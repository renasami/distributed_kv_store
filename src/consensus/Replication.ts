import type { 
  NodeId, 
  LogIndex, 
  Term, 
  LogEntry,
  AppendEntriesRequest,
  AppendEntriesResponse,
  Command,
  CommandResult,
  CommandError,
  Result,
  ReplicationState,
  ReplicationResult,
  CommitInfo,
  ReplicationConfig,
  ReplicationStats,
  TimeProvider
} from '@/types';
import { RaftState } from '@/core/State';
import { RaftLog } from '@/core/Log';
import { RaftTimer } from '@/core/Timer';

/**
 * ログレプリケーション管理クラス
 * リーダーがフォロワーにログエントリを複製し、一貫性を保証する
 */
export class ReplicationManager {
  private readonly nodeId: NodeId;
  private readonly peers: NodeId[];
  private readonly state: RaftState;
  private readonly log: RaftLog;
  private readonly timer: RaftTimer;
  private readonly rpc: any;
  private readonly config: ReplicationConfig;
  
  private followerStates: Map<NodeId, ReplicationState>;
  private stats: ReplicationStats;
  private timeProvider: TimeProvider;
  private isActive: boolean = false;
  private heartbeatTimerId?: string;

  constructor(
    nodeId: NodeId,
    peers: NodeId[],
    state: RaftState,
    log: RaftLog,
    timer: RaftTimer,
    rpc: any,
    config: Partial<ReplicationConfig> = {},
    timeProvider?: TimeProvider
  ) {
    this.nodeId = nodeId;
    this.peers = peers;
    this.state = state;
    this.log = log;
    this.timer = timer;
    this.rpc = rpc;
    
    this.config = {
      maxBatchSize: 100,
      replicationTimeout: 50,
      maxRetries: 3,
      heartbeatInterval: 50,
      ...config
    };
    
    this.timeProvider = timeProvider || {
      now: () => Date.now(),
      setTimeout: (callback, delay) => {
        const id = setTimeout(callback, delay) as any;
        return String(id);
      },
      clearTimeout: (timerId) => {
        clearTimeout(Number(timerId));
      }
    };
    
    this.followerStates = new Map();
    this.stats = {
      totalReplications: 0,
      successfulReplications: 0,
      failedReplications: 0,
      averageReplicationTime: 0,
      lastReplicationTime: 0
    };
    
    this.initializeFollowerStates();
  }

  /**
   * フォロワー状態の初期化
   */
  private initializeFollowerStates(): void {
    const nextIndex = this.log.getLastIndex() + 1;
    
    this.peers.forEach(nodeId => {
      this.followerStates.set(nodeId, {
        nodeId,
        nextIndex,
        matchIndex: 0,
        inflightRequest: false,
        lastContact: Date.now()
      });
    });
  }

  /**
   * レプリケーション開始
   */
  public start(): void {
    if (this.state.getState().type !== 'leader') {
      throw new Error('レプリケーションはリーダーのみが実行できます');
    }
    
    this.isActive = true;
    this.startHeartbeat();
  }

  /**
   * レプリケーション停止
   */
  public stop(): void {
    this.isActive = false;
    this.stopHeartbeat();
  }

  /**
   * コマンドをログに追加してレプリケーション
   */
  public async appendCommand(command: Command): Promise<CommandResult> {
    if (this.state.getState().type !== 'leader') {
      return {
        ok: false,
        error: { 
          type: 'NOT_LEADER', 
          leaderId: this.state.getLeaderId() 
        }
      };
    }

    const currentTerm = this.state.getCurrentTerm();
    const startTime = Date.now();
    
    try {
      const entry = this.log.appendEntry(currentTerm, command);
      
      const replicationResults = await Promise.all(
        this.peers.map(nodeId => this.replicateToFollower(nodeId))
      );
      
      const successCount = replicationResults.filter(
        result => result.type === 'SUCCESS'
      ).length;
      
      const totalNodes = this.peers.length + 1; // +1は自分自身
      const majority = Math.floor(totalNodes / 2) + 1;
      
      if (successCount + 1 >= majority) {
        const commitInfo = this.updateCommitIndex();
        
        this.stats.successfulReplications++;
        this.updateReplicationStats(startTime);
        
        return {
          ok: true,
          value: entry.command,
          index: entry.index
        };
      } else {
        this.stats.failedReplications++;
        return {
          ok: false,
          error: { type: 'NO_MAJORITY' }
        };
      }
    } catch (error: any) {
      this.stats.failedReplications++;
      return {
        ok: false,
        error: { 
          type: 'INTERNAL_ERROR', 
          message: error.message 
        }
      };
    }
  }

  /**
   * AppendEntriesリクエストの処理（フォロワー側）
   */
  public handleAppendEntries(request: AppendEntriesRequest): AppendEntriesResponse {
    const currentTerm = this.state.getCurrentTerm();
    
    if (request.term < currentTerm) {
      return {
        term: currentTerm,
        success: false
      };
    }
    
    if (request.term > currentTerm) {
      this.state.updateTerm(request.term);
      this.state.becomeFollower(request.leaderId);
    }
    
    this.timer.resetElectionTimeout();
    
    if (request.prevLogIndex > 0) {
      const prevEntry = this.log.getEntry(request.prevLogIndex);
      
      if (!prevEntry || prevEntry.term !== request.prevLogTerm) {
        const conflictIndex = this.findConflictIndex(request.prevLogIndex);
        const conflictTerm = prevEntry?.term || 0;
        
        return {
          term: this.state.getCurrentTerm(),
          success: false,
          conflictIndex,
          conflictTerm
        };
      }
    }
    
    if (request.entries.length > 0) {
      const entriesToAdd = request.entries.map(entry => ({
        term: entry.term,
        command: entry.command,
        timestamp: entry.timestamp
      }));
      
      const result = this.log.appendEntries(entriesToAdd);
      
      if (!result.ok) {
        return {
          term: this.state.getCurrentTerm(),
          success: false
        };
      }
    }
    
    if (request.leaderCommit > this.log.getCommitIndex()) {
      const newCommitIndex = Math.min(
        request.leaderCommit,
        this.log.getLastIndex()
      );
      this.log.commit(newCommitIndex);
    }
    
    return {
      term: this.state.getCurrentTerm(),
      success: true,
      matchIndex: this.log.getLastIndex()
    };
  }

  /**
   * フォロワーに対するレプリケーション
   */
  private async replicateToFollower(nodeId: NodeId): Promise<ReplicationResult> {
    const followerState = this.followerStates.get(nodeId);
    if (!followerState || followerState.inflightRequest) {
      return { type: 'TIMEOUT' };
    }
    
    followerState.inflightRequest = true;
    
    try {
      const entries = this.getEntriesToSend(followerState);
      const prevLogIndex = followerState.nextIndex - 1;
      const prevLogTerm = prevLogIndex > 0 
        ? this.log.getEntry(prevLogIndex)?.term || 0 
        : 0;
      
      const request: AppendEntriesRequest = {
        term: this.state.getCurrentTerm(),
        leaderId: this.nodeId,
        prevLogIndex,
        prevLogTerm,
        entries,
        leaderCommit: this.log.getCommitIndex()
      };
      
      const response = await this.rpc.sendAppendEntries(nodeId, request);
      
      if (response.term > this.state.getCurrentTerm()) {
        this.state.updateTerm(response.term);
        this.state.becomeFollower();
        return { type: 'TERM_MISMATCH', higherTerm: response.term };
      }
      
      if (response.success) {
        followerState.nextIndex = (response.matchIndex || 0) + 1;
        followerState.matchIndex = response.matchIndex || 0;
        followerState.lastContact = Date.now();
        
        return { type: 'SUCCESS', matchIndex: followerState.matchIndex };
      } else {
        if (response.conflictIndex !== undefined) {
          followerState.nextIndex = response.conflictIndex;
        } else {
          followerState.nextIndex = Math.max(1, followerState.nextIndex - 1);
        }
        
        return {
          type: 'LOG_INCONSISTENCY',
          conflictIndex: response.conflictIndex || followerState.nextIndex,
          conflictTerm: response.conflictTerm || 0
        };
      }
    } catch (error: any) {
      return { 
        type: 'NETWORK_ERROR', 
        error: error.message 
      };
    } finally {
      followerState.inflightRequest = false;
    }
  }

  /**
   * 送信するエントリの取得
   */
  private getEntriesToSend(followerState: ReplicationState): LogEntry[] {
    const startIndex = followerState.nextIndex;
    
    if (startIndex > this.log.getLastIndex()) {
      return [];
    }
    
    const maxCount = this.config.maxBatchSize;
    return this.log.getEntriesFrom(startIndex, maxCount);
  }

  /**
   * 競合インデックスの検索
   */
  private findConflictIndex(requestedIndex: LogIndex): LogIndex {
    let conflictIndex = requestedIndex;
    
    while (conflictIndex > 0) {
      const entry = this.log.getEntry(conflictIndex);
      if (!entry) {
        conflictIndex--;
      } else {
        break;
      }
    }
    
    return Math.max(1, conflictIndex);
  }

  /**
   * ハートビート開始
   */
  public startHeartbeat(): void {
    if (this.heartbeatTimerId) {
      this.timeProvider.clearTimeout(this.heartbeatTimerId);
    }
    
    const sendHeartbeat = () => {
      if (!this.isActive || this.state.getState().type !== 'leader') {
        return;
      }
      
      this.peers.forEach(async nodeId => {
        const followerState = this.followerStates.get(nodeId);
        if (followerState && !followerState.inflightRequest) {
          await this.replicateToFollower(nodeId);
        }
      });
      
      this.heartbeatTimerId = this.timeProvider.setTimeout(
        sendHeartbeat,
        this.config.heartbeatInterval
      );
    };
    
    this.heartbeatTimerId = this.timeProvider.setTimeout(
      sendHeartbeat,
      this.config.heartbeatInterval
    );
  }

  /**
   * ハートビート停止
   */
  public stopHeartbeat(): void {
    if (this.heartbeatTimerId) {
      this.timeProvider.clearTimeout(this.heartbeatTimerId);
      this.heartbeatTimerId = undefined;
    }
  }

  /**
   * フォロワーとの同期
   */
  public async syncFollower(nodeId: NodeId): Promise<Result<ReplicationState, string>> {
    const followerState = this.followerStates.get(nodeId);
    if (!followerState) {
      return { 
        ok: false, 
        error: `フォロワー ${nodeId} が見つかりません` 
      };
    }
    
    let attempts = 0;
    while (attempts < this.config.maxRetries) {
      const result = await this.replicateToFollower(nodeId);
      
      if (result.type === 'SUCCESS') {
        return { ok: true, value: followerState };
      }
      
      if (result.type === 'TERM_MISMATCH') {
        return { 
          ok: false, 
          error: 'より高いTermを受信したためFollowerになりました' 
        };
      }
      
      attempts++;
      await this.sleep(50 * attempts);
    }
    
    return { 
      ok: false, 
      error: `フォロワー ${nodeId} との同期に失敗しました` 
    };
  }

  /**
   * コミットインデックスの更新
   */
  public updateCommitIndex(): CommitInfo | null {
    const matchIndices = Array.from(this.followerStates.values())
      .map(state => state.matchIndex)
      .concat([this.log.getLastIndex()])
      .sort((a, b) => a - b);
    
    const majorityIndex = Math.floor(matchIndices.length / 2);
    const candidateIndex = matchIndices[majorityIndex];
    const candidateEntry = this.log.getEntry(candidateIndex);
    
    if (candidateEntry && 
        candidateEntry.term === this.state.getCurrentTerm() &&
        candidateIndex > this.log.getCommitIndex()) {
      
      this.log.commit(candidateIndex);
      
      return {
        index: candidateIndex,
        term: candidateEntry.term,
        timestamp: Date.now()
      };
    }
    
    return null;
  }

  /**
   * フォロワー状態の取得
   */
  public getFollowerState(nodeId: NodeId): ReplicationState | null {
    return this.followerStates.get(nodeId) || null;
  }

  /**
   * フォロワー状態の更新
   */
  public updateFollowerState(nodeId: NodeId, updates: Partial<ReplicationState>): void {
    const currentState = this.followerStates.get(nodeId);
    if (currentState) {
      this.followerStates.set(nodeId, { ...currentState, ...updates });
    }
  }

  /**
   * すべてのフォロワー状態の取得
   */
  public getAllFollowerStates(): ReplicationState[] {
    return Array.from(this.followerStates.values());
  }

  /**
   * レプリケーション統計の取得
   */
  public getStats(): ReplicationStats {
    return { ...this.stats };
  }

  /**
   * コミットインデックスの取得
   */
  public getCommitIndex(): LogIndex {
    return this.log.getCommitIndex();
  }

  /**
   * 設定の取得
   */
  public getConfig(): ReplicationConfig {
    return { ...this.config };
  }

  /**
   * バッチでコマンドを追加（テスト用）
   */
  public appendCommandBatch = this.batchReplicate;

  /**
   * 設定を更新する（テスト用）
   */
  public setConfig(newConfig: Partial<ReplicationConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * レプリケーション統計の更新
   */
  private updateReplicationStats(startTime: number): void {
    const replicationTime = Date.now() - startTime;
    this.stats.totalReplications++;
    this.stats.lastReplicationTime = replicationTime;
    
    const totalTime = this.stats.averageReplicationTime * (this.stats.totalReplications - 1) + replicationTime;
    this.stats.averageReplicationTime = totalTime / this.stats.totalReplications;
  }

  /**
   * 待機用ヘルパー関数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * バッチ処理の実装
   */
  public async batchReplicate(commands: Command[]): Promise<CommandResult[]> {
    if (this.state.getState().type !== 'leader') {
      return commands.map(() => ({
        ok: false,
        error: { 
          type: 'NOT_LEADER', 
          leaderId: this.state.getLeaderId() 
        }
      }));
    }

    const results: CommandResult[] = [];
    const batches: Command[][] = [];
    
    for (let i = 0; i < commands.length; i += this.config.maxBatchSize) {
      batches.push(commands.slice(i, i + this.config.maxBatchSize));
    }
    
    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map(command => this.appendCommand(command))
      );
      results.push(...batchResults);
    }
    
    return results;
  }
}
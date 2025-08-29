import type { NodeId, Command, CommandResult, TimeProvider } from '@/types';
import { RaftState } from './State';
import { RaftLog } from './Log';
import { RaftTimer } from './Timer';
import { ElectionManager } from '@/consensus/Election';
import { ReplicationManager } from '@/consensus/Replication';
import { SafetyChecker, type AppliedCommand, type NodeStateInfo } from '@/consensus/SafetyChecker';
import { EventEmitter } from 'events';

/**
 * ノード設定インターフェース
 */
export interface RaftNodeConfig {
  electionTimeoutMin?: number;
  electionTimeoutMax?: number;
  heartbeatInterval?: number;
  enableSafetyChecks?: boolean;
  timeProvider?: TimeProvider;
}

/**
 * ノードの状態情報
 */
export interface NodeStatus {
  nodeId: NodeId;
  state: { type: string; term: number };
  isLeader: boolean;
  commitIndex: number;
  lastApplied: number;
  logLength: number;
  stateMachineSize: number;
}

/**
 * Raftノードの統合実装
 * 全てのコンポーネントを統合し、完全なRaftアルゴリズムを提供
 */
export class RaftNode extends EventEmitter {
  private readonly nodeId: NodeId;
  private readonly peers: NodeId[];
  
  // コアコンポーネント
  private readonly state: RaftState;
  private readonly log: RaftLog;
  private readonly timer: RaftTimer;
  
  // コンセンサスマネージャー
  private readonly election: ElectionManager;
  private readonly replication: ReplicationManager;
  private readonly safety: SafetyChecker;
  
  // ステートマシン（KVストア）
  private readonly stateMachine = new Map<string, unknown>();
  private lastApplied = 0;
  private appliedCommands: AppliedCommand[] = [];
  
  // 制御フラグ
  private isRunning = false;
  private enableSafetyChecks: boolean;
  
  // RPC（モック実装）
  private rpcClient: any;
  private timeProvider: TimeProvider;
  
  constructor(
    nodeId: NodeId,
    peers: NodeId[],
    config: RaftNodeConfig = {}
  ) {
    super();
    
    this.nodeId = nodeId;
    this.peers = peers;
    this.enableSafetyChecks = config.enableSafetyChecks ?? true;
    
    // TimeProviderの設定
    this.timeProvider = config.timeProvider || {
      now: () => Date.now(),
      setTimeout: (callback, delay) => {
        const id = setTimeout(callback, delay) as any;
        return String(id);
      },
      clearTimeout: (timerId) => {
        clearTimeout(Number(timerId));
      }
    };
    
    // コアコンポーネントを初期化
    this.state = new RaftState(nodeId);
    this.log = new RaftLog();
    this.timer = new RaftTimer({
      electionTimeoutMin: config.electionTimeoutMin || 150,
      electionTimeoutMax: config.electionTimeoutMax || 300,
      heartbeatInterval: config.heartbeatInterval || 50
    }, this.timeProvider);
    
    // MockRPCClient（テスト用）
    this.rpcClient = this.createMockRPCClient();
    
    // コンセンサスマネージャーを初期化
    this.election = new ElectionManager(
      nodeId,
      peers,
      this.state,
      this.log,
      this.timer,
      this.rpcClient
    );
    
    this.replication = new ReplicationManager(
      nodeId,
      peers,
      this.state,
      this.log,
      this.timer,
      this.rpcClient,
      {},
      this.timeProvider
    );
    
    this.safety = new SafetyChecker(this.enableSafetyChecks);
    
    // イベントリスナーを設定
    this.setupEventHandlers();
    
    console.log(`Raftノードを初期化: ${nodeId}, ピア: [${peers.join(', ')}]`);
  }
  
  /**
   * イベントハンドラーの設定
   */
  private setupEventHandlers(): void {
    // 選挙タイムアウト時の処理
    this.election.onElectionTimeout(() => {
      if (this.isRunning && this.state.getState().type !== 'leader') {
        this.becomeCandidate();
      }
    });
  }
  
  /**
   * ノードを起動
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn(`ノード${this.nodeId}は既に起動しています`);
      return;
    }
    
    console.log(`ノード${this.nodeId}を起動中...`);
    this.isRunning = true;
    
    // Followerとして開始
    this.becomeFollower(this.state.getCurrentTerm());
    
    // コミット済みエントリの適用を開始
    this.startApplyingEntries();
    
    console.log(`ノード${this.nodeId}が起動しました`);
    this.emit('started');
  }
  
  /**
   * ノードを停止
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      console.warn(`ノード${this.nodeId}は既に停止しています`);
      return;
    }
    
    console.log(`ノード${this.nodeId}を停止中...`);
    this.isRunning = false;
    
    // タイマーを停止
    this.timer.stopElectionTimeout();
    this.replication.stopHeartbeat();
    
    console.log(`ノード${this.nodeId}が停止しました`);
    this.emit('stopped');
  }
  
  /**
   * クライアントコマンドを処理（リーダーのみ）
   */
  async handleClientCommand(command: Command): Promise<CommandResult> {
    if (!this.isRunning) {
      return {
        ok: false,
        error: { type: 'INTERNAL_ERROR', message: 'ノードが停止中です' }
      };
    }
    
    // リーダーでない場合はリダイレクト
    if (this.state.getState().type !== 'leader') {
      const leaderId = this.getLeaderId();
      return {
        ok: false,
        error: { type: 'NOT_LEADER', leaderId }
      };
    }
    
    // 安全性チェック（デバッグ時）
    if (this.enableSafetyChecks) {
      const beforeState = {
        term: this.state.getCurrentTerm(),
        commitIndex: this.replication.getCommitIndex(),
        lastApplied: this.lastApplied
      };
      
      const result = await this.replication.appendCommand(command);
      
      const afterState = {
        term: this.state.getCurrentTerm(),
        commitIndex: this.replication.getCommitIndex(),
        lastApplied: this.lastApplied
      };
      
      this.safety.verifyStateTransition(beforeState, afterState, this.nodeId);
      
      if (result.ok) {
        // Figure 8問題のチェック
        this.safety.checkFigure8Problem(
          this.replication.getCommitIndex(),
          this.getAllLogEntries(),
          this.state.getCurrentTerm(),
          this.nodeId
        );
      }
      
      return result;
    }
    
    // コマンドを追加してレプリケーション
    return this.replication.appendCommand(command);
  }
  
  /**
   * Follower状態に遷移
   */
  private becomeFollower(term: number, leaderId?: NodeId): void {
    if (!this.isRunning) return;
    
    console.log(`${this.nodeId}: Followerに遷移 (term=${term}, leader=${leaderId || '不明'})`);
    
    this.state.becomeFollower(term, leaderId);
    
    // リーダー機能を停止
    this.replication.stop();
    
    // 選挙タイマーを開始
    this.election.startElectionTimer();
    
    this.emit('stateChange', { 
      nodeId: this.nodeId,
      type: 'follower', 
      term,
      leaderId 
    });
  }
  
  /**
   * Candidate状態に遷移して選挙開始
   */
  private async becomeCandidate(): Promise<void> {
    if (!this.isRunning) return;
    
    console.log(`${this.nodeId}: Candidateに遷移して選挙開始`);
    
    await this.election.startElection((result) => {
      if (!this.isRunning) return;
      
      switch (result.type) {
        case 'ELECTED':
          this.becomeLeader();
          break;
        case 'STEPPED_DOWN':
          this.becomeFollower(result.newTerm);
          break;
        case 'NOT_ELECTED':
          // 次の選挙タイムアウトを待つ
          console.log(`${this.nodeId}: 選挙失敗、次の機会を待機`);
          this.election.startElectionTimer();
          break;
      }
    });
    
    this.emit('stateChange', { 
      nodeId: this.nodeId,
      type: 'candidate', 
      term: this.state.getCurrentTerm() 
    });
  }
  
  /**
   * Leader状態に遷移
   */
  private becomeLeader(): void {
    if (!this.isRunning) return;
    
    console.log(`${this.nodeId}: リーダーに選出されました (term=${this.state.getCurrentTerm()})`);
    
    this.state.becomeLeader();
    
    // 選挙タイマーを停止
    this.timer.stopElectionTimeout();
    
    // レプリケーション開始
    this.replication.start();
    
    // NOOPエントリを追加（リーダー確立）
    this.replication.appendCommand({ type: 'NOOP' }).catch(error => {
      console.error(`${this.nodeId}: NOOPエントリの追加に失敗:`, error);
    });
    
    this.emit('stateChange', { 
      nodeId: this.nodeId,
      type: 'leader', 
      term: this.state.getCurrentTerm() 
    });
    
    this.emit('leaderElected', { 
      nodeId: this.nodeId, 
      term: this.state.getCurrentTerm() 
    });
  }
  
  /**
   * コミット済みエントリの適用を開始
   */
  private startApplyingEntries(): void {
    const applyEntries = () => {
      if (!this.isRunning) return;
      
      this.applyCommittedEntries();
      
      // 次の適用を10ms後にスケジュール
      this.timeProvider.setTimeout(applyEntries, 10);
    };
    
    applyEntries();
  }
  
  /**
   * コミット済みエントリをステートマシンに適用
   */
  private applyCommittedEntries(): void {
    const commitIndex = this.replication.getCommitIndex();
    
    while (this.lastApplied < commitIndex) {
      this.lastApplied++;
      const entry = this.log.getEntry(this.lastApplied);
      
      if (entry) {
        // ステートマシンに適用
        this.applyToStateMachine(entry.command);
        
        // 適用済みコマンドを記録（安全性チェック用）
        const appliedCommand: AppliedCommand = {
          index: this.lastApplied,
          command: entry.command,
          timestamp: Date.now()
        };
        this.appliedCommands.push(appliedCommand);
        
        console.log(
          `${this.nodeId}: エントリを適用 index=${this.lastApplied}, command=${JSON.stringify(entry.command)}`
        );
        
        this.emit('entryApplied', {
          nodeId: this.nodeId,
          index: this.lastApplied,
          command: entry.command
        });
        
        // 安全性チェック（デバッグ時）
        if (this.enableSafetyChecks) {
          this.safety.verifyLogIntegrity(this.getAllLogEntries(), this.nodeId);
        }
      }
    }
  }
  
  /**
   * コマンドをステートマシンに適用
   */
  private applyToStateMachine(command: Command): void {
    switch (command.type) {
      case 'SET':
        this.stateMachine.set(command.key, command.value);
        break;
      case 'DELETE':
        this.stateMachine.delete(command.key);
        break;
      case 'NOOP':
        // 何もしない（リーダー確立用）
        break;
      default:
        console.warn(`${this.nodeId}: 不明なコマンドタイプ:`, command);
    }
  }
  
  /**
   * KVストアから値を取得（読み取り）
   */
  async getValue(key: string): Promise<unknown | undefined> {
    if (!this.isRunning) {
      throw new Error('ノードが停止中です');
    }
    
    // リーダーのみ最新の値を保証
    if (this.state.getState().type !== 'leader') {
      const leaderId = this.getLeaderId();
      throw new Error(`リーダー(${leaderId || '不明'})にリダイレクトしてください`);
    }
    
    // 簡易的なReadIndex実装
    await this.ensureCommitIndexApplied();
    
    return this.stateMachine.get(key);
  }
  
  /**
   * コミットインデックスまでの適用を待つ
   */
  private async ensureCommitIndexApplied(): Promise<void> {
    const commitIndex = this.replication.getCommitIndex();
    
    // lastAppliedがcommitIndexに追いつくまで待機
    while (this.lastApplied < commitIndex) {
      await new Promise(resolve => this.timeProvider.setTimeout(() => resolve(undefined), 1));
    }
  }
  
  /**
   * MockRPCクライアントの作成（テスト用）
   */
  private createMockRPCClient(): any {
    return {
      sendRequestVote: async (nodeId: NodeId, request: any) => {
        // デフォルトで拒否
        return {
          term: request.term,
          voteGranted: false,
          reason: 'MockRPCClient - デフォルト拒否'
        };
      },
      
      sendAppendEntries: async (nodeId: NodeId, request: any) => {
        // デフォルトで失敗
        return {
          term: request.term,
          success: false,
          reason: 'MockRPCClient - デフォルト失敗'
        };
      }
    };
  }
  
  // === パブリックメソッド ===
  
  /**
   * RequestVoteリクエストの処理
   */
  handleRequestVote(request: any): any {
    const response = this.election.handleRequestVote(request);
    
    // 安全性チェック
    if (this.enableSafetyChecks && response.voteGranted) {
      const votes = new Map<NodeId, boolean>();
      votes.set(request.candidateId, true);
      this.safety.verifyElectionInvariant(request.term, votes, request.candidateId);
    }
    
    return response;
  }
  
  /**
   * AppendEntriesリクエストの処理
   */
  handleAppendEntries(request: any): any {
    const beforeTerm = this.state.getCurrentTerm();
    const response = this.replication.handleAppendEntries(request);
    const afterTerm = this.state.getCurrentTerm();
    
    // より高いTermを受信してFollowerになった場合
    if (afterTerm > beforeTerm) {
      this.becomeFollower(afterTerm, request.leaderId);
    }
    
    // 安全性チェック
    if (this.enableSafetyChecks) {
      this.safety.verifyLogIntegrity(this.getAllLogEntries(), this.nodeId);
    }
    
    return response;
  }
  
  /**
   * ノードの状態情報を取得
   */
  getStatus(): NodeStatus {
    const state = this.state.getState();
    return {
      nodeId: this.nodeId,
      state: {
        type: state.type,
        term: this.state.getCurrentTerm()
      },
      isLeader: state.type === 'leader',
      commitIndex: this.replication.getCommitIndex(),
      lastApplied: this.lastApplied,
      logLength: this.log.getLength(),
      stateMachineSize: this.stateMachine.size
    };
  }
  
  /**
   * ノードIDを取得
   */
  getNodeId(): NodeId {
    return this.nodeId;
  }
  
  /**
   * 現在の状態を取得
   */
  getState(): { type: string; term: number } {
    const state = this.state.getState();
    return {
      type: state.type,
      term: this.state.getCurrentTerm()
    };
  }
  
  /**
   * リーダーIDを取得
   */
  getLeaderId(): NodeId | undefined {
    const state = this.state.getState();
    if (state.type === 'follower') {
      return state.leaderId;
    } else if (state.type === 'leader') {
      return this.nodeId;
    }
    return undefined;
  }
  
  /**
   * ステートマシンを取得
   */
  getStateMachine(): Map<string, unknown> {
    return new Map(this.stateMachine);
  }
  
  /**
   * ログエントリを全て取得
   */
  getAllLogEntries(): any[] {
    const entries = [];
    for (let i = 1; i <= this.log.getLastIndex(); i++) {
      const entry = this.log.getEntry(i);
      if (entry) {
        entries.push(entry);
      }
    }
    return entries;
  }
  
  /**
   * 適用済みコマンドを取得
   */
  getAppliedCommands(): AppliedCommand[] {
    return [...this.appliedCommands];
  }
  
  /**
   * 安全性チェッカーを取得
   */
  getSafetyChecker(): SafetyChecker {
    return this.safety;
  }
  
  /**
   * ノード状態情報を取得（安全性チェック用）
   */
  getNodeStateInfo(): NodeStateInfo {
    const state = this.state.getState();
    return {
      term: this.state.getCurrentTerm(),
      isLeader: state.type === 'leader',
      commitIndex: this.replication.getCommitIndex(),
      lastApplied: this.lastApplied
    };
  }
  
  /**
   * RPCクライアントを設定（テスト用）
   */
  setRPCClient(rpcClient: any): void {
    this.rpcClient = rpcClient;
    // 注意: 現在の実装では動的変更をサポートしていない
    console.warn('RPCクライアントの動的変更は未実装です');
  }
  
  /**
   * デバッグ情報を取得
   */
  getDebugInfo(): any {
    const status = this.getStatus();
    return {
      ...status,
      peers: this.peers,
      isRunning: this.isRunning,
      enableSafetyChecks: this.enableSafetyChecks,
      log: {
        entries: this.getAllLogEntries(),
        stats: this.log.getStats()
      },
      stateMachine: Object.fromEntries(this.stateMachine),
      appliedCommands: this.appliedCommands,
      safetyMetrics: this.safety.getMetrics(),
      followerStates: this.state.getState().type === 'leader' ? 
        Object.fromEntries(this.replication.getAllFollowerStates().map(s => [s.nodeId, s])) : null
    };
  }
  
  /**
   * 実行中かどうかを確認
   */
  isNodeRunning(): boolean {
    return this.isRunning;
  }
}

/**
 * RaftNode作成のファクトリー関数
 */
export function createRaftNode(
  nodeId: NodeId, 
  peers: NodeId[], 
  config?: RaftNodeConfig
): RaftNode {
  return new RaftNode(nodeId, peers, config);
}
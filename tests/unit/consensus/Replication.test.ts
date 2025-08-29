import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReplicationManager } from '@/consensus/Replication';
import { RaftState } from '@/core/State';
import { RaftLog } from '@/core/Log';
import { RaftTimer } from '@/core/Timer';
import { MockTimeProvider } from '../../utils/MockTimeProvider';
import type { 
  AppendEntriesRequest, 
  AppendEntriesResponse,
  Command,
  NodeId 
} from '@/types';

describe('ReplicationManager', () => {
  let replication: ReplicationManager;
  let state: RaftState;
  let log: RaftLog;
  let timer: RaftTimer;
  let mockTime: MockTimeProvider;
  let mockRPC: MockRPCClient;
  
  const nodeId = 'node1';
  const followers = ['node2', 'node3'];
  
  beforeEach(() => {
    state = new RaftState(nodeId);
    log = new RaftLog();
    mockTime = new MockTimeProvider();
    timer = new RaftTimer({
      electionTimeoutMin: 150,
      electionTimeoutMax: 300,
      heartbeatInterval: 50
    }, mockTime);
    mockRPC = new MockRPCClient();
    
    replication = new ReplicationManager(
      nodeId,
      followers,
      state,
      log,
      timer,
      mockRPC,
      {},
      mockTime
    );
    
    // リーダーとして開始
    state.becomeLeader();
  });
  
  describe('エントリの追加とレプリケーション', () => {
    it('リーダーがエントリを追加してFollowerに送信する', async () => {
      const command: Command = { type: 'SET', key: 'x', value: 1 };
      const sendSpy = vi.spyOn(mockRPC, 'sendAppendEntries');
      
      // 成功レスポンスを設定
      mockRPC.setAppendEntriesResponse('node2', { 
        term: 1, 
        success: true, 
        matchIndex: 1 
      });
      mockRPC.setAppendEntriesResponse('node3', { 
        term: 1, 
        success: true, 
        matchIndex: 1 
      });
      
      const result = await replication.appendCommand(command);
      
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.index).toBe(1);
      }
      
      // 両Followerに送信されたか確認
      expect(sendSpy).toHaveBeenCalledTimes(2);
      
      const expectedRequest: Partial<AppendEntriesRequest> = {
        term: 1,
        leaderId: nodeId,
        entries: expect.arrayContaining([
          expect.objectContaining({ command })
        ])
      };
      
      expect(sendSpy).toHaveBeenCalledWith('node2', expect.objectContaining(expectedRequest));
      expect(sendSpy).toHaveBeenCalledWith('node3', expect.objectContaining(expectedRequest));
    });
    
    it('過半数のレプリケーション後にコミットする', async () => {
      const command: Command = { type: 'SET', key: 'x', value: 1 };
      
      // 1つ成功、1つ失敗（3ノード中2ノードで過半数）
      mockRPC.setAppendEntriesResponse('node2', { 
        term: 1, 
        success: true, 
        matchIndex: 1 
      });
      mockRPC.setAppendEntriesResponse('node3', { 
        term: 1, 
        success: false 
      });
      
      const result = await replication.appendCommand(command);
      
      expect(result.ok).toBe(true);
      expect(replication.getCommitIndex()).toBe(1);
    });
    
    it('過半数に届かない場合はコミットしない', async () => {
      const command: Command = { type: 'SET', key: 'x', value: 1 };
      
      // 両方失敗
      mockRPC.setAppendEntriesResponse('node2', { 
        term: 1, 
        success: false 
      });
      mockRPC.setAppendEntriesResponse('node3', { 
        term: 1, 
        success: false 
      });
      
      const result = await replication.appendCommand(command);
      
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('NO_MAJORITY');
      }
      expect(replication.getCommitIndex()).toBe(0);
    });
    
    it('リーダーでない場合はエラーを返す', async () => {
      state.becomeFollower(2);
      
      const command: Command = { type: 'SET', key: 'x', value: 1 };
      const result = await replication.appendCommand(command);
      
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('NOT_LEADER');
      }
    });
  });
  
  describe('AppendEntries処理（Follower側）', () => {
    beforeEach(() => {
      state.becomeFollower(1);
    });
    
    it('一貫性チェックが成功したらエントリを追加', () => {
      const request: AppendEntriesRequest = {
        term: 1,
        leaderId: 'node2',
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [{
          term: 1,
          index: 1,
          command: { type: 'SET', key: 'x', value: 1 },
          timestamp: Date.now()
        }],
        leaderCommit: 0
      };
      
      const response = replication.handleAppendEntries(request);
      
      expect(response.success).toBe(true);
      expect(response.matchIndex).toBe(1);
      expect(log.getLength()).toBe(1);
    });
    
    it('prevLogIndexが一致しない場合は拒否', () => {
      const request: AppendEntriesRequest = {
        term: 1,
        leaderId: 'node2',
        prevLogIndex: 5,  // 存在しないインデックス
        prevLogTerm: 1,
        entries: [],
        leaderCommit: 0
      };
      
      const response = replication.handleAppendEntries(request);
      
      expect(response.success).toBe(false);
      expect(response.conflictIndex).toBeDefined();
    });
    
    it('prevLogTermが一致しない場合は拒否', () => {
      // 既存のエントリを追加
      log.appendEntry(1, { type: 'SET', key: 'x', value: 1 });
      
      const request: AppendEntriesRequest = {
        term: 2,
        leaderId: 'node2',
        prevLogIndex: 1,
        prevLogTerm: 2,  // 実際は1
        entries: [],
        leaderCommit: 0
      };
      
      const response = replication.handleAppendEntries(request);
      
      expect(response.success).toBe(false);
      expect(response.conflictTerm).toBe(1);
    });
    
    it('競合するエントリは削除して新しいエントリで置き換える', () => {
      // 既存のエントリ
      log.appendEntry(1, { type: 'SET', key: 'x', value: 1 });
      log.appendEntry(1, { type: 'SET', key: 'y', value: 2 });
      log.appendEntry(1, { type: 'SET', key: 'z', value: 3 });
      
      // インデックス2から異なるエントリ
      const request: AppendEntriesRequest = {
        term: 2,
        leaderId: 'node2',
        prevLogIndex: 1,
        prevLogTerm: 1,
        entries: [
          {
            term: 2,
            index: 2,
            command: { type: 'DELETE', key: 'y' },
            timestamp: Date.now()
          }
        ],
        leaderCommit: 0
      };
      
      const response = replication.handleAppendEntries(request);
      
      expect(response.success).toBe(true);
      expect(log.getLength()).toBe(2);  // 3→2に減少
      expect(log.getEntry(2)?.command.type).toBe('DELETE');
    });
    
    it('leaderCommitが更新されたらコミットインデックスを進める', () => {
      log.appendEntry(1, { type: 'SET', key: 'x', value: 1 });
      log.appendEntry(1, { type: 'SET', key: 'y', value: 2 });
      
      const request: AppendEntriesRequest = {
        term: 1,
        leaderId: 'node2',
        prevLogIndex: 2,
        prevLogTerm: 1,
        entries: [],
        leaderCommit: 2
      };
      
      const response = replication.handleAppendEntries(request);
      
      expect(response.success).toBe(true);
      expect(replication.getCommitIndex()).toBe(2);
    });
    
    it('古いTermのリクエストは拒否する', () => {
      state.becomeFollower(2);  // term = 2
      
      const request: AppendEntriesRequest = {
        term: 1,  // 古いterm
        leaderId: 'node2',
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [],
        leaderCommit: 0
      };
      
      const response = replication.handleAppendEntries(request);
      
      expect(response.success).toBe(false);
      expect(response.term).toBe(2);
    });
  });
  
  describe('ハートビート', () => {
    it('定期的にハートビートを送信する', () => {
      const sendSpy = vi.spyOn(mockRPC, 'sendAppendEntries');
      
      replication.startHeartbeat();
      
      // 初回送信
      mockTime.advance(50);
      expect(sendSpy).toHaveBeenCalledTimes(2);  // 2 followers
      
      // 2回目
      mockTime.advance(50);
      expect(sendSpy).toHaveBeenCalledTimes(4);
      
      // 3回目
      mockTime.advance(50);
      expect(sendSpy).toHaveBeenCalledTimes(6);
    });
    
    it('ハートビートは空のエントリ配列を送信', () => {
      const sendSpy = vi.spyOn(mockRPC, 'sendAppendEntries');
      
      replication.startHeartbeat();
      mockTime.advance(50);
      
      expect(sendSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          entries: []
        })
      );
    });
    
    it('リーダーでなくなったらハートビートを停止', () => {
      replication.startHeartbeat();
      
      state.becomeFollower(2);
      replication.stopHeartbeat();
      
      const sendSpy = vi.spyOn(mockRPC, 'sendAppendEntries');
      mockTime.advance(100);
      
      expect(sendSpy).not.toHaveBeenCalled();
    });
  });
  
  describe('ログの修復', () => {
    it('Followerが遅れている場合は古いエントリから送信', async () => {
      // リーダーに3つのエントリ
      log.appendEntry(1, { type: 'SET', key: 'x', value: 1 });
      log.appendEntry(1, { type: 'SET', key: 'y', value: 2 });
      log.appendEntry(1, { type: 'SET', key: 'z', value: 3 });
      
      const sendSpy = vi.spyOn(mockRPC, 'sendAppendEntries');
      
      // 最初の試行: prevLogIndex=2で失敗
      mockRPC.setAppendEntriesResponse('node2', {
        term: 1,
        success: false,
        conflictIndex: 1
      });
      
      await replication.syncFollower('node2');
      
      // nextIndexが減少して再送信
      expect(sendSpy).toHaveBeenCalledTimes(2);  // 2回送信
      
      const secondCall = sendSpy.mock.calls[1];
      expect(secondCall[1].prevLogIndex).toBeLessThan(3);
    });
    
    it('一致点が見つかるまでnextIndexを減らす', async () => {
      // 複数エントリを追加
      for (let i = 1; i <= 5; i++) {
        log.appendEntry(1, { type: 'SET', key: `k${i}`, value: i });
      }
      
      let attempts = 0;
      mockRPC.onAppendEntries('node2', (request) => {
        attempts++;
        // 3回目で成功
        if (attempts < 3) {
          return { term: 1, success: false, conflictIndex: 5 - attempts };
        }
        return { term: 1, success: true, matchIndex: request.prevLogIndex + request.entries.length };
      });
      
      await replication.syncFollower('node2');
      
      expect(attempts).toBe(3);
      expect(replication.getFollowerState('node2')?.matchIndex).toBeGreaterThan(0);
    });
  });
  
  describe('Follower状態の追跡', () => {
    it('各FollowerのnextIndexとmatchIndexを管理', () => {
      const followerStates = replication.getAllFollowerStates();
      
      expect(followerStates).toHaveLength(2);
      expect(followerStates[0]).toMatchObject({
        nodeId: 'node2',
        nextIndex: 1,
        matchIndex: 0
      });
    });
    
    it('成功したレプリケーションでインデックスを更新', async () => {
      mockRPC.setAppendEntriesResponse('node2', {
        term: 1,
        success: true,
        matchIndex: 1
      });
      mockRPC.setAppendEntriesResponse('node3', {
        term: 1,
        success: true,
        matchIndex: 1
      });
      
      const command: Command = { type: 'SET', key: 'x', value: 1 };
      await replication.appendCommand(command);
      
      const state = replication.getFollowerState('node2');
      expect(state?.matchIndex).toBe(1);
      expect(state?.nextIndex).toBe(2);
    });
    
    it('失敗したレプリケーションでnextIndexを減少', async () => {
      mockRPC.setAppendEntriesResponse('node2', {
        term: 1,
        success: false,
        conflictIndex: 1
      });
      
      await replication.syncFollower('node2');
      
      const state = replication.getFollowerState('node2');
      expect(state?.nextIndex).toBeLessThan(2);
    });
  });
  
  describe('コミットインデックスの更新', () => {
    it('過半数がレプリケーションした最大インデックスをコミット', () => {
      // 3つのエントリを追加
      const commands: Command[] = [
        { type: 'SET', key: 'x', value: 1 },
        { type: 'SET', key: 'y', value: 2 },
        { type: 'SET', key: 'z', value: 3 }
      ];
      
      for (const cmd of commands) {
        log.appendEntry(1, cmd);
      }
      
      // node2は全部、node3は2つまでレプリケーション
      replication.updateFollowerState('node2', { matchIndex: 3 });
      replication.updateFollowerState('node3', { matchIndex: 2 });
      
      replication.updateCommitIndex();
      
      // 過半数（2/3）がレプリケーションした最大値は2
      expect(replication.getCommitIndex()).toBe(2);
    });
    
    it('現在termのエントリのみコミット（Figure 8問題）', () => {
      // 古いtermのエントリ
      log.appendEntry(1, { type: 'SET', key: 'x', value: 1 });
      log.appendEntry(1, { type: 'SET', key: 'y', value: 2 });
      
      // 現在のterm（2）に変更
      state.becomeFollower(2);
      state.becomeLeader();
      
      // 新しいtermのエントリ
      log.appendEntry(2, { type: 'SET', key: 'z', value: 3 });
      
      // 全Followerが古いエントリまでレプリケーション
      replication.updateFollowerState('node2', { matchIndex: 2 });
      replication.updateFollowerState('node3', { matchIndex: 2 });
      
      replication.updateCommitIndex();
      
      // 古いtermのエントリはコミットしない
      expect(replication.getCommitIndex()).toBe(0);
      
      // 新しいtermのエントリがレプリケーションされたらコミット
      replication.updateFollowerState('node2', { matchIndex: 3 });
      replication.updateCommitIndex();
      
      expect(replication.getCommitIndex()).toBe(3);
    });
  });
  
  describe('バッチングとパフォーマンス', () => {
    it('複数のコマンドをバッチで送信', async () => {
      const commands: Command[] = [];
      for (let i = 0; i < 5; i++) {
        commands.push({ type: 'SET', key: `k${i}`, value: i });
      }
      
      const sendSpy = vi.spyOn(mockRPC, 'sendAppendEntries');
      
      // 成功レスポンスを設定
      mockRPC.setAppendEntriesResponse('node2', { term: 1, success: true, matchIndex: 5 });
      mockRPC.setAppendEntriesResponse('node3', { term: 1, success: true, matchIndex: 5 });
      
      // バッチで追加
      await replication.appendCommandBatch(commands);
      
      expect(log.getLength()).toBe(5);
    });
    
    it('最大バッチサイズを超えたら分割', async () => {
      const originalMaxBatch = replication.getConfig().maxBatchSize;
      replication.setConfig({ maxBatchSize: 2 });
      
      const commands: Command[] = [];
      for (let i = 0; i < 5; i++) {
        commands.push({ type: 'SET', key: `k${i}`, value: i });
      }
      
      // 成功レスポンスを設定
      mockRPC.setAppendEntriesResponse('node2', { term: 1, success: true, matchIndex: 5 });
      mockRPC.setAppendEntriesResponse('node3', { term: 1, success: true, matchIndex: 5 });
      
      await replication.appendCommandBatch(commands);
      
      expect(log.getLength()).toBe(5);
      
      replication.setConfig({ maxBatchSize: originalMaxBatch });
    });
  });
  
  describe('エラーケース', () => {
    it('ネットワークエラーでも部分的に成功する', async () => {
      const command: Command = { type: 'SET', key: 'x', value: 1 };
      
      // 1つ成功、1つエラー
      mockRPC.setAppendEntriesResponse('node2', { term: 1, success: true, matchIndex: 1 });
      mockRPC.setAppendEntriesError('node3', new Error('ネットワークエラー'));
      
      const result = await replication.appendCommand(command);
      
      // 自分 + node2で過半数
      expect(result.ok).toBe(true);
    });
    
    it('全Followerがエラーでも自分だけでは過半数に達しない', async () => {
      const command: Command = { type: 'SET', key: 'x', value: 1 };
      
      // 両方エラー
      mockRPC.setAppendEntriesError('node2', new Error('ネットワークエラー'));
      mockRPC.setAppendEntriesError('node3', new Error('ネットワークエラー'));
      
      const result = await replication.appendCommand(command);
      
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('NO_MAJORITY');
      }
    });
  });
});

/**
 * テスト用のモックRPCクライアント（AppendEntries対応）
 */
class MockRPCClient {
  private appendEntriesResponses = new Map<NodeId, AppendEntriesResponse>();
  private appendEntriesErrors = new Map<NodeId, Error>();
  private appendEntriesHandlers = new Map<NodeId, (request: AppendEntriesRequest) => AppendEntriesResponse>();
  
  setAppendEntriesResponse(nodeId: NodeId, response: AppendEntriesResponse): void {
    this.appendEntriesResponses.set(nodeId, response);
    this.appendEntriesErrors.delete(nodeId);
    this.appendEntriesHandlers.delete(nodeId);
  }
  
  setAppendEntriesError(nodeId: NodeId, error: Error): void {
    this.appendEntriesErrors.set(nodeId, error);
    this.appendEntriesResponses.delete(nodeId);
    this.appendEntriesHandlers.delete(nodeId);
  }
  
  onAppendEntries(nodeId: NodeId, handler: (request: AppendEntriesRequest) => AppendEntriesResponse): void {
    this.appendEntriesHandlers.set(nodeId, handler);
    this.appendEntriesResponses.delete(nodeId);
    this.appendEntriesErrors.delete(nodeId);
  }
  
  async sendAppendEntries(
    nodeId: NodeId,
    request: AppendEntriesRequest
  ): Promise<AppendEntriesResponse> {
    // ハンドラーが設定されている場合
    if (this.appendEntriesHandlers.has(nodeId)) {
      const handler = this.appendEntriesHandlers.get(nodeId)!;
      return handler(request);
    }
    
    // エラーが設定されている場合
    if (this.appendEntriesErrors.has(nodeId)) {
      throw this.appendEntriesErrors.get(nodeId);
    }
    
    // レスポンスが設定されている場合
    const response = this.appendEntriesResponses.get(nodeId);
    if (response) {
      return response;
    }
    
    // デフォルトは失敗
    return {
      term: request.term,
      success: false,
      reason: 'モックレスポンス未設定'
    };
  }
}
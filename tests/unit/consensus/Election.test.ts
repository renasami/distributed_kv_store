import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ElectionManager } from '@/consensus/Election';
import { RaftState } from '@/core/State';
import { RaftLog } from '@/core/Log';
import { RaftTimer } from '@/core/Timer';
import { MockTimeProvider } from '../../utils/MockTimeProvider';
import type { RequestVoteRequest, RequestVoteResponse, NodeId } from '@/types';

describe('ElectionManager', () => {
  let election: ElectionManager;
  let state: RaftState;
  let log: RaftLog;
  let timer: RaftTimer;
  let mockTime: MockTimeProvider;
  let mockRPC: MockRPCClient;
  
  const nodeId = 'node1';
  const peers = ['node2', 'node3'];
  
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
    
    election = new ElectionManager(
      nodeId,
      peers,
      state,
      log,
      timer,
      mockRPC
    );
  });
  
  describe('選挙の開始', () => {
    it('Followerから選挙を開始できる', async () => {
      const onElectionComplete = vi.fn();
      
      await election.startElection(onElectionComplete);
      
      expect(state.getState().type).toBe('candidate');
      expect(state.getCurrentTerm()).toBe(1);
      expect(state.getVotedFor()).toBe(nodeId);
    });
    
    it('自分に投票してから他ノードに要求を送る', async () => {
      const sendRequestVote = vi.spyOn(mockRPC, 'sendRequestVote');
      
      await election.startElection(() => {});
      
      expect(state.getVotedFor()).toBe(nodeId);
      expect(sendRequestVote).toHaveBeenCalledTimes(2);  // 2つのピア
    });
    
    it('RequestVoteリクエストが正しい内容を含む', async () => {
      // ログにエントリを追加
      log.appendEntry(1, { type: 'SET', key: 'x', value: 1 });
      log.appendEntry(2, { type: 'SET', key: 'y', value: 2 });
      
      const sendRequestVote = vi.spyOn(mockRPC, 'sendRequestVote');
      
      await election.startElection(() => {});
      
      const expectedRequest: RequestVoteRequest = {
        term: 1,
        candidateId: nodeId,
        lastLogIndex: 2,
        lastLogTerm: 2
      };
      
      expect(sendRequestVote).toHaveBeenCalledWith('node2', expectedRequest);
      expect(sendRequestVote).toHaveBeenCalledWith('node3', expectedRequest);
    });
  });
  
  describe('投票の集計', () => {
    it('過半数の票を獲得したらリーダーになる', async () => {
      // 1票は自分、もう1票でリーダー（3ノードクラスタ）
      mockRPC.setResponse('node2', { term: 1, voteGranted: true });
      mockRPC.setResponse('node3', { term: 1, voteGranted: false });
      
      const onElectionComplete = vi.fn();
      await election.startElection(onElectionComplete);
      
      expect(state.getState().type).toBe('leader');
      expect(onElectionComplete).toHaveBeenCalledWith({ 
        type: 'ELECTED',
        term: 1 
      });
    });
    
    it('過半数を獲得できなければCandidateのまま', async () => {
      mockRPC.setResponse('node2', { term: 1, voteGranted: false });
      mockRPC.setResponse('node3', { term: 1, voteGranted: false });
      
      const onElectionComplete = vi.fn();
      await election.startElection(onElectionComplete);
      
      expect(state.getState().type).toBe('candidate');
      expect(onElectionComplete).toHaveBeenCalledWith({ 
        type: 'NOT_ELECTED',
        term: 1 
      });
    });
    
    it('より高いTermを受信したらFollowerになる', async () => {
      mockRPC.setResponse('node2', { term: 5, voteGranted: false });
      
      const onElectionComplete = vi.fn();
      await election.startElection(onElectionComplete);
      
      expect(state.getState().type).toBe('follower');
      expect(state.getCurrentTerm()).toBe(5);
      expect(onElectionComplete).toHaveBeenCalledWith({ 
        type: 'STEPPED_DOWN', 
        newTerm: 5 
      });
    });
  });
  
  describe('投票リクエストの処理', () => {
    it('条件を満たす候補者に投票する', () => {
      const request: RequestVoteRequest = {
        term: 2,
        candidateId: 'node2',
        lastLogIndex: 0,
        lastLogTerm: 0
      };
      
      const response = election.handleRequestVote(request);
      
      expect(response.voteGranted).toBe(true);
      expect(response.term).toBe(2);
      expect(state.getVotedFor()).toBe('node2');
    });
    
    it('古いTermのリクエストは拒否する', () => {
      state.becomeCandidate();  // term = 1
      
      const request: RequestVoteRequest = {
        term: 0,
        candidateId: 'node2',
        lastLogIndex: 0,
        lastLogTerm: 0
      };
      
      const response = election.handleRequestVote(request);
      
      expect(response.voteGranted).toBe(false);
      expect(response.term).toBe(1);
    });
    
    it('同じTermで既に投票済みなら拒否する', () => {
      const request1: RequestVoteRequest = {
        term: 1,
        candidateId: 'node2',
        lastLogIndex: 0,
        lastLogTerm: 0
      };
      
      const request2: RequestVoteRequest = {
        term: 1,
        candidateId: 'node3',
        lastLogIndex: 0,
        lastLogTerm: 0
      };
      
      const response1 = election.handleRequestVote(request1);
      const response2 = election.handleRequestVote(request2);
      
      expect(response1.voteGranted).toBe(true);
      expect(response2.voteGranted).toBe(false);
      expect(state.getVotedFor()).toBe('node2');
    });
    
    it('ログが古い候補者には投票しない', () => {
      log.appendEntry(1, { type: 'SET', key: 'x', value: 1 });
      log.appendEntry(2, { type: 'SET', key: 'y', value: 2 });
      
      const request: RequestVoteRequest = {
        term: 3,
        candidateId: 'node2',
        lastLogIndex: 1,
        lastLogTerm: 1  // 自分より古い
      };
      
      const response = election.handleRequestVote(request);
      
      expect(response.voteGranted).toBe(false);
      expect(response.reason).toContain('ログが古い');
    });
    
    it('ログが同じくらい新しい候補者には投票する', () => {
      log.appendEntry(1, { type: 'SET', key: 'x', value: 1 });
      log.appendEntry(2, { type: 'SET', key: 'y', value: 2 });
      
      const request: RequestVoteRequest = {
        term: 3,
        candidateId: 'node2',
        lastLogIndex: 2,
        lastLogTerm: 2  // 同じ
      };
      
      const response = election.handleRequestVote(request);
      
      expect(response.voteGranted).toBe(true);
    });
    
    it('ログがより新しい候補者には投票する', () => {
      log.appendEntry(1, { type: 'SET', key: 'x', value: 1 });
      log.appendEntry(2, { type: 'SET', key: 'y', value: 2 });
      
      const request: RequestVoteRequest = {
        term: 3,
        candidateId: 'node2',
        lastLogIndex: 3,
        lastLogTerm: 3  // より新しい
      };
      
      const response = election.handleRequestVote(request);
      
      expect(response.voteGranted).toBe(true);
    });
  });
  
  describe('選挙タイムアウト', () => {
    it('選挙タイムアウトで新しい選挙を開始する', () => {
      const onTimeout = vi.fn();
      election.onElectionTimeout(onTimeout);
      
      // Followerで開始
      election.startElectionTimer();
      
      // タイムアウトを発生させる
      mockTime.advance(300);
      
      expect(onTimeout).toHaveBeenCalled();
    });
    
    it('リーダーになったら選挙タイマーを停止する', async () => {
      mockRPC.setResponse('node2', { term: 1, voteGranted: true });
      
      await election.startElection(() => {});
      
      expect(state.getState().type).toBe('leader');
      expect(timer.getActiveTimers().electionTimeout).toBe(false);
    });
    
    it('投票を受けたらタイマーをリセットする', () => {
      const resetSpy = vi.spyOn(timer, 'resetElectionTimeout');
      
      const request: RequestVoteRequest = {
        term: 1,
        candidateId: 'node2',
        lastLogIndex: 0,
        lastLogTerm: 0
      };
      
      election.handleRequestVote(request);
      
      expect(resetSpy).toHaveBeenCalled();
    });
  });
  
  describe('Split Vote対策', () => {
    it('選挙が失敗したら新しいランダムタイムアウトで再試行準備', async () => {
      mockRPC.setResponse('node2', { term: 1, voteGranted: false });
      mockRPC.setResponse('node3', { term: 1, voteGranted: false });
      
      // 1回目の選挙
      const onElectionComplete = vi.fn();
      await election.startElection(onElectionComplete);
      
      expect(onElectionComplete).toHaveBeenCalledWith({
        type: 'NOT_ELECTED',
        term: 1
      });
      
      // 選挙失敗後もCandidate状態のまま
      expect(state.getState().type).toBe('candidate');
    });
    
    it('選挙タイムアウトから再度選挙を開始する', () => {
      // 選挙タイムアウトコールバックを設定
      const timeoutCallback = vi.fn();
      election.onElectionTimeout(timeoutCallback);
      
      // 選挙タイマーを開始
      election.startElectionTimer();
      
      // タイムアウトを発生させる
      mockTime.advance(300);
      
      // タイムアウトコールバックが呼ばれることを確認
      expect(timeoutCallback).toHaveBeenCalled();
    });
  });
  
  describe('エラーケース', () => {
    it('RPCエラーでも選挙は継続される', async () => {
      mockRPC.setError('node2', new Error('ネットワークエラー'));
      mockRPC.setResponse('node3', { term: 1, voteGranted: true });
      
      const onElectionComplete = vi.fn();
      await election.startElection(onElectionComplete);
      
      // 1票(自分) + 1票(node3) = 2票で過半数
      expect(state.getState().type).toBe('leader');
      expect(onElectionComplete).toHaveBeenCalledWith({ 
        type: 'ELECTED',
        term: 1 
      });
    });
    
    it('すべてのRPCがエラーでも処理は完了する', async () => {
      mockRPC.setError('node2', new Error('ネットワークエラー'));
      mockRPC.setError('node3', new Error('ネットワークエラー'));
      
      const onElectionComplete = vi.fn();
      await election.startElection(onElectionComplete);
      
      // 自分の1票だけでは過半数に達しない
      expect(state.getState().type).toBe('candidate');
      expect(onElectionComplete).toHaveBeenCalledWith({ 
        type: 'NOT_ELECTED',
        term: 1 
      });
    });
  });
});

/**
 * テスト用のモックRPCクライアント
 */
class MockRPCClient {
  private responses = new Map<NodeId, RequestVoteResponse>();
  private errors = new Map<NodeId, Error>();
  
  setResponse(nodeId: NodeId, response: RequestVoteResponse): void {
    this.responses.set(nodeId, response);
    this.errors.delete(nodeId);
  }
  
  setError(nodeId: NodeId, error: Error): void {
    this.errors.set(nodeId, error);
    this.responses.delete(nodeId);
  }
  
  async sendRequestVote(
    nodeId: NodeId,
    request: RequestVoteRequest
  ): Promise<RequestVoteResponse> {
    // エラーが設定されている場合
    if (this.errors.has(nodeId)) {
      throw this.errors.get(nodeId);
    }
    
    // レスポンスが設定されている場合
    const response = this.responses.get(nodeId);
    if (response) {
      return response;
    }
    
    // デフォルトは拒否
    return {
      term: request.term,
      voteGranted: false,
      reason: 'モックレスポンス未設定'
    };
  }
}
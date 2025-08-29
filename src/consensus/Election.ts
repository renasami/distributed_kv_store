import type { 
  NodeId, 
  Term,
  RequestVoteRequest,
  RequestVoteResponse
} from '@/types';
import { RaftState } from '@/core/State';
import { RaftLog } from '@/core/Log';
import { RaftTimer } from '@/core/Timer';

/**
 * 選挙結果
 */
export type ElectionResult = 
  | { type: 'ELECTED'; term: Term }
  | { type: 'NOT_ELECTED'; term: Term }
  | { type: 'STEPPED_DOWN'; newTerm: Term };

/**
 * RPC客户端接口
 */
interface RPCClient {
  sendRequestVote(nodeId: NodeId, request: RequestVoteRequest): Promise<RequestVoteResponse>;
}

/**
 * リーダー選出を管理するクラス
 */
export class ElectionManager {
  private nodeId: NodeId;
  private peers: NodeId[];
  private state: RaftState;
  private log: RaftLog;
  private timer: RaftTimer;
  private rpcClient: RPCClient;
  
  private onElectionTimeoutCallback?: () => void;
  private currentElectionVotes = new Map<NodeId, boolean>();
  
  constructor(
    nodeId: NodeId,
    peers: NodeId[],
    state: RaftState,
    log: RaftLog,
    timer: RaftTimer,
    rpcClient: RPCClient
  ) {
    this.nodeId = nodeId;
    this.peers = peers;
    this.state = state;
    this.log = log;
    this.timer = timer;
    this.rpcClient = rpcClient;
    
    console.log(`情報: 選挙マネージャーを初期化しました: ノード=${nodeId}, ピア=[${peers.join(', ')}]`);
  }
  
  /**
   * 選挙を開始する
   */
  async startElection(onComplete: (result: ElectionResult) => void): Promise<void> {
    console.log(`情報: 選挙を開始します (Term ${this.state.getCurrentTerm() + 1})`);
    
    // Candidateになる
    this.state.becomeCandidate();
    const currentTerm = this.state.getCurrentTerm();
    
    // 投票をリセット
    this.currentElectionVotes.clear();
    this.currentElectionVotes.set(this.nodeId, true);  // 自分に投票
    
    console.log(`情報: Candidateになりました (Term: ${currentTerm}, 自分に投票)`);
    
    // RequestVoteリクエストを準備
    const request: RequestVoteRequest = {
      term: currentTerm,
      candidateId: this.nodeId,
      lastLogIndex: this.log.getLastIndex(),
      lastLogTerm: this.log.getLastTerm()
    };
    
    console.log(`情報: RequestVote準備完了 (lastLogIndex: ${request.lastLogIndex}, lastLogTerm: ${request.lastLogTerm})`);
    
    // 全ピアに並行して投票要求を送る
    const votePromises = this.peers.map(peer => 
      this.requestVoteFrom(peer, request)
    );
    
    // 投票結果を集計
    const responses = await Promise.allSettled(votePromises);
    
    console.log(`情報: ${responses.length}個のレスポンスを受信しました`);
    
    // 現在もCandidateか確認（途中でステップダウンしている可能性）
    if (this.state.getState().type !== 'candidate' || 
        this.state.getCurrentTerm() !== currentTerm) {
      console.log(`情報: 選挙中に状態変更されました (現在: ${this.state.getState().type}, Term: ${this.state.getCurrentTerm()})`);
      onComplete({ 
        type: 'STEPPED_DOWN', 
        newTerm: this.state.getCurrentTerm() 
      });
      return;
    }
    
    // 投票を集計
    let stepDownOccurred = false;
    responses.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const response = result.value;
        const peer = this.peers[index];
        
        console.log(`情報: ${peer}からのレスポンス: granted=${response.voteGranted}, term=${response.term}`);
        
        // より高いTermを見たらFollowerになる
        if (response.term > currentTerm) {
          console.log(`情報: より高いTermを受信しました (${currentTerm} -> ${response.term}), Followerに遷移`);
          this.state.becomeFollower(response.term);
          stepDownOccurred = true;
          onComplete({ type: 'STEPPED_DOWN', newTerm: response.term });
          return;
        }
        
        if (response.voteGranted) {
          const peer = this.peers[index];
          if (peer) {
            this.currentElectionVotes.set(peer, true);
          }
        }
      } else {
        const peer = this.peers[index];
        console.log(`エラー: ${peer}からの投票要求でエラー:`, String(result.reason));
      }
    });
    
    if (stepDownOccurred) {
      return;
    }
    
    // 過半数チェック
    const totalNodes = this.peers.length + 1;  // ピア + 自分
    const votesReceived = Array.from(this.currentElectionVotes.values())
      .filter(v => v).length;
    const majority = Math.floor(totalNodes / 2) + 1;
    
    console.log(`情報: 投票結果: ${votesReceived}/${totalNodes} (過半数=${majority})`);
    
    if (votesReceived >= majority) {
      // リーダーになる
      this.state.becomeLeader();
      this.timer.stopElectionTimeout();
      console.log(`情報: リーダーに選出されました！(Term=${currentTerm})`);
      onComplete({ type: 'ELECTED', term: currentTerm });
    } else {
      // 選挙失敗
      console.log(`情報: 選挙に失敗しました (Term=${currentTerm})`);
      onComplete({ type: 'NOT_ELECTED', term: currentTerm });
    }
  }
  
  /**
   * RequestVoteリクエストを処理する
   */
  handleRequestVote(request: RequestVoteRequest): RequestVoteResponse {
    const currentTerm = this.state.getCurrentTerm();
    
    console.log(`情報: 投票リクエスト受信: from=${request.candidateId}, term=${request.term}`);
    
    // より高いTermを見たらFollowerになる
    if (request.term > currentTerm) {
      console.log(`情報: より高いTermを受信 (${currentTerm} -> ${request.term}), Followerに遷移`);
      this.state.becomeFollower(request.term);
    }
    
    // 古いTermのリクエストは拒否
    if (request.term < this.state.getCurrentTerm()) {
      console.log(`情報: 古いTermのため拒否: ${request.term} < ${this.state.getCurrentTerm()}`);
      return {
        term: this.state.getCurrentTerm(),
        voteGranted: false,
        reason: '古いTerm'
      };
    }
    
    // 投票可能かチェック
    const canVote = this.state.canVoteFor(request.candidateId);
    if (!canVote) {
      console.log(`情報: 既に投票済みのため拒否: votedFor=${this.state.getVotedFor()}`);
      return {
        term: this.state.getCurrentTerm(),
        voteGranted: false,
        reason: '既に投票済み'
      };
    }
    
    // ログの新しさをチェック
    const logIsUpToDate = this.isLogUpToDate(
      request.lastLogTerm,
      request.lastLogIndex
    );
    
    if (!logIsUpToDate) {
      console.log(`情報: ログが古いため拒否 (candidate: term=${request.lastLogTerm}, index=${request.lastLogIndex} vs my: term=${this.log.getLastTerm()}, index=${this.log.getLastIndex()})`);
      return {
        term: this.state.getCurrentTerm(),
        voteGranted: false,
        reason: 'ログが古い'
      };
    }
    
    // 投票する
    this.state.recordVote(request.candidateId);
    this.timer.resetElectionTimeout(() => this.handleElectionTimeout());
    
    console.log(`情報: ${request.candidateId}に投票しました`);
    
    return {
      term: this.state.getCurrentTerm(),
      voteGranted: true
    };
  }
  
  /**
   * ログの新しさを判定
   */
  private isLogUpToDate(candidateTerm: Term, candidateIndex: number): boolean {
    const lastTerm = this.log.getLastTerm();
    const lastIndex = this.log.getLastIndex();
    
    // 候補者のログの方が新しいTermを持つ
    if (candidateTerm > lastTerm) {
      return true;
    }
    
    // 同じTermで、候補者のインデックスが同じか大きい
    if (candidateTerm === lastTerm && candidateIndex >= lastIndex) {
      return true;
    }
    
    // その他は古い
    return false;
  }
  
  /**
   * 特定のノードに投票を要求
   */
  private async requestVoteFrom(
    peer: NodeId,
    request: RequestVoteRequest
  ): Promise<RequestVoteResponse> {
    try {
      console.log(`情報: 投票要求送信: to=${peer}`);
      const response = await this.rpcClient.sendRequestVote(peer, request);
      console.log(`情報: 投票応答受信: from=${peer}, granted=${response.voteGranted}`);
      return response;
    } catch (error) {
      console.error(`エラー: ${peer}への投票要求が失敗:`, error);
      // エラーの場合は投票なしとして扱う
      return {
        term: request.term,
        voteGranted: false,
        reason: 'ネットワークエラー'
      };
    }
  }
  
  /**
   * 選挙タイマーを開始
   */
  startElectionTimer(): void {
    this.timer.startElectionTimeout(() => this.handleElectionTimeout());
  }
  
  /**
   * 選挙タイムアウトハンドラ
   */
  private handleElectionTimeout(): void {
    console.log('情報: 選挙タイムアウトが発生');
    
    if (this.state.getState().type === 'leader') {
      // リーダーは選挙タイムアウトを無視
      console.log('情報: リーダーのため選挙タイムアウトを無視');
      return;
    }
    
    // 選挙を開始
    if (this.onElectionTimeoutCallback) {
      this.onElectionTimeoutCallback();
    }
    
    this.startElection((result) => {
      if (result.type === 'NOT_ELECTED') {
        // 選挙失敗したら新しいタイムアウトで再試行
        console.log('情報: 選挙失敗、新しいタイムアウトで再試行');
        this.startElectionTimer();
      }
    });
  }
  
  /**
   * 選挙タイムアウトコールバックを設定
   */
  onElectionTimeout(callback: () => void): void {
    this.onElectionTimeoutCallback = callback;
  }
}
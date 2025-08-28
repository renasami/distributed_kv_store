import type { NodeId, Term, NodeState } from '@/types';

/**
 * Raftノードの状態を管理するクラス
 */
export class RaftState {
  private nodeId: NodeId;
  private currentTerm: Term = 0;
  private state: NodeState = { type: 'follower' };
  private votedFor: NodeId | null = null;
  private electionTimeoutActive = true;

  constructor(nodeId: NodeId) {
    if (!nodeId || nodeId.trim() === '') {
      throw new Error('エラー: 無効なノードIDが指定されました');
    }
    
    this.nodeId = nodeId;
    console.log(`情報: ノード${nodeId}を初期化しました`);
  }

  /**
   * ノードIDを取得する
   */
  getNodeId(): NodeId {
    return this.nodeId;
  }

  /**
   * 現在の状態を取得する
   */
  getState(): NodeState {
    return this.state;
  }

  /**
   * 現在のTermを取得する
   */
  getCurrentTerm(): Term {
    return this.currentTerm;
  }

  /**
   * 投票先を取得する
   */
  getVotedFor(): NodeId | null {
    return this.votedFor;
  }

  /**
   * Follower状態に遷移する
   * @param term 新しいTerm番号
   * @param leaderId リーダーのID（オプション）
   */
  becomeFollower(term: Term, leaderId?: NodeId): void {
    if (term < this.currentTerm) {
      throw new Error(`エラー: 古いTerm(${term})への遷移は許可されません`);
    }

    this.state = { type: 'follower', leaderId };
    this.currentTerm = term;
    this.votedFor = null;
    this.electionTimeoutActive = true;

    console.log(`情報: Follower状態に遷移しました (Term: ${term}, Leader: ${leaderId || '不明'})`);
  }

  /**
   * Candidate状態に遷移する
   * Termを自動的にインクリメントし、自分自身に投票する
   */
  becomeCandidate(): void {
    this.currentTerm += 1;
    this.state = { type: 'candidate' };
    this.votedFor = this.nodeId;
    this.electionTimeoutActive = true;

    console.log(`情報: Candidate状態に遷移しました (Term: ${this.currentTerm})`);
  }

  /**
   * Leader状態に遷移する
   */
  becomeLeader(): void {
    this.state = { type: 'leader' };
    this.electionTimeoutActive = false;

    console.log(`情報: Leader状態に遷移しました (Term: ${this.currentTerm})`);
  }

  /**
   * 指定した候補者に投票できるかチェックする
   * @param candidateId 候補者のID
   */
  canVoteFor(candidateId: NodeId): boolean {
    return this.votedFor === null || this.votedFor === candidateId;
  }

  /**
   * 投票を記録する
   * @param candidateId 投票先の候補者ID
   */
  recordVote(candidateId: NodeId): void {
    this.votedFor = candidateId;
    console.log(`情報: ${candidateId}に投票しました (Term: ${this.currentTerm})`);
  }

  /**
   * より高いTermを受信した場合の処理
   * @param newTerm 新しいTerm
   * @returns Termが更新された場合true
   */
  updateTerm(newTerm: Term): boolean {
    if (newTerm > this.currentTerm) {
      console.log(`情報: より高いTermを受信しました (${this.currentTerm} → ${newTerm})`);
      
      this.currentTerm = newTerm;
      this.state = { type: 'follower' };
      this.votedFor = null;
      this.electionTimeoutActive = true;
      
      return true;
    }
    return false;
  }

  /**
   * 選挙タイムアウトがアクティブかどうか
   */
  isElectionTimeoutActive(): boolean {
    return this.electionTimeoutActive;
  }

  /**
   * 選挙タイムアウトをリセットする（Leader専用）
   */
  resetElectionTimeout(): void {
    if (this.state.type !== 'leader') {
      throw new Error('エラー: Leader状態ではありません');
    }
    console.log('情報: ハートビートタイムアウトをリセットしました');
  }

  /**
   * デバッグ用の状態出力
   */
  toString(): string {
    return `RaftState{nodeId: ${this.nodeId}, term: ${this.currentTerm}, state: ${this.state.type}, votedFor: ${this.votedFor}}`;
  }
}
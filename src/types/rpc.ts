import type { NodeId, Term, LogIndex, LogEntry } from './index';

/**
 * RequestVote RPC リクエスト
 */
export interface RequestVoteRequest {
  term: Term;
  candidateId: NodeId;
  lastLogIndex: LogIndex;
  lastLogTerm: Term;
}

/**
 * RequestVote RPC レスポンス
 */
export interface RequestVoteResponse {
  term: Term;
  voteGranted: boolean;
  reason?: string;  // デバッグ用
}

/**
 * AppendEntries RPC リクエスト（ハートビート含む）
 */
export interface AppendEntriesRequest {
  term: Term;
  leaderId: NodeId;
  prevLogIndex: LogIndex;
  prevLogTerm: Term;
  entries: LogEntry[];
  leaderCommit: LogIndex;
}

/**
 * AppendEntries RPC レスポンス
 */
export interface AppendEntriesResponse {
  term: Term;
  success: boolean;
  matchIndex?: LogIndex;
  reason?: string;  // デバッグ用
}

/**
 * RPC結果（ネットワークエラー含む）
 */
export type RPCResult<T> = 
  | { ok: true; value: T }
  | { ok: false; error: RPCError };

export type RPCError = 
  | { type: 'TIMEOUT' }
  | { type: 'NETWORK_ERROR'; message: string }
  | { type: 'NODE_UNAVAILABLE'; nodeId: NodeId };
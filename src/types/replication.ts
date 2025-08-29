import type { NodeId, LogIndex, Term } from './index';

/**
 * レプリケーション状態
 */
export interface ReplicationState {
  nodeId: NodeId;
  nextIndex: LogIndex;      // 次に送信するインデックス
  matchIndex: LogIndex;     // 一致が確認された最大インデックス
  inflightRequest: boolean; // 送信中のリクエストがあるか
  lastContact: number;      // 最後の通信時刻
}

/**
 * コミット情報
 */
export interface CommitInfo {
  index: LogIndex;
  term: Term;
  timestamp: number;
}

/**
 * レプリケーション結果
 */
export type ReplicationResult = 
  | { type: 'SUCCESS'; matchIndex: LogIndex }
  | { type: 'LOG_INCONSISTENCY'; conflictIndex: LogIndex; conflictTerm: Term }
  | { type: 'TERM_MISMATCH'; higherTerm: Term }
  | { type: 'TIMEOUT' }
  | { type: 'NETWORK_ERROR'; error: string };

/**
 * クライアントコマンド結果
 */
export type CommandResult<T = unknown> = 
  | { ok: true; value: T; index: LogIndex }
  | { ok: false; error: CommandError };

export type CommandError = 
  | { type: 'NOT_LEADER'; leaderId?: NodeId }
  | { type: 'TIMEOUT' }
  | { type: 'NO_MAJORITY' }
  | { type: 'INTERNAL_ERROR'; message: string };

/**
 * レプリケーション設定
 */
export interface ReplicationConfig {
  maxBatchSize: number;
  replicationTimeout: number;
  maxRetries: number;
  heartbeatInterval: number;
}

/**
 * レプリケーション統計情報
 */
export interface ReplicationStats {
  totalReplications: number;
  successfulReplications: number;
  failedReplications: number;
  averageReplicationTime: number;
  lastReplicationTime: number;
}
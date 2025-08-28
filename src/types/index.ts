/**
 * 基本的な型エイリアス
 */
export type NodeId = string;
export type Term = number;
export type LogIndex = number;

/**
 * コマンド操作の定義
 */
export type Command = 
  | { type: 'SET'; key: string; value: unknown }
  | { type: 'DELETE'; key: string }
  | { type: 'NOOP' };  // リーダー確立用の特殊コマンド

/**
 * ノード状態（判別可能なユニオン型）
 */
export type NodeState = 
  | { type: 'follower'; leaderId?: NodeId }
  | { type: 'candidate' }
  | { type: 'leader' };

/**
 * ログエントリ
 */
export interface LogEntry {
  term: Term;
  index: LogIndex;
  command: Command;
  timestamp: number;
}

/**
 * Result型（エラーハンドリング用）
 */
export type Result<T, E> = 
  | { ok: true; value: T }
  | { ok: false; error: E };

/**
 * 投票要求メッセージ
 */
export interface VoteRequest {
  term: Term;
  candidateId: NodeId;
  lastLogIndex: LogIndex;
  lastLogTerm: Term;
}

/**
 * 投票応答メッセージ
 */
export interface VoteResponse {
  term: Term;
  voteGranted: boolean;
}

/**
 * ログ複製要求メッセージ
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
 * ログ複製応答メッセージ
 */
export interface AppendEntriesResponse {
  term: Term;
  success: boolean;
  matchIndex?: LogIndex;
}

/**
 * ログ管理のエラー型
 */
export type LogError = 
  | { type: 'INDEX_OUT_OF_BOUNDS'; index: LogIndex }
  | { type: 'NON_SEQUENTIAL_INDEX'; expected: LogIndex; received: LogIndex }
  | { type: 'CANNOT_TRUNCATE_COMMITTED'; index: LogIndex }
  | { type: 'INVALID_TERM'; currentTerm: Term; receivedTerm: Term }
  | { type: 'EMPTY_LOG' };

/**
 * ログ統計情報
 */
export interface LogStats {
  totalEntries: number;
  lastIndex: LogIndex;
  lastTerm: Term;
  terms: Term[];
}

/**
 * Raftエラーの種類
 */
export type RaftError = 
  | 'INVALID_TERM'
  | 'ALREADY_VOTED'
  | 'LOG_INCONSISTENCY'
  | 'NOT_LEADER'
  | 'NODE_UNAVAILABLE'
  | 'TIMEOUT';

/**
 * タイマー関連の型
 */
export type TimerId = string;
export type Milliseconds = number;

/**
 * タイマーコールバック
 */
export type TimerCallback = () => void;

/**
 * タイマー設定
 */
export interface TimerConfig {
  electionTimeoutMin: Milliseconds;
  electionTimeoutMax: Milliseconds;
  heartbeatInterval: Milliseconds;
}

/**
 * デフォルト設定
 */
export const DEFAULT_TIMER_CONFIG: TimerConfig = {
  electionTimeoutMin: 150,
  electionTimeoutMax: 300,
  heartbeatInterval: 50
};

/**
 * タイマーイベント
 */
export type TimerEvent = 
  | { type: 'ELECTION_TIMEOUT' }
  | { type: 'HEARTBEAT_INTERVAL' }
  | { type: 'REQUEST_TIMEOUT'; requestId: string };

/**
 * 時間プロバイダーインターフェース（テスト用）
 */
export interface TimeProvider {
  now(): number;
  setTimeout(callback: TimerCallback, delay: Milliseconds): TimerId;
  clearTimeout(timerId: TimerId): void;
}

/**
 * ノード設定
 */
export interface NodeConfig {
  nodeId: NodeId;
  peers: NodeId[];
  electionTimeoutMs: number;
  heartbeatIntervalMs: number;
  port: number;
}
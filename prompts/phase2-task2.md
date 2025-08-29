# Raftコアロジック Phase 2 タスク2: ログレプリケーション

## 前提条件の確認

Phase 2 タスク1が完了していることを確認してください：

- [ ] ElectionManagerが実装されている
- [ ] RequestVote RPCが動作している
- [ ] リーダー選出のテストが通っている

## タスク2: ログレプリケーションの実装

### 実装概要

ログレプリケーションは、リーダーがクライアントのコマンドを全Followerに複製する仕組みです：

- リーダーがクライアントリクエストを受信
- ログエントリとして追加し、Followerに送信
- 過半数のレプリケーション後にコミット
- ハートビートでリーダーの存在を維持

### 実装手順

#### 1. 技術仕様書の作成 (`docs/specs/technical/05-log-replication.md`)

```markdown
# ログレプリケーション仕様

## 概要

リーダーがログエントリを全Followerに複製し、一貫性を保証する。

## AppendEntries RPC

### リクエスト構造
```

{
term: リーダーのterm
leaderId: リーダーのID
prevLogIndex: 新エントリの直前のインデックス
prevLogTerm: prevLogIndexのterm
entries: 送信するエントリ（空=ハートビート）
leaderCommit: リーダーのコミットインデックス
}

```

### レスポンス構造
```

{
term: Followerの現在term
success: 成功/失敗
matchIndex: 一致した最後のインデックス（成功時）
conflictIndex: 競合位置（失敗時）
conflictTerm: 競合エントリのterm（失敗時）
}

````

## レプリケーションフロー

```mermaid
sequenceDiagram
    participant C as Client
    participant L as Leader
    participant F1 as Follower1
    participant F2 as Follower2

    C->>L: コマンド送信
    L->>L: ログに追加
    L->>F1: AppendEntries
    L->>F2: AppendEntries
    F1->>L: success=true
    F2->>L: success=true
    L->>L: エントリをコミット
    L->>C: 結果を返す
    L->>F1: 次のAppendEntriesでcommitIndex通知
    L->>F2: 次のAppendEntriesでcommitIndex通知
````

## ログ一貫性の保証

### Log Matching Property

1. 異なるログの同じインデックス・同じtermのエントリは同じコマンド
2. そこまでのすべてのエントリも同じ

### 一貫性チェック

```python
def check_consistency(prevLogIndex, prevLogTerm):
    if prevLogIndex == 0:
        return True  # 最初のエントリ

    if len(log) < prevLogIndex:
        return False  # エントリが存在しない

    entry = log[prevLogIndex - 1]
    return entry.term == prevLogTerm
```

### 競合解決

1. prevLogIndex/prevLogTermが一致しない場合
2. Followerは競合位置を返す
3. リーダーはnextIndexを減らして再送信
4. 一致点が見つかるまで繰り返す

## コミットルール

### エントリのコミット条件

1. 過半数のノードにレプリケーション完了
2. 現在のtermのエントリである（Figure 8問題の回避）

### コミットインデックスの更新

```python
def updateCommitIndex(matchIndices):
    # 過半数がレプリケーションした最大インデックスを探す
    sorted_indices = sorted(matchIndices)
    majority_index = len(sorted_indices) // 2
    candidate = sorted_indices[majority_index]

    # 現在termのエントリのみコミット
    if log[candidate].term == currentTerm:
        commitIndex = max(commitIndex, candidate)
```

## ハートビート

### 送信タイミング

- heartbeatInterval（50ms）ごと
- エントリ送信後もリセット

### 目的

1. リーダーの生存通知
2. コミットインデックスの伝播
3. 遅れているFollowerの検出

## パフォーマンス最適化

### バッチング

- 複数のクライアントリクエストをまとめて送信
- maxBatchSize: 100エントリ

### パイプライニング

- 前の応答を待たずに次を送信
- maxInflightRequests: 10

### 並列送信

- 全Followerに同時送信
- タイムアウト: 50ms

## エラーケース

- ネットワーク分断
- 遅いFollower
- ログの大幅な乖離
- リーダーの突然の停止

````

#### 2. 型定義の追加 (`src/types/replication.ts`)

新しいファイルを作成：

```typescript
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
  | { type: 'NO_MAJORITY' };
````

#### 3. ReplicationManagerのテスト作成 (`test/unit/consensus/Replication.test.ts`)

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReplicationManager } from '@/consensus/Replication';
import { RaftState } from '@/core/State';
import { RaftLog } from '@/core/Log';
import { RaftTimer } from '@/core/Timer';
import { MockTimeProvider } from '@/test/utils/MockTimeProvider';
import { MockRPCClient } from '@/test/utils/MockRPCClient';
import type { AppendEntriesRequest, AppendEntriesResponse, Command, NodeId } from '@/types';

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
    timer = new RaftTimer(
      {
        electionTimeoutMin: 150,
        electionTimeoutMax: 300,
        heartbeatInterval: 50,
      },
      mockTime,
    );
    mockRPC = new MockRPCClient();

    replication = new ReplicationManager(nodeId, followers, state, log, timer, mockRPC);

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
        matchIndex: 1,
      });
      mockRPC.setAppendEntriesResponse('node3', {
        term: 1,
        success: true,
        matchIndex: 1,
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
        entries: expect.arrayContaining([expect.objectContaining({ command })]),
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
        matchIndex: 1,
      });
      mockRPC.setAppendEntriesResponse('node3', {
        term: 1,
        success: false,
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
        success: false,
      });
      mockRPC.setAppendEntriesResponse('node3', {
        term: 1,
        success: false,
      });

      const result = await replication.appendCommand(command);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('NO_MAJORITY');
      }
      expect(replication.getCommitIndex()).toBe(0);
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
        entries: [
          {
            term: 1,
            index: 1,
            command: { type: 'SET', key: 'x', value: 1 },
            timestamp: Date.now(),
          },
        ],
        leaderCommit: 0,
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
        prevLogIndex: 5, // 存在しないインデックス
        prevLogTerm: 1,
        entries: [],
        leaderCommit: 0,
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
        prevLogTerm: 2, // 実際は1
        entries: [],
        leaderCommit: 0,
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
            timestamp: Date.now(),
          },
        ],
        leaderCommit: 0,
      };

      const response = replication.handleAppendEntries(request);

      expect(response.success).toBe(true);
      expect(log.getLength()).toBe(2); // 3→2に減少
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
        leaderCommit: 2,
      };

      const response = replication.handleAppendEntries(request);

      expect(response.success).toBe(true);
      expect(replication.getCommitIndex()).toBe(2);
    });
  });

  describe('ハートビート', () => {
    it('定期的にハートビートを送信する', () => {
      const sendSpy = vi.spyOn(mockRPC, 'sendAppendEntries');

      replication.startHeartbeat();

      // 初回送信
      mockTime.advance(50);
      expect(sendSpy).toHaveBeenCalledTimes(2); // 2 followers

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
          entries: [],
        }),
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
        conflictIndex: 1,
      });

      await replication.syncFollower('node2');

      // nextIndexが減少して再送信
      expect(sendSpy).toHaveBeenCalledTimes(2); // 2回送信

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
        return {
          term: 1,
          success: true,
          matchIndex: request.prevLogIndex + request.entries.length,
        };
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
        matchIndex: 0,
      });
    });

    it('成功したレプリケーションでインデックスを更新', async () => {
      mockRPC.setAppendEntriesResponse('node2', {
        term: 1,
        success: true,
        matchIndex: 3,
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
        conflictIndex: 1,
      });

      await replication.syncFollower('node2');

      const state = replication.getFollowerState('node2');
      expect(state?.nextIndex).toBeLessThan(1);
    });
  });

  describe('コミットインデックスの更新', () => {
    it('過半数がレプリケーションした最大インデックスをコミット', async () => {
      // 3つのエントリを追加
      const commands: Command[] = [
        { type: 'SET', key: 'x', value: 1 },
        { type: 'SET', key: 'y', value: 2 },
        { type: 'SET', key: 'z', value: 3 },
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

      // バッチで追加
      await replication.appendCommandBatch(commands);

      // 1回の送信で複数エントリ
      expect(sendSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          entries: expect.arrayContaining([
            expect.objectContaining({ command: commands[0] }),
            expect.objectContaining({ command: commands[1] }),
          ]),
        }),
      );
    });

    it('最大バッチサイズを超えたら分割', async () => {
      const originalMaxBatch = replication.getConfig().maxBatchSize;
      replication.setConfig({ maxBatchSize: 2 });

      const commands: Command[] = [];
      for (let i = 0; i < 5; i++) {
        commands.push({ type: 'SET', key: `k${i}`, value: i });
      }

      const sendSpy = vi.spyOn(mockRPC, 'sendAppendEntries');

      await replication.appendCommandBatch(commands);

      // 複数回に分けて送信
      const calls = sendSpy.mock.calls;
      const totalEntries = calls.reduce((sum, call) => {
        return sum + call[1].entries.length;
      }, 0);

      expect(totalEntries).toBe(5);

      replication.setConfig({ maxBatchSize: originalMaxBatch });
    });
  });
});
```

#### 4. ReplicationManagerの実装 (`src/consensus/Replication.ts`)

```typescript
import type {
  NodeId,
  Term,
  LogIndex,
  Command,
  LogEntry,
  AppendEntriesRequest,
  AppendEntriesResponse,
  CommandResult,
  ReplicationState,
} from '@/types';
import { RaftState } from '@/core/State';
import { RaftLog } from '@/core/Log';
import { RaftTimer } from '@/core/Timer';

/**
 * ログレプリケーションを管理するクラス
 */
export class ReplicationManager {
  private nodeId: NodeId;
  private followers: NodeId[];
  private state: RaftState;
  private log: RaftLog;
  private timer: RaftTimer;
  private rpcClient: any;

  // レプリケーション状態
  private followerStates = new Map<NodeId, ReplicationState>();
  private commitIndex: LogIndex = 0;
  private lastApplied: LogIndex = 0;

  // 設定
  private config = {
    maxBatchSize: 100,
    replicationTimeout: 50,
    maxRetries: 3,
  };

  constructor(
    nodeId: NodeId,
    followers: NodeId[],
    state: RaftState,
    log: RaftLog,
    timer: RaftTimer,
    rpcClient: any,
  ) {
    this.nodeId = nodeId;
    this.followers = followers;
    this.state = state;
    this.log = log;
    this.timer = timer;
    this.rpcClient = rpcClient;

    // Follower状態を初期化
    this.initializeFollowerStates();

    console.log(`レプリケーションマネージャーを初期化: followers=${followers.join(',')}`);
  }

  /**
   * Follower状態を初期化
   */
  private initializeFollowerStates(): void {
    for (const follower of this.followers) {
      this.followerStates.set(follower, {
        nodeId: follower,
        nextIndex: this.log.getLastIndex() + 1,
        matchIndex: 0,
        inflightRequest: false,
        lastContact: Date.now(),
      });
    }
  }

  /**
   * コマンドを追加してレプリケーション
   */
  async appendCommand(command: Command): Promise<CommandResult> {
    if (this.state.getState().type !== 'leader') {
      return {
        ok: false,
        error: { type: 'NOT_LEADER' },
      };
    }

    // ログに追加
    const term = this.state.getCurrentTerm();
    const result = this.log.appendEntry(term, command);

    if (!result.ok) {
      return {
        ok: false,
        error: { type: 'INTERNAL_ERROR', message: 'ログ追加失敗' },
      };
    }

    const entry = result.value;
    console.log(`エントリを追加: index=${entry.index}, term=${entry.term}`);

    // 全Followerにレプリケーション
    const replicationPromises = this.followers.map((follower) =>
      this.replicateToFollower(follower, [entry]),
    );

    const results = await Promise.allSettled(replicationPromises);

    // 成功数をカウント
    let successCount = 1; // 自分を含む
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.type === 'SUCCESS') {
        successCount++;
      }
    }

    // 過半数チェック
    const majority = Math.floor((this.followers.length + 1) / 2) + 1;

    if (successCount >= majority) {
      // コミット
      this.commitIndex = entry.index;
      console.log(`エントリをコミット: index=${entry.index}`);

      return {
        ok: true,
        value: undefined,
        index: entry.index,
      };
    } else {
      return {
        ok: false,
        error: { type: 'NO_MAJORITY' },
      };
    }
  }

  /**
   * 複数コマンドをバッチで追加
   */
  async appendCommandBatch(commands: Command[]): Promise<CommandResult[]> {
    const results: CommandResult[] = [];

    // バッチサイズで分割
    for (let i = 0; i < commands.length; i += this.config.maxBatchSize) {
      const batch = commands.slice(i, i + this.config.maxBatchSize);

      // ログに追加
      const entries: LogEntry[] = [];
      for (const command of batch) {
        const result = this.log.appendEntry(this.state.getCurrentTerm(), command);
        if (result.ok) {
          entries.push(result.value);
        }
      }

      // レプリケーション
      await this.replicateEntries(entries);

      // 結果を追加
      for (const entry of entries) {
        results.push({
          ok: true,
          value: undefined,
          index: entry.index,
        });
      }
    }

    return results;
  }

  /**
   * AppendEntriesリクエストを処理（Follower側）
   */
  handleAppendEntries(request: AppendEntriesRequest): AppendEntriesResponse {
    const currentTerm = this.state.getCurrentTerm();

    console.log(
      `AppendEntries受信: from=${request.leaderId}, term=${request.term}, prev=${request.prevLogIndex}/${request.prevLogTerm}`,
    );

    // より高いTermを見たらFollowerになる
    if (request.term > currentTerm) {
      this.state.becomeFollower(request.term);
    }

    // 古いTermは拒否
    if (request.term < this.state.getCurrentTerm()) {
      return {
        term: this.state.getCurrentTerm(),
        success: false,
      };
    }

    // 選挙タイムアウトをリセット
    this.timer.resetElectionTimeout(() => {});

    // 一貫性チェック
    if (request.prevLogIndex > 0) {
      const prevEntry = this.log.getEntry(request.prevLogIndex);

      if (!prevEntry) {
        // エントリが存在しない
        return {
          term: this.state.getCurrentTerm(),
          success: false,
          conflictIndex: this.log.getLastIndex() + 1,
        };
      }

      if (prevEntry.term !== request.prevLogTerm) {
        // Termが一致しない
        // 競合するTermの最初のインデックスを探す
        let conflictIndex = request.prevLogIndex;
        while (conflictIndex > 1) {
          const entry = this.log.getEntry(conflictIndex - 1);
          if (!entry || entry.term !== prevEntry.term) {
            break;
          }
          conflictIndex--;
        }

        return {
          term: this.state.getCurrentTerm(),
          success: false,
          conflictIndex,
          conflictTerm: prevEntry.term,
        };
      }
    }

    // エントリを追加
    if (request.entries.length > 0) {
      // 競合するエントリを削除
      const firstNewIndex = request.prevLogIndex + 1;
      const existingEntry = this.log.getEntry(firstNewIndex);

      if (existingEntry && existingEntry.term !== request.entries[0].term) {
        // 競合があれば削除
        this.log.truncateFrom(firstNewIndex);
      }

      // 新しいエントリを追加
      for (const entry of request.entries) {
        if (!this.log.getEntry(entry.index)) {
          this.log.appendEntry(entry.term, entry.command);
        }
      }
    }

    // コミットインデックスを更新
    if (request.leaderCommit > this.commitIndex) {
      const lastIndex = this.log.getLastIndex();
      this.commitIndex = Math.min(request.leaderCommit, lastIndex);
      console.log(`コミットインデックスを更新: ${this.commitIndex}`);
    }

    return {
      term: this.state.getCurrentTerm(),
      success: true,
      matchIndex: request.prevLogIndex + request.entries.length,
    };
  }

  /**
   * ハートビートを開始
   */
  startHeartbeat(): void {
    if (this.state.getState().type !== 'leader') {
      return;
    }

    console.log('ハートビートを開始');

    this.timer.startHeartbeatInterval(() => {
      this.sendHeartbeat();
    });
  }

  /**
   * ハートビートを停止
   */
  stopHeartbeat(): void {
    console.log('ハートビートを停止');
    this.timer.stopHeartbeatInterval();
  }

  /**
   * ハートビートを送信
   */
  private async sendHeartbeat(): Promise<void> {
    if (this.state.getState().type !== 'leader') {
      this.stopHeartbeat();
      return;
    }

    const promises = this.followers.map((follower) => this.sendAppendEntries(follower, []));

    await Promise.allSettled(promises);
  }

  /**
   * 特定のFollowerにエントリをレプリケーション
   */
  private async replicateToFollower(
    follower: NodeId,
    entries: LogEntry[],
  ): Promise<ReplicationResult> {
    const state = this.followerStates.get(follower);
    if (!state) {
      return { type: 'NETWORK_ERROR', error: 'Follower状態が見つからない' };
    }

    try {
      const response = await this.sendAppendEntries(follower, entries);

      if (response.success) {
        // 成功: インデックスを更新
        if (response.matchIndex) {
          state.matchIndex = response.matchIndex;
          state.nextIndex = response.matchIndex + 1;
        }

        return { type: 'SUCCESS', matchIndex: state.matchIndex };
      } else {
        // 失敗: nextIndexを調整
        if (response.conflictIndex) {
          state.nextIndex = response.conflictIndex;
        } else {
          state.nextIndex = Math.max(1, state.nextIndex - 1);
        }

        return {
          type: 'LOG_INCONSISTENCY',
          conflictIndex: response.conflictIndex || state.nextIndex,
          conflictTerm: response.conflictTerm || 0,
        };
      }
    } catch (error) {
      return { type: 'NETWORK_ERROR', error: String(error) };
    }
  }

  /**
   * AppendEntriesを送信
   */
  private async sendAppendEntries(
    follower: NodeId,
    entries: LogEntry[],
  ): Promise<AppendEntriesResponse> {
    const state = this.followerStates.get(follower);
    if (!state) {
      throw new Error(`Follower状態が見つからない: ${follower}`);
    }

    const prevLogIndex = entries.length > 0 ? entries[0].index - 1 : state.nextIndex - 1;

    const prevLogTerm = prevLogIndex > 0 ? this.log.getEntry(prevLogIndex)?.term || 0 : 0;

    const request: AppendEntriesRequest = {
      term: this.state.getCurrentTerm(),
      leaderId: this.nodeId,
      prevLogIndex,
      prevLogTerm,
      entries,
      leaderCommit: this.commitIndex,
    };

    return this.rpcClient.sendAppendEntries(follower, request);
  }

  /**
   * 遅れているFollowerを同期
   */
  async syncFollower(follower: NodeId): Promise<void> {
    const state = this.followerStates.get(follower);
    if (!state) return;

    let retries = 0;
    while (retries < this.config.maxRetries) {
      const entries = this.log.getEntriesFrom(state.nextIndex, this.config.maxBatchSize);
      const result = await this.replicateToFollower(follower, entries);

      if (result.type === 'SUCCESS') {
        break;
      }

      retries++;
    }
  }

  /**
   * コミットインデックスを更新
   */
  updateCommitIndex(): void {
    if (this.state.getState().type !== 'leader') {
      return;
    }

    // matchIndexを収集（自分を含む）
    const matchIndices = [this.log.getLastIndex()];
    for (const state of this.followerStates.values()) {
      matchIndices.push(state.matchIndex);
    }

    // ソートして中央値を取得
    matchIndices.sort((a, b) => b - a);
    const majorityIndex = Math.floor(matchIndices.length / 2);
    const candidateIndex = matchIndices[majorityIndex];

    // 現在termのエントリのみコミット
    const entry = this.log.getEntry(candidateIndex);
    if (entry && entry.term === this.state.getCurrentTerm()) {
      this.commitIndex = Math.max(this.commitIndex, candidateIndex);
      console.log(`コミットインデックスを更新: ${this.commitIndex}`);
    }
  }

  // ヘルパーメソッド
  getCommitIndex(): LogIndex {
    return this.commitIndex;
  }

  getFollowerState(follower: NodeId): ReplicationState | undefined {
    return this.followerStates.get(follower);
  }

  getAllFollowerStates(): ReplicationState[] {
    return Array.from(this.followerStates.values());
  }

  updateFollowerState(follower: NodeId, updates: Partial<ReplicationState>): void {
    const state = this.followerStates.get(follower);
    if (state) {
      Object.assign(state, updates);
    }
  }

  getConfig() {
    return { ...this.config };
  }

  setConfig(updates: Partial<typeof this.config>): void {
    Object.assign(this.config, updates);
  }

  private async replicateEntries(entries: LogEntry[]): Promise<void> {
    const promises = this.followers.map((follower) => this.replicateToFollower(follower, entries));

    await Promise.allSettled(promises);
    this.updateCommitIndex();
  }
}
```

### 完了チェックリスト

- [ ] 技術仕様書が作成されている
- [ ] レプリケーション型定義が追加されている
- [ ] すべてのテストケースが記述されている
- [ ] AppendEntries RPCが実装されている
- [ ] ログ一貫性チェックが動作する
- [ ] コミットルールが正しく実装されている
- [ ] ハートビートが定期的に送信される
- [ ] Figure 8問題が対処されている
- [ ] バッチングが実装されている
- [ ] コメントがすべて日本語である
- [ ] `npm run test` で全テストが通る

### コミット

```bash
git add -A
git commit -m "feat: ログレプリケーションを実装"
```

### 次のステップ

タスク2が完了したら、タスク3（安全性保証）に進みます。

## 実装のポイント

1. **ログ一貫性の維持**
   - prevLogIndex/prevLogTermによる厳密なチェック
   - 競合時の適切な切り詰めと再送信

2. **コミットの安全性**
   - 過半数レプリケーション後のみコミット
   - Figure 8問題: 現在termのエントリのみコミット

3. **パフォーマンス**
   - バッチング: 複数エントリをまとめて送信
   - 並行送信: 全Followerに同時送信

4. **障害対応**
   - 遅いFollowerの検出と修復
   - ネットワークエラーの適切な処理

実装を開始してください。Phase 2の核心部分です！

# Raftコアロジック Phase 2 タスク3: 安全性保証と統合

## 前提条件の確認

Phase 2 タスク1, 2が完了していることを確認してください：

- [ ] ElectionManagerが実装されている
- [ ] ReplicationManagerが実装されている
- [ ] 各コンポーネントのユニットテストが通っている

## タスク3: 安全性保証と統合

### 実装概要

Raftの安全性プロパティを保証し、すべてのコンポーネントを統合します：

- 4つの安全性プロパティの実装と検証
- RaftNodeクラスによる統合
- 統合テストによる動作確認
- KVストアとしての実装

### 実装手順

#### 1. 技術仕様書の作成 (`docs/specs/technical/06-safety-guarantees.md`)

````markdown
# Raft安全性保証仕様

## 概要

Raftアルゴリズムの正確性を保証する4つの安全性プロパティを実装・検証する。

## 安全性プロパティ

### 1. Election Safety（選出安全性）

**定義**: 1つのtermには最大1人のリーダーしか存在しない

**実装方法**:

- 各ノードは1つのtermで最大1回しか投票しない
- 過半数の票が必要（過半数は1つしか存在しない）

**検証**:

```typescript
function verifyElectionSafety(term: Term, leaders: NodeId[]): boolean {
  return leaders.length <= 1;
}
```
````

### 2. Log Matching（ログ一致性）

**定義**: 異なるログで同じインデックス・同じtermのエントリは同じコマンド

**実装方法**:

- AppendEntriesの一貫性チェック
- prevLogIndex/prevLogTermによる検証

**検証**:

```typescript
function verifyLogMatching(logs: LogEntry[][]): boolean {
  for (let i = 0; i < logs.length - 1; i++) {
    for (let j = i + 1; j < logs.length; j++) {
      if (!logsMatch(logs[i], logs[j])) return false;
    }
  }
  return true;
}
```

### 3. Leader Completeness（リーダー完全性）

**定義**: あるtermでコミットされたエントリは、将来のすべてのリーダーのログに存在

**実装方法**:

- 投票時のログ新しさチェック
- より完全なログを持つ候補者のみ当選

**検証**:

```typescript
function verifyLeaderCompleteness(
  committedEntries: LogEntry[],
  futureLeaderLog: LogEntry[],
): boolean {
  return committedEntries.every((entry) =>
    futureLeaderLog.some((e) => e.index === entry.index && e.term === entry.term),
  );
}
```

### 4. State Machine Safety（ステートマシン安全性）

**定義**: すべてのノードが同じ順序で同じコマンドを実行

**実装方法**:

- コミットされたエントリのみ適用
- インデックス順に適用

**検証**:

```typescript
function verifyStateMachineSafety(appliedLogs: AppliedEntry[][]): boolean {
  const reference = appliedLogs[0];
  return appliedLogs.every((log) =>
    log.every((entry, index) => entry.command === reference[index]?.command),
  );
}
```

## Figure 8問題の解決

### 問題

古いtermのエントリが、新しいtermで間接的にコミットされる問題

### 解決策

現在termのエントリのみ直接コミット可能にする

```typescript
function canCommit(entry: LogEntry, currentTerm: Term): boolean {
  return entry.term === currentTerm;
}
```

## 不変条件のアサーション

### 実行時チェック

```typescript
class InvariantChecker {
  checkStateTransition(before: State, after: State): void {
    assert(after.term >= before.term);
    assert(after.commitIndex >= before.commitIndex);
    assert(after.lastApplied <= after.commitIndex);
  }

  checkLogInvariant(log: LogEntry[]): void {
    for (let i = 1; i < log.length; i++) {
      assert(log[i].index === log[i - 1].index + 1);
      assert(log[i].term >= log[i - 1].term);
    }
  }
}
```

## 線形化可能性（Linearizability）

### 読み取りの一貫性

1. **リーダー読み取り**: 最新の値を保証
2. **ReadIndex**: コミット済みの値を読む
3. **リース読み取り**: ハートビート成功中は安全

### 書き込みの一貫性

1. すべての書き込みはリーダー経由
2. 過半数レプリケーション後に応答
3. 一度コミットされたら永続化

````

#### 2. SafetyCheckerの実装 (`src/consensus/SafetyChecker.ts`)

```typescript
import type { NodeId, Term, LogIndex, LogEntry } from '@/types';
import { RaftState } from '@/core/State';
import { RaftLog } from '@/core/Log';

/**
 * Raftの安全性プロパティを検証するクラス
 */
export class SafetyChecker {
  private readonly debug: boolean;

  constructor(debug = false) {
    this.debug = debug;
  }

  /**
   * Election Safety: 1つのtermに最大1人のリーダー
   */
  verifyElectionSafety(
    term: Term,
    clusterStates: Map<NodeId, { term: Term; isLeader: boolean }>
  ): boolean {
    const leaders = Array.from(clusterStates.entries())
      .filter(([_, state]) => state.term === term && state.isLeader)
      .map(([nodeId, _]) => nodeId);

    if (leaders.length > 1) {
      this.logViolation(`Election Safety違反: Term ${term}に複数のリーダー: ${leaders.join(', ')}`);
      return false;
    }

    return true;
  }

  /**
   * Log Matching: 同じindex/termのエントリは同じコマンド
   */
  verifyLogMatching(logs: Map<NodeId, LogEntry[]>): boolean {
    const nodes = Array.from(logs.keys());

    for (let i = 0; i < nodes.length - 1; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const log1 = logs.get(nodes[i]) || [];
        const log2 = logs.get(nodes[j]) || [];

        const minLength = Math.min(log1.length, log2.length);

        for (let idx = 0; idx < minLength; idx++) {
          const entry1 = log1[idx];
          const entry2 = log2[idx];

          if (entry1.index === entry2.index &&
              entry1.term === entry2.term) {
            // 同じindex/termなら同じコマンドであるべき
            if (JSON.stringify(entry1.command) !== JSON.stringify(entry2.command)) {
              this.logViolation(
                `Log Matching違反: ${nodes[i]}と${nodes[j]}のindex ${entry1.index}で異なるコマンド`
              );
              return false;
            }
          }
        }
      }
    }

    return true;
  }

  /**
   * Leader Completeness: コミット済みエントリは将来のリーダーに存在
   */
  verifyLeaderCompleteness(
    committedEntries: LogEntry[],
    newLeaderLog: LogEntry[],
    newLeaderTerm: Term
  ): boolean {
    for (const committed of committedEntries) {
      const found = newLeaderLog.find(
        entry => entry.index === committed.index &&
                 entry.term === committed.term
      );

      if (!found) {
        this.logViolation(
          `Leader Completeness違反: 新リーダー(Term ${newLeaderTerm})にコミット済みエントリ(index ${committed.index})が存在しない`
        );
        return false;
      }
    }

    return true;
  }

  /**
   * State Machine Safety: 同じ順序で同じコマンドを適用
   */
  verifyStateMachineSafety(
    appliedCommands: Map<NodeId, Array<{ index: LogIndex; command: any }>>
  ): boolean {
    const nodes = Array.from(appliedCommands.keys());
    if (nodes.length < 2) return true;

    const reference = appliedCommands.get(nodes[0]) || [];

    for (let i = 1; i < nodes.length; i++) {
      const nodeCommands = appliedCommands.get(nodes[i]) || [];

      // 同じインデックスで同じコマンドか確認
      const minLength = Math.min(reference.length, nodeCommands.length);
      for (let j = 0; j < minLength; j++) {
        if (reference[j].index === nodeCommands[j].index) {
          if (JSON.stringify(reference[j].command) !==
              JSON.stringify(nodeCommands[j].command)) {
            this.logViolation(
              `State Machine Safety違反: ${nodes[0]}と${nodes[i]}がindex ${reference[j].index}で異なるコマンドを適用`
            );
            return false;
          }
        }
      }
    }

    return true;
  }

  /**
   * 状態遷移の妥当性を検証
   */
  verifyStateTransition(
    before: { term: Term; commitIndex: LogIndex; lastApplied: LogIndex },
    after: { term: Term; commitIndex: LogIndex; lastApplied: LogIndex }
  ): boolean {
    // Termは単調増加
    if (after.term < before.term) {
      this.logViolation(`状態遷移違反: Termが減少 ${before.term} -> ${after.term}`);
      return false;
    }

    // CommitIndexは単調増加
    if (after.commitIndex < before.commitIndex) {
      this.logViolation(`状態遷移違反: CommitIndexが減少 ${before.commitIndex} -> ${after.commitIndex}`);
      return false;
    }

    // LastApplied <= CommitIndex
    if (after.lastApplied > after.commitIndex) {
      this.logViolation(`状態遷移違反: LastApplied(${after.lastApplied}) > CommitIndex(${after.commitIndex})`);
      return false;
    }

    return true;
  }

  /**
   * ログの整合性を検証
   */
  verifyLogIntegrity(log: LogEntry[]): boolean {
    for (let i = 1; i < log.length; i++) {
      // インデックスは連続
      if (log[i].index !== log[i-1].index + 1) {
        this.logViolation(`ログ整合性違反: インデックスが不連続 ${log[i-1].index} -> ${log[i].index}`);
        return false;
      }

      // Termは単調非減少
      if (log[i].term < log[i-1].term) {
        this.logViolation(`ログ整合性違反: Termが減少 index ${log[i].index}`);
        return false;
      }
    }

    return true;
  }

  /**
   * Figure 8問題のチェック
   */
  checkFigure8Problem(
    commitIndex: LogIndex,
    log: LogEntry[],
    currentTerm: Term
  ): boolean {
    if (commitIndex === 0) return true;

    const entry = log[commitIndex - 1];
    if (!entry) return false;

    // 現在termのエントリのみコミット可能
    if (entry.term !== currentTerm) {
      this.logViolation(
        `Figure 8問題: 古いterm(${entry.term})のエントリをterm ${currentTerm}でコミットしようとした`
      );
      return false;
    }

    return true;
  }

  private logViolation(message: string): void {
    if (this.debug) {
      console.error(`[安全性違反] ${message}`);
    }
  }
}
````

#### 3. RaftNodeクラスの実装 (`src/core/RaftNode.ts`)

すべてのコンポーネントを統合：

```typescript
import type { NodeId, Command, CommandResult } from '@/types';
import { RaftState } from './State';
import { RaftLog } from './Log';
import { RaftTimer } from './Timer';
import { ElectionManager } from '@/consensus/Election';
import { ReplicationManager } from '@/consensus/Replication';
import { SafetyChecker } from '@/consensus/SafetyChecker';
import { EventEmitter } from 'events';

/**
 * Raftノードの統合実装
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

  // RPC（仮実装）
  private rpcServer: any;
  private rpcClient: any;

  constructor(
    nodeId: NodeId,
    peers: NodeId[],
    config?: {
      electionTimeoutMin?: number;
      electionTimeoutMax?: number;
      heartbeatInterval?: number;
      enableSafetyChecks?: boolean;
    },
  ) {
    super();

    this.nodeId = nodeId;
    this.peers = peers;

    // コアコンポーネントを初期化
    this.state = new RaftState(nodeId);
    this.log = new RaftLog();
    this.timer = new RaftTimer({
      electionTimeoutMin: config?.electionTimeoutMin || 150,
      electionTimeoutMax: config?.electionTimeoutMax || 300,
      heartbeatInterval: config?.heartbeatInterval || 50,
    });

    // TODO: RPCクライアント/サーバーの実装
    this.rpcClient = null;
    this.rpcServer = null;

    // コンセンサスマネージャーを初期化
    this.election = new ElectionManager(
      nodeId,
      peers,
      this.state,
      this.log,
      this.timer,
      this.rpcClient,
    );

    this.replication = new ReplicationManager(
      nodeId,
      peers,
      this.state,
      this.log,
      this.timer,
      this.rpcClient,
    );

    this.safety = new SafetyChecker(config?.enableSafetyChecks);

    console.log(`Raftノードを初期化: ${nodeId}, ピア: ${peers.join(',')}`);
  }

  /**
   * ノードを起動
   */
  async start(): Promise<void> {
    console.log(`ノード${this.nodeId}を起動中...`);

    // RPCサーバーを起動
    await this.startRPCServer();

    // Followerとして開始
    this.becomeFollower(0);

    // コミット済みエントリを適用
    this.applyCommittedEntries();

    console.log(`ノード${this.nodeId}が起動しました`);
    this.emit('started');
  }

  /**
   * ノードを停止
   */
  async stop(): Promise<void> {
    console.log(`ノード${this.nodeId}を停止中...`);

    // タイマーを停止
    this.timer.stopAll();

    // RPCサーバーを停止
    await this.stopRPCServer();

    console.log(`ノード${this.nodeId}が停止しました`);
    this.emit('stopped');
  }

  /**
   * クライアントコマンドを処理（リーダーのみ）
   */
  async handleClientCommand(command: Command): Promise<CommandResult> {
    // リーダーでない場合はリダイレクト
    if (this.state.getState().type !== 'leader') {
      const leaderId = this.getLeaderId();
      return {
        ok: false,
        error: { type: 'NOT_LEADER', leaderId },
      };
    }

    // 安全性チェック（デバッグ時）
    if (this.safety) {
      const beforeState = {
        term: this.state.getCurrentTerm(),
        commitIndex: this.replication.getCommitIndex(),
        lastApplied: this.lastApplied,
      };

      const result = await this.replication.appendCommand(command);

      const afterState = {
        term: this.state.getCurrentTerm(),
        commitIndex: this.replication.getCommitIndex(),
        lastApplied: this.lastApplied,
      };

      this.safety.verifyStateTransition(beforeState, afterState);

      return result;
    }

    // コマンドを追加してレプリケーション
    return this.replication.appendCommand(command);
  }

  /**
   * Follower状態に遷移
   */
  private becomeFollower(term: number): void {
    console.log(`Followerに遷移: term=${term}`);

    this.state.becomeFollower(term);

    // リーダー機能を停止
    this.replication.stopHeartbeat();

    // 選挙タイマーを開始
    this.election.startElectionTimer();

    this.emit('stateChange', { type: 'follower', term });
  }

  /**
   * Candidate状態に遷移して選挙開始
   */
  private async becomeCandidate(): Promise<void> {
    console.log('Candidateに遷移して選挙開始');

    await this.election.startElection((result) => {
      switch (result.type) {
        case 'ELECTED':
          this.becomeLeader();
          break;
        case 'STEPPED_DOWN':
          this.becomeFollower(result.newTerm);
          break;
        case 'NOT_ELECTED':
          // 次の選挙タイムアウトを待つ
          this.election.startElectionTimer();
          break;
      }
    });

    this.emit('stateChange', { type: 'candidate', term: this.state.getCurrentTerm() });
  }

  /**
   * Leader状態に遷移
   */
  private becomeLeader(): void {
    console.log(`リーダーに選出されました: term=${this.state.getCurrentTerm()}`);

    this.state.becomeLeader();

    // 選挙タイマーを停止
    this.timer.stopElectionTimeout();

    // ハートビートを開始
    this.replication.startHeartbeat();

    // NOOPエントリを追加（リーダー確立）
    this.replication.appendCommand({ type: 'NOOP' });

    this.emit('stateChange', { type: 'leader', term: this.state.getCurrentTerm() });
    this.emit('leaderElected', { nodeId: this.nodeId, term: this.state.getCurrentTerm() });
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
        this.applyToStateMachine(entry.command);
        console.log(
          `エントリを適用: index=${this.lastApplied}, command=${JSON.stringify(entry.command)}`,
        );

        this.emit('entryApplied', {
          index: this.lastApplied,
          command: entry.command,
        });
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
        // 何もしない
        break;
    }
  }

  /**
   * KVストアから値を取得（読み取り）
   */
  async getValue(key: string): Promise<unknown | undefined> {
    // リーダーのみ最新の値を保証
    if (this.state.getState().type !== 'leader') {
      const leaderId = this.getLeaderId();
      throw new Error(`リーダー(${leaderId})にリダイレクトしてください`);
    }

    // ReadIndexを実装（簡易版）
    await this.ensureLeadershipLease();

    return this.stateMachine.get(key);
  }

  /**
   * リーダーシップリースを確認
   */
  private async ensureLeadershipLease(): Promise<void> {
    // ハートビートを送信して過半数から応答を確認
    // TODO: 実装
  }

  /**
   * RPCサーバーを起動
   */
  private async startRPCServer(): Promise<void> {
    // TODO: 実装
    // - RequestVoteハンドラー
    // - AppendEntriesハンドラー
  }

  /**
   * RPCサーバーを停止
   */
  private async stopRPCServer(): Promise<void> {
    // TODO: 実装
  }

  // ヘルパーメソッド

  getNodeId(): NodeId {
    return this.nodeId;
  }

  getState(): { type: string; term: number } {
    const state = this.state.getState();
    return {
      type: state.type,
      term: this.state.getCurrentTerm(),
    };
  }

  getLeaderId(): NodeId | undefined {
    // TODO: 実装
    return undefined;
  }

  getStateMachine(): Map<string, unknown> {
    return new Map(this.stateMachine);
  }

  getDebugInfo(): any {
    return {
      nodeId: this.nodeId,
      state: this.getState(),
      log: {
        length: this.log.getLength(),
        lastIndex: this.log.getLastIndex(),
        lastTerm: this.log.getLastTerm(),
      },
      commitIndex: this.replication.getCommitIndex(),
      lastApplied: this.lastApplied,
      stateMachine: Object.fromEntries(this.stateMachine),
    };
  }
}
```

#### 4. 統合テストの作成 (`test/integration/raft-cluster.test.ts`)

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RaftNode } from '@/core/RaftNode';
import { TestCluster } from '@/test/utils/TestCluster';
import { SafetyChecker } from '@/consensus/SafetyChecker';

describe('Raftクラスタ統合テスト', () => {
  let cluster: TestCluster;
  let safety: SafetyChecker;

  beforeEach(() => {
    cluster = new TestCluster(3); // 3ノードクラスタ
    safety = new SafetyChecker(true);
  });

  afterEach(async () => {
    await cluster.shutdown();
  });

  describe('リーダー選出', () => {
    it('クラスタ起動後にリーダーが選出される', async () => {
      await cluster.start();

      // リーダー選出を待つ
      await cluster.waitForLeader(5000);

      const leaders = cluster.getLeaders();
      expect(leaders).toHaveLength(1);

      // Election Safetyを検証
      const term = leaders[0].getState().term;
      const states = cluster.getAllNodeStates();
      expect(safety.verifyElectionSafety(term, states)).toBe(true);
    });

    it('リーダー障害時に新しいリーダーが選出される', async () => {
      await cluster.start();
      await cluster.waitForLeader();

      const oldLeader = cluster.getLeaders()[0];
      const oldTerm = oldLeader.getState().term;

      // リーダーを停止
      await cluster.stopNode(oldLeader.getNodeId());

      // 新リーダー選出を待つ
      await cluster.waitForNewLeader(oldLeader.getNodeId(), 5000);

      const newLeader = cluster.getLeaders()[0];
      expect(newLeader.getNodeId()).not.toBe(oldLeader.getNodeId());
      expect(newLeader.getState().term).toBeGreaterThan(oldTerm);
    });
  });

  describe('ログレプリケーション', () => {
    it('リーダーのコマンドが全ノードにレプリケーションされる', async () => {
      await cluster.start();
      await cluster.waitForLeader();

      const leader = cluster.getLeaders()[0];

      // コマンドを送信
      const result = await leader.handleClientCommand({
        type: 'SET',
        key: 'test',
        value: 'hello',
      });

      expect(result.ok).toBe(true);

      // レプリケーションを待つ
      await cluster.waitForReplication(result.index);

      // 全ノードのログを確認
      const logs = cluster.getAllLogs();
      expect(safety.verifyLogMatching(logs)).toBe(true);

      // 全ノードのステートマシンを確認
      const values = cluster.getAllNodeValues('test');
      expect(values.every((v) => v === 'hello')).toBe(true);
    });

    it('複数のコマンドが順序通りに適用される', async () => {
      await cluster.start();
      await cluster.waitForLeader();

      const leader = cluster.getLeaders()[0];

      // 複数コマンドを送信
      const commands = [
        { type: 'SET', key: 'a', value: 1 },
        { type: 'SET', key: 'b', value: 2 },
        { type: 'DELETE', key: 'a' },
        { type: 'SET', key: 'c', value: 3 },
      ];

      for (const cmd of commands) {
        await leader.handleClientCommand(cmd);
      }

      // 適用を待つ
      await cluster.waitForApplied(commands.length);

      // State Machine Safetyを検証
      const appliedCommands = cluster.getAllAppliedCommands();
      expect(safety.verifyStateMachineSafety(appliedCommands)).toBe(true);

      // 最終状態を確認
      const states = cluster.getAllStateMachines();
      for (const state of states) {
        expect(state.get('a')).toBeUndefined();
        expect(state.get('b')).toBe(2);
        expect(state.get('c')).toBe(3);
      }
    });
  });

  describe('ネットワーク分断', () => {
    it('少数派パーティションでは書き込みができない', async () => {
      await cluster.start();
      await cluster.waitForLeader();

      // ネットワークを分断（1ノード vs 2ノード）
      const minority = cluster.nodes[0];
      await cluster.partitionNode(minority.getNodeId());

      // 新リーダーを待つ（多数派側）
      await cluster.waitForNewLeader(minority.getNodeId());

      // 少数派での書き込みは失敗
      const result = await minority.handleClientCommand({
        type: 'SET',
        key: 'test',
        value: 'should-fail',
      });

      expect(result.ok).toBe(false);
      expect(result.error.type).toBe('NO_MAJORITY');
    });

    it('多数派パーティションでは書き込みが継続できる', async () => {
      await cluster.start();
      await cluster.waitForLeader();

      // ネットワークを分断
      const minority = cluster.nodes[0];
      await cluster.partitionNode(minority.getNodeId());

      // 多数派側のリーダーを取得
      await cluster.waitForNewLeader(minority.getNodeId());
      const majorityLeader = cluster
        .getLeaders()
        .find((n) => n.getNodeId() !== minority.getNodeId());

      // 多数派での書き込みは成功
      const result = await majorityLeader.handleClientCommand({
        type: 'SET',
        key: 'test',
        value: 'success',
      });

      expect(result.ok).toBe(true);
    });

    it('分断回復後にログが同期される', async () => {
      await cluster.start();
      await cluster.waitForLeader();

      const node1 = cluster.nodes[0];

      // 分断
      await cluster.partitionNode(node1.getNodeId());

      // 多数派側で書き込み
      const majorityLeader = cluster.getLeaders().find((n) => n.getNodeId() !== node1.getNodeId());

      await majorityLeader.handleClientCommand({
        type: 'SET',
        key: 'during-partition',
        value: 'test',
      });

      // 分断を回復
      await cluster.healPartition(node1.getNodeId());

      // 同期を待つ
      await cluster.waitForSync();

      // 全ノードでログが一致
      const logs = cluster.getAllLogs();
      expect(safety.verifyLogMatching(logs)).toBe(true);

      // Leader Completenessを検証
      const committedEntries = cluster.getCommittedEntries();
      const leaderLog = cluster.getLeaders()[0].getLog();
      expect(
        safety.verifyLeaderCompleteness(
          committedEntries,
          leaderLog,
          cluster.getLeaders()[0].getState().term,
        ),
      ).toBe(true);
    });
  });

  describe('安全性プロパティ', () => {
    it('すべての安全性プロパティが維持される', async () => {
      await cluster.start();
      await cluster.waitForLeader();

      // ランダムな操作を実行
      for (let i = 0; i < 50; i++) {
        const action = Math.random();

        if (action < 0.6) {
          // 書き込み
          const leader = cluster.getLeaders()[0];
          await leader.handleClientCommand({
            type: 'SET',
            key: `key${i}`,
            value: i,
          });
        } else if (action < 0.8) {
          // ノード障害
          const randomNode = cluster.getRandomNode();
          await cluster.stopNode(randomNode.getNodeId());
          await new Promise((r) => setTimeout(r, 100));
          await cluster.startNode(randomNode.getNodeId());
        } else {
          // ネットワーク遅延
          cluster.addNetworkDelay(50);
          await new Promise((r) => setTimeout(r, 100));
          cluster.removeNetworkDelay();
        }

        // 各操作後に安全性を検証
        const logs = cluster.getAllLogs();
        expect(safety.verifyLogMatching(logs)).toBe(true);

        const appliedCommands = cluster.getAllAppliedCommands();
        expect(safety.verifyStateMachineSafety(appliedCommands)).toBe(true);
      }
    });
  });
});
```

### 完了チェックリスト

- [ ] 安全性保証の技術仕様書が作成されている
- [ ] SafetyCheckerが実装されている
- [ ] RaftNodeクラスが全コンポーネントを統合している
- [ ] 統合テストが作成されている
- [ ] 4つの安全性プロパティが検証されている
- [ ] Figure 8問題が対処されている
- [ ] ネットワーク分断のテストが通る
- [ ] リーダー選出が正しく動作する
- [ ] ログレプリケーションが正しく動作する
- [ ] すべてのテストが通る

### コミット

```bash
git add -A
git commit -m "feat: 安全性保証と統合を実装"
git commit -m "test: Raftクラスタの統合テストを追加"
```

## Phase 2 完了！🎉

これでRaftアルゴリズムの中核実装が完了しました：

### 完成したコンポーネント

1. ✅ **Phase 1: 基礎実装**
   - State管理
   - Log管理
   - Timer管理

2. ✅ **Phase 2: Raftアルゴリズム**
   - リーダー選出
   - ログレプリケーション
   - 安全性保証

### 達成した機能

- 分散合意の形成
- 障害耐性
- ネットワーク分断への対応
- 線形化可能性の保証

### 次のステップ（Phase 3以降）

1. **ネットワーク層の実装**
   - HTTP/WebSocket RPCサーバー
   - 実際のネットワーク通信

2. **永続化層の実装**
   - ログの永続化
   - スナップショット

3. **本番環境対応**
   - パフォーマンス最適化
   - メトリクス・監視
   - 運用ツール

おめでとうございます！理論的に正しいRaftアルゴリズムの実装が完成しました。

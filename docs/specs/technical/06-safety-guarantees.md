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

**違反例**:
- ネットワーク分断で複数のリーダーが同時存在
- 投票の重複により複数の候補者が過半数を獲得

**防止策**:
```typescript
// 投票の重複防止
if (this.votedFor !== null && this.votedFor !== candidateId) {
  return { voteGranted: false, reason: '既に他の候補者に投票済み' };
}

// 過半数の厳密な計算
const majority = Math.floor(totalNodes / 2) + 1;
```

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

function logsMatch(log1: LogEntry[], log2: LogEntry[]): boolean {
  const minLen = Math.min(log1.length, log2.length);
  for (let i = 0; i < minLen; i++) {
    if (log1[i].index === log2[i].index && 
        log1[i].term === log2[i].term &&
        JSON.stringify(log1[i].command) !== JSON.stringify(log2[i].command)) {
      return false;
    }
  }
  return true;
}
```

**実装詳細**:
```typescript
// AppendEntriesでの一貫性チェック
if (request.prevLogIndex > 0) {
  const prevEntry = this.log.getEntry(request.prevLogIndex);
  if (!prevEntry || prevEntry.term !== request.prevLogTerm) {
    return {
      term: currentTerm,
      success: false,
      conflictIndex: this.findConflictIndex(request.prevLogIndex),
      conflictTerm: prevEntry?.term || 0
    };
  }
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
  futureLeaderLog: LogEntry[]
): boolean {
  return committedEntries.every(entry => 
    futureLeaderLog.some(e => 
      e.index === entry.index && e.term === entry.term
    )
  );
}
```

**ログの新しさ比較**:
```typescript
function isLogMoreUpToDate(
  candidateLastTerm: Term,
  candidateLastIndex: LogIndex,
  voterLastTerm: Term,
  voterLastIndex: LogIndex
): boolean {
  // より高いtermが優先
  if (candidateLastTerm !== voterLastTerm) {
    return candidateLastTerm > voterLastTerm;
  }
  // 同じtermならより長いログが優先
  return candidateLastIndex >= voterLastIndex;
}
```

### 4. State Machine Safety（ステートマシン安全性）
**定義**: すべてのノードが同じ順序で同じコマンドを実行

**実装方法**:
- コミットされたエントリのみ適用
- インデックス順に適用

**検証**:
```typescript
function verifyStateMachineSafety(
  appliedLogs: AppliedEntry[][]
): boolean {
  const reference = appliedLogs[0];
  return appliedLogs.every(log => 
    log.every((entry, index) => 
      entry.command === reference[index]?.command
    )
  );
}
```

**適用ルール**:
```typescript
// コミット済みエントリを順序通りに適用
while (this.lastApplied < this.commitIndex) {
  this.lastApplied++;
  const entry = this.log.getEntry(this.lastApplied);
  if (entry) {
    this.applyToStateMachine(entry.command);
  }
}
```

## Figure 8問題の解決

### 問題の説明
古いtermのエントリが、新しいtermで間接的にコミットされる問題。これにより、一度コミットされたと思われたエントリが後から削除される可能性がある。

### 具体例
```
Term 1: リーダーSがindex 2にエントリを複製（部分的）
Term 2: リーダーT選出、index 3に新エントリ
Term 3: 元リーダーSが復帰、index 2が過半数に到達

問題: Term 3でindex 2をコミットすると、
      その後index 2が別のエントリで上書きされる可能性
```

### 解決策
現在termのエントリのみ直接コミット可能にする

```typescript
function canCommitEntry(entry: LogEntry, currentTerm: Term): boolean {
  return entry.term === currentTerm;
}

function updateCommitIndex(): void {
  const matchIndices = this.getMatchIndices();
  const majorityIndex = this.findMajorityMatchIndex(matchIndices);
  const entry = this.log.getEntry(majorityIndex);
  
  // 現在termのエントリのみコミット
  if (entry && entry.term === this.state.getCurrentTerm()) {
    this.commitIndex = Math.max(this.commitIndex, majorityIndex);
    console.log(`コミットインデックスを更新: ${majorityIndex}`);
  }
}
```

## 不変条件（Invariants）の実装

### 状態遷移の不変条件
```typescript
class InvariantChecker {
  checkStateTransition(
    before: RaftState,
    after: RaftState
  ): void {
    // Termは単調増加
    assert(after.term >= before.term, 
      `Termが減少: ${before.term} -> ${after.term}`);
    
    // CommitIndexは単調増加
    assert(after.commitIndex >= before.commitIndex,
      `CommitIndexが減少: ${before.commitIndex} -> ${after.commitIndex}`);
    
    // LastApplied <= CommitIndex
    assert(after.lastApplied <= after.commitIndex,
      `LastApplied(${after.lastApplied}) > CommitIndex(${after.commitIndex})`);
  }
  
  checkLogInvariant(log: LogEntry[]): void {
    for (let i = 1; i < log.length; i++) {
      // インデックスは連続
      assert(log[i].index === log[i-1].index + 1,
        `インデックス不連続: ${log[i-1].index} -> ${log[i].index}`);
      
      // Termは単調非減少
      assert(log[i].term >= log[i-1].term,
        `Termが減少: index ${log[i].index}`);
    }
  }
  
  checkElectionInvariant(
    term: Term,
    votedNodes: Map<NodeId, boolean>
  ): void {
    const voteCount = Array.from(votedNodes.values())
      .filter(voted => voted).length;
    const totalNodes = votedNodes.size;
    const majority = Math.floor(totalNodes / 2) + 1;
    
    // 過半数を超えない
    assert(voteCount <= totalNodes,
      `投票数(${voteCount})が総ノード数(${totalNodes})を超過`);
    
    // リーダー選出には過半数が必要
    if (voteCount >= majority) {
      console.log(`Term ${term}で過半数(${voteCount}/${totalNodes})の票を獲得`);
    }
  }
}
```

### ログ整合性の検証
```typescript
function verifyLogConsistency(
  nodeLog: LogEntry[],
  referenceLog: LogEntry[]
): boolean {
  const minLength = Math.min(nodeLog.length, referenceLog.length);
  
  for (let i = 0; i < minLength; i++) {
    const nodeEntry = nodeLog[i];
    const refEntry = referenceLog[i];
    
    // 同じインデックスなら同じterm/command
    if (nodeEntry.index === refEntry.index) {
      if (nodeEntry.term !== refEntry.term ||
          JSON.stringify(nodeEntry.command) !== JSON.stringify(refEntry.command)) {
        console.error(`ログ不整合: index ${nodeEntry.index}`);
        return false;
      }
    }
  }
  
  return true;
}
```

## 線形化可能性（Linearizability）

### 読み取りの一貫性保証

#### 1. リーダー読み取り
```typescript
async function leaderRead(key: string): Promise<unknown> {
  if (this.state.getState().type !== 'leader') {
    throw new Error('リーダーではありません');
  }
  
  // リーダーシップを確認してから読み取り
  await this.confirmLeadership();
  return this.stateMachine.get(key);
}
```

#### 2. ReadIndex最適化
```typescript
async function readIndex(): Promise<LogIndex> {
  const readIndex = this.commitIndex;
  
  // 過半数からのハートビート応答を確認
  const heartbeatSuccess = await this.sendHeartbeatMajority();
  if (!heartbeatSuccess) {
    throw new Error('リーダーシップを確認できません');
  }
  
  // readIndex以上がコミットされるまで待機
  while (this.lastApplied < readIndex) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  
  return readIndex;
}
```

#### 3. リース読み取り
```typescript
class LeadershipLease {
  private leaseTimeout: number = 0;
  private readonly leaseDuration = 150; // 選挙タイムアウトより短い
  
  async renewLease(): Promise<boolean> {
    const success = await this.sendHeartbeatMajority();
    if (success) {
      this.leaseTimeout = Date.now() + this.leaseDuration;
      return true;
    }
    return false;
  }
  
  isLeaseValid(): boolean {
    return Date.now() < this.leaseTimeout;
  }
  
  async safeRead(key: string): Promise<unknown> {
    if (this.isLeaseValid()) {
      return this.stateMachine.get(key);
    }
    
    // リースが切れていたら更新
    if (await this.renewLease()) {
      return this.stateMachine.get(key);
    }
    
    throw new Error('リーダーシップリースが無効です');
  }
}
```

### 書き込みの一貫性保証

#### 1. リーダー経由の書き込み
```typescript
async function write(command: Command): Promise<CommandResult> {
  if (this.state.getState().type !== 'leader') {
    return {
      ok: false,
      error: { type: 'NOT_LEADER', leaderId: this.getLeaderId() }
    };
  }
  
  // ログに追加してレプリケーション
  const result = await this.replication.appendCommand(command);
  
  if (result.ok) {
    // コミット確認後にクライアントに応答
    await this.waitForCommit(result.index);
  }
  
  return result;
}
```

#### 2. 書き込み順序の保証
```typescript
class WriteOrdering {
  private pendingWrites = new Map<LogIndex, Promise<any>>();
  
  async orderedWrite(command: Command): Promise<CommandResult> {
    const result = await this.appendCommand(command);
    
    if (result.ok) {
      const writePromise = this.waitForApply(result.index);
      this.pendingWrites.set(result.index, writePromise);
      
      // 前の書き込みが完了してから現在の書き込みを適用
      await this.waitForPreviousWrites(result.index - 1);
      await writePromise;
      
      this.pendingWrites.delete(result.index);
    }
    
    return result;
  }
  
  private async waitForPreviousWrites(maxIndex: LogIndex): Promise<void> {
    const promises = Array.from(this.pendingWrites.entries())
      .filter(([index, _]) => index <= maxIndex)
      .map(([_, promise]) => promise);
    
    await Promise.all(promises);
  }
}
```

## デバッグと監視

### アサーションベースの検証
```typescript
function enableDebugMode(): void {
  // 開発環境でのみアサーションを有効化
  if (process.env.NODE_ENV === 'development') {
    this.debugMode = true;
    this.invariantChecker = new InvariantChecker();
    this.safetyChecker = new SafetyChecker(true);
  }
}

function debugAssert(condition: boolean, message: string): void {
  if (this.debugMode && !condition) {
    console.error(`[DEBUG] アサーション失敗: ${message}`);
    console.trace();
    throw new Error(`アサーション失敗: ${message}`);
  }
}
```

### パフォーマンスメトリクス
```typescript
class SafetyMetrics {
  private violations = {
    electionSafety: 0,
    logMatching: 0,
    leaderCompleteness: 0,
    stateMachineSafety: 0
  };
  
  recordViolation(type: keyof typeof this.violations): void {
    this.violations[type]++;
    console.warn(`[SAFETY] ${type}違反を検出 (累計: ${this.violations[type]})`);
  }
  
  getMetrics(): any {
    return {
      ...this.violations,
      totalViolations: Object.values(this.violations).reduce((a, b) => a + b, 0)
    };
  }
}
```

## テスト戦略

### 単体テスト
- 各安全性プロパティの検証関数
- 不変条件チェッカー
- Figure 8問題の回避

### 統合テスト
- 複数ノードクラスタでの動作確認
- ネットワーク分断シナリオ
- ランダム障害テスト

### プロパティベーステスト
- QuickCheckスタイルのランダムテスト
- 状態遷移の網羅的テスト
- 長時間実行での安全性確認

## まとめ

Raftの安全性は以下の実装により保証される：

1. **選出安全性**: 過半数投票による排他制御
2. **ログ一致性**: 一貫性チェックによる同期保証
3. **リーダー完全性**: ログ新しさによる選出制限
4. **ステートマシン安全性**: 順序適用による一貫性

これらの実装により、ネットワーク分断や障害が発生しても、システム全体の一貫性と可用性が保証される。
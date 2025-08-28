# タイマー管理仕様

## 概要

Raftアルゴリズムにおけるタイムアウト管理を担当するコンポーネントです。Raftでは、リーダーの生存確認と選挙の開始タイミングを制御するためにタイマーが重要な役割を果たします。テスト容易性のため、実時間とは独立した論理時間で動作可能に設計されています。

## タイマーの種類

### 1. 選挙タイムアウト (Election Timeout)

**用途**: Follower/Candidateが使用するタイマー
- **対象**: Follower状態とCandidate状態のノード
- **タイムアウト時間**: 150-300ms（ランダム化）
- **トリガー条件**: リーダーからの有効なAppendEntriesメッセージを受信しない
- **実行アクション**: 選挙を開始（Candidate状態へ遷移）

**動作詳細**:
- Follower状態では、リーダーからのハートビートを待機
- Candidate状態では、選挙の完了（リーダー選出または他のリーダーの発見）を待機
- タイムアウト時にはTermをインクリメントして新しい選挙を開始

**ランダム化の重要性**:
- 複数のノードが同時に選挙を開始することを防ぐ
- Split vote（票の分散）による無限選挙ループを回避
- 各ノードが異なるタイムアウト値を持つことで、時間差で選挙が開始される

### 2. ハートビート間隔 (Heartbeat Interval)

**用途**: リーダーが使用する定期送信タイマー
- **対象**: Leader状態のノードのみ
- **間隔**: 50ms（固定値）
- **実行アクション**: 全Followerに空のAppendEntriesメッセージ（ハートビート）を送信

**動作詳細**:
- リーダーの生存を他のノードに知らせる
- Followerの選挙タイムアウトをリセットさせる
- ネットワーク分断の早期検出に寄与

## タイミング要件

Raftアルゴリズムの正常動作には、以下の時間関係を満たす必要があります：

```
broadcastTime << electionTimeout << MTBF
```

**各時間の定義**:
- **broadcastTime**: ノード間でメッセージを送受信する平均時間
- **electionTimeout**: 選挙タイムアウト時間
- **MTBF (Mean Time Between Failures)**: 平均故障間隔

**典型的な設定値**:
```typescript
const TIMING_CONFIG = {
  broadcastTime: "0.5-20ms",      // ネットワーク遅延
  electionTimeout: "150-300ms",   // 選挙タイムアウト
  heartbeatInterval: "50ms",      // ハートビート間隔（electionTimeoutの1/3程度）
  MTBF: "数ヶ月-数年"            // ハードウェア故障間隔
};
```

**設計原則**:
1. **broadcastTime << electionTimeout**: ネットワーク遅延が選挙を引き起こさない
2. **electionTimeout << MTBF**: 選挙よりもノード故障の方が稀
3. **heartbeatInterval ≈ electionTimeout / 3**: 適切なハートビート頻度

## ランダム化の実装

### ランダム範囲の設定
```typescript
interface TimerConfig {
  electionTimeoutMin: 150;  // 最小選挙タイムアウト
  electionTimeoutMax: 300;  // 最大選挙タイムアウト
  heartbeatInterval: 50;    // 固定ハートビート間隔
}
```

### ランダム化のメリット
1. **Split Vote防止**: 複数ノードの同時候補者立候補を回避
2. **選挙収束性**: より短いタイムアウトのノードが優先的にリーダーになる
3. **ネットワーク効率**: 不要な選挙の発生を抑制

### ランダム分布の要件
- **均等分布**: 指定範囲内で偏りなくタイムアウト値を生成
- **独立性**: 各ノードが独立したランダム値を使用
- **再生成**: タイムアウトのたびに新しいランダム値を生成

## テスト戦略

### 論理時間の使用
実時間に依存しない設計により、テストの決定性と高速実行を実現：

```typescript
interface TimeProvider {
  now(): number;                                    // 現在時刻取得
  setTimeout(callback: () => void, delay: number): TimerId;  // タイマー設定
  clearTimeout(timerId: TimerId): void;             // タイマー取消
}
```

### MockTimeProviderの特徴
```typescript
class MockTimeProvider implements TimeProvider {
  advance(milliseconds: number): void;  // 時間を任意に進める
  activeTimers(): number;               // アクティブなタイマー数を取得
  clearAll(): void;                     // すべてのタイマーを削除
}
```

**テストのメリット**:
- **決定的実行**: 常に同じ結果を得られる
- **高速実行**: 実際の時間経過を待たない
- **境界値テスト**: 正確なタイミングでのテストが可能
- **並行性テスト**: 複数タイマーの相互作用を検証

## タイマーの状態管理

### タイマーの状態
```typescript
interface TimerState {
  electionTimeout: boolean;    // 選挙タイムアウトが動作中
  heartbeatInterval: boolean;  // ハートビート間隔が動作中
}
```

### 状態遷移とタイマー制御

**Follower状態**:
- 選挙タイムアウト: ON
- ハートビート間隔: OFF

**Candidate状態**:
- 選挙タイムアウト: ON（選挙タイムアウト用）
- ハートビート間隔: OFF

**Leader状態**:
- 選挙タイムアウト: OFF
- ハートビート間隔: ON

### ライフサイクル管理
```typescript
// 状態遷移時のタイマー制御例
becomeFollower() {
  timer.stopHeartbeatInterval();
  timer.startElectionTimeout(this.onElectionTimeout);
}

becomeCandidate() {
  timer.stopHeartbeatInterval();
  timer.resetElectionTimeout(this.onElectionTimeout);
}

becomeLeader() {
  timer.stopElectionTimeout();
  timer.startHeartbeatInterval(this.onHeartbeatInterval);
}
```

## エラーケースと対策

### 1. タイマーの多重起動防止
**問題**: 同じ種類のタイマーが複数回起動される

**対策**:
```typescript
startElectionTimeout(callback: TimerCallback): void {
  // 既存のタイマーがあれば停止
  this.stopElectionTimeout();
  
  // 新しいタイマーを開始
  this.electionTimeoutId = this.timeProvider.setTimeout(callback, timeout);
}
```

### 2. 不正な時間値の設定防止
**問題**: 負の値やNaN値がタイムアウトに設定される

**対策**:
```typescript
validateConfig(config: TimerConfig): void {
  if (config.electionTimeoutMin <= 0 || config.electionTimeoutMax <= 0) {
    throw new Error('エラー: タイムアウト値は正の値である必要があります');
  }
  
  if (config.electionTimeoutMin >= config.electionTimeoutMax) {
    throw new Error('エラー: 最小タイムアウトは最大タイムアウトより小さい必要があります');
  }
  
  if (config.heartbeatInterval <= 0) {
    throw new Error('エラー: ハートビート間隔は正の値である必要があります');
  }
}
```

### 3. メモリリークの防止
**問題**: タイマーがクリアされずにメモリリークが発生

**対策**:
```typescript
destructor(): void {
  console.log('情報: タイマーをクリーンアップ中');
  this.stopAll();
}
```

### 4. ネットワーク分断時の対応
**問題**: ネットワーク分断によりタイマーが適切に動作しない

**対策**:
- タイムアウト値の動的調整
- ネットワーク状態の監視
- 段階的なバックオフ戦略

## パフォーマンス考慮事項

### 1. タイマー精度
- システムタイマーの精度に依存（通常1-15ms）
- 高精度が必要な場合はhigh-resolutionタイマーを使用

### 2. CPU使用率
- ハートビート間隔を短くしすぎるとCPU使用率が上昇
- 適切なバランスが必要（50ms程度が推奨）

### 3. メモリ使用量
- タイマーオブジェクトは軽量に設計
- 不要なタイマーは即座にクリーンアップ

## 実装例

### 基本的な使用方法
```typescript
// タイマー初期化
const timerConfig: TimerConfig = {
  electionTimeoutMin: 150,
  electionTimeoutMax: 300,
  heartbeatInterval: 50
};

const timer = new RaftTimer(timerConfig);

// Follower状態でのタイマー使用
timer.startElectionTimeout(() => {
  console.log('情報: 選挙タイムアウト発生、Candidateに遷移');
  becomeCandidate();
});

// Leader状態でのタイマー使用
timer.startHeartbeatInterval(() => {
  console.log('情報: ハートビート送信');
  sendHeartbeat();
});

// クリーンアップ
timer.stopAll();
```

### エラーハンドリング付きの実装
```typescript
class SafeRaftTimer extends RaftTimer {
  startElectionTimeout(callback: TimerCallback): void {
    try {
      super.startElectionTimeout(() => {
        console.log('情報: 選挙タイムアウトが発生しました');
        callback();
      });
    } catch (error) {
      console.log(`エラー: 選挙タイムアウト開始に失敗: ${error.message}`);
      throw error;
    }
  }
}
```

## 関連仕様

- [01-state-machine.md](01-state-machine.md) - 状態機械管理
- [02-log-entries.md](02-log-entries.md) - ログエントリ管理
- [04-leader-election.md](04-leader-election.md) - リーダー選出（将来実装）
- [05-heartbeat.md](05-heartbeat.md) - ハートビート機能（将来実装）

## 参考文献

1. Diego Ongaro, John Ousterhout: "In Search of an Understandable Consensus Algorithm (Extended Version)", 2014
2. Raft論文の第5章「リーダー選出」
3. Raft論文の第5.6章「タイミングと可用性」
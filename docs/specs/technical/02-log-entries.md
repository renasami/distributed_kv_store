# ログエントリ管理仕様

## 概要

Raftログは、クライアントからのコマンドを順序付けて保存する仕組みです。分散システムにおいて、すべてのノードが同一の順序でコマンドを実行することにより、状態の一貫性を保証します。

## ログエントリの構造

各ログエントリは以下の情報を含みます：

```typescript
interface LogEntry {
  term: Term;        // エントリが作成された時のterm番号
  index: LogIndex;   // 1から始まる連番のインデックス
  command: Command;  // 実行するコマンド（SET/DELETE等）
  timestamp: number; // エントリ作成時刻（ミリ秒）
}
```

### コマンドの種類

```typescript
type Command = 
  | { type: 'SET'; key: string; value: unknown }     // キーバリューの設定
  | { type: 'DELETE'; key: string }                  // キーの削除
  | { type: 'NOOP' };                                // リーダー確立用の特殊コマンド
```

## 主要な操作

### 1. appendEntry: 新しいエントリを追加
- **目的**: 単一のコマンドエントリをログに追加
- **前提条件**: Termは現在の最後のTerm以上であること
- **戻り値**: 成功時は追加されたエントリ、失敗時はエラー

### 2. getEntry: 指定インデックスのエントリを取得
- **目的**: 特定のインデックスのエントリを取得
- **戻り値**: エントリが存在する場合はエントリ、存在しない場合はnull

### 3. getLastEntry: 最後のエントリを取得
- **目的**: ログの末尾エントリを取得
- **戻り値**: エントリが存在する場合はエントリ、空の場合はnull

### 4. truncateFrom: 指定インデックス以降を削除
- **目的**: 競合解決時に不整合なエントリを削除
- **用途**: Followerがリーダーと異なるエントリを持つ場合
- **注意**: 一度コミットされたエントリは削除してはならない（将来実装）

### 5. getEntriesFrom: 指定インデックス以降のエントリを取得
- **目的**: レプリケーション時に複数のエントリを一括取得
- **オプション**: 最大取得数を指定可能（ネットワーク効率のため）

### 6. appendEntries: 複数エントリの一括追加
- **目的**: リーダーからのレプリケーション処理
- **動作**: 競合するエントリがある場合は自動的に削除してから追加

### 7. replaceEntriesFrom: 指定位置からエントリを置換
- **目的**: ログの競合解決
- **動作**: 指定インデックス以降を削除してから新しいエントリを追加

## 不変条件

### 1. インデックスの連続性
- ログエントリのインデックスは1から始まり、ギャップなく連続している
- 新しいエントリは常に最後のインデックス+1に追加される

### 2. エントリの一意性
- 同じインデックスに異なる内容のエントリは存在しない
- 同じインデックス・Termのペアは常に同じコマンドを示す

### 3. Termの単調性（部分的）
- 同一ログ内でTermは後退しない
- ただし、異なるノード間では一時的にTermの順序が逆転する可能性がある

### 4. コミット済みエントリの永続性
- 一度過半数のノードに複製され、コミットされたエントリは変更・削除されない
- この制約によりRaftの安全性が保証される

## インデックス管理

### インデックスの範囲
- **有効範囲**: 1 ≤ index ≤ lastIndex
- **特殊値**: index = 0 は「エントリなし」を表す
- **変換**: 配列インデックス = ログインデックス - baseIndex - 1

### baseIndexの概念
将来的なスナップショット機能のために、論理的な基準インデックスを管理：
- 初期値は0
- スナップショット作成時に更新
- 実際の配列インデックスとの変換に使用

## エラーケース

### 1. INDEX_OUT_OF_BOUNDS
- **発生条件**: 存在しないインデックスにアクセス
- **対処**: インデックスの妥当性確認

### 2. NON_SEQUENTIAL_INDEX
- **発生条件**: 連続性を破るエントリの追加試行
- **対処**: 適切な順序での追加

### 3. CANNOT_TRUNCATE_COMMITTED
- **発生条件**: コミット済みエントリの削除試行
- **対処**: コミットインデックスの確認（将来実装）

### 4. EMPTY_LOG
- **発生条件**: 空のログに対する無効な操作
- **対処**: ログの状態確認

### 5. INVALID_TERM
- **発生条件**: 現在のTermより古いTermでのエントリ追加
- **対処**: Term の妥当性確認

## パフォーマンス考慮事項

### 高頻度アクセス操作の最適化
- `getLastIndex()` / `getLastTerm()`: O(1)で実行
- キャッシュ機能により配列の末尾アクセスを回避

### メモリ効率
- 大量のエントリを扱う場合のメモリ使用量を考慮
- 将来的なスナップショット機能でメモリ使用量を制御

### バッチ操作
- レプリケーション時の複数エントリ処理を効率化
- ネットワーク帯域を考慮した分割送信

## ログの整合性チェック

### matchesTermAt機能
指定インデックス位置のTermが期待値と一致するかチェック：
```typescript
matchesTermAt(index: LogIndex, term: Term): boolean
```

**用途**:
- AppendEntriesRPCでの前提条件チェック
- ログの整合性確認
- 競合検出

### ログの統計情報
デバッグやモニタリングのための統計機能：
```typescript
interface LogStats {
  totalEntries: number;    // 総エントリ数
  lastIndex: LogIndex;     // 最後のインデックス
  lastTerm: Term;          // 最後のTerm
  terms: Term[];          // 各インデックスのTerm一覧
}
```

## 実装上の注意点

### 1. 並行性制御
- 複数の操作が同時に実行される可能性を考慮
- 適切な同期メカニズムの実装

### 2. エラーハンドリング
- 操作の失敗は必ずResult型で返す
- 失敗の詳細な理由をエラー型で表現

### 3. ロギング
- 重要な操作（追加、削除、競合解決）は日本語でログ出力
- デバッグ情報として統計情報も記録

### 4. テスト容易性
- すべての公開メソッドに対応するテストケース
- エラーケースも含めた包括的なテスト

## 関連仕様

- [01-state-machine.md](01-state-machine.md) - 状態機械管理
- [03-leader-election.md](03-leader-election.md) - リーダー選出（将来実装）
- [04-log-replication.md](04-log-replication.md) - ログレプリケーション（将来実装）
- [05-snapshot.md](05-snapshot.md) - スナップショット機能（将来実装）

## 使用例

### 基本的な操作フロー
```typescript
const log = new RaftLog();

// エントリの追加
const result1 = log.appendEntry(1, { type: 'SET', key: 'x', value: 10 });
const result2 = log.appendEntry(1, { type: 'SET', key: 'y', value: 20 });
const result3 = log.appendEntry(2, { type: 'DELETE', key: 'x' });

// エントリの取得
const entry = log.getEntry(2);
const lastEntry = log.getLastEntry();
const entries = log.getEntriesFrom(2, 5);

// ログの状態確認
const stats = log.getStats();
const matches = log.matchesTermAt(2, 1);

// 競合解決（Follower）
if (!log.matchesTermAt(2, expectedTerm)) {
  log.truncateFrom(2);
}
```
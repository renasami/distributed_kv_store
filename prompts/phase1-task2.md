# Raftコアロジック Phase 1 タスク2: ログエントリ管理

## 前提条件の確認

タスク1（型定義と状態管理）が完了していることを確認してください：

- [ ] `src/types/index.ts` が作成されている
- [ ] `src/core/State.ts` が実装されている
- [ ] すべてのテストが通っている

## タスク2: ログエントリ管理の実装

### 実装概要

Raftのログは、順序付けられたコマンドの列です。各エントリはterm番号とインデックスを持ち、これによりログの一貫性を保証します。

### 実装手順

#### 1. 技術仕様書の作成 (`docs/specs/technical/02-log-entries.md`)

以下の内容を含む日本語の仕様書を作成してください：

```markdown
# ログエントリ管理仕様

## 概要

Raftログは、クライアントからのコマンドを順序付けて保存する仕組みです。

## ログエントリの構造

- term: エントリが作成された時のterm番号
- index: 1から始まる連番
- command: 実行するコマンド（SET/DELETE等）
- timestamp: エントリ作成時刻

## 主要な操作

1. appendEntry: 新しいエントリを追加
2. getEntry: 指定インデックスのエントリを取得
3. getLastEntry: 最後のエントリを取得
4. truncateFrom: 指定インデックス以降を削除（競合解決時）
5. getEntriesFrom: 指定インデックス以降のエントリを取得

## 不変条件

- インデックスは連続している（ギャップなし）
- 同じインデックスに異なるエントリは存在しない
- 一度コミットされたエントリは変更・削除されない

## エラーケース

- 不正なインデックスへのアクセス
- 連続性を破る追加
- コミット済みエントリの削除試行
```

#### 2. 型定義の追加 (`src/types/index.ts`)

既存のファイルに以下を追加：

```typescript
// コマンドの型定義
export type Command =
  | { type: 'SET'; key: string; value: unknown }
  | { type: 'DELETE'; key: string }
  | { type: 'NOOP' }; // リーダー確立用の特殊コマンド

// ログエントリの詳細定義（既存の定義を拡張）
export interface LogEntry {
  term: Term;
  index: LogIndex;
  command: Command;
  timestamp: number;
}

// ログ管理のエラー型
export type LogError =
  | { type: 'INDEX_OUT_OF_BOUNDS'; index: LogIndex }
  | { type: 'NON_SEQUENTIAL_INDEX'; expected: LogIndex; received: LogIndex }
  | { type: 'CANNOT_TRUNCATE_COMMITTED'; index: LogIndex }
  | { type: 'EMPTY_LOG' };
```

#### 3. Logクラスのテスト作成 (`test/unit/core/Log.test.ts`)

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { RaftLog } from '@/core/Log';
import type { LogEntry, Command } from '@/types';

describe('RaftLog', () => {
  let log: RaftLog;

  beforeEach(() => {
    log = new RaftLog();
  });

  describe('初期状態', () => {
    it('空のログで開始する', () => {
      expect(log.getLength()).toBe(0);
      expect(log.isEmpty()).toBe(true);
    });

    it('最後のインデックスは0を返す', () => {
      expect(log.getLastIndex()).toBe(0);
    });

    it('最後のTermは0を返す', () => {
      expect(log.getLastTerm()).toBe(0);
    });
  });

  describe('エントリの追加', () => {
    it('最初のエントリを追加できる', () => {
      const command: Command = { type: 'SET', key: 'x', value: 1 };
      const result = log.appendEntry(1, command);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.index).toBe(1);
        expect(result.value.term).toBe(1);
        expect(result.value.command).toEqual(command);
      }
    });

    it('複数のエントリを順番に追加できる', () => {
      log.appendEntry(1, { type: 'SET', key: 'x', value: 1 });
      log.appendEntry(1, { type: 'SET', key: 'y', value: 2 });
      log.appendEntry(2, { type: 'DELETE', key: 'x' });

      expect(log.getLength()).toBe(3);
      expect(log.getLastIndex()).toBe(3);
      expect(log.getLastTerm()).toBe(2);
    });

    it('Termが後退するエントリは追加できない', () => {
      log.appendEntry(2, { type: 'SET', key: 'x', value: 1 });
      const result = log.appendEntry(1, { type: 'SET', key: 'y', value: 2 });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('INVALID_TERM');
      }
    });
  });

  describe('エントリの取得', () => {
    beforeEach(() => {
      log.appendEntry(1, { type: 'SET', key: 'x', value: 1 });
      log.appendEntry(1, { type: 'SET', key: 'y', value: 2 });
      log.appendEntry(2, { type: 'DELETE', key: 'x' });
    });

    it('インデックスでエントリを取得できる', () => {
      const entry = log.getEntry(2);
      expect(entry).toBeDefined();
      expect(entry?.index).toBe(2);
      expect(entry?.term).toBe(1);
    });

    it('存在しないインデックスはnullを返す', () => {
      expect(log.getEntry(0)).toBeNull();
      expect(log.getEntry(4)).toBeNull();
    });

    it('最後のエントリを取得できる', () => {
      const last = log.getLastEntry();
      expect(last).toBeDefined();
      expect(last?.index).toBe(3);
      expect(last?.term).toBe(2);
    });

    it('範囲指定でエントリを取得できる', () => {
      const entries = log.getEntriesFrom(2);
      expect(entries).toHaveLength(2);
      expect(entries[0].index).toBe(2);
      expect(entries[1].index).toBe(3);
    });

    it('最大数を指定してエントリを取得できる', () => {
      const entries = log.getEntriesFrom(1, 2);
      expect(entries).toHaveLength(2);
      expect(entries[0].index).toBe(1);
      expect(entries[1].index).toBe(2);
    });
  });

  describe('ログの切り詰め', () => {
    beforeEach(() => {
      log.appendEntry(1, { type: 'SET', key: 'x', value: 1 });
      log.appendEntry(1, { type: 'SET', key: 'y', value: 2 });
      log.appendEntry(2, { type: 'SET', key: 'z', value: 3 });
      log.appendEntry(2, { type: 'DELETE', key: 'x' });
    });

    it('指定インデックス以降を削除できる', () => {
      const result = log.truncateFrom(3);

      expect(result.ok).toBe(true);
      expect(log.getLength()).toBe(2);
      expect(log.getLastIndex()).toBe(2);
      expect(log.getEntry(3)).toBeNull();
      expect(log.getEntry(4)).toBeNull();
    });

    it('すべてのエントリを削除できる', () => {
      const result = log.truncateFrom(1);

      expect(result.ok).toBe(true);
      expect(log.isEmpty()).toBe(true);
      expect(log.getLength()).toBe(0);
    });

    it('範囲外のインデックスはエラーを返す', () => {
      const result = log.truncateFrom(5);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('INDEX_OUT_OF_BOUNDS');
      }
    });
  });

  describe('ログの一致確認', () => {
    beforeEach(() => {
      log.appendEntry(1, { type: 'SET', key: 'x', value: 1 });
      log.appendEntry(2, { type: 'SET', key: 'y', value: 2 });
      log.appendEntry(2, { type: 'SET', key: 'z', value: 3 });
    });

    it('指定位置のTermが一致するか確認できる', () => {
      expect(log.matchesTermAt(1, 1)).toBe(true);
      expect(log.matchesTermAt(2, 2)).toBe(true);
      expect(log.matchesTermAt(3, 2)).toBe(true);
    });

    it('Termが一致しない場合はfalseを返す', () => {
      expect(log.matchesTermAt(1, 2)).toBe(false);
      expect(log.matchesTermAt(2, 1)).toBe(false);
    });

    it('存在しないインデックスはfalseを返す', () => {
      expect(log.matchesTermAt(0, 1)).toBe(false);
      expect(log.matchesTermAt(4, 2)).toBe(false);
    });
  });

  describe('バッチ操作', () => {
    it('複数のエントリを一度に追加できる', () => {
      const entries: Omit<LogEntry, 'index'>[] = [
        { term: 1, command: { type: 'SET', key: 'x', value: 1 }, timestamp: Date.now() },
        { term: 1, command: { type: 'SET', key: 'y', value: 2 }, timestamp: Date.now() },
        { term: 2, command: { type: 'DELETE', key: 'x' }, timestamp: Date.now() },
      ];

      const result = log.appendEntries(entries);

      expect(result.ok).toBe(true);
      expect(log.getLength()).toBe(3);
      expect(log.getLastIndex()).toBe(3);
    });

    it('競合するエントリがある場合は削除してから追加する', () => {
      log.appendEntry(1, { type: 'SET', key: 'x', value: 1 });
      log.appendEntry(1, { type: 'SET', key: 'y', value: 2 });
      log.appendEntry(1, { type: 'SET', key: 'z', value: 3 });

      // インデックス2から異なるエントリを追加
      const newEntries: Omit<LogEntry, 'index'>[] = [
        { term: 2, command: { type: 'DELETE', key: 'y' }, timestamp: Date.now() },
        { term: 2, command: { type: 'SET', key: 'w', value: 4 }, timestamp: Date.now() },
      ];

      const result = log.replaceEntriesFrom(2, newEntries);

      expect(result.ok).toBe(true);
      expect(log.getLength()).toBe(3);
      expect(log.getEntry(2)?.term).toBe(2);
      expect(log.getEntry(3)?.command.type).toBe('SET');
    });
  });

  describe('メタデータ', () => {
    it('ログの統計情報を取得できる', () => {
      log.appendEntry(1, { type: 'SET', key: 'x', value: 1 });
      log.appendEntry(1, { type: 'SET', key: 'y', value: 2 });
      log.appendEntry(2, { type: 'DELETE', key: 'x' });

      const stats = log.getStats();

      expect(stats.totalEntries).toBe(3);
      expect(stats.lastIndex).toBe(3);
      expect(stats.lastTerm).toBe(2);
      expect(stats.terms).toEqual([1, 1, 2]);
    });
  });
});
```

#### 4. Logクラスの実装 (`src/core/Log.ts`)

テストを通すための実装を作成してください。以下は実装のスケルトンです：

```typescript
import type { LogEntry, LogIndex, Term, Command, Result, LogError } from '@/types';

/**
 * Raftログを管理するクラス
 * ログエントリの追加、取得、切り詰めを担当
 */
export class RaftLog {
  private entries: LogEntry[] = [];
  private baseIndex: LogIndex = 0; // スナップショット後の基準インデックス

  constructor() {
    console.log('ログを初期化しました');
  }

  /**
   * ログが空かどうかを確認
   */
  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /**
   * ログの長さを取得
   */
  getLength(): number {
    return this.entries.length;
  }

  /**
   * 最後のインデックスを取得（空の場合は0）
   */
  getLastIndex(): LogIndex {
    // 実装してください
  }

  /**
   * 最後のTermを取得（空の場合は0）
   */
  getLastTerm(): Term {
    // 実装してください
  }

  /**
   * 新しいエントリを追加
   * @param term エントリのterm
   * @param command 実行するコマンド
   * @returns 追加されたエントリまたはエラー
   */
  appendEntry(term: Term, command: Command): Result<LogEntry, LogError> {
    // 実装してください
    // - Termの妥当性を確認
    // - インデックスを計算
    // - エントリを作成して追加
  }

  /**
   * 指定インデックスのエントリを取得
   * @param index 取得するインデックス
   * @returns エントリまたはnull
   */
  getEntry(index: LogIndex): LogEntry | null {
    // 実装してください
  }

  /**
   * 指定インデックス以降を削除
   * @param index 削除開始インデックス
   * @returns 成功またはエラー
   */
  truncateFrom(index: LogIndex): Result<void, LogError> {
    // 実装してください
    // - インデックスの妥当性を確認
    // - 指定位置以降を削除
  }

  /**
   * 指定位置のTermが一致するか確認
   * @param index チェックするインデックス
   * @param term 期待されるterm
   * @returns 一致する場合true
   */
  matchesTermAt(index: LogIndex, term: Term): boolean {
    // 実装してください
  }

  // 他のメソッドも実装してください
}
```

### 完了チェックリスト

- [ ] 技術仕様書が日本語で作成されている
- [ ] 型定義が追加されている
- [ ] すべてのテストケースが記述されている
- [ ] テストが失敗することを確認した
- [ ] 実装を行い、すべてのテストが通る
- [ ] ログの一貫性が保たれることを確認
- [ ] エラーハンドリングが適切に行われている
- [ ] コメントがすべて日本語である
- [ ] `npm run test` で全テストが通る

### コミット

完了したら以下のコマンドでコミット：

```bash
git add -A
git commit -m "feat: ログエントリ管理を実装"
```

### 次のステップ

タスク2が完了したら、タスク3（タイマー管理）に進みます。

## 実装のヒント

1. **インデックスの管理**
   - インデックスは1から始まる（0は「エントリなし」を表す）
   - 配列のインデックスとログインデックスの変換に注意

2. **Termの単調性**
   - 新しいエントリのTermは現在の最後のTerm以上でなければならない
   - これはリーダーの一貫性を保証するため

3. **切り詰め操作**
   - Followerがリーダーと競合するエントリを持つ場合に使用
   - コミット済みエントリは削除してはいけない（将来の実装で考慮）

4. **パフォーマンス**
   - 頻繁にアクセスされる`getLastIndex`と`getLastTerm`は高速に
   - 将来的には大量のエントリを扱うことを考慮

実装を開始してください。質問があれば聞いてください。

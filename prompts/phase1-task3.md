# Raftコアロジック Phase 1 タスク3: タイマー管理

## 前提条件の確認

タスク1, 2が完了していることを確認してください：

- [ ] `src/core/State.ts` が実装されている
- [ ] `src/core/Log.ts` が実装されている
- [ ] すべてのテストが通っている

## タスク3: タイマー管理の実装

### 実装概要

Raftでは2種類のタイマーが重要な役割を果たします：

1. **選挙タイムアウト**: Followerがリーダーを検出できない場合に選挙を開始
2. **ハートビート間隔**: リーダーが自身の存在を知らせる

これらのタイマーを管理し、テスト可能な形で実装します。

### 実装手順

#### 1. 技術仕様書の作成 (`docs/specs/technical/03-timers.md`)

以下の内容を含む日本語の仕様書を作成してください：

```markdown
# タイマー管理仕様

## 概要

Raftアルゴリズムにおけるタイムアウト管理を担当する。
テスト容易性のため、実時間とは独立した論理時間で動作可能にする。

## タイマーの種類

### 1. 選挙タイムアウト

- 用途: Follower/Candidateが使用
- タイムアウト時間: 150-300ms（ランダム）
- トリガー: リーダーからの通信がない場合
- アクション: 選挙を開始

### 2. ハートビート間隔

- 用途: リーダーが使用
- 間隔: 50ms（固定）
- アクション: 全Followerにハートビートを送信

## タイミング要件
```

broadcastTime << electionTimeout << MTBF

典型的な値:

- broadcastTime: 0.5-20ms
- electionTimeout: 150-300ms
- heartbeatInterval: 50ms
- MTBF: 数ヶ月

```

## ランダム化の重要性
- Split vote（票の分散）を防ぐため
- 各ノードが異なるタイムアウトを使用
- 範囲: electionTimeoutMin ～ electionTimeoutMax

## テスト戦略
- 実時間ではなく論理時間を使用
- 時間を任意に進められるMockタイマー
- 決定的なテストが可能

## エラーケース
- タイマーの多重起動防止
- 不正な時間値の設定防止
```

#### 2. 型定義の追加 (`src/types/index.ts`)

既存のファイルに以下を追加：

```typescript
// タイマー関連の型
export type TimerId = string;
export type Milliseconds = number;

// タイマーコールバック
export type TimerCallback = () => void;

// タイマー設定
export interface TimerConfig {
  electionTimeoutMin: Milliseconds;
  electionTimeoutMax: Milliseconds;
  heartbeatInterval: Milliseconds;
}

// デフォルト設定
export const DEFAULT_TIMER_CONFIG: TimerConfig = {
  electionTimeoutMin: 150,
  electionTimeoutMax: 300,
  heartbeatInterval: 50,
};

// タイマーイベント
export type TimerEvent =
  | { type: 'ELECTION_TIMEOUT' }
  | { type: 'HEARTBEAT_INTERVAL' }
  | { type: 'REQUEST_TIMEOUT'; requestId: string };

// 時間プロバイダーインターフェース（テスト用）
export interface TimeProvider {
  now(): number;
  setTimeout(callback: TimerCallback, delay: Milliseconds): TimerId;
  clearTimeout(timerId: TimerId): void;
}
```

#### 3. タイマークラスのテスト作成 (`test/unit/core/Timer.test.ts`)

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RaftTimer } from '@/core/Timer';
import { MockTimeProvider } from '@/test/utils/MockTimeProvider';
import type { TimerConfig } from '@/types';

describe('RaftTimer', () => {
  let timer: RaftTimer;
  let mockTime: MockTimeProvider;
  let config: TimerConfig;

  beforeEach(() => {
    mockTime = new MockTimeProvider();
    config = {
      electionTimeoutMin: 150,
      electionTimeoutMax: 300,
      heartbeatInterval: 50,
    };
    timer = new RaftTimer(config, mockTime);
  });

  describe('選挙タイムアウト', () => {
    it('選挙タイムアウトを開始できる', () => {
      const callback = vi.fn();
      timer.startElectionTimeout(callback);

      expect(mockTime.activeTimers()).toBe(1);
      expect(callback).not.toHaveBeenCalled();
    });

    it('指定時間後にコールバックが呼ばれる', () => {
      const callback = vi.fn();
      timer.startElectionTimeout(callback);

      // 最小時間では発火しない
      mockTime.advance(149);
      expect(callback).not.toHaveBeenCalled();

      // 最小時間を超えると発火する可能性がある
      mockTime.advance(200); // 合計349ms
      expect(callback).toHaveBeenCalledOnce();
    });

    it('タイムアウト時間がランダム化される', () => {
      const timeouts: number[] = [];

      for (let i = 0; i < 10; i++) {
        const newTimer = new RaftTimer(config, mockTime);
        const timeout = newTimer.getRandomElectionTimeout();
        timeouts.push(timeout);
      }

      // すべて範囲内
      timeouts.forEach((timeout) => {
        expect(timeout).toBeGreaterThanOrEqual(150);
        expect(timeout).toBeLessThanOrEqual(300);
      });

      // すべて同じ値ではない（高確率で）
      const uniqueTimeouts = new Set(timeouts);
      expect(uniqueTimeouts.size).toBeGreaterThan(1);
    });

    it('選挙タイムアウトをリセットできる', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      timer.startElectionTimeout(callback1);
      mockTime.advance(100);

      // リセット（新しいコールバックで）
      timer.resetElectionTimeout(callback2);
      mockTime.advance(100); // 合計200ms

      // 古いコールバックは呼ばれない
      expect(callback1).not.toHaveBeenCalled();

      // 新しいタイムアウトが設定される
      mockTime.advance(200); // リセットから200ms
      expect(callback2).toHaveBeenCalledOnce();
    });

    it('選挙タイムアウトを停止できる', () => {
      const callback = vi.fn();
      timer.startElectionTimeout(callback);

      timer.stopElectionTimeout();
      mockTime.advance(500);

      expect(callback).not.toHaveBeenCalled();
      expect(mockTime.activeTimers()).toBe(0);
    });

    it('多重起動を防ぐ', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      timer.startElectionTimeout(callback1);
      timer.startElectionTimeout(callback2); // 既存のタイマーを上書き

      expect(mockTime.activeTimers()).toBe(1);

      mockTime.advance(300);
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledOnce();
    });
  });

  describe('ハートビート間隔', () => {
    it('ハートビート間隔を開始できる', () => {
      const callback = vi.fn();
      timer.startHeartbeatInterval(callback);

      expect(mockTime.activeTimers()).toBe(1);
      expect(callback).not.toHaveBeenCalled();
    });

    it('固定間隔でコールバックが繰り返し呼ばれる', () => {
      const callback = vi.fn();
      timer.startHeartbeatInterval(callback);

      // 1回目
      mockTime.advance(50);
      expect(callback).toHaveBeenCalledTimes(1);

      // 2回目
      mockTime.advance(50);
      expect(callback).toHaveBeenCalledTimes(2);

      // 3回目
      mockTime.advance(50);
      expect(callback).toHaveBeenCalledTimes(3);
    });

    it('ハートビート間隔を停止できる', () => {
      const callback = vi.fn();
      timer.startHeartbeatInterval(callback);

      mockTime.advance(50);
      expect(callback).toHaveBeenCalledTimes(1);

      timer.stopHeartbeatInterval();
      mockTime.advance(100);

      // 停止後は呼ばれない
      expect(callback).toHaveBeenCalledTimes(1);
      expect(mockTime.activeTimers()).toBe(0);
    });

    it('多重起動を防ぐ', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      timer.startHeartbeatInterval(callback1);
      timer.startHeartbeatInterval(callback2); // 既存のタイマーを上書き

      mockTime.advance(50);

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledOnce();
    });
  });

  describe('タイマーの組み合わせ', () => {
    it('選挙タイムアウトとハートビートを同時に使用できる', () => {
      const electionCallback = vi.fn();
      const heartbeatCallback = vi.fn();

      timer.startElectionTimeout(electionCallback);
      timer.startHeartbeatInterval(heartbeatCallback);

      expect(mockTime.activeTimers()).toBe(2);

      // ハートビートが先に発火
      mockTime.advance(50);
      expect(heartbeatCallback).toHaveBeenCalledTimes(1);
      expect(electionCallback).not.toHaveBeenCalled();

      // さらに時間を進める
      mockTime.advance(200);
      expect(heartbeatCallback).toHaveBeenCalledTimes(5); // 合計250ms / 50ms
      expect(electionCallback).toHaveBeenCalledOnce();
    });
  });

  describe('すべてのタイマーの管理', () => {
    it('すべてのタイマーを一度に停止できる', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      timer.startElectionTimeout(callback1);
      timer.startHeartbeatInterval(callback2);

      expect(mockTime.activeTimers()).toBe(2);

      timer.stopAll();

      expect(mockTime.activeTimers()).toBe(0);

      mockTime.advance(500);
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).not.toHaveBeenCalled();
    });

    it('アクティブなタイマーの状態を取得できる', () => {
      expect(timer.getActiveTimers()).toEqual({
        electionTimeout: false,
        heartbeatInterval: false,
      });

      timer.startElectionTimeout(() => {});
      expect(timer.getActiveTimers()).toEqual({
        electionTimeout: true,
        heartbeatInterval: false,
      });

      timer.startHeartbeatInterval(() => {});
      expect(timer.getActiveTimers()).toEqual({
        electionTimeout: true,
        heartbeatInterval: true,
      });
    });
  });
});
```

#### 4. MockTimeProviderの実装 (`test/utils/MockTimeProvider.ts`)

テスト用のモック時間プロバイダー：

```typescript
import type { TimeProvider, TimerId, Milliseconds, TimerCallback } from '@/types';

/**
 * テスト用のモック時間プロバイダー
 * 時間を任意に進めることができる
 */
export class MockTimeProvider implements TimeProvider {
  private currentTime = 0;
  private timers = new Map<
    TimerId,
    {
      callback: TimerCallback;
      fireAt: number;
      interval?: Milliseconds;
    }
  >();
  private nextTimerId = 1;

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: TimerCallback, delay: Milliseconds): TimerId {
    const id = `timer-${this.nextTimerId++}`;
    this.timers.set(id, {
      callback,
      fireAt: this.currentTime + delay,
    });
    return id;
  }

  setInterval(callback: TimerCallback, interval: Milliseconds): TimerId {
    const id = `interval-${this.nextTimerId++}`;
    this.timers.set(id, {
      callback,
      fireAt: this.currentTime + interval,
      interval,
    });
    return id;
  }

  clearTimeout(timerId: TimerId): void {
    this.timers.delete(timerId);
  }

  /**
   * 時間を指定ミリ秒進める
   * この間に発火するタイマーをすべて実行
   */
  advance(ms: Milliseconds): void {
    const targetTime = this.currentTime + ms;

    while (this.currentTime < targetTime) {
      // 次に発火するタイマーを探す
      let nextFireTime = targetTime;
      let nextTimer: [TimerId, typeof this.timers extends Map<any, infer V> ? V : never] | null =
        null;

      for (const [id, timer] of this.timers.entries()) {
        if (timer.fireAt <= targetTime && timer.fireAt < nextFireTime) {
          nextFireTime = timer.fireAt;
          nextTimer = [id, timer];
        }
      }

      if (nextTimer) {
        this.currentTime = nextFireTime;
        const [id, timer] = nextTimer;

        if (timer.interval) {
          // インターバルタイマーは再スケジュール
          timer.fireAt = this.currentTime + timer.interval;
        } else {
          // 単発タイマーは削除
          this.timers.delete(id);
        }

        timer.callback();
      } else {
        this.currentTime = targetTime;
      }
    }
  }

  /**
   * アクティブなタイマーの数を取得
   */
  activeTimers(): number {
    return this.timers.size;
  }

  /**
   * すべてのタイマーをクリア
   */
  clearAll(): void {
    this.timers.clear();
  }
}
```

#### 5. Timerクラスの実装 (`src/core/Timer.ts`)

```typescript
import type { TimerConfig, TimeProvider, TimerId, TimerCallback, Milliseconds } from '@/types';

/**
 * Raftのタイマー管理クラス
 * 選挙タイムアウトとハートビート間隔を管理
 */
export class RaftTimer {
  private config: TimerConfig;
  private timeProvider: TimeProvider;
  private electionTimeoutId: TimerId | null = null;
  private heartbeatIntervalId: TimerId | null = null;
  private currentElectionTimeout: Milliseconds = 0;

  constructor(config: TimerConfig, timeProvider: TimeProvider = globalThis) {
    this.config = config;
    this.timeProvider = timeProvider;
    this.currentElectionTimeout = this.getRandomElectionTimeout();

    console.log(
      `タイマーを初期化しました: 選挙タイムアウト=${this.currentElectionTimeout}ms, ハートビート間隔=${config.heartbeatInterval}ms`,
    );
  }

  /**
   * ランダムな選挙タイムアウト時間を生成
   */
  getRandomElectionTimeout(): Milliseconds {
    const { electionTimeoutMin, electionTimeoutMax } = this.config;
    const range = electionTimeoutMax - electionTimeoutMin;
    return Math.floor(Math.random() * range) + electionTimeoutMin;
  }

  /**
   * 選挙タイムアウトを開始
   * @param callback タイムアウト時に呼ばれるコールバック
   */
  startElectionTimeout(callback: TimerCallback): void {
    // 既存のタイマーがあれば停止
    this.stopElectionTimeout();

    this.currentElectionTimeout = this.getRandomElectionTimeout();
    console.log(`選挙タイムアウトを開始: ${this.currentElectionTimeout}ms`);

    this.electionTimeoutId = this.timeProvider.setTimeout(() => {
      console.log('選挙タイムアウトが発生しました');
      this.electionTimeoutId = null;
      callback();
    }, this.currentElectionTimeout);
  }

  /**
   * 選挙タイムアウトをリセット（新しいランダム時間で再開始）
   * @param callback タイムアウト時に呼ばれるコールバック
   */
  resetElectionTimeout(callback: TimerCallback): void {
    console.log('選挙タイムアウトをリセット');
    this.startElectionTimeout(callback);
  }

  /**
   * 選挙タイムアウトを停止
   */
  stopElectionTimeout(): void {
    if (this.electionTimeoutId) {
      console.log('選挙タイムアウトを停止');
      this.timeProvider.clearTimeout(this.electionTimeoutId);
      this.electionTimeoutId = null;
    }
  }

  /**
   * ハートビート間隔を開始
   * @param callback 間隔ごとに呼ばれるコールバック
   */
  startHeartbeatInterval(callback: TimerCallback): void {
    // 既存のタイマーがあれば停止
    this.stopHeartbeatInterval();

    console.log(`ハートビート間隔を開始: ${this.config.heartbeatInterval}ms`);

    // setIntervalの代わりにsetTimeoutを繰り返し使用（テストしやすいため）
    const scheduleNext = (): void => {
      this.heartbeatIntervalId = this.timeProvider.setTimeout(() => {
        callback();
        if (this.heartbeatIntervalId) {
          scheduleNext();
        }
      }, this.config.heartbeatInterval);
    };

    scheduleNext();
  }

  /**
   * ハートビート間隔を停止
   */
  stopHeartbeatInterval(): void {
    if (this.heartbeatIntervalId) {
      console.log('ハートビート間隔を停止');
      this.timeProvider.clearTimeout(this.heartbeatIntervalId);
      this.heartbeatIntervalId = null;
    }
  }

  /**
   * すべてのタイマーを停止
   */
  stopAll(): void {
    console.log('すべてのタイマーを停止');
    this.stopElectionTimeout();
    this.stopHeartbeatInterval();
  }

  /**
   * アクティブなタイマーの状態を取得
   */
  getActiveTimers(): { electionTimeout: boolean; heartbeatInterval: boolean } {
    return {
      electionTimeout: this.electionTimeoutId !== null,
      heartbeatInterval: this.heartbeatIntervalId !== null,
    };
  }
}
```

### 完了チェックリスト

- [ ] 技術仕様書が日本語で作成されている
- [ ] 型定義が追加されている
- [ ] MockTimeProviderが実装されている
- [ ] すべてのテストケースが記述されている
- [ ] テストが失敗することを確認した
- [ ] 実装を行い、すべてのテストが通る
- [ ] ランダム化が正しく動作する
- [ ] タイマーの多重起動が防がれている
- [ ] コメントがすべて日本語である
- [ ] `npm run test` で全テストが通る

### コミット

完了したら以下のコマンドでコミット：

```bash
git add -A
git commit -m "feat: タイマー管理を実装"
```

### Phase 1 完了！

タスク3が完了したら、Phase 1（基礎実装）が完了です。

統合テストを作成して、3つのコンポーネントが連携することを確認：

```bash
# 統合テスト作成
touch test/integration/phase1.integration.test.ts
```

Phase 1の成果：

1. ✅ 状態管理（State）
2. ✅ ログエントリ管理（Log）
3. ✅ タイマー管理（Timer）

次はPhase 2（Raftアルゴリズム実装）に進みます。

## 実装のヒント

1. **テスト容易性**
   - 実時間に依存しない設計
   - MockTimeProviderで決定的なテストを実現
   - すべての非同期処理を制御可能に

2. **ランダム化の重要性**
   - Split voteを防ぐ核心機能
   - 範囲内で均等に分布することを確認

3. **タイマーのライフサイクル**
   - 状態遷移時に適切に開始/停止
   - メモリリークを防ぐため確実にクリーンアップ

4. **デバッグ性**
   - ログで現在のタイムアウト値を出力
   - どのタイマーがアクティブか追跡可能に

実装を開始してください。Phase 1お疲れ様でした！

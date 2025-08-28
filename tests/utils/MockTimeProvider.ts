import type { TimeProvider, TimerId, Milliseconds, TimerCallback } from '@/types';

/**
 * テスト用のモック時間プロバイダー
 * 時間を任意に進めることができる
 */
export class MockTimeProvider implements TimeProvider {
  private currentTime = 0;
  private timers = new Map<TimerId, {
    callback: TimerCallback;
    fireAt: number;
    interval?: Milliseconds;
  }>();
  private nextTimerId = 1;
  
  now(): number {
    return this.currentTime;
  }
  
  setTimeout(callback: TimerCallback, delay: Milliseconds): TimerId {
    const id = `timer-${this.nextTimerId++}`;
    this.timers.set(id, {
      callback,
      fireAt: this.currentTime + delay
    });
    return id;
  }
  
  /**
   * setIntervalの代替実装
   * 内部的にはsetTimeoutを繰り返し呼び出す
   */
  setInterval(callback: TimerCallback, interval: Milliseconds): TimerId {
    const id = `interval-${this.nextTimerId++}`;
    this.timers.set(id, {
      callback,
      fireAt: this.currentTime + interval,
      interval
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
    
    // 発火すべきタイマーを時系列順に実行
    while (this.currentTime < targetTime) {
      // 次に発火するタイマーを探す
      let nextFireTime = targetTime;
      let nextTimerEntry: [TimerId, typeof this.timers extends Map<any, infer V> ? V : never] | null = null;
      
      for (const [id, timer] of this.timers.entries()) {
        if (timer.fireAt <= targetTime && timer.fireAt <= nextFireTime) {
          nextFireTime = timer.fireAt;
          nextTimerEntry = [id, timer];
        }
      }
      
      if (nextTimerEntry) {
        this.currentTime = nextFireTime;
        const [id, timer] = nextTimerEntry;
        
        if (timer.interval) {
          // インターバルタイマーは次回実行時間を設定して継続
          timer.fireAt = this.currentTime + timer.interval;
        } else {
          // 単発タイマーは削除
          this.timers.delete(id);
        }
        
        // コールバックを実行
        timer.callback();
      } else {
        // 発火するタイマーがない場合は目標時間まで一気に進める
        this.currentTime = targetTime;
        break;
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
  
  /**
   * 現在時刻を設定（テスト初期化用）
   */
  setCurrentTime(time: number): void {
    this.currentTime = time;
  }
  
  /**
   * 現在のタイマー状態をデバッグ用に出力
   */
  getTimerInfo(): Array<{id: TimerId; fireAt: number; interval?: Milliseconds}> {
    const info: Array<{id: TimerId; fireAt: number; interval?: Milliseconds}> = [];
    for (const [id, timer] of this.timers.entries()) {
      info.push({
        id,
        fireAt: timer.fireAt,
        interval: timer.interval
      });
    }
    return info.sort((a, b) => a.fireAt - b.fireAt);
  }
  
  /**
   * 次に発火するタイマーまでの時間を取得
   */
  getNextFireTime(): number | null {
    let nextTime: number | null = null;
    
    for (const timer of this.timers.values()) {
      if (nextTime === null || timer.fireAt < nextTime) {
        nextTime = timer.fireAt;
      }
    }
    
    return nextTime;
  }
  
  /**
   * 指定したタイマーIDが存在するかチェック
   */
  hasTimer(timerId: TimerId): boolean {
    return this.timers.has(timerId);
  }
}
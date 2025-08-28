import type { 
  TimerConfig, 
  TimeProvider, 
  TimerId, 
  TimerCallback,
  Milliseconds 
} from '@/types';

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
  
  constructor(
    config: TimerConfig,
    timeProvider?: TimeProvider
  ) {
    // 設定値の検証
    this.validateConfig(config);
    
    this.config = config;
    // デフォルトのTimeProviderを設定（Nodeのglobal）
    this.timeProvider = timeProvider || {
      now: () => Date.now(),
      setTimeout: (callback: TimerCallback, delay: Milliseconds) => {
        const id = setTimeout(callback, delay) as any;
        return id.toString();
      },
      clearTimeout: (timerId: TimerId) => {
        clearTimeout(parseInt(timerId));
      }
    };
    this.currentElectionTimeout = this.getRandomElectionTimeout();
    
    console.log(`情報: タイマーを初期化しました: 選挙タイムアウト=${this.currentElectionTimeout}ms, ハートビート間隔=${config.heartbeatInterval}ms`);
  }
  
  /**
   * 設定値の妥当性を検証
   */
  private validateConfig(config: TimerConfig): void {
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
    console.log(`情報: 選挙タイムアウトを開始: ${this.currentElectionTimeout}ms`);
    
    this.electionTimeoutId = this.timeProvider.setTimeout(() => {
      console.log('情報: 選挙タイムアウトが発生しました');
      this.electionTimeoutId = null;
      callback();
    }, this.currentElectionTimeout);
  }
  
  /**
   * 選挙タイムアウトをリセット（新しいランダム時間で再開始）
   * @param callback タイムアウト時に呼ばれるコールバック
   */
  resetElectionTimeout(callback: TimerCallback): void {
    console.log('情報: 選挙タイムアウトをリセット');
    this.startElectionTimeout(callback);
  }
  
  /**
   * 選挙タイムアウトを停止
   */
  stopElectionTimeout(): void {
    if (this.electionTimeoutId) {
      console.log('情報: 選挙タイムアウトを停止');
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
    
    console.log(`情報: ハートビート間隔を開始: ${this.config.heartbeatInterval}ms`);
    
    // setIntervalの代わりにsetTimeoutを繰り返し使用（テストしやすいため）
    const scheduleNext = (): void => {
      this.heartbeatIntervalId = this.timeProvider.setTimeout(() => {
        console.log('情報: ハートビートが発生しました');
        
        // コールバックを実行
        callback();
        
        // タイマーがまだ有効なら次回をスケジュール
        if (this.heartbeatIntervalId !== null) {
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
      console.log('情報: ハートビート間隔を停止');
      this.timeProvider.clearTimeout(this.heartbeatIntervalId);
      this.heartbeatIntervalId = null;
    }
  }
  
  /**
   * すべてのタイマーを停止
   */
  stopAll(): void {
    console.log('情報: すべてのタイマーを停止');
    this.stopElectionTimeout();
    this.stopHeartbeatInterval();
  }
  
  /**
   * アクティブなタイマーの状態を取得
   */
  getActiveTimers(): { electionTimeout: boolean; heartbeatInterval: boolean } {
    return {
      electionTimeout: this.electionTimeoutId !== null,
      heartbeatInterval: this.heartbeatIntervalId !== null
    };
  }
  
  /**
   * 現在の選挙タイムアウト値を取得（デバッグ用）
   */
  getCurrentElectionTimeout(): Milliseconds {
    return this.currentElectionTimeout;
  }
  
  /**
   * デバッグ用の文字列表現
   */
  toString(): string {
    const activeTimers = this.getActiveTimers();
    return `RaftTimer{electionTimeout: ${activeTimers.electionTimeout}, heartbeatInterval: ${activeTimers.heartbeatInterval}, currentElectionTimeout: ${this.currentElectionTimeout}ms}`;
  }
}
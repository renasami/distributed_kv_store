import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RaftTimer } from '@/core/Timer';
import { MockTimeProvider } from '../../utils/MockTimeProvider';
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
      heartbeatInterval: 50
    };
    timer = new RaftTimer(config, mockTime);
  });
  
  describe('初期化', () => {
    it('設定値で初期化される', () => {
      expect(timer.getActiveTimers().electionTimeout).toBe(false);
      expect(timer.getActiveTimers().heartbeatInterval).toBe(false);
    });
    
    it('ランダム選挙タイムアウトが範囲内で生成される', () => {
      const timeout = timer.getRandomElectionTimeout();
      expect(timeout).toBeGreaterThanOrEqual(150);
      expect(timeout).toBeLessThanOrEqual(300);
    });
  });
  
  describe('選挙タイムアウト', () => {
    it('選挙タイムアウトを開始できる', () => {
      const callback = vi.fn();
      timer.startElectionTimeout(callback);
      
      expect(mockTime.activeTimers()).toBe(1);
      expect(timer.getActiveTimers().electionTimeout).toBe(true);
      expect(callback).not.toHaveBeenCalled();
    });
    
    it('指定時間後にコールバックが呼ばれる', () => {
      const callback = vi.fn();
      timer.startElectionTimeout(callback);
      
      // 最小時間では発火しない
      mockTime.advance(149);
      expect(callback).not.toHaveBeenCalled();
      expect(timer.getActiveTimers().electionTimeout).toBe(true);
      
      // 最大時間を超えると必ず発火する
      mockTime.advance(200); // 合計349ms（必ず最大時間300msを超える）
      expect(callback).toHaveBeenCalledOnce();
      expect(timer.getActiveTimers().electionTimeout).toBe(false);
    });
    
    it('タイムアウト時間がランダム化される', () => {
      const timeouts: number[] = [];
      
      for (let i = 0; i < 10; i++) {
        const newTimer = new RaftTimer(config, mockTime);
        const timeout = newTimer.getRandomElectionTimeout();
        timeouts.push(timeout);
      }
      
      // すべて範囲内
      timeouts.forEach(timeout => {
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
      expect(timer.getActiveTimers().electionTimeout).toBe(true);
      
      mockTime.advance(100); // 合計200ms
      
      // 古いコールバックは呼ばれない
      expect(callback1).not.toHaveBeenCalled();
      
      // 新しいタイムアウトが設定される
      mockTime.advance(200); // リセットから200ms（最大300msを考慮）
      expect(callback2).toHaveBeenCalledOnce();
    });
    
    it('選挙タイムアウトを停止できる', () => {
      const callback = vi.fn();
      timer.startElectionTimeout(callback);
      
      expect(timer.getActiveTimers().electionTimeout).toBe(true);
      
      timer.stopElectionTimeout();
      expect(timer.getActiveTimers().electionTimeout).toBe(false);
      
      mockTime.advance(500);
      
      expect(callback).not.toHaveBeenCalled();
      expect(mockTime.activeTimers()).toBe(0);
    });
    
    it('多重起動を防ぐ', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      
      timer.startElectionTimeout(callback1);
      expect(mockTime.activeTimers()).toBe(1);
      
      timer.startElectionTimeout(callback2); // 既存のタイマーを上書き
      
      expect(mockTime.activeTimers()).toBe(1);
      
      mockTime.advance(350); // 最大時間を超える
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledOnce();
    });
  });
  
  describe('ハートビート間隔', () => {
    it('ハートビート間隔を開始できる', () => {
      const callback = vi.fn();
      timer.startHeartbeatInterval(callback);
      
      expect(mockTime.activeTimers()).toBe(1);
      expect(timer.getActiveTimers().heartbeatInterval).toBe(true);
      expect(callback).not.toHaveBeenCalled();
    });
    
    it('固定間隔でコールバックが繰り返し呼ばれる', () => {
      const callback = vi.fn();
      timer.startHeartbeatInterval(callback);
      
      // 1回目
      mockTime.advance(50);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(timer.getActiveTimers().heartbeatInterval).toBe(true);
      
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
      expect(timer.getActiveTimers().heartbeatInterval).toBe(false);
      
      mockTime.advance(100);
      
      // 停止後は呼ばれない
      expect(callback).toHaveBeenCalledTimes(1);
      expect(mockTime.activeTimers()).toBe(0);
    });
    
    it('多重起動を防ぐ', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      
      timer.startHeartbeatInterval(callback1);
      expect(mockTime.activeTimers()).toBe(1);
      
      timer.startHeartbeatInterval(callback2); // 既存のタイマーを上書き
      
      expect(mockTime.activeTimers()).toBe(1);
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
      expect(timer.getActiveTimers()).toEqual({
        electionTimeout: true,
        heartbeatInterval: true
      });
      
      // ハートビートが先に発火
      mockTime.advance(50);
      expect(heartbeatCallback).toHaveBeenCalledTimes(1);
      expect(electionCallback).not.toHaveBeenCalled();
      
      // さらに時間を進める
      mockTime.advance(200);
      expect(heartbeatCallback).toHaveBeenCalledTimes(5); // 合計250ms / 50ms
      expect(electionCallback).toHaveBeenCalledOnce();
    });
    
    it('異なる種類のタイマーは独立して動作する', () => {
      const electionCallback = vi.fn();
      const heartbeatCallback = vi.fn();
      
      timer.startElectionTimeout(electionCallback);
      timer.startHeartbeatInterval(heartbeatCallback);
      
      // ハートビートを停止しても選挙タイムアウトは継続
      timer.stopHeartbeatInterval();
      expect(timer.getActiveTimers()).toEqual({
        electionTimeout: true,
        heartbeatInterval: false
      });
      
      mockTime.advance(350);
      expect(electionCallback).toHaveBeenCalledOnce();
      expect(heartbeatCallback).not.toHaveBeenCalled();
    });
  });
  
  describe('すべてのタイマーの管理', () => {
    it('すべてのタイマーを一度に停止できる', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      
      timer.startElectionTimeout(callback1);
      timer.startHeartbeatInterval(callback2);
      
      expect(mockTime.activeTimers()).toBe(2);
      expect(timer.getActiveTimers()).toEqual({
        electionTimeout: true,
        heartbeatInterval: true
      });
      
      timer.stopAll();
      
      expect(mockTime.activeTimers()).toBe(0);
      expect(timer.getActiveTimers()).toEqual({
        electionTimeout: false,
        heartbeatInterval: false
      });
      
      mockTime.advance(500);
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).not.toHaveBeenCalled();
    });
    
    it('アクティブなタイマーの状態を取得できる', () => {
      expect(timer.getActiveTimers()).toEqual({
        electionTimeout: false,
        heartbeatInterval: false
      });
      
      timer.startElectionTimeout(() => {});
      expect(timer.getActiveTimers()).toEqual({
        electionTimeout: true,
        heartbeatInterval: false
      });
      
      timer.startHeartbeatInterval(() => {});
      expect(timer.getActiveTimers()).toEqual({
        electionTimeout: true,
        heartbeatInterval: true
      });
    });
  });
  
  describe('エラーケース', () => {
    it('無効な設定値を検証する', () => {
      const invalidConfig1 = {
        electionTimeoutMin: -100,
        electionTimeoutMax: 300,
        heartbeatInterval: 50
      };
      
      expect(() => new RaftTimer(invalidConfig1, mockTime))
        .toThrow('エラー: タイムアウト値は正の値である必要があります');
      
      const invalidConfig2 = {
        electionTimeoutMin: 300,
        electionTimeoutMax: 150,  // min > max
        heartbeatInterval: 50
      };
      
      expect(() => new RaftTimer(invalidConfig2, mockTime))
        .toThrow('エラー: 最小タイムアウトは最大タイムアウトより小さい必要があります');
      
      const invalidConfig3 = {
        electionTimeoutMin: 150,
        electionTimeoutMax: 300,
        heartbeatInterval: -50
      };
      
      expect(() => new RaftTimer(invalidConfig3, mockTime))
        .toThrow('エラー: ハートビート間隔は正の値である必要があります');
    });
    
    it('停止していないタイマーを再度停止してもエラーにならない', () => {
      expect(() => timer.stopElectionTimeout()).not.toThrow();
      expect(() => timer.stopHeartbeatInterval()).not.toThrow();
      expect(() => timer.stopAll()).not.toThrow();
    });
    
    it('停止後にコールバックが実行されない', () => {
      const callback = vi.fn();
      timer.startElectionTimeout(callback);
      
      // 停止前に時間を進める
      mockTime.advance(100);
      timer.stopElectionTimeout();
      
      // 停止後に時間を進めてもコールバックは実行されない
      mockTime.advance(500);
      expect(callback).not.toHaveBeenCalled();
    });
  });
});
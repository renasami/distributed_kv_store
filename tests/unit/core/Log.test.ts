import { describe, it, expect, beforeEach } from 'vitest';
import { RaftLog } from '@/core/Log';
import type { LogEntry, Command, LogStats } from '@/types';

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

    it('最後のエントリはnullを返す', () => {
      expect(log.getLastEntry()).toBeNull();
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
        expect(result.value.timestamp).toBeGreaterThan(0);
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
        expect(result.error.currentTerm).toBe(2);
        expect(result.error.receivedTerm).toBe(1);
      }
    });

    it('同じTermのエントリを追加できる', () => {
      log.appendEntry(1, { type: 'SET', key: 'x', value: 1 });
      const result = log.appendEntry(1, { type: 'SET', key: 'y', value: 2 });
      
      expect(result.ok).toBe(true);
      expect(log.getLength()).toBe(2);
      expect(log.getLastTerm()).toBe(1);
    });

    it('NOOPコマンドを追加できる', () => {
      const result = log.appendEntry(1, { type: 'NOOP' });
      
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.command.type).toBe('NOOP');
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
      expect(entry?.command.type).toBe('SET');
    });
    
    it('存在しないインデックスはnullを返す', () => {
      expect(log.getEntry(0)).toBeNull();
      expect(log.getEntry(4)).toBeNull();
      expect(log.getEntry(-1)).toBeNull();
    });
    
    it('最後のエントリを取得できる', () => {
      const last = log.getLastEntry();
      expect(last).toBeDefined();
      expect(last?.index).toBe(3);
      expect(last?.term).toBe(2);
      expect(last?.command.type).toBe('DELETE');
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

    it('範囲外のインデックスからの取得は空配列を返す', () => {
      const entries = log.getEntriesFrom(5);
      expect(entries).toHaveLength(0);
    });

    it('maxCountが0の場合は空配列を返す', () => {
      const entries = log.getEntriesFrom(1, 0);
      expect(entries).toHaveLength(0);
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
      expect(log.getLastIndex()).toBe(0);
      expect(log.getLastTerm()).toBe(0);
    });
    
    it('範囲外のインデックスはエラーを返す', () => {
      const result = log.truncateFrom(5);
      
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('INDEX_OUT_OF_BOUNDS');
        expect(result.error.index).toBe(5);
      }
    });

    it('0を指定した場合はエラーを返す', () => {
      const result = log.truncateFrom(0);
      
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
      expect(log.matchesTermAt(3, 1)).toBe(false);
    });
    
    it('存在しないインデックスはfalseを返す', () => {
      expect(log.matchesTermAt(0, 1)).toBe(false);
      expect(log.matchesTermAt(4, 2)).toBe(false);
      expect(log.matchesTermAt(-1, 1)).toBe(false);
    });
  });
  
  describe('バッチ操作', () => {
    it('複数のエントリを一度に追加できる', () => {
      const entries: Omit<LogEntry, 'index'>[] = [
        { term: 1, command: { type: 'SET', key: 'x', value: 1 }, timestamp: Date.now() },
        { term: 1, command: { type: 'SET', key: 'y', value: 2 }, timestamp: Date.now() },
        { term: 2, command: { type: 'DELETE', key: 'x' }, timestamp: Date.now() }
      ];
      
      const result = log.appendEntries(entries);
      
      expect(result.ok).toBe(true);
      expect(log.getLength()).toBe(3);
      expect(log.getLastIndex()).toBe(3);
      expect(log.getLastTerm()).toBe(2);
    });

    it('空の配列を追加できる', () => {
      const result = log.appendEntries([]);
      
      expect(result.ok).toBe(true);
      expect(log.getLength()).toBe(0);
    });

    it('無効なTermを含む場合はエラーを返す', () => {
      log.appendEntry(2, { type: 'SET', key: 'x', value: 1 });
      
      const entries: Omit<LogEntry, 'index'>[] = [
        { term: 1, command: { type: 'SET', key: 'y', value: 2 }, timestamp: Date.now() }
      ];
      
      const result = log.appendEntries(entries);
      
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('INVALID_TERM');
      }
    });
    
    it('競合するエントリがある場合は削除してから追加する', () => {
      log.appendEntry(1, { type: 'SET', key: 'x', value: 1 });
      log.appendEntry(1, { type: 'SET', key: 'y', value: 2 });
      log.appendEntry(1, { type: 'SET', key: 'z', value: 3 });
      
      const newEntries: Omit<LogEntry, 'index'>[] = [
        { term: 2, command: { type: 'DELETE', key: 'y' }, timestamp: Date.now() },
        { term: 2, command: { type: 'SET', key: 'w', value: 4 }, timestamp: Date.now() }
      ];
      
      const result = log.replaceEntriesFrom(2, newEntries);
      
      expect(result.ok).toBe(true);
      expect(log.getLength()).toBe(3);
      expect(log.getEntry(1)?.command.key).toBe('x'); // 最初のエントリは保持
      expect(log.getEntry(2)?.term).toBe(2);
      expect(log.getEntry(2)?.command.type).toBe('DELETE');
      expect(log.getEntry(3)?.command.type).toBe('SET');
      if (log.getEntry(3)?.command.type === 'SET') {
        expect(log.getEntry(3)?.command.key).toBe('w');
      }
    });

    it('存在しないインデックスからの置換はエラーを返す', () => {
      const newEntries: Omit<LogEntry, 'index'>[] = [
        { term: 1, command: { type: 'SET', key: 'x', value: 1 }, timestamp: Date.now() }
      ];
      
      const result = log.replaceEntriesFrom(5, newEntries);
      
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('INDEX_OUT_OF_BOUNDS');
      }
    });
  });
  
  describe('メタデータ', () => {
    it('空のログの統計情報を取得できる', () => {
      const stats = log.getStats();
      
      expect(stats.totalEntries).toBe(0);
      expect(stats.lastIndex).toBe(0);
      expect(stats.lastTerm).toBe(0);
      expect(stats.terms).toEqual([]);
    });

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

  describe('エラーケース', () => {
    it('空のログから最後のエントリを取得するとnullを返す', () => {
      expect(log.getLastEntry()).toBeNull();
    });

    it('負のインデックスでエントリを取得するとnullを返す', () => {
      expect(log.getEntry(-1)).toBeNull();
    });

    it('負のインデックスからエントリ範囲を取得すると空配列を返す', () => {
      log.appendEntry(1, { type: 'SET', key: 'x', value: 1 });
      const entries = log.getEntriesFrom(-1);
      expect(entries).toHaveLength(0);
    });

    it('負のインデックスから切り詰めるとエラーを返す', () => {
      const result = log.truncateFrom(-1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('INDEX_OUT_OF_BOUNDS');
      }
    });
  });
});
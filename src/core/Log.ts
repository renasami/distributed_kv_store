import type { LogEntry, LogIndex, Term, Command, Result, LogError, LogStats } from '@/types';

/**
 * Raftログを管理するクラス
 * ログエントリの追加、取得、切り詰めを担当
 */
export class RaftLog {
  private entries: LogEntry[] = [];
  private baseIndex: LogIndex = 0;  // スナップショット後の基準インデックス
  private commitIndex: LogIndex = 0; // コミット済みインデックス
  
  constructor() {
    console.log('情報: ログを初期化しました');
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
    if (this.isEmpty()) {
      return this.baseIndex;
    }
    const lastEntry = this.entries[this.entries.length - 1];
    return lastEntry?.index ?? this.baseIndex;
  }
  
  /**
   * 最後のTermを取得（空の場合は0）
   */
  getLastTerm(): Term {
    if (this.isEmpty()) {
      return 0;
    }
    const lastEntry = this.entries[this.entries.length - 1];
    return lastEntry?.term ?? 0;
  }

  /**
   * 最後のエントリを取得（空の場合はnull）
   */
  getLastEntry(): LogEntry | null {
    if (this.isEmpty()) {
      return null;
    }
    return this.entries[this.entries.length - 1] ?? null;
  }
  
  /**
   * 新しいエントリを追加
   * @param term エントリのterm
   * @param command 実行するコマンド
   * @returns 追加されたエントリまたはエラー
   */
  appendEntry(term: Term, command: Command): Result<LogEntry, LogError> {
    const currentLastTerm = this.getLastTerm();
    
    // Termの妥当性を確認
    if (term < currentLastTerm) {
      console.log(`エラー: 無効なTerm (現在: ${currentLastTerm}, 受信: ${term})`);
      return {
        ok: false,
        error: {
          type: 'INVALID_TERM',
          currentTerm: currentLastTerm,
          receivedTerm: term
        }
      };
    }
    
    // 新しいエントリを作成
    const newIndex = this.getLastIndex() + 1;
    const entry: LogEntry = {
      term,
      index: newIndex,
      command,
      timestamp: Date.now()
    };
    
    this.entries.push(entry);
    console.log(`情報: エントリを追加しました (インデックス: ${newIndex}, Term: ${term})`);
    
    return { ok: true, value: entry };
  }
  
  /**
   * 指定インデックスのエントリを取得
   * @param index 取得するインデックス
   * @returns エントリまたはnull
   */
  getEntry(index: LogIndex): LogEntry | null {
    if (index <= this.baseIndex || index < 1) {
      return null;
    }
    
    const arrayIndex = index - this.baseIndex - 1;
    if (arrayIndex >= this.entries.length) {
      return null;
    }
    
    return this.entries[arrayIndex] ?? null;
  }

  /**
   * 指定インデックス以降のエントリを取得
   * @param startIndex 開始インデックス
   * @param maxCount 最大取得数（オプション）
   * @returns エントリ配列
   */
  getEntriesFrom(startIndex: LogIndex, maxCount?: number): LogEntry[] {
    if (startIndex < 1 || maxCount === 0) {
      return [];
    }
    
    const startArrayIndex = startIndex - this.baseIndex - 1;
    if (startArrayIndex >= this.entries.length) {
      return [];
    }
    
    const actualStart = Math.max(0, startArrayIndex);
    const endArrayIndex = maxCount !== undefined 
      ? Math.min(this.entries.length, actualStart + maxCount)
      : this.entries.length;
    
    return this.entries.slice(actualStart, endArrayIndex);
  }
  
  /**
   * 指定インデックス以降を削除
   * @param index 削除開始インデックス
   * @returns 成功またはエラー
   */
  truncateFrom(index: LogIndex): Result<void, LogError> {
    if (index <= this.baseIndex || index < 1) {
      return {
        ok: false,
        error: { type: 'INDEX_OUT_OF_BOUNDS', index }
      };
    }
    
    // インデックスが現在のログ範囲を超えている場合はエラー
    // 削除可能なインデックスは 1 ～ lastIndex まで（存在するエントリのみ）
    const lastIndex = this.getLastIndex();
    if (lastIndex > 0 && index > lastIndex) {
      return {
        ok: false,
        error: { type: 'INDEX_OUT_OF_BOUNDS', index }
      };
    }
    
    const arrayIndex = index - this.baseIndex - 1;
    const removedCount = this.entries.length - arrayIndex;
    this.entries = this.entries.slice(0, arrayIndex);
    
    console.log(`情報: インデックス${index}以降の${removedCount}個のエントリを削除しました`);
    return { ok: true, value: undefined };
  }
  
  /**
   * 指定位置のTermが一致するか確認
   * @param index チェックするインデックス
   * @param term 期待されるterm
   * @returns 一致する場合true
   */
  matchesTermAt(index: LogIndex, term: Term): boolean {
    const entry = this.getEntry(index);
    return entry?.term === term;
  }

  /**
   * 複数のエントリを一度に追加
   * @param entries 追加するエントリ配列（indexは自動設定）
   * @returns 成功またはエラー
   */
  appendEntries(entries: Omit<LogEntry, 'index'>[]): Result<LogEntry[], LogError> {
    if (entries.length === 0) {
      return { ok: true, value: [] };
    }
    
    const addedEntries: LogEntry[] = [];
    let currentIndex = this.getLastIndex();
    
    for (const entryData of entries) {
      const currentLastTerm = this.getLastTerm();
      
      // Termの妥当性を確認
      if (entryData.term < currentLastTerm) {
        console.log(`エラー: バッチ追加で無効なTerm (現在: ${currentLastTerm}, 受信: ${entryData.term})`);
        return {
          ok: false,
          error: {
            type: 'INVALID_TERM',
            currentTerm: currentLastTerm,
            receivedTerm: entryData.term
          }
        };
      }
      
      currentIndex++;
      const entry: LogEntry = {
        ...entryData,
        index: currentIndex
      };
      
      this.entries.push(entry);
      addedEntries.push(entry);
    }
    
    console.log(`情報: ${addedEntries.length}個のエントリを一括追加しました`);
    return { ok: true, value: addedEntries };
  }

  /**
   * 指定位置からエントリを置換
   * @param startIndex 置換開始インデックス
   * @param newEntries 新しいエントリ配列
   * @returns 成功またはエラー
   */
  replaceEntriesFrom(startIndex: LogIndex, newEntries: Omit<LogEntry, 'index'>[]): Result<LogEntry[], LogError> {
    if (startIndex <= this.baseIndex || startIndex < 1) {
      return {
        ok: false,
        error: { type: 'INDEX_OUT_OF_BOUNDS', index: startIndex }
      };
    }
    
    // インデックスが現在のログ範囲を超えている場合はエラー
    const lastIndex = this.getLastIndex();
    if (startIndex > lastIndex + 1) {
      return {
        ok: false,
        error: { type: 'INDEX_OUT_OF_BOUNDS', index: startIndex }
      };
    }
    
    // 指定インデックス以降を削除
    const truncateResult = this.truncateFrom(startIndex);
    if (!truncateResult.ok) {
      return truncateResult;
    }
    
    // 新しいエントリを追加
    return this.appendEntries(newEntries);
  }

  /**
   * コミットインデックスの取得
   */
  getCommitIndex(): LogIndex {
    return this.commitIndex;
  }

  /**
   * エントリをコミットする
   */
  commit(index: LogIndex): void {
    if (index > this.getLastIndex()) {
      throw new Error(`エラー: コミットインデックス(${index})が最新インデックス(${this.getLastIndex()})を超えています`);
    }
    if (index > this.commitIndex) {
      this.commitIndex = index;
      console.log(`情報: コミットインデックスを${index}に更新しました`);
    }
  }

  /**
   * ログの統計情報を取得
   * @returns 統計情報
   */
  getStats(): LogStats {
    return {
      totalEntries: this.entries.length,
      lastIndex: this.getLastIndex(),
      lastTerm: this.getLastTerm(),
      terms: this.entries.map(entry => entry.term)
    };
  }

  /**
   * デバッグ用の文字列表現
   */
  toString(): string {
    return `RaftLog{entries: ${this.entries.length}, lastIndex: ${this.getLastIndex()}, lastTerm: ${this.getLastTerm()}}`;
  }
}
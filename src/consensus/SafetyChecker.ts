import type { NodeId, Term, LogIndex, LogEntry } from '@/types';

/**
 * 適用済みコマンドの記録
 */
export interface AppliedCommand {
  index: LogIndex;
  command: any;
  timestamp: number;
}

/**
 * ノード状態の記録
 */
export interface NodeStateInfo {
  term: Term;
  isLeader: boolean;
  commitIndex: LogIndex;
  lastApplied: LogIndex;
}

/**
 * 安全性違反の記録
 */
export interface SafetyViolation {
  type: 'ELECTION_SAFETY' | 'LOG_MATCHING' | 'LEADER_COMPLETENESS' | 'STATE_MACHINE_SAFETY';
  message: string;
  timestamp: number;
  details: any;
}

/**
 * Raftの安全性プロパティを検証するクラス
 * 4つの基本安全性プロパティと不変条件をチェックする
 */
export class SafetyChecker {
  private readonly debug: boolean;
  private violations: SafetyViolation[] = [];
  private metrics = {
    electionSafety: 0,
    logMatching: 0,
    leaderCompleteness: 0,
    stateMachineSafety: 0
  };
  
  constructor(debug = false) {
    this.debug = debug;
  }
  
  /**
   * Election Safety: 1つのtermに最大1人のリーダー
   * 同一termで複数のリーダーが存在しないことを確認
   */
  verifyElectionSafety(
    term: Term,
    clusterStates: Map<NodeId, NodeStateInfo>
  ): boolean {
    const leaders = Array.from(clusterStates.entries())
      .filter(([_, state]) => state.term === term && state.isLeader)
      .map(([nodeId, _]) => nodeId);
    
    if (leaders.length > 1) {
      const violation = {
        type: 'ELECTION_SAFETY' as const,
        message: `Term ${term}に複数のリーダーが存在: ${leaders.join(', ')}`,
        timestamp: Date.now(),
        details: { term, leaders }
      };
      
      this.recordViolation(violation);
      return false;
    }
    
    return true;
  }
  
  /**
   * Log Matching Property: 同じindex/termのエントリは同じコマンド
   * 異なるノード間でログの一貫性を確認
   */
  verifyLogMatching(logs: Map<NodeId, LogEntry[]>): boolean {
    const nodes = Array.from(logs.keys());
    
    for (let i = 0; i < nodes.length - 1; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const log1 = logs.get(nodes[i]) || [];
        const log2 = logs.get(nodes[j]) || [];
        
        if (!this.logsMatch(log1, log2, nodes[i], nodes[j])) {
          return false;
        }
      }
    }
    
    return true;
  }
  
  /**
   * 2つのログが Log Matching Property を満たすかチェック
   */
  private logsMatch(
    log1: LogEntry[],
    log2: LogEntry[],
    nodeId1: NodeId,
    nodeId2: NodeId
  ): boolean {
    const minLength = Math.min(log1.length, log2.length);
    
    for (let idx = 0; idx < minLength; idx++) {
      const entry1 = log1[idx];
      const entry2 = log2[idx];
      
      // 同じインデックス位置のエントリを比較
      if (entry1.index === entry2.index) {
        // 同じインデックスで異なるterm → ログ不一致
        if (entry1.term !== entry2.term) {
          const violation = {
            type: 'LOG_MATCHING' as const,
            message: `${nodeId1}と${nodeId2}のindex ${entry1.index}で異なるterm: ${entry1.term} vs ${entry2.term}`,
            timestamp: Date.now(),
            details: { nodeId1, nodeId2, index: entry1.index, term1: entry1.term, term2: entry2.term }
          };
          
          this.recordViolation(violation);
          return false;
        }
        
        // 同じindex/termで異なるコマンド → ログ不一致
        if (entry1.term === entry2.term &&
            JSON.stringify(entry1.command) !== JSON.stringify(entry2.command)) {
          const violation = {
            type: 'LOG_MATCHING' as const,
            message: `${nodeId1}と${nodeId2}のindex ${entry1.index}, term ${entry1.term}で異なるコマンド`,
            timestamp: Date.now(),
            details: { 
              nodeId1, nodeId2, 
              index: entry1.index, 
              term: entry1.term,
              command1: entry1.command, 
              command2: entry2.command 
            }
          };
          
          this.recordViolation(violation);
          return false;
        }
      }
    }
    
    return true;
  }
  
  /**
   * Leader Completeness: コミット済みエントリは将来のリーダーに存在
   * 新しいリーダーが過去のコミット済みエントリを全て持っていることを確認
   */
  verifyLeaderCompleteness(
    committedEntries: LogEntry[],
    newLeaderLog: LogEntry[],
    newLeaderTerm: Term,
    newLeaderId?: NodeId
  ): boolean {
    for (const committed of committedEntries) {
      const found = newLeaderLog.find(
        entry => entry.index === committed.index && 
                 entry.term === committed.term &&
                 JSON.stringify(entry.command) === JSON.stringify(committed.command)
      );
      
      if (!found) {
        const violation = {
          type: 'LEADER_COMPLETENESS' as const,
          message: `新リーダー${newLeaderId ? `(${newLeaderId})` : ''}(Term ${newLeaderTerm})にコミット済みエントリ(index ${committed.index}, term ${committed.term})が存在しない`,
          timestamp: Date.now(),
          details: { 
            newLeaderId, 
            newLeaderTerm,
            missingEntry: committed,
            leaderLogLength: newLeaderLog.length
          }
        };
        
        this.recordViolation(violation);
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * State Machine Safety: 同じ順序で同じコマンドを適用
   * 全ノードが同じインデックスで同じコマンドを適用していることを確認
   */
  verifyStateMachineSafety(
    appliedCommands: Map<NodeId, AppliedCommand[]>
  ): boolean {
    const nodes = Array.from(appliedCommands.keys());
    if (nodes.length < 2) return true;
    
    const reference = appliedCommands.get(nodes[0]) || [];
    
    for (let i = 1; i < nodes.length; i++) {
      const nodeCommands = appliedCommands.get(nodes[i]) || [];
      
      if (!this.appliedCommandsMatch(reference, nodeCommands, nodes[0], nodes[i])) {
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * 2つのノードの適用済みコマンド列が一致するかチェック
   */
  private appliedCommandsMatch(
    commands1: AppliedCommand[],
    commands2: AppliedCommand[],
    nodeId1: NodeId,
    nodeId2: NodeId
  ): boolean {
    const minLength = Math.min(commands1.length, commands2.length);
    
    for (let i = 0; i < minLength; i++) {
      const cmd1 = commands1[i];
      const cmd2 = commands2[i];
      
      // 同じインデックスで異なるコマンド → State Machine Safety違反
      if (cmd1.index === cmd2.index &&
          JSON.stringify(cmd1.command) !== JSON.stringify(cmd2.command)) {
        const violation = {
          type: 'STATE_MACHINE_SAFETY' as const,
          message: `${nodeId1}と${nodeId2}がindex ${cmd1.index}で異なるコマンドを適用`,
          timestamp: Date.now(),
          details: { 
            nodeId1, nodeId2,
            index: cmd1.index,
            command1: cmd1.command, 
            command2: cmd2.command 
          }
        };
        
        this.recordViolation(violation);
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * 状態遷移の妥当性を検証（不変条件のチェック）
   */
  verifyStateTransition(
    before: { term: Term; commitIndex: LogIndex; lastApplied: LogIndex },
    after: { term: Term; commitIndex: LogIndex; lastApplied: LogIndex },
    nodeId?: NodeId
  ): boolean {
    // Termは単調増加
    if (after.term < before.term) {
      this.logViolation(
        `状態遷移違反${nodeId ? `(${nodeId})` : ''}: Termが減少 ${before.term} -> ${after.term}`
      );
      return false;
    }
    
    // CommitIndexは単調増加
    if (after.commitIndex < before.commitIndex) {
      this.logViolation(
        `状態遷移違反${nodeId ? `(${nodeId})` : ''}: CommitIndexが減少 ${before.commitIndex} -> ${after.commitIndex}`
      );
      return false;
    }
    
    // LastApplied <= CommitIndex
    if (after.lastApplied > after.commitIndex) {
      this.logViolation(
        `状態遷移違反${nodeId ? `(${nodeId})` : ''}: LastApplied(${after.lastApplied}) > CommitIndex(${after.commitIndex})`
      );
      return false;
    }
    
    return true;
  }
  
  /**
   * ログの整合性を検証（構造的不変条件）
   */
  verifyLogIntegrity(log: LogEntry[], nodeId?: NodeId): boolean {
    if (log.length === 0) return true;
    
    // インデックスは1から開始
    if (log[0].index !== 1) {
      this.logViolation(
        `ログ整合性違反${nodeId ? `(${nodeId})` : ''}: 最初のインデックスが1でない: ${log[0].index}`
      );
      return false;
    }
    
    for (let i = 1; i < log.length; i++) {
      const prev = log[i-1];
      const curr = log[i];
      
      // インデックスは連続
      if (curr.index !== prev.index + 1) {
        this.logViolation(
          `ログ整合性違反${nodeId ? `(${nodeId})` : ''}: インデックスが不連続 ${prev.index} -> ${curr.index}`
        );
        return false;
      }
      
      // Termは単調非減少
      if (curr.term < prev.term) {
        this.logViolation(
          `ログ整合性違反${nodeId ? `(${nodeId})` : ''}: Termが減少 index ${curr.index} (${prev.term} -> ${curr.term})`
        );
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Figure 8問題のチェック
   * 古いtermのエントリが現在termで間接的にコミットされることを防ぐ
   */
  checkFigure8Problem(
    commitIndex: LogIndex,
    log: LogEntry[],
    currentTerm: Term,
    nodeId?: NodeId
  ): boolean {
    if (commitIndex === 0 || log.length === 0) return true;
    
    // commitIndexが範囲内かチェック
    if (commitIndex > log.length) {
      this.logViolation(
        `Figure 8チェック${nodeId ? `(${nodeId})` : ''}: commitIndex(${commitIndex})がログ長(${log.length})を超過`
      );
      return false;
    }
    
    const entry = log[commitIndex - 1]; // 配列は0ベースなので-1
    if (!entry) {
      this.logViolation(
        `Figure 8チェック${nodeId ? `(${nodeId})` : ''}: commitIndex ${commitIndex}のエントリが存在しない`
      );
      return false;
    }
    
    // 現在termのエントリのみコミット可能
    if (entry.term !== currentTerm) {
      this.logViolation(
        `Figure 8問題${nodeId ? `(${nodeId})` : ''}: 古いterm(${entry.term})のエントリをterm ${currentTerm}でコミットしようとした`
      );
      return false;
    }
    
    return true;
  }
  
  /**
   * 選挙の妥当性をチェック
   */
  verifyElectionInvariant(
    term: Term,
    votes: Map<NodeId, boolean>,
    expectedWinner?: NodeId
  ): boolean {
    const totalNodes = votes.size;
    const yesVotes = Array.from(votes.values()).filter(vote => vote).length;
    const noVotes = totalNodes - yesVotes;
    const majority = Math.floor(totalNodes / 2) + 1;
    
    if (this.debug) {
      console.log(`選挙結果 Term ${term}: ${yesVotes}/${totalNodes} (過半数: ${majority})`);
    }
    
    // 投票数の整合性
    if (yesVotes + noVotes !== totalNodes) {
      this.logViolation(
        `選挙不変条件違反: 投票数が不一致 (賛成: ${yesVotes}, 反対: ${noVotes}, 総数: ${totalNodes})`
      );
      return false;
    }
    
    // 過半数を獲得した場合の確認
    if (yesVotes >= majority && expectedWinner) {
      if (this.debug) {
        console.log(`Term ${term}で${expectedWinner}が過半数(${yesVotes}/${totalNodes})を獲得してリーダーに選出`);
      }
      return true;
    }
    
    // 過半数に届かなかった場合
    if (yesVotes < majority) {
      if (this.debug) {
        console.log(`Term ${term}で過半数に届かず選挙失敗 (${yesVotes}/${totalNodes})`);
      }
      return true;
    }
    
    return true;
  }
  
  /**
   * クラスタ全体の一貫性チェック
   */
  verifyClusterConsistency(
    nodeStates: Map<NodeId, NodeStateInfo>,
    nodeLogs: Map<NodeId, LogEntry[]>,
    appliedCommands: Map<NodeId, AppliedCommand[]>
  ): boolean {
    let allSafe = true;
    
    // 各termでElection Safetyをチェック
    const terms = new Set(Array.from(nodeStates.values()).map(s => s.term));
    for (const term of terms) {
      if (!this.verifyElectionSafety(term, nodeStates)) {
        allSafe = false;
      }
    }
    
    // Log Matchingをチェック
    if (!this.verifyLogMatching(nodeLogs)) {
      allSafe = false;
    }
    
    // State Machine Safetyをチェック
    if (!this.verifyStateMachineSafety(appliedCommands)) {
      allSafe = false;
    }
    
    // 各ノードのログ整合性をチェック
    for (const [nodeId, log] of nodeLogs) {
      if (!this.verifyLogIntegrity(log, nodeId)) {
        allSafe = false;
      }
    }
    
    return allSafe;
  }
  
  /**
   * 違反を記録
   */
  private recordViolation(violation: SafetyViolation): void {
    this.violations.push(violation);
    this.metrics[violation.type.toLowerCase() as keyof typeof this.metrics]++;
    
    if (this.debug) {
      console.error(`[安全性違反] ${violation.message}`);
      console.error(`[詳細] ${JSON.stringify(violation.details, null, 2)}`);
    }
  }
  
  /**
   * 違反をログ出力
   */
  private logViolation(message: string): void {
    if (this.debug) {
      console.error(`[安全性違反] ${message}`);
    }
    
    // 詳細な違反として記録
    this.violations.push({
      type: 'STATE_MACHINE_SAFETY', // デフォルト分類
      message,
      timestamp: Date.now(),
      details: {}
    });
  }
  
  /**
   * 違反履歴の取得
   */
  getViolations(): SafetyViolation[] {
    return [...this.violations];
  }
  
  /**
   * メトリクス取得
   */
  getMetrics(): typeof this.metrics & { totalViolations: number } {
    return {
      ...this.metrics,
      totalViolations: Object.values(this.metrics).reduce((a, b) => a + b, 0)
    };
  }
  
  /**
   * 違反履歴をクリア
   */
  clearViolations(): void {
    this.violations = [];
    this.metrics = {
      electionSafety: 0,
      logMatching: 0,
      leaderCompleteness: 0,
      stateMachineSafety: 0
    };
  }
  
  /**
   * デバッグレポートの生成
   */
  generateReport(): string {
    const report = [];
    report.push('=== Raft安全性チェック レポート ===');
    report.push(`生成時刻: ${new Date().toISOString()}`);
    report.push('');
    
    const metrics = this.getMetrics();
    report.push('=== 違反統計 ===');
    report.push(`Election Safety: ${metrics.electionSafety}`);
    report.push(`Log Matching: ${metrics.logMatching}`);
    report.push(`Leader Completeness: ${metrics.leaderCompleteness}`);
    report.push(`State Machine Safety: ${metrics.stateMachineSafety}`);
    report.push(`総違反数: ${metrics.totalViolations}`);
    report.push('');
    
    if (this.violations.length > 0) {
      report.push('=== 違反詳細 ===');
      for (const violation of this.violations) {
        report.push(`[${violation.type}] ${violation.message}`);
        report.push(`  時刻: ${new Date(violation.timestamp).toISOString()}`);
        if (Object.keys(violation.details).length > 0) {
          report.push(`  詳細: ${JSON.stringify(violation.details)}`);
        }
        report.push('');
      }
    } else {
      report.push('=== 安全性OK ===');
      report.push('違反は検出されませんでした。');
    }
    
    return report.join('\n');
  }
}
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RaftNode } from '@/core/RaftNode';
import { SafetyChecker, type AppliedCommand, type NodeStateInfo } from '@/consensus/SafetyChecker';
import { MockTimeProvider } from '../utils/MockTimeProvider';
import type { NodeId, LogEntry, Command } from '@/types';

/**
 * テスト用のRaftクラスタを管理するクラス
 */
class TestCluster {
  public nodes: RaftNode[] = [];
  private mockTime: MockTimeProvider;
  private safety: SafetyChecker;
  private rpcNetwork: MockRPCNetwork;
  private partitions: Set<NodeId> = new Set();

  constructor(nodeCount: number = 3) {
    this.mockTime = new MockTimeProvider();
    this.safety = new SafetyChecker(true);
    this.rpcNetwork = new MockRPCNetwork();
    this.createNodes(nodeCount);
  }

  /**
   * ノードを作成
   */
  private createNodes(nodeCount: number): void {
    const nodeIds = Array.from({ length: nodeCount }, (_, i) => `node${i + 1}`);
    
    for (let i = 0; i < nodeCount; i++) {
      const nodeId = nodeIds[i];
      const peers = nodeIds.filter(id => id !== nodeId);
      
      const node = new RaftNode(nodeId, peers, {
        electionTimeoutMin: 150,
        electionTimeoutMax: 300,
        heartbeatInterval: 50,
        enableSafetyChecks: true,
        timeProvider: this.mockTime
      });
      
      this.nodes.push(node);
    }
    
    // RPCネットワークを設定
    this.setupRPCNetwork();
  }

  /**
   * RPCネットワークを設定
   */
  private setupRPCNetwork(): void {
    for (const node of this.nodes) {
      const rpcClient = this.rpcNetwork.createClient(node.getNodeId(), this.nodes, this.partitions);
      node.setRPCClient(rpcClient);
    }
  }

  /**
   * クラスタを起動
   */
  async start(): Promise<void> {
    console.log(`テストクラスタを起動: ${this.nodes.length}ノード`);
    await Promise.all(this.nodes.map(node => node.start()));
  }

  /**
   * クラスタを停止
   */
  async shutdown(): Promise<void> {
    await Promise.all(this.nodes.map(node => node.stop()));
  }

  /**
   * 指定したノードを停止
   */
  async stopNode(nodeId: NodeId): Promise<void> {
    const node = this.nodes.find(n => n.getNodeId() === nodeId);
    if (node) {
      await node.stop();
    }
  }

  /**
   * 指定したノードを起動
   */
  async startNode(nodeId: NodeId): Promise<void> {
    const node = this.nodes.find(n => n.getNodeId() === nodeId);
    if (node && !node.isNodeRunning()) {
      await node.start();
    }
  }

  /**
   * リーダーが選出されるまで待つ
   */
  async waitForLeader(timeout = 5000): Promise<RaftNode> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      const leaders = this.getLeaders();
      if (leaders.length === 1) {
        return leaders[0];
      }
      
      // 選挙を進めるために時間を進める
      this.mockTime.advance(50);
      await this.sleep(10);
    }
    
    throw new Error(`リーダー選出がタイムアウト (${timeout}ms)`);
  }

  /**
   * 新しいリーダーが選出されるまで待つ
   */
  async waitForNewLeader(excludeNodeId: NodeId, timeout = 5000): Promise<RaftNode> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      const leaders = this.getLeaders().filter(n => n.getNodeId() !== excludeNodeId);
      if (leaders.length === 1) {
        return leaders[0];
      }
      
      this.mockTime.advance(50);
      await this.sleep(10);
    }
    
    throw new Error(`新リーダー選出がタイムアウト (除外: ${excludeNodeId})`);
  }

  /**
   * エントリがレプリケーションされるまで待つ
   */
  async waitForReplication(logIndex: number, timeout = 3000): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      const runningNodes = this.nodes.filter(n => n.isNodeRunning() && !this.partitions.has(n.getNodeId()));
      const replicatedCount = runningNodes.filter(n => {
        const log = n.getAllLogEntries();
        return log.length >= logIndex;
      }).length;
      
      const majority = Math.floor(runningNodes.length / 2) + 1;
      if (replicatedCount >= majority) {
        return;
      }
      
      this.mockTime.advance(10);
      await this.sleep(5);
    }
    
    throw new Error(`レプリケーション待機がタイムアウト (index: ${logIndex})`);
  }

  /**
   * エントリが適用されるまで待つ
   */
  async waitForApplied(logIndex: number, timeout = 3000): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      const runningNodes = this.nodes.filter(n => n.isNodeRunning() && !this.partitions.has(n.getNodeId()));
      const appliedCount = runningNodes.filter(n => {
        const status = n.getStatus();
        return status.lastApplied >= logIndex;
      }).length;
      
      const majority = Math.floor(runningNodes.length / 2) + 1;
      if (appliedCount >= majority) {
        return;
      }
      
      this.mockTime.advance(10);
      await this.sleep(5);
    }
    
    throw new Error(`適用待機がタイムアウト (index: ${logIndex})`);
  }

  /**
   * クラスタの同期を待つ
   */
  async waitForSync(timeout = 5000): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      if (this.isClusterSynced()) {
        return;
      }
      
      this.mockTime.advance(50);
      await this.sleep(10);
    }
    
    throw new Error('クラスタ同期がタイムアウト');
  }

  /**
   * ノードを分断
   */
  async partitionNode(nodeId: NodeId): Promise<void> {
    console.log(`ノード${nodeId}を分断`);
    this.partitions.add(nodeId);
    
    // 分断されたノードを一旦停止してから再起動
    const node = this.nodes.find(n => n.getNodeId() === nodeId);
    if (node) {
      await node.stop();
      await node.start();
    }
  }

  /**
   * 分断を回復
   */
  async healPartition(nodeId: NodeId): Promise<void> {
    console.log(`ノード${nodeId}の分断を回復`);
    this.partitions.delete(nodeId);
  }

  /**
   * ランダムなノードを取得
   */
  getRandomNode(): RaftNode {
    const runningNodes = this.nodes.filter(n => n.isNodeRunning());
    const randomIndex = Math.floor(Math.random() * runningNodes.length);
    return runningNodes[randomIndex];
  }

  /**
   * 現在のリーダー一覧を取得
   */
  getLeaders(): RaftNode[] {
    return this.nodes.filter(n => 
      n.isNodeRunning() && 
      !this.partitions.has(n.getNodeId()) &&
      n.getState().type === 'leader'
    );
  }

  /**
   * 全ノードの状態を取得
   */
  getAllNodeStates(): Map<NodeId, NodeStateInfo> {
    const states = new Map<NodeId, NodeStateInfo>();
    
    for (const node of this.nodes) {
      if (node.isNodeRunning()) {
        states.set(node.getNodeId(), node.getNodeStateInfo());
      }
    }
    
    return states;
  }

  /**
   * 全ノードのログを取得
   */
  getAllLogs(): Map<NodeId, LogEntry[]> {
    const logs = new Map<NodeId, LogEntry[]>();
    
    for (const node of this.nodes) {
      if (node.isNodeRunning()) {
        logs.set(node.getNodeId(), node.getAllLogEntries());
      }
    }
    
    return logs;
  }

  /**
   * 全ノードの適用済みコマンドを取得
   */
  getAllAppliedCommands(): Map<NodeId, AppliedCommand[]> {
    const commands = new Map<NodeId, AppliedCommand[]>();
    
    for (const node of this.nodes) {
      if (node.isNodeRunning()) {
        commands.set(node.getNodeId(), node.getAppliedCommands());
      }
    }
    
    return commands;
  }

  /**
   * 全ノードのステートマシンを取得
   */
  getAllStateMachines(): Map<string, unknown>[] {
    return this.nodes
      .filter(n => n.isNodeRunning())
      .map(n => n.getStateMachine());
  }

  /**
   * 指定したキーの値を全ノードから取得
   */
  getAllNodeValues(key: string): unknown[] {
    return this.nodes
      .filter(n => n.isNodeRunning())
      .map(n => n.getStateMachine().get(key));
  }

  /**
   * コミット済みエントリを取得
   */
  getCommittedEntries(): LogEntry[] {
    const leader = this.getLeaders()[0];
    if (!leader) return [];
    
    const commitIndex = leader.getStatus().commitIndex;
    const log = leader.getAllLogEntries();
    
    return log.slice(0, commitIndex);
  }

  /**
   * クラスタが同期されているかチェック
   */
  private isClusterSynced(): boolean {
    const runningNodes = this.nodes.filter(n => 
      n.isNodeRunning() && !this.partitions.has(n.getNodeId())
    );
    
    if (runningNodes.length === 0) return true;
    
    // 全ノードが同じcommitIndexを持っているかチェック
    const commitIndices = runningNodes.map(n => n.getStatus().commitIndex);
    const referenceCommitIndex = commitIndices[0];
    
    return commitIndices.every(index => index === referenceCommitIndex);
  }

  /**
   * 安全性チェッカーを取得
   */
  getSafetyChecker(): SafetyChecker {
    return this.safety;
  }

  /**
   * ネットワーク遅延を追加
   */
  addNetworkDelay(delayMs: number): void {
    this.rpcNetwork.setDelay(delayMs);
  }

  /**
   * ネットワーク遅延を削除
   */
  removeNetworkDelay(): void {
    this.rpcNetwork.setDelay(0);
  }

  /**
   * sleep関数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * モックRPCネットワーク
 */
class MockRPCNetwork {
  private delayMs = 0;

  setDelay(delayMs: number): void {
    this.delayMs = delayMs;
  }

  createClient(sourceNodeId: NodeId, allNodes: RaftNode[], partitions: Set<NodeId>): any {
    return {
      sendRequestVote: async (targetNodeId: NodeId, request: any) => {
        // 分断チェック
        if (partitions.has(sourceNodeId) || partitions.has(targetNodeId)) {
          throw new Error('ネットワーク分断によりアクセスできません');
        }

        // 遅延シミュレーション
        if (this.delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, this.delayMs));
        }

        const targetNode = allNodes.find(n => n.getNodeId() === targetNodeId);
        if (!targetNode || !targetNode.isNodeRunning()) {
          throw new Error('ターゲットノードが利用できません');
        }

        return targetNode.handleRequestVote(request);
      },

      sendAppendEntries: async (targetNodeId: NodeId, request: any) => {
        // 分断チェック
        if (partitions.has(sourceNodeId) || partitions.has(targetNodeId)) {
          throw new Error('ネットワーク分断によりアクセスできません');
        }

        // 遅延シミュレーション
        if (this.delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, this.delayMs));
        }

        const targetNode = allNodes.find(n => n.getNodeId() === targetNodeId);
        if (!targetNode || !targetNode.isNodeRunning()) {
          throw new Error('ターゲットノードが利用できません');
        }

        return targetNode.handleAppendEntries(request);
      }
    };
  }
}

// ====== テストケース ======

describe('Raftクラスタ統合テスト', () => {
  let cluster: TestCluster;

  beforeEach(() => {
    cluster = new TestCluster(3); // 3ノードクラスタ
  });

  afterEach(async () => {
    await cluster.shutdown();
  });

  describe('リーダー選出', () => {
    it('クラスタ起動後にリーダーが選出される', async () => {
      await cluster.start();

      // リーダー選出を待つ
      const leader = await cluster.waitForLeader(5000);

      const leaders = cluster.getLeaders();
      expect(leaders).toHaveLength(1);
      expect(leaders[0].getNodeId()).toBe(leader.getNodeId());

      // Election Safetyを検証
      const term = leader.getState().term;
      const states = cluster.getAllNodeStates();
      const safety = cluster.getSafetyChecker();
      expect(safety.verifyElectionSafety(term, states)).toBe(true);
    });

    it('リーダー障害時に新しいリーダーが選出される', async () => {
      await cluster.start();
      const oldLeader = await cluster.waitForLeader();
      const oldTerm = oldLeader.getState().term;

      // リーダーを停止
      await cluster.stopNode(oldLeader.getNodeId());

      // 新リーダー選出を待つ  
      const newLeader = await cluster.waitForNewLeader(oldLeader.getNodeId(), 5000);

      expect(newLeader.getNodeId()).not.toBe(oldLeader.getNodeId());
      expect(newLeader.getState().term).toBeGreaterThan(oldTerm);

      // Election Safetyを検証
      const states = cluster.getAllNodeStates();
      const safety = cluster.getSafetyChecker();
      expect(safety.verifyElectionSafety(newLeader.getState().term, states)).toBe(true);
    });
  });

  describe('ログレプリケーション', () => {
    it('リーダーのコマンドが全ノードにレプリケーションされる', async () => {
      await cluster.start();
      const leader = await cluster.waitForLeader();

      // コマンドを送信
      const command: Command = {
        type: 'SET',
        key: 'test',
        value: 'hello'
      };

      const result = await leader.handleClientCommand(command);
      expect(result.ok).toBe(true);

      if (result.ok) {
        // レプリケーションを待つ
        await cluster.waitForReplication(result.index);

        // 適用を待つ
        await cluster.waitForApplied(result.index);

        // Log Matchingを検証
        const logs = cluster.getAllLogs();
        const safety = cluster.getSafetyChecker();
        expect(safety.verifyLogMatching(logs)).toBe(true);

        // State Machine Safetyを検証
        const appliedCommands = cluster.getAllAppliedCommands();
        expect(safety.verifyStateMachineSafety(appliedCommands)).toBe(true);

        // 全ノードのステートマシンを確認
        const values = cluster.getAllNodeValues('test');
        expect(values.every(v => v === 'hello')).toBe(true);
      }
    });

    it('複数のコマンドが順序通りに適用される', async () => {
      await cluster.start();
      const leader = await cluster.waitForLeader();

      // 複数コマンドを送信
      const commands: Command[] = [
        { type: 'SET', key: 'a', value: 1 },
        { type: 'SET', key: 'b', value: 2 },
        { type: 'DELETE', key: 'a' },
        { type: 'SET', key: 'c', value: 3 }
      ];

      const results = [];
      for (const cmd of commands) {
        const result = await leader.handleClientCommand(cmd);
        expect(result.ok).toBe(true);
        if (result.ok) {
          results.push(result);
        }
      }

      // 最後のコマンドの適用を待つ
      const lastResult = results[results.length - 1];
      await cluster.waitForApplied(lastResult.index);

      // State Machine Safetyを検証
      const appliedCommands = cluster.getAllAppliedCommands();
      const safety = cluster.getSafetyChecker();
      expect(safety.verifyStateMachineSafety(appliedCommands)).toBe(true);

      // 最終状態を確認
      const states = cluster.getAllStateMachines();
      for (const state of states) {
        expect(state.get('a')).toBeUndefined(); // 削除済み
        expect(state.get('b')).toBe(2);
        expect(state.get('c')).toBe(3);
      }
    });
  });

  describe('ネットワーク分断', () => {
    it('少数派パーティションでは書き込みができない', async () => {
      await cluster.start();
      await cluster.waitForLeader();

      // ネットワークを分断（1ノード vs 2ノード）
      const minority = cluster.nodes[0];
      await cluster.partitionNode(minority.getNodeId());

      // 新リーダーを待つ（多数派側）
      await cluster.waitForNewLeader(minority.getNodeId());

      // 少数派での書き込みは失敗
      const result = await minority.handleClientCommand({
        type: 'SET',
        key: 'test',
        value: 'should-fail'
      });

      expect(result.ok).toBe(false);
      // リーダーではないため失敗
      if (!result.ok) {
        expect(result.error.type).toBe('NOT_LEADER');
      }
    });

    it('多数派パーティションでは書き込みが継続できる', async () => {
      await cluster.start();
      await cluster.waitForLeader();

      // ネットワークを分断
      const minority = cluster.nodes[0];
      await cluster.partitionNode(minority.getNodeId());

      // 多数派側のリーダーを取得
      const majorityLeader = await cluster.waitForNewLeader(minority.getNodeId());

      // 多数派での書き込みは成功
      const result = await majorityLeader.handleClientCommand({
        type: 'SET',
        key: 'test',
        value: 'success'
      });

      expect(result.ok).toBe(true);
    });

    it('分断回復後にログが同期される', async () => {
      await cluster.start();
      await cluster.waitForLeader();

      const node1 = cluster.nodes[0];

      // 分断
      await cluster.partitionNode(node1.getNodeId());

      // 多数派側で書き込み
      const majorityLeader = await cluster.waitForNewLeader(node1.getNodeId());

      const result = await majorityLeader.handleClientCommand({
        type: 'SET',
        key: 'during-partition',
        value: 'test'
      });
      expect(result.ok).toBe(true);

      if (result.ok) {
        await cluster.waitForApplied(result.index);
      }

      // 分断を回復
      await cluster.healPartition(node1.getNodeId());

      // 同期を待つ
      await cluster.waitForSync();

      // Log Matchingを検証
      const logs = cluster.getAllLogs();
      const safety = cluster.getSafetyChecker();
      expect(safety.verifyLogMatching(logs)).toBe(true);

      // Leader Completenessを検証
      const committedEntries = cluster.getCommittedEntries();
      const currentLeader = cluster.getLeaders()[0];
      const leaderLog = currentLeader.getAllLogEntries();
      expect(safety.verifyLeaderCompleteness(
        committedEntries,
        leaderLog,
        currentLeader.getState().term,
        currentLeader.getNodeId()
      )).toBe(true);
    });
  });

  describe('安全性プロパティ', () => {
    it('Election Safetyが維持される', async () => {
      await cluster.start();
      await cluster.waitForLeader();

      // 複数回選挙を実行
      for (let i = 0; i < 10; i++) {
        const currentLeader = cluster.getLeaders()[0];
        
        // リーダーを停止して新選挙を発生させる
        await cluster.stopNode(currentLeader.getNodeId());
        await cluster.waitForNewLeader(currentLeader.getNodeId());
        
        // Election Safetyを検証
        const states = cluster.getAllNodeStates();
        const safety = cluster.getSafetyChecker();
        
        for (const [nodeId, state] of states) {
          if (state.isLeader) {
            expect(safety.verifyElectionSafety(state.term, states)).toBe(true);
          }
        }
        
        // ノードを復帰
        await cluster.startNode(currentLeader.getNodeId());
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    });

    it('Log Matchingが維持される', async () => {
      await cluster.start();
      const leader = await cluster.waitForLeader();

      // 様々なコマンドを送信
      const commands: Command[] = [
        { type: 'SET', key: 'x', value: 1 },
        { type: 'SET', key: 'y', value: 2 },
        { type: 'DELETE', key: 'x' },
        { type: 'SET', key: 'z', value: 3 }
      ];

      for (const cmd of commands) {
        const result = await leader.handleClientCommand(cmd);
        expect(result.ok).toBe(true);
        if (result.ok) {
          await cluster.waitForReplication(result.index);
        }
      }

      // Log Matchingを検証
      const logs = cluster.getAllLogs();
      const safety = cluster.getSafetyChecker();
      expect(safety.verifyLogMatching(logs)).toBe(true);

      // 各ノードのログ整合性を検証
      for (const [nodeId, log] of logs) {
        expect(safety.verifyLogIntegrity(log, nodeId)).toBe(true);
      }
    });

    it('State Machine Safetyが維持される', async () => {
      await cluster.start();
      const leader = await cluster.waitForLeader();

      // 様々な状態変更を実行
      const operations = [
        { type: 'SET', key: 'counter', value: 1 },
        { type: 'SET', key: 'counter', value: 2 },
        { type: 'SET', key: 'name', value: 'alice' },
        { type: 'SET', key: 'counter', value: 3 },
        { type: 'DELETE', key: 'name' },
        { type: 'SET', key: 'final', value: 'done' }
      ];

      for (const op of operations) {
        const result = await leader.handleClientCommand(op as Command);
        expect(result.ok).toBe(true);
        if (result.ok) {
          await cluster.waitForApplied(result.index);
        }
      }

      // State Machine Safetyを検証
      const appliedCommands = cluster.getAllAppliedCommands();
      const safety = cluster.getSafetyChecker();
      expect(safety.verifyStateMachineSafety(appliedCommands)).toBe(true);

      // 最終状態が全ノードで一致することを確認
      const stateMachines = cluster.getAllStateMachines();
      const referenceState = stateMachines[0];
      
      for (const state of stateMachines) {
        expect(state.get('counter')).toBe(referenceState.get('counter'));
        expect(state.get('name')).toBe(referenceState.get('name'));
        expect(state.get('final')).toBe(referenceState.get('final'));
      }
    });

    it('クラスタ全体の一貫性が維持される', async () => {
      await cluster.start();
      const leader = await cluster.waitForLeader();

      // 複雑なシナリオを実行
      for (let i = 0; i < 20; i++) {
        const action = Math.random();

        if (action < 0.7) {
          // 書き込み操作
          const result = await leader.handleClientCommand({
            type: 'SET',
            key: `key${i}`,
            value: i
          });
          if (result.ok) {
            await cluster.waitForApplied(result.index);
          }
        } else {
          // ノードの一時停止・復帰
          const randomNode = cluster.getRandomNode();
          if (randomNode.getNodeId() !== leader.getNodeId()) {
            await cluster.stopNode(randomNode.getNodeId());
            await new Promise(resolve => setTimeout(resolve, 50));
            await cluster.startNode(randomNode.getNodeId());
          }
        }

        // 各操作後に一貫性を検証
        const nodeStates = cluster.getAllNodeStates();
        const logs = cluster.getAllLogs();
        const appliedCommands = cluster.getAllAppliedCommands();
        const safety = cluster.getSafetyChecker();

        expect(safety.verifyClusterConsistency(nodeStates, logs, appliedCommands)).toBe(true);
      }
    });
  });

  describe('エラー処理', () => {
    it('非リーダーノードへの書き込み要求は適切に拒否される', async () => {
      await cluster.start();
      const leader = await cluster.waitForLeader();
      
      const follower = cluster.nodes.find(n => 
        n.getNodeId() !== leader.getNodeId() && n.isNodeRunning()
      );
      
      expect(follower).toBeDefined();
      
      if (follower) {
        const result = await follower.handleClientCommand({
          type: 'SET',
          key: 'test',
          value: 'should-fail'
        });
        
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.type).toBe('NOT_LEADER');
          expect(result.error.leaderId).toBe(leader.getNodeId());
        }
      }
    });

    it('停止中のノードへの書き込み要求は適切に拒否される', async () => {
      await cluster.start();
      const leader = await cluster.waitForLeader();
      
      await cluster.stopNode(leader.getNodeId());
      
      const result = await leader.handleClientCommand({
        type: 'SET',
        key: 'test', 
        value: 'should-fail'
      });
      
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('INTERNAL_ERROR');
      }
    });
  });
});
# Raftコアロジック Phase 1 開発開始

プロジェクトルートに `claude.md` があることを確認し、その開発原則に従って実装を進めてください。
**特に重要: すべてのコメント、ログ、エラーメッセージ、ドキュメントは日本語で記述してください。**

## 現在のタスク: Phase 1 - 基礎実装

### タスク1: 型定義とドメインモデル作成

以下の順序で実装してください：

1. **型定義ファイルの作成** (`src/types/index.ts`)

   ```typescript
   // 基本的な型エイリアス
   export type NodeId = string;
   export type Term = number;
   export type LogIndex = number;

   // ノード状態（判別可能なユニオン型）
   export type NodeState =
     | { type: 'follower'; leaderId?: NodeId }
     | { type: 'candidate' }
     | { type: 'leader' };

   // ログエントリ
   export interface LogEntry {
     term: Term;
     index: LogIndex;
     command: Command;
     timestamp: number;
   }

   // Result型（エラーハンドリング用）
   export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
   ```

2. **技術仕様書の作成** (`docs/specs/technical/01-state-machine.md`)
   以下の内容を含む日本語の仕様書を作成：
   - 3つの状態（Follower, Candidate, Leader）の詳細定義
   - 各状態から他の状態への遷移条件
   - 各状態での振る舞いと責務
   - 状態遷移図（Mermaidで記述）

3. **Stateクラスのテスト作成** (`test/unit/core/State.test.ts`)

   ```typescript
   import { describe, it, expect, beforeEach } from 'vitest';
   import { RaftState } from '@/core/State';

   describe('RaftState', () => {
     describe('初期状態', () => {
       it('Follower状態で開始する', () => {
         // テストを記述
       });

       it('初期Termは0である', () => {
         // テストを記述
       });
     });

     describe('状態遷移', () => {
       it('FollowerからCandidateに遷移できる', () => {
         // テストを記述
       });

       it('Candidateに遷移するとTermが増加する', () => {
         // テストを記述
       });

       it('より高いTermを受信するとFollowerになる', () => {
         // テストを記述
       });
     });

     describe('投票管理', () => {
       it('同じTermで複数回投票できない', () => {
         // テストを記述
       });
     });
   });
   ```

4. **Stateクラスの実装** (`src/core/State.ts`)
   テストを通す最小限の実装を行う

### 実装要件

#### State クラスの仕様:

```typescript
export class RaftState {
  constructor(nodeId: string);

  // 状態取得メソッド
  getState(): NodeState;
  getCurrentTerm(): Term;
  getVotedFor(): NodeId | null;

  // 状態遷移メソッド
  becomeFollower(term: Term): void;
  becomeCandidate(): void; // termを自動インクリメント
  becomeLeader(): void;

  // 投票管理メソッド
  canVoteFor(candidateId: NodeId): boolean;
  recordVote(candidateId: NodeId): void;

  // より高いTermの処理
  updateTerm(newTerm: Term): boolean; // 更新された場合true
}
```

### コード例（日本語コメント付き）:

```typescript
/**
 * Raftノードの状態を管理するクラス
 */
export class RaftState {
  private nodeId: NodeId;
  private currentTerm: Term = 0;
  private state: NodeState = { type: 'follower' };
  private votedFor: NodeId | null = null;

  constructor(nodeId: NodeId) {
    this.nodeId = nodeId;
    console.log(`ノード${nodeId}を初期化しました`);
  }

  /**
   * Follower状態に遷移する
   * @param term 新しいTerm番号
   */
  becomeFollower(term: Term): void {
    if (term < this.currentTerm) {
      throw new Error(`エラー: 古いTerm(${term})への遷移は許可されません`);
    }

    this.state = { type: 'follower' };
    this.currentTerm = term;
    this.votedFor = null;

    console.log(`情報: Follower状態に遷移しました (Term: ${term})`);
  }
}
```

### 完了チェックリスト

- [ ] 型定義ファイルが作成され、すべての必要な型が定義されている
- [ ] 技術仕様書が日本語で作成されている
- [ ] すべてのテストケースが記述されている
- [ ] テストが失敗することを確認した
- [ ] 実装を行い、すべてのテストが通る
- [ ] コード内のコメントがすべて日本語である
- [ ] ログメッセージがすべて日本語である
- [ ] `npm run test` で全テストが通る

### 次のステップ

タスク1が完了したら：

1. `git add -A && git commit -m "feat: 基本的な状態管理を実装"`
2. タスク2（ログ管理）に進む

## 確認事項

実装を始める前に確認してください：

1. **プロジェクトの初期設定は完了していますか？**

   ```bash
   npm init -y
   npm i -D typescript tsx vitest
   ```

2. **必要なディレクトリ構造は作成されていますか？**

   ```bash
   mkdir -p src/{core,types} test/unit/core docs/specs/technical
   ```

3. **tsconfig.jsonは設定されていますか？**

準備ができたら「型定義から開始します」と返答してください。

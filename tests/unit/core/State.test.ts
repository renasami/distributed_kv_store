import { describe, it, expect, beforeEach } from 'vitest';
import { RaftState } from '@/core/State';
import type { NodeId, Term } from '@/types';

describe('RaftState', () => {
  let raftState: RaftState;
  const nodeId: NodeId = 'test-node-1';
  
  beforeEach(() => {
    raftState = new RaftState(nodeId);
  });

  describe('初期状態', () => {
    it('Follower状態で開始する', () => {
      const state = raftState.getState();
      expect(state.type).toBe('follower');
    });
    
    it('初期Termは0である', () => {
      expect(raftState.getCurrentTerm()).toBe(0);
    });

    it('初期投票記録はnullである', () => {
      expect(raftState.getVotedFor()).toBeNull();
    });

    it('ノードIDが正しく設定されている', () => {
      expect(raftState.getNodeId()).toBe(nodeId);
    });
  });
  
  describe('状態遷移', () => {
    it('FollowerからCandidateに遷移できる', () => {
      raftState.becomeCandidate();
      
      const state = raftState.getState();
      expect(state.type).toBe('candidate');
    });
    
    it('Candidateに遷移するとTermが増加する', () => {
      const initialTerm = raftState.getCurrentTerm();
      raftState.becomeCandidate();
      
      expect(raftState.getCurrentTerm()).toBe(initialTerm + 1);
    });

    it('Candidateに遷移すると自分自身に投票する', () => {
      raftState.becomeCandidate();
      
      expect(raftState.getVotedFor()).toBe(nodeId);
    });
    
    it('より高いTermを受信するとFollowerになる', () => {
      raftState.becomeCandidate();
      const higherTerm: Term = 5;
      
      const updated = raftState.updateTerm(higherTerm);
      
      expect(updated).toBe(true);
      expect(raftState.getCurrentTerm()).toBe(higherTerm);
      expect(raftState.getState().type).toBe('follower');
      expect(raftState.getVotedFor()).toBeNull();
    });

    it('同じTermでは更新されない', () => {
      const currentTerm = raftState.getCurrentTerm();
      
      const updated = raftState.updateTerm(currentTerm);
      
      expect(updated).toBe(false);
      expect(raftState.getCurrentTerm()).toBe(currentTerm);
    });

    it('より低いTermでは更新されない', () => {
      raftState.becomeCandidate(); // Term = 1
      const currentTerm = raftState.getCurrentTerm();
      
      const updated = raftState.updateTerm(0);
      
      expect(updated).toBe(false);
      expect(raftState.getCurrentTerm()).toBe(currentTerm);
      expect(raftState.getState().type).toBe('candidate');
    });

    it('CandidateからLeaderに遷移できる', () => {
      raftState.becomeCandidate();
      raftState.becomeLeader();
      
      const state = raftState.getState();
      expect(state.type).toBe('leader');
    });

    it('LeaderからFollowerに遷移できる', () => {
      raftState.becomeCandidate();
      raftState.becomeLeader();
      
      raftState.becomeFollower(5);
      
      const state = raftState.getState();
      expect(state.type).toBe('follower');
      expect(raftState.getCurrentTerm()).toBe(5);
    });

    it('Followerに遷移時にリーダーIDを設定できる', () => {
      const leaderId: NodeId = 'leader-node';
      raftState.becomeFollower(1, leaderId);
      
      const state = raftState.getState();
      expect(state.type).toBe('follower');
      if (state.type === 'follower') {
        expect(state.leaderId).toBe(leaderId);
      }
    });
  });
  
  describe('投票管理', () => {
    it('初期状態では任意の候補者に投票できる', () => {
      const candidateId: NodeId = 'candidate-1';
      expect(raftState.canVoteFor(candidateId)).toBe(true);
    });

    it('同じTermで複数回投票できない', () => {
      const candidate1: NodeId = 'candidate-1';
      const candidate2: NodeId = 'candidate-2';
      
      raftState.recordVote(candidate1);
      
      expect(raftState.canVoteFor(candidate1)).toBe(true);
      expect(raftState.canVoteFor(candidate2)).toBe(false);
    });

    it('投票記録が正しく保存される', () => {
      const candidateId: NodeId = 'candidate-1';
      
      raftState.recordVote(candidateId);
      
      expect(raftState.getVotedFor()).toBe(candidateId);
    });

    it('新しいTermでは投票記録がリセットされる', () => {
      const candidateId: NodeId = 'candidate-1';
      raftState.recordVote(candidateId);
      
      raftState.updateTerm(2);
      
      expect(raftState.getVotedFor()).toBeNull();
      expect(raftState.canVoteFor('new-candidate')).toBe(true);
    });

    it('同じ候補者には再投票できる', () => {
      const candidateId: NodeId = 'candidate-1';
      
      raftState.recordVote(candidateId);
      
      expect(raftState.canVoteFor(candidateId)).toBe(true);
    });
  });

  describe('エラーケース', () => {
    it('Followerへの遷移で古いTermは拒否される', () => {
      raftState.becomeCandidate(); // Term = 1
      
      expect(() => raftState.becomeFollower(0)).toThrow('エラー: 古いTerm');
    });

    it('Leader状態でない場合のLeader専用メソッドはエラー', () => {
      expect(() => raftState.resetElectionTimeout()).toThrow('エラー: Leader状態ではありません');
    });

    it('無効なノードIDでの初期化はエラー', () => {
      expect(() => new RaftState('')).toThrow('エラー: 無効なノードID');
    });
  });

  describe('タイムアウト管理', () => {
    it('初期状態では選挙タイムアウトが設定されている', () => {
      expect(raftState.isElectionTimeoutActive()).toBe(true);
    });

    it('Leader状態では選挙タイムアウトが無効', () => {
      raftState.becomeCandidate();
      raftState.becomeLeader();
      
      expect(raftState.isElectionTimeoutActive()).toBe(false);
    });

    it('Leader状態でタイムアウトをリセットできる', () => {
      raftState.becomeCandidate();
      raftState.becomeLeader();
      
      expect(() => raftState.resetElectionTimeout()).not.toThrow();
    });
  });
});
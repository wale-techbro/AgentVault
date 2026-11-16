import { describe, expect, it } from 'vitest';
import { canAssignTask, canDecideBid, canSubmitBid, canTransitionTask, deliverableReviewResult, ownsAgent, type TaskStatus } from './domain';

describe('marketplace permissions and transitions', () => {
  it('permits only an available non-owner agent to bid within budget', () => {
    const base = { taskStatus: 'open' as const, taskOwnerId: 'owner', bidderId: 'worker', agentActive: true, agentAvailability: 'available' as const, bidYocto: BigInt('20'), budgetYocto: BigInt('30') };
    expect(canSubmitBid(base)).toBe(true);
    expect(canSubmitBid({ ...base, bidderId: 'owner' })).toBe(false);
    expect(canSubmitBid({ ...base, agentAvailability: 'offline' })).toBe(false);
    expect(canSubmitBid({ ...base, bidYocto: BigInt('31') })).toBe(false);
    expect(canSubmitBid({ ...base, alreadyBid: true })).toBe(false);
    expect(canSubmitBid({ ...base, taskStatus: 'completed' })).toBe(false);
  });

  it('scopes agent edits to the authenticated owner', () => {
    expect(ownsAgent('user-a', 'user-a')).toBe(true);
    expect(ownsAgent('user-a', 'user-b')).toBe(false);
    expect(ownsAgent(null, 'user-a')).toBe(false);
  });

  it('allows the owner to decide one pending bid only while the task is open', () => {
    const base = { actorId: 'owner', taskOwnerId: 'owner', taskStatus: 'bidding' as const, bidStatus: 'pending' as const, decision: 'accept' as const };
    expect(canDecideBid(base)).toBe(true);
    expect(canDecideBid({ ...base, actorId: 'worker' })).toBe(false);
    expect(canDecideBid({ ...base, bidStatus: 'selected' })).toBe(false);
    expect(canDecideBid({ ...base, taskStatus: 'assigned' })).toBe(false);
    expect(canDecideBid({ ...base, decision: 'reject' })).toBe(true);
  });

  it('allows exactly one of two concurrent assignment claims to win', async () => {
    const task: { status: TaskStatus; selectedAgentId: string | null; ownerId: string } = { status: 'bidding', selectedAgentId: null, ownerId: 'owner' };
    const claim = async (agentId: string) => {
      await Promise.resolve();
      if (!canAssignTask({ taskStatus: task.status, selectedAgentId: task.selectedAgentId, ownerId: task.ownerId, actorId: 'owner' })) return false;
      task.status = 'assigned';
      task.selectedAgentId = agentId;
      return true;
    };
    const results = await Promise.all([claim('agent-a'), claim('agent-b')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(['agent-a', 'agent-b']).toContain(task.selectedAgentId);
    expect(canAssignTask({ taskStatus: 'assigned', selectedAgentId: task.selectedAgentId, ownerId: 'owner', actorId: 'attacker' })).toBe(false);
  });

  it('restricts task state changes by actor and lifecycle state', () => {
    expect(canTransitionTask('open', 'cancelled', 'owner')).toBe(true);
    expect(canTransitionTask('open', 'cancelled', 'assigned_agent')).toBe(false);
    expect(canTransitionTask('assigned', 'in_progress', 'assigned_agent')).toBe(true);
    expect(canTransitionTask('submitted', 'completed', 'owner')).toBe(false);
    expect(canTransitionTask('completed', 'disputed', 'owner')).toBe(false);
  });

  it('requires verification before owner approval and keeps revisions unapproved', () => {
    expect(deliverableReviewResult('submitted', 'verify')).toEqual({ deliverableStatus: 'verified', taskStatus: 'verified' });
    expect(deliverableReviewResult('submitted', 'approve')).toBeNull();
    expect(deliverableReviewResult('verified', 'approve')).toEqual({ deliverableStatus: 'approved', taskStatus: 'approved' });
    expect(deliverableReviewResult('submitted', 'request_revision')).toEqual({ deliverableStatus: 'revision_requested', taskStatus: 'in_progress' });
  });
});

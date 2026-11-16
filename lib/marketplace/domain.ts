export type TaskStatus =
  | 'open' | 'bidding' | 'assigned' | 'in_progress' | 'submitted' | 'verified'
  | 'approved' | 'completed' | 'cancelled' | 'disputed' | 'settling' | 'refunded' | 'failed';

export type WorkflowActor = 'owner' | 'assigned_agent' | 'other';
export type BidDecision = 'accept' | 'reject';
export type DeliverableDecision = 'verify' | 'approve' | 'request_revision' | 'reject';

export function ownsAgent(agentOwnerId: string | null | undefined, userId: string): boolean {
  return Boolean(agentOwnerId && agentOwnerId === userId);
}

export function canAssignTask(input: { taskStatus: TaskStatus; selectedAgentId: string | null; ownerId: string | null; actorId: string }): boolean {
  return input.actorId === input.ownerId
    && input.ownerId !== null
    && (input.taskStatus === 'open' || input.taskStatus === 'bidding')
    && input.selectedAgentId === null;
}

export function canSubmitBid(input: {
  taskStatus: TaskStatus;
  taskOwnerId: string;
  bidderId: string;
  agentActive: boolean;
  agentAvailability: 'available' | 'busy' | 'offline';
  alreadyBid?: boolean;
  bidYocto: bigint;
  budgetYocto: bigint;
}): boolean {
  return (input.taskStatus === 'open' || input.taskStatus === 'bidding')
    && input.taskOwnerId !== input.bidderId
    && input.agentActive
    && input.agentAvailability === 'available'
    && !input.alreadyBid
    && input.bidYocto > BigInt('0')
    && input.bidYocto <= input.budgetYocto;
}

export function canDecideBid(input: {
  actorId: string;
  taskOwnerId: string;
  taskStatus: TaskStatus;
  bidStatus: 'pending' | 'selected' | 'rejected' | 'withdrawn';
  decision: BidDecision;
}): boolean {
  return input.actorId === input.taskOwnerId
    && (input.taskStatus === 'open' || input.taskStatus === 'bidding')
    && input.bidStatus === 'pending'
    && (input.decision === 'accept' || input.decision === 'reject');
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus, actor: WorkflowActor): boolean {
  if (from === to || from === 'completed' || from === 'cancelled' || from === 'refunded' || from === 'failed') return false;
  if (to === 'cancelled') return actor === 'owner' && ['open', 'bidding', 'assigned', 'in_progress'].includes(from);
  if (to === 'disputed') return (actor === 'owner' || actor === 'assigned_agent') && ['assigned', 'in_progress', 'submitted', 'verified', 'approved'].includes(from);
  if (to === 'in_progress') return actor === 'assigned_agent' && from === 'assigned';
  if (to === 'completed') return actor === 'owner' && from === 'approved';
  return false;
}

export function deliverableReviewResult(current: string, decision: DeliverableDecision): { deliverableStatus: string; taskStatus: TaskStatus } | null {
  if (decision === 'verify' && current === 'submitted') return { deliverableStatus: 'verified', taskStatus: 'verified' };
  if (decision === 'approve' && current === 'verified') return { deliverableStatus: 'approved', taskStatus: 'approved' };
  if (decision === 'request_revision' && (current === 'submitted' || current === 'verified' || current === 'revision_requested')) {
    return { deliverableStatus: 'revision_requested', taskStatus: 'in_progress' };
  }
  if (decision === 'reject' && (current === 'submitted' || current === 'verified' || current === 'revision_requested')) {
    return { deliverableStatus: 'rejected', taskStatus: 'disputed' };
  }
  return null;
}

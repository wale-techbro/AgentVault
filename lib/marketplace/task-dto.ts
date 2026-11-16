import { yoctoToNearNumber } from '@/lib/validation/tasks';

export type TaskRow = {
  id: string;
  title: string;
  description: string;
  budget_yocto: string;
  capabilities: string[];
  deadline_at: Date | null;
  status: string;
  agent_name: string | null;
  agent_account_id: string | null;
  created_at: Date;
  bid_count?: number;
  owner_user_id?: string | null;
  owner_near_account_id?: string | null;
  is_mine?: boolean;
  selected_agent_id?: string | null;
};

export function taskDto(row: TaskRow) {
  const category = row.capabilities[0] || 'General';
  const agentName = row.agent_name || 'Awaiting bids';
  const initials = agentName.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  const status = row.status === 'open' || row.status === 'bidding'
    ? 'Open'
    : row.status === 'assigned' || row.status === 'in_progress'
      ? 'In progress'
      : row.status === 'submitted' || row.status === 'verified' || row.status === 'approved' || row.status === 'settling'
        ? 'In review'
        : row.status === 'completed'
          ? 'Completed'
          : row.status === 'cancelled'
            ? 'Cancelled'
            : row.status === 'disputed'
              ? 'Disputed'
              : row.status === 'refunded'
                ? 'Refunded'
                : 'Needs attention';
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category,
    agent: agentName,
    agentId: initials || '—',
    amount: yoctoToNearNumber(row.budget_yocto),
    eta: row.deadline_at ? new Date(row.deadline_at).toLocaleDateString('en-GB', { timeZone: 'UTC' }) : 'No deadline',
    score: '—',
    status,
    color: 'gold',
    workerAccountId: row.agent_account_id,
    createdAt: row.created_at,
    bidCount: Number(row.bid_count || 0),
    isMine: Boolean(row.is_mine),
    selectedAgentId: row.selected_agent_id || null,
    deadlineAt: row.deadline_at?.toISOString() || null,
  };
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowUpRight, BadgeCheck, BriefcaseBusiness, Check, ChevronDown, Clock3, FileText, LockKeyhole, Plus, ShieldCheck, Sparkles, Wallet } from 'lucide-react';
import type { Agent, Bid } from '@/lib/demo';
import { nearExplorerUrl, type EscrowCall, type EscrowView } from '@/lib/near/client';

type ApiBid = { id: string; taskId: string; agentId: string; agent: string; agentAccountId: string; amountNear: number; etaHours: number; capabilityScore: number; proposal: string; status: string; createdAt: string };
type Deliverable = { id: string; agent_id: string; agent_name: string; revision: number; title: string; content: { title?: string; body?: string }; status: string; metadata: Record<string, unknown>; verification_evidence: { label: string; url: string }[]; review_note: string | null; submittedAt: string; reviewedAt: string | null };
type Detail = { task: Bid; taskStatus: string; isOwner: boolean; isAssignedAgent: boolean; deliverables: Deliverable[]; events: { sender: string; event_type: string; payload: Record<string, unknown>; created_at: string }[] };
type WorkspaceError = string;

function evidenceFromLines(value: string) {
  return value.split('\n').map((line) => line.trim()).filter(Boolean).map((url) => ({ label: url, url }));
}

export default function PersistentTaskWorkspace({ task: summary, agents, onTaskChanged, connected, onConnect, account, contractConfigured,
  chainTask, chainBusy, chainError, workerAccountId, setWorkerAccountId, workerVerified, workerCheck, verifyWorker, onChainAction, receipts,
}: {
  task: Bid; agents: Agent[]; onTaskChanged: (task: Bid) => void; connected: boolean; onConnect: () => void; account: string;
  contractConfigured: boolean; chainTask: EscrowView | null; chainBusy: boolean; chainError: string; workerAccountId: string;
  setWorkerAccountId: (value: string) => void; workerVerified: boolean; workerCheck: string; verifyWorker: () => void;
  onChainAction: (action: EscrowCall) => void; receipts: { taskId: string; action: EscrowCall; hash: string; signerAccountId: string; amountNear?: number; status: string; createdAt: string }[];
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [bids, setBids] = useState<ApiBid[]>([]);
  const [isBidOwner, setIsBidOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<WorkspaceError>('');
  const [success, setSuccess] = useState('');
  const [bidAgentId, setBidAgentId] = useState('');
  const [bidAmount, setBidAmount] = useState('');
  const [bidEta, setBidEta] = useState('24');
  const [bidProposal, setBidProposal] = useState('');
  const [deliverableTitle, setDeliverableTitle] = useState('');
  const [deliverableContent, setDeliverableContent] = useState('');
  const [evidenceText, setEvidenceText] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const keys = useRef<Record<string, string>>({});
  const myAgents = useMemo(() => agents.filter((agent) => agent.isMine && agent.isActive && agent.availability === 'available'), [agents]);
  const latestDeliverable = detail?.deliverables[0];
  const taskId = summary.id;

  const reload = useCallback(async () => {
    const [taskResponse, bidResponse] = await Promise.all([
      fetch(`/api/tasks/${taskId}`, { cache: 'no-store' }),
      fetch(`/api/tasks/${taskId}/bids`, { cache: 'no-store' }),
    ]);
    const [taskData, bidData] = await Promise.all([taskResponse.json(), bidResponse.json()]);
    if (!taskResponse.ok) throw new Error(taskData.error || 'Task details could not be loaded.');
    if (!bidResponse.ok) throw new Error(bidData.error || 'Bid details could not be loaded.');
    setDetail(taskData as Detail); setBids(bidData.bids as ApiBid[]); setIsBidOwner(Boolean(bidData.isOwner));
    onTaskChanged(taskData.task as Bid);
  }, [taskId, onTaskChanged]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(''); setDetail(null); setBids([]);
    Promise.all([fetch(`/api/tasks/${taskId}`, { cache: 'no-store' }), fetch(`/api/tasks/${taskId}/bids`, { cache: 'no-store' })])
      .then(async ([taskResponse, bidResponse]) => {
        const [taskData, bidData] = await Promise.all([taskResponse.json(), bidResponse.json()]);
        if (!taskResponse.ok) throw new Error(taskData.error || 'Task details could not be loaded.');
        if (!bidResponse.ok) throw new Error(bidData.error || 'Bid details could not be loaded.');
        if (cancelled) return;
        setDetail(taskData as Detail); setBids(bidData.bids as ApiBid[]); setIsBidOwner(Boolean(bidData.isOwner)); onTaskChanged(taskData.task as Bid);
        setBidAgentId(myAgents[0]?.id || ''); setBidAmount(summary.amount ? String(summary.amount) : '');
      })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Task details could not be loaded.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [taskId, summary.amount, myAgents, onTaskChanged]);

  useEffect(() => { if (summary.workerAccountId) setWorkerAccountId(summary.workerAccountId); }, [summary.workerAccountId, setWorkerAccountId]);

  async function mutate(keyName: string, url: string, body: unknown, method = 'POST', message = 'Saved.') {
    const key = keys.current[keyName] || (keys.current[keyName] = crypto.randomUUID());
    setBusy(keyName); setError(''); setSuccess('');
    try {
      const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'The update could not be saved.');
      delete keys.current[keyName]; await reload(); setSuccess(message);
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The update could not be saved.'); return false; }
    finally { setBusy(''); }
  }

  if (loading) return <div className="panel marketplace-empty" role="status">Loading task, bids, revisions and activity…</div>;
  if (!detail) return <div className="panel marketplace-empty"><h3>Task could not be opened</h3><p>{error || 'Refresh the marketplace and try again.'}</p><button className="secondary-btn" onClick={() => { setLoading(true); void reload().catch((cause) => setError(cause instanceof Error ? cause.message : 'Refresh failed.')).finally(() => setLoading(false)); }}>Retry</button></div>;

  const { taskStatus, task, isOwner, isAssignedAgent } = detail;
  const open = taskStatus === 'open' || taskStatus === 'bidding';
  const canReview = isOwner && latestDeliverable && ['submitted', 'verified'].includes(latestDeliverable.status);

  return <section className="workspace-view">
    <div className="workspace-banner"><div className="task-type type-research"><BriefcaseBusiness size={19}/></div><div className="workspace-title"><div className="task-breadcrumb">ACCOUNT TASK <span>·</span> {task.id.slice(0, 8).toUpperCase()}</div><h2>{task.title}</h2><p>{task.description}</p></div><span className={`status ${taskStatus === 'completed' ? 'status-complete' : taskStatus === 'in_progress' ? 'status-progress' : 'status-review'}`}><i/>{taskStatus.replace('_', ' ')}</span></div>
    {error && <div className="workspace-data-error" role="alert">{error}</div>}{success && <div className="workspace-success-note" role="status"><Check size={14}/>{success}</div>}
    <div className="workspace-meta"><div><span>BUDGET</span><b>{task.amount.toFixed(3)} <small>NEAR</small></b></div><div><span>DEADLINE</span><b>{task.deadlineAt ? new Date(task.deadlineAt).toLocaleDateString() : 'Not set'}</b></div><div><span>REQUIRED SKILLS</span><div className="skill-chips">{task.category.split(',').map((skill) => <i key={skill}>{skill.trim()}</i>)}</div></div><div><span>ACTIVITY</span><b>{detail.events.length} recorded events</b></div></div>
    <div className="workspace-columns"><div className="workspace-primary">
      {open && !isOwner && myAgents.length > 0 && <form className="panel workflow-panel persistent-form" onSubmit={async (event) => { event.preventDefault(); const ok = await mutate('bid', `/api/tasks/${task.id}/bids`, { agentId: bidAgentId, amountNear: bidAmount, etaHours: Number(bidEta), proposal: bidProposal }, 'POST', 'Bid submitted to the task owner.'); if (ok) { setBidProposal(''); keys.current.bid = ''; } }}>
        <div className="panel-head"><div><h3>Submit a bid</h3><p>Offer a price and delivery window for this task.</p></div></div>
        <div className="persistent-form-grid"><label>Your agent<select required value={bidAgentId} onChange={(event) => { setBidAgentId(event.target.value); delete keys.current.bid; }}><option value="">Choose an available agent</option>{myAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.nearAccountId}</option>)}</select></label><label>Proposed price<input required type="number" min="0.000001" step="0.000001" max={task.amount} value={bidAmount} onChange={(event) => { setBidAmount(event.target.value); delete keys.current.bid; }}/><small>Task budget: {task.amount.toFixed(3)} NEAR</small></label><label>Estimated hours<input required type="number" min="1" max="8760" step="1" value={bidEta} onChange={(event) => { setBidEta(event.target.value); delete keys.current.bid; }}/></label><label className="persistent-wide">Proposal<textarea required minLength={20} maxLength={5000} value={bidProposal} onChange={(event) => { setBidProposal(event.target.value); delete keys.current.bid; }} placeholder="Explain the approach, milestones and expected deliverable."/></label></div>
        <button className="primary-btn" disabled={busy === 'bid' || !bidAgentId}>{busy === 'bid' ? 'Submitting…' : 'Submit bid'}</button>
      </form>}
      {open && !isOwner && myAgents.length === 0 && <div className="panel marketplace-empty"><h3>Register an available agent to bid</h3><p>Your agent must have an active NEAR payout account and be available. Register it in the Agent directory.</p></div>}

      <div className="panel workflow-panel"><div className="panel-head"><div><h3>Bid comparison</h3><p>{isBidOwner ? `${bids.length} submitted bid${bids.length === 1 ? '' : 's'}` : 'Only your own bid is visible to you.'}</p></div><span className="demo-pill"><i/> DATABASE</span></div>
        {bids.length === 0 ? <div className="awaiting-bids"><div className="modal-icon"><Clock3 size={18}/></div><h3>No bids yet</h3><p>Available agent owners can submit a price, an estimate, and a proposal. The task remains open for offers.</p></div> : <div className="persistent-bid-list">{bids.map((bid) => <article className="persistent-bid" key={bid.id}><div><b>{bid.agent}</b><small>{bid.capabilityScore}% capability match · {bid.etaHours} hours · {bid.agentAccountId}</small><p>{bid.proposal}</p></div><div className="persistent-bid-price"><b>{bid.amountNear.toFixed(3)} <small>NEAR</small></b><span>{bid.status}</span></div>{isBidOwner && open && bid.status === 'pending' && <div className="persistent-bid-actions"><button className="primary-btn" disabled={busy === `bid-${bid.id}`} onClick={() => void mutate(`bid-${bid.id}`, `/api/tasks/${task.id}/bids/${bid.id}`, { decision: 'accept' }, 'POST', `${bid.agent} assigned to the task.`)}>Accept & assign</button><button className="secondary-btn" disabled={busy === `reject-${bid.id}`} onClick={() => void mutate(`reject-${bid.id}`, `/api/tasks/${task.id}/bids/${bid.id}`, { decision: 'reject' }, 'POST', 'Bid rejected.')}>Reject</button></div>}</article>)}</div>}
      </div>

      {isAssignedAgent && taskStatus === 'assigned' && <div className="panel workflow-panel"><h3>Assignment accepted</h3><p>Start work when you are ready. Starting records the transition and makes deliverable submission available.</p><button className="primary-btn" disabled={busy === 'start'} onClick={() => void mutate('start', `/api/tasks/${task.id}/transition`, { to: 'in_progress' }, 'POST', 'Work started.')}>{busy === 'start' ? 'Updating…' : 'Start task'}</button></div>}
      {isAssignedAgent && taskStatus === 'in_progress' && <form className="panel workflow-panel persistent-form" onSubmit={(event) => { event.preventDefault(); const submitted = mutate('deliverable', `/api/tasks/${task.id}/deliverables`, { title: deliverableTitle, content: deliverableContent, evidence: evidenceFromLines(evidenceText) }, 'POST', 'Deliverable submitted; waiting for owner review.'); void submitted.then((ok) => { if (ok) { setDeliverableTitle(''); setDeliverableContent(''); setEvidenceText(''); delete keys.current.deliverable; } }); }}>
        <div className="panel-head"><div><h3>Submit deliverable</h3><p>Submission creates a numbered revision. It is not automatically approved.</p></div></div>
        <label>Deliverable title<input required minLength={3} maxLength={160} value={deliverableTitle} onChange={(event) => { setDeliverableTitle(event.target.value); delete keys.current.deliverable; }}/></label>
        <label>Work completed<textarea required minLength={50} maxLength={60000} value={deliverableContent} onChange={(event) => { setDeliverableContent(event.target.value); delete keys.current.deliverable; }} placeholder="Write the report, result, or implementation summary here."/></label>
        <label>Evidence URLs, one per line<input value={evidenceText} onChange={(event) => { setEvidenceText(event.target.value); delete keys.current.deliverable; }} placeholder="https://example.com/source"/></label>
        <button className="primary-btn" disabled={busy === 'deliverable'}>{busy === 'deliverable' ? 'Submitting…' : 'Submit revision'}</button>
      </form>}

      <div className="panel workflow-panel"><div className="panel-head"><div><h3>Deliverable revisions</h3><p>Human owner review is required for verification and approval.</p></div></div>
        {detail.deliverables.length === 0 ? <div className="awaiting-bids"><FileText size={18}/><h3>No deliverable submitted</h3><p>The assigned agent can submit a revision after starting the task.</p></div> : detail.deliverables.map((item) => <article className="persistent-deliverable" key={item.id}><div className="deliverable-top"><div className="document-icon"><FileText size={17}/></div><div><b>{item.title || item.content.title || 'Work submission'}</b><small>Revision {item.revision} · {item.agent_name} · {new Date(item.submittedAt).toLocaleString()}</small></div><span className="market-status">{item.status.replace('_', ' ')}</span></div><div className="persistent-deliverable-body">{item.content.body || 'No deliverable body.'}</div>{item.verification_evidence?.length > 0 && <div className="persistent-evidence"><b>Evidence links</b>{item.verification_evidence.map((link) => <a key={link.url} href={link.url} target="_blank" rel="noreferrer">{link.label}<ArrowUpRight size={12}/></a>)}</div>}{item.review_note && <p className="persistent-review-note">Owner review: {item.review_note}</p>}</article>)}
        {canReview && latestDeliverable && <div className="persistent-review"><label>Review note<textarea maxLength={4000} value={reviewNote} onChange={(event) => { setReviewNote(event.target.value); delete keys.current.review; }}/></label><label>Verification evidence URLs, one per line<input value={evidenceText} onChange={(event) => { setEvidenceText(event.target.value); delete keys.current.review; }} placeholder="https://example.com/verification"/></label><div className="persistent-bid-actions">{latestDeliverable.status === 'submitted' && <button className="secondary-btn" disabled={busy === 'review'} onClick={() => void mutate('review', `/api/tasks/${task.id}/deliverables/${latestDeliverable.id}/review`, { decision: 'verify', note: reviewNote, evidence: evidenceFromLines(evidenceText) }, 'POST', 'Verification recorded. The deliverable remains unapproved.')}>Verify with evidence</button>}{latestDeliverable.status === 'verified' && <button className="primary-btn" disabled={busy === 'review'} onClick={() => void mutate('review', `/api/tasks/${task.id}/deliverables/${latestDeliverable.id}/review`, { decision: 'approve', note: reviewNote, evidence: evidenceFromLines(evidenceText) }, 'POST', 'You approved this deliverable.')}>Approve deliverable</button>}<button className="secondary-btn" disabled={busy === 'review'} onClick={() => void mutate('review', `/api/tasks/${task.id}/deliverables/${latestDeliverable.id}/review`, { decision: 'request_revision', note: reviewNote, evidence: evidenceFromLines(evidenceText) }, 'POST', 'Revision requested; the assigned agent can resubmit.')}>Request revision</button></div></div>}
      </div>

      <div className="panel workflow-panel"><div className="panel-head"><div><h3>Task activity</h3><p>Persisted events and state transitions</p></div></div>{detail.events.length === 0 ? <p>No participant activity has been recorded yet.</p> : <div className="persistent-events">{detail.events.map((event, index) => <div className="activity-line" key={`${event.event_type}-${index}`}><span className="avatar avatar-green"><Activity size={13}/></span><p><b>{event.event_type.replace(/[._]/g, ' ')}</b><small>{event.sender} · {new Date(event.created_at).toLocaleString()}</small></p></div>)}</div>}</div>
    </div>
    <aside className="workspace-secondary"><div className="panel selected-card"><div className="panel-head"><div><h3>Work order</h3><p>{isOwner ? 'You own this task' : isAssignedAgent ? 'Assigned to your agent' : 'Open marketplace task'}</p></div></div><div className="selected-stats"><div><span>BUDGET</span><b>{task.amount.toFixed(3)} <small>NEAR</small></b></div><div><span>STATUS</span><b>{taskStatus.replace('_', ' ')}</b></div><div><span>BIDS</span><b>{task.bidCount || bids.length}</b></div></div><div className="agent-skills"><span>CAPABILITIES</span><div>{task.category.split(',').map((skill) => <i key={skill}>{skill.trim()}</i>)}</div></div>
      {isOwner && ['open', 'bidding', 'assigned'].includes(taskStatus) && <button className="secondary-btn full-btn" disabled={busy === 'cancel'} onClick={() => void mutate('cancel', `/api/tasks/${task.id}/transition`, { to: 'cancelled' }, 'POST', 'Task cancelled.')}>Cancel task</button>}
      {(isOwner || isAssignedAgent) && ['assigned', 'in_progress', 'submitted', 'verified', 'approved'].includes(taskStatus) && <button className="secondary-btn full-btn" disabled={busy === 'dispute'} onClick={() => { const note = window.prompt('Describe the issue (at least 10 characters).'); if (note) void mutate('dispute', `/api/tasks/${task.id}/transition`, { to: 'disputed', note }, 'POST', 'Dispute recorded.'); }}>Open dispute</button>}
      {isOwner && taskStatus === 'approved' && <button className="primary-btn full-btn" disabled={busy === 'complete'} onClick={() => void mutate('complete', `/api/tasks/${task.id}/transition`, { to: 'completed' }, 'POST', 'Task marked completed.')}>Mark task completed</button>}
    </div>
    <div className="panel selected-card escrow-controls"><div className="panel-head"><div><h3>NEAR testnet escrow</h3><p>{connected ? `Owner wallet: ${account}` : 'Connect an owner wallet to sign contract calls.'}</p></div><span>{chainTask?.settled ? 'Confirmed' : chainTask ? 'On testnet' : 'Demo only'}</span></div>
      {!connected && <button className="secondary-btn full-btn" onClick={onConnect}><Wallet size={14}/>Connect NEAR wallet</button>}
      {!contractConfigured && <p>Demo only · configure a deployed testnet contract before sending a transaction.</p>}
      {contractConfigured && isOwner && !chainTask && !['cancelled', 'completed', 'disputed'].includes(taskStatus) && <button className="primary-btn full-btn" disabled={!connected || chainBusy} onClick={() => onChainAction('create_escrow')}>{chainBusy ? 'Waiting for wallet…' : `Create escrow · ${task.amount.toFixed(3)} NEAR`}</button>}
      {contractConfigured && chainTask && !chainTask.worker && <><label>Selected agent payout account<input value={workerAccountId} readOnly placeholder="Accept an agent bid first"/></label><button className="secondary-btn full-btn" disabled={!workerAccountId || !task.selectedAgentId || chainBusy || taskStatus !== 'assigned'} onClick={verifyWorker}>Verify selected agent on testnet</button><small>{workerCheck || (task.selectedAgentId ? 'The payout recipient is read from the selected agent profile.' : 'Accept a bid before assigning a worker.')}</small><button className="primary-btn full-btn" disabled={!workerVerified || chainBusy || taskStatus !== 'assigned' || !task.selectedAgentId} onClick={() => onChainAction('assign_worker')}>Assign verified worker</button></>}
      {chainTask?.worker && <p>Worker payout: <b>{chainTask.worker}</b></p>}
      {chainTask?.worker && taskStatus === 'approved' && !chainTask.complete && <button className="primary-btn full-btn" disabled={chainBusy || !connected} onClick={() => onChainAction('approve_completion')}>Approve completion on testnet</button>}
      {chainTask?.complete && !chainTask.settled && <button className="primary-btn full-btn" disabled={chainBusy || !connected || chainTask.pending} onClick={() => onChainAction('release_payment')}>Release payment</button>}
      {chainTask && !chainTask.settled && (!chainTask.complete || chainTask.transfer_failed) && <button className="secondary-btn full-btn" disabled={chainBusy || !connected || chainTask.pending} onClick={() => onChainAction('refund')}>Refund escrow</button>}
      {chainError && <p role="alert">{chainError}</p>}
      {receipts.map((receipt) => <div className="timeline-data" key={receipt.hash}><span>{receipt.action.replaceAll('_', ' ')} · {receipt.status} · testnet</span><a href={nearExplorerUrl(receipt.hash)} target="_blank" rel="noreferrer">{receipt.hash.slice(0, 12)}… Explorer</a></div>)}
      <p className="workspace-demo-note"><LockKeyhole size={12}/>NEAR signatures and database review are separate. A confirmed testnet call is not inferred from task status.</p>
    </div>
    <div className="approval-card"><div className="approval-lock"><ShieldCheck size={16}/></div><div><span className="modal-kicker">HUMAN REVIEW</span><h3>{taskStatus === 'approved' ? 'Owner approved this work' : taskStatus === 'verified' ? 'Verification recorded' : 'Approval is never automatic'}</h3><p>Only the task owner can record verification and explicit approval. NEAR payment release needs a separate wallet signature.</p><div className="testnet-notice"><i/>{taskStatus === 'approved' ? 'Approved in PostgreSQL' : 'Awaiting owner review'}</div></div></div>
    </aside></div>
  </section>;
}

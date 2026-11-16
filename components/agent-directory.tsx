'use client';

import { useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Check, Plus, Search, X } from 'lucide-react';
import type { Agent } from '@/lib/demo';

type AgentFormValue = { name: string; role: string; description: string; capabilities: string; nearAccountId: string; availability: 'available' | 'offline' };
const blankForm: AgentFormValue = { name: '', role: '', description: '', capabilities: '', nearAccountId: '', availability: 'available' };

export default function AgentDirectory({ agents, query, setQuery, persistentMode, loading, onAgentsChange }: {
  agents: Agent[]; query: string; setQuery: (value: string) => void; persistentMode: boolean; loading: boolean; onAgentsChange: (agents: Agent[]) => void;
}) {
  const [form, setForm] = useState<AgentFormValue>(blankForm);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [capabilityFilter, setCapabilityFilter] = useState('');
  const requestKeys = useRef<Record<string, { fingerprint: string; key: string }>>({});
  const capabilities = useMemo(() => Array.from(new Set(agents.flatMap((agent) => agent.skills))).sort((a, b) => a.localeCompare(b)), [agents]);
  const visibleAgents = useMemo(() => agents.filter((agent) =>
    `${agent.name} ${agent.role} ${agent.skills.join(' ')}`.toLowerCase().includes(query.toLowerCase())
    && (!capabilityFilter || agent.skills.includes(capabilityFilter))), [agents, query, capabilityFilter]);
  const registered = agents.filter((agent) => agent.isMine).length;
  const available = agents.filter((agent) => agent.isActive && agent.availability === 'available').length;

  function startCreate() { setEditing(null); setForm(blankForm); setError(''); setNotice(''); setFormOpen(true); }
  function startEdit(agent: Agent) {
    setEditing(agent); setError(''); setNotice('');
    setForm({ name: agent.name, role: agent.role, description: agent.description || '', capabilities: agent.skills.join(', '), nearAccountId: agent.nearAccountId, availability: agent.availability === 'offline' ? 'offline' : 'available' });
    setFormOpen(true);
  }

  async function refresh() {
    const response = await fetch('/api/agents', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Agent records could not be refreshed.');
    onAgentsChange(data.agents as Agent[]);
  }

  function idempotencyKey(action: string, body: unknown) {
    const fingerprint = JSON.stringify(body);
    const current = requestKeys.current[action];
    if (current?.fingerprint === fingerprint) return current.key;
    const key = crypto.randomUUID();
    requestKeys.current[action] = { fingerprint, key };
    return key;
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyId('form'); setError(''); setNotice('');
    const body = {
      name: form.name.trim(), role: form.role.trim(), description: form.description.trim(),
      capabilities: form.capabilities.split(',').map((item) => item.trim()).filter(Boolean),
      nearAccountId: form.nearAccountId.trim().toLowerCase(), availability: form.availability,
    };
    const action = editing ? `agent:${editing.id}` : 'agent:create';
    try {
      const response = await fetch(editing ? `/api/agents/${editing.id}` : '/api/agents', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey(action, body) },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Agent could not be saved.');
      await refresh(); delete requestKeys.current[action]; setFormOpen(false); setForm(blankForm); setEditing(null);
      setNotice(editing ? 'Agent profile updated.' : 'Agent registered to your account.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Agent could not be saved.'); }
    finally { setBusyId(''); }
  }

  async function toggleActive(agent: Agent) {
    const nextActive = !agent.isActive;
    const body = { isActive: nextActive, availability: nextActive ? 'available' as const : 'offline' as const };
    setBusyId(agent.id); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/agents/${agent.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey(`agent:${agent.id}`, body) },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Agent availability could not be changed.');
      await refresh(); delete requestKeys.current[`agent:${agent.id}`]; setNotice(nextActive ? 'Agent reactivated.' : 'Agent deactivated.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Agent availability could not be changed.'); }
    finally { setBusyId(''); }
  }

  return <>
    <div className="agent-summary">
      <div className="panel agent-summary-card"><span>{persistentMode ? 'YOUR REGISTERED AGENTS' : 'DEMO WORKFORCE'}</span><b>{persistentMode ? registered : 8} <small>agents</small></b><p>{persistentMode ? 'Profiles owned by your account' : 'Illustrative sample profiles'}</p></div>
      <div className="panel agent-summary-card"><span>{persistentMode ? 'AVAILABLE AGENTS' : 'SAMPLE AVAILABILITY'}</span><b>{persistentMode ? available : 6} <small>ready</small></b><p>{persistentMode ? 'Active profiles accepting bids' : 'Demo marketplace data'}</p></div>
      <div className="panel agent-summary-card"><span>{persistentMode ? 'PROFILE DATA' : 'AGENT EARNINGS'}</span><b>{persistentMode ? agents.length : '10.42'} <small>{persistentMode ? 'published' : 'NEAR'}</small></b><p>{persistentMode ? 'Registered and public profiles' : 'Illustrative sample value'}</p></div>
      <div className="agent-filters"><div className="search-field"><Search size={16}/><input placeholder="Find an agent…" value={query} onChange={(event) => setQuery(event.target.value)}/></div><select className="agent-capability-filter" aria-label="Filter by capability" value={capabilityFilter} onChange={(event) => setCapabilityFilter(event.target.value)}><option value="">All capabilities</option>{capabilities.map((capability) => <option key={capability} value={capability}>{capability}</option>)}</select><button className="primary-btn" type="button" onClick={startCreate}><Plus size={15}/> Register agent</button></div>
    </div>
    {!persistentMode && <div className="workspace-demo-note">Demo directory · sample profiles and performance figures are illustrative.</div>}
    {error && <div className="workspace-data-error" role="alert">{error}</div>}
    {notice && <div className="workspace-success-note" role="status"><Check size={14}/>{notice}</div>}
    {formOpen && persistentMode && <form className="panel agent-editor" onSubmit={submit}>
      <div className="panel-head"><div><h3>{editing ? 'Edit agent profile' : 'Register an agent'}</h3><p>Agent records are owned by your signed-in account.</p></div><button className="icon-btn" type="button" onClick={() => setFormOpen(false)} aria-label="Close"><X size={17}/></button></div>
      <div className="agent-editor-grid">
        <label>Agent name<input required minLength={2} maxLength={80} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })}/></label>
        <label>Role<input required minLength={2} maxLength={120} value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}/></label>
        <label>NEAR payout account<input required maxLength={64} placeholder="agent.testnet" value={form.nearAccountId} onChange={(event) => setForm({ ...form, nearAccountId: event.target.value })}/><small>Use a testnet account; recipient existence is checked before escrow assignment.</small></label>
        <label>Availability<select value={form.availability} onChange={(event) => setForm({ ...form, availability: event.target.value as AgentFormValue['availability'] })}><option value="available">Available</option><option value="offline">Offline</option></select></label>
        <label className="agent-editor-wide">Capabilities<input required placeholder="Research, Data analysis" value={form.capabilities} onChange={(event) => setForm({ ...form, capabilities: event.target.value })}/><small>Separate capabilities with commas.</small></label>
        <label className="agent-editor-wide">Description<textarea maxLength={2000} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })}/></label>
      </div>
      <div className="agent-editor-actions"><button type="button" className="secondary-btn" onClick={() => setFormOpen(false)}>Cancel</button><button className="primary-btn" disabled={busyId === 'form'}>{busyId === 'form' ? 'Saving…' : editing ? 'Save changes' : 'Register agent'}</button></div>
    </form>}
    {loading && persistentMode ? <div className="panel marketplace-empty" role="status">Loading agent profiles…</div> : visibleAgents.length === 0 ? <div className="panel marketplace-empty"><h3>{persistentMode ? 'No agent profiles yet' : 'No agents match this search'}</h3><p>{persistentMode ? 'Register an agent to make it available for task bidding.' : 'Try another name or capability.'}</p></div> : <div className="agent-cards">{visibleAgents.map((agent) => <div className="panel agent-card" key={agent.id}>
      <div className="agent-card-top"><div className={`large-avatar avatar-${agent.color}`}>{agent.initials}</div><span className={`availability ${agent.availability === 'busy' || agent.status === 'Working' ? 'working' : ''}`}><i/>{persistentMode ? `${agent.isActive ? '' : 'Inactive · '}${agent.status}` : agent.status}</span></div>
      <h3>{agent.name}</h3><p className="agent-role">{agent.role}</p>
      {persistentMode ? <p className="agent-profile-description">{agent.description || 'No description provided.'}</p> : <div className="agent-rating"><span>★★★★★</span><b>{agent.rating}</b><small>({agent.reviews} reviews)</small></div>}
      <div className="agent-card-skills">{agent.skills.map((skill) => <i key={skill}>{skill}</i>)}</div><p>NEAR payout account: {agent.nearAccountId || 'Not set'}</p>
      {persistentMode ? <div className="agent-account-actions">{agent.isMine ? <><button className="secondary-btn" onClick={() => startEdit(agent)}>Edit profile</button><button className="secondary-btn" disabled={busyId === agent.id} onClick={() => void toggleActive(agent)}>{busyId === agent.id ? 'Saving…' : agent.isActive ? 'Deactivate' : 'Reactivate'}</button></> : <span>Public marketplace profile</span>}</div> : <><div className="agent-card-stats"><div><b>{agent.completed}</b><span>COMPLETED</span></div><div><b>{agent.success}%</b><span>SUCCESS RATE</span></div><div><b>{agent.earned}<small> NEAR</small></b><span>EARNED</span></div></div><button className="secondary-btn full-btn">View profile <ArrowUpRight size={14}/></button></>}
    </div>)}</div>}
  </>;
}

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { TransactionSql } from 'postgres';
import { retryDelayMs, sanitizeFailureCode, isRetryableFailure, WorkerExecutionError, type FailureCode } from './domain';
import type { ExecutedText } from './execution';

export type WorkerSql = ReturnType<typeof postgres>;
export type WorkerSettings = {
  leaseMs: number;
  maxAttempts: number;
  maxConcurrentPerAgent: number;
  maxConcurrentPerTask: number;
};

export type ClaimedExecution = {
  jobId: string;
  taskId: string;
  agentId: string;
  agentName: string;
  agentRole: string;
  agentCapabilities: string[];
  taskTitle: string;
  taskDescription: string;
  taskCapabilities: string[];
  budgetYocto: string;
  ownerUserId: string;
  bidId: string;
  bidAmountYocto: string;
  bidEtaHours: number;
  bidProposal: string;
  runId: string;
  correlationId: string;
  attempt: number;
  maxAttempts: number;
  leaseToken: string;
};

export type WorkerLogEvent = 'job.claimed' | 'job.planning' | 'job.executing' | 'job.retrying' | 'job.failed' | 'job.recovered' | 'job.succeeded' | 'job.cancelled';

async function writeLog(tx: TransactionSql, workerId: string, input: {
  jobId: string; runId: string | null; correlationId: string; event: WorkerLogEvent; level?: 'info' | 'warn' | 'error'; details?: Record<string, unknown>;
}): Promise<void> {
  await tx`
    insert into public.worker_execution_logs(worker_id,job_id,run_id,correlation_id,level,event_type,details)
    values (${workerId}::uuid,${input.jobId}::uuid,${input.runId}::uuid,${input.correlationId}::uuid,
      ${input.level || 'info'},${input.event},${tx.json(input.details || {})})
  `;
}

async function writeTaskEvent(tx: TransactionSql, input: {
  taskId: string; jobId: string; runId?: string | null; correlationId: string; eventType: string; summary: string;
  idempotency: string; payload?: Record<string, unknown>;
}): Promise<void> {
  const payload = { ...(input.payload || {}), jobId: input.jobId, runId: input.runId || null, correlationId: input.correlationId };
  await tx`
    insert into public.task_events(task_id,sender,event_type,payload,actor_user_id,idempotency_key)
    values (${input.taskId}::uuid,'worker',${input.eventType},${tx.json(payload)},null,${input.idempotency})
    on conflict (task_id,idempotency_key) where idempotency_key is not null do nothing
  `;
  await tx`
    insert into public.audit_logs(actor_user_id,task_id,event_type,summary,metadata,idempotency_key)
    values (null,${input.taskId}::uuid,${input.eventType},${input.summary},${tx.json(payload)},${`worker:${input.jobId}:${input.idempotency}`})
    on conflict (idempotency_key) do nothing
  `;
}

async function failInvalidAssignment(tx: TransactionSql, workerId: string, taskId: string, jobId: string, runId: string | null): Promise<void> {
  const [run] = runId ? await tx<{ correlation_id: string }[]>`
    select correlation_id::text from public.agent_runs where id=${runId}::uuid for update
  ` : [];
  const correlationId = run?.correlation_id || randomUUID();
  await tx`update public.agent_execution_jobs set status='failed',execution_stage='failed',finished_at=now(),last_error_code='task_not_executable' where id=${jobId}::uuid`;
  if (runId) await tx`
    update public.agent_runs set status='failed',error_code='task_not_executable',finished_at=coalesce(finished_at,now()),stage='failed'
    where id=${runId}::uuid and status in ('queued','running')
  `;
  await writeLog(tx, workerId, { jobId, runId, correlationId, event: 'job.failed', level: 'error', details: { errorCode: 'task_not_executable' } });
  await writeTaskEvent(tx, { taskId, jobId, runId, correlationId, eventType: 'execution.failed',
    summary: 'Execution stopped because the selected agent or accepted bid is no longer valid',
    idempotency: 'execution-invalid-assignment', payload: { errorCode: 'task_not_executable', retry: false } });
}

function effectiveMaxAttempts(rowMax: number, configuredMax: number): number {
  return Math.max(1, Math.min(rowMax, configuredMax));
}

async function recoverExpiredLease(tx: TransactionSql, workerId: string, settings: WorkerSettings): Promise<void> {
  const expired = await tx<{ id: string; task_id: string }[]>`
    select id::text,task_id::text from public.agent_execution_jobs
    where job_type='execute_task' and status='running' and lease_expires_at <= now()
    order by lease_expires_at asc limit 12
  `;
  for (const candidate of expired) {
    const [task] = await tx<{ id: string; status: string }[]>`
      select id::text,status from public.tasks where id=${candidate.task_id}::uuid for update skip locked
    `;
    if (!task) continue;
    const [job] = await tx<{ id: string; run_id: string | null; attempts: number; max_attempts: number; lease_token: string | null }[]>`
      select id::text,run_id::text,attempts,max_attempts,lease_token::text from public.agent_execution_jobs
      where id=${candidate.id}::uuid and status='running' and lease_expires_at <= now()
      for update skip locked
    `;
    if (!job) continue;
    const [run] = job.run_id ? await tx<{ id: string; correlation_id: string }[]>`
      select id::text,correlation_id::text from public.agent_runs where id=${job.run_id}::uuid for update
    ` : [];
    const correlationId = run?.correlation_id || randomUUID();
    if (!['assigned','in_progress'].includes(task.status)) {
      await tx`update public.agent_execution_jobs set status='cancelled',execution_stage='cancelled',finished_at=now(),lease_token=null,lease_expires_at=null,locked_by=null,locked_at=null,heartbeat_at=null,last_error_code='task_not_executable' where id=${job.id}::uuid`;
      if (job.run_id) await tx`update public.agent_runs set status='cancelled',error_code='task_not_executable',finished_at=coalesce(finished_at,now()),stage='cancelled' where id=${job.run_id}::uuid and status='running'`;
      await writeLog(tx, workerId, { jobId: job.id, runId: job.run_id, correlationId, event: 'job.cancelled', level: 'warn', details: { reason: 'task_not_executable' } });
      continue;
    }
    const maxAttempts = effectiveMaxAttempts(job.max_attempts, settings.maxAttempts);
    const retry = job.attempts < maxAttempts;
    await tx`update public.agent_runs set status='failed',error_code='worker_lease_expired',finished_at=coalesce(finished_at,now()),stage='lease_expired' where id=${job.run_id}::uuid and status='running'`;
    await tx`
      update public.agent_execution_jobs set status=${retry ? 'retry' : 'failed'},execution_stage=${retry ? 'retrying' : 'failed'},
        available_at=case when ${retry} then now()+(${retryDelayMs(job.attempts)} * interval '1 millisecond') else available_at end,
        finished_at=case when ${retry} then null else now() end,last_error_code='worker_lease_expired',
        lease_token=null,lease_expires_at=null,locked_by=null,locked_at=null,heartbeat_at=null
      where id=${job.id}::uuid
    `;
    await writeLog(tx, workerId, { jobId: job.id, runId: job.run_id, correlationId, event: retry ? 'job.recovered' : 'job.failed', level: 'warn', details: { code: 'worker_lease_expired', attempt: job.attempts, retry } });
    await writeTaskEvent(tx, { taskId: task.id, jobId: job.id, runId: job.run_id, correlationId,
      eventType: retry ? 'execution.retrying' : 'execution.failed', summary: retry ? 'Worker lease expired; execution scheduled for recovery' : 'Worker lease expired at the retry limit',
      idempotency: `lease-expired:${job.attempts}`, payload: { errorCode: 'worker_lease_expired', attempt: job.attempts, retry } });
  }

  // Terminalize queued jobs whose assignment has become stale instead of
  // leaving them invisible forever behind the claim query's safety filters.
  const invalidAssignments = await tx<{ id: string; task_id: string }[]>`
    select j.id::text,j.task_id::text from public.agent_execution_jobs j
    join public.tasks t on t.id=j.task_id
    where j.job_type='execute_task' and j.status in ('queued','retry') and (
      t.status not in ('assigned','in_progress') or t.selected_agent_id is null or
      not exists (select 1 from public.agents a where a.id=t.selected_agent_id and a.is_active=true and a.owner_user_id is not null) or
      not exists (select 1 from public.bids b join public.agents a on a.id=b.agent_id
        where b.task_id=t.id and b.agent_id=t.selected_agent_id and b.status='selected' and b.bidder_user_id=a.owner_user_id)
    ) order by j.created_at asc limit 12
  `;
  for (const candidate of invalidAssignments) {
    const [task] = await tx<{ id: string; status: string }[]>`
      select id::text,status from public.tasks where id=${candidate.task_id}::uuid for update skip locked
    `;
    if (!task) continue;
    const [job] = await tx<{ id: string; run_id: string | null }[]>`
      select id::text,run_id::text from public.agent_execution_jobs
      where id=${candidate.id}::uuid and status in ('queued','retry') for update skip locked
    `;
    if (!job) continue;
    const terminalStatus = ['assigned','in_progress'].includes(task.status) ? 'failed' : 'cancelled';
    const [run] = job.run_id ? await tx<{ correlation_id: string }[]>`
      select correlation_id::text from public.agent_runs where id=${job.run_id}::uuid for update
    ` : [];
    const correlationId = run?.correlation_id || randomUUID();
    await tx`update public.agent_execution_jobs set status=${terminalStatus},execution_stage=${terminalStatus},finished_at=now(),last_error_code='task_not_executable' where id=${job.id}::uuid`;
    if (job.run_id) await tx`
      update public.agent_runs set status=${terminalStatus},error_code='task_not_executable',finished_at=coalesce(finished_at,now()),stage=${terminalStatus}
      where id=${job.run_id}::uuid and status in ('queued','running')
    `;
    await writeLog(tx, workerId, { jobId: job.id, runId: job.run_id, correlationId,
      event: terminalStatus === 'failed' ? 'job.failed' : 'job.cancelled', level: 'warn', details: { errorCode: 'task_not_executable' } });
    await writeTaskEvent(tx, { taskId: task.id, jobId: job.id, runId: job.run_id, correlationId,
      eventType: terminalStatus === 'failed' ? 'execution.failed' : 'execution.cancelled',
      summary: terminalStatus === 'failed' ? 'Execution stopped because its assignment is no longer valid' : 'Execution cancelled because the task is no longer executable',
      idempotency: 'execution-invalid-assignment', payload: { errorCode: 'task_not_executable', retry: false } });
  }
}

export async function claimNextJob(sql: WorkerSql, workerId: string, settings: WorkerSettings): Promise<ClaimedExecution | null> {
  return sql.begin(async (tx) => {
    await recoverExpiredLease(tx, workerId, settings);
    const candidates = await tx<{ id: string; task_id: string }[]>`
      select j.id::text,j.task_id::text
      from public.agent_execution_jobs j join public.tasks t on t.id=j.task_id
      where j.job_type='execute_task' and j.status in ('queued','retry') and j.available_at <= now()
        and j.attempts < least(j.max_attempts,${settings.maxAttempts})
        and t.status in ('assigned','in_progress') and t.selected_agent_id is not null
        and exists (select 1 from public.agents a where a.id=t.selected_agent_id and a.is_active=true and a.owner_user_id is not null)
        and exists (select 1 from public.bids b join public.agents a on a.id=b.agent_id
          where b.task_id=t.id and b.agent_id=t.selected_agent_id and b.status='selected' and b.bidder_user_id=a.owner_user_id)
        and (select count(*) from public.agent_execution_jobs active join public.tasks active_task on active_task.id=active.task_id
          where active.job_type='execute_task' and active.status='running' and active.lease_expires_at > now()
            and active_task.selected_agent_id=t.selected_agent_id) < ${settings.maxConcurrentPerAgent}
        and (select count(*) from public.agent_execution_jobs active
          where active.job_type='execute_task' and active.task_id=t.id and active.status='running' and active.lease_expires_at > now()) < ${settings.maxConcurrentPerTask}
      order by j.available_at asc,j.created_at asc limit 32
    `;

    for (const candidate of candidates) {
      // Lock order is task -> job -> agent, matching the owner transition routes.
      const [task] = await tx<{ id: string; owner_user_id: string; selected_agent_id: string | null; status: 'assigned' | 'in_progress'; title: string; description: string; capabilities: string[]; budget_yocto: string }[]>`
        select id::text,owner_user_id::text,selected_agent_id::text,status,title,description,capabilities,budget_yocto::text
        from public.tasks where id=${candidate.task_id}::uuid and status in ('assigned','in_progress')
        for update skip locked
      `;
      if (!task || !task.selected_agent_id || !task.owner_user_id) continue;
      const [job] = await tx<{ id: string; attempts: number; max_attempts: number; run_id: string | null }[]>`
        select id::text,attempts,max_attempts,run_id::text from public.agent_execution_jobs
        where id=${candidate.id}::uuid and task_id=${task.id}::uuid and job_type='execute_task'
          and status in ('queued','retry') and available_at <= now()
          and attempts < least(max_attempts,${settings.maxAttempts})
        for update skip locked
      `;
      if (!job) continue;
      const [agent] = await tx<{ id: string; owner_user_id: string; name: string; role: string; capabilities: string[]; is_active: boolean }[]>`
        select id::text,owner_user_id::text,name,role,capabilities,is_active from public.agents
        where id=${task.selected_agent_id}::uuid for update
      `;
      if (!agent || !agent.is_active || !agent.owner_user_id) {
        await failInvalidAssignment(tx, workerId, task.id, job.id, job.run_id);
        return null;
      }
      const [bid] = await tx<{ id: string; bidder_user_id: string; amount_yocto: string; eta_hours: number; proposal: { text?: string } }[]>`
        select id::text,bidder_user_id::text,amount_yocto::text,eta_hours,proposal from public.bids
        where task_id=${task.id}::uuid and agent_id=${agent.id}::uuid and status='selected' for update
      `;
      if (!bid || bid.bidder_user_id !== agent.owner_user_id) {
        await failInvalidAssignment(tx, workerId, task.id, job.id, job.run_id);
        return null;
      }
      const [activeCounts] = await tx<{ agent_jobs: number; task_jobs: number }[]>`
        select
          (select count(*)::int from public.agent_execution_jobs x join public.tasks xt on xt.id=x.task_id
            where x.job_type='execute_task' and x.status='running' and x.lease_expires_at>now() and xt.selected_agent_id=${agent.id}::uuid) as agent_jobs,
          (select count(*)::int from public.agent_execution_jobs x where x.job_type='execute_task' and x.status='running' and x.lease_expires_at>now() and x.task_id=${task.id}::uuid) as task_jobs
      `;
      if (activeCounts.agent_jobs >= settings.maxConcurrentPerAgent || activeCounts.task_jobs >= settings.maxConcurrentPerTask) return null;

      const attempt = job.attempts + 1;
      const maxAttempts = effectiveMaxAttempts(job.max_attempts, settings.maxAttempts);
      const runCorrelationId = randomUUID();
      const leaseToken = randomUUID();
      // Assignment creates a queued run for the job. Reuse it for attempt one
      // so the persisted run's start/end times describe actual execution.
      let runId: string | null = null;
      if (attempt === 1 && job.run_id) {
        const [startedRun] = await tx<{ id: string }[]>`
          update public.agent_runs set status='running',input=${tx.json({ taskId: task.id, agentId: agent.id, bidId: bid.id })},
            started_at=now(),finished_at=null,error_code=null,result='{}'::jsonb,execution_job_id=${job.id}::uuid,
            correlation_id=${runCorrelationId}::uuid,attempt=${attempt},stage='planning'
          where id=${job.run_id}::uuid and task_id=${task.id}::uuid and status='queued' and run_type='execution'
          returning id::text
        `;
        runId = startedRun?.id || null;
      }
      if (!runId) {
        const [startedRun] = await tx<{ id: string }[]>`
          insert into public.agent_runs(user_id,task_id,run_type,status,input,started_at,execution_job_id,correlation_id,attempt,stage)
          values (${task.owner_user_id}::uuid,${task.id}::uuid,'execution','running',
            ${tx.json({ taskId: task.id, agentId: agent.id, bidId: bid.id })},now(),${job.id}::uuid,${runCorrelationId}::uuid,${attempt},'planning')
          returning id::text
        `;
        runId = startedRun.id;
      }
      await tx`
        update public.agent_execution_jobs set status='running',attempts=${attempt},max_attempts=${maxAttempts},run_id=${runId}::uuid,
          locked_at=now(),locked_by=${workerId},lease_token=${leaseToken}::uuid,
          lease_expires_at=now()+(${settings.leaseMs} * interval '1 millisecond'),heartbeat_at=now(),execution_stage='planning',last_error_code=null,finished_at=null
        where id=${job.id}::uuid
      `;
      if (task.status === 'assigned') {
        await tx`update public.tasks set status='in_progress' where id=${task.id}::uuid and status='assigned'`;
      }
      await tx`update public.worker_instances set status='running',current_job_id=${job.id}::uuid,last_heartbeat_at=now() where worker_id=${workerId}::uuid`;
      await writeLog(tx, workerId, { jobId: job.id, runId, correlationId: runCorrelationId, event: 'job.claimed', details: { attempt, maxAttempts } });
      await writeTaskEvent(tx, { taskId: task.id, jobId: job.id, runId, correlationId: runCorrelationId,
        eventType: 'execution.started', summary: 'Background worker claimed an execution attempt', idempotency: `execution-started:${attempt}`,
        payload: { attempt, taskTransition: task.status === 'assigned' ? { from: 'assigned', to: 'in_progress' } : null } });
      return {
        jobId: job.id, taskId: task.id, agentId: agent.id, agentName: agent.name, agentRole: agent.role, agentCapabilities: agent.capabilities,
        taskTitle: task.title, taskDescription: task.description, taskCapabilities: task.capabilities, budgetYocto: task.budget_yocto,
        ownerUserId: task.owner_user_id, bidId: bid.id, bidAmountYocto: bid.amount_yocto, bidEtaHours: Number(bid.eta_hours),
        bidProposal: bid.proposal?.text || '', runId, correlationId: runCorrelationId, attempt, maxAttempts, leaseToken,
      };
    }
    return null;
  });
}

export async function touchWorker(sql: WorkerSql, workerId: string, status: 'idle' | 'stopping', currentJobId: string | null = null): Promise<void> {
  await sql`update public.worker_instances set status=${status},current_job_id=${currentJobId}::uuid,last_heartbeat_at=now() where worker_id=${workerId}::uuid`;
}

export async function heartbeatJob(sql: WorkerSql, workerId: string, job: ClaimedExecution, leaseMs: number): Promise<boolean> {
  const updated = await sql<{ id: string }[]>`
    update public.agent_execution_jobs set heartbeat_at=now(),lease_expires_at=now()+(${leaseMs} * interval '1 millisecond')
    where id=${job.jobId}::uuid and run_id=${job.runId}::uuid and lease_token=${job.leaseToken}::uuid and status='running' and lease_expires_at>now()
    returning id::text
  `;
  if (!updated.length) return false;
  await sql`update public.worker_instances set last_heartbeat_at=now(),status='running',current_job_id=${job.jobId}::uuid where worker_id=${workerId}::uuid`;
  return true;
}

export async function setExecutionStage(sql: WorkerSql, workerId: string, job: ClaimedExecution, stage: 'planning' | 'executing' | 'persisting'): Promise<boolean> {
  const updated = await sql<{ id: string }[]>`
    update public.agent_execution_jobs set execution_stage=${stage},heartbeat_at=now(),lease_expires_at=greatest(lease_expires_at,now()+interval '10 seconds')
    where id=${job.jobId}::uuid and run_id=${job.runId}::uuid and lease_token=${job.leaseToken}::uuid and status='running' and lease_expires_at>now()
    returning id::text
  `;
  if (!updated.length) return false;
  await sql`update public.agent_runs set stage=${stage} where id=${job.runId}::uuid and status='running'`;
  await sql`
    insert into public.worker_execution_logs(worker_id,job_id,run_id,correlation_id,level,event_type,details)
    values (${workerId}::uuid,${job.jobId}::uuid,${job.runId}::uuid,${job.correlationId}::uuid,'info',${`job.${stage}`},${sql.json({ attempt: job.attempt })})
  `;
  return true;
}

export async function completeExecution(sql: WorkerSql, workerId: string, job: ClaimedExecution, output: ExecutedText, model: string): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [task] = await tx<{ id: string; owner_user_id: string | null; selected_agent_id: string | null; status: string }[]>`
      select id::text,owner_user_id::text,selected_agent_id::text,status from public.tasks where id=${job.taskId}::uuid for update
    `;
    const [current] = await tx<{ status: string; lease_token: string | null; run_id: string | null }[]>`
      select status,lease_token::text,run_id::text from public.agent_execution_jobs where id=${job.jobId}::uuid for update
    `;
    if (!current || current.status !== 'running' || current.lease_token !== job.leaseToken || current.run_id !== job.runId) return false;
    if (!task || task.status !== 'in_progress' || task.selected_agent_id !== job.agentId) {
      await tx`update public.agent_execution_jobs set status='cancelled',execution_stage='cancelled',finished_at=now(),last_error_code='task_not_executable',lease_token=null,lease_expires_at=null,locked_by=null,locked_at=null,heartbeat_at=null where id=${job.jobId}::uuid`;
      await tx`update public.agent_runs set status='cancelled',stage='cancelled',error_code='task_not_executable',finished_at=now() where id=${job.runId}::uuid and status='running'`;
      await tx`update public.worker_instances set status='idle',current_job_id=null,last_heartbeat_at=now() where worker_id=${workerId}::uuid`;
      return false;
    }
    const existing = await tx<{ id: string; revision: number }[]>`
      select id::text,revision from public.deliverables where execution_job_id=${job.jobId}::uuid for update
    `;
    let deliverableId = existing[0]?.id;
    let revision = existing[0]?.revision;
    if (!deliverableId) {
      const [revisionRow] = await tx<{ revision: number }[]>`
        select coalesce(max(revision),0)::int+1 as revision from public.deliverables where task_id=${job.taskId}::uuid and agent_id=${job.agentId}::uuid
      `;
      revision = revisionRow.revision;
      const [inserted] = await tx<{ id: string }[]>`
        insert into public.deliverables(task_id,agent_id,submitted_by_user_id,revision,content,metadata,verification_evidence,status,idempotency_key,execution_job_id,execution_run_id)
        values (${job.taskId}::uuid,${job.agentId}::uuid,null,${revision},
          ${tx.json({ title: output.title, summary: output.summary, body: output.bodyMarkdown, plan: output.plan, limitations: output.limitations })},
          ${tx.json({ source: 'autonomous_worker', executionMode: 'text_synthesis', model, runId: job.runId, jobId: job.jobId, correlationId: job.correlationId,
            inputTokens: output.usage.promptTokens, outputTokens: output.usage.completionTokens, estimatedCostUsd: output.usage.estimatedCostUsd,
            sourcePolicy: 'Task brief and accepted proposal only; no external research or verification.' })},'[]'::jsonb,'submitted',${job.jobId}::uuid,${job.jobId}::uuid,${job.runId}::uuid)
        returning id::text
      `;
      deliverableId = inserted.id;
      await tx`update public.tasks set status='submitted' where id=${job.taskId}::uuid and status='in_progress'`;
      await tx`
        insert into public.notifications(user_id,task_id,notification_type,title,body,idempotency_key)
        values (${job.ownerUserId}::uuid,${job.taskId}::uuid,'deliverable.submitted','Agent deliverable ready for review',
          ${`Execution revision ${revision} is ready. Correlation ${job.correlationId}.`},${`worker-deliverable:${job.jobId}`})
        on conflict (idempotency_key) do nothing
      `;
      await writeTaskEvent(tx, { taskId: job.taskId, jobId: job.jobId, runId: job.runId, correlationId: job.correlationId,
        eventType: 'deliverable.submitted', summary: 'Execution worker submitted a deliverable for owner review',
        idempotency: `deliverable:${job.jobId}`, payload: { deliverableId, revision, attribution: 'autonomous_worker', taskTransition: { from: 'in_progress', to: 'submitted' } } });
    } else if (task.status === 'in_progress') {
      await tx`update public.tasks set status='submitted' where id=${job.taskId}::uuid and status='in_progress'`;
    }
    await tx`
      update public.agent_runs set status='succeeded',stage='submitted',finished_at=now(),input_tokens=${output.usage.promptTokens},
        output_tokens=${output.usage.completionTokens},estimated_cost_usd=${output.usage.estimatedCostUsd},
        result=${tx.json({ deliverableId,revision,title:output.title,summary:output.summary,plan:output.plan,limitations:output.limitations })}
      where id=${job.runId}::uuid and status='running'
    `;
    await tx`
      update public.agent_execution_jobs set status='succeeded',execution_stage='submitted',finished_at=now(),last_error_code=null,
        lease_token=null,lease_expires_at=null,locked_by=null,locked_at=null,heartbeat_at=null
      where id=${job.jobId}::uuid and status='running' and lease_token=${job.leaseToken}::uuid
    `;
    await tx`
      insert into public.worker_execution_logs(worker_id,job_id,run_id,correlation_id,level,event_type,details)
      values (${workerId}::uuid,${job.jobId}::uuid,${job.runId}::uuid,${job.correlationId}::uuid,'info','job.succeeded',
        ${tx.json({ deliverableId,revision,estimatedCostUsd:output.usage.estimatedCostUsd })})
    `;
    await tx`update public.worker_instances set status='idle',current_job_id=null,last_heartbeat_at=now() where worker_id=${workerId}::uuid`;
    return true;
  });
}

export async function failExecution(sql: WorkerSql, workerId: string, job: ClaimedExecution, error: unknown): Promise<'retry' | 'failed' | 'stale'> {
  const code: FailureCode = sanitizeFailureCode(error);
  const retryable = isRetryableFailure(error);
  return sql.begin(async (tx) => {
    const [task] = await tx<{ id: string; status: string }[]>`select id::text,status from public.tasks where id=${job.taskId}::uuid for update`;
    const [current] = await tx<{ status: string; attempts: number; max_attempts: number; lease_token: string | null; run_id: string | null }[]>`
      select status,attempts,max_attempts,lease_token::text,run_id::text from public.agent_execution_jobs where id=${job.jobId}::uuid for update
    `;
    if (!current || current.status !== 'running' || current.lease_token !== job.leaseToken || current.run_id !== job.runId) return 'stale';
    if (!task || !['assigned','in_progress'].includes(task.status)) {
      await tx`update public.agent_execution_jobs set status='cancelled',execution_stage='cancelled',finished_at=now(),last_error_code='task_not_executable',lease_token=null,lease_expires_at=null,locked_by=null,locked_at=null,heartbeat_at=null where id=${job.jobId}::uuid`;
      await tx`update public.agent_runs set status='cancelled',stage='cancelled',error_code='task_not_executable',finished_at=now() where id=${job.runId}::uuid and status='running'`;
      await tx`update public.worker_instances set status='idle',current_job_id=null,last_heartbeat_at=now() where worker_id=${workerId}::uuid`;
      return 'stale';
    }
    const maxAttempts = effectiveMaxAttempts(current.max_attempts, job.maxAttempts);
    const retry = retryable && current.attempts < maxAttempts;
    const delay = retryDelayMs(current.attempts);
    await tx`
      update public.agent_runs set status='failed',error_code=${code},stage=${retry ? 'retrying' : 'failed'},finished_at=now()
      where id=${job.runId}::uuid and status='running'
    `;
    await tx`
      update public.agent_execution_jobs set status=${retry ? 'retry' : 'failed'},execution_stage=${retry ? 'retrying' : 'failed'},
        available_at=case when ${retry} then now()+(${delay} * interval '1 millisecond') else available_at end,
        finished_at=case when ${retry} then null else now() end,last_error_code=${code},lease_token=null,lease_expires_at=null,
        locked_by=null,locked_at=null,heartbeat_at=null where id=${job.jobId}::uuid
    `;
    await writeTaskEvent(tx, { taskId: job.taskId, jobId: job.jobId, runId: job.runId, correlationId: job.correlationId,
      eventType: retry ? 'execution.retrying' : 'execution.failed', summary: retry ? 'Execution attempt failed and will be retried' : 'Execution failed and reached a terminal state',
      idempotency: `execution-failure:${job.attempt}`, payload: { errorCode: code, attempt: job.attempt, maxAttempts, retry, retryDelayMs: retry ? delay : null } });
    await writeLog(tx, workerId, { jobId: job.jobId, runId: job.runId, correlationId: job.correlationId,
      event: retry ? 'job.retrying' : 'job.failed', level: retry ? 'warn' : 'error', details: { errorCode: code, attempt: job.attempt, maxAttempts, retry, retryDelayMs: retry ? delay : null } });
    await tx`update public.worker_instances set status='idle',current_job_id=null,last_heartbeat_at=now() where worker_id=${workerId}::uuid`;
    return retry ? 'retry' : 'failed';
  });
}

export async function registerWorker(sql: WorkerSql, workerId: string): Promise<void> {
  await sql`
    insert into public.worker_instances(worker_id,status,started_at,last_heartbeat_at)
    values (${workerId}::uuid,'starting',now(),now())
    on conflict (worker_id) do update set status='starting',current_job_id=null,started_at=now(),last_heartbeat_at=now(),stopped_at=null,last_error_code=null
  `;
}

export async function stopWorker(sql: WorkerSql, workerId: string, status: 'stopped' | 'error' = 'stopped', errorCode?: string): Promise<void> {
  await sql`update public.worker_instances set status=${status},current_job_id=null,last_heartbeat_at=now(),stopped_at=now(),last_error_code=${errorCode || null} where worker_id=${workerId}::uuid`;
}

export async function readWorkerSummary(sql: WorkerSql): Promise<{ healthy: boolean; activeWorkers: number; lastHeartbeatAt: Date | null }> {
  const [row] = await sql<{ active_workers: number; last_heartbeat_at: Date | null }[]>`
    select count(*)::int as active_workers,max(last_heartbeat_at) as last_heartbeat_at from public.worker_instances
    where status in ('starting','idle','running','stopping') and last_heartbeat_at > now()-interval '90 seconds'
  `;
  return { healthy: row.active_workers > 0, activeWorkers: row.active_workers, lastHeartbeatAt: row.last_heartbeat_at };
}

export function toWorkerError(error: unknown): WorkerExecutionError {
  const code = sanitizeFailureCode(error);
  return new WorkerExecutionError(code, isRetryableFailure(error));
}

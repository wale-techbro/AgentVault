import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { failExecution, claimNextJob, completeExecution, registerWorker, stopWorker, type ClaimedExecution, type WorkerSql } from './store';
import { WorkerExecutionError } from './domain';
import type { ExecutedText } from './execution';

// Run only against a separately provisioned, disposable PostgreSQL database
// with migrations 001-004 applied. Never point this at the application database.
const databaseUrl = process.env.WORKER_TEST_DATABASE_URL?.trim();
const sql = databaseUrl ? postgres(databaseUrl, { max: 6, prepare: false, ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : 'require' }) : null;
const workerIds: string[] = [];
const taskIds: string[] = [];
const agentIds: string[] = [];
const ownerIds: string[] = [];
const settings = { leaseMs: 30_000, maxAttempts: 4, maxConcurrentPerAgent: 1, maxConcurrentPerTask: 1 };

describe.skipIf(!databaseUrl)('PostgreSQL worker queue integration', () => {
  afterAll(async () => {
    if (!sql) return;
    for (const workerId of workerIds) {
      await sql`delete from public.worker_execution_logs where worker_id=${workerId}::uuid`;
      await sql`delete from public.worker_instances where worker_id=${workerId}::uuid`;
    }
    for (const taskId of taskIds) await sql`delete from public.tasks where id=${taskId}::uuid`;
    for (const agentId of agentIds) await sql`delete from public.agents where id=${agentId}::uuid`;
    for (const ownerId of ownerIds) await sql`delete from auth.users where id=${ownerId}::uuid`;
    await sql.end({ timeout: 5 });
  });

  it('claims once across workers, recovers leases, backs off retries, and stores one unapproved deliverable', async () => {
    if (!sql) throw new Error('WORKER_TEST_DATABASE_URL is required.');
    const ownerId = randomUUID(); ownerIds.push(ownerId);
    const agentId = randomUUID(); agentIds.push(agentId);
    const taskId = randomUUID(); taskIds.push(taskId);
    const bidId = randomUUID();
    const runId = randomUUID();
    const jobId = randomUUID();
    const workerA = randomUUID(); workerIds.push(workerA);
    const workerB = randomUUID(); workerIds.push(workerB);
    const workerC = randomUUID(); workerIds.push(workerC);

    await sql`insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      values (${ownerId}::uuid,'authenticated','authenticated',${`${ownerId}@agentvault.integration.invalid`},'',now(),'{}'::jsonb,'{}'::jsonb,now(),now())`;
    await sql`insert into public.agents(id,account_id,name,role,capabilities,status,owner_user_id,description,availability,is_active)
      values (${agentId}::uuid,${`av${agentId.replaceAll('-', '').slice(0, 12)}.testnet`},'Integration Writer','Writer',array['writing'],'idle',${ownerId}::uuid,'Worker integration fixture','busy',true)`;
    await sql`insert into public.tasks(id,owner_account_id,owner_user_id,owner_near_account_id,title,description,budget_yocto,capabilities,status,selected_agent_id)
      values (${taskId}::uuid,${`av${ownerId.replaceAll('-', '').slice(0, 12)}.testnet`},${ownerId}::uuid,${`av${ownerId.replaceAll('-', '').slice(0, 12)}.testnet`},
        'Integration task','Summarize the supplied integration test notes into a short draft.',1000000000000000000000000,array['writing'],'assigned',${agentId}::uuid)`;
    await sql`insert into public.bids(id,task_id,agent_id,bidder_user_id,amount_yocto,eta_hours,capability_score,proposal,status)
      values (${bidId}::uuid,${taskId}::uuid,${agentId}::uuid,${ownerId}::uuid,1000000000000000000000000,12,95,${sql.json({ text: 'Summarize only supplied notes.' })},'selected')`;
    await sql`insert into public.agent_runs(id,user_id,task_id,run_type,status,input)
      values (${runId}::uuid,${ownerId}::uuid,${taskId}::uuid,'execution','queued',${sql.json({ agentId, bidId })})`;
    await sql`insert into public.agent_execution_jobs(id,task_id,run_id,job_type,status,idempotency_key,payload)
      values (${jobId}::uuid,${taskId}::uuid,${runId}::uuid,'execute_task','queued',${`integration:${jobId}`},${sql.json({ agentId, bidId })})`;
    await Promise.all([registerWorker(sql, workerA), registerWorker(sql, workerB), registerWorker(sql, workerC)]);

    const [claimA, claimB] = await Promise.all([claimNextJob(sql, workerA, settings), claimNextJob(sql, workerB, settings)]);
    const first = (claimA || claimB) as ClaimedExecution | null;
    expect(first).not.toBeNull();
    expect([claimA, claimB].filter(Boolean)).toHaveLength(1);
    expect(first?.attempt).toBe(1);
    const firstRunId = first!.runId;

    await sql`update public.agent_execution_jobs set lease_expires_at=now()-interval '1 second' where id=${jobId}::uuid`;
    expect(await claimNextJob(sql, workerC, settings)).toBeNull();
    const [recovered] = await sql<{ status: string; last_error_code: string; available_at: Date }[]>`
      select status,last_error_code,available_at from public.agent_execution_jobs where id=${jobId}::uuid`;
    expect(recovered).toMatchObject({ status: 'retry', last_error_code: 'worker_lease_expired' });
    const [expiredRun] = await sql<{ status: string; finished_at: Date | null }[]>`select status,finished_at from public.agent_runs where id=${firstRunId}::uuid`;
    expect(expiredRun.status).toBe('failed');
    expect(expiredRun.finished_at).not.toBeNull();
    await sql`update public.agent_execution_jobs set available_at=now()-interval '1 second' where id=${jobId}::uuid and status='retry'`;

    const second = await claimNextJob(sql, workerC, settings);
    expect(second?.attempt).toBe(2);
    expect(second?.runId).not.toBe(firstRunId);
    expect(await failExecution(sql, workerC, second!, new WorkerExecutionError('ai_timeout', true))).toBe('retry');
    const [backoff] = await sql<{ status: string; available_at: Date; attempts: number }[]>`
      select status,available_at,attempts from public.agent_execution_jobs where id=${jobId}::uuid`;
    expect(backoff.status).toBe('retry');
    expect(backoff.attempts).toBe(2);
    expect(backoff.available_at.getTime()).toBeGreaterThan(Date.now());
    expect(await sql<{ count: number }[]>`select count(*)::int as count from public.deliverables where task_id=${taskId}::uuid`).toMatchObject([{ count: 0 }]);
    await sql`update public.agent_execution_jobs set available_at=now()-interval '1 second' where id=${jobId}::uuid and status='retry'`;

    const third = await claimNextJob(sql, workerA, settings);
    expect(third?.attempt).toBe(3);
    const output: ExecutedText = {
      title: 'Integration deliverable', summary: 'A short response created from the test fixture task information.',
      bodyMarkdown: 'This is a bounded integration test output based only on the supplied task description and accepted proposal. It is submitted for human owner review, is not verified or approved, and does not trigger a wallet or escrow call.',
      plan: ['Read task brief', 'Prepare a concise draft'], limitations: ['No external research or verification was performed.'],
      usage: { promptTokens: 120, completionTokens: 160, estimatedCostUsd: 0.0056 },
    };
    expect(await completeExecution(sql, workerA, third!, output, 'mock-test-model')).toBe(true);
    expect(await completeExecution(sql, workerA, third!, output, 'mock-test-model')).toBe(false);
    const [result] = await sql<{ task_status: string; job_status: string; deliverable_status: string; approved_at: Date | null; deliverable_count: number; release_receipts: number; run_count: number }[]>`
      select t.status as task_status,j.status as job_status,d.status as deliverable_status,d.reviewed_at as approved_at,
        (select count(*)::int from public.deliverables where execution_job_id=j.id) as deliverable_count,
        (select count(*)::int from public.escrow_receipts er where er.task_id=t.id and er.action='release') as release_receipts,
        (select count(*)::int from public.agent_runs r where r.execution_job_id=j.id) as run_count
      from public.tasks t join public.agent_execution_jobs j on j.task_id=t.id join public.deliverables d on d.execution_job_id=j.id
      where t.id=${taskId}::uuid
    `;
    expect(result).toMatchObject({ task_status: 'submitted', job_status: 'succeeded', deliverable_status: 'submitted', approved_at: null, deliverable_count: 1, release_receipts: 0, run_count: 3 });
    await Promise.all([stopWorker(sql, workerA), stopWorker(sql, workerB), stopWorker(sql, workerC)]);
  }, 30_000);
});

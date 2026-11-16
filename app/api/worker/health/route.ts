import { NextResponse } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth';
import { databaseIsConfigured, getDatabase } from '@/lib/db/postgres';
import { readWorkerSummary } from '@/lib/worker/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireAuthenticatedUser();
  if (!auth.user) return NextResponse.json({ error: auth.error }, { status: auth.status, headers: { 'Cache-Control': 'no-store' } });
  if (!databaseIsConfigured()) return NextResponse.json({ error: 'Database is not configured.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  try {
    const summary = await readWorkerSummary(getDatabase());
    return NextResponse.json({ ...summary, checkedAt: new Date().toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Worker health is unavailable. Confirm migration 004 and database connectivity.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}

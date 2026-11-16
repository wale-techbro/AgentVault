import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const nextPath = request.nextUrl.searchParams.get('next') || '/';
  const destination = new URL(nextPath, request.nextUrl.origin);
  const safePath = nextPath.startsWith('/') && destination.origin === request.nextUrl.origin ? `${destination.pathname}${destination.search}${destination.hash}` : '/';
  const supabase = await createSupabaseServerClient();
  if (!supabase || !code) return NextResponse.redirect(new URL('/login?error=auth_callback_failed', request.url));
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(new URL('/login?error=auth_callback_failed', request.url));
  return NextResponse.redirect(new URL(safePath, request.url));
}

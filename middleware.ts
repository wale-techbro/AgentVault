import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseConfig } from '@/lib/supabase/config';

const publicPaths = new Set(['/login', '/auth/callback']);

export async function middleware(request: NextRequest) {
  const config = getSupabaseConfig();
  if (!config) return NextResponse.next(); // Local demo mode until Supabase is configured.
  if (request.nextUrl.pathname.startsWith('/api/') || publicPaths.has(request.nextUrl.pathname)) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(config.url, config.key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
      },
    },
  });

  const { data, error } = await supabase.auth.getClaims();
  if (error && request.cookies.getAll().some(({ name }) => name.startsWith('sb-'))) {
    return new NextResponse('Authentication service is temporarily unavailable.', { status: 503 });
  }
  if (!data?.claims) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};

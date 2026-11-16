import { createSupabaseServerClient } from '@/lib/supabase/server';

export type AuthenticatedUser = { id: string; email: string | null };
export type AuthResult = { user: AuthenticatedUser; error: null } | { user: null; status: 401 | 503; error: string };

export async function requireAuthenticatedUser(): Promise<AuthResult> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { user: null, status: 503, error: 'Authentication is not configured. Set the Supabase URL and publishable key.' };
  const { data, error } = await supabase.auth.getUser();
  if (error) return { user: null, status: error.status && error.status >= 500 ? 503 : 401, error: error.status && error.status >= 500 ? 'Authentication service is temporarily unavailable.' : 'Sign in to continue.' };
  if (!data.user) return { user: null, status: 401, error: 'Sign in to continue.' };
  return { user: { id: data.user.id, email: data.user.email ?? null }, error: null };
}

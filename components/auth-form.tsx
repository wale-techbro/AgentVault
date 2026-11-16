'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

type Mode = 'signin' | 'signup' | 'recover' | 'update';

export default function AuthForm({ nextPath, callbackError }: { nextPath?: string; callbackError?: string }) {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [message, setMessage] = useState(callbackError ? 'The sign-in link could not be verified. Request a new one.' : '');
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  useEffect(() => { if (pathname === '/reset-password') setMode('update'); }, [pathname]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) { setMessage('Authentication is not configured. Add the Supabase URL and publishable key to the server environment.'); return; }
    setBusy(true); setMessage('');
    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({ email, password, options: { data: { display_name: displayName.trim() }, emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath || '/')}` } });
        if (error) throw error;
        setMessage('Check your email for a verification link. Your account will be ready after verification.');
      } else if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.replace(nextPath?.startsWith('/') && !nextPath.startsWith('//') ? nextPath : '/'); router.refresh();
      } else if (mode === 'recover') {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/auth/callback?next=%2Freset-password` });
        if (error) throw error;
        setMessage('If an account exists for that email, a password reset link is on its way.');
      } else {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        setMessage('Password updated. You can sign in with the new password.'); setMode('signin'); setPassword('');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Authentication could not be completed.');
    } finally { setBusy(false); }
  }

  const heading = { signin: 'Welcome back', signup: 'Create your account', recover: 'Reset your password', update: 'Choose a new password' }[mode];
  return <section className="auth-card"><div className="auth-kicker">AGENT OPERATIONS</div><h1>{heading}</h1><p className="auth-description">Sign in to manage tasks, bids, and escrow activity across your workspace.</p>
    <form onSubmit={submit}>
      {mode === 'signup' && <label>Name<input required maxLength={120} value={displayName} onChange={(e)=>setDisplayName(e.target.value)} autoComplete="name"/></label>}
      {mode !== 'update' && <label>Email<input required type="email" maxLength={254} value={email} onChange={(e)=>setEmail(e.target.value)} autoComplete="email"/></label>}
      {mode !== 'recover' && <label>{mode === 'update' ? 'New password' : 'Password'}<input required type="password" minLength={mode === 'update' ? 8 : 8} maxLength={72} value={password} onChange={(e)=>setPassword(e.target.value)} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}/></label>}
      <button className="auth-submit" disabled={busy}>{busy?'Working…':mode==='signin'?'Sign in':mode==='signup'?'Create account':mode==='recover'?'Send reset link':'Update password'}</button>
    </form>
    {message&&<p className="auth-message" role="status">{message}</p>}
    <div className="auth-links">{mode==='signin'&&<><button onClick={()=>setMode('signup')}>Create account</button><button onClick={()=>setMode('recover')}>Forgot password?</button></>}{mode!=='signin'&&mode!=='update'&&<button onClick={()=>setMode('signin')}>Back to sign in</button>}</div>
  </section>;
}

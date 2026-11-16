'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

export default function AccountControl() {
  const [email, setEmail] = useState('');
  const [configured, setConfigured] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    if (!supabase) return;
    setConfigured(true);
    void supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? ''));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setEmail(session?.user.email ?? ''));
    return () => data.subscription.unsubscribe();
  }, []);

  if (!configured) return <span className="demo-auth-status">Demo workspace</span>;
  return <div className="account-control"><span>{email}</span><button onClick={async()=>{ const client=createSupabaseBrowserClient(); await client?.auth.signOut(); router.replace('/login'); router.refresh(); }}>Sign out</button></div>;
}

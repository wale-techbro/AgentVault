import AuthForm from '@/components/auth-form';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const params = await searchParams;
  return <main className="auth-shell"><div className="auth-brand"><span>av</span><b>AGENTVAULT</b></div><AuthForm nextPath={params.next} callbackError={params.error}/><p className="auth-foot">NEAR testnet transactions require your wallet’s own approval.</p></main>;
}

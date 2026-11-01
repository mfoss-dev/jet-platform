import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

// Reads the session (cookies), so it renders per request. Streaming behind <Suspense> can come later
// (see node_modules/next/dist/docs/01-app/02-guides/authentication-with-cache-components.md).
export const instant = false;

async function sendLink(formData: FormData) {
  'use server';
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const next = String(formData.get('next') ?? '/');
  if (!/^\S+@\S+\.\S+$/.test(email)) redirect('/login?error=email');

  const h = await headers();
  const origin = h.get('origin') ?? `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('host')}`;
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}` },
  });
  redirect(error ? `/login?error=send&detail=${encodeURIComponent(error.message)}` : `/login?sent=${encodeURIComponent(email)}`);
}

const ERRORS: Record<string, string> = {
  email: 'Please enter a valid email address.',
  send: 'The sign-in email could not be sent.',
  link: 'That sign-in link has expired or was already used. Send a new one.',
};

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const sent = one(sp.sent);
  const error = one(sp.error);
  const detail = one(sp.detail);

  return (
    <div className="login">
      <div className="art">
        <h2>Jet Worldwide</h2>
        <p>Book, track, bill and report from one place.</p>
      </div>
      <div className="box">
        <form action={sendLink}>
          <div className="logo" style={{ color: 'var(--ink)', padding: 0 }}><i>J</i>Jet Platform</div>
          <h1>Sign in</h1>
          {sent ? (
            <div className="banner">Check <b>{sent}</b> for a sign-in link. It works once and expires after an hour.</div>
          ) : (
            <>
              <div><label htmlFor="email">Work email</label><input id="email" name="email" type="email" autoComplete="email" required /></div>
              <input type="hidden" name="next" value={one(sp.next) ?? '/'} />
              <button className="btn primary block">Email me a sign-in link</button>
            </>
          )}
          {error && <div className="banner" role="alert">{ERRORS[error] ?? 'Something went wrong.'}{detail ? ` (${detail})` : ''}</div>}
          <div className="hint">Test environment. Staff get their role from an invitation; anyone else signs in with no access.</div>
        </form>
      </div>
    </div>
  );
}

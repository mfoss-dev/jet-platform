import { headers } from 'next/headers';

// Sends email through Resend (resend.com) when RESEND_API_KEY and EMAIL_FROM are set on the server (Vercel
// environment variables); until then nothing is sent and callers say so. EMAIL_FROM must be on a domain verified
// in Resend, e.g. "Jet Worldwide <accounts@jetworldwide.com.au>".
export const emailConfigured = () => Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);

export type Mail = { to: string[]; subject: string; text: string };

// Returns whether the email went. Failures are logged, never thrown: a notification must not undo the work.
export async function sendEmail(mail: Mail): Promise<boolean> {
  const to = [...new Set(mail.to.filter(Boolean))];
  if (!emailConfigured() || !to.length) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to, subject: mail.subject, text: mail.text }),
    });
    if (!res.ok) console.error(`Email not sent (${res.status}): ${await res.text()}`);
    return res.ok;
  } catch (e) {
    console.error('Email not sent:', e);
    return false;
  }
}

// A full link back into the app, from the request's own host.
export async function appLink(path: string) {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}${path}`;
}

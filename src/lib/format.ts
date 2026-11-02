export const money = (n: number | string | null | undefined) =>
  n == null ? '—' : `$${Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'Australia/Sydney' }) : '—';

export const dayTime = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Sydney' })
    : '—';

// Supabase returns a to-one embed as an object, but its types can't always tell; this accepts either.
export const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export const BILLING_EDITORS = ['owner', 'management', 'finance', 'admin'];

// Time windows for server-rendered pages (rendered once per request, so "now" is the request time).
export const msAgo = (days: number) => Date.now() - days * 864e5;
export function startOfMonth() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

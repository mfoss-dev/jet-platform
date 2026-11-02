import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BILLING_EDITORS, day, dayTime, money, one } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { placeHold, releaseHold, saveTerms } from '../actions';
import { HOLD_REASON } from '../labels';

type Customer = {
  id: string; account_code: string; name: string; branch_code: string; status: 'active' | 'on_hold' | 'closed';
  payment_terms_days: number; billing_email: string | null; hold_reason: string | null; hold_note: string | null;
  held_at: string | null; created_at: string; rep: { full_name: string } | null;
};
type Change = { id: number; at: string; actor_email: string | null; action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null };

const FIELDS: Record<string, string> = {
  status: 'Status', hold_reason: 'Hold reason', hold_note: 'Hold note', payment_terms_days: 'Terms (days)', billing_email: 'Billing email', name: 'Name', rep_id: 'Rep',
};

// Turns an audit row into "Status: active → on hold" lines, skipping timestamps.
function describe(c: Change) {
  if (c.action === 'insert') return ['Account created'];
  return Object.keys(FIELDS)
    .filter((k) => JSON.stringify(c.before?.[k] ?? null) !== JSON.stringify(c.after?.[k] ?? null))
    .map((k) => `${FIELDS[k]}: ${String(c.before?.[k] ?? '—').replace('_', ' ')} → ${String(c.after?.[k] ?? '—').replace('_', ' ')}`);
}

export default async function CustomerDetail({ params, searchParams }: PageProps<'/stream/customers/[id]'>) {
  const me = await getMe();
  if (!me.apps.includes('stream')) notFound();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const msg = (await searchParams).msg;

  const supabase = await createClient();
  const [{ data }, { data: jobs }, { data: history }] = await Promise.all([
    supabase.from(SELECTS.customer.table).select(SELECTS.customer.select).eq('id', id).maybeSingle(),
    supabase.from(SELECTS.customerJobs.table).select(SELECTS.customerJobs.select).eq('customer_id', id).order('booked_at', { ascending: false }).limit(10),
    supabase.from(SELECTS.history.table).select(SELECTS.history.select).eq('table_name', 'customers').eq('row_id', id).order('at', { ascending: false }).limit(20),
  ]);
  if (!data) notFound();
  const c = { ...(data as unknown as Customer), rep: one((data as unknown as Customer).rep) };
  const canEdit = BILLING_EDITORS.includes(me.role);
  const changes = ((history ?? []) as Change[]).map((h) => ({ ...h, lines: describe(h) })).filter((h) => h.lines.length);

  return (
    <>
      <div className="top">
        <div>
          <h1>{c.name} · {c.account_code}</h1>
          <div className="sub">
            {c.branch_code === 'NZ' ? 'Auckland' : 'Sydney'} · Rep: {c.rep?.full_name || 'House'} ·{' '}
            {c.status === 'on_hold' ? `on hold since ${day(c.held_at)}` : c.status}
          </div>
        </div>
        <div className="acts"><Link className="btn" href="/stream/customers">← Customers</Link></div>
      </div>

      {typeof msg === 'string' && <div className={`banner ${msg.startsWith('Not saved') || msg.startsWith('Choose') || msg.startsWith('Terms') ? 'warn' : ''}`} role="status">{msg}</div>}

      <div className="grid k11">
        <div className="card">
          <h3>Billing &amp; terms</h3>
          <form action={saveTerms} className="form" style={{ gridTemplateColumns: '1fr' }}>
            <input type="hidden" name="id" value={c.id} />
            <div>
              <label htmlFor="terms">Payment terms (days)</label>
              <input id="terms" name="payment_terms_days" type="number" min={0} max={120} defaultValue={c.payment_terms_days} disabled={!canEdit} />
            </div>
            <div>
              <label htmlFor="email">Invoice email</label>
              <input id="email" name="billing_email" type="email" defaultValue={c.billing_email ?? ''} disabled={!canEdit} />
            </div>
            <div className="hint">Currency {c.branch_code === 'NZ' ? 'NZD · GST 15%' : 'AUD · GST 10%'} (set by the branch).</div>
            {canEdit && <div><button className="btn primary">Save</button></div>}
          </form>
        </div>

        <div className="card">
          <h3>Account hold</h3>
          <p>
            Status: <b>{c.status === 'on_hold' ? 'On hold' : c.status === 'active' ? 'Active' : 'Closed'}</b>
            {c.status === 'on_hold' && <> · {HOLD_REASON[c.hold_reason ?? '']}{c.hold_note ? ` · “${c.hold_note}”` : ''}</>}
          </p>
          {canEdit && (c.status === 'on_hold' ? (
            <form action={releaseHold}>
              <input type="hidden" name="id" value={c.id} />
              <button className="btn primary">Release hold</button>
            </form>
          ) : (
            <form action={placeHold} className="form" style={{ gridTemplateColumns: '1fr' }}>
              <input type="hidden" name="id" value={c.id} />
              <div>
                <label htmlFor="reason">Reason</label>
                <select id="reason" name="hold_reason" className="f" required defaultValue="">
                  <option value="" disabled>Choose…</option>
                  {Object.entries(HOLD_REASON).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="note">Note</label>
                <input id="note" name="hold_note" placeholder="e.g. Promised payment Friday" />
              </div>
              <div><button className="btn">Place on hold</button></div>
            </form>
          ))}
          <p className="hint mt8">On hold, the customer can&apos;t book in the portal (portal phase); jobs already booked still bill.</p>
        </div>
      </div>

      <div className="grid k11 mt">
        <div className="card">
          <h3>Recent jobs</h3>
          {(jobs ?? []).length ? (
            <table>
              <thead><tr><th>Connote</th><th>Booked</th><th>To</th><th className="r">Charge</th><th>Billing</th></tr></thead>
              <tbody>
                {(jobs ?? []).map((j) => (
                  <tr key={j.id}>
                    <td><b>{j.connote}</b></td><td>{day(j.booked_at)}</td><td>{j.dest_city}</td><td className="r">{money(j.sell_ex_gst)}</td>
                    <td><span className={`pill ${j.billing_status === 'needs_attention' ? 'bad' : j.billing_status === 'ready' ? 'ok' : ''}`}>{String(j.billing_status).replace('_', ' ')}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="hint">No jobs yet.</p>}
        </div>
        <div className="card">
          <h3>History</h3>
          {changes.length ? (
            <table>
              <tbody>
                {changes.map((h) => (
                  <tr key={h.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{dayTime(h.at)}</td>
                    <td>{h.actor_email ?? 'System'}</td>
                    <td>{h.lines.map((l) => <div key={l}>{l}</div>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="hint">{canEdit ? 'No changes recorded yet.' : 'History is visible to finance and management.'}</p>}
        </div>
      </div>
    </>
  );
}

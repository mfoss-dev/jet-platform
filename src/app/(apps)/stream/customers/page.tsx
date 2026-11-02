import Link from 'next/link';
import { notFound } from 'next/navigation';
import { day, one } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { HOLD_REASON } from './labels';

type Row = {
  id: string; account_code: string; name: string; branch_code: string; status: 'active' | 'on_hold' | 'closed';
  payment_terms_days: number; billing_email: string | null; hold_reason: string | null; held_at: string | null;
  rep: { full_name: string } | null;
};

const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

export default async function Customers({ searchParams }: PageProps<'/stream/customers'>) {
  const me = await getMe();
  if (!me.apps.includes('stream')) notFound();
  const sp = await searchParams;
  const q = pick(sp.q).trim();
  const branch = pick(sp.branch);
  const status = pick(sp.status);

  const supabase = await createClient();
  let query = supabase.from(SELECTS.customers.table).select(SELECTS.customers.select).order('name').limit(500);
  if (branch === 'AU' || branch === 'NZ') query = query.eq('branch_code', branch);
  if (['active', 'on_hold', 'closed'].includes(status)) query = query.eq('status', status);
  if (q) {
    const like = `%${q.replace(/[%_,()]/g, ' ')}%`;
    query = query.or(`name.ilike.${like},account_code.ilike.${like},billing_email.ilike.${like}`);
  }
  const { data, error } = await query;
  const rows = ((data ?? []) as unknown as Row[]).map((r) => ({ ...r, rep: one(r.rep) }));

  // Exceptions per customer, so finance can see who is holding up the invoice run.
  const { data: open } = await supabase.from(SELECTS.openJobs.table).select(SELECTS.openJobs.select).eq('billing_status', 'needs_attention');
  const openBy = (open ?? []).reduce<Record<string, number>>((a, j) => { a[j.customer_id] = (a[j.customer_id] ?? 0) + 1; return a; }, {});

  return (
    <>
      <div className="top">
        <div><h1>Customers</h1><div className="sub">Accounts, terms and credit control</div></div>
      </div>

      <form className="filters" action="/stream/customers">
        <input name="q" defaultValue={q} placeholder="Search account, name or email…" aria-label="Search customers" />
        <select name="branch" defaultValue={branch} className="f" aria-label="Branch">
          <option value="">All branches</option><option value="AU">Sydney (AU)</option><option value="NZ">Auckland (NZ)</option>
        </select>
        <select name="status" defaultValue={status} className="f" aria-label="Status">
          <option value="">All statuses</option><option value="active">Active</option><option value="on_hold">On hold</option><option value="closed">Closed</option>
        </select>
        <button className="btn">Filter</button>
        {(q || branch || status) && <Link className="btn ghost" href="/stream/customers">Clear</Link>}
      </form>

      {error ? <div className="banner warn" role="alert">Couldn&apos;t load customers: {error.message}</div> : (
        <div className="card" style={{ padding: 0 }}>
          <div className="tw">
            <table>
              <thead><tr><th>Account</th><th>Name</th><th>Branch</th><th>Rep</th><th className="r">Terms</th><th className="r">Exceptions</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="click">
                    <td><Link href={`/stream/customers/${c.id}`}><b>{c.account_code}</b></Link></td>
                    <td><Link href={`/stream/customers/${c.id}`}>{c.name}</Link></td>
                    <td>{c.branch_code}</td>
                    <td>{c.rep?.full_name || <span className="hint">House</span>}</td>
                    <td className="r">{c.payment_terms_days} days</td>
                    <td className="r">{openBy[c.id] ? <span className="pill bad">{openBy[c.id]}</span> : <span className="hint">0</span>}</td>
                    <td>
                      {c.status === 'on_hold'
                        ? <span className="pill bad" title={`Since ${day(c.held_at)}`}>On hold · {HOLD_REASON[c.hold_reason ?? ''] ?? 'Hold'}</span>
                        : <span className={`pill ${c.status === 'active' ? 'ok' : ''}`}>{c.status === 'active' ? 'Active' : 'Closed'}</span>}
                    </td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={7} className="hint">No customers match.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

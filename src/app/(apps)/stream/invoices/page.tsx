import Link from 'next/link';
import { notFound } from 'next/navigation';
import { day, money, one } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { setCreditLimit } from './actions';
import { STATUS } from './labels';

type Inv = { id: string; branch_code: string; number: number | null; kind: string; invoice_date: string; due_date: string | null; total: number; status: string; flags: string[]; reason: string | null; bill_to: { id: string; name: string; account_code: string } | null };

const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const PAGE = 100;
const KIND: Record<string, string> = { weekly: 'Weekly', duties: 'Duties', credit: 'Credit note' };
const mondayThisWeek = () => {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

export default async function Invoices({ searchParams }: PageProps<'/stream/invoices'>) {
  const me = await getMe();
  if (!me.apps.includes('stream')) notFound();
  const sp = await searchParams;
  const q = pick(sp.q).trim();
  const branch = pick(sp.branch);
  const kind = pick(sp.kind);
  const page = Math.max(0, Number(pick(sp.page)) || 0);
  const msg = pick(sp.msg);
  const supabase = await createClient();
  const { data: draftData } = await supabase.from(SELECTS.invoiceList.table).select(SELECTS.invoiceList.select).eq('kind', 'credit').eq('status', 'draft').order('invoice_date').limit(100);
  const draftCredits = ((draftData ?? []) as unknown as Inv[]).map((i) => ({ ...i, bill_to: one(i.bill_to) }));
  const [{ data: queueData }, { data: limitData }] = await Promise.all([
    supabase.from(SELECTS.creditQueue.table).select(SELECTS.creditQueue.select).limit(100),
    supabase.from(SELECTS.creditLimits.table).select(SELECTS.creditLimits.select).order('code'),
  ]);
  const queue = new Map((queueData ?? []).map((q) => [q.id, q]));
  const limits = limitData ?? [];
  const isManager = ['owner', 'management'].includes(me.role);

  let list = supabase.from(SELECTS.invoiceList.table).select(SELECTS.invoiceList.select, { count: 'exact' }).neq('status', 'draft');
  if (branch) list = list.eq('branch_code', branch);
  if (kind) list = list.eq('kind', kind);
  if (/^\d+$/.test(q)) list = list.eq('number', Number(q));
  else if (q) {
    const { data: who } = await supabase.from(SELECTS.customerPicker.table).select('id')
      .or(`name.ilike.%${q.replace(/[%_,()]/g, ' ')}%,account_code.ilike.%${q.replace(/[%_,()]/g, ' ')}%`).limit(200);
    list = list.in('bill_to_id', (who ?? []).map((c) => c.id));
  }
  const { data, count } = await list.order('invoice_date', { ascending: false }).order('number', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
  const rows = ((data ?? []) as unknown as Inv[]).map((i) => ({ ...i, bill_to: one(i.bill_to) }));
  const pages = Math.ceil((count ?? 0) / PAGE);
  const link = (p: number) => ({ pathname: '/stream/invoices', query: { ...(q ? { q } : {}), ...(branch ? { branch } : {}), ...(kind ? { kind } : {}), page: p } });

  return (
    <>
      <div className="top">
        <div><h1>Invoices &amp; credits</h1><div className="sub">Every approved invoice and credit note, including JetStream&apos;s history since July 2026 · raise a credit note from the invoice</div></div>
        {kind === 'credit' && (
          <div className="flex">
            {['AU', 'NZ'].map((b) => <a key={b} className="btn sm" href={`/stream/invoices/myob?branch=${b}&from=${mondayThisWeek()}&to=${new Date().toISOString().slice(0, 10)}`}>MYOB file · {b} credits this week</a>)}
          </div>
        )}
      </div>
      {msg && <div className={`banner ${/^Not /.test(msg) ? 'warn' : ''}`} role="status">{msg}</div>}
      {draftCredits.length > 0 && (
        <div className="card">
          <h3>Credit notes waiting for approval ({draftCredits.length})</h3>
          <table className="mt8">
            <thead><tr><th>Bill to</th><th>Branch</th><th>Raised</th><th>Reason</th><th className="r">Amount</th><th>Approves</th></tr></thead>
            <tbody>
              {draftCredits.map((i) => {
                const qd = queue.get(i.id);
                return (
                  <tr key={i.id}>
                    <td><Link href={`/stream/invoices/${i.id}`}>{i.bill_to?.name}</Link> <span className="hint">{i.bill_to?.account_code}</span></td>
                    <td>{i.branch_code}</td><td>{day(i.invoice_date)}{qd?.raised_by ? <span className="hint"> · {qd.raised_by}</span> : ''}</td><td>{i.reason}</td><td className="r">{money(i.total)}</td>
                    <td>{qd?.needs_management ? 'Management' : 'Finance'}{qd?.i_can_approve && <span className="pill ok" style={{ marginLeft: 6 }}>You can</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {kind === 'credit' && (
        <div className="card">
          <h3>Credit approval limit</h3>
          <p className="hint">Finance approve credit notes up to this amount (inc GST). Above it, management approves, and never the person who raised it.</p>
          <div className="flex mt8">
            {limits.map((b) => isManager ? (
              <form key={b.code} action={setCreditLimit} className="flex">
                <input type="hidden" name="branch" value={b.code} />
                <label htmlFor={`lim-${b.code}`}>{b.name} ({b.currency})</label>
                <input id={`lim-${b.code}`} name="limit" type="number" min="0" step="1" defaultValue={Number(b.credit_approval_limit)} style={{ width: 110 }} />
                <button className="btn sm">Save</button>
              </form>
            ) : <span key={b.code}>{b.name}: <b>{money(b.credit_approval_limit)}</b> {b.currency}</span>)}
          </div>
        </div>
      )}
      <form className="filters" action="/stream/invoices">
        <input name="q" defaultValue={q} placeholder="Invoice number, account or name" aria-label="Search invoices" />
        <select name="branch" className="f" defaultValue={branch} aria-label="Branch" style={{ width: 'auto' }}>
          <option value="">Both branches</option><option value="AU">Sydney</option><option value="NZ">Auckland</option>
        </select>
        <select name="kind" className="f" defaultValue={kind} aria-label="Type" style={{ width: 'auto' }}>
          <option value="">All types</option><option value="weekly">Weekly</option><option value="duties">Duties</option><option value="credit">Credit notes</option>
        </select>
        <button className="btn">Search</button>
        <span className="hint">{(count ?? 0).toLocaleString()} {kind === 'credit' ? 'credit notes' : 'invoices'}{pages > 1 ? ` · page ${page + 1} of ${pages}` : ''}</span>
        {page > 0 && <Link className="btn sm" href={link(page - 1)}>← Newer</Link>}
        {page + 1 < pages && <Link className="btn sm" href={link(page + 1)}>Older →</Link>}
      </form>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Number</th><th>Bill to</th><th>Branch</th><th>Type</th><th>Date</th><th>Due</th><th className="r">Total</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id}>
                <td><Link href={`/stream/invoices/${i.id}`}><b>{i.number ?? '—'}</b></Link></td>
                <td>{i.bill_to?.name} <span className="hint">{i.bill_to?.account_code}</span></td>
                <td>{i.branch_code}</td><td>{KIND[i.kind] ?? i.kind}</td>
                <td>{day(i.invoice_date)}</td><td>{day(i.due_date)}</td><td className="r">{money(i.total)}</td>
                <td><span className={`pill ${STATUS[i.status]?.[1] ?? ''}`}>{STATUS[i.status]?.[0] ?? i.status}</span></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={8} className="hint">No invoices match.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

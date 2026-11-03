import Link from 'next/link';
import { notFound } from 'next/navigation';
import { day, money } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';

type Inv = { id: string; branch_code: string; number: number | null; kind: string; invoice_date: string; due_date: string | null; terms_code: string | null; total: number; status: string; credit_for: string | null };

const KIND: Record<string, string> = { weekly: 'Freight', duties: 'Duties & taxes', credit: 'Credit note' };
const PERIOD: Record<string, [string, number]> = { '3': ['Last 3 months', 92], '6': ['Last 6 months', 183], '12': ['Last 12 months', 366], all: ['All', 0] };
const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const isoDaysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

// The customer's invoices and credit notes: download each as a PDF, with the shipment CSV alongside.
// Row-level security limits this to invoices the person's account pays; staff see every customer's.
export default async function PortalInvoices({ searchParams }: PageProps<'/portal/inv'>) {
  const me = await getMe();
  if (!me.apps.includes('portal')) notFound();
  const sp = await searchParams;
  const q = pick(sp.q).trim();
  const kind = KIND[pick(sp.kind)] ? pick(sp.kind) : '';
  const period = PERIOD[pick(sp.period)] ? pick(sp.period) : '6';
  const supabase = await createClient();

  let list = supabase.from(SELECTS.portalInvoices.table).select(SELECTS.portalInvoices.select).in('status', ['approved', 'sent', 'exported']);
  if (kind) list = list.eq('kind', kind);
  if (PERIOD[period][1]) list = list.gte('invoice_date', isoDaysAgo(PERIOD[period][1]));
  if (/^\d{1,8}$/.test(q)) list = list.eq('number', Number(q));
  else if (q) {
    // A connote (or part of one): the invoices its lines are on.
    const { data: hits } = await supabase.from('charges').select('invoice_id').ilike('connote', `%${q.replace(/[%_,()]/g, '')}%`).not('invoice_id', 'is', null).limit(200);
    list = list.in('id', [...new Set((hits ?? []).map((h) => h.invoice_id as string))]);
  }
  const [{ data }, { data: me2 }, { data: recent }] = await Promise.all([
    list.order('invoice_date', { ascending: false }).order('number', { ascending: false }).limit(300),
    supabase.from('customers').select('name, payment_terms_code, payment_terms_days').eq('account_code', me.accountCode ?? '').maybeSingle(),
    supabase.from(SELECTS.portalInvoices.table).select('total, kind').in('status', ['approved', 'sent', 'exported']).gte('invoice_date', isoDaysAgo(30)).limit(500),
  ]);
  const rows = (data ?? []) as unknown as Inv[];
  const numbers = new Map(rows.map((r) => [r.id, r.number]));
  const last30 = (recent ?? []).filter((r) => r.kind !== 'credit').reduce((a, r) => a + Number(r.total), 0);
  const credits30 = (recent ?? []).filter((r) => r.kind === 'credit').reduce((a, r) => a + Number(r.total), 0);
  const latest = rows.find((r) => r.kind !== 'credit');
  const terms = me2?.payment_terms_code ?? (me2?.payment_terms_days != null ? `${me2.payment_terms_days} days` : '—');

  return (
    <>
      <div className="top">
        <div>
          <h1>Invoices</h1>
          <div className="sub">{me.customerName ? `Invoices and credit notes for ${me.customerName}` : 'Every customer’s invoices (you are signed in as staff)'} · download as PDF, with the shipment detail as CSV</div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <div className="card kpi"><div className="l">Invoiced in the last 30 days</div><div className="v">{money(last30)}</div><div className="d">inc GST</div></div>
        <div className="card kpi"><div className="l">Latest invoice</div><div className="v">{latest ? money(latest.total) : '—'}</div><div className="d">{latest ? `No ${latest.number} · due ${day(latest.due_date)}` : 'None yet'}</div></div>
        <div className="card kpi"><div className="l">Credits in the last 30 days</div><div className="v">{money(credits30)}</div><div className="d">Credit notes against your invoices</div></div>
        <div className="card kpi"><div className="l">Payment terms</div><div className="v">{terms}</div><div className="d">Counted from the day we send the invoice</div></div>
      </div>

      <form className="filters mt" action="/portal/inv">
        <input name="q" defaultValue={q} placeholder="Invoice number or connote" aria-label="Search invoices" />
        <select name="kind" className="f" defaultValue={kind} aria-label="Type">
          <option value="">All types</option>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select name="period" className="f" defaultValue={period} aria-label="Period">
          {Object.entries(PERIOD).map(([k, [v]]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className="btn">Search</button>
        {(q || kind || period !== '6') && <Link className="btn ghost" href="/portal/inv">Clear</Link>}
      </form>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Number</th><th>Type</th><th>Date</th><th>Due</th><th className="r">Amount</th><th>Download</th></tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id}>
                <td><a href={`/invoices/${i.id}/pdf`} target="_blank" rel="noreferrer"><b>{i.number}</b></a></td>
                <td>{KIND[i.kind] ?? i.kind}{i.kind === 'credit' && i.credit_for && numbers.get(i.credit_for) ? <span className="hint"> · against {numbers.get(i.credit_for)}</span> : ''}</td>
                <td>{day(i.invoice_date)}</td>
                <td>{i.kind === 'credit' ? '—' : day(i.due_date)}</td>
                <td className="r">{money(i.total)}</td>
                <td><div className="flex">
                  <a className="btn sm" href={`/invoices/${i.id}/pdf`} target="_blank" rel="noreferrer">PDF</a>
                  <a className="btn sm ghost" href={`/invoices/${i.id}/csv`}>CSV</a>
                </div></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={6} className="hint">{q ? 'No invoices match that search.' : 'No invoices in this period.'}</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="hint mt8">Showing up to 300. Questions about an invoice? Contact accounts@jetworldwide.com.au.</p>
    </>
  );
}

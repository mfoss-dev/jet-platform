import Link from 'next/link';
import { notFound } from 'next/navigation';
import { day, money } from '@/lib/format';
import { isoDaysAgo, PERIOD, readFilters, shipmentsQuery, STATUS, type Shipment } from '@/lib/portal-shipments';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';

const PAGE = 100;
const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

// My shipments: every shipment the customer's account sent, whether invoiced yet or not. Amounts appear once a
// shipment is invoiced (before that the price can still change). Staff see every customer's.
export default async function MyShipments({ searchParams }: PageProps<'/portal/list'>) {
  const me = await getMe();
  if (!me.apps.includes('portal')) notFound();
  const sp = await searchParams;
  const f = readFilters(sp);
  const page = Math.max(0, Number(pick(sp.page)) || 0);
  const supabase = await createClient();

  const [{ data, count, error }, { data: recent }] = await Promise.all([
    shipmentsQuery(supabase, f, true).range(page * PAGE, page * PAGE + PAGE - 1),
    supabase.rpc('portal_shipments').select('status, total').gte('shipped_on', isoDaysAgo(31)).limit(5000),
  ]);
  const rows = (data ?? []) as unknown as Shipment[];
  const pages = Math.ceil((count ?? 0) / PAGE);
  const last30 = (recent ?? []) as { status: string; total: number | null }[];
  const query = { ...(f.q ? { q: f.q } : {}), ...(f.status ? { status: f.status } : {}), period: f.period };
  const link = (p: number) => ({ pathname: '/portal/list', query: { ...query, page: p } });
  const csv = `/portal/list/csv?${new URLSearchParams(query)}`;
  const staff = !me.customerName;

  return (
    <>
      <div className="top">
        <div>
          <h1>My shipments</h1>
          <div className="sub">{staff ? 'Every customer’s shipments (you are signed in as staff)' : `Shipments sent on ${me.customerName}’s account`} · amounts show once invoiced</div>
        </div>
        <a className="btn" href={csv}>Download CSV</a>
      </div>
      {error && <div className="banner warn" role="status">Shipments couldn&apos;t be loaded: {error.message}</div>}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <div className="card kpi"><div className="l">Shipments in the last 30 days</div><div className="v">{last30.length.toLocaleString()}</div></div>
        <div className="card kpi"><div className="l">Not yet invoiced</div><div className="v">{last30.filter((r) => r.status === 'to_invoice').length.toLocaleString()}</div><div className="d">Go on your next invoice</div></div>
        <div className="card kpi"><div className="l">Invoiced, last 30 days</div><div className="v">{money(last30.reduce((a, r) => a + Number(r.total ?? 0), 0))}</div><div className="d">inc GST</div></div>
      </div>

      <form className="filters mt" action="/portal/list">
        <input name="q" defaultValue={f.q} placeholder="Connote or your reference" aria-label="Search shipments" />
        <select name="status" className="f" defaultValue={f.status} aria-label="Status">
          <option value="">All</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select name="period" className="f" defaultValue={f.period} aria-label="Period">
          {Object.entries(PERIOD).map(([k, [v]]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className="btn">Search</button>
        {(f.q || f.status || f.period !== '3') && <Link className="btn ghost" href="/portal/list">Clear</Link>}
        <span className="hint">{(count ?? 0).toLocaleString()} shipments{pages > 1 ? ` · page ${page + 1} of ${pages}` : ''}</span>
        {page > 0 && <Link className="btn sm" href={link(page - 1)}>← Newer</Link>}
        {page + 1 < pages && <Link className="btn sm" href={link(page + 1)}>Older →</Link>}
      </form>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Connote</th><th>Shipped</th><th>Service</th><th>Reference</th><th>From → to</th><th className="r">Pcs</th><th className="r">Kg</th><th>Invoice</th><th className="r">Amount</th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={`${s.connote}-${s.kind}-${s.account_code}`}>
                <td><b>{s.connote}</b>{(staff || s.account_code !== me.accountCode) && <div className="hint">{staff ? `${s.customer_name} · ` : ''}{s.account_code}</div>}</td>
                <td>{day(s.shipped_on)}</td>
                <td>{s.kind === 'duties' ? 'Customs duties' : s.service_name ?? s.service_code ?? '—'}</td>
                <td>{s.reference ?? ''}</td>
                <td>{[s.orig_country, s.dest_country].filter(Boolean).join(' → ')}</td>
                <td className="r">{s.pieces ?? ''}</td>
                <td className="r">{s.weight == null ? '' : Number(s.weight)}</td>
                <td>{s.status === 'invoiced' && s.invoice_id
                  ? <a href={`/invoices/${s.invoice_id}/pdf`} target="_blank" rel="noreferrer">{s.invoice_number}</a>
                  : <span className="pill warn">{STATUS.to_invoice}</span>}</td>
                <td className="r">{s.total == null ? '' : money(s.total)}</td>
              </tr>
            ))}
            {!rows.length && !error && <tr><td colSpan={9} className="hint">{f.q ? 'No shipments match that search.' : 'No shipments in this period.'}</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

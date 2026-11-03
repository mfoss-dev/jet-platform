import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { SalesHeader } from '@/components/SalesHeader';
import { Sparkline, WeeklyBars } from '@/components/SalesCharts';
import { day, money } from '@/lib/format';
import { byRep, change, HEALTH, loadSales, series, withDuties } from '@/lib/sales';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';

const pct = (n: number | null) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n}%`);

// JetSales overview (Kym, Chris): sales over the last 13 weeks, how each rep is trading, new and lost accounts.
// Reps go straight to their own page.
export default async function SalesOverview({ searchParams }: PageProps<'/sales/overview'>) {
  const me = await getMe();
  if (!me.apps.includes('sales')) notFound();
  if (me.role === 'sales_rep') redirect('/sales/rep');
  const duties = withDuties(await searchParams);
  const supabase = await createClient();
  const { accounts, weekly, asOf, mondays, error } = await loadSales(supabase, duties);
  const reps = byRep(accounts, weekly, mondays);
  const total = (k: 'sales_4w' | 'sales_prev_4w' | 'sales_13w') => accounts.reduce((s, a) => s + a[k], 0);
  const active = accounts.filter((a) => a.shipments_13w > 0);
  const atRisk = accounts.filter((a) => a.health === 'at_risk');
  const fresh = accounts.filter((a) => a.health === 'new').sort((a, b) => b.sales_13w - a.sales_13w).slice(0, 8);
  const lost = accounts.filter((a) => a.health === 'lost').sort((a, b) => b.sales_total - a.sales_total).slice(0, 8);
  const query = duties ? { duties: '1' } : {};

  return (
    <>
      <SalesHeader title="Sales overview" sub="Both branches, every rep" asOf={asOf} duties={duties} path="/sales/overview" />
      {error && <div className="banner warn">Sales couldn&apos;t be loaded: {error.message}</div>}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <div className="card kpi"><div className="l">Last 4 weeks</div><div className="v">{money(total('sales_4w'))}</div><div className="d">{pct(change(total('sales_4w'), total('sales_prev_4w')))} on the 4 weeks before</div></div>
        <div className="card kpi"><div className="l">Last 13 weeks</div><div className="v">{money(total('sales_13w'))}</div><div className="d">{accounts.reduce((s, a) => s + a.shipments_13w, 0).toLocaleString()} shipments</div></div>
        <div className="card kpi"><div className="l">Active accounts</div><div className="v">{active.length.toLocaleString()}</div><div className="d">Shipped in the last 13 weeks · {fresh.length ? `${accounts.filter((a) => a.health === 'new').length} new` : 'none new'}</div></div>
        <div className="card kpi"><div className="l">Accounts at risk</div><div className="v">{atRisk.length}</div><div className="d"><Link href={{ pathname: '/sales/health', query: { ...query, tab: 'at_risk' } }}>{money(atRisk.reduce((s, a) => s + a.sales_prev_4w - a.sales_4w, 0))} down on 4 weeks before</Link></div></div>
      </div>

      <div className="card mt">
        <h3>Weekly sales, last 13 weeks</h3>
        <WeeklyBars values={series(weekly, mondays)} mondays={mondays} label="Weekly sales ex GST, last 13 weeks" />
      </div>

      <div className="card mt" style={{ padding: 0 }}>
        <div style={{ padding: '14px 16px 0' }}><h3>Reps</h3><div className="hint">House accounts earn no commission. Click a rep to see their accounts.</div></div>
        <table className="mt8">
          <thead><tr><th>Rep</th><th className="r">Active accounts</th><th className="r">Last 4 weeks</th><th className="r">vs 4 before</th><th className="r">13 weeks</th><th className="r">At risk</th><th>13-week trend</th></tr></thead>
          <tbody>
            {reps.map((r) => (
              <tr key={r.code}>
                <td><Link href={{ pathname: '/sales/rep', query: { ...query, code: r.code } }}><b>{r.name}</b></Link> <span className="hint">{r.code}{r.is_house ? ' · house' : ''}</span></td>
                <td className="r">{r.active} <span className="hint">of {r.accounts}</span></td>
                <td className="r">{money(r.sales_4w)}</td><td className="r">{pct(change(r.sales_4w, r.sales_prev_4w))}</td><td className="r">{money(r.sales_13w)}</td>
                <td className="r">{r.at_risk || ''}</td>
                <td><Sparkline values={r.weeks} mondays={mondays} /></td>
              </tr>
            ))}
            {!reps.length && <tr><td colSpan={7} className="hint">No sales yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="grid mt" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        {([['New accounts', fresh, 'Became customers in the last 90 days'], ['Lost accounts', lost, 'No shipments for 60 days, biggest first']] as const).map(([title, list, hint]) => (
          <div className="card" key={title}>
            <h3>{title}</h3><div className="hint">{hint}</div>
            <table className="mt8">
              <thead><tr><th>Account</th><th>Rep</th><th>{title === 'New accounts' ? 'Since' : 'Last shipped'}</th><th className="r">{title === 'New accounts' ? '13 weeks' : 'Total'}</th></tr></thead>
              <tbody>
                {list.map((a) => (
                  <tr key={a.customer_id}>
                    <td>{a.name} <span className="hint">{a.account_code}</span></td><td>{a.rep_code ?? '—'}</td>
                    <td>{day(title === 'New accounts' ? a.first_trade_date : a.last_shipped)}</td>
                    <td className="r">{money(title === 'New accounts' ? a.sales_13w : a.sales_total)}</td>
                  </tr>
                ))}
                {!list.length && <tr><td colSpan={4} className="hint">None.</td></tr>}
              </tbody>
            </table>
            <div className="mt8"><Link className="btn sm ghost" href={{ pathname: '/sales/health', query: { ...query, tab: title === 'New accounts' ? 'new' : 'lost' } }}>See all {HEALTH[title === 'New accounts' ? 'new' : 'lost'][0].toLowerCase()}</Link></div>
          </div>
        ))}
      </div>
    </>
  );
}

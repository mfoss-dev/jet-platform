import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SalesHeader } from '@/components/SalesHeader';
import { WeeklyBars } from '@/components/SalesCharts';
import { day, money } from '@/lib/format';
import { byRep, change, HEALTH, loadSales, series, withDuties } from '@/lib/sales';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { moveAccounts } from '../actions';

const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const pct = (n: number | null) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n}%`);
const SORT: Record<string, string> = { sales_13w: '13 weeks', sales_4w: 'Last 4 weeks', change: 'Biggest drop', last_shipped: 'Last shipped' };

// Rep detail: one rep's accounts, how each is trading and its health. Reps see their own (the same page their
// manager sees); management can pick any rep and move accounts to another rep.
export default async function RepDetail({ searchParams }: PageProps<'/sales/rep'>) {
  const me = await getMe();
  if (!me.apps.includes('sales')) notFound();
  const sp = await searchParams;
  const duties = withDuties(sp);
  const msg = pick(sp.msg);
  const sort = SORT[pick(sp.sort)] ? pick(sp.sort) : 'sales_13w';
  const supabase = await createClient();
  const isRep = me.role === 'sales_rep';
  const canMove = ['owner', 'management', 'admin'].includes(me.role);
  const [{ accounts, weekly, asOf, mondays, error }, { data: repData }] = await Promise.all([
    loadSales(supabase, duties),
    supabase.from('sales_reps').select('code, name, is_house, active').order('name'),
  ]);
  const reps = (repData ?? []) as { code: string; name: string; is_house: boolean; active: boolean }[];
  const summaries = byRep(accounts, weekly, mondays);
  const code = pick(sp.code) || (isRep ? summaries[0]?.code : '') || summaries.find((r) => !r.is_house)?.code || '';
  const rep = summaries.find((r) => r.code === code);
  const mine = accounts.filter((a) => (a.rep_code ?? '') === code).sort((a, b) =>
    sort === 'change' ? (a.sales_4w - a.sales_prev_4w) - (b.sales_4w - b.sales_prev_4w)
      : sort === 'last_shipped' ? String(b.last_shipped ?? '').localeCompare(String(a.last_shipped ?? ''))
        : b[sort as 'sales_13w' | 'sales_4w'] - a[sort as 'sales_13w' | 'sales_4w']);
  const query = { ...(duties ? { duties: '1' } : {}), code };
  const repName = reps.find((r) => r.code === code)?.name ?? rep?.name ?? code;

  return (
    <>
      <SalesHeader title={isRep ? 'My accounts' : repName || 'Rep detail'} sub={isRep ? 'How your accounts are trading' : `Rep ${code}${rep?.is_house ? ' · house accounts' : ''}`} asOf={asOf} duties={duties} path="/sales/rep" query={{ code }} />
      {msg && <div className={`banner ${/^Not /.test(msg) ? 'warn' : ''}`} role="status">{msg}</div>}
      {error && <div className="banner warn">Sales couldn&apos;t be loaded: {error.message}</div>}

      {!isRep && (
        <form className="filters" action="/sales/rep">
          {duties && <input type="hidden" name="duties" value="1" />}
          <select name="code" className="f" defaultValue={code} aria-label="Rep">
            {summaries.map((r) => <option key={r.code} value={r.code}>{reps.find((x) => x.code === r.code)?.name ?? r.name} ({r.code})</option>)}
          </select>
          <button className="btn">Show</button>
        </form>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
        <div className="card kpi"><div className="l">Last 4 weeks</div><div className="v">{money(rep?.sales_4w ?? 0)}</div><div className="d">{pct(change(rep?.sales_4w ?? 0, rep?.sales_prev_4w ?? 0))} on the 4 weeks before</div></div>
        <div className="card kpi"><div className="l">Last 13 weeks</div><div className="v">{money(rep?.sales_13w ?? 0)}</div></div>
        <div className="card kpi"><div className="l">Active accounts</div><div className="v">{rep?.active ?? 0}</div><div className="d">of {rep?.accounts ?? 0} on this rep</div></div>
        <div className="card kpi"><div className="l">Need a call</div><div className="v">{(rep?.at_risk ?? 0) + (rep?.quiet ?? 0)}</div><div className="d">{rep?.at_risk ?? 0} at risk · {rep?.quiet ?? 0} quiet</div></div>
      </div>

      <div className="card mt">
        <h3>Weekly sales</h3>
        <WeeklyBars values={series(weekly, mondays, (w) => (w.rep_code ?? '') === code)} mondays={mondays} label={`Weekly sales for ${repName}, last 13 weeks`} />
      </div>

      <form className="card mt" style={{ padding: 0 }}>
        <div className="flex" style={{ padding: '14px 16px 0', justifyContent: 'space-between' }}>
          <h3>Accounts ({mine.length})</h3>
          <div className="flex">
            {Object.entries(SORT).map(([k, v]) => <Link key={k} className={`btn sm ${sort === k ? 'primary' : 'ghost'}`} href={{ pathname: '/sales/rep', query: { ...query, sort: k } }}>{v}</Link>)}
            <a className="btn sm" href={`/sales/rep/csv?${new URLSearchParams(query)}`}>Download CSV</a>
          </div>
        </div>
        <table className="mt8">
          <thead><tr>{canMove && <th />}<th>Account</th><th>Health</th><th>Customer since</th><th>Last shipped</th><th className="r">Last 4 weeks</th><th className="r">vs 4 before</th><th className="r">13 weeks</th><th className="r">Shipments</th></tr></thead>
          <tbody>
            {mine.map((a) => (
              <tr key={a.customer_id}>
                {canMove && <td><input type="checkbox" name="account" value={a.customer_id} aria-label={`Select ${a.name}`} /></td>}
                <td><b>{a.name}</b> <span className="hint">{a.account_code} · {a.branch_code}{a.status !== 'active' ? ` · ${a.status.replace('_', ' ')}` : ''}</span></td>
                <td><span className={`pill ${HEALTH[a.health][1]}`}>{HEALTH[a.health][0]}</span></td>
                <td>{day(a.first_trade_date)}</td><td>{day(a.last_shipped)}</td>
                <td className="r">{money(a.sales_4w)}</td><td className="r">{pct(change(a.sales_4w, a.sales_prev_4w))}</td><td className="r">{money(a.sales_13w)}</td>
                <td className="r">{a.shipments_13w}</td>
              </tr>
            ))}
            {!mine.length && <tr><td colSpan={9} className="hint">No accounts on this rep.</td></tr>}
          </tbody>
        </table>
        {canMove && mine.length > 0 && (
          <div className="flex" style={{ padding: '10px 16px 14px' }}>
            <input type="hidden" name="from" value={code} />
            <label htmlFor="mv-to" className="hint">Move ticked accounts to</label>
            <select id="mv-to" name="to" className="f" aria-label="Move to rep">
              {reps.filter((r) => r.code !== code && r.active).map((r) => <option key={r.code} value={r.code}>{r.name} ({r.code})</option>)}
            </select>
            <button className="btn" formAction={moveAccounts}>Move</button>
          </div>
        )}
      </form>
    </>
  );
}

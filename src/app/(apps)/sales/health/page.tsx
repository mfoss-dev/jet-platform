import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SalesHeader } from '@/components/SalesHeader';
import { day, money } from '@/lib/format';
import { change, HEALTH, HEALTH_RULES, loadSales, withDuties, type Health } from '@/lib/sales';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';

const TABS: Health[] = ['at_risk', 'quiet', 'new', 'growing', 'lost'];
const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const pct = (n: number | null) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n}%`);

// Account health: accounts that need a call (at risk, gone quiet), new ones, growing ones and lost ones.
// Reps see their own; management can narrow to one rep.
export default async function AccountHealth({ searchParams }: PageProps<'/sales/health'>) {
  const me = await getMe();
  if (!me.apps.includes('sales')) notFound();
  const sp = await searchParams;
  const duties = withDuties(sp);
  const tab = (TABS as string[]).includes(pick(sp.tab)) ? (pick(sp.tab) as Health) : 'at_risk';
  const rep = pick(sp.rep);
  const supabase = await createClient();
  const { accounts, asOf, error } = await loadSales(supabase, duties);
  const scoped = accounts.filter((a) => !rep || (a.rep_code ?? '') === rep);
  const list = scoped.filter((a) => a.health === tab).sort((a, b) =>
    tab === 'at_risk' ? (a.sales_4w - a.sales_prev_4w) - (b.sales_4w - b.sales_prev_4w) : tab === 'lost' ? b.sales_total - a.sales_total : b.sales_13w - a.sales_13w);
  const repCodes = [...new Set(accounts.map((a) => a.rep_code).filter(Boolean))] as string[];
  const query = { ...(duties ? { duties: '1' } : {}), ...(rep ? { rep } : {}) };

  return (
    <>
      <SalesHeader title="Account health" sub="Who to call this week" asOf={asOf} duties={duties} path="/sales/health" query={{ tab, ...(rep ? { rep } : {}) }} />
      {error && <div className="banner warn">Sales couldn&apos;t be loaded: {error.message}</div>}

      <div className="filters">
        {TABS.map((t) => (
          <Link key={t} className={`btn sm ${t === tab ? 'primary' : ''}`} href={{ pathname: '/sales/health', query: { ...query, tab: t } }}>
            {HEALTH[t][0]} ({scoped.filter((a) => a.health === t).length})
          </Link>
        ))}
        {me.role !== 'sales_rep' && repCodes.length > 1 && (
          <form action="/sales/health" className="flex">
            <input type="hidden" name="tab" value={tab} />{duties && <input type="hidden" name="duties" value="1" />}
            <select name="rep" className="f" defaultValue={rep} aria-label="Rep"><option value="">All reps</option>{repCodes.sort().map((c) => <option key={c} value={c}>{c}</option>)}</select>
            <button className="btn sm">Show</button>
          </form>
        )}
      </div>
      <p className="hint">{HEALTH_RULES[tab]}.</p>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Account</th><th>Rep</th><th>Customer since</th><th>Last shipped</th><th className="r">Last 4 weeks</th><th className="r">4 weeks before</th><th className="r">Change</th><th className="r">13 weeks</th></tr></thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.customer_id}>
                <td><b>{a.name}</b> <span className="hint">{a.account_code} · {a.branch_code}</span></td>
                <td>{a.rep_code ?? '—'}{a.is_house ? <span className="hint"> · house</span> : ''}</td>
                <td>{day(a.first_trade_date)}</td><td>{day(a.last_shipped)}</td>
                <td className="r">{money(a.sales_4w)}</td><td className="r">{money(a.sales_prev_4w)}</td><td className="r">{pct(change(a.sales_4w, a.sales_prev_4w))}</td>
                <td className="r">{money(a.sales_13w)}</td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={8} className="hint">No accounts here.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

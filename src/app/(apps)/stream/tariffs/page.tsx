import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BILLING_EDITORS, day, one } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { cancelFuel, scheduleFuel } from './actions';
import { PriceCheck } from './PriceCheck';
import { RateCards } from './RateCards';
import { SalesTariffs } from './SalesTariffs';

const TABS = [['fuel', 'Fuel surcharge'], ['rates', 'Rate cards'], ['sales', 'Sales tariffs'], ['price', 'Price check']] as const;

type Fuel = { id: string; carrier_code: string; rate_pct: number; effective_from: string; created_at: string; carrier: { name: string } | null };
const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

function nextMonday() {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

export default async function Tariffs({ searchParams }: PageProps<'/stream/tariffs'>) {
  const me = await getMe();
  if (!me.apps.includes('stream')) notFound();
  const sp = await searchParams;
  const tab = (TABS.some(([t]) => t === sp.tab) ? sp.tab : 'fuel') as (typeof TABS)[number][0];
  const msg = pick(sp.msg);
  const canEdit = BILLING_EDITORS.includes(me.role);
  const canPublish = ['owner', 'management', 'admin'].includes(me.role);
  const supabase = await createClient();

  return (
    <>
      <div className="top">
        <div><h1>Tariffs &amp; fuel</h1><div className="sub">Rates managed in-house · every change has a start date and goes to the audit log</div></div>
      </div>
      <div className="tabs">
        {TABS.map(([t, label]) => (
          <Link key={t} href={{ pathname: '/stream/tariffs', query: { tab: t } }} scroll={false}><span className={t === tab ? 'on' : ''}>{label}</span></Link>
        ))}
      </div>
      {msg && <div className={`banner ${/^(Not |No |Choose|Give)|must/.test(msg) ? 'warn' : ''}`} role="status">{msg}</div>}
      {tab === 'fuel' && <FuelTab supabase={supabase} canEdit={canEdit} />}
      {tab === 'rates' && <RateCards supabase={supabase} canEdit={canEdit} canPublish={canPublish} tariffId={pick(sp.tariff)} versionId={pick(sp.version)} />}
      {tab === 'sales' && <SalesTariffs supabase={supabase} canEdit={canEdit} salesId={pick(sp.sales)} />}
      {tab === 'price' && <PriceCheck supabase={supabase} params={{ customer: pick(sp.customer), zone: pick(sp.zone), kind: pick(sp.kind), weight: pick(sp.weight), date: pick(sp.date) }} />}
    </>
  );
}

async function FuelTab({ supabase, canEdit }: { supabase: Awaited<ReturnType<typeof createClient>>; canEdit: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const [{ data }, { data: carriers }] = await Promise.all([
    supabase.from(SELECTS.fuel.table).select(SELECTS.fuel.select).order('effective_from', { ascending: false }).limit(200),
    supabase.from(SELECTS.carriers.table).select(SELECTS.carriers.select).eq('active', true).order('name'),
  ]);
  const rows = ((data ?? []) as unknown as Fuel[]).map((r) => ({ ...r, carrier: one(r.carrier) }));
  const byCarrier = (carriers ?? []).map((c) => {
    const mine = rows.filter((r) => r.carrier_code === c.code);
    return {
      ...c,
      current: mine.find((r) => r.effective_from <= today),
      next: [...mine].reverse().find((r) => r.effective_from > today),
    };
  });
  const scheduled = rows.filter((r) => r.effective_from > today).sort((a, b) => a.effective_from.localeCompare(b.effective_from));

  return (
    <div className="grid k11">
      <div className="card">
        <h3>Fuel surcharge by carrier</h3>
        <table>
          <thead><tr><th>Carrier</th><th className="r">Current</th><th>Since</th><th className="r">Next</th><th>From</th></tr></thead>
          <tbody>
            {byCarrier.map((c) => (
              <tr key={c.code}>
                <td>{c.name}</td>
                <td className="r">{c.current ? `${c.current.rate_pct}%` : <span className="hint">not set</span>}</td>
                <td>{c.current ? day(c.current.effective_from) : '—'}</td>
                <td className="r">{c.next ? <b>{c.next.rate_pct}%</b> : '—'}</td>
                <td>{c.next ? day(c.next.effective_from) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {canEdit && (
          <form action={scheduleFuel} className="form mt" style={{ gridTemplateColumns: '1.4fr 1fr 1.2fr auto', alignItems: 'end' }}>
            <div>
              <label htmlFor="carrier">Carrier</label>
              <select id="carrier" name="carrier_code" className="f" required defaultValue="">
                <option value="" disabled>Choose…</option>
                {(carriers ?? []).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </div>
            <div><label htmlFor="rate">Rate %</label><input id="rate" name="rate_pct" type="number" step="0.1" min={0} max={100} required /></div>
            <div><label htmlFor="from">Starts</label><input id="from" name="effective_from" type="date" defaultValue={nextMonday()} required /></div>
            <div><button className="btn primary">Schedule</button></div>
          </form>
        )}
      </div>

      <div className="card">
        <h3>Scheduled changes</h3>
        {scheduled.length ? (
          <table>
            <thead><tr><th>Carrier</th><th className="r">Rate</th><th>Starts</th>{canEdit && <th />}</tr></thead>
            <tbody>
              {scheduled.map((r) => (
                <tr key={r.id}>
                  <td>{r.carrier?.name ?? r.carrier_code}</td><td className="r">{r.rate_pct}%</td><td>{day(r.effective_from)}</td>
                  {canEdit && (
                    <td className="r">
                      <form action={cancelFuel}><input type="hidden" name="id" value={r.id} /><button className="btn sm ghost">Cancel</button></form>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="hint">Nothing scheduled.</p>}
        <p className="hint mt8">Jobs are rated with the rate in force on their booking date. Past rates stay as the record of what was charged.</p>
      </div>
    </div>
  );
}

import { day } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import type { createClient } from '@/lib/supabase/server';
import { cancelFuel, scheduleFuel } from './actions';

type Supabase = Awaited<ReturnType<typeof createClient>>;
type Rule = { id: string; branch_code: string; customer_id: string | null; service_code: string | null; valid_from: string; valid_to: string; percentage: number; source: string | null };

function nextMonday() {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

// Weekly fuel surcharge per branch and service (JetStream's #FUEL rules). Customer-specific rates are listed separately.
export async function FuelTab({ supabase, canEdit }: { supabase: Supabase; canEdit: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const [{ data }, { data: services }, { data: branches }] = await Promise.all([
    supabase.from(SELECTS.addonRules.table).select(SELECTS.addonRules.select).eq('code', '#FUEL').gte('valid_to', today).order('valid_from').limit(1000),
    supabase.from(SELECTS.tariffServices.table).select(SELECTS.tariffServices.select).order('name'),
    supabase.from(SELECTS.branches.table).select(SELECTS.branches.select).order('code'),
  ]);
  const rules = (data ?? []) as unknown as Rule[];
  const general = rules.filter((r) => !r.customer_id);
  const serviceName = (c: string | null) => (services ?? []).find((s) => s.code === c)?.name ?? c ?? 'All services';
  const pairs = [...new Set(general.map((r) => `${r.branch_code}|${r.service_code ?? ''}`))].sort();
  const lastRecorded = (await supabase.from(SELECTS.addonRules.table).select('valid_to').eq('code', '#FUEL').is('customer_id', null)
    .order('valid_to', { ascending: false }).limit(1)).data?.[0]?.valid_to;
  const customerRates = rules.filter((r) => r.customer_id && r.valid_from <= today);
  const scheduled = general.filter((r) => r.valid_from > today);

  return (
    <div className="grid k11">
      <div className="card">
        <h3>Fuel surcharge by branch and service</h3>
        {pairs.length ? (
          <table>
            <thead><tr><th>Branch</th><th>Service</th><th className="r">Current</th><th>Since</th><th className="r">Next</th><th>From</th></tr></thead>
            <tbody>
              {pairs.map((p) => {
                const [b, s] = p.split('|');
                const mine = general.filter((r) => r.branch_code === b && (r.service_code ?? '') === s);
                const current = mine.find((r) => r.valid_from <= today && r.valid_to >= today);
                const next = mine.find((r) => r.valid_from > today);
                return (
                  <tr key={p}>
                    <td>{b}</td><td>{serviceName(s || null)}</td>
                    <td className="r">{current ? `${current.percentage}%` : <span className="hint">not set</span>}</td>
                    <td>{current ? day(current.valid_from) : '—'}{current?.source === 'reconstructed' && <span className="hint"> · from billed jobs</span>}</td>
                    <td className="r">{next ? <b>{next.percentage}%</b> : '—'}</td><td>{next ? day(next.valid_from) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="banner warn">
            No fuel rate is in force today.{lastRecorded ? ` The last recorded rate ended ${day(lastRecorded)}` : ''} (the imported JetStream backup
            has no fuel rules; rates up to its last billed week were worked out from the bills). Set this week&apos;s rates below.
          </div>
        )}
        {canEdit && (
          <form action={scheduleFuel} className="form mt" style={{ gridTemplateColumns: '0.8fr 1.6fr 0.9fr 1.2fr auto', alignItems: 'end' }}>
            <div>
              <label htmlFor="f-branch">Branch</label>
              <select id="f-branch" name="branch_code" className="f" required>{(branches ?? []).map((b) => <option key={b.code} value={b.code}>{b.code}</option>)}</select>
            </div>
            <div>
              <label htmlFor="f-service">Service</label>
              <select id="f-service" name="service_code" className="f" required>{(services ?? []).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select>
            </div>
            <div><label htmlFor="f-rate">Rate %</label><input id="f-rate" name="rate_pct" type="number" step="0.01" min={0} max={100} required /></div>
            <div><label htmlFor="f-from">Starts</label><input id="f-from" name="valid_from" type="date" defaultValue={nextMonday()} required /></div>
            <div><button className="btn primary">Set</button></div>
          </form>
        )}
      </div>

      <div className="grid" style={{ alignSelf: 'start' }}>
        <div className="card">
          <h3>Scheduled changes</h3>
          {scheduled.length ? (
            <table>
              <tbody>
                {scheduled.map((r) => (
                  <tr key={r.id}>
                    <td>{r.branch_code} · {serviceName(r.service_code)}</td><td className="r">{r.percentage}%</td><td>{day(r.valid_from)}</td>
                    {canEdit && <td className="r"><form action={cancelFuel}><input type="hidden" name="id" value={r.id} /><button className="btn sm ghost">Cancel</button></form></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="hint">Nothing scheduled.</p>}
        </div>
        <div className="card">
          <h3>Customers on their own fuel rate</h3>
          <p className="hint">{customerRates.length ? `${customerRates.length} customer rates in force (e.g. customers who pay no fuel). They are add-on rules for those customers; see the Add-ons tab.` : 'None in force today.'}</p>
          <p className="hint mt8">Fuel is charged on the freight line and on any add-on marked &ldquo;adds fuel&rdquo;, at the rate in force on the booking date.</p>
        </div>
      </div>
    </div>
  );
}

import { money } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import type { createClient } from '@/lib/supabase/server';

type Supabase = Awaited<ReturnType<typeof createClient>>;
type Params = { customer: string; zone: string; kind: string; weight: string; date: string };
type Priced = {
  sales_tariff: string | null; base_tariff: string | null; version: number | null; base_charge: number | null;
  margin_pct: number | null; price: number | null; fuel_pct: number | null; problem: string | null;
};

// "What would this cost?" using the same database function that will rate real jobs.
export async function PriceCheck({ supabase, params }: { supabase: Supabase; params: Params }) {
  const [{ data: customers }, { data: zones }] = await Promise.all([
    supabase.from(SELECTS.customerPicker.table).select(SELECTS.customerPicker.select).neq('status', 'closed').order('name'),
    supabase.from(SELECTS.zones.table).select(SELECTS.zones.select).order('sort'),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const weight = Number(params.weight);
  const ready = params.customer && params.zone && weight > 0;
  let result: Priced | null = null;
  let error: string | null = null;
  if (ready) {
    const { data, error: e } = await supabase.rpc('price_shipment', {
      p_customer: params.customer, p_zone: params.zone, p_kind: params.kind === 'doc' ? 'doc' : 'parcel', p_weight: weight, p_date: params.date || today,
    });
    result = (data as Priced[] | null)?.[0] ?? null;
    error = e?.message ?? null;
  }
  const fuel = result?.price != null && result.fuel_pct != null ? Math.round(result.price * Number(result.fuel_pct)) / 100 : null;

  return (
    <div className="grid k11">
      <div className="card">
        <h3>Price check</h3>
        <form action="/stream/tariffs" className="form" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <input type="hidden" name="tab" value="price" />
          <div className="s2">
            <label htmlFor="pc-customer">Customer</label>
            <select id="pc-customer" name="customer" className="f" defaultValue={params.customer} required>
              <option value="" disabled>Choose…</option>
              {(customers ?? []).map((c) => <option key={c.id} value={c.id}>{c.name} · {c.account_code}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="pc-zone">Zone</label>
            <select id="pc-zone" name="zone" className="f" defaultValue={params.zone} required>
              <option value="" disabled>Choose…</option>
              {(zones ?? []).map((z) => <option key={z.code} value={z.code}>{z.code} · {z.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="pc-kind">Type</label>
            <select id="pc-kind" name="kind" className="f" defaultValue={params.kind || 'parcel'}>
              <option value="parcel">Parcel</option><option value="doc">Documents</option>
            </select>
          </div>
          <div><label htmlFor="pc-weight">Weight (kg)</label><input id="pc-weight" name="weight" type="number" step="0.1" min="0.1" defaultValue={params.weight} required /></div>
          <div><label htmlFor="pc-date">Booking date</label><input id="pc-date" name="date" type="date" defaultValue={params.date || today} /></div>
          <div><button className="btn primary">Check price</button></div>
        </form>
        <p className="hint mt8">Uses published rate cards only, the version in force on the booking date. Try a 2027 date to see a scheduled version.</p>
      </div>

      <div className="card">
        <h3>Result</h3>
        {!ready && <p className="hint">Choose a customer, zone and weight.</p>}
        {error && <div className="banner warn">{error}</div>}
        {result && (
          <>
            {result.problem && <div className="banner warn">{result.problem}</div>}
            <table>
              <tbody>
                <tr><td>Sales tariff</td><td className="r">{result.sales_tariff ?? '—'}</td></tr>
                <tr><td>Rate card</td><td className="r">{result.base_tariff ?? '—'}{result.version ? ` · version ${result.version}` : ''}</td></tr>
                <tr><td>Base rate</td><td className="r">{money(result.base_charge)}</td></tr>
                <tr><td>Margin</td><td className="r">{result.margin_pct == null ? '—' : `${result.margin_pct}%`}</td></tr>
                <tr><td><b>Freight price (ex GST)</b></td><td className="r"><b>{money(result.price)}</b></td></tr>
                <tr><td>Fuel surcharge {result.fuel_pct != null ? `(${result.fuel_pct}%)` : ''}</td><td className="r">{money(fuel)}</td></tr>
                <tr><td>Freight + fuel (ex GST)</td><td className="r">{result.price != null ? money(result.price + (fuel ?? 0)) : '—'}</td></tr>
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

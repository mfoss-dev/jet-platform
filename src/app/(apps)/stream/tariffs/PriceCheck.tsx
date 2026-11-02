import { money } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import type { createClient } from '@/lib/supabase/server';

type Supabase = Awaited<ReturnType<typeof createClient>>;
export type PriceParams = {
  customer: string; service: string; ocountry: string; opost: string; dcountry: string; dpost: string;
  kind: string; weight: string; l: string; w: string; h: string; date: string; zone: string;
};
type Priced = {
  sales_tariff: string | null; base_tariff: string | null; version: number | null; zone_code: string | null;
  volumetric_divisor: number | null; price: number | null; fuel_pct: number | null; problem: string | null;
};

// "What would this cost?" using the same database function that will rate real jobs (JetStream's rules).
export async function PriceCheck({ supabase, params: p }: { supabase: Supabase; params: PriceParams }) {
  const [{ data: customers }, { data: services }] = await Promise.all([
    supabase.from(SELECTS.customerPicker.table).select(SELECTS.customerPicker.select).neq('status', 'closed').order('name').limit(1000),
    supabase.from(SELECTS.tariffServices.table).select(SELECTS.tariffServices.select).order('name'),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const actual = Number(p.weight);
  const dims = [p.l, p.w, p.h].map(Number);
  const ready = p.customer && p.service && actual > 0 && (p.zone || (p.ocountry && p.dcountry));
  const call = async (weight: number) => {
    const { data, error } = await supabase.rpc('price_shipment', {
      p_customer: p.customer, p_service: p.service, p_orig_country: p.ocountry || 'AU', p_orig_postcode: p.opost, p_dest_country: p.dcountry || 'AU',
      p_dest_postcode: p.dpost, p_kind: p.kind === 'doc' ? 'doc' : 'parcel', p_weight: weight, p_date: p.date || today, p_zone: p.zone || null,
    });
    return { row: (data as Priced[] | null)?.[0] ?? null, error: error?.message ?? null };
  };

  let result: Priced | null = null;
  let error: string | null = null;
  let cubic: number | null = null;
  let chargeable = actual;
  if (ready) {
    ({ row: result, error } = await call(actual));
    // Chargeable weight: the greater of actual and cubic (L x W x H in cm / divisor), using the divisor that applies.
    if (result?.volumetric_divisor && dims.every((d) => d > 0)) {
      cubic = Math.round((dims[0] * dims[1] * dims[2]) / result.volumetric_divisor * 100) / 100;
      if (cubic > actual) { chargeable = cubic; ({ row: result, error } = await call(cubic)); }
    }
  }
  const fuel = result?.price != null && result.fuel_pct != null ? Math.round(Number(result.price) * Number(result.fuel_pct)) / 100 : null;
  const isIntl = p.service.startsWith('INT');

  return (
    <div className="grid k11">
      <div className="card">
        <h3>Price check</h3>
        <form action="/stream/tariffs" className="form" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <input type="hidden" name="tab" value="price" />
          <div className="s2">
            <label htmlFor="pc-customer">Customer</label>
            <select id="pc-customer" name="customer" className="f" defaultValue={p.customer} required>
              <option value="" disabled>Choose…</option>
              {(customers ?? []).map((c) => <option key={c.id} value={c.id}>{c.name} · {c.account_code}</option>)}
            </select>
          </div>
          <div className="s2">
            <label htmlFor="pc-service">Service</label>
            <select id="pc-service" name="service" className="f" defaultValue={p.service || 'INTOUTEXP'} required>
              {(services ?? []).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
            </select>
          </div>
          <div><label htmlFor="pc-oc">From country</label><input id="pc-oc" name="ocountry" defaultValue={p.ocountry || 'AU'} maxLength={2} placeholder="AU" /></div>
          <div><label htmlFor="pc-op">From postcode</label><input id="pc-op" name="opost" defaultValue={p.opost} placeholder="2000" /></div>
          <div><label htmlFor="pc-dc">To country</label><input id="pc-dc" name="dcountry" defaultValue={p.dcountry || (isIntl ? '' : 'AU')} maxLength={2} placeholder="GB" /></div>
          <div><label htmlFor="pc-dp">To postcode</label><input id="pc-dp" name="dpost" defaultValue={p.dpost} placeholder="3000" /></div>
          <div>
            <label htmlFor="pc-kind">Type</label>
            <select id="pc-kind" name="kind" className="f" defaultValue={p.kind || 'parcel'}><option value="parcel">Parcel</option><option value="doc">Documents</option></select>
          </div>
          <div><label htmlFor="pc-weight">Weight (kg)</label><input id="pc-weight" name="weight" type="number" step="0.1" min="0.1" defaultValue={p.weight} required /></div>
          <div className="s2">
            <label>Dimensions (cm, optional)</label>
            <div className="flex">
              <input name="l" defaultValue={p.l} placeholder="L" inputMode="decimal" style={{ width: 80 }} aria-label="Length cm" />
              <input name="w" defaultValue={p.w} placeholder="W" inputMode="decimal" style={{ width: 80 }} aria-label="Width cm" />
              <input name="h" defaultValue={p.h} placeholder="H" inputMode="decimal" style={{ width: 80 }} aria-label="Height cm" />
            </div>
          </div>
          <div><label htmlFor="pc-date">Booking date</label><input id="pc-date" name="date" type="date" defaultValue={p.date || today} /></div>
          <div><label htmlFor="pc-zone">Zone (optional override)</label><input id="pc-zone" name="zone" defaultValue={p.zone} placeholder="found from postcodes" /></div>
          <div><button className="btn primary">Check price</button></div>
        </form>
        <p className="hint mt8">The zone comes from the rate card&apos;s zone guide (country and postcode), checking the customer&apos;s own zones first, as JetStream does.</p>
      </div>

      <div className="card">
        <h3>Result</h3>
        {!ready && <p className="hint">Choose a customer and service, enter where it&apos;s going and the weight.</p>}
        {error && <div className="banner warn">{error}</div>}
        {result && (
          <>
            {result.problem && <div className="banner warn">{result.problem}</div>}
            <table>
              <tbody>
                <tr><td>Sales tariff</td><td className="r">{result.sales_tariff ?? '—'}</td></tr>
                <tr><td>Rate card</td><td className="r">{result.base_tariff ?? '—'}{result.version ? ` · version ${result.version}` : ''}</td></tr>
                <tr><td>Zone</td><td className="r">{result.zone_code ?? '—'}</td></tr>
                <tr><td>Chargeable weight</td><td className="r">{chargeable} kg{cubic != null ? ` (cubic ${cubic} kg at ÷${result.volumetric_divisor})` : ''}</td></tr>
                <tr><td><b>Freight (ex GST)</b></td><td className="r"><b>{money(result.price)}</b></td></tr>
                <tr><td>Fuel surcharge {result.fuel_pct != null ? `(${result.fuel_pct}%)` : ''}</td><td className="r">{money(fuel)}</td></tr>
                <tr><td>Freight + fuel (ex GST)</td><td className="r">{result.price != null ? money(Number(result.price) + (fuel ?? 0)) : '—'}</td></tr>
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

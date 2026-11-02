import { money } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import type { createClient } from '@/lib/supabase/server';

type Supabase = Awaited<ReturnType<typeof createClient>>;
export type PriceParams = {
  customer: string; service: string; ocountry: string; opost: string; dcountry: string; dpost: string;
  kind: string; weight: string; l: string; w: string; h: string; date: string; zone: string;
  insured: string; declared: string; priority: string; dtp: string;
};
type Line = { code: string; description: string; charge: number; fuel: number; security: number; gst: number };
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
  // The full charge: the freight line and every add-on, with fuel, security and GST, as it would be invoiced.
  let lines: Line[] = [];
  if (result?.price != null) {
    const { data } = await supabase.rpc('charge_lines', {
      p_customer: p.customer, p_service: p.service, p_date: p.date || today, p_freight: Number(result.price), p_weight: chargeable,
      p_orig_country: p.ocountry || 'AU', p_orig_postcode: p.opost, p_dest_country: p.dcountry || 'AU', p_dest_postcode: p.dpost,
      p_declared: Number(p.declared) || 0, p_insured: Number(p.insured) || 0, p_priority: p.priority === 'on', p_dtp: p.dtp === 'on',
      p_pieces: [{ weight: actual, max_dim: Math.max(0, ...dims.filter((d) => d > 0)) }],
    });
    lines = ((data ?? []) as Line[]).map((l) => ({ ...l, charge: Number(l.charge), fuel: Number(l.fuel), security: Number(l.security), gst: Number(l.gst) }))
      .filter((l) => l.charge || l.fuel || l.security || l.gst);
    if (!lines.some((l) => l.code === '.FREIGHT')) lines.unshift({ code: '.FREIGHT', description: 'Freight', charge: Number(result.price), fuel: 0, security: 0, gst: 0 });
  }
  const exGst = lines.reduce((a, l) => a + l.charge + l.fuel + l.security, 0);
  const gst = lines.reduce((a, l) => a + l.gst, 0);
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
          <div><label htmlFor="pc-ins">Insured value $</label><input id="pc-ins" name="insured" defaultValue={p.insured} inputMode="decimal" placeholder="0" /></div>
          <div><label htmlFor="pc-dec">Declared value $</label><input id="pc-dec" name="declared" defaultValue={p.declared} inputMode="decimal" placeholder="0" /></div>
          <div className="s2 flex">
            <label style={{ margin: 0 }}><input type="checkbox" name="priority" defaultChecked={p.priority === 'on'} /> Priority</label>
            <label style={{ margin: 0 }}><input type="checkbox" name="dtp" defaultChecked={p.dtp === 'on'} /> Duties and taxes paid by sender</label>
          </div>
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
                <tr><td>Freight</td><td className="r">{money(result.price)}</td></tr>
                <tr><td>Fuel rate</td><td className="r">{result.fuel_pct != null ? `${result.fuel_pct}%` : <span className="hint">not set for this date</span>}</td></tr>
              </tbody>
            </table>
            {lines.length > 0 && (
              <table className="mt">
                <thead><tr><th>Line</th><th className="r">Charge</th><th className="r">Fuel</th><th className="r">Security</th><th className="r">GST</th></tr></thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={`${l.code}-${i}`}><td>{l.description || l.code} <span className="hint">{l.code}</span></td><td className="r">{money(l.charge)}</td>
                      <td className="r">{l.fuel ? money(l.fuel) : '—'}</td><td className="r">{l.security ? money(l.security) : '—'}</td><td className="r">{l.gst ? money(l.gst) : '—'}</td></tr>
                  ))}
                  <tr><td><b>Total ex GST</b></td><td className="r" colSpan={3}><b>{money(exGst)}</b></td><td className="r">{money(gst)}</td></tr>
                  <tr><td><b>Total inc GST</b></td><td className="r" colSpan={4}><b>{money(exGst + gst)}</b></td></tr>
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}

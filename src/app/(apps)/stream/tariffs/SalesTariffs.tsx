import Link from 'next/link';
import { day, one } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import type { createClient } from '@/lib/supabase/server';
import { createSalesTariff, saveSalesMargins } from './actions';

type Supabase = Awaited<ReturnType<typeof createClient>>;
const BANDS = [['0.5', 'Up to 0.5 kg'], ['5', 'Up to 5 kg'], ['20', 'Up to 20 kg'], ['over', 'Over 20 kg']] as const;
type Sales = { id: string; code: string; name: string; base_tariff_id: string; base: { code: string; name: string } | null };

export async function SalesTariffs({ supabase, canEdit, salesId }: { supabase: Supabase; canEdit: boolean; salesId: string }) {
  const [{ data: sdata }, { data: zones }, { data: bases }, { data: assigned }] = await Promise.all([
    supabase.from(SELECTS.salesTariffs.table).select(SELECTS.salesTariffs.select).order('code'),
    supabase.from(SELECTS.zones.table).select(SELECTS.zones.select).order('sort'),
    supabase.from(SELECTS.baseTariffs.table).select(SELECTS.baseTariffs.select).order('code'),
    supabase.from(SELECTS.customerTariffs.table).select(SELECTS.customerTariffs.select).order('effective_from', { ascending: false }),
  ]);
  const sales = ((sdata ?? []) as unknown as Sales[]).map((s) => ({ ...s, base: one(s.base) }));
  const selected = sales.find((s) => s.id === salesId) ?? sales[0];
  const { data: margins } = selected
    ? await supabase.from(SELECTS.salesMargins.table).select(SELECTS.salesMargins.select).eq('sales_tariff_id', selected.id)
    : { data: [] };
  const cell = (zone: string, band: string) =>
    (margins ?? []).find((m) => m.zone_code === zone && (band === 'over' ? m.up_to_kg == null : Number(m.up_to_kg) === Number(band)))?.margin_pct;

  // Each customer's current tariff is their latest assignment that has started.
  const today = new Date().toISOString().slice(0, 10);
  const current = new Map<string, string>();
  for (const a of assigned ?? []) if (a.effective_from <= today && !current.has(a.customer_id)) current.set(a.customer_id, a.sales_tariff_id);
  const onTariff = [...current.entries()].filter(([, s]) => s === selected?.id).map(([c]) => c);
  const { data: customers } = onTariff.length
    ? await supabase.from(SELECTS.customerPicker.table).select(SELECTS.customerPicker.select).in('id', onTariff).order('name')
    : { data: [] };

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(220px, 280px) 1fr', alignItems: 'start' }}>
      <div className="grid">
        <div className="card">
          <h3>Sales tariffs</h3>
          {sales.map((s) => (
            <div key={s.id}>
              <Link href={{ pathname: '/stream/tariffs', query: { tab: 'sales', sales: s.id } }} scroll={false}>{s.id === selected?.id ? <b>{s.name}</b> : s.name}</Link>
              <div className="hint">{s.code} · on {s.base?.code}</div>
            </div>
          ))}
          {!sales.length && <p className="hint">None yet.</p>}
        </div>
        {canEdit && (
          <div className="card">
            <h3>New sales tariff</h3>
            <form action={createSalesTariff} className="form" style={{ gridTemplateColumns: '1fr' }}>
              <div><label htmlFor="code">Code</label><input id="code" name="code" placeholder="e.g. RESELLER" required /></div>
              <div><label htmlFor="name">Name</label><input id="name" name="name" placeholder="e.g. Reseller accounts" required /></div>
              <div>
                <label htmlFor="base">Rate card</label>
                <select id="base" name="base_tariff_id" className="f" required>
                  {(bases ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="copy">Copy margins from</label>
                <select id="copy" name="copy_from" className="f" defaultValue={selected?.id ?? ''}>
                  <option value="">Start blank</option>
                  {sales.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div><button className="btn">Create</button></div>
            </form>
          </div>
        )}
      </div>

      {selected && (
        <div className="grid" style={{ minWidth: 0 }}>
          <div className="card">
            <h3>{selected.name} · margin on top of {selected.base?.name}</h3>
            <form action={saveSalesMargins}>
              <input type="hidden" name="sales_tariff_id" value={selected.id} />
              <div className="tw">
                <table>
                  <thead><tr><th>Zone</th>{BANDS.map(([, l]) => <th key={l} className="r">{l}</th>)}</tr></thead>
                  <tbody>
                    {(zones ?? []).map((z) => (
                      <tr key={z.code}>
                        <td>{z.code} · {z.name}</td>
                        {BANDS.map(([b]) => (
                          <td key={b} className="r">
                            <input name={`m|${z.code}|${b}`} defaultValue={cell(z.code, b) ?? ''} inputMode="decimal" disabled={!canEdit} placeholder="—"
                              aria-label={`Zone ${z.name}, ${b === 'over' ? 'over 20' : `up to ${b}`} kg margin %`} style={{ width: 80, textAlign: 'right' }} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex mt">
                {canEdit && <button className="btn primary">Save margins</button>}
                <span className="hint">Percent on top of the base rate, e.g. 28 means the customer pays base × 1.28. Blank means no price (the job shows &ldquo;No rate&rdquo;). Changes apply straight away.</span>
              </div>
            </form>
          </div>
          <div className="card">
            <h3>Customers on this tariff ({(customers ?? []).length})</h3>
            {(customers ?? []).length ? (
              <div className="flex">{(customers ?? []).map((c) => <Link key={c.id} className="pill" href={`/stream/customers/${c.id}`}>{c.name}</Link>)}</div>
            ) : <p className="hint">Nobody yet. Assign customers from their page under Customers.</p>}
            <p className="hint mt8">As of {day(today)}.</p>
          </div>
        </div>
      )}
    </div>
  );
}

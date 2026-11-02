import Link from 'next/link';
import { day, money, one } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import type { createClient } from '@/lib/supabase/server';
import { endAddon, saveAddon } from './actions';

type Supabase = Awaited<ReturnType<typeof createClient>>;
export type AddonRule = {
  id: string; branch_code: string; customer_id: string | null; service_code: string | null; code: string; description: string;
  valid_from: string; valid_to: string; apply_when: string; percentage_of: string | null; percentage: number; fixed_fee: number; minimum: number;
  range_from: string | null; range_to: string | null; add_fuel: boolean; add_security: boolean; add_gst: boolean; source: string | null;
  customer: { name: string; account_code: string } | null;
};

const range = (r: AddonRule, unit = '') => (r.range_from === r.range_to ? `${r.range_from}${unit}` : `${r.range_from}–${r.range_to}${unit}`);
// JetStream's ApplyWhen codes in plain English.
export function when(r: AddonRule) {
  switch (r.apply_when) {
    case 'ALWAYS': return 'Every shipment';
    case 'INSURED': return 'When insured';
    case 'PRIORITY': return 'Priority shipments';
    case 'DTP': return 'Duties and taxes paid by sender';
    case 'DESTPC': case 'DESTPC/KG': return `Destination postcode ${range(r)}`;
    case 'ORIGPC': case 'ORIGPC/KG': return `Origin postcode ${range(r)}`;
    case 'DESTCC': case 'DESTCC/KG': return `Destination country ${range(r)}`;
    case 'ORIGCC/KG': return `Origin country ${range(r)}`;
    case 'DESTCCPC': case 'DESTCC.PC': return `Destination ${range(r)}`;
    case 'ORIGCCPC': case 'ORIGCC.PC': return `Origin ${range(r)}`;
    case 'VALUE': return `Declared value ${range(r)}`;
    case 'TLWEIGHT': return `Total weight ${range(r, ' kg')}`;
    case 'LAST': return 'On top of everything fuel applies to';
    case 'PCWEIGHT': return `Each piece weighing ${range(r, ' kg')}`;
    case 'PCDIM': return `Each piece with a side of ${range(r, ' cm')}`;
    case 'MANUAL': case 'ADHOC': return 'Added by staff when needed';
    case 'ADD=Y': case 'ADD=N': case 'REQUIRED': return 'Rate used by other lines';
    default: return `${r.apply_when} (not applied automatically)`;
  }
}
export function price(r: AddonRule) {
  const min = Number(r.minimum) ? `, min ${money(r.minimum)}` : '';
  const fee = Number(r.fixed_fee) ? `${money(r.fixed_fee)}` : '';
  if (r.code.startsWith('#')) return `${r.percentage}%`;
  if (r.percentage_of === 'W') return `${fee} per ${Number(r.percentage) === 0.5 ? '0.5 kg' : 'kg'}${min}`;
  if (r.percentage_of === 'I') return `${r.percentage}% of insured value${fee ? ` + ${fee}` : ''}${min}`;
  if (Number(r.percentage)) return `${r.percentage}% of freight${fee ? ` + ${fee}` : ''}${min}`;
  return `${fee || money(0)}${min}`;
}
const adds = (r: AddonRule) => [r.add_fuel && 'fuel', r.add_security && 'security', r.add_gst && 'GST'].filter(Boolean).join(', ') || '—';

export async function AddOns({ supabase, canEdit, addonId, q, branch, service, who, when: period }: {
  supabase: Supabase; canEdit: boolean; addonId: string; q: string; branch: string; service: string; who: string; when: string;
}) {
  const today = new Date().toISOString().slice(0, 10);
  let query = supabase.from(SELECTS.addonRules.table).select(SELECTS.addonRules.select, { count: 'exact' })
    .order('code').order('valid_from', { ascending: false }).limit(300);
  if (period !== 'all') query = query.lte('valid_from', today).gte('valid_to', today);
  if (branch) query = query.eq('branch_code', branch);
  if (service) query = query.eq('service_code', service);
  if (who !== 'customers') query = query.is('customer_id', null); else query = query.not('customer_id', 'is', null);
  if (q) { const like = `%${q.replace(/[%_,()]/g, ' ')}%`; query = query.or(`code.ilike.${like},description.ilike.${like}`); }
  query = query.neq('code', '#FUEL');
  const [{ data, count }, { data: services }, { data: branches }] = await Promise.all([
    query,
    supabase.from(SELECTS.tariffServices.table).select(SELECTS.tariffServices.select).order('name'),
    supabase.from(SELECTS.branches.table).select(SELECTS.branches.select).order('code'),
  ]);
  const rules = ((data ?? []) as unknown as AddonRule[]).map((r) => ({ ...r, customer: one(r.customer) }));
  let selected = rules.find((r) => r.id === addonId) ?? null;
  if (!selected && addonId && addonId !== 'new') {
    const { data: one1 } = await supabase.from(SELECTS.addonRules.table).select(SELECTS.addonRules.select).eq('id', addonId).maybeSingle();
    if (one1) selected = { ...(one1 as unknown as AddonRule), customer: one((one1 as unknown as AddonRule).customer) };
  }
  const serviceName = (c: string | null) => (c ? (services ?? []).find((s) => s.code === c)?.name ?? c : 'All services');
  const link = (extra: Record<string, string>) => ({ pathname: '/stream/tariffs', query: { tab: 'addons', ...(q ? { q } : {}), ...(branch ? { branch } : {}), ...(service ? { service } : {}), ...(who ? { who } : {}), ...(period ? { when: period } : {}), ...extra } });
  const editing = addonId === 'new' ? null : selected;
  const showForm = canEdit && (addonId === 'new' || selected);

  return (
    <div className="grid" style={{ gridTemplateColumns: showForm || selected ? 'minmax(0, 1.5fr) minmax(300px, 1fr)' : '1fr', alignItems: 'start' }}>
      <div style={{ minWidth: 0 }}>
        <form className="filters" action="/stream/tariffs">
          <input type="hidden" name="tab" value="addons" />
          <input name="q" defaultValue={q} placeholder="Search code or description" aria-label="Search add-ons" />
          <select name="branch" className="f" defaultValue={branch} aria-label="Branch"><option value="">Both branches</option>{(branches ?? []).map((b) => <option key={b.code} value={b.code}>{b.code}</option>)}</select>
          <select name="service" className="f" defaultValue={service} aria-label="Service"><option value="">Any service</option>{(services ?? []).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select>
          <select name="who" className="f" defaultValue={who} aria-label="Who"><option value="">For every customer</option><option value="customers">Customer-specific</option></select>
          <select name="when" className="f" defaultValue={period} aria-label="When"><option value="">In force today</option><option value="all">Including past and future</option></select>
          <button className="btn">Filter</button>
          {canEdit && <Link className="btn primary" href={link({ addon: 'new' })}>+ New add-on</Link>}
        </form>
        <div className="card" style={{ padding: 0 }}>
          <div className="tw">
            <table>
              <thead><tr><th>Code</th><th>What</th><th>When it applies</th><th>Charge</th><th>Adds</th><th>Service</th><th>Valid</th></tr></thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id} className={r.id === selected?.id ? 'sel' : ''}>
                    <td><Link href={link({ addon: r.id })}><b>{r.code}</b></Link>{r.customer && <div className="hint">{r.customer.name}</div>}</td>
                    <td>{r.description}</td><td>{when(r)}</td><td>{price(r)}</td><td className="hint">{adds(r)}</td>
                    <td className="hint">{r.branch_code} · {serviceName(r.service_code)}</td>
                    <td className="hint">{day(r.valid_from)} – {r.valid_to >= '9999-01-01' ? 'open' : day(r.valid_to)}</td>
                  </tr>
                ))}
                {!rules.length && <tr><td colSpan={7} className="hint">No add-ons match.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <p className="hint mt8">{(count ?? 0).toLocaleString()} add-ons{(count ?? 0) > 300 ? ' (first 300 shown; filter to narrow down)' : ''}. Fuel rates are on the Fuel surcharge tab. Codes starting with &ldquo;z&rdquo; are added by staff by hand.</p>
      </div>

      {showForm && (
        <div className="card">
          <h3>{editing ? `${editing.code} · ${editing.description}` : 'New add-on'}</h3>
          {editing?.customer && <p className="hint">Only for {editing.customer.name} ({editing.customer.account_code}).</p>}
          <form action={saveAddon} className="form mt8" style={{ gridTemplateColumns: '1fr 1fr' }}>
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <div><label htmlFor="a-code">Code</label><input id="a-code" name="code" defaultValue={editing?.code} required /></div>
            <div><label htmlFor="a-desc">Description</label><input id="a-desc" name="description" defaultValue={editing?.description} /></div>
            <div><label htmlFor="a-branch">Branch</label><select id="a-branch" name="branch_code" className="f" defaultValue={editing?.branch_code ?? 'AU'}>{(branches ?? []).map((b) => <option key={b.code} value={b.code}>{b.code}</option>)}</select></div>
            <div><label htmlFor="a-svc">Service</label><select id="a-svc" name="service_code" className="f" defaultValue={editing?.service_code ?? ''}><option value="">All services</option>{(services ?? []).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></div>
            <div className="s2">
              <label htmlFor="a-when">Applies</label>
              <select id="a-when" name="apply_when" className="f" defaultValue={editing?.apply_when ?? 'ALWAYS'}>
                {[['ALWAYS', 'Every shipment'], ['DESTPC', 'Destination postcode range'], ['ORIGPC', 'Origin postcode range'], ['DESTCC', 'Destination country range'],
                  ['DESTCC/KG', 'Destination country, per kg'], ['ORIGCC/KG', 'Origin country, per kg'], ['DESTCC.PC', 'Destination country.postcode range'],
                  ['ORIGCC.PC', 'Origin country.postcode range'], ['INSURED', 'When insured'], ['PRIORITY', 'Priority shipments'], ['DTP', 'Duties and taxes paid'],
                  ['VALUE', 'Declared value range'], ['TLWEIGHT', 'Total weight range (kg)'], ['PCWEIGHT', 'Each piece in a weight range (kg)'],
                  ['PCDIM', 'Each piece with a side in a range (cm)'], ['LAST', 'On top of everything fuel applies to'], ['MANUAL', 'Added by staff']]
                  .map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div><label htmlFor="a-rf">Range from</label><input id="a-rf" name="range_from" defaultValue={editing?.range_from ?? ''} placeholder="e.g. 0800 or GB" /></div>
            <div><label htmlFor="a-rt">Range to</label><input id="a-rt" name="range_to" defaultValue={editing?.range_to ?? ''} placeholder="e.g. 0899 or GB" /></div>
            <div>
              <label htmlFor="a-of">Charged as</label>
              <select id="a-of" name="percentage_of" className="f" defaultValue={editing?.percentage_of ?? 'F'}>
                <option value="F">% of freight + fee</option><option value="I">% of insured value + fee</option><option value="W">Fee per weight (0.5 or 1 kg)</option>
              </select>
            </div>
            <div><label htmlFor="a-pct">Percent (or 0.5 / 1 for per weight)</label><input id="a-pct" name="percentage" defaultValue={editing?.percentage ?? 0} inputMode="decimal" /></div>
            <div><label htmlFor="a-fee">Fee $</label><input id="a-fee" name="fixed_fee" defaultValue={editing?.fixed_fee ?? 0} inputMode="decimal" /></div>
            <div><label htmlFor="a-min">Minimum $</label><input id="a-min" name="minimum" defaultValue={editing?.minimum ?? 0} inputMode="decimal" /></div>
            <div className="s2 flex">
              <label style={{ margin: 0 }}><input type="checkbox" name="add_fuel" defaultChecked={editing?.add_fuel} /> Adds fuel</label>
              <label style={{ margin: 0 }}><input type="checkbox" name="add_security" defaultChecked={editing?.add_security} /> Adds security</label>
              <label style={{ margin: 0 }}><input type="checkbox" name="add_gst" defaultChecked={editing?.add_gst ?? true} /> Adds GST</label>
            </div>
            <div><label htmlFor="a-from">Valid from</label><input id="a-from" name="valid_from" type="date" defaultValue={editing?.valid_from ?? today} required /></div>
            <div><label htmlFor="a-to">Valid to</label><input id="a-to" name="valid_to" type="date" defaultValue={editing && editing.valid_to < '9999-01-01' ? editing.valid_to : ''} /></div>
            <div className="s2"><button className="btn primary">{editing ? 'Save changes' : 'Create add-on'}</button></div>
          </form>
          {editing && (
            <>
              <form action={endAddon} className="flex mt">
                <input type="hidden" name="id" value={editing.id} />
                <label htmlFor="a-end" style={{ margin: 0 }}>End on</label>
                <input id="a-end" type="date" name="valid_to" defaultValue={today} style={{ width: 160 }} />
                <button className="btn">End add-on</button>
              </form>
              <p className="hint mt8">To change a price from a date, end this add-on the day before and create a new one, so past jobs keep the price they were charged.{editing.source === 'jetstream' ? ' Imported from JetStream.' : ''}</p>
            </>
          )}
        </div>
      )}
      {!showForm && selected && (
        <div className="card">
          <h3>{selected.code} · {selected.description}</h3>
          <p>{when(selected)} · {price(selected)} · adds {adds(selected)}</p>
        </div>
      )}
    </div>
  );
}

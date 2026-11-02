import Link from 'next/link';
import { one } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import type { createClient } from '@/lib/supabase/server';
import { createSalesTariff } from './actions';
import { LaneEditor } from './LaneEditor';
import { TariffGrid, type Rate } from './TariffGrid';

type Supabase = Awaited<ReturnType<typeof createClient>>;
type Sales = { id: string; code: string; name: string; base_tariff_id: string; branch_code: string; service_code: string | null; base: { code: string; name: string } | null };
const GRID_MAX_RATES = 1000;
const PAGE = 100;
const toRate = (r: Record<string, unknown>): Rate => ({
  zone_code: String(r.zone_code), kind: r.kind as Rate['kind'], from_kg: Number(r.from_kg), to_kg: Number(r.to_kg), step_kg: Number(r.step_kg),
  method: r.method as Rate['method'], charge: Number(r.charge), basic: Number(r.basic), minimum: Number(r.minimum),
});

export async function SalesTariffs({ supabase, canEdit, salesId, q, branch, service, zq, page }: {
  supabase: Supabase; canEdit: boolean; salesId: string; q: string; branch: string; service: string; zq: string; page: number;
}) {
  let list = supabase.from(SELECTS.salesTariffs.table).select(SELECTS.salesTariffs.select).order('code').limit(400);
  if (branch) list = list.eq('branch_code', branch);
  if (service) list = list.eq('service_code', service);
  if (q) list = list.or(`code.ilike.%${q.replace(/[%_,()]/g, ' ')}%,name.ilike.%${q.replace(/[%_,()]/g, ' ')}%`);
  const [{ data: sdata }, { data: usage }, { data: services }, { data: bases }] = await Promise.all([
    list,
    supabase.from(SELECTS.salesUsage.table).select(SELECTS.salesUsage.select).limit(1000),
    supabase.from(SELECTS.tariffServices.table).select(SELECTS.tariffServices.select).order('name'),
    supabase.from(SELECTS.baseTariffs.table).select(SELECTS.baseTariffs.select).eq('cost_only', false).order('code'),
  ]);
  const used = new Map((usage ?? []).map((u) => [u.sales_tariff_id, u.customers]));
  const sales = ((sdata ?? []) as unknown as Sales[]).map((s) => ({ ...s, base: one(s.base) }));
  const serviceName = (c: string | null) => (services ?? []).find((s) => s.code === c)?.name ?? c ?? '—';

  // The selected tariff may not be in the filtered list; load it on its own.
  let selected = sales.find((s) => s.id === salesId) ?? null;
  if (!selected && salesId) {
    const { data } = await supabase.from(SELECTS.salesTariffs.table).select(SELECTS.salesTariffs.select).eq('id', salesId).maybeSingle();
    if (data) selected = { ...(data as unknown as Sales), base: one((data as unknown as Sales).base) };
  }
  selected ??= [...sales].sort((a, b) => (used.get(b.id) ?? 0) - (used.get(a.id) ?? 0))[0] ?? null;

  let editor: React.ReactNode = null;
  let customers: { id: string; name: string; account_code: string }[] = [];
  if (selected) {
    const today = new Date().toISOString().slice(0, 10);
    const { data: live } = await supabase.from(SELECTS.tariffVersions.table).select(SELECTS.tariffVersions.select)
      .eq('tariff_id', selected.base_tariff_id).eq('status', 'published').lte('valid_from', today).order('valid_from', { ascending: false }).limit(1);
    const version = live?.[0];
    const { data: onIt } = await supabase.from(SELECTS.salesCustomers.table).select(SELECTS.salesCustomers.select)
      .eq('sales_tariff_id', selected.id).lte('effective_from', today).or(`effective_to.is.null,effective_to.gte.${today}`).limit(200);
    type Cust = { id: string; name: string; account_code: string };
    customers = (onIt ?? []).map((c) => one(c.customer as unknown as Cust | Cust[] | null)).filter((c): c is Cust => !!c);
    if (version) {
      const { count } = await supabase.from(SELECTS.tariffRates.table).select('zone_code', { count: 'exact', head: true }).eq('version_id', version.id);
      if ((count ?? 0) <= GRID_MAX_RATES) {
        const [{ data: rates }, { data: margins }] = await Promise.all([
          supabase.from(SELECTS.tariffRates.table).select(SELECTS.tariffRates.select).eq('version_id', version.id).limit(GRID_MAX_RATES),
          supabase.from(SELECTS.salesMargins.table).select(SELECTS.salesMargins.select).eq('sales_tariff_id', selected.id).limit(GRID_MAX_RATES),
        ]);
        const rs = (rates ?? []).map(toRate);
        const zones = [...new Set(rs.map((r) => r.zone_code))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        editor = (
          <TariffGrid key={selected.id} mode="margins" id={selected.id} editable={canEdit} zones={zones} rates={rs}
            margins={Object.fromEntries((margins ?? []).map((m) => [`${m.kind}|${Number(m.to_kg)}|${m.zone_code}`, Number(m.margin_pct)]))} fileName={`${selected.code}-margins`} />
        );
      } else {
        let rq = supabase.from(SELECTS.tariffRates.table).select(SELECTS.tariffRates.select, { count: 'exact' }).eq('version_id', version.id);
        if (zq) rq = rq.ilike('zone_code', `%${zq.replace(/[%_]/g, '')}%`);
        const { data: rates, count: matching } = await rq.order('zone_code').order('kind').order('to_kg').range(page * PAGE, page * PAGE + PAGE - 1);
        const rs = (rates ?? []).map(toRate);
        const zonesOnPage = [...new Set(rs.map((r) => r.zone_code))];
        const { data: margins } = zonesOnPage.length
          ? await supabase.from(SELECTS.salesMargins.table).select(SELECTS.salesMargins.select).eq('sales_tariff_id', selected.id).in('zone_code', zonesOnPage).limit(1000)
          : { data: [] };
        const pages = Math.ceil((matching ?? 0) / PAGE);
        const link = (p: number) => ({ pathname: '/stream/tariffs', query: { tab: 'sales', sales: selected!.id, ...(zq ? { zq } : {}), page: p } });
        editor = (
          <>
            <form className="filters" action="/stream/tariffs">
              <input type="hidden" name="tab" value="sales" /><input type="hidden" name="sales" value={selected.id} />
              <input name="zq" defaultValue={zq} placeholder="Filter zones / lanes" aria-label="Filter zones" />
              <button className="btn">Filter</button>
              <span className="hint">{(matching ?? 0).toLocaleString()} rates{pages > 1 ? ` · page ${page + 1} of ${pages}` : ''}</span>
              {page > 0 && <Link className="btn sm" href={link(page - 1)}>← Previous</Link>}
              {page + 1 < pages && <Link className="btn sm" href={link(page + 1)}>Next →</Link>}
            </form>
            <LaneEditor key={`${selected.id}:${zq}:${page}`} mode="margins" id={selected.id} editable={canEdit} rows={rs}
              margins={Object.fromEntries((margins ?? []).map((m) => [`${m.zone_code}|${m.kind}|${Number(m.to_kg)}`, Number(m.margin_pct)]))} />
          </>
        );
      }
    } else {
      editor = <div className="card"><p className="hint">The rate card {selected.base?.code} has no published version in force, so there&apos;s nothing to set margins against.</p></div>;
    }
  }

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(260px, 340px) 1fr', alignItems: 'start' }}>
      <div className="grid">
        <div className="card" style={{ padding: 0 }}>
          <form action="/stream/tariffs" style={{ padding: '12px 12px 0', display: 'grid', gap: 8 }}>
            <input type="hidden" name="tab" value="sales" />
            <input name="q" defaultValue={q} placeholder="Search code or name" aria-label="Search sales tariffs" style={{ maxWidth: 'none' }} />
            <div className="flex">
              <select name="branch" className="f" defaultValue={branch} aria-label="Branch" style={{ width: 'auto' }}>
                <option value="">Both branches</option><option value="AU">Sydney</option><option value="NZ">Auckland</option>
              </select>
              <select name="service" className="f" defaultValue={service} aria-label="Service" style={{ width: 'auto' }}>
                <option value="">All services</option>
                {(services ?? []).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
              </select>
              <button className="btn sm">Filter</button>
            </div>
          </form>
          <div style={{ maxHeight: 520, overflow: 'auto' }}>
            <table>
              <thead><tr><th>Sales tariff ({sales.length})</th><th className="r">Customers</th></tr></thead>
              <tbody>
                {sales.map((s) => (
                  <tr key={s.id} className={s.id === selected?.id ? 'sel' : ''}>
                    <td>
                      <Link href={{ pathname: '/stream/tariffs', query: { tab: 'sales', sales: s.id, ...(q ? { q } : {}), ...(branch ? { branch } : {}), ...(service ? { service } : {}) } }} scroll={false}>
                        <b>{s.code}</b>
                      </Link>
                      <div className="hint">{s.branch_code} · {serviceName(s.service_code)}</div>
                    </td>
                    <td className="r">{used.get(s.id) ?? 0}</td>
                  </tr>
                ))}
                {!sales.length && <tr><td colSpan={2} className="hint">No sales tariffs match.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        {canEdit && (
          <details className="card">
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>+ New sales tariff</summary>
            <form action={createSalesTariff} className="form mt8" style={{ gridTemplateColumns: '1fr' }}>
              <div><label htmlFor="code">Code</label><input id="code" name="code" placeholder="e.g. RESELLER" required /></div>
              <div><label htmlFor="name">Name</label><input id="name" name="name" placeholder="e.g. Reseller accounts" required /></div>
              <div>
                <label htmlFor="base">Rate card</label>
                <select id="base" name="base_tariff_id" className="f" required>
                  {(bases ?? []).map((b) => <option key={b.id} value={b.id}>{b.code} ({b.branch_code})</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="copy">Copy margins from</label>
                <select id="copy" name="copy_from" className="f" defaultValue={selected?.id ?? ''}>
                  <option value="">Start blank</option>
                  {sales.map((s) => <option key={s.id} value={s.id}>{s.code} ({s.branch_code})</option>)}
                </select>
              </div>
              <div><button className="btn">Create</button></div>
            </form>
          </details>
        )}
      </div>

      {selected && (
        <div className="grid" style={{ minWidth: 0 }}>
          <div className="card">
            <h3>{selected.code} · {selected.name}</h3>
            <div className="hint">{selected.branch_code} · {serviceName(selected.service_code)} · margin on top of {selected.base?.code}</div>
            <div className="mt8">
              <b>Customers on this tariff ({used.get(selected.id) ?? customers.length})</b>
              {customers.length ? (
                <div className="flex mt8">{customers.slice(0, 40).map((c) => <Link key={c.id} className="pill" href={`/stream/customers/${c.id}`}>{c.name}</Link>)}
                  {customers.length > 40 && <span className="hint">+{customers.length - 40} more</span>}</div>
              ) : <p className="hint">Nobody yet. Assign customers from their page under Customers.</p>}
            </div>
          </div>
          {editor}
        </div>
      )}
    </div>
  );
}

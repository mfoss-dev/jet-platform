import Link from 'next/link';
import { money } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import type { createClient } from '@/lib/supabase/server';
import { moveCustomers, setStandard } from './actions';

type Supabase = Awaited<ReturnType<typeof createClient>>;
type Review = {
  id: string; code: string; name: string; branch_code: string; service_code: string | null; is_standard: boolean; base_tariff_id: string;
  rate_card: string; customers: number; cells: number; min_margin: number | null; avg_margin: number | null; max_margin: number | null;
  distinct_margins: number; jobs_12m: number; freight_12m: number;
};
type Preview = { customer_id: string; name: string; account_code: string; service_code: string; jobs: number; billed: number; current_price: number; new_price: number; unpriced: number };

const pct = (n: number | null) => (n == null ? '—' : `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`);

// What makes a tariff worth a look. Below-cost and very high margins are the ones JetStream's import brought across.
function flags(r: Review) {
  const f: [string, 'bad' | 'warn' | ''][] = [];
  if (r.min_margin != null && r.min_margin < 0) f.push(['Below cost', 'bad']);
  if (r.max_margin != null && r.max_margin > 200) f.push(['Margin over 200%', 'warn']);
  if (!r.cells) f.push(['No margins', 'bad']);
  if (!r.customers) f.push(['Unused', '']);
  else if (r.customers === 1 && !r.is_standard) f.push(['One customer', '']);
  return f;
}

function nextMonday() {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

// Standardising pricing: spot outlier tariffs, see what moving their customers to the standard would do to each one's
// bill (re-pricing their own jobs from the last 12 months), then move them from a start date.
export async function Standardise({ supabase, canEdit, branch, service, show, from, to }: {
  supabase: Supabase; canEdit: boolean; branch: string; service: string; show: string; from: string; to: string;
}) {
  let list = supabase.from(SELECTS.salesReview.table).select(SELECTS.salesReview.select).order('freight_12m', { ascending: false }).limit(1000);
  if (branch) list = list.eq('branch_code', branch);
  if (service) list = list.eq('service_code', service);
  const [{ data }, { data: services }] = await Promise.all([
    list,
    supabase.from(SELECTS.tariffServices.table).select(SELECTS.tariffServices.select).order('name'),
  ]);
  const all = (data ?? []) as unknown as Review[];
  const serviceName = (c: string | null) => (services ?? []).find((s) => s.code === c)?.name ?? c ?? 'All services';
  const rows = show === 'all' ? all : all.filter((r) => flags(r).length || r.is_standard);
  const groups = [...new Set(rows.map((r) => `${r.branch_code}|${r.service_code ?? ''}`))].sort();
  const keep = { ...(branch ? { branch } : {}), ...(service ? { service } : {}), ...(show ? { show } : {}) };
  const here = new URLSearchParams({ tab: 'standardise', ...keep }).toString();

  // The tariff being reviewed, and the one its customers might move to (same branch; same service, or one for all services).
  let source: Review | null = null;
  let targets: Review[] = [];
  let target: Review | null = null;
  let preview: Preview[] = [];
  let previewError: string | null = null;
  if (from) {
    source = all.find((r) => r.id === from) ?? null;
    if (!source) source = ((await supabase.from(SELECTS.salesReview.table).select(SELECTS.salesReview.select).eq('id', from).maybeSingle()).data ?? null) as unknown as Review | null;
  }
  if (source) {
    const { data: t } = await supabase.from(SELECTS.salesReview.table).select(SELECTS.salesReview.select)
      .eq('branch_code', source.branch_code).neq('id', source.id).limit(1000);
    targets = ((t ?? []) as unknown as Review[]).filter((r) => !r.service_code || r.service_code === source.service_code)
      .sort((a, b) => Number(b.is_standard) - Number(a.is_standard) || Number(a.service_code == null) - Number(b.service_code == null) || b.customers - a.customers);
    target = targets.find((r) => r.id === to) ?? targets[0] ?? null;
    if (target) {
      const { data: p, error } = await supabase.rpc('tariff_switch_preview', { p_from: source.id, p_to: target.id });
      preview = ((p ?? []) as Preview[]).map((r) => ({ ...r, billed: Number(r.billed), current_price: Number(r.current_price), new_price: Number(r.new_price) }));
      previewError = error?.message ?? null;
    }
  }
  const total = preview.reduce((a, r) => ({ jobs: a.jobs + r.jobs, cur: a.cur + r.current_price, next: a.next + r.new_price }), { jobs: 0, cur: 0, next: 0 });
  const change = (cur: number, next: number) => {
    if (!cur) return <span className="hint">—</span>;
    const d = next - cur;
    return <span className={d > 0.005 ? 'warn-t' : d < -0.005 ? 'ok-t' : ''}>{d > 0 ? '+' : ''}{money(d)} ({d > 0 ? '+' : ''}{pct((d / cur) * 100)})</span>;
  };

  return (
    <div className="grid">
      <div className="card">
        <h3>Standardise pricing</h3>
        <p className="hint">
          Each branch and service can have one <b>standard</b> tariff. Tariffs below are flagged when they price below cost, carry margins over 200%,
          or serve a single customer. Open one to see what each of its customers would pay on another tariff, worked out on their own jobs from the
          last 12 months, then move them from a start date. Jobs before that date keep their price.
        </p>
        <form action="/stream/tariffs" className="filters mt8">
          <input type="hidden" name="tab" value="standardise" />
          <select name="branch" className="f" defaultValue={branch} aria-label="Branch" style={{ width: 'auto' }}>
            <option value="">Both branches</option><option value="AU">Sydney</option><option value="NZ">Auckland</option>
          </select>
          <select name="service" className="f" defaultValue={service} aria-label="Service" style={{ width: 'auto' }}>
            <option value="">All services</option>
            {(services ?? []).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
          <select name="show" className="f" defaultValue={show} aria-label="Show" style={{ width: 'auto' }}>
            <option value="">Flagged and standard tariffs</option><option value="all">Every tariff</option>
          </select>
          <button className="btn">Show</button>
          <span className="hint">{rows.length} of {all.length} tariffs</span>
        </form>
      </div>

      {source && (
        <div className="card">
          <h3>Move customers off {source.code}</h3>
          <div className="hint">{source.branch_code} · {serviceName(source.service_code)} · {source.name} · on {source.rate_card} · {source.customers} customers</div>
          {targets.length ? (
            <form action="/stream/tariffs" className="filters mt8">
              <input type="hidden" name="tab" value="standardise" /><input type="hidden" name="from" value={source.id} />
              {Object.entries(keep).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
              <label htmlFor="to" style={{ margin: 0 }}>Compare with</label>
              <select id="to" name="to" className="f" defaultValue={target?.id} style={{ width: 'auto' }}>
                {targets.map((t) => <option key={t.id} value={t.id}>{t.code}{t.is_standard ? ' (standard)' : ''} · {t.customers} customers · avg {pct(t.avg_margin)}</option>)}
              </select>
              <button className="btn">Compare</button>
            </form>
          ) : <p className="hint mt8">There is no other tariff for this branch and service to move to. Create one under Sales tariffs.</p>}
          {target && target.rate_card !== source.rate_card && (
            <div className="banner mt8">{target.code} uses a different rate card ({target.rate_card}), so the comparison includes the difference in cost rates as well as margin.</div>
          )}
          {previewError && <div className="banner warn mt8">{previewError}</div>}
          {target && !previewError && (
            <form action={moveCustomers} className="mt">
              <input type="hidden" name="from" value={source.id} /><input type="hidden" name="to" value={target.id} />
              <table>
                <thead>
                  <tr><th>{canEdit ? 'Move' : ''}</th><th>Customer</th><th className="r">Jobs</th><th className="r">On {source.code}</th><th className="r">On {target.code}</th><th className="r">Change</th><th className="r">Not priced</th></tr>
                </thead>
                <tbody>
                  {preview.map((r) => (
                    <tr key={`${r.customer_id}|${r.service_code}`}>
                      <td>{canEdit && <input type="checkbox" name="customer" value={r.customer_id} defaultChecked aria-label={`Move ${r.name}`} />}</td>
                      <td><Link href={`/stream/customers/${r.customer_id}`}>{r.name}</Link> <span className="hint">{r.account_code}</span></td>
                      <td className="r">{r.jobs}</td><td className="r">{r.jobs ? money(r.current_price) : '—'}</td><td className="r">{r.jobs ? money(r.new_price) : '—'}</td>
                      <td className="r">{change(r.current_price, r.new_price)}</td>
                      <td className="r">{r.unpriced ? <span className="pill warn">{r.unpriced}</span> : '—'}</td>
                    </tr>
                  ))}
                  {!preview.length && <tr><td colSpan={7} className="hint">Nobody is on {source.code} today.</td></tr>}
                  {preview.length > 1 && (
                    <tr><td /><td><b>All customers</b></td><td className="r"><b>{total.jobs}</b></td><td className="r"><b>{money(total.cur)}</b></td><td className="r"><b>{money(total.next)}</b></td><td className="r"><b>{change(total.cur, total.next)}</b></td><td /></tr>
                  )}
                </tbody>
              </table>
              <p className="hint mt8">
                Freight only (before fuel and add-ons), at today&apos;s published rate cards, on each customer&apos;s jobs from the last 12 months. Both columns
                count only jobs both tariffs can price; &ldquo;not priced&rdquo; jobs have no zone, rate or margin on one of them. The imported history starts in July 2026, when JetStream began itemising freight.
              </p>
              {canEdit && preview.length > 0 && (
                <div className="flex mt8">
                  <label htmlFor="start" style={{ margin: 0 }}>New prices start</label>
                  <input id="start" name="start" type="date" defaultValue={nextMonday()} min={new Date().toISOString().slice(0, 10)} required style={{ width: 'auto' }} />
                  <button className="btn primary">Move ticked customers to {target.code}</button>
                </div>
              )}
            </form>
          )}
        </div>
      )}

      {groups.map((g) => {
        const [b, s] = g.split('|');
        const mine = rows.filter((r) => r.branch_code === b && (r.service_code ?? '') === s);
        const std = all.find((r) => r.branch_code === b && (r.service_code ?? '') === s && r.is_standard);
        return (
          <div className="card" key={g}>
            <h3>{b} · {serviceName(s || null)}</h3>
            <div className="hint">{std ? <>Standard: <b>{std.code}</b> · {std.name}</> : 'No standard tariff chosen yet: mark the one most customers should be on.'}</div>
            <table className="mt8">
              <thead>
                <tr><th>Sales tariff</th><th>Rate card</th><th className="r">Customers</th><th className="r">Jobs (12 months)</th><th className="r">Freight (12 months)</th><th className="r">Average margin</th><th className="r">Range</th><th>Flags</th><th /></tr>
              </thead>
              <tbody>
                {mine.map((r) => (
                  <tr key={r.id} className={r.id === source?.id ? 'sel' : ''}>
                    <td><b>{r.code}</b> {r.is_standard && <span className="pill ok">Standard</span>}<div className="hint">{r.name}</div></td>
                    <td>{r.rate_card}</td>
                    <td className="r">{r.customers}</td><td className="r">{r.jobs_12m.toLocaleString()}</td><td className="r">{money(r.freight_12m)}</td>
                    <td className="r">{pct(r.avg_margin)}</td>
                    <td className="r">{r.cells ? `${pct(r.min_margin)} to ${pct(r.max_margin)}` : '—'}</td>
                    <td><div className="flex">{flags(r).map(([f, c]) => <span key={f} className={`pill ${c}`}>{f}</span>)}</div></td>
                    <td className="r">
                      <div className="flex" style={{ justifyContent: 'flex-end' }}>
                        {r.customers > 0 && !r.is_standard && <Link className="btn sm" href={{ pathname: '/stream/tariffs', query: { tab: 'standardise', ...keep, from: r.id } }}>Review</Link>}
                        <Link className="btn sm ghost" href={{ pathname: '/stream/tariffs', query: { tab: 'sales', sales: r.id } }}>Margins</Link>
                        {canEdit && (
                          <form action={setStandard}>
                            <input type="hidden" name="id" value={r.id} /><input type="hidden" name="return" value={here} />
                            {r.is_standard ? <><input type="hidden" name="standard" value="off" /><button className="btn sm ghost">Unmark</button></>
                              : <button className="btn sm ghost">Make standard</button>}
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      {!groups.length && <div className="card"><p className="hint">No tariffs match. Choose &ldquo;Every tariff&rdquo; to see them all.</p></div>}
    </div>
  );
}

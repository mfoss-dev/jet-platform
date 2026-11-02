import Link from 'next/link';
import { day, one } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import type { createClient } from '@/lib/supabase/server';
import { adjustDraft, createRateCard, deleteDraft, newDraft, publishVersion } from './actions';
import { LaneEditor } from './LaneEditor';
import { TariffGrid, type Rate } from './TariffGrid';

type Supabase = Awaited<ReturnType<typeof createClient>>;
type Version = {
  id: string; tariff_id: string; version: number; status: 'draft' | 'published'; valid_from: string | null; note: string | null;
  volumetric_divisor: number; published_at: string | null; publisher: { full_name: string } | null;
};
const GRID_MAX_RATES = 1000;   // above this (domestic lane cards) the lane list is used; also the API's page limit
const PAGE = 100;

const toRate = (r: Record<string, unknown>): Rate => ({
  zone_code: String(r.zone_code), kind: r.kind as Rate['kind'], from_kg: Number(r.from_kg), to_kg: Number(r.to_kg), step_kg: Number(r.step_kg),
  method: r.method as Rate['method'], charge: Number(r.charge), basic: Number(r.basic), minimum: Number(r.minimum),
});

async function allRates(supabase: Supabase, versionId: string) {
  const { data } = await supabase.from(SELECTS.tariffRates.table).select(SELECTS.tariffRates.select).eq('version_id', versionId).order('zone_code').limit(GRID_MAX_RATES);
  return (data ?? []).map(toRate);
}

export async function RateCards({ supabase, canEdit, canPublish, tariffId, versionId, zq, page }: {
  supabase: Supabase; canEdit: boolean; canPublish: boolean; tariffId: string; versionId: string; zq: string; page: number;
}) {
  const [{ data: tariffs }, { data: carriers }, { data: branches }, { data: services }, { data: zoneSets }, { data: allVersions }] = await Promise.all([
    supabase.from(SELECTS.baseTariffs.table).select(SELECTS.baseTariffs.select).order('branch_code').order('code'),
    supabase.from(SELECTS.carriers.table).select(SELECTS.carriers.select).eq('active', true).order('name'),
    supabase.from(SELECTS.branches.table).select(SELECTS.branches.select).order('code'),
    supabase.from(SELECTS.tariffServices.table).select(SELECTS.tariffServices.select).order('name'),
    supabase.from(SELECTS.zoneSets.table).select(SELECTS.zoneSets.select).order('branch_code').order('code'),
    supabase.from(SELECTS.tariffVersions.table).select(SELECTS.tariffVersions.select).eq('status', 'published').order('valid_from', { ascending: false }),
  ]);
  const serviceName = (c: string | null) => (services ?? []).find((s) => s.code === c)?.name ?? c ?? '—';
  const copyFrom = (tariffs ?? []).flatMap((t) => {
    const v = (allVersions ?? []).find((x) => x.tariff_id === t.id);
    return v ? [{ id: v.id, label: `${t.code} (${t.branch_code}, version ${v.version})` }] : [];
  });

  const newCard = canEdit && (
    <details className="card">
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>+ New rate card</summary>
      <form action={createRateCard} className="form mt8" style={{ gridTemplateColumns: '1fr' }}>
        <div><label htmlFor="rc-code">Code</label><input id="rc-code" name="code" placeholder="e.g. FDX.OUT.EXPR" required /></div>
        <div><label htmlFor="rc-name">Name</label><input id="rc-name" name="name" placeholder="e.g. FedEx international outbound" required /></div>
        <div>
          <label htmlFor="rc-service">Service</label>
          <select id="rc-service" name="service_code" className="f" required>{(services ?? []).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select>
        </div>
        <div>
          <label htmlFor="rc-carrier">Carrier</label>
          <select id="rc-carrier" name="carrier_code" className="f" required>{(carriers ?? []).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select>
        </div>
        <div>
          <label htmlFor="rc-branch">Branch</label>
          <select id="rc-branch" name="branch_code" className="f" required>{(branches ?? []).map((b) => <option key={b.code} value={b.code}>{b.name} ({b.code})</option>)}</select>
        </div>
        <div>
          <label htmlFor="rc-zones">Zone guide</label>
          <select id="rc-zones" name="zone_set_id" className="f" defaultValue="">
            <option value="">None yet</option>
            {(zoneSets ?? []).map((z) => <option key={z.id} value={z.id}>{z.code} · {z.branch_code} · {z.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="rc-copy">Start from</label>
          <select id="rc-copy" name="copy_version" className="f" defaultValue="">
            <option value="">Blank (add your own weight breaks)</option>
            {copyFrom.map((c) => <option key={c.id} value={c.id}>A copy of {c.label}</option>)}
          </select>
        </div>
        <div><button className="btn primary">Create draft</button></div>
      </form>
    </details>
  );

  if (!tariffs?.length) {
    return (
      <div className="grid" style={{ gridTemplateColumns: 'minmax(220px, 320px) 1fr', alignItems: 'start' }}>
        {newCard}
        <div className="card"><h3>No rate cards yet</h3><p className="hint">Import them from JetStream (scripts/jetstream-import) or create one here.</p></div>
      </div>
    );
  }

  const tariff = tariffs.find((t) => t.id === tariffId) ?? tariffs.find((t) => !t.cost_only) ?? tariffs[0];
  const { data: vdata } = await supabase.from(SELECTS.tariffVersions.table).select(SELECTS.tariffVersions.select).eq('tariff_id', tariff.id).order('version', { ascending: false });
  const versions = ((vdata ?? []) as unknown as Version[]).map((v) => ({ ...v, publisher: one(v.publisher) }));
  const today = new Date().toISOString().slice(0, 10);
  const published = versions.filter((v) => v.status === 'published').sort((a, b) => (b.valid_from ?? '').localeCompare(a.valid_from ?? ''));
  const live = published.find((v) => (v.valid_from ?? '') <= today) ?? null;
  const latestPublished = published[0] ?? null;
  const draft = versions.find((v) => v.status === 'draft') ?? null;
  const selected = versions.find((v) => v.id === versionId) ?? draft ?? live ?? versions[0];
  const label = (v: Version) =>
    v.status === 'draft' ? 'Draft' : (v.valid_from ?? '') > today ? `Starts ${day(v.valid_from)}` : v.id === live?.id ? 'Live now' : 'Past';
  const minDate = latestPublished?.valid_from ? new Date(new Date(latestPublished.valid_from).getTime() + 864e5).toISOString().slice(0, 10) : today;

  const { count } = selected
    ? await supabase.from(SELECTS.tariffRates.table).select('zone_code', { count: 'exact', head: true }).eq('version_id', selected.id)
    : { count: 0 };
  const laneMode = (count ?? 0) > GRID_MAX_RATES;
  const editable = selected?.status === 'draft' && canEdit;

  let body: React.ReactNode = null;
  if (selected && !laneMode) {
    const rates = await allRates(supabase, selected.id);
    const compare = selected.status === 'draft' && live
      ? Object.fromEntries((await allRates(supabase, live.id)).map((r) => [`${r.kind}|${r.to_kg}|${r.zone_code}`, r.charge]))
      : null;
    const zones = [...new Set(rates.map((r) => r.zone_code))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    body = (
      <TariffGrid key={selected.id} mode="rates" id={selected.id} editable={editable} zones={zones} rates={rates} compare={compare}
        compareLabel={live ? `version ${live.version}` : undefined} note={selected.note ?? ''} fileName={`${tariff.code}-v${selected.version}`} />
    );
  } else if (selected) {
    let query = supabase.from(SELECTS.tariffRates.table).select(SELECTS.tariffRates.select, { count: 'exact' }).eq('version_id', selected.id);
    if (zq) query = query.ilike('zone_code', `%${zq.replace(/[%_]/g, '')}%`);
    const { data, count: matching } = await query.order('zone_code').order('kind').order('to_kg').range(page * PAGE, page * PAGE + PAGE - 1);
    const pages = Math.ceil((matching ?? 0) / PAGE);
    const link = (p: number) => ({ pathname: '/stream/tariffs', query: { tab: 'rates', tariff: tariff.id, version: selected.id, ...(zq ? { zq } : {}), page: p } });
    body = (
      <>
        <form className="filters" action="/stream/tariffs">
          <input type="hidden" name="tab" value="rates" /><input type="hidden" name="tariff" value={tariff.id} /><input type="hidden" name="version" value={selected.id} />
          <input name="zq" defaultValue={zq} placeholder="Filter zones / lanes, e.g. SYD- or MEL" aria-label="Filter zones" />
          <button className="btn">Filter</button>
          <span className="hint">{(matching ?? 0).toLocaleString()} of {(count ?? 0).toLocaleString()} rates{pages > 1 ? ` · page ${page + 1} of ${pages}` : ''}</span>
          {page > 0 && <Link className="btn sm" href={link(page - 1)}>← Previous</Link>}
          {page + 1 < pages && <Link className="btn sm" href={link(page + 1)}>Next →</Link>}
        </form>
        {editable && (
          <form action={adjustDraft} className="card flex" style={{ marginBottom: 12 }}>
            <input type="hidden" name="version_id" value={selected.id} /><input type="hidden" name="tariff_id" value={tariff.id} />
            <input type="hidden" name="zone_like" value={zq} />
            <b>Adjust prices</b>
            <input name="pct" placeholder="e.g. 3.5" aria-label="Percent change" style={{ width: 110 }} inputMode="decimal" required /> <span>%</span>
            <span className="hint">for {zq ? <>all {(matching ?? 0).toLocaleString()} rates matching &ldquo;{zq}&rdquo;</> : <>all {(count ?? 0).toLocaleString()} rates on this card</>} (rate, basic and minimum)</span>
            <button className="btn">Apply</button>
          </form>
        )}
        <LaneEditor key={`${selected.id}:${zq}:${page}`} mode="rates" id={selected.id} editable={editable} rows={(data ?? []).map(toRate)} />
      </>
    );
  }

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(220px, 300px) 1fr', alignItems: 'start' }}>
      <div className="grid">
        <div className="card">
          <h3>Rate cards ({tariffs.length})</h3>
          {(branches ?? []).map((b) => (
            <div key={b.code} className="mt8">
              <div className="hint" style={{ textTransform: 'uppercase', letterSpacing: '.05em' }}>{b.name}</div>
              {tariffs.filter((t) => t.branch_code === b.code).map((t) => (
                <div key={t.id} style={{ margin: '4px 0' }}>
                  <Link href={{ pathname: '/stream/tariffs', query: { tab: 'rates', tariff: t.id } }} scroll={false}>
                    {t.id === tariff.id ? <b>{t.code}</b> : t.code}
                  </Link>
                  {t.cost_only && <span className="pill" style={{ marginLeft: 6 }}>cost</span>}
                  <div className="hint">{serviceName(t.service_code)}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
        {newCard}
      </div>

      <div style={{ minWidth: 0 }}>
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="flex between">
            <div>
              <h2 style={{ margin: 0, fontSize: 18 }}>{tariff.name}</h2>
              <div className="hint">
                {serviceName(tariff.service_code)} · {tariff.carrier_code} · {tariff.branch_code}
                {tariff.cost_only && ' · carrier cost card (for comparison, not used to price customers)'}
              </div>
            </div>
            {canEdit && !draft && latestPublished && (
              <form action={newDraft}>
                <input type="hidden" name="tariff_id" value={tariff.id} /><input type="hidden" name="from_version" value={latestPublished.id} />
                <button className="btn">Start a new draft</button>
              </form>
            )}
          </div>
          <div className="flex mt8">
            {versions.map((v) => (
              <Link key={v.id} href={{ pathname: '/stream/tariffs', query: { tab: 'rates', tariff: tariff.id, version: v.id } }} scroll={false}
                className={`pill ${v.status === 'draft' ? 'warn' : v.id === live?.id ? 'ok' : ''}`} style={v.id === selected?.id ? { outline: '2px solid var(--brand)' } : undefined}>
                Version {v.version} · {label(v)}
              </Link>
            ))}
          </div>
          {selected && (
            <div className="hint mt8">
              {selected.status === 'draft'
                ? `Draft: editable, not used for pricing.${!laneMode && live ? ` Highlighted cells differ from version ${live.version} (live now).` : ''}`
                : `Published ${day(selected.published_at)}${selected.publisher?.full_name ? ` by ${selected.publisher.full_name}` : ''} · in force from ${day(selected.valid_from)} · locked`}
              {' · '}{(count ?? 0).toLocaleString()} rates · volumetric divisor {selected.volumetric_divisor}{selected.note ? ` · ${selected.note}` : ''}
            </div>
          )}
          {selected?.status === 'draft' && canEdit && (
            <div className="flex mt8">
              {canPublish ? (
                <form action={publishVersion} className="flex">
                  <input type="hidden" name="version_id" value={selected.id} /><input type="hidden" name="tariff_id" value={tariff.id} />
                  <label htmlFor="pub" style={{ margin: 0 }}>Rates start</label>
                  <input id="pub" type="date" name="valid_from" min={minDate} defaultValue={minDate} required style={{ width: 160 }} />
                  <button className="btn primary">Publish</button>
                </form>
              ) : <span className="hint">Management publishes drafts.</span>}
              <form action={deleteDraft}>
                <input type="hidden" name="version_id" value={selected.id} /><input type="hidden" name="tariff_id" value={tariff.id} />
                <button className="btn ghost">Delete draft</button>
              </form>
            </div>
          )}
        </div>
        {body}
      </div>
    </div>
  );
}

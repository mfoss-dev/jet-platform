import Link from 'next/link';
import { day, one } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import type { createClient } from '@/lib/supabase/server';
import { deleteDraft, newDraft, publishVersion } from './actions';
import { TariffGrid, type GridBreak } from './TariffGrid';

type Supabase = Awaited<ReturnType<typeof createClient>>;
type Version = {
  id: string; tariff_id: string; version: number; status: 'draft' | 'published'; valid_from: string | null; note: string | null;
  published_at: string | null; publisher: { full_name: string } | null;
};

async function loadGrid(supabase: Supabase, versionId: string) {
  const [{ data: breaks }, { data: cells }] = await Promise.all([
    supabase.from(SELECTS.tariffBreaks.table).select(SELECTS.tariffBreaks.select).eq('version_id', versionId).order('to_kg'),
    supabase.from(SELECTS.tariffCells.table).select(SELECTS.tariffCells.select).eq('version_id', versionId),
  ]);
  return {
    breaks: (breaks ?? []).map((b) => ({ kind: b.kind, to_kg: Number(b.to_kg), method: b.method, step_kg: Number(b.step_kg) })) as GridBreak[],
    cells: Object.fromEntries((cells ?? []).map((c) => [`${c.kind}|${Number(c.to_kg)}|${c.zone_code}`, Number(c.charge)])),
  };
}

export async function RateCards({ supabase, canEdit, canPublish, tariffId, versionId }: {
  supabase: Supabase; canEdit: boolean; canPublish: boolean; tariffId: string; versionId: string;
}) {
  const [{ data: tariffs }, { data: zones }] = await Promise.all([
    supabase.from(SELECTS.baseTariffs.table).select(SELECTS.baseTariffs.select).order('code'),
    supabase.from(SELECTS.zones.table).select(SELECTS.zones.select).order('sort'),
  ]);
  if (!tariffs?.length) {
    return <div className="card"><h3>No rate cards yet</h3><p className="hint">Jet&apos;s rate cards will be imported from Wayne&apos;s JetStream (BaseTariff tables).</p></div>;
  }
  const tariff = tariffs.find((t) => t.id === tariffId) ?? tariffs[0];
  const { data: vdata } = await supabase.from(SELECTS.tariffVersions.table).select(SELECTS.tariffVersions.select).eq('tariff_id', tariff.id).order('version', { ascending: false });
  const versions = ((vdata ?? []) as unknown as Version[]).map((v) => ({ ...v, publisher: one(v.publisher) }));
  const today = new Date().toISOString().slice(0, 10);
  const published = versions.filter((v) => v.status === 'published').sort((a, b) => (b.valid_from ?? '').localeCompare(a.valid_from ?? ''));
  const live = published.find((v) => (v.valid_from ?? '') <= today) ?? null;
  const latestPublished = published[0] ?? null;
  const draft = versions.find((v) => v.status === 'draft') ?? null;
  const selected = versions.find((v) => v.id === versionId) ?? draft ?? live ?? versions[0];

  const grid = selected ? await loadGrid(supabase, selected.id) : null;
  // A draft is compared with the version customers are paying today.
  const compare = selected?.status === 'draft' && live ? (await loadGrid(supabase, live.id)).cells : null;
  const label = (v: Version) =>
    v.status === 'draft' ? 'Draft' : (v.valid_from ?? '') > today ? `Starts ${day(v.valid_from)}` : v.id === live?.id ? 'Live now' : 'Past';
  const minDate = latestPublished?.valid_from
    ? new Date(new Date(latestPublished.valid_from).getTime() + 864e5).toISOString().slice(0, 10)
    : today;

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(220px, 280px) 1fr', alignItems: 'start' }}>
      <div className="grid">
        <div className="card">
          <h3>Rate cards</h3>
          {tariffs.map((t) => (
            <div key={t.id}>
              <Link href={{ pathname: '/stream/tariffs', query: { tab: 'rates', tariff: t.id } }} scroll={false}>
                {t.id === tariff.id ? <b>{t.name}</b> : t.name}
              </Link>
              <div className="hint">{t.code} · {t.carrier_code} · {t.branch_code}</div>
            </div>
          ))}
        </div>
        <div className="card">
          <h3>Versions</h3>
          <table>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id} className={v.id === selected?.id ? 'sel' : ''}>
                  <td>
                    <Link href={{ pathname: '/stream/tariffs', query: { tab: 'rates', tariff: tariff.id, version: v.id } }} scroll={false}>Version {v.version}</Link>
                    <div className="hint">{v.note}</div>
                  </td>
                  <td className="r"><span className={`pill ${v.status === 'draft' ? 'warn' : v.id === live?.id ? 'ok' : ''}`}>{label(v)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {canEdit && !draft && latestPublished && (
            <form action={newDraft} className="mt8">
              <input type="hidden" name="tariff_id" value={tariff.id} />
              <input type="hidden" name="from_version" value={latestPublished.id} />
              <button className="btn block">Start a new draft</button>
              <div className="hint mt8">Copies version {latestPublished.version}. Customers keep paying the live rates until the draft is published.</div>
            </form>
          )}
        </div>
      </div>

      <div style={{ minWidth: 0 }}>
        {selected && grid && (
          <>
            <div className="flex between" style={{ marginBottom: 12 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18 }}>{tariff.name} · version {selected.version}</h2>
                <div className="hint">
                  {selected.status === 'draft'
                    ? `Draft: editable, not used for pricing.${compare ? ` Highlighted cells differ from version ${live?.version} (live now).` : ''}`
                    : `Published ${day(selected.published_at)}${selected.publisher?.full_name ? ` by ${selected.publisher.full_name}` : ''} · in force from ${day(selected.valid_from)} · locked`}
                </div>
              </div>
              {selected.status === 'draft' && canEdit && (
                <div className="acts">
                  {canPublish ? (
                    <form action={publishVersion} className="flex">
                      <input type="hidden" name="version_id" value={selected.id} />
                      <input type="hidden" name="tariff_id" value={tariff.id} />
                      <label htmlFor="pub" style={{ margin: 0 }}>Rates start</label>
                      <input id="pub" type="date" name="valid_from" min={minDate} defaultValue={minDate} required style={{ width: 160 }} />
                      <button className="btn primary">Publish</button>
                    </form>
                  ) : <span className="hint">Management publishes drafts.</span>}
                  <form action={deleteDraft}>
                    <input type="hidden" name="version_id" value={selected.id} />
                    <input type="hidden" name="tariff_id" value={tariff.id} />
                    <button className="btn ghost">Delete draft</button>
                  </form>
                </div>
              )}
            </div>
            <TariffGrid
              key={selected.id}
              versionId={selected.id}
              editable={selected.status === 'draft' && canEdit}
              zones={zones ?? []}
              breaks={grid.breaks}
              cells={grid.cells}
              compare={compare}
              compareLabel={live ? `version ${live.version}` : undefined}
              note={selected.note ?? ''}
              fileName={`${tariff.code}-v${selected.version}`}
            />
          </>
        )}
      </div>
    </div>
  );
}

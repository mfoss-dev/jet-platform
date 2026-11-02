import Link from 'next/link';
import { notFound } from 'next/navigation';
import { dayTime, msAgo } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';

// Plain-English names for the tables the audit log covers.
const AREAS: Record<string, string> = {
  jobs: 'Billing feed', reweighs: 'Reweighs', customers: 'Customers', fuel_surcharges: 'Fuel surcharge',
  tariff_versions: 'Rate card versions', tariff_cells: 'Rate card prices', base_tariffs: 'Rate cards', sales_tariffs: 'Sales tariffs',
  sales_margins: 'Sales tariff margins', customer_tariffs: 'Customer tariffs',
  profiles: 'Users & roles', services: 'Services', zones: 'Zones', carriers: 'Carriers',
};
const IGNORE = new Set(['updated_at', 'created_at', 'held_at', 'decided_at', 'id']);
const PERIODS = [['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['365', 'Last year']] as const;

type Entry = {
  id: number; at: string; actor_email: string | null; table_name: string; row_id: string | null; action: string;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
};

const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const show = (v: unknown) => (v == null || v === '' ? '—' : String(v).replace(/_/g, ' '));

// Which record: a connote, account code or carrier is more useful than an id.
function record(e: Entry) {
  const r = e.after ?? e.before ?? {};
  if (e.table_name === 'jobs') return String(r.connote ?? '');
  if (e.table_name === 'customers') return `${r.account_code ?? ''} ${r.name ?? ''}`.trim();
  if (e.table_name === 'fuel_surcharges') return `${r.carrier_code ?? ''} from ${r.effective_from ?? ''}`;
  if (e.table_name === 'sales_margins') return `Zone ${r.zone_code ?? ''}, ${r.up_to_kg == null ? 'over' : `up to ${r.up_to_kg}`} kg`;
  if (e.table_name === 'tariff_versions') return `Version ${r.version ?? ''}${r.status ? ` (${r.status})` : ''}`;
  if (e.table_name === 'tariff_cells') return 'Draft rate card';
  if (e.table_name === 'customer_tariffs') return `From ${r.effective_from ?? ''}`;
  if (e.table_name === 'profiles') return String(r.email ?? '');
  return String(r.code ?? r.name ?? e.row_id ?? '').slice(0, 40);
}

function changes(e: Entry) {
  if (e.table_name === 'tariff_cells') return [`${e.after?.cells_changed ?? 0} prices changed${e.after?.note ? ` · ${e.after.note}` : ''}`];
  if (e.action === 'insert') return ['Created'];
  if (e.action === 'delete') return ['Deleted'];
  const keys = new Set([...Object.keys(e.before ?? {}), ...Object.keys(e.after ?? {})]);
  return [...keys]
    .filter((k) => !IGNORE.has(k) && JSON.stringify(e.before?.[k] ?? null) !== JSON.stringify(e.after?.[k] ?? null))
    .map((k) => `${k.replace(/_/g, ' ')}: ${show(e.before?.[k])} → ${show(e.after?.[k])}`);
}

export default async function AuditLog({ searchParams }: PageProps<'/stream/audit'>) {
  const me = await getMe();
  if (!me.apps.includes('stream')) notFound();
  const sp = await searchParams;
  const area = pick(sp.area);
  const who = pick(sp.who).trim().toLowerCase();
  const days = PERIODS.some(([d]) => d === pick(sp.days)) ? pick(sp.days) : '7';

  const supabase = await createClient();
  let query = supabase
    .from(SELECTS.audit.table)
    .select(SELECTS.audit.select)
    .gte('at', new Date(msAgo(Number(days))).toISOString())
    .order('at', { ascending: false })
    .limit(300);
  if (area in AREAS) query = query.eq('table_name', area);
  if (who === 'system') query = query.is('actor_email', null);
  else if (who) query = query.ilike('actor_email', `%${who.replace(/[%_]/g, '')}%`);
  const { data, error } = await query;
  const rows = ((data ?? []) as Entry[]).map((e) => ({ ...e, lines: changes(e) })).filter((e) => e.lines.length);
  const managers = ['owner', 'management', 'admin'].includes(me.role);

  return (
    <>
      <div className="top">
        <div><h1>Audit log</h1><div className="sub">Who changed what, before and after · nobody can edit or delete these entries</div></div>
      </div>

      <form className="filters" action="/stream/audit">
        <select name="days" className="f" defaultValue={days} aria-label="Period">
          {PERIODS.map(([d, l]) => <option key={d} value={d}>{l}</option>)}
        </select>
        <select name="area" className="f" defaultValue={area} aria-label="Area">
          <option value="">All areas</option>
          {Object.entries(AREAS).map(([t, l]) => <option key={t} value={t}>{l}</option>)}
        </select>
        <input name="who" defaultValue={who} placeholder="Who (email, or “system”)" aria-label="Who" />
        <button className="btn">Filter</button>
        {(area || who || days !== '7') && <Link className="btn ghost" href="/stream/audit">Clear</Link>}
      </form>

      {!managers && <div className="banner">You see changes to billing data (jobs, reweighs, customers, margins, fuel). Changes to users and roles are visible to management.</div>}
      {error && <div className="banner warn" role="alert">Couldn&apos;t load the audit log: {error.message}</div>}

      <div className="card" style={{ padding: 0 }}>
        <div className="tw">
          <table>
            <thead><tr><th>When</th><th>Who</th><th>Area</th><th>Record</th><th>Change</th></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{dayTime(e.at)}</td>
                  <td>{e.actor_email ?? <span className="hint">System / data load</span>}</td>
                  <td>{AREAS[e.table_name] ?? e.table_name}</td>
                  <td><b>{record(e)}</b></td>
                  <td>{e.lines.slice(0, 6).map((l) => <div key={l}>{l}</div>)}{e.lines.length > 6 && <div className="hint">+{e.lines.length - 6} more</div>}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={5} className="hint">No changes in this period.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <p className="hint mt8">Showing up to 300 entries. AI (MCP) questions will appear here too once the MCP server is built.</p>
    </>
  );
}

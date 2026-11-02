import { notFound } from 'next/navigation';
import { BILLING_EDITORS, dayTime, money, msAgo, one, startOfMonth } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { ReweighTable, type PendingReweigh } from './ReweighTable';

const DECISION: Record<string, [string, string]> = { pass_on: ['Passed on', 'ok'], absorb: ['Absorbed', 'warn'], dispute: ['Disputed', ''] };

type Row = {
  id: string; source_file: string | null; declared_kg: number; carrier_kg: number; extra_charge: number;
  decision: string; decision_note: string | null; decided_at: string | null; created_at: string;
  job: { connote: string; sell_ex_gst: number | null; customer: { name: string; account_code: string } | null } | null;
  decider: { full_name: string } | null;
};

export default async function Reweighs() {
  const me = await getMe();
  if (!me.apps.includes('stream')) notFound();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from(SELECTS.reweighs.table)
    .select(SELECTS.reweighs.select)
    .order('created_at', { ascending: false })
    .limit(300);
  const rows = ((data ?? []) as unknown as Row[]).map((r) => ({ ...r, job: one(r.job), decider: one(r.decider) }));

  const pending = rows.filter((r) => r.decision === 'pending');
  const decided = rows.filter((r) => r.decision !== 'pending').sort((a, b) => (b.decided_at ?? '').localeCompare(a.decided_at ?? ''));
  const monthStart = startOfMonth();
  const thisMonth = decided.filter((r) => r.decided_at && new Date(r.decided_at) >= monthStart);
  const sum = (list: Row[]) => list.reduce((a, r) => a + Number(r.extra_charge), 0);

  // Who repeatedly under-declares (last 90 days), to suggest package presets.
  const since = msAgo(90);
  const offenders = Object.values(
    rows.filter((r) => new Date(r.created_at).getTime() >= since).reduce<Record<string, { name: string; n: number; extra: number }>>((acc, r) => {
      const c = one(r.job?.customer);
      if (!c) return acc;
      acc[c.account_code] ??= { name: c.name, n: 0, extra: 0 };
      acc[c.account_code].n++; acc[c.account_code].extra += Number(r.extra_charge);
      return acc;
    }, {}),
  ).sort((a, b) => b.n - a.n).slice(0, 5);

  const pendingRows: PendingReweigh[] = pending.map((r) => {
    const c = one(r.job?.customer);
    return {
      id: r.id, connote: r.job?.connote ?? '—', customer: c?.name ?? '—', declared: Number(r.declared_kg), carrier: Number(r.carrier_kg),
      extra: Number(r.extra_charge), file: r.source_file ?? '—',
    };
  });

  return (
    <>
      <div className="top">
        <div>
          <h1>Reweighs</h1>
          <div className="sub">Carrier weight checks: pass the extra on, absorb it, or dispute it with the carrier</div>
        </div>
      </div>

      <div className="grid k4">
        <div className="card kpi"><div className="l">Need a decision</div><div className="v">{pending.length}</div><div className="d">{money(sum(pending))} at stake</div></div>
        <div className="card kpi"><div className="l">Passed on this month</div><div className="v">{money(sum(thisMonth.filter((r) => r.decision === 'pass_on')))}</div><div className="d">Billed to customers</div></div>
        <div className="card kpi"><div className="l">Absorbed this month</div><div className="v">{money(sum(thisMonth.filter((r) => r.decision === 'absorb')))}</div><div className="d">Jet&apos;s cost, not passed on</div></div>
        <div className="card kpi"><div className="l">Disputed this month</div><div className="v">{thisMonth.filter((r) => r.decision === 'dispute').length}</div><div className="d">Challenged with the carrier</div></div>
      </div>

      {error && <div className="banner warn mt" role="alert">Couldn&apos;t load reweighs: {error.message}</div>}

      <div className="grid split mt">
        <div style={{ minWidth: 0 }}>
          <ReweighTable rows={pendingRows} canEdit={BILLING_EDITORS.includes(me.role)} />

          <div className="card mt">
            <h3>Recently decided</h3>
            {decided.length ? (
              <div className="tw">
                <table>
                  <thead><tr><th>Connote</th><th>Customer</th><th className="r">Extra</th><th>Decision</th><th>By</th><th>When</th></tr></thead>
                  <tbody>
                    {decided.slice(0, 20).map((r) => {
                      const c = one(r.job?.customer);
                      const [label, tone] = DECISION[r.decision] ?? [r.decision, ''];
                      return (
                        <tr key={r.id} title={r.decision_note ?? ''}>
                          <td><b>{r.job?.connote}</b></td><td>{c?.name}</td><td className="r">{money(r.extra_charge)}</td>
                          <td><span className={`pill ${tone}`}>{label}</span>{r.decision_note ? <span className="hint"> · {r.decision_note}</span> : null}</td>
                          <td>{r.decider?.full_name || '—'}</td><td>{dayTime(r.decided_at)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <p className="hint">No decisions yet.</p>}
          </div>
        </div>

        <div className="grid" style={{ alignSelf: 'start' }}>
          <div className="card">
            <h3>Repeat offenders · 90 days</h3>
            {offenders.length ? (
              <table>
                <thead><tr><th>Customer</th><th className="r">Reweighs</th><th className="r">Extra</th></tr></thead>
                <tbody>{offenders.map((o) => <tr key={o.name}><td>{o.name}</td><td className="r">{o.n}</td><td className="r">{money(o.extra)}</td></tr>)}</tbody>
              </table>
            ) : <p className="hint">None yet.</p>}
            <p className="hint mt8">Customers who keep under-declaring can be prompted to set up package presets in the portal (portal phase).</p>
          </div>
          <div className="card">
            <h3>Import</h3>
            <p className="hint">Reweigh files are imported automatically once the carrier feeds are connected (open item M4: how each DHL file arrives). Today&apos;s rows are demo data.</p>
          </div>
        </div>
      </div>
    </>
  );
}

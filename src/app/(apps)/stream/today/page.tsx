import Link from 'next/link';
import { notFound } from 'next/navigation';
import { day, dayTime, money } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';

type Run = { id: string; branch_code: string; kind: string; period_end: string; status: string; automatic: boolean; created_at: string; approved_at: string | null; invoices: number; drafts: number; flagged: number; total: number };
type Unbilled = { branch_code: string; kind: string; status: string; lines: number; shipments: number; total: number; oldest: string; ready: boolean };
type Task = { issue: string; tone: 'warn' | 'bad' | ''; detail: string; amount: number | null; since: string | null; href: string; action: string };

const BRANCH: Record<string, string> = { AU: 'Sydney', NZ: 'Auckland' };

// Dates in Sydney: the Sunday that ends last week, and the next Thursday the weekly run is prepared.
function week() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Australia/Sydney' }));
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const sunday = new Date(now); sunday.setDate(now.getDate() - now.getDay());
  const thursday = new Date(now); thursday.setDate(now.getDate() + ((4 - now.getDay() + 7) % 7));
  return { sunday: iso(sunday), thursday: iso(thursday), hour: now.getHours(), isThursday: now.getDay() === 4 };
}

// Today: one page of what needs doing in billing, with the biggest amounts at stake first, and where this week's
// invoicing cycle is up to for each branch.
export default async function Today() {
  const me = await getMe();
  if (!me.apps.includes('stream')) notFound();
  const supabase = await createClient();
  const w = week();

  const [{ data: runData }, { data: unbilledData }, { data: queueData }, { data: reweighData }, { count: feedCount }, { data: carrierData }] = await Promise.all([
    supabase.from(SELECTS.runSummary.table).select(SELECTS.runSummary.select).neq('status', 'cancelled').or(`status.eq.draft,period_end.gte.${w.sunday}`).order('period_end', { ascending: false }).limit(40),
    supabase.from(SELECTS.unbilled.table).select(SELECTS.unbilled.select).limit(100),
    supabase.from('credit_note_queue').select('id, total, invoice_date, needs_management, i_can_approve').limit(200),
    supabase.from('reweighs').select('extra_charge, created_at').eq('decision', 'pending').limit(2000),
    supabase.from('job_list').select('id', { count: 'exact', head: true }).eq('billing_status', 'needs_attention'),
    supabase.from(SELECTS.carrierInvoices.table).select('id, carrier_code, invoice_number, open, open_at_stake, uploaded_at').gt('open', 0).limit(50),
  ]);
  const runs = (runData ?? []) as unknown as Run[];
  const unbilled = (unbilledData ?? []) as unknown as Unbilled[];
  const queue = (queueData ?? []) as { id: string; total: number; invoice_date: string; needs_management: boolean; i_can_approve: boolean }[];
  const reweighs = (reweighData ?? []) as { extra_charge: number | null; created_at: string }[];
  const carrier = (carrierData ?? []) as { id: string; carrier_code: string; invoice_number: string; open: number; open_at_stake: number; uploaded_at: string }[];
  const oldest = (dates: (string | null | undefined)[]) => dates.filter(Boolean).sort()[0] ?? null;
  const sum = (xs: number[]) => xs.reduce((a, x) => a + Number(x || 0), 0);

  const ready = (b: string, k: string) => unbilled.filter((u) => u.branch_code === b && u.kind === k && u.status === 'new' && u.ready);
  const notReady = unbilled.filter((u) => u.status === 'new' && !u.ready);
  const held = unbilled.filter((u) => u.status !== 'new');
  const drafts = runs.filter((r) => r.status === 'draft');
  const mine = queue.filter((q) => q.i_can_approve);
  const othersCredits = queue.filter((q) => !q.i_can_approve);

  const tasks: Task[] = [
    ...drafts.filter((r) => r.flagged > 0).map((r) => ({
      issue: 'Invoices to check', tone: 'warn' as const, detail: `${BRANCH[r.branch_code]} ${r.kind} run to ${day(r.period_end)}: ${r.flagged} flagged of ${r.invoices}`,
      amount: Number(r.total), since: r.created_at, href: `/stream/run?run=${r.id}`, action: 'Review',
    })),
    ...drafts.filter((r) => r.flagged === 0 && r.drafts > 0).map((r) => ({
      issue: 'Run ready to approve', tone: '' as const, detail: `${BRANCH[r.branch_code]} ${r.kind} run to ${day(r.period_end)}: ${r.drafts} clean invoices`,
      amount: Number(r.total), since: r.created_at, href: `/stream/run?run=${r.id}`, action: 'Approve',
    })),
    ...(mine.length ? [{ issue: 'Credit notes to approve', tone: 'warn' as const, detail: `${mine.length} waiting for you`, amount: sum(mine.map((q) => q.total)), since: oldest(mine.map((q) => q.invoice_date)), href: '/stream/invoices', action: 'Approve' }] : []),
    ...(othersCredits.length ? [{ issue: 'Credit notes waiting', tone: '' as const, detail: `${othersCredits.length} for ${othersCredits.some((q) => q.needs_management) ? 'management' : 'finance'} to approve`, amount: sum(othersCredits.map((q) => q.total)), since: oldest(othersCredits.map((q) => q.invoice_date)), href: '/stream/invoices', action: 'View' }] : []),
    ...(notReady.length ? [{ issue: 'Not priced', tone: 'bad' as const, detail: `${sum(notReady.map((u) => u.shipments))} shipments can't be invoiced until priced`, amount: null, since: oldest(notReady.map((u) => u.oldest)), href: '/stream/run?held=1', action: 'Fix' }] : []),
    ...(held.length ? [{ issue: 'Held charges', tone: 'warn' as const, detail: `${sum(held.map((u) => u.lines))} lines held or marked do-not-bill`, amount: sum(held.map((u) => u.total)), since: oldest(held.map((u) => u.oldest)), href: '/stream/run?held=1', action: 'Review' }] : []),
    ...(reweighs.length ? [{ issue: 'Reweighs', tone: 'warn' as const, detail: `${reweighs.length} carrier weights to pass on or absorb`, amount: sum(reweighs.map((r) => r.extra_charge ?? 0)), since: oldest(reweighs.map((r) => r.created_at)), href: '/stream/reweighs', action: 'Decide' }] : []),
    ...carrier.map((c) => ({
      issue: 'Carrier invoice exceptions', tone: 'warn' as const, detail: `${c.carrier_code} ${c.invoice_number}: ${c.open} to pass on, absorb or dispute`,
      amount: Number(c.open_at_stake), since: c.uploaded_at, href: `/stream/cinv/${c.id}`, action: 'Decide',
    })),
    ...(feedCount ? [{ issue: 'Billing feed', tone: 'warn' as const, detail: `${feedCount} jobs need attention`, amount: null, since: null, href: '/stream/feed', action: 'Clear' }] : []),
  ].sort((a, b) => Math.abs(b.amount ?? 0) - Math.abs(a.amount ?? 0));

  // This week's weekly cycle, per branch: prepared, checked, approved, MYOB file.
  const cycle = (b: string) => {
    const run = runs.find((r) => r.branch_code === b && r.kind === 'weekly' && r.period_end === w.sunday);
    const freight = ready(b, 'freight');
    return [
      { label: 'Shipments to invoice', note: `${freight.reduce((a, u) => a + u.shipments, 0).toLocaleString()} ready · ${money(sum(freight.map((u) => u.total)))}`, state: 'd' },
      { label: 'Draft run prepared', note: run ? `${run.automatic ? 'Automatically' : 'By hand'} ${dayTime(run.created_at)}` : `Thu ${day(w.thursday)} 6am`, state: run ? 'd' : '' },
      { label: 'Flagged invoices checked', note: !run ? 'After the draft' : run.status === 'draft' && run.flagged ? `${run.flagged} to check` : 'Done', state: !run ? '' : run.status === 'draft' && run.flagged ? 'w' : 'd' },
      { label: 'Approved and numbered', note: run?.status === 'approved' ? dayTime(run.approved_at) : run ? `${run.drafts} drafts waiting` : '—', state: run?.status === 'approved' ? 'd' : run ? 'w' : '' },
      { label: 'MYOB file', note: run?.status === 'approved' ? 'Ready to download' : 'After approval', state: run?.status === 'approved' ? 'd' : '', href: run?.status === 'approved' ? `/stream/run/${run.id}/myob` : undefined },
    ];
  };

  const greeting = w.hour < 12 ? 'Good morning' : w.hour < 17 ? 'Good afternoon' : 'Good evening';
  const first = (me.name || me.email).split(/[ @]/)[0];
  const readyTotal = (k: string) => sum(['AU', 'NZ'].flatMap((b) => ready(b, k).map((u) => u.total)));

  return (
    <>
      <div className="top">
        <div>
          <h1>{greeting}, {first}</h1>
          <div className="sub">{w.isThursday ? 'Invoice run day: drafts were prepared at 6am' : `Next weekly run is prepared Thu ${day(w.thursday)} at 6am`} · duties runs every weekday</div>
        </div>
        <Link className="btn primary" href="/stream/run">Open invoice run</Link>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <div className="card kpi"><div className="l">Freight ready to invoice</div><div className="v">{money(readyTotal('freight'))}</div><div className="d">Sydney {money(sum(ready('AU', 'freight').map((u) => u.total)))} · Auckland {money(sum(ready('NZ', 'freight').map((u) => u.total)))}</div></div>
        <div className="card kpi"><div className="l">Duties ready to invoice</div><div className="v">{money(readyTotal('duties'))}</div><div className="d">Invoiced each weekday, 7-day terms</div></div>
        <div className="card kpi"><div className="l">Things to do</div><div className="v">{tasks.length}</div><div className="d">{tasks.length ? 'Biggest amounts first' : 'All clear'}</div></div>
        <div className="card kpi"><div className="l">Credit notes waiting</div><div className="v">{queue.length}</div><div className="d">{mine.length ? `${mine.length} for you to approve` : 'None for you'}</div></div>
      </div>

      <div className="grid mt" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(260px, 1fr)', alignItems: 'start' }}>
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '14px 16px 0' }}><h3>Work queue</h3></div>
          <table className="mt8">
            <thead><tr><th>Issue</th><th>Detail</th><th className="r">At stake</th><th>Since</th><th /></tr></thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={`${t.issue}-${t.detail}`}>
                  <td><span className={`pill ${t.tone}`}>{t.issue}</span></td><td>{t.detail}</td>
                  <td className="r">{t.amount == null ? '—' : money(t.amount)}</td><td>{t.since ? day(t.since) : '—'}</td>
                  <td><Link className="btn sm" href={t.href}>{t.action}</Link></td>
                </tr>
              ))}
              {!tasks.length && <tr><td colSpan={5} className="hint">Nothing waiting. Drafts appear here when they&apos;re prepared.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3>This week&apos;s invoicing</h3>
          <div className="hint">Week to Sunday {day(w.sunday)}</div>
          {['AU', 'NZ'].map((b) => (
            <div key={b} className="mt8">
              <b>{BRANCH[b]}</b>
              <div className="cycle">
                {cycle(b).map((s) => (
                  <div className="row" key={s.label}>
                    <span className={`ic ${s.state}`}>{s.state === 'd' ? '✓' : s.state === 'w' ? '!' : '○'}</span>
                    <div><b>{s.href ? <a href={s.href}>{s.label}</a> : s.label}</b><span>{s.note}</span></div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

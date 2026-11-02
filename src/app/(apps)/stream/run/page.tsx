import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BILLING_EDITORS, day, dayTime, money, one } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { approve, cancelRun, prepareRun, release, releaseHeld } from './actions';

type Run = {
  id: string; branch_code: string; kind: 'weekly' | 'duties'; period_end: string; invoice_date: string; status: string; automatic: boolean; source: string | null;
  created_at: string; approved_at: string | null; invoices: number; drafts: number; flagged: number; total: number; first_number: number | null; last_number: number | null;
};
type Inv = { id: string; number: number | null; kind: string; invoice_date: string; due_date: string | null; terms_code: string | null; total: number; status: string; flags: string[]; bill_to: { id: string; name: string; account_code: string } | null };
type Unbilled = { branch_code: string; kind: string; status: string; lines: number; shipments: number; total: number; oldest: string };
type Held = { id: string; branch_code: string; connote: string; shipped_on: string; code: string; description: string; charge: number; fuel: number; security: number; gst: number; status: string; customer: { name: string; account_code: string } | null };

const BRANCH: Record<string, string> = { AU: 'Sydney', NZ: 'Auckland' };
const KIND: Record<string, string> = { weekly: 'Weekly', duties: 'Duties' };
const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

function lastSunday() {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
}

// The invoice run. Drafts are prepared on a schedule (Thursday for the week to Sunday, each weekday for duties);
// finance approves the clean invoices in one go and deals only with the flagged ones.
export default async function InvoiceRun({ searchParams }: PageProps<'/stream/run'>) {
  const me = await getMe();
  if (!me.apps.includes('stream')) notFound();
  const sp = await searchParams;
  const msg = pick(sp.msg);
  const focus = pick(sp.run);
  const showHeld = pick(sp.held) === '1';
  const canEdit = BILLING_EDITORS.includes(me.role);
  const supabase = await createClient();

  const [{ data: runData }, { data: unbilledData }] = await Promise.all([
    supabase.from(SELECTS.runSummary.table).select(SELECTS.runSummary.select).neq('status', 'cancelled').order('period_end', { ascending: false }).order('created_at', { ascending: false }).limit(30),
    supabase.from(SELECTS.unbilled.table).select(SELECTS.unbilled.select).limit(100),
  ]);
  const runs = (runData ?? []) as unknown as Run[];
  const drafts = runs.filter((r) => r.status === 'draft');
  const open = runs.find((r) => r.id === focus) ?? drafts[0] ?? null;
  const unbilled = (unbilledData ?? []) as unknown as Unbilled[];

  let invoices: Inv[] = [];
  if (open) {
    const { data } = await supabase.from(SELECTS.invoiceList.table).select(SELECTS.invoiceList.select).eq('run_id', open.id).order('total', { ascending: false }).limit(1000);
    invoices = ((data ?? []) as unknown as Inv[]).map((i) => ({ ...i, bill_to: one(i.bill_to) }));
  }
  const flagged = invoices.filter((i) => i.status === 'draft' && i.flags.length);
  const clean = invoices.filter((i) => i.status === 'draft' && !i.flags.length);
  const done = invoices.filter((i) => i.status !== 'draft');

  let held: Held[] = [];
  if (showHeld) {
    const { data } = await supabase.from(SELECTS.heldCharges.table).select(SELECTS.heldCharges.select).in('status', ['held', 'no_bill']).is('invoice_id', null)
      .order('shipped_on').limit(500);
    held = ((data ?? []) as unknown as Held[]).map((h) => ({ ...h, customer: one(h.customer) }));
  }
  const heldCount = unbilled.filter((u) => u.status !== 'new').reduce((a, u) => a + u.lines, 0);

  const invRow = (i: Inv, tick: boolean) => (
    <tr key={i.id}>
      {tick && <td><input type="checkbox" name="invoice" value={i.id} aria-label={`Select ${i.bill_to?.name}`} /></td>}
      <td><Link href={`/stream/invoices/${i.id}`}>{i.bill_to?.name}</Link> <span className="hint">{i.bill_to?.account_code}</span></td>
      <td>{i.number ?? <span className="hint">on approval</span>}</td>
      <td>{i.terms_code ?? '—'} · due {day(i.due_date)}</td>
      <td className="r">{money(i.total)}</td>
      <td><div className="flex">{i.flags.map((f) => <span key={f} className="pill warn">{f}</span>)}</div></td>
    </tr>
  );

  return (
    <>
      <div className="top">
        <div><h1>Invoice run</h1><div className="sub">Drafts are prepared automatically · clean invoices approve in one click · only exceptions need you</div></div>
      </div>
      {msg && <div className={`banner ${/^(Not |Choose|Tick)/.test(msg) ? 'warn' : ''}`} role="status">{msg}</div>}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        {['AU', 'NZ'].flatMap((b) => ['weekly', 'duties'].map((k) => {
          const u = unbilled.find((x) => x.branch_code === b && x.kind === (k === 'duties' ? 'duties' : 'freight') && x.status === 'new');
          return (
            <div className="card" key={`${b}${k}`}>
              <div className="hint">{BRANCH[b]} · {k === 'duties' ? 'customs duties' : 'freight'} not yet invoiced</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{money(u?.total ?? 0)}</div>
              <div className="hint">{u ? `${u.shipments.toLocaleString()} shipments · oldest ${day(u.oldest)}` : 'Nothing waiting'}</div>
            </div>
          );
        }))}
      </div>
      {heldCount > 0 && (
        <div className="banner mt">{heldCount} charge lines are held or marked do-not-bill. <Link href="/stream/run?held=1">Review held charges</Link></div>
      )}

      {showHeld && (
        <div className="card mt">
          <h3>Held and do-not-bill charges</h3>
          <form action={releaseHeld}>
            <table className="mt8">
              <thead><tr><th /><th>Account</th><th>Shipment</th><th>Shipped</th><th>Line</th><th className="r">Amount</th><th>Status</th></tr></thead>
              <tbody>
                {held.map((h) => (
                  <tr key={h.id}>
                    <td>{canEdit && <input type="checkbox" name="charge" value={h.id} aria-label={`Release ${h.connote}`} />}</td>
                    <td>{h.customer?.name} <span className="hint">{h.customer?.account_code}</span></td><td>{h.connote}</td><td>{day(h.shipped_on)}</td>
                    <td>{h.description || h.code}</td><td className="r">{money(Number(h.charge) + Number(h.fuel) + Number(h.security) + Number(h.gst))}</td>
                    <td><span className="pill">{h.status === 'held' ? 'Held' : 'Do not bill'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {canEdit && held.length > 0 && <div className="mt8"><button className="btn">Release ticked into the next run</button></div>}
          </form>
        </div>
      )}

      {open && (
        <div className="card mt">
          <div className="flex" style={{ justifyContent: 'space-between' }}>
            <div>
              <h3>{BRANCH[open.branch_code]} · {KIND[open.kind]} run · period to {day(open.period_end)}</h3>
              <div className="hint">
                Invoice date {day(open.invoice_date)} · {open.source === 'jetstream' ? 'imported from JetStream' : open.automatic ? 'prepared automatically' : 'prepared by hand'} {dayTime(open.created_at)}
                {open.status === 'approved' && ` · approved ${dayTime(open.approved_at)}`}
              </div>
            </div>
            <div className="flex">
              <span className={`pill ${open.status === 'approved' ? 'ok' : 'warn'}`}>{open.status === 'draft' ? 'Draft' : 'Approved'}</span>
              {open.status === 'approved' && <a className="btn sm" href={`/stream/run/${open.id}/myob`}>MYOB file</a>}
            </div>
          </div>
          <div className="grid mt8" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
            <div><div className="hint">Invoices</div><b>{open.invoices}</b></div>
            <div><div className="hint">Ready to approve</div><b>{clean.length}</b></div>
            <div><div className="hint">Need a look</div><b>{flagged.length}</b></div>
            <div><div className="hint">Total inc GST</div><b>{money(open.total)}</b></div>
          </div>

          {open.status === 'draft' && canEdit && (
            <div className="flex mt">
              {clean.length > 0 && (
                <form action={approve}><input type="hidden" name="run" value={open.id} /><button className="btn primary">Approve {clean.length} clean invoice{clean.length === 1 ? '' : 's'} ({money(clean.reduce((a, i) => a + Number(i.total), 0))})</button></form>
              )}
              {!done.length && <form action={cancelRun}><input type="hidden" name="run" value={open.id} /><button className="btn ghost">Cancel run</button></form>}
            </div>
          )}

          {flagged.length > 0 && (
            <form className="mt">
              <input type="hidden" name="run" value={open.id} />
              <h3>Need a look ({flagged.length})</h3>
              <p className="hint">Open an invoice to check it, then approve it, carry it to the next run, or hold its charges.</p>
              <table className="mt8">
                <thead><tr><th /><th>Bill to</th><th>Number</th><th>Terms</th><th className="r">Total</th><th>Why</th></tr></thead>
                <tbody>{flagged.map((i) => invRow(i, canEdit))}</tbody>
              </table>
              {canEdit && (
                <div className="flex mt8">
                  <input type="hidden" name="only" value="ticked" />
                  <button className="btn" formAction={approve}>Approve ticked</button>
                  <button className="btn ghost" formAction={release} name="how" value="carry">Carry ticked to next run</button>
                  <button className="btn ghost" formAction={release} name="how" value="hold">Hold ticked</button>
                </div>
              )}
            </form>
          )}

          {clean.length > 0 && (
            <details className="mt">
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Clean drafts ({clean.length})</summary>
              <table className="mt8"><thead><tr><th>Bill to</th><th>Number</th><th>Terms</th><th className="r">Total</th><th /></tr></thead><tbody>{clean.map((i) => invRow(i, false))}</tbody></table>
            </details>
          )}
          {done.length > 0 && (
            <details className="mt" open={open.status === 'approved'}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Approved ({done.length}){open.first_number ? ` · numbers ${open.first_number}–${open.last_number}` : ''}</summary>
              <table className="mt8"><thead><tr><th>Bill to</th><th>Number</th><th>Terms</th><th className="r">Total</th><th /></tr></thead><tbody>{done.map((i) => invRow(i, false))}</tbody></table>
            </details>
          )}
        </div>
      )}

      <div className="grid mt" style={{ gridTemplateColumns: 'minmax(260px, 360px) 1fr', alignItems: 'start' }}>
        <div className="card">
          <h3>Prepare a run now</h3>
          <p className="hint">Runs are prepared automatically: weekly every Thursday at 6am up to last Sunday, and duties each weekday. Use this for an extra run.</p>
          {canEdit ? (
            <form action={prepareRun} className="form mt8" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <div><label htmlFor="r-branch">Branch</label><select id="r-branch" name="branch" className="f"><option value="AU">Sydney</option><option value="NZ">Auckland</option></select></div>
              <div><label htmlFor="r-kind">Type</label><select id="r-kind" name="kind" className="f"><option value="weekly">Weekly</option><option value="duties">Duties (7 days)</option></select></div>
              <div><label htmlFor="r-pe">Shipped up to</label><input id="r-pe" name="period_end" type="date" defaultValue={lastSunday()} required /></div>
              <div><label htmlFor="r-id">Invoice date</label><input id="r-id" name="invoice_date" type="date" placeholder="same day" /></div>
              <div className="s2"><button className="btn primary">Prepare draft</button></div>
            </form>
          ) : <p className="hint">Only finance and management can run invoicing.</p>}
        </div>
        <div className="card">
          <h3>Recent runs</h3>
          <table className="mt8">
            <thead><tr><th>Run</th><th>Period to</th><th className="r">Invoices</th><th className="r">Total</th><th>Status</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className={r.id === open?.id ? 'sel' : ''}>
                  <td><Link href={`/stream/run?run=${r.id}`}>{BRANCH[r.branch_code]} · {KIND[r.kind]}</Link>{r.source === 'jetstream' && <span className="hint"> · JetStream</span>}</td>
                  <td>{day(r.period_end)}</td><td className="r">{r.invoices}</td><td className="r">{money(r.total)}</td>
                  <td>{r.status === 'draft' ? <span className="pill warn">Draft{r.flagged ? ` · ${r.flagged} flagged` : ''}</span> : <span className="pill ok">Approved</span>}</td>
                </tr>
              ))}
              {!runs.length && <tr><td colSpan={5} className="hint">No runs yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckAll } from '@/components/CheckAll';
import { DECISIONS, ISSUES, type Extra } from '@/lib/carrier-csv';
import { BILLING_EDITORS, day, dayTime, money, one } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { decideCarrierLines, rematchCarrierInvoice, removeCarrierInvoice } from '../actions';

type Line = {
  id: string; line_no: number; waybill: string; reference: string | null; shipped_on: string | null; product_name: string | null; pieces: number | null;
  orig_country: string | null; dest_country: string | null; declared_kg: number | null; carrier_kg: number | null; declared_vol_kg: number | null;
  carrier_vol_kg: number | null; weight_flag: string | null; billed_kg: number | null; weight_charge: number; extras: Extra[]; total_ex: number; tax: number;
  connote: string | null; jet_kg: number | null; jet_billed: number | null; jet_addons: number | null; review_extras: number; issues: string[];
  at_stake: number; decision: string; decision_note: string | null; decided_at: string | null; passed_charge_id: string | null;
  customer: { name: string; account_code: string } | null; decider: { full_name: string } | null;
};
type Summary = { id: string; carrier_code: string; branch_code: string; invoice_number: string; account_number: string | null; invoice_date: string | null; due_date: string | null; total_ex: number; tax: number; file_name: string | null; uploaded_at: string; matched_at: string | null; uploaded_by_name: string | null; shipments: number; matched: number; jet_billed: number; matched_cost: number; open: number; open_at_stake: number };

const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const kg = (n: number | null) => (n == null ? '—' : `${Number(n).toLocaleString('en-AU', { maximumFractionDigits: 2 })} kg`);
// Which weight the carrier billed on (DHL's weight flag).
const FLAG: Record<string, string> = { A: "customer's scale weight", B: "carrier's scale weight", V: "customer's volume weight", W: "carrier's volume weight", M: 'minimum weight' };
const VIEWS: [string, string][] = [['open', 'To decide'], ...Object.entries(ISSUES).map(([k, v]) => [k, v[0]] as [string, string]), ['decided', 'Decided'], ['all', 'All lines']];

// One carrier invoice: what the carrier charged against what Jet billed, line by line, and the exceptions to decide.
export default async function CarrierInvoice({ params, searchParams }: PageProps<'/stream/cinv/[id]'>) {
  const me = await getMe();
  if (!me.apps.includes('stream')) notFound();
  const { id } = await params;
  const sp = await searchParams;
  const msg = pick(sp.msg);
  const view = VIEWS.some(([k]) => k === pick(sp.view)) ? pick(sp.view) : 'open';
  const canEdit = BILLING_EDITORS.includes(me.role);
  const supabase = await createClient();
  const [{ data: inv }, { data, error }] = await Promise.all([
    supabase.from(SELECTS.carrierInvoices.table).select(SELECTS.carrierInvoices.select).eq('id', id).maybeSingle(),
    supabase.from(SELECTS.carrierLines.table).select(SELECTS.carrierLines.select).eq('invoice_id', id).order('line_no').limit(5000),
  ]);
  if (!inv) notFound();
  const invoice = inv as unknown as Summary;
  const lines = ((data ?? []) as unknown as Line[]).map((l) => ({ ...l, customer: one(l.customer), decider: one(l.decider) }));
  const flagged = lines.filter((l) => l.issues.length);
  const count = (k: string) => (k === 'open' ? flagged.filter((l) => l.decision === 'pending').length
    : k === 'decided' ? flagged.filter((l) => l.decision !== 'pending').length : k === 'all' ? lines.length : flagged.filter((l) => l.issues.includes(k)).length);
  const shown = (view === 'all' ? lines : view === 'decided' ? flagged.filter((l) => l.decision !== 'pending')
    : view === 'open' ? flagged.filter((l) => l.decision === 'pending') : flagged.filter((l) => l.issues.includes(view)))
    .sort((a, b) => (view === 'all' ? a.line_no - b.line_no : Number(b.at_stake) - Number(a.at_stake)));
  const carrier = invoice.carrier_code;
  const margin = Number(invoice.jet_billed) - Number(invoice.matched_cost);
  const decidable = canEdit && shown.some((l) => l.decision === 'pending' && l.issues.length);

  return (
    <>
      <div className="top">
        <div>
          <h1>{invoice.carrier_code} invoice {invoice.invoice_number}</h1>
          <div className="sub">
            {day(invoice.invoice_date)} · due {day(invoice.due_date)}{invoice.account_number ? ` · account ${invoice.account_number}` : ''} · {money(invoice.total_ex)} ex GST{Number(invoice.tax) ? ` + ${money(invoice.tax)} GST` : ''}
            {' · '}loaded {dayTime(invoice.uploaded_at)}{invoice.uploaded_by_name ? ` by ${invoice.uploaded_by_name}` : ''}
          </div>
        </div>
        <div className="flex noprint">
          <Link className="btn" href="/stream/cinv">All carrier invoices</Link>
          {canEdit && <form action={rematchCarrierInvoice}><input type="hidden" name="invoice" value={id} /><button className="btn">Match again</button></form>}
        </div>
      </div>
      {msg && <div className={`banner ${/^(Not|Nothing) /.test(msg) ? 'warn' : ''}`} role="status">{msg}</div>}
      {error && <div className="banner warn" role="alert">Couldn&apos;t load the lines: {error.message}</div>}

      <div className="grid k4">
        <div className="card kpi"><div className="l">To decide</div><div className="v">{invoice.open}</div><div className="d">{money(invoice.open_at_stake)} at stake</div></div>
        <div className="card kpi"><div className="l">Matched to Jet jobs</div><div className="v">{invoice.matched} of {invoice.shipments}</div><div className="d">{invoice.shipments - invoice.matched} with no Jet job</div></div>
        <div className="card kpi"><div className="l">Jet billed on those</div><div className="v">{money(invoice.jet_billed)}</div><div className="d">{carrier} charged {money(invoice.matched_cost)} · ex GST</div></div>
        <div className="card kpi"><div className="l">Margin on matched jobs</div><div className="v">{money(margin)}</div><div className="d">{Number(invoice.jet_billed) ? `${Math.round((100 * margin) / Number(invoice.jet_billed))}% of what Jet billed` : '—'}</div></div>
      </div>

      <div className="tabs mt">
        {VIEWS.map(([k, label]) => (
          <Link key={k} href={{ pathname: `/stream/cinv/${id}`, query: k === 'open' ? {} : { view: k } }} style={{ textDecoration: 'none' }}>
            <span className={k === view ? 'on' : ''}>{label} ({count(k)})</span>
          </Link>
        ))}
      </div>
      {ISSUES[view] && <p className="hint">{ISSUES[view][2]}.</p>}

      <form action={decideCarrierLines} className="card" style={{ padding: 0 }}>
        <input type="hidden" name="invoice" value={id} /><input type="hidden" name="view" value={view === 'open' ? '' : view} />
        <div className="tw">
          <table>
            <thead><tr>
              {decidable && <th><CheckAll name="line" /></th>}
              <th>{carrier} waybill · Jet connote</th><th>Customer</th><th>Shipped</th><th>Weight</th><th className="r">{carrier} ex GST</th><th className="r">Jet billed</th>
              <th>Surcharges</th><th>Exceptions</th><th className="r">At stake</th><th>Decision</th>
            </tr></thead>
            <tbody>
              {shown.map((l) => {
                const extras = (l.extras ?? []).filter((e) => e.code !== 'FF');
                const fuel = (l.extras ?? []).filter((e) => e.code === 'FF').reduce((a, e) => a + e.amount, 0);
                const [dLabel, dTone] = DECISIONS[l.decision] ?? ['', ''];
                return (
                  <tr key={l.id}>
                    {decidable && <td>{l.decision === 'pending' && l.issues.length ? <input type="checkbox" name="line" value={l.id} aria-label={`Select ${l.waybill}`} /> : null}</td>}
                    <td><b>{l.waybill}</b><div className="hint">{l.connote ?? (l.reference ? `ref ${l.reference} · no Jet job` : 'no Jet job')}</div></td>
                    <td>{l.customer ? <>{l.customer.name} <span className="hint">{l.customer.account_code}</span></> : '—'}</td>
                    <td>{day(l.shipped_on)}<div className="hint">{l.orig_country}→{l.dest_country}{l.product_name ? ` · ${l.product_name.toLowerCase()}` : ''}</div></td>
                    <td title={`Customer scale ${kg(l.declared_kg)}, ${carrier} scale ${kg(l.carrier_kg)}, customer volume ${kg(l.declared_vol_kg)}, ${carrier} volume ${kg(l.carrier_vol_kg)}`}>
                      {carrier} {kg(l.billed_kg)}<div className="hint">{l.weight_flag ? `${FLAG[l.weight_flag] ?? l.weight_flag} · ` : ''}Jet {kg(l.jet_kg)}</div>
                    </td>
                    <td className="r">{money(l.total_ex)}<div className="hint">freight {money(l.weight_charge)}{fuel ? ` · fuel ${money(fuel)}` : ''}</div></td>
                    <td className="r">{l.connote ? money(l.jet_billed) : '—'}{Number(l.jet_addons) ? <div className="hint">add-ons {money(l.jet_addons)}</div> : null}</td>
                    <td>{extras.length ? extras.map((e) => <div key={e.code} className="hint">{e.name.toLowerCase()} {money(e.amount)}</div>) : <span className="hint">—</span>}</td>
                    <td>{l.issues.map((i) => <span key={i} className={`pill ${ISSUES[i]?.[1] ?? ''}`} title={ISSUES[i]?.[2]} style={{ marginRight: 4 }}>{ISSUES[i]?.[0] ?? i}</span>)}</td>
                    <td className="r">{l.issues.length ? money(l.at_stake) : ''}</td>
                    <td>
                      {l.decision !== 'pending' ? (
                        <><span className={`pill ${dTone}`}>{dLabel}</span><div className="hint">{l.decider?.full_name ?? ''}{l.decided_at ? ` · ${day(l.decided_at)}` : ''}{l.decision_note ? ` · ${l.decision_note}` : ''}{l.passed_charge_id ? ' · charge added' : ''}</div></>
                      ) : l.issues.length ? <span className="hint">To decide</span> : <span className="hint">Matches</span>}
                    </td>
                  </tr>
                );
              })}
              {!shown.length && <tr><td colSpan={11} className="hint">{view === 'open' ? 'Nothing left to decide on this invoice.' : 'No lines here.'}</td></tr>}
            </tbody>
          </table>
        </div>
        {decidable && (
          <div className="flex" style={{ padding: '10px 16px 14px', flexWrap: 'wrap' }}>
            <label htmlFor="cl-decision" className="hint">Ticked lines:</label>
            <select id="cl-decision" name="decision" className="f" defaultValue="pass_on" style={{ width: 'auto' }}>
              <option value="pass_on">Pass on to the customer</option><option value="absorb">Absorb (Jet pays)</option>
              <option value="dispute">Dispute with {carrier}</option><option value="ok">Fine, nothing to do</option>
            </select>
            <input name="amount" className="f" inputMode="decimal" placeholder="Amount (one line only)" aria-label="Amount to pass on, ex GST" style={{ maxWidth: 190 }} />
            <input name="note" className="f" placeholder="Note (optional)" aria-label="Note" style={{ maxWidth: 260 }} />
            <button className="btn primary">Apply</button>
            <span className="hint">Passing on adds the amount at stake (ex GST, with GST as {carrier} charged it) to the customer&apos;s next invoice.</span>
          </div>
        )}
      </form>

      {canEdit && !lines.some((l) => l.decision === 'pass_on') && (
        <form action={removeCarrierInvoice} className="mt noprint">
          <input type="hidden" name="invoice" value={id} />
          <button className="btn ghost sm">Remove this invoice (loaded by mistake)</button>
        </form>
      )}
    </>
  );
}

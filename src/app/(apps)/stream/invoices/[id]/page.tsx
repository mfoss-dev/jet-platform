import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BILLING_EDITORS, day, dayTime, money, one } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { approveCredit, discardCredit } from '../actions';
import { STATUS } from '../labels';
import { PrintButton } from './PrintButton';

type Invoice = {
  id: string; run_id: string | null; branch_code: string; number: number | null; kind: string; invoice_date: string; due_date: string | null; terms_code: string | null;
  charge_total: number; fuel_total: number; security_total: number; gst_total: number; total: number; status: string; flags: string[]; source: string | null;
  credit_for: string | null; reason: string | null; approved_at: string | null;
  bill_to: { id: string; name: string; account_code: string; invoice_recipients: string | null } | null;
  rebill_to: { name: string; account_code: string } | null;
};
type Credit = { id: string; number: number | null; status: string; invoice_date: string; total: number; reason: string | null };
type Line = {
  id: string; connote: string; shipped_on: string; service_code: string | null; kind: string; code: string; description: string; charge: number; fuel: number; security: number; gst: number;
  pieces: number | null; weight: number | null; orig_country: string | null; dest_country: string | null; customer: { name: string; account_code: string } | null;
};

const ENTITY: Record<string, string> = { AU: 'Jet Worldwide (Aust) Pty Ltd', NZ: 'Jet Worldwide · Auckland' };
const amt = (n: number) => (n ? money(n) : '');

// The tax invoice, laid out like JetStream's: a summary by service, then each shipment with its lines
// (Charge + Fuel + Security + GST = Total). Print it to PDF from the browser.
export default async function InvoiceView({ params, searchParams }: PageProps<'/stream/invoices/[id]'>) {
  const me = await getMe();
  if (!me.apps.includes('stream')) notFound();
  const { id } = await params;
  const msg = [(await searchParams).msg].flat()[0] ?? '';
  const canEdit = BILLING_EDITORS.includes(me.role);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const [{ data }, { data: lineData }, { data: services }, { data: creditData }] = await Promise.all([
    supabase.from(SELECTS.invoice.table).select(SELECTS.invoice.select).eq('id', id).maybeSingle(),
    supabase.from(SELECTS.invoiceLines.table).select(SELECTS.invoiceLines.select).eq('invoice_id', id).order('connote').order('code').limit(5000),
    supabase.from(SELECTS.tariffServices.table).select(SELECTS.tariffServices.select),
    supabase.from(SELECTS.credits.table).select(SELECTS.credits.select).eq('credit_for', id).order('created_at'),
  ]);
  if (!data) notFound();
  const raw = data as unknown as Invoice;
  const { data: original } = raw.credit_for ? await supabase.from(SELECTS.credits.table).select('id, number').eq('id', raw.credit_for).maybeSingle() : { data: null };
  const inv = { ...raw, bill_to: one(raw.bill_to), rebill_to: one(raw.rebill_to), original: original as { id: string; number: number | null } | null };
  const isCredit = inv.kind === 'credit';
  const credits = (creditData ?? []) as unknown as Credit[];
  const creditedTotal = credits.reduce((a, c) => a + Number(c.total), 0);
  const lines = ((lineData ?? []) as unknown as Line[]).map((l) => ({
    ...l, customer: one(l.customer), charge: Number(l.charge), fuel: Number(l.fuel), security: Number(l.security), gst: Number(l.gst),
  }));
  const serviceName = (c: string | null) => (c === 'CUSTOMS' ? 'Customs clearance' : (services ?? []).find((s) => s.code === c)?.name ?? c ?? 'Other');
  const lineTotal = (l: Line) => l.charge + l.fuel + l.security + l.gst;

  const shipments = [...new Set(lines.map((l) => l.connote))].map((c) => ({ connote: c, lines: lines.filter((l) => l.connote === c) }));
  const byService = new Map<string, { exGst: number; gst: number; count: number }>();
  for (const s of shipments) {
    const name = serviceName(s.lines[0].service_code);
    const v = byService.get(name) ?? { exGst: 0, gst: 0, count: 0 };
    for (const l of s.lines) { v.exGst += l.charge + l.fuel + l.security; v.gst += l.gst; }
    v.count++;
    byService.set(name, v);
  }
  const otherAccounts = new Set(lines.map((l) => l.customer?.account_code)).size > 1 || lines.some((l) => l.customer?.account_code !== inv.bill_to?.account_code);

  return (
    <>
      <div className="top noprint">
        <div>
          <h1>{isCredit ? 'Credit note' : 'Invoice'} {inv.number ?? '(draft)'}</h1>
          <div className="sub">
            <span className={`pill ${STATUS[inv.status]?.[1] ?? ''}`}>{STATUS[inv.status]?.[0] ?? inv.status}</span>
            {inv.flags.length > 0 && inv.status === 'draft' && <> · {inv.flags.join(' · ')}</>}
            {inv.source === 'jetstream' && ' · issued by JetStream'}
            {isCredit && inv.original && <> · credits <Link href={`/stream/invoices/${inv.original.id}`}>invoice {inv.original.number}</Link></>}
            {isCredit && inv.approved_at && <> · approved {dayTime(inv.approved_at)}</>}
          </div>
        </div>
        <div className="flex">
          {inv.run_id && <Link className="btn" href={`/stream/run?run=${inv.run_id}`}>Back to the run</Link>}
          {canEdit && !isCredit && inv.status !== 'draft' && <Link className="btn" href={`/stream/invoices/${id}/credit`}>Raise credit note</Link>}
          {isCredit && inv.status !== 'draft' && <a className="btn" href={`/stream/invoices/myob?id=${id}`}>MYOB file</a>}
          <PrintButton />
        </div>
      </div>
      {msg && <div className={`banner noprint ${/^Not /.test(msg) ? 'warn' : ''}`} role="status">{msg}</div>}

      {isCredit && inv.status === 'draft' && (
        <div className="card noprint">
          <b>Draft credit note.</b> {inv.reason}
          {inv.rebill_to && <> · on approval the credited lines are re-billed to <b>{inv.rebill_to.name}</b> {inv.rebill_to.account_code} in the next run</>}
          {canEdit && (
            <div className="flex mt8">
              <form action={approveCredit}><input type="hidden" name="id" value={id} /><button className="btn primary">Approve credit note ({money(inv.total)})</button></form>
              <form action={discardCredit}><input type="hidden" name="id" value={id} /><input type="hidden" name="invoice" value={inv.credit_for ?? ''} /><button className="btn ghost">Discard</button></form>
            </div>
          )}
        </div>
      )}

      {!isCredit && credits.length > 0 && (
        <div className="card noprint">
          <h3>Credit notes against this invoice</h3>
          <table className="mt8">
            <thead><tr><th>Number</th><th>Date</th><th>Reason</th><th className="r">Amount</th><th>Status</th></tr></thead>
            <tbody>
              {credits.map((c) => (
                <tr key={c.id}>
                  <td><Link href={`/stream/invoices/${c.id}`}><b>{c.number ?? 'Draft'}</b></Link></td><td>{day(c.invoice_date)}</td><td>{c.reason}</td>
                  <td className="r">{money(c.total)}</td><td><span className={`pill ${STATUS[c.status]?.[1] ?? ''}`}>{STATUS[c.status]?.[0] ?? c.status}</span></td>
                </tr>
              ))}
              <tr><td colSpan={3}><b>Invoice less credits</b></td><td className="r"><b>{money(Number(inv.total) + creditedTotal)}</b></td><td /></tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="card invoice">
        <div className="flex" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{inv.kind === 'credit' ? 'ADJUSTMENT NOTE' : 'TAX INVOICE'}</div>
            <div className="hint">{ENTITY[inv.branch_code] ?? 'Jet Worldwide'}{inv.kind === 'duties' ? ' · customs duties and charges' : ''}</div>
            {isCredit && <div className="mt8">Adjusts invoice <b>{inv.original?.number}</b>{inv.reason ? ` · ${inv.reason}` : ''}</div>}
          </div>
          <table style={{ width: 'auto' }}>
            <tbody>
              <tr><td className="hint">{isCredit ? 'Credit note no' : 'Invoice no'}</td><td className="r"><b>{inv.number ?? 'on approval'}</b></td></tr>
              <tr><td className="hint">Date</td><td className="r">{day(inv.invoice_date)}</td></tr>
              <tr><td className="hint">Account</td><td className="r">{inv.bill_to?.account_code}</td></tr>
              {!isCredit && <tr><td className="hint">Terms</td><td className="r">{inv.terms_code ?? '—'}</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="mt">
          <div className="hint">Bill to</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{inv.bill_to?.name}</div>
        </div>

        <table className="mt">
          <thead><tr><th>Summary</th><th className="r">Shipments</th><th className="r">Ex GST</th><th className="r">GST</th><th className="r">Total</th></tr></thead>
          <tbody>
            {[...byService.entries()].map(([name, v]) => (
              <tr key={name}><td>{name} services</td><td className="r">{v.count}</td><td className="r">{money(v.exGst)}</td><td className="r">{money(v.gst)}</td><td className="r">{money(v.exGst + v.gst)}</td></tr>
            ))}
            <tr>
              <td><b>{isCredit ? 'TOTAL CREDIT' : `TOTAL DUE ${day(inv.due_date)}`}</b></td><td className="r">{shipments.length}</td>
              <td className="r">{money(Number(inv.charge_total) + Number(inv.fuel_total) + Number(inv.security_total))}</td><td className="r">{money(inv.gst_total)}</td>
              <td className="r"><b>{money(inv.total)}</b></td>
            </tr>
          </tbody>
        </table>
        {!isCredit && <p className="hint mt8">Claims must be made within 21 days of the invoice date.</p>}

        <h3 className="mt">Shipment detail</h3>
        <table className="mt8">
          <thead><tr><th>Shipment</th><th>Service / product</th><th className="r">Charge</th><th className="r">+ Fuel</th><th className="r">+ Sec.</th><th className="r">+ GST</th><th className="r">= Total</th></tr></thead>
          <tbody>
            {shipments.map((s) => {
              const f = s.lines[0];
              return s.lines.map((l, k) => (
                <tr key={l.id} style={k === s.lines.length - 1 ? { borderBottom: '1px dashed var(--line)' } : undefined}>
                  <td style={{ verticalAlign: 'top' }}>
                    {k === 0 && (
                      <>
                        <b>{s.connote}</b>
                        <div className="hint">{day(f.shipped_on)}{f.pieces != null ? ` · ${f.pieces} pc` : ''}{f.weight != null ? ` · ${Number(f.weight)} kg` : ''}</div>
                        <div className="hint">{f.orig_country ?? ''}{f.dest_country ? ` → ${f.dest_country}` : ''}{otherAccounts ? ` · ${f.customer?.account_code}` : ''}</div>
                      </>
                    )}
                  </td>
                  <td>{k === 0 && <b>{serviceName(l.service_code)}</b>}{l.code !== '.FREIGHT' && <div>- {l.description || l.code}</div>}</td>
                  <td className="r">{amt(l.charge)}</td><td className="r">{amt(l.fuel)}</td><td className="r">{amt(l.security)}</td><td className="r">{amt(l.gst)}</td>
                  <td className="r">{money(lineTotal(l))}</td>
                </tr>
              ));
            })}
            {!shipments.length && <tr><td colSpan={7} className="hint">No lines.</td></tr>}
          </tbody>
        </table>
        <div className="flex mt" style={{ justifyContent: 'space-between' }}>
          <b>{isCredit ? '' : `DUE DATE ${day(inv.due_date)}`}</b>
          <b>{isCredit ? 'TOTAL CREDIT' : 'TOTAL AMOUNT DUE'} {money(inv.total)}</b>
        </div>
      </div>
    </>
  );
}

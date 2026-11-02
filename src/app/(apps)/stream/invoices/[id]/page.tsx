import Link from 'next/link';
import { notFound } from 'next/navigation';
import { day, money, one } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { STATUS } from '../labels';
import { PrintButton } from './PrintButton';

type Invoice = {
  id: string; run_id: string | null; branch_code: string; number: number | null; kind: string; invoice_date: string; due_date: string | null; terms_code: string | null;
  charge_total: number; fuel_total: number; security_total: number; gst_total: number; total: number; status: string; flags: string[]; source: string | null;
  bill_to: { id: string; name: string; account_code: string; invoice_recipients: string | null } | null;
};
type Line = {
  id: string; connote: string; shipped_on: string; service_code: string | null; kind: string; code: string; description: string; charge: number; fuel: number; security: number; gst: number;
  pieces: number | null; weight: number | null; orig_country: string | null; dest_country: string | null; customer: { name: string; account_code: string } | null;
};

const ENTITY: Record<string, string> = { AU: 'Jet Worldwide (Aust) Pty Ltd', NZ: 'Jet Worldwide · Auckland' };
const amt = (n: number) => (n ? money(n) : '');

// The tax invoice, laid out like JetStream's: a summary by service, then each shipment with its lines
// (Charge + Fuel + Security + GST = Total). Print it to PDF from the browser.
export default async function InvoiceView({ params }: PageProps<'/stream/invoices/[id]'>) {
  const me = await getMe();
  if (!me.apps.includes('stream')) notFound();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const [{ data }, { data: lineData }, { data: services }] = await Promise.all([
    supabase.from(SELECTS.invoice.table).select(SELECTS.invoice.select).eq('id', id).maybeSingle(),
    supabase.from(SELECTS.invoiceLines.table).select(SELECTS.invoiceLines.select).eq('invoice_id', id).order('connote').order('code').limit(5000),
    supabase.from(SELECTS.tariffServices.table).select(SELECTS.tariffServices.select),
  ]);
  if (!data) notFound();
  const inv = { ...(data as unknown as Invoice), bill_to: one((data as unknown as Invoice).bill_to) };
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
          <h1>Invoice {inv.number ?? '(draft)'}</h1>
          <div className="sub">
            <span className={`pill ${STATUS[inv.status]?.[1] ?? ''}`}>{STATUS[inv.status]?.[0] ?? inv.status}</span>
            {inv.flags.length > 0 && inv.status === 'draft' && <> · {inv.flags.join(' · ')}</>}
            {inv.source === 'jetstream' && ' · issued by JetStream'}
          </div>
        </div>
        <div className="flex">
          {inv.run_id && <Link className="btn" href={`/stream/run?run=${inv.run_id}`}>Back to the run</Link>}
          <PrintButton />
        </div>
      </div>

      <div className="card invoice">
        <div className="flex" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{inv.kind === 'credit' ? 'ADJUSTMENT NOTE' : 'TAX INVOICE'}</div>
            <div className="hint">{ENTITY[inv.branch_code] ?? 'Jet Worldwide'}{inv.kind === 'duties' ? ' · customs duties and charges' : ''}</div>
          </div>
          <table style={{ width: 'auto' }}>
            <tbody>
              <tr><td className="hint">Invoice no</td><td className="r"><b>{inv.number ?? 'on approval'}</b></td></tr>
              <tr><td className="hint">Invoice date</td><td className="r">{day(inv.invoice_date)}</td></tr>
              <tr><td className="hint">Account</td><td className="r">{inv.bill_to?.account_code}</td></tr>
              <tr><td className="hint">Terms</td><td className="r">{inv.terms_code ?? '—'}</td></tr>
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
              <td><b>TOTAL DUE {day(inv.due_date)}</b></td><td className="r">{shipments.length}</td>
              <td className="r">{money(Number(inv.charge_total) + Number(inv.fuel_total) + Number(inv.security_total))}</td><td className="r">{money(inv.gst_total)}</td>
              <td className="r"><b>{money(inv.total)}</b></td>
            </tr>
          </tbody>
        </table>
        <p className="hint mt8">Claims must be made within 21 days of the invoice date.</p>

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
          <b>DUE DATE {day(inv.due_date)}</b>
          <b>TOTAL AMOUNT DUE {money(inv.total)}</b>
        </div>
      </div>
    </>
  );
}

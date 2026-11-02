// The MYOB sales import file in JetStream's layout (ExportToMYOB in frmAccRating): one row per charge line, a blank
// row between invoices, duties invoice numbers prefixed "D", tax code GST or FRE. Credit notes are the same rows with
// negative amounts, which MYOB imports as a credit.
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const field = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const blanks = (n: number) => Array(n).fill('');

type Who = { name: string; account_code: string };
export type MyobInvoice = { id: string; number: number; kind: string; invoice_date: string; due_date: string | null; bill_to: Who | Who[] | null };
export type MyobLine = { invoice_id: string; connote: string; description: string; code: string; charge: number; fuel: number; security: number; gst: number; income_account: string | null };

export const MYOB_INVOICE = 'id, number, kind, invoice_date, due_date, bill_to:customers!invoices_bill_to_id_fkey(name, account_code)';
export const MYOB_LINE = 'invoice_id, connote, description, code, charge, fuel, security, gst, income_account';

export function myobFile(invoices: MyobInvoice[], lines: MyobLine[], nz: boolean) {
  const out: string[] = [];
  for (const inv of invoices) {
    const who = Array.isArray(inv.bill_to) ? inv.bill_to[0] : inv.bill_to;
    const days = inv.due_date ? Math.round((Date.parse(inv.due_date) - Date.parse(inv.invoice_date)) / 864e5) : 0;
    for (const l of lines.filter((x) => x.invoice_id === inv.id)) {
      const ex = Number(l.charge) + Number(l.fuel) + Number(l.security);
      const gst = Number(l.gst);
      out.push([
        who?.name ?? '', '', `${inv.kind === 'duties' ? 'D' : ''}${inv.number}`, ddmmyyyy(inv.invoice_date), ...blanks(nz ? 7 : 6),
        `${l.connote}: ${l.description || l.code}`, l.income_account ?? '', ex.toFixed(2), (ex + gst).toFixed(2), '', gst ? 'GST' : 'FRE', '0.00', gst.toFixed(2),
        ...(nz ? ['7', '', ''] : ['0.00', '', '']), ...(nz ? ['22', '0', '0', '0', '0'] : ['2', '0', String(days), '0', '0']), ...blanks(nz ? 7 : 12), who?.account_code ?? '',
      ].map(field).join(','));
    }
    out.push('');
  }
  return out.join('\r\n');
}

export const csvResponse = (body: string, name: string) =>
  new Response(body, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` } });

import { docName, lineTotal, loadInvoiceDoc } from '@/lib/invoice-doc';
import { createClient } from '@/lib/supabase/server';

// The shipment CSV that goes with an invoice, one row per shipment, in JetStream's column order (Inv_No to
// Inc_GST), then the connote and countries. Goods description and the sender and receiver addresses JetStream added
// aren't held here yet, so Description is blank.
const field = (v: string | number | null | undefined) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export async function GET(_req: Request, ctx: RouteContext<'/invoices/[id]/csv'>) {
  const { id } = await ctx.params;
  const doc = await loadInvoiceDoc(await createClient(), id);
  if (!doc) return new Response('Not found', { status: 404 });
  const { inv, shipments } = doc;
  const rows = [['Inv_No', 'Inv_Date', 'Sender_Acc', 'ShipDate', 'Service', 'Reference', 'Pieces', 'Kgs', 'Description', 'Ex_GST', 'GST', 'Inc_GST', 'Connote', 'Origin_Country', 'Dest_Country']];
  for (const s of shipments) {
    const f = s.lines[0];
    const gst = s.lines.reduce((a, l) => a + l.gst, 0);
    const total = s.lines.reduce((a, l) => a + lineTotal(l), 0);
    rows.push([
      String(inv.number ?? ''), dmy(inv.invoice_date), f.customer?.account_code ?? '', dmy(f.shipped_on), s.service, f.reference ?? '',
      f.pieces == null ? '' : String(f.pieces), f.weight == null ? '' : Number(f.weight).toFixed(2), '',
      (total - gst).toFixed(2), gst.toFixed(2), total.toFixed(2), s.connote, f.orig_country ?? '', f.dest_country ?? '',
    ]);
  }
  return new Response(rows.map((r) => r.map(field).join(',')).join('\r\n'), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${docName(inv, 'csv')}"`, 'Cache-Control': 'private, no-store' },
  });
}

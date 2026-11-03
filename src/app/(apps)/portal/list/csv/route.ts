import { readFilters, shipmentsQuery, STATUS, type Shipment } from '@/lib/portal-shipments';
import { createClient } from '@/lib/supabase/server';

// My shipments as a CSV, with the same filters as the page.
const field = (v: string | number | null | undefined) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function GET(req: Request) {
  const f = readFilters(Object.fromEntries(new URL(req.url).searchParams));
  const { data, error } = await shipmentsQuery(await createClient(), f).limit(10000);
  if (error) return new Response('Could not load shipments', { status: 500 });
  const rows = [['Connote', 'Account', 'Shipped', 'Service', 'Reference', 'Pieces', 'Kgs', 'From', 'To', 'Status', 'Invoice', 'Amount_inc_GST']];
  for (const s of (data ?? []) as unknown as Shipment[]) {
    rows.push([s.connote, s.account_code, s.shipped_on, s.kind === 'duties' ? 'Customs duties' : s.service_name ?? s.service_code ?? '', s.reference ?? '',
      s.pieces == null ? '' : String(s.pieces), s.weight == null ? '' : Number(s.weight).toFixed(2), s.orig_country ?? '', s.dest_country ?? '',
      STATUS[s.status], s.invoice_number == null ? '' : String(s.invoice_number), s.total == null ? '' : Number(s.total).toFixed(2)]);
  }
  return new Response(rows.map((r) => r.map(field).join(',')).join('\r\n'), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="Jet Worldwide shipments.csv"', 'Cache-Control': 'private, no-store' },
  });
}

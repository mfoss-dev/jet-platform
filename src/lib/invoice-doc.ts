import { one } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import type { createClient } from '@/lib/supabase/server';

// One invoice or credit note with its lines, grouped the way the printed invoice shows them: a summary by service,
// then each shipment with its lines. Read as the signed-in person, so row-level security decides what comes back.

export type DocLine = {
  id: string; connote: string; shipped_on: string; service_code: string | null; kind: string; code: string; description: string;
  charge: number; fuel: number; security: number; gst: number; pieces: number | null; weight: number | null;
  orig_country: string | null; dest_country: string | null; reference?: string | null; customer: { name: string; account_code: string } | null;
};
export type DocInvoice = {
  id: string; branch_code: string; number: number | null; kind: string; invoice_date: string; due_date: string | null; terms_code: string | null;
  charge_total: number; fuel_total: number; security_total: number; gst_total: number; total: number; status: string; reason: string | null;
  bill_to: { id: string; name: string; account_code: string } | null; original: number | null;
};
export type InvoiceDoc = {
  inv: DocInvoice;
  shipments: { connote: string; service: string; lines: DocLine[] }[];
  byService: { name: string; count: number; exGst: number; gst: number }[];
};

export const ENTITY: Record<string, string> = { AU: 'Jet Worldwide (Aust) Pty Ltd', NZ: 'Jet Worldwide · Auckland' };
export const lineTotal = (l: DocLine) => l.charge + l.fuel + l.security + l.gst;

export async function loadInvoiceDoc(supabase: Awaited<ReturnType<typeof createClient>>, id: string): Promise<InvoiceDoc | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [{ data }, { data: lineData }, { data: services }] = await Promise.all([
    supabase.from(SELECTS.invoiceDoc.table).select(SELECTS.invoiceDoc.select).eq('id', id).maybeSingle(),
    supabase.from(SELECTS.invoiceLines.table).select(SELECTS.invoiceLines.select).eq('invoice_id', id).order('connote').order('code').limit(5000),
    supabase.from(SELECTS.tariffServices.table).select(SELECTS.tariffServices.select),
  ]);
  if (!data) return null;
  const raw = data as unknown as Omit<DocInvoice, 'original' | 'bill_to'> & { credit_for: string | null; bill_to: DocInvoice['bill_to'] | DocInvoice['bill_to'][] };
  const { data: original } = raw.credit_for
    ? await supabase.from('invoices').select('number').eq('id', raw.credit_for).maybeSingle()
    : { data: null };
  const inv: DocInvoice = { ...raw, bill_to: one(raw.bill_to), original: original?.number ?? null };

  const serviceName = (c: string | null) => (c === 'CUSTOMS' ? 'Customs clearance' : (services ?? []).find((s) => s.code === c)?.name ?? c ?? 'Other');
  const lines = ((lineData ?? []) as unknown as DocLine[]).map((l) => ({
    ...l, customer: one(l.customer), charge: Number(l.charge), fuel: Number(l.fuel), security: Number(l.security), gst: Number(l.gst),
  }));
  const shipments = [...new Set(lines.map((l) => l.connote))].map((c) => {
    const ls = lines.filter((l) => l.connote === c);
    return { connote: c, service: serviceName(ls[0].service_code), lines: ls };
  });
  const sums = new Map<string, { name: string; count: number; exGst: number; gst: number }>();
  for (const s of shipments) {
    const v = sums.get(s.service) ?? { name: s.service, count: 0, exGst: 0, gst: 0 };
    for (const l of s.lines) { v.exGst += l.charge + l.fuel + l.security; v.gst += l.gst; }
    v.count++;
    sums.set(s.service, v);
  }
  return { inv, shipments, byService: [...sums.values()] };
}

// File names customers will see in their downloads folder.
export const docName = (inv: DocInvoice, ext: string) =>
  `${inv.kind === 'credit' ? 'Jet Worldwide credit note' : 'Jet Worldwide invoice'} ${inv.number ?? 'draft'}.${ext}`;

import { docName, loadInvoiceDoc } from '@/lib/invoice-doc';
import { invoicePdf } from '@/lib/invoice-pdf';
import { createClient } from '@/lib/supabase/server';

// The invoice or credit note as a PDF, for staff and for the customer who pays it (row-level security decides).
export async function GET(_req: Request, ctx: RouteContext<'/invoices/[id]/pdf'>) {
  const { id } = await ctx.params;
  const doc = await loadInvoiceDoc(await createClient(), id);
  if (!doc) return new Response('Not found', { status: 404 });
  const body = await invoicePdf(doc);
  return new Response(body as BodyInit, {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${docName(doc.inv, 'pdf')}"`, 'Cache-Control': 'private, no-store' },
  });
}

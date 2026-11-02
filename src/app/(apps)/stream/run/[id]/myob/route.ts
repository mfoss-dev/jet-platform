import { createClient } from '@/lib/supabase/server';
import { csvResponse, MYOB_INVOICE, MYOB_LINE, myobFile, type MyobInvoice, type MyobLine } from '@/lib/myob';

// The MYOB sales import file for an approved run.
export async function GET(_req: Request, ctx: RouteContext<'/stream/run/[id]/myob'>) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
  const supabase = await createClient();
  const { data: run } = await supabase.from('invoice_runs').select('branch_code, kind, period_end').eq('id', id).maybeSingle();
  if (!run) return new Response('Not found', { status: 404 });
  const { data: invData } = await supabase.from('invoices').select(MYOB_INVOICE).eq('run_id', id).neq('status', 'draft').order('number').limit(5000);
  const invoices = (invData ?? []) as unknown as MyobInvoice[];
  const lines: MyobLine[] = [];
  for (let i = 0; i < invoices.length; i += 200) {
    const { data } = await supabase.from('charges').select(MYOB_LINE).in('invoice_id', invoices.slice(i, i + 200).map((x) => x.id)).order('connote').order('code').limit(10000);
    lines.push(...((data ?? []) as unknown as MyobLine[]));
  }
  return csvResponse(myobFile(invoices, lines, run.branch_code === 'NZ'), `MYOB-${run.branch_code}-${run.kind}-${run.period_end}.csv`);
}

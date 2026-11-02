import { createClient } from '@/lib/supabase/server';
import { csvResponse, MYOB_INVOICE, MYOB_LINE, myobFile, type MyobInvoice, type MyobLine } from '@/lib/myob';

// The MYOB file for approved credit notes: one (?id=) or a branch's credits dated between two days (?branch=&from=&to=).
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const id = q.get('id') ?? '';
  const branch = q.get('branch') ?? '';
  const from = q.get('from') ?? '';
  const to = q.get('to') ?? '';
  const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (!/^[0-9a-f-]{36}$/i.test(id) && !(['AU', 'NZ'].includes(branch) && isDay(from) && isDay(to))) return new Response('Not found', { status: 404 });
  const supabase = await createClient();
  let list = supabase.from('invoices').select(`${MYOB_INVOICE}, branch_code`).eq('kind', 'credit').neq('status', 'draft');
  list = id ? list.eq('id', id) : list.eq('branch_code', branch).gte('invoice_date', from).lte('invoice_date', to);
  const { data: invData } = await list.order('number').limit(2000);
  const invoices = (invData ?? []) as unknown as (MyobInvoice & { branch_code: string })[];
  if (!invoices.length) return new Response('No approved credit notes', { status: 404 });
  const { data } = await supabase.from('charges').select(MYOB_LINE).in('invoice_id', invoices.map((x) => x.id)).order('connote').order('code').limit(10000);
  const name = id ? `MYOB-credit-${invoices[0].number}.csv` : `MYOB-${branch}-credits-${from}-to-${to}.csv`;
  return csvResponse(myobFile(invoices, (data ?? []) as unknown as MyobLine[], invoices[0].branch_code === 'NZ'), name);
}

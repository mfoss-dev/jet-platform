import { createClient } from '@/lib/supabase/server';

// The MYOB sales import file for an approved run, in JetStream's layout (ExportToMYOB in frmAccRating): one row per
// charge line, a blank row between invoices, duties invoice numbers prefixed "D", tax code GST or FRE.
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const field = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const blanks = (n: number) => Array(n).fill('');

type Inv = { id: string; number: number; kind: string; invoice_date: string; due_date: string | null; bill_to: { name: string; account_code: string } | { name: string; account_code: string }[] | null };
type Line = { invoice_id: string; connote: string; description: string; code: string; charge: number; fuel: number; security: number; gst: number; income_account: string | null };

export async function GET(_req: Request, ctx: RouteContext<'/stream/run/[id]/myob'>) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
  const supabase = await createClient();
  const { data: run } = await supabase.from('invoice_runs').select('branch_code, kind, period_end').eq('id', id).maybeSingle();
  if (!run) return new Response('Not found', { status: 404 });
  const { data: invData } = await supabase.from('invoices').select('id, number, kind, invoice_date, due_date, bill_to:customers!invoices_bill_to_id_fkey(name, account_code)')
    .eq('run_id', id).neq('status', 'draft').order('number').limit(5000);
  const invoices = (invData ?? []) as unknown as Inv[];
  const lines: Line[] = [];
  for (let i = 0; i < invoices.length; i += 200) {
    const { data } = await supabase.from('charges').select('invoice_id, connote, description, code, charge, fuel, security, gst, income_account')
      .in('invoice_id', invoices.slice(i, i + 200).map((x) => x.id)).order('connote').order('code').limit(10000);
    lines.push(...((data ?? []) as unknown as Line[]));
  }
  const nz = run.branch_code === 'NZ';
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
  const name = `MYOB-${run.branch_code}-${run.kind}-${run.period_end}.csv`;
  return new Response(out.join('\r\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` } });
}

import { HEALTH, loadSales } from '@/lib/sales';
import { createClient } from '@/lib/supabase/server';

// A rep's accounts as a CSV (for Excel), with the same figures as the page.
const field = (v: string | number | null | undefined) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const code = q.get('code') ?? '';
  const { accounts, asOf } = await loadSales(await createClient(), q.get('duties') === '1');
  const rows = [['Account', 'Name', 'Branch', 'Rep', 'Health', 'Customer_since', 'Last_shipped', 'Sales_4w', 'Sales_prev_4w', 'Sales_13w', 'Shipments_13w']];
  for (const a of accounts.filter((x) => !code || (x.rep_code ?? '') === code).sort((x, y) => y.sales_13w - x.sales_13w)) {
    rows.push([a.account_code, a.name, a.branch_code, a.rep_code ?? '', HEALTH[a.health][0], a.first_trade_date ?? '', a.last_shipped ?? '',
      a.sales_4w.toFixed(2), a.sales_prev_4w.toFixed(2), a.sales_13w.toFixed(2), String(a.shipments_13w)]);
  }
  return new Response(rows.map((r) => r.map(field).join(',')).join('\r\n'), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="JetSales ${code || 'all'} to ${asOf}.csv"`, 'Cache-Control': 'private, no-store' },
  });
}

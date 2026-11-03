import type { createClient } from '@/lib/supabase/server';

// JetSales data: one row per account (sales and health) and weekly sales per rep, from the database functions
// sales_accounts() and sales_weekly(). Row-level rules in those functions decide whose accounts come back.

export type SalesAccount = {
  customer_id: string; account_code: string; name: string; branch_code: string; status: string; rep_code: string | null; rep_name: string | null; is_house: boolean;
  first_trade_date: string | null; first_shipped: string | null; last_shipped: string | null; as_of: string;
  sales_4w: number; sales_prev_4w: number; sales_13w: number; sales_total: number; shipments_4w: number; shipments_13w: number; health: Health;
};
export type Health = 'new' | 'growing' | 'steady' | 'at_risk' | 'quiet' | 'lost' | 'none';
export type Week = { week_start: string; rep_code: string | null; sales: number; shipments: number };
export type RepSummary = {
  code: string; name: string; is_house: boolean; accounts: number; active: number; sales_4w: number; sales_prev_4w: number; sales_13w: number;
  at_risk: number; quiet: number; new_accounts: number; weeks: number[];
};

export const HEALTH: Record<Health, [string, string]> = {
  at_risk: ['At risk', 'bad'], quiet: ['Quiet', 'warn'], lost: ['Lost', 'bad'], new: ['New', 'ok'], growing: ['Growing', 'ok'], steady: ['Steady', ''], none: ['No sales', ''],
};
export const HEALTH_RULES: Record<Health, string> = {
  at_risk: 'Last 4 weeks down more than 30% on the 4 before',
  quiet: 'No shipments for 14 days',
  lost: 'No shipments for 60 days',
  new: 'Became a customer in the last 90 days',
  growing: 'Last 4 weeks up more than 30% on the 4 before',
  steady: 'Trading as usual',
  none: 'No sales in the history',
};

const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
export const withDuties = (sp: Record<string, string | string[] | undefined>) => pick(sp.duties) === '1';

export async function loadSales(supabase: Awaited<ReturnType<typeof createClient>>, duties: boolean, weeks = 13) {
  const [{ data: a, error }, { data: w }] = await Promise.all([
    supabase.rpc('sales_accounts', { p_include_duties: duties }).limit(5000),
    supabase.rpc('sales_weekly', { p_weeks: weeks, p_include_duties: duties }).limit(5000),
  ]);
  const accounts = ((a ?? []) as SalesAccount[]).map((x) => ({
    ...x, sales_4w: Number(x.sales_4w), sales_prev_4w: Number(x.sales_prev_4w), sales_13w: Number(x.sales_13w), sales_total: Number(x.sales_total),
  }));
  const weekly = ((w ?? []) as Week[]).map((x) => ({ ...x, sales: Number(x.sales) }));
  const asOf = accounts[0]?.as_of ?? new Date().toISOString().slice(0, 10);
  // The Monday of each of the last `weeks` weeks, oldest first.
  const last = new Date(`${asOf}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() - ((last.getUTCDay() + 6) % 7));
  const mondays = Array.from({ length: weeks }, (_, i) => {
    const d = new Date(last); d.setUTCDate(d.getUTCDate() - 7 * (weeks - 1 - i));
    return d.toISOString().slice(0, 10);
  });
  return { accounts, weekly, asOf, mondays, error };
}

export const series = (weekly: Week[], mondays: string[], keep: (w: Week) => boolean = () => true) =>
  mondays.map((m) => weekly.filter((w) => w.week_start === m && keep(w)).reduce((s, w) => s + w.sales, 0));

export function byRep(accounts: SalesAccount[], weekly: Week[], mondays: string[]): RepSummary[] {
  const codes = [...new Set(accounts.map((a) => a.rep_code ?? ''))];
  return codes.map((code) => {
    const mine = accounts.filter((a) => (a.rep_code ?? '') === code);
    const sum = (k: 'sales_4w' | 'sales_prev_4w' | 'sales_13w') => mine.reduce((s, a) => s + a[k], 0);
    return {
      code, name: mine[0]?.rep_name ?? (code || 'No rep'), is_house: mine[0]?.is_house ?? false, accounts: mine.length,
      active: mine.filter((a) => a.shipments_13w > 0).length, sales_4w: sum('sales_4w'), sales_prev_4w: sum('sales_prev_4w'), sales_13w: sum('sales_13w'),
      at_risk: mine.filter((a) => a.health === 'at_risk').length, quiet: mine.filter((a) => a.health === 'quiet').length,
      new_accounts: mine.filter((a) => a.health === 'new').length, weeks: series(weekly, mondays, (w) => (w.rep_code ?? '') === code),
    };
  }).sort((a, b) => b.sales_13w - a.sales_13w);
}

// Change on the 4 weeks before, as a whole percentage; null when there's nothing to compare with.
export const change = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);

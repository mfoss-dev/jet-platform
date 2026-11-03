import type { createClient } from '@/lib/supabase/server';

// My shipments: the filters the page and its CSV download share.
export type Shipment = {
  connote: string; kind: string; branch_code: string; account_code: string; customer_name: string; shipped_on: string; service_code: string | null;
  service_name: string | null; pieces: number | null; weight: number | null; orig_country: string | null; dest_country: string | null; reference: string | null;
  status: 'invoiced' | 'to_invoice'; total: number | null; invoice_id: string | null; invoice_number: number | null;
};
export type ShipmentFilters = { q: string; status: string; period: string };

export const PERIOD: Record<string, [string, number]> = { '1': ['Last 30 days', 31], '3': ['Last 3 months', 92], '6': ['Last 6 months', 183], '12': ['Last 12 months', 366], all: ['All', 0] };
export const STATUS: Record<string, string> = { to_invoice: 'Not yet invoiced', invoiced: 'Invoiced' };
const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
export const isoDaysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

export function readFilters(sp: Record<string, string | string[] | undefined>): ShipmentFilters {
  return {
    q: pick(sp.q).trim().replace(/[%_,()*]/g, ''),
    status: STATUS[pick(sp.status)] ? pick(sp.status) : '',
    period: PERIOD[pick(sp.period)] ? pick(sp.period) : '3',
  };
}

export function shipmentsQuery(supabase: Awaited<ReturnType<typeof createClient>>, f: ShipmentFilters, count = false) {
  let list = supabase.rpc('portal_shipments', {}, count ? { count: 'exact' } : undefined).select('*');
  if (f.status) list = list.eq('status', f.status);
  if (PERIOD[f.period][1]) list = list.gte('shipped_on', isoDaysAgo(PERIOD[f.period][1]));
  if (f.q) list = list.or(`connote.ilike.*${f.q}*,reference.ilike.*${f.q}*`);
  return list.order('shipped_on', { ascending: false }).order('connote', { ascending: false });
}

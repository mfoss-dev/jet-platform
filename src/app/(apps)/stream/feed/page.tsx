import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { FeedTable, type FeedRow } from './FeedTable';

const VIEWS = [
  ['needs_attention', 'Needs attention'],
  ['ready', 'Ready'],
  ['on_hold', 'On hold'],
  ['invoiced', 'Invoiced'],
  ['all', 'All'],
] as const;
type View = (typeof VIEWS)[number][0];

export default async function BillingFeed({ searchParams }: PageProps<'/stream/feed'>) {
  const me = await getMe();
  if (!me.apps.includes('stream')) notFound();
  const sp = await searchParams;
  const view = (VIEWS.some(([v]) => v === sp.view) ? sp.view : 'needs_attention') as View;
  const q = typeof sp.q === 'string' ? sp.q.trim() : '';

  const supabase = await createClient();
  let query = supabase
    .from('job_list')
    .select('id, connote, customer_name, account_code, carrier_code, service_name, booked_at, origin_city, dest_city, dest_country, declared_weight_kg, carrier_weight_kg, sell_ex_gst, cost_ex_gst, margin_pct, status, billing_status, issue, issue_note')
    .order('booked_at', { ascending: false })
    .limit(500);
  if (view !== 'all') query = query.eq('billing_status', view);
  if (q) {
    const like = `%${q.replace(/[%_,()]/g, ' ')}%`;
    query = query.or(`connote.ilike.${like},customer_name.ilike.${like}`);
  }

  const counts = Object.fromEntries(
    await Promise.all(
      VIEWS.filter(([v]) => v !== 'all').map(async ([v]) => {
        const { count } = await supabase.from('job_list').select('id', { count: 'exact', head: true }).eq('billing_status', v);
        return [v, count ?? 0] as const;
      }),
    ),
  ) as Record<Exclude<View, 'all'>, number>;

  const { data, error } = await query;
  const rows = (data ?? []) as FeedRow[];
  const canEdit = ['owner', 'management', 'finance', 'admin'].includes(me.role);
  const totalJobs = Object.values(counts).reduce((a, b) => a + b, 0);
  const ready = counts.ready + counts.invoiced;

  return (
    <>
      <div className="top">
        <div>
          <h1>Billing feed</h1>
          <div className="sub">Every job, rated as it&apos;s booked · fix issues without leaving the list</div>
        </div>
      </div>

      {totalJobs > 0 && (
        <div className="banner">
          <b>Ready to invoice:</b> {ready.toLocaleString()} of {totalJobs.toLocaleString()} jobs ({Math.round((ready / totalJobs) * 100)}%)
          {counts.needs_attention > 0 && <> · {counts.needs_attention} exception{counts.needs_attention === 1 ? '' : 's'} to clear before the invoice run</>}
        </div>
      )}

      <div className="tabs">
        {VIEWS.map(([v, label]) => (
          <Link key={v} href={{ pathname: '/stream/feed', query: { view: v, ...(q ? { q } : {}) } }} scroll={false}>
            <span className={v === view ? 'on' : ''}>{label}{v !== 'all' ? ` (${counts[v].toLocaleString()})` : ''}</span>
          </Link>
        ))}
      </div>

      <form className="filters" action="/stream/feed">
        <input type="hidden" name="view" value={view} />
        <input name="q" defaultValue={q} placeholder="Search connote or customer…" aria-label="Search connote or customer" />
        <button className="btn">Search</button>
        {q && <Link className="btn ghost" href={{ pathname: '/stream/feed', query: { view } }}>Clear</Link>}
      </form>

      {error ? (
        <div className="banner warn" role="alert">Couldn&apos;t load jobs: {error.message}</div>
      ) : (
        <FeedTable key={`${view}:${q}`} rows={rows} canEdit={canEdit} showCost={me.role !== 'sales_rep'} />
      )}
    </>
  );
}

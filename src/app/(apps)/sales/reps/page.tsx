import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { SalesHeader } from '@/components/SalesHeader';
import { Sparkline } from '@/components/SalesCharts';
import { money } from '@/lib/format';
import { byRep, change, loadSales, withDuties } from '@/lib/sales';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { saveRep } from '../actions';

type Rep = { code: string; name: string; branch_code: string | null; is_house: boolean; profile_id: string | null; active: boolean };
const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const pct = (n: number | null) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n}%`);

// Rep performance, and rep setup: link each JetStream rep code to the rep's sign-in (so they see their own
// accounts) and mark house codes. Invite the rep first in JetStream → Users & roles, with the Sales rep role.
export default async function RepPerformance({ searchParams }: PageProps<'/sales/reps'>) {
  const me = await getMe();
  if (!me.apps.includes('sales')) notFound();
  if (me.role === 'sales_rep') redirect('/sales/rep');
  const sp = await searchParams;
  const duties = withDuties(sp);
  const msg = pick(sp.msg);
  const canEdit = ['owner', 'management', 'admin'].includes(me.role);
  const supabase = await createClient();
  const [{ accounts, weekly, asOf, mondays, error }, { data: repData }, { data: people }] = await Promise.all([
    loadSales(supabase, duties),
    supabase.from('sales_reps').select('code, name, branch_code, is_house, profile_id, active').order('name'),
    supabase.from('profiles').select('id, full_name, email, role').in('role', ['sales_rep', 'management', 'owner']).eq('active', true).order('full_name'),
  ]);
  const reps = (repData ?? []) as Rep[];
  const summary = new Map(byRep(accounts, weekly, mondays).map((r) => [r.code, r]));
  const users = (people ?? []) as { id: string; full_name: string; email: string; role: string }[];

  return (
    <>
      <SalesHeader title="Rep performance" sub="Each rep's accounts and sales" asOf={asOf} duties={duties} path="/sales/reps" />
      {msg && <div className={`banner ${/^Not /.test(msg) ? 'warn' : ''}`} role="status">{msg}</div>}
      {error && <div className="banner warn">Sales couldn&apos;t be loaded: {error.message}</div>}

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Rep</th><th className="r">Accounts</th><th className="r">Active</th><th className="r">New</th><th className="r">At risk</th><th className="r">Last 4 weeks</th><th className="r">vs 4 before</th><th className="r">13 weeks</th><th>Trend</th>{canEdit && <th>Sign-in · house · in use</th>}</tr></thead>
          <tbody>
            {reps.map((r) => {
              const s = summary.get(r.code);
              const form = `rep-${r.code}`;
              return (
                <tr key={r.code} style={r.active ? undefined : { opacity: 0.6 }}>
                  <td><Link href={{ pathname: '/sales/rep', query: { code: r.code, ...(duties ? { duties: '1' } : {}) } }}><b>{r.name}</b></Link> <span className="hint">{r.code}{r.branch_code ? ` · ${r.branch_code}` : ''}{r.is_house ? ' · house' : ''}</span></td>
                  <td className="r">{s?.accounts ?? 0}</td><td className="r">{s?.active ?? 0}</td><td className="r">{s?.new_accounts || ''}</td><td className="r">{s?.at_risk || ''}</td>
                  <td className="r">{money(s?.sales_4w ?? 0)}</td><td className="r">{pct(change(s?.sales_4w ?? 0, s?.sales_prev_4w ?? 0))}</td><td className="r">{money(s?.sales_13w ?? 0)}</td>
                  <td>{s ? <Sparkline values={s.weeks} mondays={mondays} /> : null}</td>
                  {canEdit && (
                    <td>
                      <form id={form} action={saveRep} className="flex">
                        <input type="hidden" name="code" value={r.code} />
                        <select name="profile" className="f" defaultValue={r.profile_id ?? ''} aria-label={`Sign-in for ${r.code}`} style={{ maxWidth: 170 }}>
                          <option value="">No sign-in</option>
                          {users.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
                        </select>
                        <label className="flex" style={{ gap: 4 }}><input type="checkbox" name="house" defaultChecked={r.is_house} /> House</label>
                        <label className="flex" style={{ gap: 4 }}><input type="checkbox" name="active" defaultChecked={r.active} /> In use</label>
                        <button className="btn sm">Save</button>
                      </form>
                    </td>
                  )}
                </tr>
              );
            })}
            {!reps.length && <tr><td colSpan={10} className="hint">No reps yet. They come across from JetStream with the import.</td></tr>}
          </tbody>
        </table>
      </div>
      {canEdit && <p className="hint mt8">To give a rep their own view, invite them in JetStream → Users &amp; roles with the Sales rep role, then pick them here. They&apos;ll see only the accounts on their code.</p>}
    </>
  );
}

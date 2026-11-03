import { notFound } from 'next/navigation';
import { inviteUser } from '@/app/(apps)/stream/users/actions';
import { InviteLink } from '@/components/InviteLink';
import { UserList, type DirectoryRow } from '@/components/UserList';
import { appLink } from '@/lib/email';
import { ROLE_LABEL } from '@/lib/nav';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';

const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

// Account & users (customer portal): a customer admin invites their own colleagues, makes them admins or users,
// and switches off people who leave. Customer users see who to ask.
export default async function AccountAndUsers({ searchParams }: PageProps<'/portal/account'>) {
  const me = await getMe();
  if (!me.apps.includes('portal')) notFound();
  const sp = await searchParams;
  const msg = pick(sp.msg);
  const invited = pick(sp.invited);
  const supabase = await createClient();
  const isAdmin = me.role === 'customer_admin';
  const [{ data }, { data: account }] = await Promise.all([
    isAdmin ? supabase.rpc('user_directory').order('full_name').limit(500) : Promise.resolve({ data: [] }),
    supabase.from('customers').select('name, account_code, payment_terms_code, payment_terms_days, invoice_recipients').eq('account_code', me.accountCode ?? '').maybeSingle(),
  ]);
  const rows = (data ?? []) as unknown as DirectoryRow[];
  const link = invited ? await appLink(`/login?email=${encodeURIComponent(invited)}`) : '';

  if (!me.customerName) {
    return (
      <>
        <div className="top"><div><h1>Account &amp; users</h1><div className="sub">Customer portal</div></div></div>
        <div className="card"><p className="hint">You&apos;re signed in as Jet staff. Customers&apos; portal users are managed in JetStream → Users &amp; roles → Customer portal users.</p></div>
      </>
    );
  }

  return (
    <>
      <div className="top">
        <div><h1>Account &amp; users</h1><div className="sub">{me.customerName} · account {me.accountCode}</div></div>
      </div>
      {msg && <div className={`banner ${/^Not /.test(msg) ? 'warn' : ''}`} role="status">{msg}</div>}
      {link && <InviteLink link={link} />}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <div className="card kpi"><div className="l">Your access</div><div className="v">{ROLE_LABEL[me.role]}</div><div className="d">{me.email}</div></div>
        <div className="card kpi"><div className="l">Payment terms</div><div className="v">{account?.payment_terms_code ?? (account?.payment_terms_days != null ? `${account.payment_terms_days} days` : '—')}</div></div>
        <div className="card kpi"><div className="l">Invoices are emailed to</div><div className="v" style={{ fontSize: 14, wordBreak: 'break-all' }}>{account?.invoice_recipients || '—'}</div><div className="d">To change this, contact Jet Worldwide</div></div>
      </div>

      {isAdmin ? (
        <div className="grid mt" style={{ gridTemplateColumns: 'minmax(260px, 320px) 1fr', alignItems: 'start' }}>
          <div className="card">
            <h3>Add a colleague</h3>
            <p className="hint">They sign in with their email address: no password.</p>
            <form action={inviteUser} className="form mt8">
              <input type="hidden" name="from" value="portal" />
              <div><label htmlFor="a-name">Name</label><input id="a-name" name="full_name" required /></div>
              <div><label htmlFor="a-email">Email</label><input id="a-email" name="email" type="email" required /></div>
              <div>
                <label htmlFor="a-role">Access</label>
                <select id="a-role" name="role" className="f" defaultValue="customer_user">
                  <option value="customer_user">{ROLE_LABEL.customer_user}: shipments and invoices</option>
                  <option value="customer_admin">{ROLE_LABEL.customer_admin}: also manages users</option>
                </select>
              </div>
              <div><button className="btn primary">Invite</button></div>
            </form>
          </div>
          <UserList rows={rows} roles={['customer_admin', 'customer_user']} from="portal" showAccount={false} />
        </div>
      ) : (
        <div className="card mt"><p className="hint">To add or remove colleagues, ask your company&apos;s portal admin, or contact Jet Worldwide.</p></div>
      )}
    </>
  );
}

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { InviteLink } from '@/components/InviteLink';
import { UserList, type DirectoryRow } from '@/components/UserList';
import { appLink } from '@/lib/email';
import { ROLE_LABEL, type Role } from '@/lib/nav';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { inviteUser } from './actions';

const MANAGERS: Role[] = ['owner', 'management', 'admin'];
const STAFF_ROLES: Role[] = ['owner', 'management', 'finance', 'customer_service', 'sales_rep', 'admin'];
const PORTAL_ROLES: Role[] = ['customer_admin', 'customer_user'];
const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

// Users & roles: invite Jet staff and customers' portal users, change roles and branches, switch people off.
// Management can't give the owner or admin role; nobody changes their own access. Every change is in the audit log.
export default async function UsersAndRoles({ searchParams }: PageProps<'/stream/users'>) {
  const me = await getMe();
  if (!me.apps.includes('stream') || !MANAGERS.includes(me.role)) notFound();
  const sp = await searchParams;
  const view = pick(sp.view) === 'portal' ? 'portal' : 'staff';
  const msg = pick(sp.msg);
  const invited = pick(sp.invited);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('user_directory').order('full_name').limit(2000);
  const all = (data ?? []) as unknown as DirectoryRow[];
  const rows = all.filter((u) => (view === 'portal') === u.role.startsWith('customer_'));
  const canGive = (me.role === 'management' ? STAFF_ROLES.filter((r) => r !== 'owner' && r !== 'admin') : STAFF_ROLES).concat(PORTAL_ROLES);
  const link = invited ? await appLink(`/login?email=${encodeURIComponent(invited)}`) : '';
  const count = (portal: boolean) => all.filter((u) => portal === u.role.startsWith('customer_')).length;

  return (
    <>
      <div className="top">
        <div><h1>Users &amp; roles</h1><div className="sub">Invite people, set what they can do, switch off people who leave · every change is in the audit log</div></div>
      </div>
      {msg && <div className={`banner ${/^Not /.test(msg) ? 'warn' : ''}`} role="status">{msg}</div>}
      {link && <InviteLink link={link} />}
      {error && <div className="banner warn">Couldn&apos;t load users: {error.message}</div>}

      <div className="grid" style={{ gridTemplateColumns: 'minmax(260px, 340px) 1fr', alignItems: 'start' }}>
        <div className="card">
          <h3>Invite someone</h3>
          <p className="hint">They sign in with their email address: no password. Their access starts the first time they sign in.</p>
          <form action={inviteUser} className="form mt8">
            <input type="hidden" name="from" value="stream" />
            <div><label htmlFor="i-name">Name</label><input id="i-name" name="full_name" required /></div>
            <div><label htmlFor="i-email">Email</label><input id="i-email" name="email" type="email" required /></div>
            <div>
              <label htmlFor="i-role">Role</label>
              <select id="i-role" name="role" className="f" defaultValue={view === 'portal' ? 'customer_admin' : 'finance'}>
                <optgroup label="Jet staff">{canGive.filter((r) => !r.startsWith('customer_')).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</optgroup>
                <optgroup label="Customer portal">{PORTAL_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</optgroup>
              </select>
            </div>
            <div><label htmlFor="i-branch">Branch (Jet staff)</label><select id="i-branch" name="branch" className="f"><option value="AU">Sydney</option><option value="NZ">Auckland</option></select></div>
            <div><label htmlFor="i-acct">Customer account (portal users)</label><input id="i-acct" name="account" placeholder="Account code" /></div>
            <div><button className="btn primary">Invite</button></div>
          </form>
          <p className="hint mt8">
            <b>Roles:</b> Management approves credit notes over the limit and manages users. Finance runs invoicing and credits. Customer service
            sees billing but can&apos;t change prices. Sales reps see only their own accounts in JetSales. A customer admin manages their own company&apos;s portal users.
          </p>
        </div>

        <div>
          <div className="flex" style={{ marginBottom: 10 }}>
            <Link className={`btn sm ${view === 'staff' ? 'primary' : ''}`} href="/stream/users">Jet staff ({count(false)})</Link>
            <Link className={`btn sm ${view === 'portal' ? 'primary' : ''}`} href="/stream/users?view=portal">Customer portal users ({count(true)})</Link>
          </div>
          <UserList rows={rows} roles={canGive} from="stream" showAccount={view === 'portal'} />
        </div>
      </div>
    </>
  );
}

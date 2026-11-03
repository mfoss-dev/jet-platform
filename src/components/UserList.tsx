import { cancelInvite, updateUser } from '@/app/(apps)/stream/users/actions';
import { dayTime } from '@/lib/format';
import { ROLE_LABEL, type Role } from '@/lib/nav';

export type DirectoryRow = {
  id: string | null; email: string; full_name: string; role: Role; branch_code: string | null; customer_id: string | null; account_code: string | null;
  customer_name: string | null; active: boolean; pending: boolean; last_sign_in_at: string | null; created_at: string; can_change: boolean;
};

const BRANCH: Record<string, string> = { AU: 'Sydney', NZ: 'Auckland' };

// The people list on Users & roles and on the portal's Account & users. Each row edits in place (role, branch,
// access); pending invites can be cancelled. Rows the viewer may not change are read-only.
export function UserList({ rows, roles, from, showAccount }: { rows: DirectoryRow[]; roles: Role[]; from: 'stream' | 'portal'; showAccount: boolean }) {
  const staff = (r: Role) => !r.startsWith('customer_');
  return (
    <div className="card" style={{ padding: 0 }}>
      <table>
        <thead><tr><th>Name</th><th>Role</th>{showAccount ? <th>Account</th> : <th>Branch</th>}<th>Last sign-in</th><th>Access</th><th /></tr></thead>
        <tbody>
          {rows.map((u) => {
            const choices = roles.filter((r) => staff(r) === staff(u.role));
            const editable = u.can_change && !u.pending;
            const form = `u-${u.id ?? u.email}`;
            return (
              <tr key={u.id ?? `invite-${u.email}`}>
                <td><b>{u.full_name || '—'}</b><div className="hint">{u.email}</div></td>
                <td>
                  {editable ? (
                    <select form={form} name="role" className="f" defaultValue={u.role} aria-label={`Role for ${u.email}`}>
                      {(choices.includes(u.role) ? choices : [u.role, ...choices]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                    </select>
                  ) : ROLE_LABEL[u.role]}
                </td>
                {showAccount
                  ? <td>{u.customer_name ? <>{u.customer_name} <span className="hint">{u.account_code}</span></> : '—'}</td>
                  : <td>{editable && staff(u.role) ? (
                    <select form={form} name="branch" className="f" defaultValue={u.branch_code ?? 'AU'} aria-label={`Branch for ${u.email}`}>
                      <option value="AU">Sydney</option><option value="NZ">Auckland</option>
                    </select>
                  ) : (u.branch_code ? BRANCH[u.branch_code] : '—')}</td>}
                <td>{u.pending ? <span className="hint">Invited {dayTime(u.created_at)}</span> : u.last_sign_in_at ? dayTime(u.last_sign_in_at) : <span className="hint">Never</span>}</td>
                <td>
                  {u.pending ? <span className="pill warn">Invited</span>
                    : editable ? <label className="flex" style={{ gap: 6 }}><input form={form} type="checkbox" name="active" defaultChecked={u.active} /> {u.active ? 'On' : 'Off'}</label>
                      : <span className={`pill ${u.active ? 'ok' : 'bad'}`}>{u.active ? 'On' : 'Off'}</span>}
                </td>
                <td>
                  {editable && (
                    <form id={form} action={updateUser}>
                      <input type="hidden" name="from" value={from} /><input type="hidden" name="id" value={u.id ?? ''} />
                      <input type="hidden" name="full_name" value={u.full_name} />
                      {!staff(u.role) && <input type="hidden" name="branch" value="" />}
                      <button className="btn sm">Save</button>
                    </form>
                  )}
                  {u.pending && u.can_change && (
                    <form action={cancelInvite}>
                      <input type="hidden" name="from" value={from} /><input type="hidden" name="email" value={u.email} />
                      <button className="btn sm ghost">Cancel invite</button>
                    </form>
                  )}
                </td>
              </tr>
            );
          })}
          {!rows.length && <tr><td colSpan={6} className="hint">Nobody here yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

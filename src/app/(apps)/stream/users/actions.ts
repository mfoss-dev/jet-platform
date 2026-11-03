'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { appLink, sendEmail } from '@/lib/email';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';

// Shared by Users & roles (Jet) and Account & users (customer admins): the database decides who may do what.
const back = (path: string, msg: string, extra = ''): never => redirect(`${path}?msg=${encodeURIComponent(msg)}${extra}`);
const where = (formData: FormData) => (String(formData.get('from')) === 'portal' ? '/portal/account' : '/stream/users');

export async function inviteUser(formData: FormData) {
  const path = where(formData);
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const name = String(formData.get('full_name') ?? '').trim();
  const role = String(formData.get('role') ?? '');
  const branch = String(formData.get('branch') ?? '') || null;
  const supabase = await createClient();
  const me = await getMe();
  let customer: string | null = null;
  if (path === '/portal/account') {
    const { data } = await supabase.from('customers').select('id').eq('account_code', me.accountCode ?? '').maybeSingle();
    customer = data?.id ?? null;
  } else if (role.startsWith('customer_')) {
    const code = String(formData.get('account') ?? '').trim().toUpperCase();
    const { data } = await supabase.from('customers').select('id').eq('account_code', code).maybeSingle();
    if (!data) back(path, `Not invited: no account ${code || '(none entered)'}.`);
    customer = data!.id;
  }
  const { error } = await supabase.rpc('invite_user', { p_email: email, p_full_name: name, p_role: role, p_branch: branch, p_customer: customer });
  revalidatePath(path);
  if (error) back(path, `Not invited: ${error.message}`);
  const link = await appLink(`/login?email=${encodeURIComponent(email)}`);
  const sent = await sendEmail({
    to: [email],
    subject: 'Your Jet Worldwide sign-in',
    text: [`Hi ${name},`, '', `${me.name || 'Jet Worldwide'} has given you access to the Jet Worldwide platform.`, '',
      `Sign in here with this email address (${email}); we email you a one-time link, so there is no password to remember:`, link].join('\n'),
  });
  back(path, `${name} invited · logged.${sent ? ' They have been emailed a link.' : ''}`, `&invited=${encodeURIComponent(email)}`);
}

export async function updateUser(formData: FormData) {
  const path = where(formData);
  const supabase = await createClient();
  const { error } = await supabase.rpc('update_user', {
    p_id: String(formData.get('id')), p_full_name: String(formData.get('full_name') ?? ''), p_role: String(formData.get('role')),
    p_branch: String(formData.get('branch') ?? '') || null, p_active: formData.get('active') === 'on',
  });
  revalidatePath(path);
  if (error) back(path, `Not saved: ${error.message}`);
  back(path, 'Saved · logged');
}

export async function cancelInvite(formData: FormData) {
  const path = where(formData);
  const supabase = await createClient();
  const { error } = await supabase.rpc('cancel_invite', { p_email: String(formData.get('email')) });
  revalidatePath(path);
  if (error) back(path, `Not cancelled: ${error.message}`);
  back(path, 'Invite cancelled · logged');
}

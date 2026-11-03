'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

const back = (path: string, msg: string): never => redirect(`${path}${path.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}`);

// Move ticked accounts to another rep (management only; the database checks).
export async function moveAccounts(formData: FormData) {
  const from = String(formData.get('from') ?? '');
  const to = String(formData.get('to') ?? '');
  const ids = formData.getAll('account').map(String).filter(Boolean);
  const path = `/sales/rep?code=${encodeURIComponent(from)}`;
  if (!ids.length) back(path, 'Not moved: tick the accounts to move.');
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('assign_sales_rep', { p_customers: ids, p_code: to });
  revalidatePath('/sales');
  if (error) back(path, `Not moved: ${error.message}`);
  back(path, `${data} account${data === 1 ? '' : 's'} moved to ${to} · logged`);
}

// Link a rep code to the rep's sign-in, or mark it as house accounts.
export async function saveRep(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.rpc('set_sales_rep', {
    p_code: String(formData.get('code')), p_profile: String(formData.get('profile') ?? '') || null,
    p_is_house: formData.get('house') === 'on', p_active: formData.get('active') === 'on',
  });
  revalidatePath('/sales');
  if (error) back('/sales/reps', `Not saved: ${error.message}`);
  back('/sales/reps', 'Saved · logged');
}

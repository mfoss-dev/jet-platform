import { cache } from 'react';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { SELECTS } from '@/lib/selects';
import { ROLE_APPS, type AppKey, type Role } from '@/lib/nav';

export type Me = {
  id: string;
  email: string;
  name: string;
  role: Role;
  apps: AppKey[];
  customerName: string | null;
  accountCode: string | null;
};

// The signed-in person's profile, once per request. Sends signed-out visitors to /login.
export const getMe = cache(async (): Promise<Me> => {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const id = claims?.claims?.sub;
  if (!id) redirect('/login');

  const { data: p, error } = await supabase
    .from(SELECTS.profile.table)
    // Named foreign key in SELECTS: customers also links to profiles through rep_id, so "customers" alone is ambiguous.
    .select(SELECTS.profile.select)
    .eq('id', id)
    .maybeSingle();
  // A failed read must not quietly turn staff into customers. No row at all (uninvited) still means no access.
  if (error) throw new Error(`Couldn't load your profile: ${error.message}`);

  const role = (p?.active ? p.role : 'customer_user') as Role;
  const customer = Array.isArray(p?.customer) ? p.customer[0] : p?.customer;
  return {
    id,
    email: p?.email ?? String(claims?.claims?.email ?? ''),
    name: p?.full_name ?? '',
    role,
    apps: ROLE_APPS[role],
    customerName: customer?.name ?? null,
    accountCode: customer?.account_code ?? null,
  };
});

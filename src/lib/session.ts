import { cache } from 'react';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
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

  const { data: p } = await supabase
    .from('profiles')
    .select('email, full_name, role, active, customer:customers(name, account_code)')
    .eq('id', id)
    .maybeSingle();

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

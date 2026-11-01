import { SideMenu } from '@/components/SideMenu';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';

// Reads the session (cookies), so it renders per request. Streaming behind <Suspense> can come later
// (see node_modules/next/dist/docs/01-app/02-guides/authentication-with-cache-components.md).
export const instant = false;

export default async function AppsLayout({ children }: LayoutProps<'/'>) {
  const me = await getMe();
  const supabase = await createClient();

  // Menu counts. Row-level security means each person only counts what they can see.
  const badges: Record<string, number> = {};
  if (me.apps.includes('stream')) {
    const [{ count: feed }, { count: reweighs }] = await Promise.all([
      supabase.from('job_list').select('id', { count: 'exact', head: true }).eq('billing_status', 'needs_attention'),
      supabase.from('reweighs').select('id', { count: 'exact', head: true }).eq('decision', 'pending'),
    ]);
    badges['stream/feed'] = feed ?? 0;
    badges['stream/reweighs'] = reweighs ?? 0;
  }

  return (
    <SideMenu
      apps={me.apps}
      role={me.role}
      name={me.name}
      email={me.email}
      customerName={me.customerName}
      accountCode={me.accountCode}
      badges={badges}
    >
      {children}
    </SideMenu>
  );
}

import { redirect } from 'next/navigation';
import { homeFor } from '@/lib/nav';
import { getMe } from '@/lib/session';

// Reads the session (cookies), so it renders per request. Streaming behind <Suspense> can come later
// (see node_modules/next/dist/docs/01-app/02-guides/authentication-with-cache-components.md).
export const instant = false;

export default async function Home() {
  const me = await getMe();
  redirect(homeFor(me.role));
}

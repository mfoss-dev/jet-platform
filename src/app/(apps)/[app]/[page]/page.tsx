import { notFound } from 'next/navigation';
import { APPS, findItem, isAppKey } from '@/lib/nav';
import { getMe } from '@/lib/session';

// Every menu item that isn't connected to the database yet lands here.
export default async function NotYetConnected({ params }: PageProps<'/[app]/[page]'>) {
  const { app, page } = await params;
  const me = await getMe();
  if (!isAppKey(app) || !me.apps.includes(app)) notFound();
  const item = findItem(app, page);
  if (!item) notFound();

  return (
    <>
      <div className="top"><div><h1>{item.label}</h1><div className="sub">{APPS[app].name}</div></div></div>
      <div className="card">
        <h3>Not connected yet</h3>
        <p className="hint">
          This screen is designed (see the wireframe and the clickable prototype) but isn&apos;t wired to the database yet.
          Billing screens come first, in the order of the Phase 1 plan.
        </p>
      </div>
    </>
  );
}

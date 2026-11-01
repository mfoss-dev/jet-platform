'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { APPS, ROLE_LABEL, type AppKey, type Role } from '@/lib/nav';
import { Icon } from './Icon';

type Props = {
  apps: AppKey[];
  role: Role;
  name: string;
  email: string;
  customerName?: string | null;
  accountCode?: string | null;
  badges: Record<string, number>; // 'stream/feed' -> 7
  children: React.ReactNode;
};

const MOBILE = '(max-width:1000px)';
const subscribeMobile = (cb: () => void) => {
  const m = matchMedia(MOBILE);
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
};

// "Menu hidden" lives in localStorage so it's remembered per person and device.
const HIDDEN_KEY = 'jet-menu-hidden';
const subscribeHidden = (cb: () => void) => {
  addEventListener('storage', cb);
  addEventListener(HIDDEN_KEY, cb);
  return () => { removeEventListener('storage', cb); removeEventListener(HIDDEN_KEY, cb); };
};
function readHidden() {
  try { return localStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; }
}
function writeHidden(h: boolean) {
  try { localStorage.setItem(HIDDEN_KEY, h ? '1' : '0'); } catch { /* private window: not remembered */ }
  dispatchEvent(new Event(HIDDEN_KEY));
}

export function SideMenu({ apps, role, name, email, customerName, accountCode, badges, children }: Props) {
  const path = usePathname();
  const [, appSeg = apps[0], pageSeg] = path.split('/');
  const app = (apps.includes(appSeg as AppKey) ? appSeg : apps[0]) as AppKey;
  const multi = apps.length > 1;

  const mobile = useSyncExternalStore(subscribeMobile, () => matchMedia(MOBILE).matches, () => false);
  const hiddenPref = useSyncExternalStore(subscribeHidden, readHidden, () => false);
  const hidden = hiddenPref && !mobile;
  // The drawer and profile menu remember which page they were opened on, so moving to another page closes them.
  const [drawerOn, setDrawerOn] = useState<string | null>(null);
  const [profileOn, setProfileOn] = useState<string | null>(null);
  const drawer = drawerOn === path;
  const profileOpen = profileOn === path;
  const setDrawer = (open: boolean) => setDrawerOn(open ? path : null);
  const setProfileOpen = (open: boolean) => setProfileOn(open ? path : null);
  const [folded, setFolded] = useState<Set<string>>(new Set());

  const toggleMenu = () => (mobile ? setDrawer(!drawer) : writeHidden(!hiddenPref));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input,select,textarea')) return;
      if (e.key === '[') toggleMenu();
      if (e.key === 'Escape') { setDrawer(false); setProfileOpen(false); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const appHasBadge = (a: AppKey) => Object.entries(badges).some(([k, n]) => k.startsWith(a + '/') && n > 0);
  const initials = name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase() || email[0]?.toUpperCase();
  const firstPage = (a: AppKey) => `/${a}/${APPS[a].groups[0][1][0].key}`;

  const profileMenu = profileOpen && (
    <div className="pop" style={{ left: multi ? 72 : 16, bottom: 16 }} onClick={(e) => e.stopPropagation()}>
      <b>{name || email}</b>
      <small>{ROLE_LABEL[role]} · {email}</small>
      <label>Theme</label>
      <select
        defaultValue={typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') ?? '' : ''}
        onChange={(e) => {
          const v = e.target.value;
          if (v) document.documentElement.setAttribute('data-theme', v); else document.documentElement.removeAttribute('data-theme');
          try { localStorage.setItem('jet-theme', v); } catch { /* not remembered */ }
        }}
      >
        <option value="">System</option><option value="light">Light</option><option value="dark">Dark</option>
      </select>
      <form className="row" action="/auth/signout" method="post">
        <button className="btn sm">Sign out</button>
        <span className="hint">Test environment</span>
      </form>
    </div>
  );

  return (
    <div
      className={`app ${multi ? 'multi' : 'solo'} ${hidden ? 'hid' : ''} ${drawer && mobile ? 'drawer' : ''}`}
      onClick={() => profileOpen && setProfileOpen(false)}
    >
      <div className="scrim" onClick={() => setDrawer(false)} />
      <aside>
        {multi && (
          <div className="rail">
            <div className="logo" title="Jet Platform"><i>J</i></div>
            {apps.map((a) => (
              a === app
                ? <button key={a} className="rbtn on" title={APPS[a].name} onClick={toggleMenu}>
                    <Icon name={APPS[a].icon} />{APPS[a].short}{appHasBadge(a) && <span className="dot" />}
                  </button>
                : <Link key={a} className="rbtn" title={APPS[a].name} href={firstPage(a)} onClick={() => hiddenPref && toggleMenu()}>
                    <Icon name={APPS[a].icon} />{APPS[a].short}{appHasBadge(a) && <span className="dot" />}
                  </Link>
            ))}
            <div className="sp" />
            <button className="rbtn" title={`${name} · ${ROLE_LABEL[role]}`} onClick={(e) => { e.stopPropagation(); setProfileOpen(!profileOpen); }}>
              <span className="av">{initials}</span>
            </button>
          </div>
        )}
        <div className="panel">
          <div className="in">
            <div className="phead">
              {multi ? <span>{APPS[app].name}</span> : <div className="logo"><i>J</i><span className="lbl">Jet Platform</span></div>}
              <button className="ibtn" title={`${hidden ? 'Show' : 'Hide'} menu  [`} onClick={mobile ? () => setDrawer(false) : toggleMenu}>
                <Icon name={mobile ? 'x' : 'chevL'} />
              </button>
            </div>
            {app === 'portal' && customerName && (
              <div className="acct"><b>{customerName}</b><small>Account {accountCode}</small></div>
            )}
            <nav className="nav">
              {APPS[app].groups.map(([group, items]) => {
                const isFolded = folded.has(app + group) && !hidden;
                return (
                  <div key={group}>
                    <button
                      className={`grp ${isFolded ? 'folded' : ''}`}
                      onClick={() => setFolded((f) => { const n = new Set(f); if (n.has(app + group)) n.delete(app + group); else n.add(app + group); return n; })}
                    >
                      <span>{group}</span><Icon name="chevD" />
                    </button>
                    {items.filter((i) => !isFolded || i.key === pageSeg).map((i) => {
                      const n = badges[`${app}/${i.key}`];
                      return (
                        <Link key={i.key} href={`/${app}/${i.key}`} className={i.key === pageSeg ? 'on' : ''} title={i.label}>
                          <Icon name={i.icon} /><span className="lbl">{i.label}</span>
                          {n ? <span className="badge">{n}</span> : null}
                        </Link>
                      );
                    })}
                  </div>
                );
              })}
            </nav>
            {!multi && (
              <div className="me">
                <span className="av">{initials}</span>
                <div className="lbl" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {name || email}<small>{ROLE_LABEL[role]}</small>
                </div>
                <button className="ibtn lbl" title="Profile and settings" onClick={(e) => { e.stopPropagation(); setProfileOpen(!profileOpen); }}>
                  <Icon name="gear" />
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>
      <main className={hidden && multi ? 'withshow' : ''}>
        <div className="mbar">
          <button className="ibtn" title="Menu" onClick={() => setDrawer(true)}><Icon name="menu" /></button>
          <div className="logo"><i>J</i>{APPS[app].name}</div>
        </div>
        {hidden && multi && <button className="showmenu" title="Show menu  [" onClick={toggleMenu}><Icon name="menu" /></button>}
        {children}
      </main>
      {profileMenu}
    </div>
  );
}

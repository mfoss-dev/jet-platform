// Side menu structure (option B from the wireframes: app rail + grouped menu panel).
// Keys match the prototype's routes, so /stream/feed here is #stream/feed there.

export type AppKey = 'portal' | 'stream' | 'sales' | 'auto';
export type Role =
  | 'owner' | 'management' | 'finance' | 'customer_service' | 'sales_rep' | 'admin' | 'customer_admin' | 'customer_user';

export type NavItem = { key: string; label: string; icon: IconName; live?: boolean };
export type IconName =
  | 'home' | 'list' | 'monitor' | 'scale' | 'inbox' | 'claim' | 'play' | 'doc' | 'export' | 'users' | 'user' | 'fuel' | 'shield'
  | 'clock' | 'box' | 'chart' | 'spark' | 'plus' | 'pin' | 'truck' | 'dollar' | 'chat' | 'check' | 'mail' | 'book' | 'pulse'
  | 'plug' | 'gear' | 'chevL' | 'chevD' | 'menu' | 'x';

export const APPS: Record<AppKey, { name: string; short: string; icon: IconName; groups: [string, NavItem[]][] }> = {
  portal: {
    name: 'Customer portal', short: 'Portal', icon: 'box',
    groups: [
      ['Shipping', [{ key: 'dash', label: 'Dashboard', icon: 'home' }, { key: 'ship', label: 'New shipment', icon: 'plus' },
        { key: 'list', label: 'My shipments', icon: 'box' }, { key: 'track', label: 'Track', icon: 'pin' }, { key: 'pickup', label: 'Book pickup', icon: 'truck' }]],
      ['Account', [{ key: 'addr', label: 'Address book', icon: 'book' }, { key: 'inv', label: 'Invoices', icon: 'dollar' },
        { key: 'ask', label: 'Ask about my account', icon: 'chat' }, { key: 'ai', label: 'AI assistant', icon: 'plug' },
        { key: 'account', label: 'Account & users', icon: 'gear' }]],
    ],
  },
  stream: {
    name: 'JetStream', short: 'Stream', icon: 'list',
    groups: [
      ['Daily work', [{ key: 'today', label: 'Today', icon: 'home' }, { key: 'feed', label: 'Billing feed', icon: 'list', live: true },
        { key: 'monitor', label: 'Shipment monitor', icon: 'monitor' }]],
      ['Carriers', [{ key: 'reweighs', label: 'Reweighs', icon: 'scale', live: true }, { key: 'cinv', label: 'Carrier invoices', icon: 'inbox' },
        { key: 'claims', label: 'Credit claims', icon: 'claim' }]],
      ['Billing', [{ key: 'run', label: 'Invoice run', icon: 'play', live: true }, { key: 'invoices', label: 'Invoices & credits', icon: 'doc', live: true },
        { key: 'exports', label: 'Accounting exports', icon: 'export' }]],
      ['Customers & pricing', [{ key: 'customers', label: 'Customers', icon: 'users', live: true }, { key: 'tariffs', label: 'Tariffs & fuel', icon: 'fuel', live: true }]],
      ['Admin', [{ key: 'users', label: 'Users & roles', icon: 'shield' }, { key: 'audit', label: 'Audit log', icon: 'clock', live: true }]],
    ],
  },
  sales: {
    name: 'JetSales', short: 'Sales', icon: 'chart',
    groups: [
      ['Performance', [{ key: 'overview', label: 'Overview', icon: 'chart' }, { key: 'reps', label: 'Rep performance', icon: 'users' },
        { key: 'rep', label: 'Rep detail', icon: 'user' }, { key: 'health', label: 'Account health', icon: 'pulse' }]],
      ['Commission', [{ key: 'comm', label: 'Commission', icon: 'dollar' }, { key: 'plans', label: 'Plans & accounts', icon: 'doc' },
        { key: 'email', label: 'Rep weekly email', icon: 'mail' }]],
      ['Ask', [{ key: 'ask', label: 'Ask the business', icon: 'chat' }]],
    ],
  },
  auto: {
    name: 'Auto & AI', short: 'Auto', icon: 'spark',
    groups: [
      ['Automations', [{ key: 'approvals', label: 'Waiting for approval', icon: 'check' }, { key: 'autos', label: 'Automations', icon: 'spark' }]],
      ['AI (MCP)', [{ key: 'access', label: 'AI access (MCP)', icon: 'shield' }, { key: 'tools', label: 'MCP tools & permissions', icon: 'gear' },
        { key: 'activity', label: 'AI activity', icon: 'clock' }, { key: 'connect', label: 'My AI connection', icon: 'plug' }]],
    ],
  },
};

// Same as the roles matrix wireframe: which apps each role gets on the rail.
export const ROLE_APPS: Record<Role, AppKey[]> = {
  owner: ['portal', 'stream', 'sales', 'auto'],
  management: ['portal', 'stream', 'sales', 'auto'],
  admin: ['portal', 'stream', 'sales', 'auto'],
  finance: ['stream', 'auto'],
  customer_service: ['stream', 'auto'],
  sales_rep: ['sales'],
  customer_admin: ['portal'],
  customer_user: ['portal'],
};

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner', management: 'Management', admin: 'Admin', finance: 'Finance', customer_service: 'Customer service',
  sales_rep: 'Sales rep', customer_admin: 'Customer admin', customer_user: 'Customer',
};

export const findItem = (app: AppKey, key: string) =>
  APPS[app].groups.flatMap(([, items]) => items).find((i) => i.key === key);

export const isAppKey = (k: string): k is AppKey => k in APPS;

const liveItem = (app: AppKey) => APPS[app].groups.flatMap(([, i]) => i).find((i) => i.live);

// Where an app opens: its first connected screen, otherwise its first menu item.
export const appStart = (app: AppKey) => `/${app}/${(liveItem(app) ?? APPS[app].groups[0][1][0]).key}`;

// After sign-in: the first of the person's apps that has a connected screen (staff land on the billing feed).
export function homeFor(role: Role) {
  const apps = ROLE_APPS[role];
  return appStart(apps.find((a) => liveItem(a)) ?? apps[0]);
}

// Checks every query in src/lib/selects.ts against the real Test project's API, signed out.
// Signed out, a correct query is refused with "permission denied" (42501); a broken one (unknown column,
// ambiguous or missing relationship, missing table) comes back with a query error instead.
// Run after migrations are deployed: npm run test:api
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SELECTS } from '../../src/lib/selects.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = Object.fromEntries(
  readFileSync(join(root, '.env.local'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => l.trim().split(/=(.*)/s).slice(0, 2)),
);
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

console.log(`API query checks against ${new URL(url).host}:`);
let failed = 0;
for (const [name, { table, select }] of Object.entries(SELECTS)) {
  const res = await fetch(`${url}/rest/v1/${table}?select=${encodeURIComponent(select.replace(/\s+/g, ''))}&limit=1`, { headers: { apikey: key } });
  const body = await res.json().catch(() => ({}));
  const ok = body.code === '42501' || res.status === 401;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n    ${body.code ?? res.status}: ${body.message ?? JSON.stringify(body).slice(0, 200)}`}`);
}
process.exitCode = failed ? 1 : 0;

// Proves the imported tariffs price like JetStream: re-prices JetStream's billed jobs (Billing table) with the new
// price_shipment() in the linked project and compares with what JetStream charged.
//
//   node scripts/jetstream-import/validate.mjs [--from 20260101]
//
// Only automatically rated jobs (HandRated = N) on imported services, shipped on or after --from (default: the
// start of the imported rate cards' validity). Writes out/validation.csv (real data, git-ignored) and prints a summary.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const SQLCMD = process.env.SQLCMD ?? 'C:/Program Files/SqlCmd/sqlcmd.exe';
const SERVER = process.env.JETSTREAM_SERVER ?? 'lpc:localhost';
const from = process.argv.includes('--from') ? process.argv[process.argv.indexOf('--from') + 1] : '20260101';
const SERVICES = ['INTOUTEXP', 'INTINBEXP', 'DOMESTEXP', 'DOMESTROAD', 'DOMESTASAP'];

const raw = execFileSync(SQLCMD, ['-S', SERVER, '-E', '-C', '-d', 'JetStream', '-h', '-1', '-y', '0', '-Q',
  // Billing.Charge is freight plus add-ons (fuel, security, surcharges); the freight alone is the ".FREIGHT"
  // transaction line, so that is what the new freight price is compared with.
  `set nocount on; select b.ConnoteNo, b.CustomerCode, b.ServiceCode, b.ShipmentDate, b.ConsignmentType, b.SenderCountryCode, b.SenderPostcode,
   b.ReceiverCountryCode, b.ReceiverPostcode, b.Weight, f.Freight as Charge, b.WeightType from Billing b
   join (select ConnoteNo, sum(Charge) Freight from (select ConnoteNo, Charge, TransactionType from Transactions union all
         select ConnoteNo, Charge, TransactionType from arcTransactions) t where TransactionType = '.FREIGHT' group by ConnoteNo) f on f.ConnoteNo = b.ConnoteNo
   where b.HandRated = 'N' and b.ShipmentDate >= '${from}' and b.ServiceCode in (${SERVICES.map((s) => `'${s}'`).join(',')}) for json path`],
  { maxBuffer: 1 << 28, encoding: 'utf8' });
const jobs = JSON.parse(raw.replace(/\r?\n/g, '').trim() || '[]');
console.log(`${jobs.length} automatically rated jobs since ${from} with a freight line`);
if (!jobs.length) process.exit(0);

const t = (s) => (s ?? '').toString().trim();
const lit = (v) => (v == null ? 'null' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const results = [];
for (let i = 0; i < jobs.length; i += 400) {
  const batch = jobs.slice(i, i + 400);
  const values = batch.map((j) => `(${[t(j.ConnoteNo), t(j.CustomerCode), t(j.ServiceCode), `${t(j.ShipmentDate).slice(0, 4)}-${t(j.ShipmentDate).slice(4, 6)}-${t(j.ShipmentDate).slice(6, 8)}`,
    t(j.ConsignmentType) === 'DOX' ? 'doc' : 'parcel', t(j.SenderCountryCode), t(j.SenderPostcode), t(j.ReceiverCountryCode), t(j.ReceiverPostcode),
    Number(j.Weight), Number(j.Charge)].map(lit).join(', ')})`).join(',\n');
  const sql = `select s.connote, s.service, s.billed, p.price, p.zone_code, p.sales_tariff, p.base_tariff, p.problem
from (values ${values}) as s (connote, account, service, shipped, kind, oc, op, dc, dp, weight, billed)
left join public.customers c on c.account_code = s.account
left join lateral public.price_shipment(c.id, s.service, s.oc, s.op, s.dc, s.dp, s.kind, s.weight, s.shipped::date) p on true;`;
  const file = join(here, 'out', 'validate-batch.sql');
  writeFileSync(file, sql);
  const res = execFileSync('npx', ['supabase', 'db', 'query', '--linked', '-f', 'scripts/jetstream-import/out/validate-batch.sql', '--output-format', 'json'], { cwd: root, encoding: 'utf8', shell: true, maxBuffer: 1 << 28 });
  const json = JSON.parse(res.slice(res.indexOf('{')));
  results.push(...(json.rows ?? []));
  process.stdout.write('.');
}
console.log();

const byService = {};
let exact = 0, close = 0, off = 0, unpriced = 0;
const lines = [['connote', 'service', 'billed', 'new_price', 'difference', 'zone', 'sales_tariff', 'rate_card', 'problem']];
for (const r of results) {
  const s = (byService[r.service] ??= { jobs: 0, exact: 0, close: 0, off: 0, unpriced: 0 });
  s.jobs++;
  const billed = Number(r.billed), price = r.price == null ? null : Number(r.price);
  let diff = null;
  if (price == null) { unpriced++; s.unpriced++; }
  else {
    diff = Math.round((price - billed) * 100) / 100;
    if (Math.abs(diff) <= 0.01) { exact++; s.exact++; } else if (Math.abs(diff) <= Math.max(0.5, billed * 0.01)) { close++; s.close++; } else { off++; s.off++; }
  }
  lines.push([r.connote, r.service, billed, price, diff, r.zone_code, r.sales_tariff, r.base_tariff, r.problem]);
}
writeFileSync(join(here, 'out', 'validation.csv'), lines.map((l) => l.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n'));
const pct = (n) => `${Math.round((n / results.length) * 1000) / 10}%`;
console.log(`Exact (within 1c): ${exact} (${pct(exact)}) · close (within 1% / 50c): ${close} (${pct(close)}) · different: ${off} (${pct(off)}) · not priced: ${unpriced} (${pct(unpriced)})`);
console.table(byService);
const problems = results.filter((r) => r.problem).reduce((a, r) => { a[r.problem] = (a[r.problem] ?? 0) + 1; return a; }, {});
if (Object.keys(problems).length) console.table(problems);
console.log(`Details: ${join(here, 'out', 'validation.csv')}`);

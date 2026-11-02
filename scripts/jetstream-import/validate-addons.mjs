// Proves the imported add-on rules charge like JetStream: for each automatically rated job billed from July 2026
// (when this backup's itemised charge lines start), rebuilds the add-on lines with charge_lines() in the linked project,
// feeding in JetStream's own freight figure, and compares every line (charge, fuel, security, GST) with what was billed.
// Manual codes (starting with "z") are left out on both sides: staff add those by hand.
//
//   node scripts/jetstream-import/validate-addons.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const SQLCMD = process.env.SQLCMD ?? 'C:/Program Files/SqlCmd/sqlcmd.exe';
const SERVER = process.env.JETSTREAM_SERVER ?? 'lpc:localhost';
const q = (sql) => {
  const raw = execFileSync(SQLCMD, ['-S', SERVER, '-E', '-C', '-d', 'JetStream', '-h', '-1', '-y', '0', '-Q', `set nocount on; ${sql} for json path`], { maxBuffer: 1 << 29, encoding: 'utf8' });
  const text = raw.replace(/\r?\n/g, '').trim();
  return text ? JSON.parse(text) : [];
};
const t = (s) => (s ?? '').toString().trim();
const lit = (v) => (v == null ? 'null' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

const lines = q(`select ConnoteNo, TransactionType, Charge, Fuel, Security, GST from
  (select ConnoteNo, TransactionType, Charge, Fuel, Security, GST, InvoiceDate from arcTransactions union all
   select ConnoteNo, TransactionType, Charge, Fuel, Security, GST, InvoiceDate from Transactions) x
  where InvoiceDate >= '20260701' and TransactionType not like 'z%'`);
const connotes = [...new Set(lines.map((l) => t(l.ConnoteNo)))];
const jobs = q(`select b.ConnoteNo, b.CustomerCode, b.ServiceCode, b.ShipmentDate, b.SenderCountryCode, b.SenderPostcode, b.ReceiverCountryCode,
  b.ReceiverPostcode, b.Weight, b.InsuranceValue, b.ServiceLevel, b.FreeDomicile, c.DeclaredValue
  from (select * from arcBilling union all select * from Billing) b left join Consignment c on c.ConnoteNo = b.ConnoteNo
  where b.HandRated = 'N' and b.ShipmentDate >= '20260601'`).filter((j) => connotes.includes(t(j.ConnoteNo)));
const items = q(`select ConnoteNo, Items, DeadWeight, CubicWeight, Length, Width, Height from ConsignmentItems`);
const pieces = {};
for (const i of items) {
  const k = t(i.ConnoteNo);
  for (let n = 0; n < Number(i.Items || 0); n++) {
    (pieces[k] ??= []).push({ weight: Math.max(Number(i.DeadWeight || 0), Number(i.CubicWeight || 0)), max_dim: Math.max(Number(i.Length || 0), Number(i.Width || 0), Number(i.Height || 0)) });
  }
}
const billed = {};
for (const l of lines) (billed[t(l.ConnoteNo)] ??= []).push({ code: t(l.TransactionType), charge: Number(l.Charge), fuel: Number(l.Fuel), security: Number(l.Security), gst: Number(l.GST) });
console.log(`${jobs.length} automatically rated jobs with itemised lines since July 2026`);

const ours = {};
for (let i = 0; i < jobs.length; i += 300) {
  const batch = jobs.slice(i, i + 300);
  const values = batch.map((j) => {
    const freight = (billed[t(j.ConnoteNo)] ?? []).filter((b) => b.code === '.FREIGHT').reduce((a, b) => a + b.charge, 0);
    return `(${[t(j.ConnoteNo), t(j.CustomerCode), t(j.ServiceCode), `${t(j.ShipmentDate).slice(0, 4)}-${t(j.ShipmentDate).slice(4, 6)}-${t(j.ShipmentDate).slice(6, 8)}`,
      freight, Number(j.Weight || 0), t(j.SenderCountryCode), t(j.SenderPostcode), t(j.ReceiverCountryCode), t(j.ReceiverPostcode),
      Number(j.DeclaredValue || 0), Number(j.InsuranceValue || 0)].map(lit).join(', ')}, ${['P', 'PRI'].includes(t(j.ServiceLevel))}, ${['S', 'DTP'].includes(t(j.FreeDomicile))}, ${lit(JSON.stringify(pieces[t(j.ConnoteNo)] ?? []))}::jsonb)`;
  }).join(',\n');
  writeFileSync(join(here, 'out', 'validate-addons-batch.sql'), `select s.connote, l.code, l.charge, l.fuel, l.security, l.gst
from (values ${values}) as s (connote, account, service, shipped, freight, weight, oc, op, dc, dp, declared, insured, priority, dtp, pieces)
join public.customers c on c.account_code = s.account
cross join lateral public.charge_lines(c.id, s.service, s.shipped::date, s.freight, s.weight, s.oc, s.op, s.dc, s.dp, s.declared, s.insured, s.priority, s.dtp, s.pieces) l
where l.code not like 'z%';`);
  const res = execFileSync('npx', ['supabase', 'db', 'query', '--linked', '-f', 'scripts/jetstream-import/out/validate-addons-batch.sql', '--output-format', 'json'],
    { cwd: root, encoding: 'utf8', shell: true, maxBuffer: 1 << 28 });
  for (const r of JSON.parse(res.slice(res.indexOf('{'))).rows ?? []) (ours[r.connote] ??= []).push({ code: r.code, charge: Number(r.charge), fuel: Number(r.fuel), security: Number(r.security), gst: Number(r.gst) });
  process.stdout.write('.');
}
console.log();

// Compare line by line, per code (lines with the same code are summed; zero lines are ignored on both sides).
const near = (a, b) => Math.abs(a - b) < 0.015;
const perCode = {};
let jobsExact = 0;
const out = [['connote', 'code', 'billed_charge', 'our_charge', 'billed_fuel', 'our_fuel', 'billed_security', 'our_security', 'billed_gst', 'our_gst', 'match']];
for (const j of jobs) {
  const k = t(j.ConnoteNo);
  const sum = (ls) => ls.reduce((m, l) => {
    if (!l.charge && !l.fuel && !l.security && !l.gst) return m;
    const s = (m[l.code] ??= { charge: 0, fuel: 0, security: 0, gst: 0 });
    s.charge += l.charge; s.fuel += l.fuel; s.security += l.security; s.gst += l.gst;
    return m;
  }, {});
  const b = sum(billed[k] ?? []), o = sum(ours[k] ?? []);
  let all = true;
  for (const code of new Set([...Object.keys(b), ...Object.keys(o)])) {
    const x = b[code] ?? { charge: 0, fuel: 0, security: 0, gst: 0 }, y = o[code] ?? { charge: 0, fuel: 0, security: 0, gst: 0 };
    const ok = near(x.charge, y.charge) && near(x.fuel, y.fuel) && near(x.security, y.security) && near(x.gst, y.gst);
    const c = (perCode[code] ??= { lines: 0, exact: 0, missing: 0, extra: 0, different: 0 });
    c.lines++;
    if (ok) c.exact++; else if (!o[code]) c.missing++; else if (!b[code]) c.extra++; else c.different++;
    if (!ok) all = false;
    out.push([k, code, x.charge, y.charge, x.fuel, y.fuel, x.security, y.security, x.gst, y.gst, ok]);
  }
  if (all) jobsExact++;
}
writeFileSync(join(here, 'out', 'validation-addons.csv'), out.map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n'));
console.log(`Jobs where every automatic line matches to the cent: ${jobsExact} of ${jobs.length} (${Math.round((jobsExact / jobs.length) * 1000) / 10}%)`);
console.table(Object.fromEntries(Object.entries(perCode).sort((a, b) => b[1].lines - a[1].lines)));
console.log(`Details: ${join(here, 'out', 'validation-addons.csv')}`);

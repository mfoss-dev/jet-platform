// Imports Jet's tariffs, zone guides and customers from a restored JetStream database (SQL Server) into the
// linked Supabase project (Test). Repeatable: each run replaces what the previous run imported.
//
//   node scripts/jetstream-import/import.mjs            # export, write SQL to out/, load into the linked project
//   node scripts/jetstream-import/import.mjs --dry-run  # export and write SQL only
//
// Needs: SQL Server with the JetStream database (JETSTREAM_SERVER, default lpc:localhost), sqlcmd, and
// `npx supabase link` done. Brings across business names, account codes, branch, status and terms only:
// no contacts, emails, phone numbers or addresses. Output in out/ holds real data and is git-ignored.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(here, 'out');
const dryRun = process.argv.includes('--dry-run');
const SQLCMD = process.env.SQLCMD ?? 'C:/Program Files/SqlCmd/sqlcmd.exe';
const SERVER = process.env.JETSTREAM_SERVER ?? 'lpc:localhost';
const TODAY = new Date().toISOString().slice(0, 10).replace(/-/g, '');

// ---------------------------------------------------------------- export from SQL Server
function q(sql) {
  const raw = execFileSync(SQLCMD, ['-S', SERVER, '-E', '-C', '-d', 'JetStream', '-h', '-1', '-y', '0', '-Q', `set nocount on; ${sql} for json path, include_null_values`],
    { maxBuffer: 1 << 30, encoding: 'utf8' });
  const text = raw.replace(/\r?\n/g, '').trim();
  return text ? JSON.parse(text) : [];
}

console.log('Exporting from JetStream…');
const t = (s) => (s ?? '').toString().trim();
const lives = q(`select BranchCode, BaseTariff, Version, ValidFrom, ValidTo, VolumetricDivisor, Description from BaseTariffsLife where CustomerCode = 'z'`);
const masters = q(`select BranchCode, BaseTariff, ServiceCode, ZoneType, Description from BaseTariffMaster`);
const rates = q(`select BranchCode, BaseTariff, Version, ConsignmentType, ZoneCode, ForEach, FromWeight, ToWeight, Minimum, Basic, Charge, Method from BaseTariff`);
const zoneTypes = q(`select BranchCode, SalesZoneTypeCode, SalesZoneTypeName from SalesZoneType`);
const groups = q(`select BranchCode, SalesZoneTypeCode, CountryCode, RangeFrom, RangeTo, SalesZoneGroupCode from SalesZoneGroup`);
const lanes = q(`select BranchCode, CustomerCode, SalesZoneTypeCode, OrigGroup, DestGroup, SalesZoneCode from SalesZone`);
const salesMasters = q(`select BranchCode, ServiceCode, BaseTariff, SalesTariff, Description from SalesTariffMaster`);
const margins = q(`select BranchCode, ServiceCode, SalesTariff, ZoneCode, ConsignmentType, ToWeight, Margin from SalesTariff`);
const customers = q(`select CustomerCode, BranchCode, CustomerName, Status, Active, PaymentTerms from Customer`);
const custTariffs = q(`select BranchCode, CustomerCode, ServiceCode, SalesTariff, EffectiveFrom, EffectiveTo, VolumetricDivisor from CustomersTariff where EffectiveTo >= '20260101'`);
console.log(`  ${rates.length} rates, ${margins.length} margins, ${groups.length} zone groups, ${lanes.length} zone lanes, ${customers.length} customers, ${custTariffs.length} customer tariffs`);

// ---------------------------------------------------------------- transform
const BRANCH = { JETSYD: 'AU', JETAKL: 'NZ' };
const KIND = (c) => (t(c) === 'DOX' ? 'doc' : 'parcel');            // DOX = documents; WPX and DOM = everything else
const CARRIER = (code) => ({ DHL: 'DHL', TNT: 'TNT', FDX: 'FEDEX', AKL: 'DHL', JET: 'JET' })[code.split('.')[0]] ?? 'DHL';
const TERMS = { '7D': 7, '14D': 14, '21D': 21, '30D': 30, '30EOM': 30, '60D': 60, EOM: 30 };
const date = (s) => (t(s).length === 8 ? `${t(s).slice(0, 4)}-${t(s).slice(4, 6)}-${t(s).slice(6, 8)}` : null);
const num = (v) => Number(v ?? 0);
// Same JetStream key always gives the same id, so re-imports replace rows instead of duplicating them.
const uid = (...k) => {
  const h = createHash('sha1').update(['jetstream', ...k].join('|')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const report = [];

// Customers (business details only).
const custRows = customers.filter((c) => BRANCH[t(c.BranchCode)]).map((c) => {
  const st = t(c.Status);
  const status = st === 'H' ? 'on_hold' : st === 'L' || t(c.Active) === 'N' && st !== 'A' ? 'closed' : 'active';
  return {
    id: uid('customer', t(c.CustomerCode)), account_code: t(c.CustomerCode), name: t(c.CustomerName) || t(c.CustomerCode), branch_code: BRANCH[t(c.BranchCode)],
    status, payment_terms_days: TERMS[t(c.PaymentTerms)] ?? 14, payment_terms_code: t(c.PaymentTerms) || null,
    hold_reason: status === 'on_hold' ? 'other' : null, hold_note: status === 'on_hold' ? 'On hold in JetStream at import' : null,
  };
});
const custId = new Map(custRows.map((c) => [c.account_code, c.id]));

// Rate cards: those with a 2026 life and rates. The master may be renamed with a "z" prefix (retired).
const masterFor = (branch, code) => masters.find((m) => t(m.BranchCode) === branch && t(m.BaseTariff) === code)
  ?? masters.find((m) => t(m.BranchCode) === branch && t(m.BaseTariff) === `z${code}`);
const cards = lives.filter((l) => rates.some((r) => t(r.BranchCode) === t(l.BranchCode) && t(r.BaseTariff) === t(l.BaseTariff) && t(r.Version) === t(l.Version))).map((l) => {
  const branch = t(l.BranchCode), code = t(l.BaseTariff), m = masterFor(branch, code);
  if (!m) report.push(`No BaseTariffMaster for ${branch} ${code}: imported without a zone guide`);
  return {
    id: uid('tariff', branch, code), version_id: uid('version', branch, code, t(l.Version)), branch, code, branch_code: BRANCH[branch],
    name: `${code}${m && t(m.Description) ? ` · ${t(m.Description).replace(/\s+/g, ' ')}` : ''}`.slice(0, 200),
    carrier: CARRIER(code), service: m ? t(m.ServiceCode) : null, zoneType: m ? t(m.ZoneType) : null, cost_only: code.includes('.COST.'),
    valid_from: date(l.ValidFrom) ?? '2026-01-01', divisor: num(l.VolumetricDivisor) || (code.includes('DOM') ? 4000 : 5000),
    note: `${t(l.Description)} (JetStream version ${t(l.Version)})`.slice(0, 300), jsVersion: t(l.Version),
  };
});
const cardKey = new Map(cards.map((c) => [`${c.branch}|${c.code}`, c]));

// Zone guides used by those cards (a few cards point at a zone type with no SalesZoneType row; create it anyway).
const zoneSets = [...new Set(cards.filter((c) => c.zoneType).map((c) => `${c.branch}|${c.zoneType}`))].map((k) => {
  const [branch, code] = k.split('|');
  const zt = zoneTypes.find((z) => t(z.BranchCode) === branch && t(z.SalesZoneTypeCode) === code);
  return { id: uid('zoneset', branch, code), branch, code, branch_code: BRANCH[branch], name: zt ? t(zt.SalesZoneTypeName) : code };
});
const zoneSetId = new Map(zoneSets.map((z) => [`${z.branch}|${z.code}`, z.id]));
const groupRows = groups.filter((g) => zoneSetId.has(`${t(g.BranchCode)}|${t(g.SalesZoneTypeCode)}`)).map((g) => ({
  zone_set_id: zoneSetId.get(`${t(g.BranchCode)}|${t(g.SalesZoneTypeCode)}`), country: t(g.CountryCode).toUpperCase(),
  from: num(g.RangeFrom), to: num(g.RangeTo), group: t(g.SalesZoneGroupCode),
}));
const laneMap = new Map();
let laneSkipped = 0;
for (const l of lanes) {
  const zs = zoneSetId.get(`${t(l.BranchCode)}|${t(l.SalesZoneTypeCode)}`);
  if (!zs) continue;
  const cc = t(l.CustomerCode);
  const customer = cc === 'z' ? null : custId.get(cc);
  if (cc !== 'z' && !customer) { laneSkipped++; continue; }
  laneMap.set(`${zs}|${customer}|${t(l.OrigGroup)}|${t(l.DestGroup)}`, { zone_set_id: zs, customer, orig: t(l.OrigGroup), dest: t(l.DestGroup), zone: t(l.SalesZoneCode) });
}
const laneRows = [...laneMap.values()];
if (laneSkipped) report.push(`${laneSkipped} customer zone overrides skipped (customer not in the Customer table)`);

// Rates, keyed like tariff_rates (version, zone, kind, to_kg).
const rateMap = new Map();
let rateDupes = 0;
for (const r of rates) {
  const c = cardKey.get(`${t(r.BranchCode)}|${t(r.BaseTariff)}`);
  if (!c || t(r.Version) !== c.jsVersion) continue;
  const key = `${c.version_id}|${t(r.ZoneCode)}|${KIND(r.ConsignmentType)}|${num(r.ToWeight)}`;
  if (rateMap.has(key)) rateDupes++;
  rateMap.set(key, { version_id: c.version_id, zone: t(r.ZoneCode), kind: KIND(r.ConsignmentType), from: num(r.FromWeight), to: num(r.ToWeight),
    step: num(r.ForEach) || 0.5, method: t(r.Method).toUpperCase(), charge: num(r.Charge), basic: num(r.Basic), minimum: num(r.Minimum) });
}
const rateRows = [...rateMap.values()];
if (rateDupes) report.push(`${rateDupes} duplicate rate rows (same card, zone, kind and weight) collapsed to one`);

// Sales tariffs on imported cards, their margins, and current customer assignments.
const sales = salesMasters.map((s) => ({ s, card: cardKey.get(`${t(s.BranchCode)}|${t(s.BaseTariff)}`) })).filter((x) => x.card).map(({ s, card }) => ({
  id: uid('sales', t(s.BranchCode), t(s.ServiceCode), t(s.SalesTariff)), branch: t(s.BranchCode), branch_code: BRANCH[t(s.BranchCode)],
  service: t(s.ServiceCode), code: t(s.SalesTariff), name: (t(s.Description) || t(s.SalesTariff)).slice(0, 200), base_tariff_id: card.id,
}));
report.push(`${salesMasters.length - sales.length} sales tariffs skipped (their rate card has no 2026 version)`);
const salesId = new Map(sales.map((s) => [`${s.branch}|${s.service}|${s.code}`, s.id]));
const marginMap = new Map();
for (const m of margins) {
  const id = salesId.get(`${t(m.BranchCode)}|${t(m.ServiceCode)}|${t(m.SalesTariff)}`);
  if (!id || m.Margin == null || t(m.Margin) === '') continue;
  marginMap.set(`${id}|${t(m.ZoneCode)}|${KIND(m.ConsignmentType)}|${num(m.ToWeight)}`, { id, zone: t(m.ZoneCode), kind: KIND(m.ConsignmentType), to: num(m.ToWeight), pct: num(m.Margin) });
}
const marginRows = [...marginMap.values()];
const ctMap = new Map();
let ctSkipped = 0;
for (const c of custTariffs) {
  const customer = custId.get(t(c.CustomerCode));
  const sid = salesId.get(`${t(c.BranchCode)}|${t(c.ServiceCode)}|${t(c.SalesTariff)}`);
  const from = date(c.EffectiveFrom);
  if (!customer || !sid || !from) { ctSkipped++; continue; }
  ctMap.set(`${customer}|${t(c.ServiceCode)}|${from}`, { customer, service: t(c.ServiceCode), from, to: date(c.EffectiveTo), sid, divisor: num(c.VolumetricDivisor) || null });
}
const ctRows = [...ctMap.values()];
if (ctSkipped) report.push(`${ctSkipped} customer tariff rows skipped (customer, sales tariff or date missing)`);

// ---------------------------------------------------------------- SQL
const lit = (v) => (v == null ? 'null' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const files = [];
const header = "set jet.importing = 'on';\n";
const write = (name, sql) => files.push({ name, sql: header + sql });
const chunked = (name, rows, size, toSql) => {
  for (let i = 0; i < rows.length; i += size) write(`${name}-${String(i / size + 1).padStart(3, '0')}`, toSql(rows.slice(i, i + size)));
};
const values = (rows, cols) => rows.map((r) => `(${cols.map((c) => lit(r[c])).join(', ')})`).join(',\n');

const allTariffIds = cards.map((c) => c.id), allSalesIds = sales.map((s) => s.id), allZoneIds = zoneSets.map((z) => z.id);
write('00-reset', `
-- Remove the demo tariffs and anything a previous import brought in (cascades to versions, rates, margins, lanes, assignments).
delete from public.customer_tariffs where sales_tariff_id in (select id from public.sales_tariffs where code in ('STANDARD', 'KEY') and name like '%(demo)');
delete from public.sales_tariffs where name like '%(demo)' or id in (${allSalesIds.map(lit).join(', ') || 'null'});
delete from public.base_tariffs where name like '%(demo)' or id in (${allTariffIds.map(lit).join(', ') || 'null'});
delete from public.zone_sets where code like 'DEMO-%' or id in (${allZoneIds.map(lit).join(', ') || 'null'});
insert into public.carriers (code, name) values ('JET', 'Jet Worldwide (own network)') on conflict (code) do nothing;
`);
chunked('01-customers', custRows, 1000, (rows) => `
insert into public.customers (id, account_code, name, branch_code, status, payment_terms_days, payment_terms_code, hold_reason, hold_note, held_at)
select v.id::uuid, v.account_code, v.name, v.branch_code, v.status::public.customer_status, v.days, v.code, v.reason::public.hold_reason, v.note, case when v.status = 'on_hold' then now() end
from (values ${values(rows, ['id', 'account_code', 'name', 'branch_code', 'status', 'payment_terms_days', 'payment_terms_code', 'hold_reason', 'hold_note'])})
  as v (id, account_code, name, branch_code, status, days, code, reason, note)
on conflict (account_code) do update set name = excluded.name, branch_code = excluded.branch_code, status = excluded.status,
  payment_terms_days = excluded.payment_terms_days, payment_terms_code = excluded.payment_terms_code,
  hold_reason = excluded.hold_reason, hold_note = excluded.hold_note, held_at = coalesce(public.customers.held_at, excluded.held_at);
`);
write('02-zone-sets', `insert into public.zone_sets (id, branch_code, code, name) values\n${values(zoneSets, ['id', 'branch_code', 'code', 'name'])};`);
chunked('03-zone-groups', groupRows, 3000, (rows) => `insert into public.zone_groups (zone_set_id, country_code, range_from, range_to, group_code) values\n${values(rows, ['zone_set_id', 'country', 'from', 'to', 'group'])};`);
chunked('04-zone-lanes', laneRows, 3000, (rows) => `insert into public.zone_lanes (zone_set_id, customer_id, orig_group, dest_group, zone_code) values\n${values(rows, ['zone_set_id', 'customer', 'orig', 'dest', 'zone'])};`);
write('05-rate-cards', `
insert into public.base_tariffs (id, code, name, branch_code, carrier_code, service_code, zone_set_id, cost_only) values
${cards.map((c) => `(${[c.id, c.code, c.name, c.branch_code, c.carrier, c.service, c.zoneType ? zoneSetId.get(`${c.branch}|${c.zoneType}`) : null, c.cost_only].map((v) => (typeof v === 'boolean' ? String(v) : lit(v))).join(', ')})`).join(',\n')};
insert into public.tariff_versions (id, tariff_id, version, note, volumetric_divisor) values
${values(cards.map((c) => ({ ...c, v: 1 })), ['version_id', 'id', 'v', 'note', 'divisor'])};
`);
chunked('06-rates', rateRows, 2500, (rows) => `insert into public.tariff_rates (version_id, zone_code, kind, from_kg, to_kg, step_kg, method, charge, basic, minimum) values\n${values(rows, ['version_id', 'zone', 'kind', 'from', 'to', 'step', 'method', 'charge', 'basic', 'minimum'])};`);
write('07-publish', cards.map((c) => `update public.tariff_versions set status = 'published', valid_from = ${lit(c.valid_from)}, published_at = now() where id = ${lit(c.version_id)};`).join('\n'));
write('08-sales-tariffs', `insert into public.sales_tariffs (id, code, name, base_tariff_id, branch_code, service_code) values\n${values(sales, ['id', 'code', 'name', 'base_tariff_id', 'branch_code', 'service'])};`);
chunked('09-margins', marginRows, 3000, (rows) => `insert into public.sales_margins (sales_tariff_id, zone_code, kind, to_kg, margin_pct) values\n${values(rows, ['id', 'zone', 'kind', 'to', 'pct'])};`);
chunked('10-customer-tariffs', ctRows, 2000, (rows) => `insert into public.customer_tariffs (customer_id, service_code, effective_from, effective_to, sales_tariff_id, volumetric_divisor, created_by) values\n${rows.map((r) => `(${[r.customer, r.service, r.from, r.to, r.sid, r.divisor].map(lit).join(', ')}, null)`).join(',\n')};`);
write('11-log', `select private.log_change('import', 'jetstream', jsonb_build_object('rate_cards', ${cards.length}, 'rates', ${rateRows.length}, 'sales_tariffs', ${sales.length}, 'margins', ${marginRows.length}, 'customers', ${custRows.length}, 'customer_tariffs', ${ctRows.length}, 'source', 'JetStreamSeeded backup', 'run', ${lit(TODAY)}));`);

mkdirSync(out, { recursive: true });
for (const old of readdirSync(out).filter((n) => n.endsWith('.sql'))) rmSync(join(out, old));   // keep the folder (it may be open elsewhere)
for (const f of files) writeFileSync(join(out, `${f.name}.sql`), f.sql);
console.log(`Wrote ${files.length} SQL files to ${out}`);
console.log(`  ${cards.length} rate cards, ${rateRows.length} rates, ${zoneSets.length} zone guides (${groupRows.length} groups, ${laneRows.length} lanes),`);
console.log(`  ${sales.length} sales tariffs, ${marginRows.length} margins, ${custRows.length} customers, ${ctRows.length} customer tariffs`);
for (const r of report) console.log(`  note: ${r}`);
if (dryRun) process.exit(0);

// ---------------------------------------------------------------- load into the linked project
console.log('Loading into the linked Supabase project…');
for (const f of readdirSync(out).filter((n) => n.endsWith('.sql')).sort()) {
  process.stdout.write(`  ${f} … `);
  const res = execFileSync('npx', ['supabase', 'db', 'query', '--linked', '-f', `scripts/jetstream-import/out/${f}`, '--output-format', 'json'],
    { cwd: root, encoding: 'utf8', shell: true, maxBuffer: 1 << 26 });
  if (/"error"|ERROR/i.test(res)) { console.log('failed'); console.log(res.slice(0, 2000)); process.exit(1); }
  console.log('ok');
}
console.log('Import complete.');

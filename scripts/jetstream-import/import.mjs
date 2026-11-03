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
const customers = q(`select CustomerCode, BranchCode, CustomerName, Status, Active, PaymentTerms, BillTo, SalesRepCode, FirstTradeDate from Customer`);
// Rep codes and names only (JetStream also holds reps' phones and emails; those stay behind).
const reps = q(`select SalesRepCode, SalesRepName from SalesRep`);
const custTariffs = q(`select BranchCode, CustomerCode, ServiceCode, SalesTariff, EffectiveFrom, EffectiveTo, VolumetricDivisor from CustomersTariff where EffectiveTo >= '20260101'`);
// Add-on rules (SalesAddOn) in force from 2025, plus weekly fuel reconstructed from billed freight lines: this backup
// holds no #FUEL rules, so each week's rate per branch and service (and any customer's own rate) is the rate that was
// actually billed most often. Marked source = 'reconstructed'; a fresh live backup should replace them.
const addOns = q(`select BranchCode, CustomerCode, AddOnCode, Description, ServiceCode, ValidFrom, ValidTo, Percentage, PercentageOf, FixedFee,
  ApplyWhen, IncomeAccount, RangeFrom, RangeTo, AddFuel, AddSecurity, AddGST, Minimum from SalesAddOn where ValidTo >= '20250101'`);
const fuelLines = q(`select b.BranchCode, b.CustomerCode, b.ServiceCode, b.ShipmentDate,
  cast(t.Charge as decimal(12,2)) as Charge, cast(t.Fuel as decimal(12,2)) as Fuel
  from (select ConnoteNo, Charge, Fuel, TransactionType from arcTransactions union all select ConnoteNo, Charge, Fuel, TransactionType from Transactions) t
  join (select ConnoteNo, BranchCode, CustomerCode, ServiceCode, ShipmentDate, HandRated from arcBilling union all
        select ConnoteNo, BranchCode, CustomerCode, ServiceCode, ShipmentDate, HandRated from Billing) b on b.ConnoteNo = t.ConnoteNo
  where t.TransactionType = '.FREIGHT' and t.Charge > 0 and b.HandRated = 'N' and b.ShipmentDate >= '20260101'`);
// Charge lines (Transactions, live and archived) with their shipment details: invoice history and what is still unbilled.
// A '#' status marks customs duties. Deleted lines are left behind.
const invoiceLines = q(`select t.BranchCode, t.ChargeAccount, t.CustomerCode, t.ConnoteNo, t.Status, t.TransactionType, t.Description,
  cast(t.Charge as decimal(12,2)) Charge, cast(t.Fuel as decimal(12,2)) Fuel, cast(t.Security as decimal(12,2)) Security, cast(t.GST as decimal(12,2)) GST,
  t.InvoiceRun, t.InvoiceDate, t.InvoiceNo, t.DueDate, t.IncomeAccount, b.ShipmentDate, b.ServiceCode, b.Pieces, b.Weight, b.SenderCountryCode, b.ReceiverCountryCode,
  b.Status as BillingStatus
  from (select BranchCode, ChargeAccount, CustomerCode, ConnoteNo, Status, TransactionType, Description, Charge, Fuel, Security, GST, InvoiceRun, InvoiceDate, InvoiceNo, DueDate, IncomeAccount from Transactions
        union all select BranchCode, ChargeAccount, CustomerCode, ConnoteNo, Status, TransactionType, Description, Charge, Fuel, Security, GST, InvoiceRun, InvoiceDate, InvoiceNo, DueDate, IncomeAccount from arcTransactions) t
  left join (select ConnoteNo, ShipmentDate, ServiceCode, Pieces, Weight, SenderCountryCode, ReceiverCountryCode, Status from Billing
        union all select ConnoteNo, ShipmentDate, ServiceCode, Pieces, Weight, SenderCountryCode, ReceiverCountryCode, Status from arcBilling) b on b.ConnoteNo = t.ConnoteNo
  where t.Status not like 'DEL%'`);
console.log(`  ${invoiceLines.length} charge lines (invoiced and unbilled)`);

// Automatically rated jobs billed this year with their freight line: the pricing review re-prices them on other tariffs.
const shipments = q(`select b.ConnoteNo, b.BranchCode, b.CustomerCode, b.ServiceCode, b.ShipmentDate, b.ConsignmentType, b.SenderCountryCode,
  b.SenderPostcode, b.ReceiverCountryCode, b.ReceiverPostcode, b.Weight, f.Freight
  from (select * from arcBilling union all select * from Billing) b
  join (select ConnoteNo, cast(sum(Charge) as decimal(12,2)) Freight from (select ConnoteNo, Charge, TransactionType from Transactions union all
        select ConnoteNo, Charge, TransactionType from arcTransactions) t where TransactionType = '.FREIGHT' group by ConnoteNo) f on f.ConnoteNo = b.ConnoteNo
  where b.HandRated = 'N' and b.ShipmentDate >= '20260101'`);
console.log(`  ${addOns.length} add-on rules, ${fuelLines.length} billed freight lines for fuel`);
console.log(`  ${shipments.length} billed shipments for the pricing review`);
console.log(`  ${rates.length} rates, ${margins.length} margins, ${groups.length} zone groups, ${lanes.length} zone lanes, ${customers.length} customers, ${custTariffs.length} customer tariffs`);

// ---------------------------------------------------------------- transform
const BRANCH = { JETSYD: 'AU', JETAKL: 'NZ' };
const KIND = (c) => (t(c) === 'DOX' ? 'doc' : 'parcel');            // DOX = documents; WPX and DOM = everything else
const CARRIER = (code) => ({ DHL: 'DHL', TNT: 'TNT', FDX: 'FEDEX', AKL: 'DHL', JET: 'JET' })[code.split('.')[0]] ?? 'DHL';
const TERMS = { '7D': 7, '14D': 14, '21D': 21, '30D': 30, '30EOM': 30, '60D': 60, EOM: 30 };
// yyyymmdd to an ISO date; anything that isn't a real date (JetStream uses 99999999 for "no end") gives null.
const date = (s) => {
  const d = t(s).length === 8 ? `${t(s).slice(0, 4)}-${t(s).slice(4, 6)}-${t(s).slice(6, 8)}` : null;
  return d && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d) ? d : null;
};
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
// Sales reps (JetStream's SalesRep) and each account's rep. Codes used by customers but missing from SalesRep (a rep
// who has left) come across too, named by their code. HOUSE is the office's own accounts.
const repCode = (v) => t(v).toUpperCase();
const repBranches = new Map();
for (const c of customers.filter((c) => custId.has(t(c.CustomerCode)) && repCode(c.SalesRepCode))) {
  const k = repCode(c.SalesRepCode);
  repBranches.set(k, new Set([...(repBranches.get(k) ?? []), BRANCH[t(c.BranchCode)]]));
}
const repRows = [...new Set([...reps.map((r) => repCode(r.SalesRepCode)), ...repBranches.keys()])].filter((k) => /^[A-Z0-9_-]+$/.test(k)).map((k) => {
  const r = reps.find((x) => repCode(x.SalesRepCode) === k);
  const b = [...(repBranches.get(k) ?? [])];
  return { code: k, name: t(r?.SalesRepName) || `${k} (not in JetStream's rep list)`, branch: b.length === 1 ? b[0] : null, house: k === 'HOUSE' };
});
const repSet = new Set(repRows.map((r) => r.code));
const repAssign = customers.filter((c) => custId.has(t(c.CustomerCode)))
  .map((c) => ({ id: custId.get(t(c.CustomerCode)), rep: repSet.has(repCode(c.SalesRepCode)) ? repCode(c.SalesRepCode) : null, first: date(c.FirstTradeDate) }))
  .filter((r) => r.rep || r.first);
if (repRows.some((r) => !reps.find((x) => repCode(x.SalesRepCode) === r.code))) report.push(`rep codes used by customers but not in SalesRep: ${repRows.filter((r) => !reps.find((x) => repCode(x.SalesRepCode) === r.code)).map((r) => r.code).join(', ')}`);

// Bill-to accounts (JetStream's BillTo): who receives and pays the invoice when it isn't the account itself.
const billToRows = customers.filter((c) => custId.has(t(c.CustomerCode)) && t(c.BillTo) && t(c.BillTo) !== t(c.CustomerCode) && custId.has(t(c.BillTo)))
  .map((c) => ({ id: custId.get(t(c.CustomerCode)), bill_to: custId.get(t(c.BillTo)) }));

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

// Services seen anywhere (add-ons use some that have no tariff, e.g. economy and customs).
const SERVICE_NAMES = {
  INTOUTEXP: 'International outbound express', INTINBEXP: 'International inbound express', DOMESTEXP: 'Domestic express',
  DOMESTROAD: 'Domestic road', DOMESTASAP: 'Domestic next flight', INTOUTECO: 'International outbound economy',
  INTINBECO: 'International inbound economy', INTOUTASAP: 'International outbound next flight', CUSTOMS: 'Customs', EXTRA: 'Extras',
};
const serviceCodes = new Set([...addOns.map((a) => t(a.ServiceCode)).filter((s) => s && s !== 'z'), ...ctRows.map((c) => c.service), ...cards.map((c) => c.service).filter(Boolean)]);
const serviceRows = [...serviceCodes].map((code) => ({ code, name: SERVICE_NAMES[code] ?? code }));

const yn = (v) => t(v).toUpperCase() === 'Y';
let addonSkipped = 0;
const addonRows = addOns.filter((a) => BRANCH[t(a.BranchCode)]).flatMap((a) => {
  const cc = t(a.CustomerCode);
  const customer = cc === 'z' ? null : custId.get(cc);
  if (cc !== 'z' && !customer) { addonSkipped++; return []; }
  const svc = t(a.ServiceCode);
  return [{
    id: uid('addon', t(a.BranchCode), cc, svc, t(a.AddOnCode), t(a.ValidFrom), t(a.ApplyWhen), t(a.RangeFrom), t(a.RangeTo)),
    branch_code: BRANCH[t(a.BranchCode)], customer, service: svc === 'z' || !svc ? null : svc, code: t(a.AddOnCode), description: t(a.Description),
    valid_from: date(a.ValidFrom) ?? '2000-01-01', valid_to: date(a.ValidTo) ?? '9999-12-31', apply_when: t(a.ApplyWhen).toUpperCase(),
    percentage_of: t(a.PercentageOf).toUpperCase() || null, percentage: num(a.Percentage), fixed_fee: num(a.FixedFee), minimum: num(a.Minimum),
    range_from: a.RangeFrom == null ? null : String(a.RangeFrom), range_to: a.RangeTo == null ? null : String(a.RangeTo),
    add_fuel: yn(a.AddFuel), add_security: yn(a.AddSecurity), add_gst: yn(a.AddGST), income_account: t(a.IncomeAccount) || null,
  }];
});
// Several JetStream rows can share every key above; keep one of each.
const addonUnique = [...new Map(addonRows.map((r) => [r.id, r])).values()];
if (addonSkipped) report.push(`${addonSkipped} customer-specific add-on rules skipped (customer not in the Customer table)`);

// Weekly fuel, reconstructed: the most-billed rate per branch, service and week; a customer's own rate where it differs.
const monday = (s) => {
  const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const sunday = (m) => { const d = new Date(`${m}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 6); return d.toISOString().slice(0, 10); };
// Fuel is stored to the cent, so the billed ratio wobbles on small charges (42.47% vs 42.50%). For each group, try every
// ratio seen and keep the rate that reproduces the most billed fuel amounts to the cent.
const r2 = (n) => Math.round(n * 100) / 100;
const bestRate = (lines) => {
  const candidates = [...new Set(lines.map((l) => r2((Number(l.Fuel) / Number(l.Charge)) * 100)))];
  let best = { pct: 0, hits: -1 };
  for (const pct of candidates) {
    const hits = lines.filter((l) => Math.abs(r2((Number(l.Charge) * pct) / 100) - Number(l.Fuel)) < 0.006).length;
    if (hits > best.hits) best = { pct, hits };
  }
  return best;
};
const hitsAt = (lines, pct) => lines.filter((l) => Math.abs(r2((Number(l.Charge) * pct) / 100) - Number(l.Fuel)) < 0.006).length;
const groupLines = (keyFn) => fuelLines.reduce((m, l) => { (m[keyFn(l)] ??= []).push(l); return m; }, {});
const generalRate = Object.fromEntries(Object.entries(groupLines((l) => `${t(l.BranchCode)}|${t(l.ServiceCode)}|${monday(t(l.ShipmentDate))}`))
  .map(([k, ls]) => [k, bestRate(ls).pct]));
const fuelRows = Object.entries(generalRate).filter(([k]) => BRANCH[k.split('|')[0]]).map(([k, pct]) => {
  const [branch, service, week] = k.split('|');
  return { id: uid('fuel', branch, service, week), branch_code: BRANCH[branch], customer: null, service, week, pct };
});
// A customer gets their own rate only when the general rate explains under half their bills that week and their
// own rate explains at least two.
for (const [k, ls] of Object.entries(groupLines((l) => `${t(l.BranchCode)}|${t(l.ServiceCode)}|${monday(t(l.ShipmentDate))}|${t(l.CustomerCode)}`))) {
  const [branch, service, week, cust] = k.split('|');
  const customer = custId.get(cust);
  if (!customer || !BRANCH[branch]) continue;
  if (hitsAt(ls, generalRate[`${branch}|${service}|${week}`]) * 2 >= ls.length) continue;
  const own = bestRate(ls);
  if (own.hits < 2 && !(own.hits === ls.length && own.pct === 0)) continue;
  fuelRows.push({ id: uid('fuel', branch, service, week, cust), branch_code: BRANCH[branch], customer, service, week, pct: own.pct });
}
for (const s of new Set(fuelRows.map((f) => f.service))) if (!serviceCodes.has(s)) serviceRows.push({ code: s, name: SERVICE_NAMES[s] ?? s });
if (ctSkipped) report.push(`${ctSkipped} customer tariff rows skipped (customer, sales tariff or date missing)`);

// ---------------------------------------------------------------- SQL
const shipRows = [...new Map(shipments.filter((b) => BRANCH[t(b.BranchCode)] && custId.has(t(b.CustomerCode)) && Number(b.Weight) > 0).map((b) => [t(b.ConnoteNo), {
  connote: t(b.ConnoteNo), customer: custId.get(t(b.CustomerCode)), branch: BRANCH[t(b.BranchCode)], service: t(b.ServiceCode), shipped: date(b.ShipmentDate),
  kind: KIND(b.ConsignmentType), oc: t(b.SenderCountryCode), op: t(b.SenderPostcode), dc: t(b.ReceiverCountryCode), dp: t(b.ReceiverPostcode),
  weight: Number(b.Weight), freight: Number(b.Freight),
}])).values()].filter((r) => r.shipped);

// Invoices and charge lines. JetStream statuses: NEW/LCK/PST = not yet invoiced, HLD = held, INV = invoiced (not sent),
// SNT = sent, EXP = exported to MYOB; '#' = duties. Invoices are keyed by branch and number.
const STATUS = (st) => st.replace('#', '');
const invoiceKey = (l) => `${BRANCH[t(l.BranchCode)]}|${t(l.InvoiceNo)}`;
const chargeRows = [];
const invoiceMap = new Map();
let linesSkipped = 0;
for (const [n, l] of invoiceLines.entries()) {
  const branch = BRANCH[t(l.BranchCode)];
  const customer = custId.get(t(l.CustomerCode));
  if (!branch || !customer) { linesSkipped++; continue; }
  const st = STATUS(t(l.Status));
  const duties = t(l.Status).endsWith('#') || t(l.ServiceCode) === 'CUSTOMS';
  const invoiced = ['INV', 'SNT', 'EXP'].includes(st) && t(l.InvoiceNo);
  let invoice = null;
  if (invoiced) {
    const key = invoiceKey(l);
    const billTo = custId.get(t(l.ChargeAccount)) ?? customer;
    const inv = invoiceMap.get(key) ?? {
      id: uid('invoice', key), branch, number: Number(t(l.InvoiceNo)), kind: duties ? 'duties' : 'weekly', bill_to: billTo,
      date: date(l.InvoiceDate), due: date(l.DueDate), run: t(l.InvoiceRun) || `${t(l.InvoiceDate)}`, status: st === 'EXP' ? 'exported' : st === 'SNT' ? 'sent' : 'approved',
      charge: 0, fuel: 0, security: 0, gst: 0,
    };
    inv.charge += num(l.Charge); inv.fuel += num(l.Fuel); inv.security += num(l.Security); inv.gst += num(l.GST);
    invoiceMap.set(key, inv);
    invoice = inv.id;
  }
  chargeRows.push({
    id: uid('charge', t(l.BranchCode), t(l.ConnoteNo), t(l.TransactionType), t(l.InvoiceNo), String(n)), branch, customer, connote: t(l.ConnoteNo),
    shipped: date(l.ShipmentDate) ?? date(l.InvoiceDate) ?? '2026-01-01', service: t(l.ServiceCode) || null, kind: duties ? 'duties' : 'freight',
    code: t(l.TransactionType), description: t(l.Description), charge: num(l.Charge), fuel: num(l.Fuel), security: num(l.Security), gst: num(l.GST),
    account: t(l.IncomeAccount) || null, pieces: l.Pieces == null ? null : Number(l.Pieces), weight: l.Weight == null ? null : Number(l.Weight),
    oc: t(l.SenderCountryCode) || null, dc: t(l.ReceiverCountryCode) || null,
    status: invoice ? 'invoiced' : st === 'HLD' ? 'held' : t(l.BillingStatus).startsWith('NOINV') ? 'no_bill' : 'new', invoice,
  });
}
// Charge ids must be unique even if JetStream repeats a line; keep the first.
const chargeUnique = [...new Map(chargeRows.map((r) => [r.id, r])).values()];
const invoiceRows = [...invoiceMap.values()].filter((i) => i.date);
const r2c = (n) => Math.round(n * 100) / 100;
const runMap = new Map();
for (const i of invoiceRows) {
  const key = `${i.branch}|${i.kind}|${i.run}`;
  const pe = /^[A-Z]{2}:(\d{4}-\d{2}-\d{2})$/.exec(i.run)?.[1] ?? i.date;
  const r = runMap.get(key) ?? { id: uid('run', key), branch: i.branch, kind: i.kind, period_end: pe, invoice_date: i.date };
  if (i.date > r.invoice_date) r.invoice_date = i.date;
  runMap.set(key, r);
  i.run_id = r.id;
}
const runRows = [...runMap.values()];
const invoiceIds = new Set(invoiceRows.map((i) => i.id));
const nextNumber = Object.fromEntries(['AU', 'NZ'].map((b) => [b, Math.max(0, ...invoiceRows.filter((i) => i.branch === b).map((i) => i.number)) + 1]));
if (linesSkipped) report.push(`${linesSkipped} charge lines skipped (branch or customer not imported)`);

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
delete from public.addon_rules where source in ('jetstream', 'reconstructed') or id::text like '7e000000-%';
delete from public.billed_shipments where source in ('jetstream', 'demo');
delete from public.charges where source in ('jetstream', 'demo');
delete from public.invoices where source = 'jetstream' or id in (select id from public.invoices where run_id in (select id from public.invoice_runs where source = 'jetstream'));
delete from public.invoice_runs where source = 'jetstream';
delete from public.invoices i where i.status = 'draft' and not exists (select 1 from public.charges c where c.invoice_id = i.id);
update public.customers set bill_to_id = null where bill_to_id is not null;
insert into public.tariff_services (code, name) values
${serviceRows.map((r) => `(${lit(r.code)}, ${lit(r.name)})`).join(',\n')}
on conflict (code) do nothing;
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
chunked('12-addons', addonUnique, 1500, (rows) => `insert into public.addon_rules (id, branch_code, customer_id, service_code, code, description, valid_from, valid_to, apply_when, percentage_of, percentage, fixed_fee, minimum, range_from, range_to, add_fuel, add_security, add_gst, income_account, source) values\n${rows.map((r) => `(${[r.id, r.branch_code, r.customer, r.service, r.code, r.description, r.valid_from, r.valid_to, r.apply_when, r.percentage_of, r.percentage, r.fixed_fee, r.minimum, r.range_from, r.range_to].map(lit).join(', ')}, ${r.add_fuel}, ${r.add_security}, ${r.add_gst}, ${lit(r.income_account)}, 'jetstream')`).join(',\n')};`);
chunked('13-fuel', fuelRows, 1500, (rows) => `insert into public.addon_rules (id, branch_code, customer_id, service_code, code, description, valid_from, valid_to, apply_when, percentage, add_gst, source) values\n${rows.map((r) => `(${[r.id, r.branch_code, r.customer, r.service, '#FUEL', 'Fuel surcharge (reconstructed from billed jobs)', r.week, sunday(r.week), 'ADD=Y', r.pct].map(lit).join(', ')}, true, 'reconstructed')`).join(',\n')};`);
write('15-bill-to', billToRows.length ? `update public.customers c set bill_to_id = v.bill_to::uuid from (values ${values(billToRows, ['id', 'bill_to'])}) as v (id, bill_to) where c.id = v.id::uuid;` : 'select 1;');
write('20-sales-reps', `
insert into public.sales_reps (code, name, branch_code, is_house, source) values
${repRows.map((r) => `(${[r.code, r.name, r.branch].map(lit).join(', ')}, ${r.house}, 'jetstream')`).join(',\n')}
on conflict (code) do update set name = excluded.name, branch_code = excluded.branch_code, source = 'jetstream';
${repAssign.length ? `update public.customers c set sales_rep_code = v.rep, first_trade_date = v.first::date from (values ${values(repAssign, ['id', 'rep', 'first'])}) as v (id, rep, first) where c.id = v.id::uuid;` : ''}
`);
write('16-invoice-runs', `insert into public.invoice_runs (id, branch_code, kind, period_end, invoice_date, status, created_by, source) values
${runRows.map((r) => `(${[r.id, r.branch, r.kind, r.period_end, r.invoice_date].map(lit).join(', ')}, 'approved', null, 'jetstream')`).join(',\n')};`);
chunked('17-invoices', invoiceRows, 1500, (rows) => `insert into public.invoices (id, run_id, branch_code, number, kind, bill_to_id, invoice_date, due_date, charge_total, fuel_total, security_total, gst_total, total, status, source) values
${rows.map((i) => `(${[i.id, i.run_id, i.branch, i.number, i.kind, i.bill_to, i.date, i.due, r2c(i.charge), r2c(i.fuel), r2c(i.security), r2c(i.gst), r2c(i.charge + i.fuel + i.security + i.gst), i.status].map(lit).join(', ')}, 'jetstream')`).join(',\n')};`);
chunked('18-charges', chargeUnique, 2000, (rows) => `insert into public.charges (id, branch_code, customer_id, connote, shipped_on, service_code, kind, code, description, charge, fuel, security, gst, income_account, pieces, weight, orig_country, dest_country, status, invoice_id, source) values
${rows.map((c) => `(${[c.id, c.branch, c.customer, c.connote, c.shipped, c.service, c.kind, c.code, c.description, c.charge, c.fuel, c.security, c.gst, c.account, c.pieces, c.weight, c.oc, c.dc, c.status, invoiceIds.has(c.invoice) ? c.invoice : null].map(lit).join(', ')}, 'jetstream')`).join(',\n')};`);
write('19-invoice-numbers', `insert into public.invoice_sequences (branch_code, next_number) values ('AU', ${nextNumber.AU}), ('NZ', ${nextNumber.NZ})
on conflict (branch_code) do update set next_number = greatest(public.invoice_sequences.next_number, excluded.next_number);`);
chunked('14-shipments', shipRows, 2000, (rows) => `insert into public.billed_shipments (connote, customer_id, branch_code, service_code, shipped_on, kind, orig_country, orig_postcode, dest_country, dest_postcode, weight, freight) values
${values(rows, ['connote', 'customer', 'branch', 'service', 'shipped', 'kind', 'oc', 'op', 'dc', 'dp', 'weight', 'freight'])};`);
write('99-log', `select private.log_change('import', 'jetstream', jsonb_build_object('rate_cards', ${cards.length}, 'rates', ${rateRows.length}, 'sales_tariffs', ${sales.length}, 'margins', ${marginRows.length}, 'customers', ${custRows.length}, 'customer_tariffs', ${ctRows.length}, 'addon_rules', ${addonUnique.length}, 'fuel_weeks', ${fuelRows.length}, 'billed_shipments', ${shipRows.length}, 'invoices', ${invoiceRows.length}, 'charges', ${chargeUnique.length}, 'source', 'JetStreamSeeded backup', 'run', ${lit(TODAY)}));`);

mkdirSync(out, { recursive: true });
for (const old of readdirSync(out).filter((n) => n.endsWith('.sql'))) rmSync(join(out, old));   // keep the folder (it may be open elsewhere)
for (const f of files) writeFileSync(join(out, `${f.name}.sql`), f.sql);
console.log(`Wrote ${files.length} SQL files to ${out}`);
console.log(`  ${cards.length} rate cards, ${rateRows.length} rates, ${zoneSets.length} zone guides (${groupRows.length} groups, ${laneRows.length} lanes),`);
console.log(`  ${sales.length} sales tariffs, ${marginRows.length} margins, ${custRows.length} customers, ${ctRows.length} customer tariffs`);
console.log(`  ${shipRows.length} billed shipments, ${invoiceRows.length} invoices in ${runRows.length} runs, ${chargeUnique.length} charge lines (${chargeUnique.filter((c) => !c.invoice).length} not yet invoiced), ${billToRows.length} bill-to accounts, next numbers AU ${nextNumber.AU} / NZ ${nextNumber.NZ}`);
console.log(`  ${addonUnique.length} add-on rules, ${fuelRows.length} reconstructed weekly fuel rates (${fuelRows.filter((f) => f.customer).length} customer-specific), ${serviceRows.length} services`);
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

// Runs every migration and the seed in an in-memory Postgres (PGlite), then checks the
// row-level security rules as different people. No Docker or Supabase project needed.
// Usage: npm run test:db
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// DB_TEST_ROOT lets a deliberately broken copy of the migrations be checked (the tests must then fail).
const root = process.env.DB_TEST_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();

// Minimal stand-ins for what Supabase provides: roles, auth.users, auth.uid(), auth.jwt().
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  -- No default table grants: like the hosted project, every table needs an explicit GRANT in a migration.
  create schema auth; grant usage on schema auth to anon, authenticated, service_role;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}');
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
`);

for (const f of readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
}
await db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'));
// Running the seed twice must be harmless (it is re-run on Test after each reset).
await db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'));

async function signUp(email) {
  const { rows } = await db.query('insert into auth.users (email) values ($1) returning id', [email]);
  return rows[0].id;
}
const chris = await signUp('chris@jetworldwide.example');
const sam = await signUp('sam@jetworldwide.example');
const priya = await signUp('priya@harbouroptics.example');
const stranger = await signUp('someone@else.example');
await db.query(`update public.customers set rep_id = $1 where account_code in ('SYD1021', 'SYD1088')`, [sam]);

async function as(id, email, fn) {
  await db.exec('begin');
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(id ? { sub: id, email } : {})]);
    await db.exec(`set local role ${id ? 'authenticated' : 'anon'}`);
    return await fn();
  } finally {
    await db.exec('rollback');
  }
}
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const results = [];

const totalJobs = Number((await one('select count(*) from public.jobs')).count);

// Sequential: each `as` runs in its own transaction on the one connection, then rolls back.
const run = async () => {
  const p = await one('select role, branch_code, customer_id from public.profiles where id = $1', [chris]);
  assert.equal(p.role, 'management'); assert.equal(p.branch_code, 'AU');
  const pp = await one('select role, customer_id from public.profiles where id = $1', [priya]);
  assert.equal(pp.role, 'customer_admin'); assert.ok(pp.customer_id);
  assert.equal((await one('select role from public.profiles where id = $1', [stranger])).role, 'customer_user');
  assert.equal(Number((await one('select count(*) from public.user_invites where email = $1', ['chris@jetworldwide.example'])).count), 0);
  results.push('  ✓ invites turn into profiles with the right role on first sign-in');

  const early = await signUp('early@jetworldwide.example');
  assert.equal((await one('select role from public.profiles where id = $1', [early])).role, 'customer_user');
  await db.query(`insert into public.user_invites (email, full_name, role, branch_code) values ('early@jetworldwide.example', 'Early Bird', 'finance', 'NZ')`);
  const e = await one('select role, full_name, branch_code from public.profiles where id = $1', [early]);
  assert.deepEqual([e.role, e.full_name, e.branch_code], ['finance', 'Early Bird', 'NZ']);
  assert.equal(Number((await one(`select count(*) from public.user_invites where email = 'early@jetworldwide.example'`)).count), 0);
  results.push('  ✓ inviting someone who already signed in applies the role straight away');

  await as(chris, 'chris@jetworldwide.example', async () => {
    assert.equal(Number((await one('select count(*) from public.jobs')).count), totalJobs);
    const j = await one(`select cost_ex_gst, margin_pct from public.job_list where connote = 'JWW1048802'`);
    assert.equal(Number(j.cost_ex_gst), 96.1); assert.equal(Number(j.margin_pct), 44.0);
    await db.query(`update public.jobs set billing_status = 'ready', issue = null where connote = 'JWW1048802'`);
    const a = await one(`select actor_email, action, before ->> 'billing_status' as was from public.audit_log where table_name = 'jobs' order by id desc limit 1`);
    assert.equal(a.actor_email, 'chris@jetworldwide.example'); assert.equal(a.action, 'update'); assert.equal(a.was, 'needs_attention');
  });
  results.push(`  ✓ management sees all ${totalJobs} jobs with cost and margin, can edit, and the edit is audited`);

  await as(sam, 'sam@jetworldwide.example', async () => {
    assert.equal(Number((await one('select count(*) from public.jobs')).count), 0, 'reps must not read the jobs table directly');
    const r = await one(`select count(*) as n, count(cost_ex_gst) as costs, count(distinct account_code) as accts,
                          bool_and(account_code in ('SYD1021', 'SYD1088')) as only_mine from public.job_list`);
    assert.ok(Number(r.n) > 0); assert.equal(Number(r.costs), 0, 'reps must not see cost'); assert.equal(r.only_mine, true);
    assert.equal(Number((await one('select count(*) from public.customers')).count), 2);
    const u = await db.query(`update public.jobs set sell_ex_gst = 1 where connote = 'JWW1048611'`);
    assert.equal(u.affectedRows, 0, 'reps must not edit jobs');
    assert.equal(Number((await one('select count(*) from public.audit_log')).count), 0);
  });
  results.push('  ✓ sales rep sees only their accounts, no cost or margin, cannot edit');

  await as(priya, 'priya@harbouroptics.example', async () => {
    const r = await one(`select count(*) as n, count(cost_ex_gst) as costs, bool_and(account_code = 'SYD1021') as only_mine from public.job_list`);
    assert.ok(Number(r.n) > 0); assert.equal(Number(r.costs), 0); assert.equal(r.only_mine, true);
    assert.equal(Number((await one('select count(*) from public.customers')).count), 1);
    assert.equal(Number((await one('select count(*) from public.reweighs')).count), 0);
    assert.equal(Number((await one('select count(*) from public.profiles')).count), 1, 'customer admin sees own company users only');
  });
  results.push('  ✓ customer sees only their own account, no cost, no reweighs');

  await as(stranger, 'someone@else.example', async () => {
    assert.equal(Number((await one('select count(*) from public.job_list')).count), 0);
    assert.equal(Number((await one('select count(*) from public.customers')).count), 0);
  });
  results.push('  ✓ a sign-in with no invite and no account sees nothing');

  await as(null, null, async () => {
    await assert.rejects(db.query('select * from public.job_list'), /permission denied/);
  });
  results.push('  ✓ signed-out visitors are refused');

  await as(sam, 'sam@jetworldwide.example', async () => {
    await assert.rejects(db.query(`update public.profiles set role = 'owner' where id = $1`, [sam]).then((r) => {
      if (r.affectedRows === 0) throw new Error('blocked');
    }), /blocked/);
  });
  results.push('  ✓ people cannot promote themselves');

  const monica = await signUp('monica@jetworldwide.example');
  const rw = async (connote) => one(`select r.id, j.sell_ex_gst, j.billing_status, j.issue from public.reweighs r join public.jobs j on j.id = r.job_id where j.connote = $1`, [connote]);
  await as(monica, 'monica@jetworldwide.example', async () => {
    const before = await rw('JWW1048611');
    const n = (await one(`select public.decide_reweighs(array[$1]::uuid[], 'pass_on', 'Customer agreed') as n`, [before.id])).n;
    assert.equal(n, 1);
    const after = await rw('JWW1048611');
    assert.equal(Number(after.sell_ex_gst), Number(before.sell_ex_gst) + 16);
    assert.deepEqual([after.billing_status, after.issue], ['ready', null]);
    assert.equal((await one(`select decision from public.reweighs where id = $1`, [before.id])).decision, 'pass_on');
    const again = (await one(`select public.decide_reweighs(array[$1]::uuid[], 'absorb') as n`, [before.id])).n;
    assert.equal(again, 0, 'a decided reweigh is not decided twice');

    const k = await rw('JWW1048802');
    await db.query(`select public.decide_reweighs(array[$1]::uuid[], 'absorb')`, [k.id]);
    const ka = await rw('JWW1048802');
    assert.equal(Number(ka.sell_ex_gst), Number(k.sell_ex_gst), 'absorbing leaves the customer charge alone');
    assert.equal(ka.billing_status, 'ready');
  });
  await as(sam, 'sam@jetworldwide.example', async () => {
    const { id } = await one(`select id from public.reweighs limit 1`) ?? {};
    assert.equal(id, undefined, 'reps cannot see reweighs');
    await assert.rejects(db.query(`select public.decide_reweighs(array[gen_random_uuid()], 'absorb')`), /Only finance and management/);
  });
  results.push('  ✓ reweigh decisions update the job (pass on adds the charge, absorb does not); reps cannot decide');

  await as(monica, 'monica@jetworldwide.example', async () => {
    assert.ok(Number((await one('select count(*) from public.sales_margins')).count) > 0);
    await db.query(`update public.customers set status = 'on_hold', hold_reason = 'overdue', hold_note = 'Test', held_at = now() where account_code = 'SYD1112'`);
    await db.exec('savepoint no_reason');
    await assert.rejects(db.query(`update public.customers set status = 'on_hold' where account_code = 'SYD1021'`), /customers_hold_check/);
    await db.exec('rollback to savepoint no_reason');
    const h = await one(`select count(*) from public.audit_log where table_name = 'customers' and actor_email = 'monica@jetworldwide.example'`);
    assert.equal(Number(h.count), 1, 'finance can read customer history');
    assert.equal(Number((await one(`select count(*) from public.audit_log where table_name = 'profiles'`)).count), 0, 'but not staff changes');
  });
  for (const [id, email] of [[sam, 'sam@jetworldwide.example'], [priya, 'priya@harbouroptics.example']]) {
    await as(id, email, async () => {
      assert.equal(Number((await one('select count(*) from public.sales_margins')).count), 0, `${email} must not see margins`);
    });
  }
  results.push('  ✓ holds need a reason, finance sees customer history, margins are staff only');

  // ---- tariffs (JetStream's rules, Rating.vb)
  const V1 = '7b000000-0000-4000-8000-000000000001', V2 = '7b000000-0000-4000-8000-000000000002';
  const KEY = '7c000000-0000-4000-8000-000000000002', ZSET = '7d000000-0000-4000-8000-000000000001';
  const HARBOUR = 'c0000000-0000-4000-8000-000000000001';
  const r2 = (n) => Math.round(n * 100) / 100;
  const fc = async (v, w, kind = 'parcel', zone = '6', sales = KEY) =>
    (await one(`select public.freight_charge($1, $2, $3, $4, $5) as c`, [v, sales, zone, kind, w])).c;
  await as(chris, 'chris@jetworldwide.example', async () => {
    // Zone 6 demo rates: parcel 24.55 (first 0.5), 3.23 per 0.5 to 2 kg, 3.10 per 0.5 to 30 kg, 6.01/kg above; doc 20.07.
    // Key accounts margins by break: 30%, 29%, 28%, 25% (documents 30%).
    assert.equal(Number(await fc(V1, 0.3)), r2(24.55 * 1.30), 'first step');
    assert.equal(Number(await fc(V1, 3.2)), r2(24.55 * 1.30 + 3 * 3.23 * 1.29 + 3 * 3.10 * 1.28), 'margin applied row by row, steps counted from the start');
    assert.equal(Number(await fc(V1, 40)), r2(40 * r2(6.01 * 1.25)), 'per kg on the whole weight, rate rounded first');
    assert.equal(Number(await fc(V1, 0.4, 'doc')), r2(20.07 * 1.30), 'documents');
    assert.equal(Number(await fc(V1, 1.5, 'doc')), Number(await fc(V1, 1.5, 'parcel')), 'documents over the documents breaks price as parcels');
    assert.equal(await fc(V1, 500), null, 'heavier than the last break');
    assert.equal((await one(`select public.find_zone($1, $2, 'AU', '2000', 'GB', 'SW1A 1AA') as z`, [ZSET, HARBOUR])).z, '6');
    const p = await one(`select * from public.price_shipment($1, 'INTOUTEXP', 'AU', '2000', 'GB', 'SW1A', 'parcel', 3.2, '2026-06-01')`, [HARBOUR]);
    assert.deepEqual([p.sales_tariff, p.version, p.zone_code, p.volumetric_divisor, p.problem], ['KEY', 1, '6', 5000, null]);
    assert.equal(Number(p.price), Number(await fc(V1, 3.2)));
  });
  // A customer's own zone lane wins over the general one.
  await db.query(`insert into public.zone_lanes (zone_set_id, customer_id, orig_group, dest_group, zone_code) values ($1, $2, 'AU', 'GB', '7')`, [ZSET, HARBOUR]);
  await as(chris, 'chris@jetworldwide.example', async () => {
    assert.equal((await one(`select public.find_zone($1, $2, 'AU', '2000', 'GB', '') as z`, [ZSET, HARBOUR])).z, '7');
    assert.equal((await one(`select public.find_zone($1, null, 'AU', '2000', 'GB', '') as z`, [ZSET])).z, '6');
  });
  await db.query(`delete from public.zone_lanes where customer_id is not null`);
  results.push('  ✓ pricing follows JetStream: margins per row, documents fall back to parcels, per-kg on whole weight, zone lookup with customer overrides');

  await as(monica, 'monica@jetworldwide.example', async () => {
    await db.exec('savepoint locked');
    await assert.rejects(db.query(`update public.tariff_rates set charge = 1 where version_id = $1`, [V1]), /published and locked/);
    await db.exec('rollback to savepoint locked');
    const docCharge = Number((await one(`select charge from public.tariff_rates where version_id = $1 and zone_code = '6' and kind = 'doc'`, [V2])).charge);
    const n = (await one(`select public.upsert_tariff_rates($1, $2::jsonb, 'Zone 6 parcels') as n`, [V2, JSON.stringify([
      { zone_code: '6', kind: 'parcel', from_kg: 0, to_kg: 0.5, step_kg: 0.5, method: 'I', charge: 30 },
      { zone_code: '6', kind: 'doc', from_kg: 0, to_kg: 0.5, step_kg: 0.5, method: 'I', charge: docCharge },
    ])])).n;
    assert.equal(n, 1, 'only changed rows count');
    assert.equal(Number((await one(`select public.adjust_tariff_draft($1, 10, '1', null) as n`, [V2])).n), 5, '+10% on zone 1 only');
    assert.equal(Number((await one(`select public.delete_tariff_rates($1, $2::jsonb) as n`, [V2, JSON.stringify([{ zone_code: '7', kind: 'doc', to_kg: 0.5 }])])).n), 1);
    assert.equal(Number((await one(`select count(*) from public.audit_log where table_name = 'tariff_rates' and actor_email = 'monica@jetworldwide.example'`)).count), 3, 'one audit entry per save');
    assert.equal(Number((await one(`select public.save_sales_margins($1, $2::jsonb) as n`, [KEY, JSON.stringify([
      { zone_code: '6', kind: 'parcel', to_kg: 0.5, margin_pct: 31 }, { zone_code: '7', kind: 'doc', to_kg: 0.5, margin_pct: null }])])).n), 2);
    await db.exec('savepoint publish');
    await assert.rejects(db.query(`select public.publish_tariff_version($1, '2027-01-01')`, [V2]), /Only management/);
    await db.exec('rollback to savepoint publish');
    const v = (await one(`select public.create_rate_card('TNT.DOM.ROAD', 'TNT Road', 'AU', 'TNT', 'DOMESTROAD', null, null) as id`)).id;
    assert.equal(Number((await one(`select volumetric_divisor from public.tariff_versions where id = $1`, [v])).volumetric_divisor), 4000, 'domestic cards default to divisor 4000');
  });
  await as(chris, 'chris@jetworldwide.example', async () => {
    await db.exec('savepoint early');
    await assert.rejects(db.query(`select public.publish_tariff_version($1, '2025-12-01')`, [V2]), /Start date must be after/);
    await db.exec('rollback to savepoint early');
    await db.query(`select public.publish_tariff_version($1, '2027-01-01')`, [V2]);
    assert.equal((await one(`select * from public.price_shipment($1, 'INTOUTEXP', 'AU', '2000', 'GB', '', 'parcel', 3.2, '2026-12-31')`, [HARBOUR])).version, 1);
    assert.equal((await one(`select * from public.price_shipment($1, 'INTOUTEXP', 'AU', '2000', 'GB', '', 'parcel', 3.2, '2027-01-01')`, [HARBOUR])).version, 2);
    const v3 = (await one(`select public.new_tariff_draft($1) as id`, [V2])).id;
    assert.equal(Number((await one(`select count(*) from public.tariff_rates where version_id = $1`, [v3])).count), Number((await one(`select count(*) from public.tariff_rates where version_id = $1`, [V2])).count));
  });
  for (const [id, email] of [[sam, 'sam@jetworldwide.example'], [priya, 'priya@harbouroptics.example']]) {
    await as(id, email, async () => {
      assert.equal(Number((await one('select count(*) from public.tariff_rates')).count), 0, `${email} must not see rates`);
      assert.equal(Number((await one('select count(*) from public.zone_lanes')).count), 0, `${email} must not see zones`);
      assert.equal((await one(`select problem from public.price_shipment($1, 'INTOUTEXP', 'AU', '2000', 'GB', '', 'parcel', 3.2)`, [HARBOUR])).problem, 'The customer has no sales tariff for this service on this date');
    });
  }
  results.push('  ✓ drafts edit by row, by % or by delete (one audit entry each); published locked; management publishes; right version by date; staff only');

  // ---- add-ons (JetStream's GetSalesAddons / GetPieceLevelSalesAddons)
  const lines = async (args) => (await db.query(
    `select code, charge::float, fuel::float, security::float, gst::float, per_piece from public.charge_lines($1, 'INTOUTEXP', $2::date, $3, $4, 'AU', $5, 'GB', 'SW1A', 0, $6, false, false, $7::jsonb)`,
    [HARBOUR, args.date ?? '2026-11-10', args.freight ?? 100, args.weight ?? 3.2, args.opc ?? '2830', args.insured ?? 1000, JSON.stringify(args.pieces ?? [{ weight: 80, max_dim: 50 }])])).rows;
  const byCode = (rows) => Object.fromEntries(rows.map((r) => [r.code, [r.charge, r.fuel, r.security, r.gst]]));
  await as(chris, 'chris@jetworldwide.example', async () => {
    const l = byCode(await lines({}));
    assert.deepEqual(l['.FREIGHT'], [100, 42.5, 2, 14.45], 'freight line: fuel 42.5%, security 2%, GST 10% on all three');
    assert.deepEqual(l.INSUR, [25, 0, 0, 2.5], 'insurance: 2.5% of insured value, minimum $25');
    assert.deepEqual(l.PSS, [5.25, 2.23, 0.11, 0.76], 'peak surcharge: 7 half-kilos at $0.75 (3.2 kg), plus fuel, security, GST');
    assert.deepEqual(l.RAPD, [37, 0, 0, 3.7], 'remote pickup from postcode 2830');
    assert.deepEqual(l.OSPI1, [180, 76.5, 3.6, 18], 'overweight piece: GST on the fee only, as JetStream does');
    assert.equal(l.zADHOC, undefined, 'ad hoc codes are never automatic');
    const notRemote = byCode(await lines({ opc: '2000', insured: 0, pieces: [{ weight: 5, max_dim: 30 }] }));
    assert.deepEqual(Object.keys(notRemote).sort(), ['.FREIGHT', 'PSS'], 'no remote, insurance or piece add-ons when they do not apply');
    assert.equal(byCode(await lines({ date: '2026-10-27' }))['.FREIGHT'][1], 41, 'the fuel rate in force that week');
    assert.equal(byCode(await lines({ pieces: [{ weight: 70, max_dim: 50 }] })).OSPI1, undefined, 'per-piece ranges are decimals: 70 kg is not over 70.001');
  });
  await db.query(`insert into public.addon_rules (branch_code, customer_id, service_code, code, valid_from, apply_when, percentage, add_gst) values ('AU', $1, 'INTOUTEXP', '#FUEL', '2026-01-01', 'ADD=Y', 30, true)`, [HARBOUR]);
  await as(chris, 'chris@jetworldwide.example', async () => {
    assert.equal(byCode(await lines({}))['.FREIGHT'][1], 30, "a customer's own fuel rate wins over the general one");
    assert.equal(Number((await one(`select fuel_pct from public.price_shipment($1, 'INTOUTEXP', 'AU', '2000', 'GB', '', 'parcel', 3.2, '2026-11-10')`, [HARBOUR])).fuel_pct), 30);
  });
  await db.query(`delete from public.addon_rules where customer_id is not null`);
  for (const [id, email] of [[sam, 'sam@jetworldwide.example'], [priya, 'priya@harbouroptics.example']]) {
    await as(id, email, async () => {
      assert.equal(Number((await one('select count(*) from public.addon_rules')).count), 0, `${email} must not see add-on rules`);
    });
  }
  results.push('  ✓ add-ons follow JetStream: freight line, fuel/security/GST, % / per-kg / per-piece rules, postcode conditions, weekly and customer fuel rates');

  // ---- pricing review: outliers, what a move would cost each customer, moving from a date
  const STANDARD = '7c000000-0000-4000-8000-000000000001';
  await as(chris, 'chris@jetworldwide.example', async () => {
    const review = Object.fromEntries((await db.query(`select code, is_standard, customers, jobs_12m, min_margin::float, max_margin::float from public.sales_tariff_review`)).rows.map((r) => [r.code, r]));
    assert.equal(review.STANDARD.is_standard, true);
    assert.equal(review.KEY.customers, 2);
    assert.equal(review.KEY.jobs_12m, 80, "Key accounts' last 12 months of jobs");
    assert.deepEqual([review.KEY.min_margin, review.KEY.max_margin], [25, 30]);
    const p = await one(`select * from public.tariff_switch_preview($1, $2) where customer_id = $3`, [KEY, STANDARD, HARBOUR]);
    assert.equal(p.jobs, 40);
    assert.equal(Number(p.current_price), Number(p.billed), "today's price on their own tariff matches what was billed");
    const rise = Number(p.new_price) / Number(p.current_price);
    assert.ok(rise > 1.05 && rise < 1.08, `Standard is 8 points dearer (got ${rise})`);
    await db.exec('savepoint past');
    await assert.rejects(db.query(`select public.move_customers_to_tariff($1, $2, $3, current_date - 1)`, [KEY, STANDARD, [HARBOUR]]), /today or later/);
    await db.exec('rollback to savepoint past');
    assert.equal((await one(`select public.move_customers_to_tariff($1, $2, $3, current_date + 7) as n`, [KEY, STANDARD, [HARBOUR]])).n, 1);
    const on = async (d) => (await one(`select sales_tariff from public.price_shipment($1, 'INTOUTEXP', 'AU', '2000', 'GB', '', 'parcel', 3.2, current_date + $2::int)`, [HARBOUR, d])).sales_tariff;
    assert.deepEqual([await on(6), await on(7)], ['KEY', 'STANDARD'], 'jobs before the start date keep the old tariff');
    assert.equal(Number((await one(`select count(*) from public.audit_log where table_name = 'customer_tariffs' and after ->> 'moved_to' = 'STANDARD'`)).count), 1);
    await db.query(`select public.set_standard_tariff($1)`, [KEY]);
    assert.deepEqual((await db.query(`select code from public.sales_tariffs where is_standard`)).rows.map((r) => r.code), ['KEY'], 'one standard per branch and service');
  });
  await as(sam, 'sam@jetworldwide.example', async () => {
    await assert.rejects(db.query(`select public.move_customers_to_tariff($1, $2, $3, current_date + 7)`, [KEY, STANDARD, [HARBOUR]]), /Only finance/);
  });
  await as(priya, 'priya@harbouroptics.example', async () => {
    assert.equal(Number((await one('select count(*) from public.billed_shipments')).count), 0, 'customers never see the shipment history');
    assert.equal(Number((await one('select count(*) from public.sales_tariff_review')).count), 0);
  });
  results.push('  ✓ pricing review: tariff outliers, like-for-like preview of a move on real jobs, moves start on a date and are logged, one standard per service');

  // ---- invoicing: weekly run by bill-to account, flags, numbering on approval, carry-over and holds
  const PHARMA = 'c0000000-0000-4000-8000-000000000005', CYCLES = 'c0000000-0000-4000-8000-000000000007', REDFERN = 'c0000000-0000-4000-8000-000000000006';
  const due = async (t, d) => (await one(`select private.due_date($1, $2::date)::text as d`, [t, d])).d;
  assert.deepEqual([await due('14D', '2026-11-01'), await due('EOM', '2026-02-10'), await due('30EOM', '2026-01-15'), await due('XYZ', '2026-01-15')],
    ['2026-11-15', '2026-02-28', '2026-03-02', null]);
  await as(sam, 'sam@jetworldwide.example', async () => {
    await db.exec('savepoint s1');
    await assert.rejects(db.query(`select public.prepare_invoice_run('AU', 'weekly', '2026-11-01')`), /Only finance/);
    await db.exec('rollback to savepoint s1');
    await assert.rejects(db.query(`select private.build_invoice_run('AU', 'weekly', '2026-11-01', '2026-11-01', false)`), /permission denied/);
  });
  await as(chris, 'chris@jetworldwide.example', async () => {
    const run = (await one(`select public.prepare_invoice_run('AU', 'weekly', '2026-11-01') as id`)).id;
    const invs = Object.fromEntries((await db.query(`select bill_to_id, flags, total::float, due_date::text, number from public.invoices where run_id = $1`, [run])).rows.map((r) => [r.bill_to_id, r]));
    assert.equal(invs[CYCLES], undefined, "Coastal Cycles' charges go on Coastal Pharma's invoice");
    assert.deepEqual(invs[PHARMA].flags, ['Has manual charges']);
    assert.ok(invs[REDFERN].flags.includes('Account on hold'));
    assert.equal(invs[HARBOUR].due_date, '2026-11-15', 'Harbour Optics: 14 days');
    const unbilled = Number((await one(`select count(*) from public.charges where branch_code = 'AU' and kind = 'freight' and invoice_id is null and status = 'new' and shipped_on <= '2026-11-01'`)).count);
    assert.equal(unbilled, 0, 'every freight charge to the period end is on an invoice');
    assert.equal(Number((await one(`select count(*) from public.charges where kind = 'duties' and invoice_id is not null`)).count), 0, 'duties are not in the weekly run');
    await db.exec('savepoint s2');
    await assert.rejects(db.query(`select public.prepare_invoice_run('AU', 'weekly', '2026-11-01')`), /already a draft/);
    await db.exec('rollback to savepoint s2');
    const clean = Object.values(invs).filter((i) => !i.flags.length).length;
    assert.equal((await one(`select public.approve_invoices($1) as n`, [run])).n, clean, 'one click approves every clean invoice');
    const nums = (await db.query(`select number from public.invoices where run_id = $1 and status = 'approved' order by number`, [run])).rows.map((r) => Number(r.number));
    assert.deepEqual(nums, nums.map((_, k) => 356500 + k), 'numbers run on from the branch sequence without gaps');
    assert.equal((await one(`select status from public.invoice_runs where id = $1`, [run])).status, 'draft', 'flagged invoices still wait');
    await db.query(`select public.release_invoices($1, array[(select id from public.invoices where run_id = $1 and bill_to_id = $2)], true)`, [run, REDFERN]);
    assert.ok(Number((await one(`select count(*) from public.charges where customer_id = $1 and status = 'held'`, [REDFERN])).count) > 0, 'held charges wait for release');
    await db.query(`select public.approve_invoices($1, array[(select id from public.invoices where run_id = $1 and bill_to_id = $2)])`, [run, PHARMA]);
    assert.equal((await one(`select status from public.invoice_runs where id = $1`, [run])).status, 'approved');
    const d = (await one(`select public.prepare_invoice_run('AU', 'duties', '2026-11-02') as id`)).id;
    assert.deepEqual(Object.values(await one(`select terms_code, due_date::text, total::float from public.invoices where run_id = $1`, [d])), ['7D', '2026-11-09', 88.4], 'duties: own invoice, 7 days');
  });
  await as(priya, 'priya@harbouroptics.example', async () => {
    assert.equal(Number((await one('select count(*) from public.invoices')).count), 0, 'customers see no draft invoices');
    assert.equal(Number((await one('select count(*) from public.invoice_runs')).count), 0);
  });
  results.push('  ✓ invoicing: grouped by bill-to, duties apart on 7 days, flags hold back exceptions, one-click approval numbers without gaps, carry-over and holds');
};

try {
  await run();
} catch (e) {
  process.exitCode = 1;
  results.push(`  ✗ ${e.message}`);
}
console.log(`Database tests (${readdirSync(join(root, 'migrations')).length} migrations + seed):`);
for (const r of results) console.log(r);

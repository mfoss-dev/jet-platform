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
    assert.ok(Number((await one('select count(*) from public.customer_margins')).count) > 0);
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
      assert.equal(Number((await one('select count(*) from public.customer_margins')).count), 0, `${email} must not see margins`);
    });
  }
  results.push('  ✓ holds need a reason, finance sees customer history, margins are staff only');
};

try {
  await run();
} catch (e) {
  process.exitCode = 1;
  results.push(`  ✗ ${e.message}`);
}
console.log(`Database tests (${readdirSync(join(root, 'migrations')).length} migrations + seed):`);
for (const r of results) console.log(r);

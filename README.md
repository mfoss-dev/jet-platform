# Jet Platform

The rebuild of Jet Worldwide's systems: customer portal, JetStream (billing and back office), JetSales and automations, on one Supabase database.
Built billing first (Phase 1 of Option 3). The screens follow the wireframes and the clickable prototype in the parent folder.

## Stack

- **Next.js 16** (App Router, TypeScript). Read `AGENTS.md` before changing framework code: this version differs from older Next.js.
- **Supabase** (Postgres, Auth, row-level security). Decision D10: Supabase for the whole project.
- Styles are ported from the prototype (`src/app/globals.css`), so screens match the wireframes.

## Environments

| Environment | Web app | Supabase project | Data | Updated |
|---|---|---|---|---|
| Local | `npm run dev` | Test project (no Docker needed) | Test data | As you save |
| Preview | Vercel, one link per pull request | Test project | Test data | Each push to a pull request |
| Test (staging) | Vercel project `enabla-technology/jet-platform` (Vercel calls this "Production") | `kyfqdevrvihtjfugmzrx` | Demo data plus Wayne's reference data | Each merge to `main` |
| Production | Not created yet (its own Vercel and Supabase projects) | Not created yet | Real data only | Approved releases only |

Vercel needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (Production and Preview). Every Vercel address must also be listed in Supabase under **Authentication → URL Configuration → Redirect URLs**, including the preview wildcard `https://jet-platform-*-enabla-technology.vercel.app/**`.

## Run it locally

```bash
npm install
cp .env.example .env.local   # then fill in the Test project's URL and publishable key
npm run dev                  # http://localhost:3000
```

Sign-in is by emailed link. In the Supabase dashboard, **Authentication → URL Configuration** must list `http://localhost:3000/**` as a redirect URL.

## Database

- `supabase/migrations/`: every schema change, in order. Never edit the database by hand; add a migration.
- `supabase/seed.sql`: demo data for local and Test only. Every insert skips rows that already exist, so it's safe to re-run. Note `db push --include-seed` loads it only once; after editing it, run it again with `npx supabase db query --linked -f supabase/seed.sql`.
- **Every new table needs explicit `GRANT`s** in its migration (see `20261102000400_table_privileges.sql`). The hosted project doesn't grant new tables to the API roles automatically, and the tests mirror that, so a missing grant fails `npm run test:db`.
- `npm run test:db`: runs all migrations and the seed in an in-memory Postgres (PGlite), then checks the access rules as management, a sales rep, a customer, an uninvited sign-in and a signed-out visitor.

- `npm run test:api`: after a deploy, checks every query the app sends (listed in `src/lib/selects.ts`) against the real Test API while signed out. A correct query is refused with "permission denied"; a typo, missing column or ambiguous join comes back as a query error. Add new queries to `selects.ts` so they're covered.

Migrations apply to Test automatically on every push to `main` (Supabase's GitHub integration). To apply them by hand instead (after `npx supabase login` and `npx supabase link --project-ref kyfqdevrvihtjfugmzrx`):

```bash
npx supabase db push --linked --include-seed
```

### Access rules (row-level security)

- **Staff** (owner, management, finance, customer service, admin) see every customer and job, including cost and margin.
- **Billing staff** (owner, management, finance, admin) can change billing data.
- **Sales reps** see only their own accounts, never cost or margin.
- **Customers** see only their own account, never cost.
- Everyone reads jobs through the `job_list` view, which applies the row and column rules. Only staff can read the `jobs` table directly.
- Every change to profiles, customers, jobs, reweighs, services and fuel is written to `audit_log` with who made it.

### Users and roles

Staff are invited by adding a row to `user_invites` (email, name, role, branch). Their first sign-in creates their profile with that role. Anyone who signs in without an invite gets a customer profile with no account, so they see nothing.

## Checks

GitHub Actions runs lint, the database tests and a build on every pull request and every push to `main`.

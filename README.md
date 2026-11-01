# Jet Platform

The rebuild of Jet Worldwide's systems: customer portal, JetStream (billing and back office), JetSales and automations, on one Supabase database.
Built billing first (Phase 1 of Option 3). The screens follow the wireframes and the clickable prototype in the parent folder.

## Stack

- **Next.js 16** (App Router, TypeScript). Read `AGENTS.md` before changing framework code: this version differs from older Next.js.
- **Supabase** (Postgres, Auth, row-level security). Decision D10: Supabase for the whole project.
- Styles are ported from the prototype (`src/app/globals.css`), so screens match the wireframes.

## Environments

| Environment | Supabase project | Data | Updated |
|---|---|---|---|
| Local | Test project (no Docker needed) | Test data | As you save |
| Test (staging) | `kyfqdevrvihtjfugmzrx` | Demo data plus Wayne's reference data | When migrations are pushed or merged |
| Production | Not created yet | Real data only | Approved releases only |

## Run it locally

```bash
npm install
cp .env.example .env.local   # then fill in the Test project's URL and publishable key
npm run dev                  # http://localhost:3000
```

Sign-in is by emailed link. In the Supabase dashboard, **Authentication → URL Configuration** must list `http://localhost:3000/**` as a redirect URL.

## Database

- `supabase/migrations/`: every schema change, in order. Never edit the database by hand; add a migration.
- `supabase/seed.sql`: demo data for local and Test only.
- `npm run test:db`: runs all migrations and the seed in an in-memory Postgres (PGlite), then checks the access rules as management, a sales rep, a customer, an uninvited sign-in and a signed-out visitor.

Apply migrations to the Test project (after `npx supabase login` and `npx supabase link --project-ref kyfqdevrvihtjfugmzrx`):

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

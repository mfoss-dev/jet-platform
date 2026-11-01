-- Foundation: branches, roles, user profiles, invitations and the audit log.
-- Every later table relies on the helper functions in the `private` schema for row-level security.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------- branches
create table public.branches (
  code text primary key check (code in ('AU', 'NZ')),
  name text not null,
  currency text not null check (currency in ('AUD', 'NZD')),
  gst_rate numeric(5, 4) not null check (gst_rate between 0 and 1),
  timezone text not null
);
comment on table public.branches is 'Jet Worldwide trading branches. Same system and workflows; currency, GST and invoice layout differ (Decision D14).';

insert into public.branches (code, name, currency, gst_rate, timezone) values
  ('AU', 'Sydney', 'AUD', 0.10, 'Australia/Sydney'),
  ('NZ', 'Auckland', 'NZD', 0.15, 'Pacific/Auckland');

-- ---------------------------------------------------------------- roles
create type public.app_role as enum (
  'owner',             -- Kym
  'management',        -- Chris, Nigel
  'finance',           -- Monica, Maree
  'customer_service',
  'sales_rep',         -- JetSales: own accounts only
  'admin',             -- Enabla support
  'customer_admin',    -- customer portal: manages their company's users
  'customer_user'
);

-- ---------------------------------------------------------------- profiles
-- One row per sign-in (auth.users). Customer roles must point at a customer; staff roles must not.
-- The customer_id foreign key is added in the billing migration, once public.customers exists.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null default '',
  role public.app_role not null default 'customer_user',
  branch_code text references public.branches (code),
  customer_id uuid,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index profiles_customer_id_idx on public.profiles (customer_id);

-- Staff are invited by email. When that person first signs in, their profile is created from the invite.
create table public.user_invites (
  email text primary key check (email = lower(email)),
  full_name text not null,
  role public.app_role not null,
  branch_code text references public.branches (code),
  customer_id uuid,
  invited_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- helpers (used by RLS everywhere)
create or replace function private.my_role() returns public.app_role
language sql stable security definer set search_path = '' as $$
  select role from public.profiles where id = (select auth.uid()) and active
$$;

create or replace function private.my_customer_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select customer_id from public.profiles where id = (select auth.uid()) and active
$$;

-- Staff who see everything, including cost and margin. Sales reps are deliberately excluded.
create or replace function private.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.my_role() in ('owner', 'management', 'finance', 'customer_service', 'admin'), false)
$$;

-- Staff who can change billing data: prices, holds, reweigh decisions, tariffs.
create or replace function private.can_edit_billing() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.my_role() in ('owner', 'management', 'finance', 'admin'), false)
$$;

create or replace function private.can_manage_users() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.my_role() in ('owner', 'management', 'admin'), false)
$$;

grant execute on all functions in schema private to authenticated, service_role;

-- ---------------------------------------------------------------- updated_at
create or replace function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger profiles_touch before update on public.profiles
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------- new sign-ins
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  inv public.user_invites;
begin
  select * into inv from public.user_invites where email = lower(new.email);
  insert into public.profiles (id, email, full_name, role, branch_code, customer_id)
  values (
    new.id,
    lower(new.email),
    coalesce(inv.full_name, new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(inv.role, 'customer_user'),
    inv.branch_code,
    inv.customer_id
  );
  delete from public.user_invites where email = lower(new.email);
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------- audit log
-- Who changed what, before and after. Screen changes and (later) every MCP question land here.
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid,
  actor_email text,
  table_name text not null,
  row_id text,
  action text not null check (action in ('insert', 'update', 'delete', 'ai_query')),
  before jsonb,
  after jsonb
);
create index audit_log_at_idx on public.audit_log (at desc);
create index audit_log_table_row_idx on public.audit_log (table_name, row_id);

create or replace function private.audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  old_row jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  new_row jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
begin
  if tg_op = 'UPDATE' and old_row = new_row then
    return new;
  end if;
  insert into public.audit_log (actor_id, actor_email, table_name, row_id, action, before, after)
  values (
    (select auth.uid()),
    (select auth.jwt() ->> 'email'),
    tg_table_name,
    coalesce(new_row ->> 'id', old_row ->> 'id', new_row ->> 'code', old_row ->> 'code'),
    lower(tg_op),
    old_row,
    new_row
  );
  return coalesce(new, old);
end $$;

create trigger profiles_audit after insert or update or delete on public.profiles
  for each row execute function private.audit();

-- ---------------------------------------------------------------- row-level security
alter table public.branches enable row level security;
alter table public.profiles enable row level security;
alter table public.user_invites enable row level security;
alter table public.audit_log enable row level security;

create policy "Signed-in users read branches" on public.branches
  for select to authenticated using (true);

create policy "Read own profile" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "Staff read all profiles" on public.profiles
  for select to authenticated using ((select private.is_staff()));
create policy "Customer admins read their company's profiles" on public.profiles
  for select to authenticated
  using ((select private.my_role()) = 'customer_admin' and customer_id = (select private.my_customer_id()));
create policy "User managers update profiles" on public.profiles
  for update to authenticated
  using ((select private.can_manage_users())) with check ((select private.can_manage_users()));

create policy "User managers manage invites" on public.user_invites
  for all to authenticated
  using ((select private.can_manage_users())) with check ((select private.can_manage_users()));

create policy "Managers read the audit log" on public.audit_log
  for select to authenticated using ((select private.can_manage_users()));
-- No insert/update/delete policies: only the audit trigger (security definer) writes, and nobody edits history.

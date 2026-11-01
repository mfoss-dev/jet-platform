-- Billing core (Phase 1, billing first): customers, carriers and services, jobs, reweighs, fuel surcharges.
-- All money is ex GST, in the branch's currency. GST is applied at invoice time from public.branches.

-- ---------------------------------------------------------------- customers
create type public.customer_status as enum ('active', 'on_hold', 'closed');

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  account_code text not null unique,            -- e.g. SYD1021, AKL2033
  name text not null,
  branch_code text not null references public.branches (code),
  status public.customer_status not null default 'active',
  payment_terms_days integer not null default 14 check (payment_terms_days between 0 and 120),
  billing_email text,
  rep_id uuid references public.profiles (id) on delete set null,   -- JetSales account owner
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customers_rep_id_idx on public.customers (rep_id);

alter table public.profiles
  add constraint profiles_customer_id_fkey foreign key (customer_id) references public.customers (id) on delete set null,
  add constraint profiles_customer_role_check check (customer_id is null or role in ('customer_admin', 'customer_user'));
alter table public.user_invites
  add constraint user_invites_customer_id_fkey foreign key (customer_id) references public.customers (id) on delete cascade;

-- Which customers can the signed-in person see? Staff: all. Reps: their accounts. Customers: their own.
create or replace function private.can_see_customer(cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when private.is_staff() then true
    when private.my_role() = 'sales_rep' then exists (
      select 1 from public.customers c where c.id = cid and c.rep_id = (select auth.uid()))
    when private.my_role() in ('customer_admin', 'customer_user') then cid = private.my_customer_id()
    else false
  end
$$;
grant execute on function private.can_see_customer(uuid) to authenticated;

-- ---------------------------------------------------------------- carriers and services
create table public.carriers (
  code text primary key,                         -- DHL, TNT, FEDEX, STARTRACK, ARAMEX
  name text not null,
  active boolean not null default true
);

create table public.services (
  id uuid primary key default gen_random_uuid(),
  carrier_code text not null references public.carriers (code),
  code text not null,
  name text not null,
  active boolean not null default true,
  unique (carrier_code, code)
);

-- ---------------------------------------------------------------- fuel surcharges
-- One row per carrier per change; the rate in force is the latest effective_from on or before the job date.
create table public.fuel_surcharges (
  id uuid primary key default gen_random_uuid(),
  carrier_code text not null references public.carriers (code),
  rate_pct numeric(5, 2) not null check (rate_pct between 0 and 100),
  effective_from date not null,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (carrier_code, effective_from)
);

-- ---------------------------------------------------------------- jobs
create type public.job_status as enum ('booked', 'in_transit', 'delivered', 'exception', 'cancelled');
create type public.billing_status as enum ('needs_attention', 'ready', 'on_hold', 'invoiced');
create type public.billing_issue as enum ('reweigh', 'below_cost', 'no_rate', 'remote_area', 'address_fee', 'manual_job', 'missing_fuel', 'duties');

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  connote text not null unique,
  customer_id uuid not null references public.customers (id),
  branch_code text not null references public.branches (code),
  carrier_code text not null references public.carriers (code),
  service_id uuid references public.services (id),
  booked_at timestamptz not null default now(),
  origin_city text,
  origin_country text check (origin_country ~ '^[A-Z]{2}$'),
  dest_city text,
  dest_country text check (dest_country ~ '^[A-Z]{2}$'),
  pieces integer not null default 1 check (pieces > 0),
  declared_weight_kg numeric(10, 2) check (declared_weight_kg >= 0),
  carrier_weight_kg numeric(10, 2) check (carrier_weight_kg >= 0),
  sell_ex_gst numeric(12, 2),                    -- what the customer is charged
  cost_ex_gst numeric(12, 2),                    -- what the carrier charges Jet: staff only
  status public.job_status not null default 'booked',
  billing_status public.billing_status not null default 'needs_attention',
  issue public.billing_issue,
  issue_note text,
  customer_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_customer_id_idx on public.jobs (customer_id);
create index jobs_billing_status_idx on public.jobs (billing_status, booked_at desc);
create index jobs_booked_at_idx on public.jobs (booked_at desc);

-- ---------------------------------------------------------------- reweighs
create type public.reweigh_decision as enum ('pending', 'pass_on', 'absorb', 'dispute');

create table public.reweighs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id) on delete cascade,
  source_file text,                              -- e.g. the DHL daily reweigh file name
  declared_kg numeric(10, 2) not null,
  carrier_kg numeric(10, 2) not null,
  extra_charge numeric(12, 2) not null default 0,
  decision public.reweigh_decision not null default 'pending',
  decision_note text,
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check ((decision = 'pending') = (decided_at is null))
);
create index reweighs_job_id_idx on public.reweighs (job_id);
create index reweighs_pending_idx on public.reweighs (created_at desc) where decision = 'pending';

-- ---------------------------------------------------------------- timestamps and audit
create trigger customers_touch before update on public.customers for each row execute function private.touch_updated_at();
create trigger jobs_touch before update on public.jobs for each row execute function private.touch_updated_at();

create trigger customers_audit after insert or update or delete on public.customers for each row execute function private.audit();
create trigger jobs_audit after insert or update or delete on public.jobs for each row execute function private.audit();
create trigger reweighs_audit after insert or update or delete on public.reweighs for each row execute function private.audit();
create trigger fuel_audit after insert or update or delete on public.fuel_surcharges for each row execute function private.audit();
create trigger services_audit after insert or update or delete on public.services for each row execute function private.audit();

-- ---------------------------------------------------------------- row-level security
alter table public.customers enable row level security;
alter table public.carriers enable row level security;
alter table public.services enable row level security;
alter table public.fuel_surcharges enable row level security;
alter table public.jobs enable row level security;
alter table public.reweighs enable row level security;

create policy "Read visible customers" on public.customers
  for select to authenticated using ((select private.can_see_customer(id)));
create policy "Billing staff edit customers" on public.customers
  for all to authenticated
  using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));

create policy "Signed-in users read carriers" on public.carriers for select to authenticated using (true);
create policy "Signed-in users read services" on public.services for select to authenticated using (true);
create policy "Billing staff edit carriers" on public.carriers
  for all to authenticated using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));
create policy "Billing staff edit services" on public.services
  for all to authenticated using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));

create policy "Signed-in users read fuel surcharges" on public.fuel_surcharges for select to authenticated using (true);
create policy "Billing staff edit fuel surcharges" on public.fuel_surcharges
  for all to authenticated using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));

-- The jobs table holds cost, so only staff read it directly. Customers and reps use public.job_list.
create policy "Staff read jobs" on public.jobs for select to authenticated using ((select private.is_staff()));
create policy "Billing staff edit jobs" on public.jobs
  for all to authenticated using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));

create policy "Staff read reweighs" on public.reweighs for select to authenticated using ((select private.is_staff()));
create policy "Billing staff decide reweighs" on public.reweighs
  for all to authenticated using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));

-- ---------------------------------------------------------------- job_list view
-- The one way everyone reads jobs. Rows: whatever private.can_see_customer allows.
-- Columns: cost and margin only for staff; customers and reps get null (the MCP design's column rule).
-- Runs as the view owner (not security_invoker) so it can apply that column rule itself;
-- the WHERE clause is what keeps rows private, so keep it when editing this view.
create view public.job_list with (security_barrier = true) as
select
  j.id,
  j.connote,
  j.customer_id,
  c.account_code,
  c.name as customer_name,
  j.branch_code,
  j.carrier_code,
  s.name as service_name,
  j.booked_at,
  j.origin_city,
  j.origin_country,
  j.dest_city,
  j.dest_country,
  j.pieces,
  j.declared_weight_kg,
  j.carrier_weight_kg,
  j.sell_ex_gst,
  case when private.is_staff() then j.cost_ex_gst end as cost_ex_gst,
  case when private.is_staff() and j.sell_ex_gst > 0 and j.cost_ex_gst is not null
       then round((j.sell_ex_gst - j.cost_ex_gst) / j.sell_ex_gst * 100, 1) end as margin_pct,
  j.status,
  j.billing_status,
  j.issue,
  j.issue_note,
  j.customer_reference
from public.jobs j
join public.customers c on c.id = j.customer_id
left join public.services s on s.id = j.service_id
where private.can_see_customer(j.customer_id);

revoke all on public.job_list from anon;
grant select on public.job_list to authenticated;

-- Nothing in this schema is for signed-out visitors.
revoke all on all tables in schema public from anon;

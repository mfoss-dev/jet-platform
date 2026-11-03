-- JetSales, part 1: sales performance (commission comes later, once Chris's plan rules are in).
--   * sales_reps: JetStream's rep codes (SalesRep), each optionally linked to the rep's sign-in so they see their own
--     accounts. HOUSE-type codes earn no commission and have no rep to alert.
--   * customers.sales_rep_code: one rep per account, as in JetStream (Customer.SalesRepCode); first_trade_date from
--     JetStream says when an account became a customer.
--   * Sales are ex GST: freight, fuel, security and add-ons, by ship date, not yet-invoiced work included (so this
--     week counts), approved credit notes taken off. Customs duties are left out by default (a pass-through), and
--     JetStream's unpriced placeholder and do-not-bill lines never count.
--   * Reps see only their own accounts; management and finance see everyone. Customers see none of this.

create table public.sales_reps (
  code text primary key,
  name text not null,
  branch_code text references public.branches (code),
  is_house boolean not null default false,          -- the office's own accounts: no commission
  profile_id uuid references public.profiles (id),  -- the rep's sign-in, when they have one
  active boolean not null default true,
  source text
);
alter table public.customers
  add column sales_rep_code text references public.sales_reps (code) on update cascade,
  add column first_trade_date date;
create index customers_sales_rep on public.customers (sales_rep_code);
create index charges_sales on public.charges (customer_id, shipped_on);

create trigger sales_reps_audit after insert or update or delete on public.sales_reps for each row execute function private.audit();
alter table public.sales_reps enable row level security;
create policy "Staff and reps read sales reps" on public.sales_reps for select to authenticated
  using ((select private.is_staff()) or profile_id = (select auth.uid()));
grant select on public.sales_reps to authenticated;
grant all on public.sales_reps to service_role;

-- Reps see the accounts on their rep code as well as any assigned to them directly (rep_id).
create or replace function private.can_see_customer(cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when private.is_staff() then true
    when private.my_role() = 'sales_rep' then exists (
      select 1 from public.customers c left join public.sales_reps r on r.code = c.sales_rep_code
       where c.id = cid and (c.rep_id = (select auth.uid()) or r.profile_id = (select auth.uid())))
    when private.my_role() in ('customer_admin', 'customer_user') then cid = private.my_customer_id()
    else false
  end
$$;

-- The rep code(s) the signed-in rep works under.
create or replace function private.my_rep_codes() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(code), '{}') from public.sales_reps where profile_id = (select auth.uid())
$$;

-- The day sales figures run to: today, or the last day there are shipments if the data stops earlier (Test).
create or replace function private.sales_as_of() returns date
language sql stable security definer set search_path = '' as $$
  select least((now() at time zone 'Australia/Sydney')::date, coalesce(max(shipped_on), (now() at time zone 'Australia/Sydney')::date))
    from public.charges where status <> 'no_bill' and charge < 999000
$$;

-- Accounts the signed-in person may see in JetSales: staff all, reps their own.
create or replace function private.sales_accounts_visible() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select c.id from public.customers c
   where private.is_staff()
      or (private.my_role() = 'sales_rep' and (c.sales_rep_code = any (private.my_rep_codes()) or c.rep_id = (select auth.uid())))
$$;

-- Sales lines that count, for the visible accounts.
create or replace function private.sales_lines(p_include_duties boolean)
returns table (customer_id uuid, connote text, shipped_on date, amount numeric)
language sql stable security definer set search_path = '' as $$
  select ch.customer_id, ch.connote, ch.shipped_on, ch.charge + ch.fuel + ch.security
    from public.charges ch
   where ch.customer_id in (select private.sales_accounts_visible())
     and ch.status <> 'no_bill' and ch.charge < 999000
     and (p_include_duties or ch.kind = 'freight')
     and (ch.credit_of is null or ch.status = 'invoiced')     -- approved credit notes only
$$;

-- One row per account: rep, recent sales, and its health.
--   new: became a customer in the last 90 days · lost: nothing for 60 days · quiet: nothing for 14 days
--   at_risk: last 4 weeks down more than 30% on the 4 before · growing: up more than 30% · steady otherwise
create or replace function public.sales_accounts(p_include_duties boolean default false)
returns table (
  customer_id uuid, account_code text, name text, branch_code text, status text, rep_code text, rep_name text, is_house boolean,
  first_trade_date date, first_shipped date, last_shipped date, as_of date,
  sales_4w numeric, sales_prev_4w numeric, sales_13w numeric, sales_total numeric, shipments_4w integer, shipments_13w integer, health text
)
language sql stable security definer set search_path = '' as $$
  with d as (select private.sales_as_of() as as_of),
  l as (select * from private.sales_lines(p_include_duties)),
  a as (
    select l.customer_id, min(l.shipped_on) as first_shipped, max(l.shipped_on) as last_shipped,
           coalesce(sum(l.amount) filter (where l.shipped_on > d.as_of - 28), 0) as s4,
           coalesce(sum(l.amount) filter (where l.shipped_on > d.as_of - 56 and l.shipped_on <= d.as_of - 28), 0) as p4,
           coalesce(sum(l.amount) filter (where l.shipped_on > d.as_of - 91), 0) as s13,
           sum(l.amount) as total,
           (count(distinct l.connote) filter (where l.shipped_on > d.as_of - 28))::integer as n4,
           (count(distinct l.connote) filter (where l.shipped_on > d.as_of - 91))::integer as n13
      from l, d where l.shipped_on <= d.as_of group by l.customer_id
  )
  select c.id, c.account_code, c.name, c.branch_code, c.status::text, c.sales_rep_code, r.name, coalesce(r.is_house, false),
         c.first_trade_date, a.first_shipped, a.last_shipped, d.as_of,
         coalesce(a.s4, 0), coalesce(a.p4, 0), coalesce(a.s13, 0), coalesce(a.total, 0), coalesce(a.n4, 0), coalesce(a.n13, 0),
         case
           when a.customer_id is null then 'none'
           when c.first_trade_date > d.as_of - 90 then 'new'
           when a.last_shipped <= d.as_of - 60 then 'lost'
           when a.last_shipped <= d.as_of - 14 then 'quiet'
           when a.p4 > 0 and a.s4 < 0.7 * a.p4 then 'at_risk'
           when a.p4 > 0 and a.s4 > 1.3 * a.p4 then 'growing'
           else 'steady'
         end
    from public.customers c
    join (select private.sales_accounts_visible() as id) v on v.id = c.id
    cross join d
    left join a on a.customer_id = c.id
    left join public.sales_reps r on r.code = c.sales_rep_code
$$;

-- Weekly sales (weeks start Monday) for the last p_weeks, per rep, for the visible accounts.
create or replace function public.sales_weekly(p_weeks integer default 13, p_include_duties boolean default false)
returns table (week_start date, rep_code text, sales numeric, shipments integer)
language sql stable security definer set search_path = '' as $$
  with d as (select private.sales_as_of() as as_of)
  select date_trunc('week', l.shipped_on)::date, c.sales_rep_code, sum(l.amount), count(distinct l.connote)::integer
    from private.sales_lines(p_include_duties) l join public.customers c on c.id = l.customer_id, d
   where l.shipped_on <= d.as_of and l.shipped_on >= date_trunc('week', d.as_of)::date - 7 * (least(greatest(p_weeks, 1), 104) - 1)
   group by 1, 2
$$;

-- Management links a rep code to the rep's sign-in, or marks it as house.
create or replace function public.set_sales_rep(p_code text, p_profile uuid, p_is_house boolean, p_active boolean default true)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.can_manage_users() then raise exception 'Only management can change sales reps' using errcode = '42501'; end if;
  if p_profile is not null and not exists (select 1 from public.profiles where id = p_profile and role in ('sales_rep', 'management', 'owner')) then
    raise exception 'Link a rep code to someone with the Sales rep role';
  end if;
  update public.sales_reps set profile_id = p_profile, is_house = p_is_house, active = p_active where code = p_code;
  if not found then raise exception 'No rep code %', p_code; end if;
end $$;

-- Move accounts to another rep (logged). Commission plans and start dates will hang off this later.
create or replace function public.assign_sales_rep(p_customers uuid[], p_code text)
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if not private.can_manage_users() then raise exception 'Only management can move accounts between reps' using errcode = '42501'; end if;
  if not exists (select 1 from public.sales_reps where code = p_code) then raise exception 'No rep code %', p_code; end if;
  update public.customers set sales_rep_code = p_code where id = any (p_customers) and sales_rep_code is distinct from p_code;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function private.my_rep_codes(), private.sales_as_of(), private.sales_accounts_visible(), private.sales_lines(boolean) from public, anon;
grant execute on function private.my_rep_codes(), private.sales_as_of(), private.sales_accounts_visible(), private.sales_lines(boolean) to authenticated;
revoke all on function public.sales_accounts(boolean), public.sales_weekly(integer, boolean), public.set_sales_rep(text, uuid, boolean, boolean),
  public.assign_sales_rep(uuid[], text) from public, anon;
grant execute on function public.sales_accounts(boolean), public.sales_weekly(integer, boolean), public.set_sales_rep(text, uuid, boolean, boolean),
  public.assign_sales_rep(uuid[], text) to authenticated;


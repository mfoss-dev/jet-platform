-- Pricing review: helps finance standardise sales tariffs.
--   * billed_shipments: the jobs JetStream billed (automatically rated), so a tariff change can be tried on real work
--   * sales_tariffs.is_standard: the tariff a branch and service should normally use
--   * sales_tariff_review: each tariff's customers, last 12 months' jobs and freight, and margin spread
--   * tariff_switch_preview(): what each customer on one tariff would pay on another, on their own recent jobs
--   * move_customers_to_tariff(): move chosen customers from a start date (jobs before it keep their price)

create table public.billed_shipments (
  connote text primary key,
  customer_id uuid not null references public.customers (id) on delete cascade,
  branch_code text not null references public.branches (code),
  service_code text not null,
  shipped_on date not null,
  kind text not null check (kind in ('doc', 'parcel')),
  orig_country text not null default '',
  orig_postcode text not null default '',
  dest_country text not null default '',
  dest_postcode text not null default '',
  weight numeric(10, 3) not null,       -- chargeable weight as billed
  freight numeric(12, 2) not null,      -- the freight line as billed (before fuel and add-ons)
  source text not null default 'jetstream'
);
create index billed_shipments_customer on public.billed_shipments (customer_id, service_code, shipped_on);

alter table public.billed_shipments enable row level security;
create policy "Staff read billed shipments" on public.billed_shipments for select to authenticated using ((select private.is_staff()));
grant select on public.billed_shipments to authenticated;
grant all on public.billed_shipments to service_role;

alter table public.sales_tariffs add column is_standard boolean not null default false;
create unique index sales_tariffs_one_standard on public.sales_tariffs (branch_code, coalesce(service_code, '')) where is_standard;
create index if not exists customer_tariffs_sales on public.customer_tariffs (sales_tariff_id);

-- One row per sales tariff, for spotting outliers. Runs as the caller (staff only).
create view public.sales_tariff_review with (security_invoker = true) as
select s.id, s.code, s.name, s.branch_code, s.service_code, s.is_standard, s.base_tariff_id, b.code as rate_card,
       coalesce(u.customers, 0) as customers,
       m.cells, m.min_margin, m.avg_margin, m.max_margin, m.distinct_margins,
       coalesce(h.jobs, 0) as jobs_12m, coalesce(h.freight, 0) as freight_12m
  from public.sales_tariffs s
  join public.base_tariffs b on b.id = s.base_tariff_id
  left join public.sales_tariff_usage u on u.sales_tariff_id = s.id
  left join lateral (
    select count(*)::integer as cells, min(margin_pct) as min_margin, round(avg(margin_pct), 1) as avg_margin,
           max(margin_pct) as max_margin, count(distinct margin_pct)::integer as distinct_margins
      from public.sales_margins where sales_tariff_id = s.id
  ) m on true
  left join lateral (
    select count(*)::integer as jobs, sum(bs.freight) as freight
      from public.customer_tariffs ct
      join public.billed_shipments bs on bs.customer_id = ct.customer_id and bs.service_code = ct.service_code
       and bs.shipped_on between ct.effective_from and coalesce(ct.effective_to, '9999-12-31')
     where ct.sales_tariff_id = s.id and bs.shipped_on > current_date - 365
  ) h on true;
grant select on public.sales_tariff_review to authenticated;

-- Freight for a shipment on a given sales tariff (rather than the customer's own), at that date's published rate card.
create or replace function public.price_on_tariff(p_sales uuid, p_customer uuid, p_orig_country text, p_orig_postcode text,
  p_dest_country text, p_dest_postcode text, p_kind text, p_weight numeric, p_date date default current_date)
returns numeric
language plpgsql stable security invoker set search_path = '' as $$
declare
  bt public.base_tariffs;
  v uuid;
  z text;
begin
  select b.* into bt from public.sales_tariffs s join public.base_tariffs b on b.id = s.base_tariff_id where s.id = p_sales;
  select id into v from public.tariff_versions where tariff_id = bt.id and status = 'published' and valid_from <= p_date order by valid_from desc limit 1;
  if v is null then return null; end if;
  z := public.find_zone(bt.zone_set_id, p_customer, p_orig_country, p_orig_postcode, p_dest_country, p_dest_postcode);
  if z is null then return null; end if;
  return public.freight_charge(v, p_sales, z, p_kind, p_weight);
end $$;

-- For every customer on p_from today: their jobs since p_since, what was billed, and the freight today's rate cards give
-- on p_from and on p_to. Current and new are summed over the same jobs (those both tariffs can price), so they compare
-- like for like; "unpriced" counts jobs either tariff can't price (no zone, rate or margin).
create or replace function public.tariff_switch_preview(p_from uuid, p_to uuid, p_since date default current_date - 365)
returns table (customer_id uuid, name text, account_code text, service_code text, jobs integer, billed numeric,
               current_price numeric, new_price numeric, unpriced integer)
language sql stable security invoker set search_path = '' as $$
  with tf as (
    select s.id as sales_id, b.zone_set_id,
           (select v.id from public.tariff_versions v where v.tariff_id = b.id and v.status = 'published' and v.valid_from <= current_date
             order by v.valid_from desc limit 1) as version_id
      from public.sales_tariffs s join public.base_tariffs b on b.id = s.base_tariff_id
     where s.id in (p_from, p_to)
  ),
  on_it as (
    select distinct ct.customer_id, ct.service_code from public.customer_tariffs ct
     where ct.sales_tariff_id = p_from and ct.effective_from <= current_date and (ct.effective_to is null or ct.effective_to >= current_date)
  ),
  j as (
    select bs.* from public.billed_shipments bs join on_it o on o.customer_id = bs.customer_id and o.service_code = bs.service_code
     where bs.shipped_on >= p_since
  ),
  lanes as (
    select distinct j.customer_id, j.orig_country, j.orig_postcode, j.dest_country, j.dest_postcode, z.zone_set_id
      from j cross join (select distinct zone_set_id from tf) z
  ),
  zoned as (
    select l.*, public.find_zone(l.zone_set_id, l.customer_id, l.orig_country, l.orig_postcode, l.dest_country, l.dest_postcode) as zone_code from lanes l
  ),
  job_zone as (
    select j.connote, j.kind, j.weight, tf.sales_id, tf.version_id, z.zone_code
      from j cross join tf
      join zoned z on z.zone_set_id = tf.zone_set_id and z.customer_id = j.customer_id and z.orig_country = j.orig_country
       and z.orig_postcode = j.orig_postcode and z.dest_country = j.dest_country and z.dest_postcode = j.dest_postcode
  ),
  cells as (
    select d.*, case when d.version_id is not null and d.zone_code is not null
                     then public.freight_charge(d.version_id, d.sales_id, d.zone_code, d.kind, d.weight) end as price
      from (select distinct sales_id, version_id, zone_code, kind, weight from job_zone) d
  ),
  per_job as (
    select jz.connote,
           max(c.price) filter (where jz.sales_id = p_from) as cur,
           max(c.price) filter (where jz.sales_id = p_to) as new
      from job_zone jz
      join cells c on c.sales_id = jz.sales_id and c.version_id is not distinct from jz.version_id
       and c.zone_code is not distinct from jz.zone_code and c.kind = jz.kind and c.weight = jz.weight
     group by jz.connote
  )
  select o.customer_id, cu.name, cu.account_code, o.service_code, count(j.connote)::integer, coalesce(sum(j.freight), 0),
         coalesce(sum(p.cur) filter (where p.cur is not null and p.new is not null), 0),
         coalesce(sum(p.new) filter (where p.cur is not null and p.new is not null), 0),
         (count(j.connote) filter (where p.cur is null or p.new is null))::integer
    from on_it o
    join public.customers cu on cu.id = o.customer_id
    left join j on j.customer_id = o.customer_id and j.service_code = o.service_code
    left join per_job p on p.connote = j.connote
   group by o.customer_id, cu.name, cu.account_code, o.service_code
   order by coalesce(sum(j.freight), 0) desc, cu.name
$$;

-- Move customers from one sales tariff to another from a start date (today or later). Their current assignment ends the
-- day before; the new one keeps their volumetric divisor and end date. One audit entry per move, plus the row changes.
create or replace function public.move_customers_to_tariff(p_from uuid, p_to uuid, p_customers uuid[], p_date date)
returns integer
language plpgsql security invoker set search_path = '' as $$
declare
  f public.sales_tariffs;
  t public.sales_tariffs;
  r public.customer_tariffs;
  n integer := 0;
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can move customers between tariffs' using errcode = '42501';
  end if;
  select * into f from public.sales_tariffs where id = p_from;
  select * into t from public.sales_tariffs where id = p_to;
  if f.id is null or t.id is null then raise exception 'Unknown sales tariff'; end if;
  if f.id = t.id then raise exception 'Choose a different tariff to move to'; end if;
  if f.branch_code <> t.branch_code then raise exception 'Both tariffs must belong to the same branch'; end if;
  if p_date is null or p_date < current_date then raise exception 'The move must start today or later, so jobs already billed keep their price'; end if;

  for r in
    select * from public.customer_tariffs ct
     where ct.sales_tariff_id = p_from and ct.customer_id = any(p_customers)
       and ct.effective_from <= p_date and (ct.effective_to is null or ct.effective_to >= p_date)
  loop
    continue when t.service_code is not null and t.service_code <> r.service_code;
    if r.effective_from = p_date then
      update public.customer_tariffs set sales_tariff_id = p_to
       where customer_id = r.customer_id and service_code = r.service_code and effective_from = r.effective_from;
    else
      update public.customer_tariffs set effective_to = p_date - 1
       where customer_id = r.customer_id and service_code = r.service_code and effective_from = r.effective_from;
      insert into public.customer_tariffs (customer_id, service_code, effective_from, effective_to, sales_tariff_id, volumetric_divisor)
      values (r.customer_id, r.service_code, p_date, r.effective_to, p_to, r.volumetric_divisor);
    end if;
    n := n + 1;
  end loop;
  if n > 0 then
    perform private.log_change('customer_tariffs', p_to::text,
      jsonb_build_object('moved_from', f.code, 'moved_to', t.code, 'customers', n, 'starting', p_date));
  end if;
  return n;
end $$;

-- Mark a tariff as the standard for its branch and service (only one per branch and service).
create or replace function public.set_standard_tariff(p_sales uuid, p_standard boolean default true)
returns void
language plpgsql security invoker set search_path = '' as $$
declare
  s public.sales_tariffs;
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can choose standard tariffs' using errcode = '42501';
  end if;
  select * into s from public.sales_tariffs where id = p_sales;
  if s.id is null then raise exception 'Unknown sales tariff'; end if;
  if p_standard then
    update public.sales_tariffs set is_standard = false
     where is_standard and branch_code = s.branch_code and coalesce(service_code, '') = coalesce(s.service_code, '') and id <> s.id;
  end if;
  update public.sales_tariffs set is_standard = p_standard where id = p_sales;
end $$;

revoke all on function public.price_on_tariff(uuid, uuid, text, text, text, text, text, numeric, date),
  public.tariff_switch_preview(uuid, uuid, date), public.move_customers_to_tariff(uuid, uuid, uuid[], date),
  public.set_standard_tariff(uuid, boolean) from public, anon;
grant execute on function public.price_on_tariff(uuid, uuid, text, text, text, text, text, numeric, date),
  public.tariff_switch_preview(uuid, uuid, date), public.move_customers_to_tariff(uuid, uuid, uuid[], date),
  public.set_standard_tariff(uuid, boolean) to authenticated;

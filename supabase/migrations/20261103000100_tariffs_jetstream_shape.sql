-- Tariffs reshaped to match Jet's real data (restored JetStream backup, 2 Nov 2026):
--   * rates are stored per zone (domestic cards use different weight breaks in different zones)
--   * every rate card has its own zone guide: postcode/country -> zone group, origin group x destination group -> zone
--   * rates carry a basic charge and a minimum (TNT road: basic + per kg, with a floor)
--   * margins are set per rate row (zone, documents/parcels, weight break), as JetStream's SalesTariff does
--   * tariffs, sales tariffs and customer assignments are per Jet service (international outbound express, ...)
-- Pricing reproduces JetStream's Rating.vb (GetFreightCharge / CalculateFreightCharge) so imported rates price the same.

drop function if exists public.save_tariff_draft(uuid, jsonb, text);
drop function if exists public.tariff_charge(uuid, text, text, numeric);
drop function if exists public.price_shipment(uuid, text, text, numeric, date);
drop function if exists public.new_tariff_draft(uuid);
drop function if exists public.create_rate_card(text, text, text, text, uuid, uuid);
drop table public.tariff_cells;
drop table public.tariff_breaks;
drop table public.sales_margins;
drop table public.customer_tariffs;

-- Imports set jet.importing so bulk loads don't write one audit row per tariff row.
create or replace function private.audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  old_row jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  new_row jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  r jsonb := coalesce(new_row, old_row);
begin
  if (tg_op = 'UPDATE' and old_row = new_row) or current_setting('jet.importing', true) = 'on' then
    return coalesce(new, old);
  end if;
  insert into public.audit_log (actor_id, actor_email, table_name, row_id, action, before, after)
  values ((select auth.uid()), (select auth.jwt() ->> 'email'), tg_table_name,
          coalesce(r ->> 'id', r ->> 'code', concat_ws('/', r ->> 'customer_id', r ->> 'service_code', r ->> 'effective_from')),
          lower(tg_op), old_row, new_row);
  return coalesce(new, old);
end $$;

-- ---------------------------------------------------------------- services (Jet's products, carrier-neutral)
create table public.tariff_services (
  code text primary key,                    -- JetStream ServiceCode, e.g. INTOUTEXP
  name text not null
);
insert into public.tariff_services (code, name) values
  ('INTOUTEXP', 'International outbound express'), ('INTINBEXP', 'International inbound express'),
  ('DOMESTEXP', 'Domestic express'), ('DOMESTROAD', 'Domestic road'), ('DOMESTASAP', 'Domestic next flight');

-- ---------------------------------------------------------------- zone guides
create table public.zone_sets (
  id uuid primary key default gen_random_uuid(),
  branch_code text not null references public.branches (code),
  code text not null,                       -- JetStream SalesZoneTypeCode, e.g. DHLINTOUT1310
  name text not null,
  unique (branch_code, code)
);

-- Postcode (or country) ranges that make up a zone group. International groups are usually a whole country.
create table public.zone_groups (
  zone_set_id uuid not null references public.zone_sets (id) on delete cascade,
  country_code text not null,
  range_from numeric not null,
  range_to numeric not null,
  group_code text not null
);
create index zone_groups_lookup on public.zone_groups (zone_set_id, country_code, range_from, range_to);

-- Origin group x destination group -> zone. customer_id set = that customer's own override (checked first).
create table public.zone_lanes (
  zone_set_id uuid not null references public.zone_sets (id) on delete cascade,
  customer_id uuid references public.customers (id) on delete cascade,
  orig_group text not null,
  dest_group text not null,
  zone_code text not null
);
create unique index zone_lanes_unique on public.zone_lanes (zone_set_id, coalesce(customer_id, '00000000-0000-0000-0000-000000000000'), orig_group, dest_group);

alter table public.base_tariffs
  add column zone_set_id uuid references public.zone_sets (id),
  add column service_code text references public.tariff_services (code),
  add column cost_only boolean not null default false;   -- carrier cost cards ("use for comparison only")
alter table public.base_tariffs drop constraint base_tariffs_code_key;
alter table public.base_tariffs add constraint base_tariffs_branch_code_key unique (branch_code, code);

alter table public.tariff_versions add column volumetric_divisor integer not null default 5000 check (volumetric_divisor > 0);

-- ---------------------------------------------------------------- rates (per zone, as in JetStream's BaseTariff)
-- method: E = exact price for the break, I = add this charge for each step, M = rate x whole weight (+ basic, floor at minimum)
create table public.tariff_rates (
  version_id uuid not null references public.tariff_versions (id) on delete cascade,
  zone_code text not null,
  kind text not null check (kind in ('doc', 'parcel')),
  from_kg numeric(10, 3) not null,
  to_kg numeric(10, 3) not null check (to_kg > from_kg),
  step_kg numeric(7, 3) not null check (step_kg > 0),
  method text not null check (method in ('E', 'I', 'M')),
  charge numeric(12, 4) not null check (charge >= 0),
  basic numeric(12, 4) not null default 0 check (basic >= 0),
  minimum numeric(12, 4) not null default 0 check (minimum >= 0),
  primary key (version_id, zone_code, kind, to_kg)
);

create trigger tariff_rates_draft_only before insert or update or delete on public.tariff_rates
  for each row execute function private.tariff_draft_only();

-- ---------------------------------------------------------------- sales tariffs, margins, customer assignments
alter table public.sales_tariffs
  add column branch_code text references public.branches (code),
  add column service_code text references public.tariff_services (code);
update public.sales_tariffs s set branch_code = b.branch_code from public.base_tariffs b where b.id = s.base_tariff_id;
alter table public.sales_tariffs alter column branch_code set not null;
alter table public.sales_tariffs drop constraint sales_tariffs_code_key;
create unique index sales_tariffs_unique on public.sales_tariffs (branch_code, coalesce(service_code, ''), code);

-- One margin per rate row (zone, documents/parcels, weight break), matched exactly like JetStream's ProduceSalesTariff.
create table public.sales_margins (
  sales_tariff_id uuid not null references public.sales_tariffs (id) on delete cascade,
  zone_code text not null,
  kind text not null check (kind in ('doc', 'parcel')),
  to_kg numeric(10, 3) not null,
  margin_pct numeric(7, 2) not null check (margin_pct between -100 and 1000),
  primary key (sales_tariff_id, zone_code, kind, to_kg)
);

create table public.customer_tariffs (
  customer_id uuid not null references public.customers (id) on delete cascade,
  service_code text not null references public.tariff_services (code),
  effective_from date not null,
  effective_to date,
  sales_tariff_id uuid not null references public.sales_tariffs (id) on delete cascade,
  volumetric_divisor integer check (volumetric_divisor > 0),   -- overrides the rate card's, as in JetStream
  created_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (customer_id, service_code, effective_from),
  check (effective_to is null or effective_to >= effective_from)
);
create trigger customer_tariffs_audit after insert or update or delete on public.customer_tariffs for each row execute function private.audit();
create trigger zone_sets_audit after insert or update or delete on public.zone_sets for each row execute function private.audit();

-- ---------------------------------------------------------------- editing functions
-- Upsert a set of rate rows into a draft (only the rows given). Used by both the grid and the lane list.
create or replace function public.upsert_tariff_rates(p_version uuid, p_rates jsonb, p_note text default null)
returns integer
language plpgsql security invoker set search_path = '' as $$
declare
  n integer;
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can edit tariffs' using errcode = '42501';
  end if;
  with incoming as (
    select p_version as version_id, r ->> 'zone_code' as zone_code, r ->> 'kind' as kind, (r ->> 'from_kg')::numeric as from_kg,
           (r ->> 'to_kg')::numeric as to_kg, (r ->> 'step_kg')::numeric as step_kg, r ->> 'method' as method,
           (r ->> 'charge')::numeric as charge, coalesce((r ->> 'basic')::numeric, 0) as basic, coalesce((r ->> 'minimum')::numeric, 0) as minimum
      from jsonb_array_elements(p_rates) r
  ), changed as (
    select i.* from incoming i
    left join public.tariff_rates t using (version_id, zone_code, kind, to_kg)
     where t.version_id is null or (t.from_kg, t.step_kg, t.method, t.charge, t.basic, t.minimum) is distinct from (i.from_kg, i.step_kg, i.method, i.charge, i.basic, i.minimum)
  ), done as (
    insert into public.tariff_rates as t (version_id, zone_code, kind, from_kg, to_kg, step_kg, method, charge, basic, minimum)
    select * from changed
    on conflict (version_id, zone_code, kind, to_kg) do update
      set from_kg = excluded.from_kg, step_kg = excluded.step_kg, method = excluded.method,
          charge = excluded.charge, basic = excluded.basic, minimum = excluded.minimum
    returning 1
  )
  select count(*) into n from done;
  if n > 0 then
    perform private.log_change('tariff_rates', p_version::text, jsonb_build_object('rates_changed', n, 'note', p_note));
    update public.tariff_versions set note = coalesce(nullif(trim(p_note), ''), note) where id = p_version;
  end if;
  return n;
end $$;

-- Remove rate rows from a draft. p_keys: [{zone_code, kind, to_kg}]
create or replace function public.delete_tariff_rates(p_version uuid, p_keys jsonb)
returns integer
language plpgsql security invoker set search_path = '' as $$
declare
  n integer;
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can edit tariffs' using errcode = '42501';
  end if;
  delete from public.tariff_rates t using jsonb_array_elements(p_keys) k
   where t.version_id = p_version and t.zone_code = k ->> 'zone_code' and t.kind = k ->> 'kind' and t.to_kg = (k ->> 'to_kg')::numeric;
  get diagnostics n = row_count;
  if n > 0 then perform private.log_change('tariff_rates', p_version::text, jsonb_build_object('rates_removed', n)); end if;
  return n;
end $$;

-- Change prices by a percentage across a draft, or the zones matching a filter (e.g. 'SYD-%'), or one kind.
create or replace function public.adjust_tariff_draft(p_version uuid, p_pct numeric, p_zone_like text default null, p_kind text default null)
returns integer
language plpgsql security invoker set search_path = '' as $$
declare
  n integer;
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can edit tariffs' using errcode = '42501';
  end if;
  update public.tariff_rates
     set charge = round(charge * (1 + p_pct / 100), 2), basic = round(basic * (1 + p_pct / 100), 2), minimum = round(minimum * (1 + p_pct / 100), 2)
   where version_id = p_version and (p_zone_like is null or zone_code ilike p_zone_like) and (p_kind is null or kind = p_kind);
  get diagnostics n = row_count;
  if n > 0 then
    perform private.log_change('tariff_rates', p_version::text, jsonb_build_object('rates_changed', n, 'percent', p_pct, 'zones', p_zone_like, 'kind', p_kind));
  end if;
  return n;
end $$;

create or replace function public.new_tariff_draft(p_from_version uuid)
returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  src public.tariff_versions;
  new_id uuid;
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can edit tariffs' using errcode = '42501';
  end if;
  select * into src from public.tariff_versions where id = p_from_version;
  if src.id is null then raise exception 'Tariff version not found'; end if;
  if exists (select 1 from public.tariff_versions where tariff_id = src.tariff_id and status = 'draft') then
    raise exception 'This tariff already has a draft. Finish or delete it first.';
  end if;
  insert into public.tariff_versions (tariff_id, version, note, volumetric_divisor)
  values (src.tariff_id, (select max(version) + 1 from public.tariff_versions where tariff_id = src.tariff_id), 'Copied from version ' || src.version, src.volumetric_divisor)
  returning id into new_id;
  insert into public.tariff_rates (version_id, zone_code, kind, from_kg, to_kg, step_kg, method, charge, basic, minimum)
    select new_id, zone_code, kind, from_kg, to_kg, step_kg, method, charge, basic, minimum from public.tariff_rates where version_id = src.id;
  return new_id;
end $$;

create or replace function public.create_rate_card(
  p_code text, p_name text, p_branch text, p_carrier text, p_service text, p_zone_set uuid, p_copy_version uuid default null)
returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  t_id uuid;
  v_id uuid;
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can create rate cards' using errcode = '42501';
  end if;
  insert into public.base_tariffs (code, name, branch_code, carrier_code, service_code, zone_set_id)
  values (upper(trim(p_code)), trim(p_name), p_branch, p_carrier, p_service, p_zone_set)
  returning id into t_id;
  insert into public.tariff_versions (tariff_id, version, note, volumetric_divisor)
  values (t_id, 1, case when p_copy_version is null then 'New rate card' else 'Copied from another rate card' end,
          coalesce((select volumetric_divisor from public.tariff_versions where id = p_copy_version), case when p_service like 'DOM%' then 4000 else 5000 end))
  returning id into v_id;
  if p_copy_version is not null then
    insert into public.tariff_rates (version_id, zone_code, kind, from_kg, to_kg, step_kg, method, charge, basic, minimum)
      select v_id, zone_code, kind, from_kg, to_kg, step_kg, method, charge, basic, minimum from public.tariff_rates where version_id = p_copy_version;
  end if;
  return v_id;
end $$;

-- Save margins for a sales tariff (only the cells given; null margin removes the cell). One audit entry per save.
create or replace function public.save_sales_margins(p_sales uuid, p_margins jsonb)
returns integer
language plpgsql security invoker set search_path = '' as $$
declare
  n integer := 0;
  d integer := 0;
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can edit margins' using errcode = '42501';
  end if;
  delete from public.sales_margins m using jsonb_array_elements(p_margins) x
   where m.sales_tariff_id = p_sales and m.zone_code = x ->> 'zone_code' and m.kind = x ->> 'kind'
     and m.to_kg = (x ->> 'to_kg')::numeric and (x ->> 'margin_pct') is null;
  get diagnostics d = row_count;
  with up as (
    insert into public.sales_margins (sales_tariff_id, zone_code, kind, to_kg, margin_pct)
    select p_sales, x ->> 'zone_code', x ->> 'kind', (x ->> 'to_kg')::numeric, (x ->> 'margin_pct')::numeric
      from jsonb_array_elements(p_margins) x where (x ->> 'margin_pct') is not null
    on conflict (sales_tariff_id, zone_code, kind, to_kg) do update set margin_pct = excluded.margin_pct
      where public.sales_margins.margin_pct is distinct from excluded.margin_pct
    returning 1
  ) select count(*) into n from up;
  if n + d > 0 then perform private.log_change('sales_margins', p_sales::text, jsonb_build_object('margins_changed', n, 'margins_removed', d)); end if;
  return n + d;
end $$;

-- ---------------------------------------------------------------- pricing (JetStream's rules)
-- Leading digits of a postcode as a number (JetStream compares postcodes numerically); no digits = 0.
create or replace function private.postcode_num(p text) returns numeric
language sql immutable set search_path = '' as $$
  select coalesce(nullif(substring(coalesce(p, '') from '^\s*([0-9]+)'), '')::numeric, 0)
$$;

-- The zone for a shipment: up to two candidate groups each side (narrowest ranges first), tried in JetStream's order,
-- with the customer's own lanes ahead of the general ones.
create or replace function public.find_zone(p_zone_set uuid, p_customer uuid, p_orig_country text, p_orig_postcode text, p_dest_country text, p_dest_postcode text)
returns text
language plpgsql stable security invoker set search_path = '' as $$
declare
  o text[];
  d text[];
  z text;
  pair record;
begin
  select array_agg(group_code) into o from (
    select group_code from public.zone_groups
     where zone_set_id = p_zone_set and country_code = upper(p_orig_country)
       and private.postcode_num(p_orig_postcode) between range_from and range_to
     order by range_to, range_from desc limit 2) x;
  select array_agg(group_code) into d from (
    select group_code from public.zone_groups
     where zone_set_id = p_zone_set and country_code = upper(p_dest_country)
       and private.postcode_num(p_dest_postcode) between range_from and range_to
     order by range_to, range_from desc limit 2) x;
  if o is null or d is null then return null; end if;
  for pair in select * from (values (1, 1, 1), (2, 2, 1), (3, 1, 2), (4, 2, 2)) as v (n, oi, di) order by n loop
    continue when o[pair.oi] is null or d[pair.di] is null;
    select zone_code into z from public.zone_lanes
     where zone_set_id = p_zone_set and orig_group = o[pair.oi] and dest_group = d[pair.di]
       and (customer_id is null or customer_id = p_customer)
     order by customer_id is null limit 1;
    if z is not null then return z; end if;
  end loop;
  return null;
end $$;

-- Freight charge for one zone, kind and chargeable weight on a rate card version with a sales tariff's margins.
-- Mirrors CalculateFreightCharge: margins applied row by row; documents heavier than the documents breaks price as parcels.
create or replace function public.freight_charge(p_version uuid, p_sales uuid, p_zone text, p_kind text, p_weight numeric)
returns numeric
language plpgsql stable security invoker set search_path = '' as $$
declare
  r record;
  v_kind text := p_kind;
  max_doc numeric;
  tally numeric := 0;
  total numeric := 0;
  rate numeric;
begin
  if p_weight is null or p_weight <= 0 then return null; end if;
  select max(to_kg) into max_doc from public.tariff_rates where version_id = p_version and zone_code = p_zone and kind = 'doc';
  if v_kind = 'doc' and (max_doc is null or p_weight > max_doc) then v_kind := 'parcel'; end if;

  for r in
    select t.*, m.margin_pct from public.tariff_rates t
    left join public.sales_margins m on m.sales_tariff_id = p_sales and (m.zone_code, m.kind, m.to_kg) = (t.zone_code, t.kind, t.to_kg)
     where t.version_id = p_version and t.zone_code = p_zone and t.kind = v_kind
     order by t.from_kg, t.step_kg
  loop
    if r.margin_pct is null then return null; end if;          -- JetStream: "Sales Tariff missing or contains invalid margins"
    rate := 1 + r.margin_pct / 100;
    while tally < r.to_kg loop
      tally := tally + r.step_kg;
      if r.method = 'E' then
        total := r.charge * rate;
        if tally >= p_weight then return round(total, 2); end if;
      elsif r.method = 'I' then
        total := total + r.charge * rate;
        if tally >= p_weight then return round(total, 2); end if;
      else -- 'M'
        if tally >= p_weight then
          total := tally / r.step_kg * round(r.charge * rate, 2) + round(r.basic * rate, 2);
          return round(greatest(total, r.minimum * rate), 2);
        end if;
      end if;
    end loop;
  end loop;
  return null;   -- heavier than the last break
end $$;

-- Full price for a customer's shipment on a date: which tariff, version, zone, divisor, freight charge and fuel.
create or replace function public.price_shipment(
  p_customer uuid, p_service text, p_orig_country text, p_orig_postcode text, p_dest_country text, p_dest_postcode text,
  p_kind text, p_weight numeric, p_date date default current_date, p_zone text default null)
returns table (sales_tariff text, base_tariff text, version integer, zone_code text, volumetric_divisor integer,
               price numeric, fuel_pct numeric, problem text)
language plpgsql stable security invoker set search_path = '' as $$
declare
  ct public.customer_tariffs;
  st public.sales_tariffs;
  bt public.base_tariffs;
  v public.tariff_versions;
  z text := p_zone;
  amount numeric;
  fuel numeric;
begin
  select * into ct from public.customer_tariffs
   where customer_id = p_customer and service_code = p_service and effective_from <= p_date and (effective_to is null or effective_to >= p_date)
   order by effective_from desc limit 1;
  if ct.customer_id is null then
    return query select null::text, null::text, null::integer, null::text, null::integer, null::numeric, null::numeric, 'The customer has no sales tariff for this service on this date';
    return;
  end if;
  select * into st from public.sales_tariffs where id = ct.sales_tariff_id;
  select * into bt from public.base_tariffs where id = st.base_tariff_id;
  select * into v from public.tariff_versions where tariff_id = bt.id and status = 'published' and valid_from <= p_date order by valid_from desc limit 1;
  if v.id is null then
    return query select st.code, bt.code, null::integer, null::text, null::integer, null::numeric, null::numeric, 'No published rate card is in force on this date';
    return;
  end if;
  if z is null then z := public.find_zone(bt.zone_set_id, p_customer, p_orig_country, p_orig_postcode, p_dest_country, p_dest_postcode); end if;
  select f.rate_pct into fuel from public.fuel_surcharges f where f.carrier_code = bt.carrier_code and f.effective_from <= p_date order by f.effective_from desc limit 1;
  if z is null then
    return query select st.code, bt.code, v.version, null::text, coalesce(ct.volumetric_divisor, v.volumetric_divisor), null::numeric, fuel, 'No zone found for these postcodes in the rate card''s zone guide';
    return;
  end if;
  amount := public.freight_charge(v.id, st.id, z, p_kind, p_weight);
  return query select st.code, bt.code, v.version, z, coalesce(ct.volumetric_divisor, v.volumetric_divisor), amount, fuel,
    case when amount is null then 'No rate or margin for this zone and weight' end;
end $$;

revoke all on function public.upsert_tariff_rates(uuid, jsonb, text), public.delete_tariff_rates(uuid, jsonb), public.adjust_tariff_draft(uuid, numeric, text, text),
  public.new_tariff_draft(uuid), public.create_rate_card(text, text, text, text, text, uuid, uuid), public.save_sales_margins(uuid, jsonb),
  public.find_zone(uuid, uuid, text, text, text, text), public.freight_charge(uuid, uuid, text, text, numeric),
  public.price_shipment(uuid, text, text, text, text, text, text, numeric, date, text) from public, anon;
grant execute on function public.upsert_tariff_rates(uuid, jsonb, text), public.delete_tariff_rates(uuid, jsonb), public.adjust_tariff_draft(uuid, numeric, text, text),
  public.new_tariff_draft(uuid), public.create_rate_card(text, text, text, text, text, uuid, uuid), public.save_sales_margins(uuid, jsonb),
  public.find_zone(uuid, uuid, text, text, text, text), public.freight_charge(uuid, uuid, text, text, numeric),
  public.price_shipment(uuid, text, text, text, text, text, text, numeric, date, text) to authenticated;
grant execute on function private.postcode_num(text) to authenticated;

-- publish_tariff_version (from the previous migration) checked tariff_cells; point it at tariff_rates.
create or replace function public.publish_tariff_version(p_version uuid, p_valid_from date)
returns void
language plpgsql security invoker set search_path = '' as $$
declare
  v public.tariff_versions;
  latest date;
begin
  if not private.can_manage_users() then
    raise exception 'Only management can publish a tariff' using errcode = '42501';
  end if;
  select * into v from public.tariff_versions where id = p_version;
  if v.status <> 'draft' then raise exception 'Only a draft can be published'; end if;
  if not exists (select 1 from public.tariff_rates where version_id = p_version) then raise exception 'The draft has no rates'; end if;
  select max(valid_from) into latest from public.tariff_versions where tariff_id = v.tariff_id and status = 'published';
  if latest is not null and p_valid_from <= latest then
    raise exception 'Start date must be after %, when the current version starts', to_char(latest, 'DD Mon YYYY');
  end if;
  update public.tariff_versions
     set status = 'published', valid_from = p_valid_from, published_by = (select auth.uid()), published_at = now()
   where id = p_version;
end $$;

-- ---------------------------------------------------------------- row-level security and privileges
alter table public.tariff_services enable row level security;
alter table public.zone_sets enable row level security;
alter table public.zone_groups enable row level security;
alter table public.zone_lanes enable row level security;
alter table public.tariff_rates enable row level security;
alter table public.sales_margins enable row level security;
alter table public.customer_tariffs enable row level security;

create policy "Signed-in users read services" on public.tariff_services for select to authenticated using (true);
create policy "Staff read zone sets" on public.zone_sets for select to authenticated using ((select private.is_staff()));
create policy "Staff read zone groups" on public.zone_groups for select to authenticated using ((select private.is_staff()));
create policy "Staff read zone lanes" on public.zone_lanes for select to authenticated using ((select private.is_staff()));
create policy "Staff read tariff rates" on public.tariff_rates for select to authenticated using ((select private.is_staff()));
create policy "Staff read sales margins" on public.sales_margins for select to authenticated using ((select private.is_staff()));
create policy "Staff read customer tariffs" on public.customer_tariffs for select to authenticated using ((select private.is_staff()));

create policy "Billing staff edit services" on public.tariff_services
  for all to authenticated using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));
create policy "Billing staff edit zone sets" on public.zone_sets
  for all to authenticated using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));
create policy "Billing staff edit zone groups" on public.zone_groups
  for all to authenticated using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));
create policy "Billing staff edit zone lanes" on public.zone_lanes
  for all to authenticated using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));
create policy "Billing staff edit tariff rates" on public.tariff_rates
  for all to authenticated using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));
create policy "Billing staff edit sales margins" on public.sales_margins
  for all to authenticated using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));
create policy "Billing staff assign tariffs" on public.customer_tariffs
  for all to authenticated using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));

grant select, insert, update, delete on public.tariff_services, public.zone_sets, public.zone_groups, public.zone_lanes,
  public.tariff_rates, public.sales_margins, public.customer_tariffs to authenticated;
grant all on public.tariff_services, public.zone_sets, public.zone_groups, public.zone_lanes,
  public.tariff_rates, public.sales_margins, public.customer_tariffs to service_role;

-- Finance can read the history of everything tariff-related.
drop policy "Managers read the audit log" on public.audit_log;
create policy "Managers read the audit log" on public.audit_log
  for select to authenticated
  using (
    (select private.can_manage_users())
    or ((select private.can_edit_billing()) and table_name in (
      'customers', 'jobs', 'reweighs', 'fuel_surcharges', 'zones', 'zone_sets', 'base_tariffs', 'tariff_versions', 'tariff_rates',
      'sales_tariffs', 'sales_margins', 'customer_tariffs'))
  );

-- JetStream's payment terms code (7D, 14D, 30EOM, EOM ...) alongside the days, so "end of month" terms survive the import.
alter table public.customers add column payment_terms_code text;

-- How many customers are on each sales tariff today (counted in the database; runs as the caller, so staff only).
create view public.sales_tariff_usage with (security_invoker = true) as
select sales_tariff_id, count(distinct customer_id)::integer as customers
from public.customer_tariffs
where effective_from <= current_date and (effective_to is null or effective_to >= current_date)
group by sales_tariff_id;
grant select on public.sales_tariff_usage to authenticated;

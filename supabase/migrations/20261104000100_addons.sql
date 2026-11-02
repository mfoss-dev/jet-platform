-- Add-ons: everything JetStream charges on top of the tariff, from its SalesAddOn table and Rating.vb
-- (GetSalesAddons, GetPieceLevelSalesAddons, CalculateSalesAddOn, GetFuelSecurityGST):
--   * the freight line itself (".FREIGHT": 100% of freight, with fuel/security/GST flags)
--   * percentages: #FUEL, #SEC, #GST (most specific rule wins: this service before all services, this customer before all)
--   * surcharges with a condition: always, insured, priority, duties paid, origin/destination postcode or country ranges,
--     declared value, total weight, per piece weight or size, or "last" (a % of everything fuel applies to)
-- Each rule can add fuel, security and GST on top of itself. Manual and ad hoc codes are added by staff, never automatically.
-- Fuel replaces the per-carrier fuel table: JetStream sets it per branch and service (optionally per customer), weekly.

create table public.addon_rules (
  id uuid primary key default gen_random_uuid(),
  branch_code text not null references public.branches (code),
  customer_id uuid references public.customers (id) on delete cascade,   -- null = every customer
  service_code text references public.tariff_services (code),             -- null = every service
  code text not null,
  description text not null default '',
  valid_from date not null,
  valid_to date not null default '9999-12-31',
  apply_when text not null,             -- ALWAYS, INSURED, PRIORITY, DTP, DESTPC, ORIGPC, DESTCC, DESTCC/KG, ... MANUAL, ADHOC
  percentage_of text,                   -- F = freight, I = insured value, W = per weight unit
  percentage numeric(12, 4) not null default 0,
  fixed_fee numeric(12, 4) not null default 0,
  minimum numeric(12, 4) not null default 0,
  range_from text,
  range_to text,
  add_fuel boolean not null default false,
  add_security boolean not null default false,
  add_gst boolean not null default false,
  income_account text,
  source text,                          -- 'jetstream' (imported), 'reconstructed' (worked out from billed jobs), null (entered here)
  created_at timestamptz not null default now(),
  check (valid_to >= valid_from)
);
create index addon_rules_lookup on public.addon_rules (branch_code, valid_from, valid_to);
create trigger addon_rules_audit after insert or update or delete on public.addon_rules for each row execute function private.audit();

alter table public.addon_rules enable row level security;
create policy "Staff read add-on rules" on public.addon_rules for select to authenticated using ((select private.is_staff()));
create policy "Billing staff edit add-on rules" on public.addon_rules
  for all to authenticated using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));
grant select, insert, update, delete on public.addon_rules to authenticated;
grant all on public.addon_rules to service_role;

-- The rules that apply to a customer, service and date, in JetStream's order: code, then this service before all
-- services, then this customer before all customers.
create or replace function private.addon_rules_for(p_customer uuid, p_service text, p_date date)
returns setof public.addon_rules
language sql stable security invoker set search_path = '' as $$
  select r.* from public.addon_rules r
  join public.customers c on c.id = p_customer and c.branch_code = r.branch_code
  where (r.customer_id is null or r.customer_id = p_customer)
    and (r.service_code is null or r.service_code = p_service)
    and p_date between r.valid_from and r.valid_to
  order by upper(r.code) collate "C", r.service_code is null, r.customer_id is null
$$;

-- A percentage rule (#FUEL, #SEC, #GST): the first in JetStream's order.
create or replace function public.addon_percent(p_customer uuid, p_service text, p_date date, p_code text)
returns numeric
language sql stable security invoker set search_path = '' as $$
  select percentage from private.addon_rules_for(p_customer, p_service, p_date) where upper(code) = upper(p_code) limit 1
$$;

-- CalculateSalesAddOn: % of freight or insured value plus a fixed fee, or a fee per 0.5 kg / per kg; floored at the minimum.
create or replace function private.addon_amount(p_base numeric, p_insured numeric, p_of text, p_pct numeric, p_fee numeric, p_min numeric, p_weight numeric)
returns numeric
language plpgsql immutable set search_path = '' as $$
declare
  v numeric := 0;
begin
  if p_of = 'F' then v := coalesce(p_base, 0) * p_pct / 100 + p_fee;
  elsif p_of = 'I' then v := coalesce(p_insured, 0) * p_pct / 100 + p_fee;
  elsif p_of = 'W' then
    if p_pct = 0.5 then v := floor((coalesce(p_weight, 0) + 0.49) * 2) / 2 / 0.5 * p_fee;
    elsif p_pct = 1 then v := floor(coalesce(p_weight, 0) + 0.9) * p_fee;
    end if;
  else
    return 0;                                         -- JetStream returns 0 for any other basis, without the minimum
  end if;
  return greatest(v, p_min);
end $$;

-- Does a rule's condition match? Unknown conditions (e.g. ORIGCC, which JetStream's code doesn't handle) never match.
create or replace function private.addon_matches(r public.addon_rules, p_weight numeric, p_oc text, p_opc text, p_dc text, p_dpc text,
                                                 p_declared numeric, p_insured numeric, p_priority boolean, p_dtp boolean)
returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  w text := upper(r.apply_when);
  f text := trim(coalesce(r.range_from, ''));
  t text := trim(coalesce(r.range_to, ''));
  osuf text := case when trim(coalesce(p_opc, '')) ~ '^[0-9]+$' then (trim(p_opc)::numeric)::text else coalesce(p_opc, '') end;
  dsuf text := case when trim(coalesce(p_dpc, '')) ~ '^[0-9]+$' then (trim(p_dpc)::numeric)::text else coalesce(p_dpc, '') end;
begin
  return case w
    when 'ALWAYS' then true
    when 'LAST' then true
    when 'INSURED' then coalesce(p_insured, 0) > 0
    when 'PRIORITY' then coalesce(p_priority, false)
    when 'DTP' then coalesce(p_dtp, false)
    when 'DESTPC' then private.postcode_num(p_dpc) between private.postcode_num(f) and private.postcode_num(t)
    when 'ORIGPC' then private.postcode_num(p_opc) between private.postcode_num(f) and private.postcode_num(t)
    when 'DESTCC' then (upper(p_dc)) collate "C" between upper(left(f, 2)) and upper(left(t, 2))
    when 'DESTCC/KG' then (upper(p_dc)) collate "C" between upper(left(f, 2)) and upper(left(t, 2))
    when 'ORIGCC/KG' then (upper(p_oc)) collate "C" between upper(left(f, 2)) and upper(left(t, 2))
    when 'DESTPC/KG' then (upper(coalesce(p_dpc, ''))) collate "C" between upper(coalesce(r.range_from, '')) and upper(coalesce(r.range_to, ''))
    when 'ORIGPC/KG' then (upper(coalesce(p_opc, ''))) collate "C" between upper(coalesce(r.range_from, '')) and upper(coalesce(r.range_to, ''))
    when 'DESTCCPC' then ((p_dc || '.' || coalesce(p_dpc, ''))) collate "C" between f and t
    when 'ORIGCCPC' then ((p_oc || '.' || coalesce(p_opc, ''))) collate "C" between f and t
    when 'DESTCC.PC' then ((p_dc || '.' || dsuf)) collate "C" between f and t
    when 'ORIGCC.PC' then ((p_oc || '.' || osuf)) collate "C" between f and t
    when 'VALUE' then f ~ '^-?[0-9.]+$' and t ~ '^-?[0-9.]+$' and coalesce(p_declared, 0) between f::numeric and t::numeric
    when 'TLWEIGHT' then f ~ '^-?[0-9.]+$' and t ~ '^-?[0-9.]+$' and coalesce(p_weight, 0) between f::numeric and t::numeric
    else false
  end;
end $$;

-- All the add-on lines for a shipment (the freight line included, via the .FREIGHT rule), as JetStream builds them.
-- p_pieces: [{"weight": kg, "max_dim": cm}, ...] for per-piece rules (oversize, overweight).
create or replace function public.charge_lines(
  p_customer uuid, p_service text, p_date date, p_freight numeric, p_weight numeric,
  p_orig_country text, p_orig_postcode text, p_dest_country text, p_dest_postcode text,
  p_declared numeric default 0, p_insured numeric default 0, p_priority boolean default false, p_dtp boolean default false,
  p_pieces jsonb default '[]')
returns table (code text, description text, charge numeric, fuel numeric, security numeric, gst numeric, income_account text, per_piece boolean)
language plpgsql stable security invoker set search_path = '' as $$
#variable_conflict use_column
declare
  fuel_pct numeric := 0;
  sec_pct numeric := 0;
  gst_pct numeric := 0;
  gst_on_fuel boolean := false;
  gst_on_sec boolean := false;
  seen text[] := '{}';
  prev text := '';
  fuel_base numeric := 0;
  r public.addon_rules;
  amt numeric;
  fv numeric;
  sv numeric;
  pc jsonb;
  resets constant text[] := array['DESTPC', 'ORIGPC', 'DESTCC', 'DESTCC/KG', 'ORIGCC/KG', 'DESTPC/KG', 'ORIGPC/KG', 'DESTCCPC', 'DESTCC.PC', 'ORIGCC.PC', 'ORIGCCPC'];
begin
  -- Percentages: the first #FUEL / #SEC / #GST rule in order.
  for r in select * from private.addon_rules_for(p_customer, p_service, p_date) where upper(code) in ('#FUEL', '#SEC', '#GST') loop
    continue when upper(r.code) = any (seen);
    seen := seen || upper(r.code);
    if upper(r.code) = '#FUEL' then fuel_pct := r.percentage; gst_on_fuel := r.add_gst;
    elsif upper(r.code) = '#SEC' then sec_pct := r.percentage; gst_on_sec := r.add_gst;
    else gst_pct := r.percentage;
    end if;
  end loop;

  -- Shipment-level add-ons: first matching rule per code (range conditions let later rules of the same code try).
  for r in select * from private.addon_rules_for(p_customer, p_service, p_date) loop
    continue when upper(r.code) in ('#FUEL', '#SEC', '#GST');
    continue when upper(r.code) = prev;
    prev := upper(r.code);
    continue when upper(r.apply_when) in ('PCWEIGHT', 'PCDIM');
    if not private.addon_matches(r, p_weight, p_orig_country, p_orig_postcode, p_dest_country, p_dest_postcode, p_declared, p_insured, p_priority, p_dtp) then
      if upper(r.apply_when) = any (resets) then prev := ''; end if;
      continue;
    end if;
    amt := private.addon_amount(case when upper(r.apply_when) = 'LAST' then fuel_base else p_freight end, p_insured,
                                upper(r.percentage_of), r.percentage, r.fixed_fee, r.minimum, p_weight);
    fv := case when r.add_fuel then amt * fuel_pct / 100 else 0 end;
    sv := case when r.add_security then amt * sec_pct / 100 else 0 end;
    code := r.code; description := r.description; charge := round(amt, 2); fuel := round(fv, 2); security := round(sv, 2);
    gst := round(case when r.add_gst then (amt + case when gst_on_fuel then fv else 0 end + case when gst_on_sec then sv else 0 end) * gst_pct / 100 else 0 end, 2);
    income_account := r.income_account; per_piece := false;
    return next;
    if r.add_fuel then fuel_base := fuel_base + amt; end if;
  end loop;

  -- Per-piece add-ons: every matching rule, for every piece (JetStream doesn't add GST on the fuel of these).
  for r in select * from private.addon_rules_for(p_customer, p_service, p_date) where upper(apply_when) in ('PCWEIGHT', 'PCDIM') loop
    for pc in select * from jsonb_array_elements(coalesce(p_pieces, '[]')) loop
      continue when not (case upper(r.apply_when)
        when 'PCWEIGHT' then coalesce((pc ->> 'weight')::numeric, 0) between private.postcode_num(r.range_from) and private.postcode_num(r.range_to)
        else coalesce((pc ->> 'max_dim')::numeric, 0) between private.postcode_num(r.range_from) and private.postcode_num(r.range_to) end);
      amt := private.addon_amount(0, 0, upper(r.percentage_of), r.percentage, r.fixed_fee, r.minimum, 0);
      fv := case when r.add_fuel then amt * fuel_pct / 100 else 0 end;
      sv := case when r.add_security then amt * sec_pct / 100 else 0 end;
      code := r.code; description := r.description; charge := round(amt, 2); fuel := round(fv, 2); security := round(sv, 2);
      gst := round(case when r.add_gst then amt * gst_pct / 100 else 0 end, 2);
      income_account := r.income_account; per_piece := true;
      return next;
    end loop;
  end loop;
end $$;

revoke all on function public.charge_lines(uuid, text, date, numeric, numeric, text, text, text, text, numeric, numeric, boolean, boolean, jsonb),
  public.addon_percent(uuid, text, date, text) from public, anon;
grant execute on function public.charge_lines(uuid, text, date, numeric, numeric, text, text, text, text, numeric, numeric, boolean, boolean, jsonb),
  public.addon_percent(uuid, text, date, text) to authenticated;
grant execute on function private.addon_rules_for(uuid, text, date), private.addon_amount(numeric, numeric, text, numeric, numeric, numeric, numeric),
  private.addon_matches(public.addon_rules, numeric, text, text, text, text, numeric, numeric, boolean, boolean) to authenticated;

-- price_shipment's fuel % now comes from the #FUEL rules (per branch and service), not the old per-carrier table.
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
  fuel numeric := public.addon_percent(p_customer, p_service, p_date, '#FUEL');
begin
  select * into ct from public.customer_tariffs
   where customer_id = p_customer and service_code = p_service and effective_from <= p_date and (effective_to is null or effective_to >= p_date)
   order by effective_from desc limit 1;
  if ct.customer_id is null then
    return query select null::text, null::text, null::integer, null::text, null::integer, null::numeric, fuel, 'The customer has no sales tariff for this service on this date';
    return;
  end if;
  select * into st from public.sales_tariffs where id = ct.sales_tariff_id;
  select * into bt from public.base_tariffs where id = st.base_tariff_id;
  select * into v from public.tariff_versions where tariff_id = bt.id and status = 'published' and valid_from <= p_date order by valid_from desc limit 1;
  if v.id is null then
    return query select st.code, bt.code, null::integer, null::text, null::integer, null::numeric, fuel, 'No published rate card is in force on this date';
    return;
  end if;
  if z is null then z := public.find_zone(bt.zone_set_id, p_customer, p_orig_country, p_orig_postcode, p_dest_country, p_dest_postcode); end if;
  if z is null then
    return query select st.code, bt.code, v.version, null::text, coalesce(ct.volumetric_divisor, v.volumetric_divisor), null::numeric, fuel, 'No zone found for these postcodes in the rate card''s zone guide';
    return;
  end if;
  amount := public.freight_charge(v.id, st.id, z, p_kind, p_weight);
  return query select st.code, bt.code, v.version, z, coalesce(ct.volumetric_divisor, v.volumetric_divisor), amount, fuel,
    case when amount is null then 'No rate or margin for this zone and weight' end;
end $$;

-- The old per-carrier fuel table is replaced by #FUEL rules.
drop table public.fuel_surcharges;

drop policy "Managers read the audit log" on public.audit_log;
create policy "Managers read the audit log" on public.audit_log
  for select to authenticated
  using (
    (select private.can_manage_users())
    or ((select private.can_edit_billing()) and table_name in (
      'customers', 'jobs', 'reweighs', 'addon_rules', 'zones', 'zone_sets', 'base_tariffs', 'tariff_versions', 'tariff_rates',
      'sales_tariffs', 'sales_margins', 'customer_tariffs'))
  );

-- Tariff tables, following the structure of Wayne's JetStream (TableIO/BaseTariff*, SalesTariff*, CustomersTariff, Rating.vb):
--   base tariff      = Jet's rate card: a charge per zone and weight break, for documents and parcels
--   tariff version   = a dated copy of the rate card (JetStream's BaseTariffsLife); drafts are edited, published ones are locked
--   sales tariff     = a named margin % by zone and weight band on top of a base tariff, shared by many customers
--   customer tariff  = which sales tariff a customer is on, from a date
-- Price = base charge x (1 + margin %). Replaces the per-customer margin grid from the previous migration.

drop table public.customer_margins;

-- ---------------------------------------------------------------- base tariffs and versions
create table public.base_tariffs (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,                    -- e.g. DHL-WPX-AU
  name text not null,
  branch_code text not null references public.branches (code),
  carrier_code text not null references public.carriers (code),
  service_id uuid references public.services (id),
  created_at timestamptz not null default now()
);

create type public.tariff_status as enum ('draft', 'published');

create table public.tariff_versions (
  id uuid primary key default gen_random_uuid(),
  tariff_id uuid not null references public.base_tariffs (id) on delete cascade,
  version integer not null,
  status public.tariff_status not null default 'draft',
  valid_from date,                              -- set when published; the version in force is the latest valid_from on or before the booking date
  note text,
  created_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  published_by uuid references public.profiles (id),
  published_at timestamptz,
  unique (tariff_id, version),
  check ((status = 'published') = (valid_from is not null and published_at is not null))
);
create unique index tariff_versions_one_draft on public.tariff_versions (tariff_id) where status = 'draft';
create unique index tariff_versions_one_per_day on public.tariff_versions (tariff_id, valid_from) where status = 'published';

-- A weight break: up to to_kg (from the previous break's to_kg). Method, as in JetStream's Rating.vb:
--   E (flat):     the charge is the price for any weight in the break
--   I (per step): the price at the start of the break, plus the charge for each step (e.g. 0.5 kg) into it
--   M (per kg):   the charge per step applied to the whole weight (e.g. $/kg over 30 kg)
create table public.tariff_breaks (
  version_id uuid not null references public.tariff_versions (id) on delete cascade,
  kind text not null check (kind in ('doc', 'parcel')),
  to_kg numeric(9, 3) not null check (to_kg > 0),
  method text not null check (method in ('E', 'I', 'M')),
  step_kg numeric(7, 3) not null default 0.5 check (step_kg > 0),
  primary key (version_id, kind, to_kg)
);

create table public.tariff_cells (
  version_id uuid not null,
  kind text not null,
  to_kg numeric(9, 3) not null,
  zone_code text not null references public.zones (code),
  charge numeric(12, 4) not null check (charge >= 0),
  primary key (version_id, kind, to_kg, zone_code),
  foreign key (version_id, kind, to_kg) references public.tariff_breaks (version_id, kind, to_kg) on delete cascade
);

-- Published rate cards are the record of what customers were charged: no edits, only new versions.
create or replace function private.tariff_draft_only() returns trigger
language plpgsql set search_path = '' as $$
declare
  vid uuid := coalesce(new.version_id, old.version_id);
begin
  if (select status from public.tariff_versions where id = vid) <> 'draft' then
    raise exception 'This tariff version is published and locked. Start a new draft to change it.' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
create trigger tariff_breaks_draft_only before insert or update or delete on public.tariff_breaks
  for each row execute function private.tariff_draft_only();
create trigger tariff_cells_draft_only before insert or update or delete on public.tariff_cells
  for each row execute function private.tariff_draft_only();

-- ---------------------------------------------------------------- sales tariffs and customer assignment
create table public.sales_tariffs (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,                    -- e.g. STANDARD, KEY
  name text not null,
  base_tariff_id uuid not null references public.base_tariffs (id),
  created_at timestamptz not null default now()
);

-- Margin for weights up to up_to_kg (null = everything heavier than the last band).
create table public.sales_margins (
  sales_tariff_id uuid not null references public.sales_tariffs (id) on delete cascade,
  zone_code text not null references public.zones (code),
  up_to_kg numeric(9, 3),
  margin_pct numeric(6, 2) not null check (margin_pct between -50 and 500),
  unique nulls not distinct (sales_tariff_id, zone_code, up_to_kg)
);

create table public.customer_tariffs (
  customer_id uuid not null references public.customers (id) on delete cascade,
  effective_from date not null,
  sales_tariff_id uuid not null references public.sales_tariffs (id),
  created_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (customer_id, effective_from)
);

-- ---------------------------------------------------------------- audit
-- Versions, sales tariffs, margins and assignments are audited per row. Rate cells are audited as one
-- summary entry per save (a +3% change touches hundreds of cells), written by save_tariff_draft.
create trigger base_tariffs_audit after insert or update or delete on public.base_tariffs for each row execute function private.audit();
create trigger tariff_versions_audit after insert or update or delete on public.tariff_versions for each row execute function private.audit();
create trigger sales_tariffs_audit after insert or update or delete on public.sales_tariffs for each row execute function private.audit();
create trigger sales_margins_audit after insert or update or delete on public.sales_margins for each row execute function private.audit();
create trigger customer_tariffs_audit after insert or update or delete on public.customer_tariffs for each row execute function private.audit();

create or replace function private.log_change(p_table text, p_row text, p_after jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_log (actor_id, actor_email, table_name, row_id, action, after)
  values ((select auth.uid()), (select auth.jwt() ->> 'email'), p_table, p_row, 'update', p_after)
$$;
revoke all on function private.log_change(text, text, jsonb) from public;
grant execute on function private.log_change(text, text, jsonb) to authenticated;

drop policy "Managers read the audit log" on public.audit_log;
create policy "Managers read the audit log" on public.audit_log
  for select to authenticated
  using (
    (select private.can_manage_users())
    or ((select private.can_edit_billing()) and table_name in (
      'customers', 'jobs', 'reweighs', 'fuel_surcharges', 'zones', 'base_tariffs', 'tariff_versions', 'tariff_cells',
      'sales_tariffs', 'sales_margins', 'customer_tariffs'))
  );

-- ---------------------------------------------------------------- functions
-- Save a whole draft rate card in one go. p_breaks: [{kind, to_kg, method, step_kg, cells: {zone_code: charge}}].
create or replace function public.save_tariff_draft(p_version uuid, p_breaks jsonb, p_note text default null)
returns integer
language plpgsql security invoker set search_path = '' as $$
declare
  before_cells jsonb;
  after_cells jsonb;
  changed integer;
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can edit tariffs' using errcode = '42501';
  end if;
  select coalesce(jsonb_object_agg(kind || '|' || to_kg::text || '|' || zone_code, charge), '{}') into before_cells
    from public.tariff_cells where version_id = p_version;

  delete from public.tariff_breaks where version_id = p_version;   -- the trigger refuses this for published versions
  insert into public.tariff_breaks (version_id, kind, to_kg, method, step_kg)
  select p_version, b ->> 'kind', (b ->> 'to_kg')::numeric, b ->> 'method', coalesce((b ->> 'step_kg')::numeric, 0.5)
    from jsonb_array_elements(p_breaks) b;
  insert into public.tariff_cells (version_id, kind, to_kg, zone_code, charge)
  select p_version, b ->> 'kind', (b ->> 'to_kg')::numeric, c.key, c.value::text::numeric
    from jsonb_array_elements(p_breaks) b, jsonb_each(b -> 'cells') c
   where c.value is not null and c.value <> 'null'::jsonb and c.value::text <> '""';

  select coalesce(jsonb_object_agg(kind || '|' || to_kg::text || '|' || zone_code, charge), '{}') into after_cells
    from public.tariff_cells where version_id = p_version;
  select count(*) into changed from (
    select key from jsonb_each(before_cells) b full join jsonb_each(after_cells) a using (key)
     where b.value is distinct from a.value) d;
  update public.tariff_versions set note = coalesce(nullif(trim(p_note), ''), note) where id = p_version;
  if changed > 0 then
    perform private.log_change('tariff_cells', p_version::text, jsonb_build_object('cells_changed', changed, 'note', p_note));
  end if;
  return changed;
end $$;

-- Start a new draft from any version (normally the latest published one).
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
  insert into public.tariff_versions (tariff_id, version, note)
  values (src.tariff_id, (select max(version) + 1 from public.tariff_versions where tariff_id = src.tariff_id), 'Copied from version ' || src.version)
  returning id into new_id;
  insert into public.tariff_breaks (version_id, kind, to_kg, method, step_kg)
    select new_id, kind, to_kg, method, step_kg from public.tariff_breaks where version_id = src.id;
  insert into public.tariff_cells (version_id, kind, to_kg, zone_code, charge)
    select new_id, kind, to_kg, zone_code, charge from public.tariff_cells where version_id = src.id;
  return new_id;
end $$;

-- Publishing is a management decision (Decision D8: Chris owns tariffs); finance can prepare drafts.
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
  if not exists (select 1 from public.tariff_cells where version_id = p_version) then raise exception 'The draft has no rates'; end if;
  select max(valid_from) into latest from public.tariff_versions where tariff_id = v.tariff_id and status = 'published';
  if latest is not null and p_valid_from <= latest then
    raise exception 'Start date must be after %, when the current version starts', to_char(latest, 'DD Mon YYYY');
  end if;
  update public.tariff_versions
     set status = 'published', valid_from = p_valid_from, published_by = (select auth.uid()), published_at = now()
   where id = p_version;
end $$;

-- The base charge for one zone, kind and weight on one version (JetStream's CalculateFreightCharge).
create or replace function public.tariff_charge(p_version uuid, p_zone text, p_kind text, p_weight numeric)
returns numeric
language plpgsql stable security invoker set search_path = '' as $$
declare
  b record;
  prev_to numeric := 0;
  running numeric := 0;
begin
  for b in
    select br.to_kg, br.method, br.step_kg, c.charge
      from public.tariff_breaks br
      join public.tariff_cells c on (c.version_id, c.kind, c.to_kg) = (br.version_id, br.kind, br.to_kg) and c.zone_code = p_zone
     where br.version_id = p_version and br.kind = p_kind
     order by br.to_kg
  loop
    if b.method = 'E' then
      if p_weight <= b.to_kg then return round(b.charge, 2); end if;
      running := b.charge;
    elsif b.method = 'I' then
      if p_weight <= b.to_kg then return round(running + ceil((p_weight - prev_to) / b.step_kg) * b.charge, 2); end if;
      running := running + ceil((b.to_kg - prev_to) / b.step_kg) * b.charge;
    else -- 'M'
      if p_weight <= b.to_kg then return round(ceil(p_weight / b.step_kg) * b.step_kg * b.charge, 2); end if;
      running := b.to_kg * b.charge;
    end if;
    prev_to := b.to_kg;
  end loop;
  return null;   -- heavier than the last break, or no rate for this zone
end $$;

-- What a customer pays for a shipment on a date: which tariff applies, base charge, margin, price ex GST.
create or replace function public.price_shipment(p_customer uuid, p_zone text, p_kind text, p_weight numeric, p_date date default current_date)
returns table (sales_tariff text, base_tariff text, version integer, base_charge numeric, margin_pct numeric, price numeric, fuel_pct numeric, problem text)
language plpgsql stable security invoker set search_path = '' as $$
declare
  st public.sales_tariffs;
  bt public.base_tariffs;
  v public.tariff_versions;
  m numeric;
  charge numeric;
begin
  select s.* into st from public.customer_tariffs ct join public.sales_tariffs s on s.id = ct.sales_tariff_id
   where ct.customer_id = p_customer and ct.effective_from <= p_date order by ct.effective_from desc limit 1;
  if st.id is null then
    return query select null::text, null::text, null::integer, null::numeric, null::numeric, null::numeric, null::numeric, 'The customer has no sales tariff on this date';
    return;
  end if;
  select * into bt from public.base_tariffs where id = st.base_tariff_id;
  select * into v from public.tariff_versions
   where tariff_id = bt.id and status = 'published' and valid_from <= p_date order by valid_from desc limit 1;
  if v.id is null then
    return query select st.code, bt.code, null::integer, null::numeric, null::numeric, null::numeric, null::numeric, 'No published rate card is in force on this date';
    return;
  end if;
  charge := public.tariff_charge(v.id, p_zone, p_kind, p_weight);
  select sm.margin_pct into m from public.sales_margins sm
   where sm.sales_tariff_id = st.id and sm.zone_code = p_zone and (sm.up_to_kg is null or p_weight <= sm.up_to_kg)
   order by sm.up_to_kg nulls last limit 1;
  return query select st.code, bt.code, v.version, charge, m,
    case when charge is not null and m is not null then round(charge * (1 + m / 100), 2) end,
    (select f.rate_pct from public.fuel_surcharges f where f.carrier_code = bt.carrier_code and f.effective_from <= p_date order by f.effective_from desc limit 1),
    case when charge is null then 'No rate for this zone and weight' when m is null then 'No margin set for this zone and weight' end;
end $$;

revoke all on function public.save_tariff_draft(uuid, jsonb, text), public.new_tariff_draft(uuid), public.publish_tariff_version(uuid, date),
  public.tariff_charge(uuid, text, text, numeric), public.price_shipment(uuid, text, text, numeric, date) from public, anon;
grant execute on function public.save_tariff_draft(uuid, jsonb, text), public.new_tariff_draft(uuid), public.publish_tariff_version(uuid, date),
  public.tariff_charge(uuid, text, text, numeric), public.price_shipment(uuid, text, text, numeric, date) to authenticated;

-- ---------------------------------------------------------------- row-level security and privileges
alter table public.base_tariffs enable row level security;
alter table public.tariff_versions enable row level security;
alter table public.tariff_breaks enable row level security;
alter table public.tariff_cells enable row level security;
alter table public.sales_tariffs enable row level security;
alter table public.sales_margins enable row level security;
alter table public.customer_tariffs enable row level security;

-- Rates and margins reveal cost: staff only.
create policy "Staff read base tariffs" on public.base_tariffs for select to authenticated using ((select private.is_staff()));
create policy "Staff read tariff versions" on public.tariff_versions for select to authenticated using ((select private.is_staff()));
create policy "Staff read tariff breaks" on public.tariff_breaks for select to authenticated using ((select private.is_staff()));
create policy "Staff read tariff cells" on public.tariff_cells for select to authenticated using ((select private.is_staff()));
create policy "Staff read sales tariffs" on public.sales_tariffs for select to authenticated using ((select private.is_staff()));
create policy "Staff read sales margins" on public.sales_margins for select to authenticated using ((select private.is_staff()));
create policy "Staff read customer tariffs" on public.customer_tariffs for select to authenticated using ((select private.is_staff()));

create policy "Billing staff edit base tariffs" on public.base_tariffs
  for all to authenticated using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));
-- Versions: billing staff create and delete drafts; publishing goes through publish_tariff_version (management).
create policy "Billing staff add drafts" on public.tariff_versions
  for insert to authenticated with check ((select private.can_edit_billing()) and status = 'draft');
create policy "Billing staff edit drafts" on public.tariff_versions
  for update to authenticated
  using ((select private.can_edit_billing()) and (status = 'draft' or (select private.can_manage_users())))
  with check ((select private.can_edit_billing()) and (status = 'draft' or (select private.can_manage_users())));
create policy "Billing staff delete drafts" on public.tariff_versions
  for delete to authenticated using ((select private.can_edit_billing()) and status = 'draft');
create policy "Billing staff edit tariff breaks" on public.tariff_breaks
  for all to authenticated using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));
create policy "Billing staff edit tariff cells" on public.tariff_cells
  for all to authenticated using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));
create policy "Billing staff edit sales tariffs" on public.sales_tariffs
  for all to authenticated using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));
create policy "Billing staff edit sales margins" on public.sales_margins
  for all to authenticated using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));
create policy "Billing staff assign tariffs" on public.customer_tariffs
  for all to authenticated using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));

grant select, insert, update, delete on public.base_tariffs, public.tariff_versions, public.tariff_breaks, public.tariff_cells,
  public.sales_tariffs, public.sales_margins, public.customer_tariffs to authenticated;
grant all on public.base_tariffs, public.tariff_versions, public.tariff_breaks, public.tariff_cells,
  public.sales_tariffs, public.sales_margins, public.customer_tariffs to service_role;

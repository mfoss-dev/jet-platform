-- Carrier invoice matching. The carrier's invoice data file (DHL MyBill CSV) is loaded line by line and each line is
-- matched to Jet's job: by Jet's connote (DHL's "Shipment Reference 1") or by the carrier's waybill. Finance then sees
-- only the exceptions:
--   no_job      the carrier charged for a shipment Jet has no job for (never billed)
--   duplicate   the waybill is already on an earlier invoice from the same carrier
--   below_cost  Jet billed less than the carrier charged (ex GST, freight + fuel + surcharges)
--   surcharge   carrier surcharges marked for review that Jet's add-on lines don't cover
--   heavier     the carrier billed a heavier weight than Jet did
-- Each exception is passed on (a charge line for the next invoice run), absorbed, disputed, or marked fine.
-- Only business fields are kept: the files' names, addresses and contacts are never loaded.

-- ---------------------------------------------------------------- each job's carrier and waybill
-- From JetStream (Billing.Provider / ProviderID) for now; new bookings will record it themselves.
create table public.shipment_waybills (
  connote text primary key,
  branch_code text not null references public.branches (code),
  carrier_code text not null,                    -- DHL, TNT, FEDEX, ...
  provider text,                                 -- JetStream's provider code, e.g. DHLEXP
  waybill text not null,
  source text not null default 'jetstream'
);
create index shipment_waybills_waybill on public.shipment_waybills (waybill);
create index if not exists charges_connote on public.charges (connote);

-- ---------------------------------------------------------------- carrier charge codes
-- How each carrier surcharge is treated when matching:
--   fuel      covered by Jet's own fuel surcharge
--   included  built into Jet's rates, never flagged
--   review    flagged when Jet's add-on lines on the job don't cover it (new codes start here)
create table public.carrier_charge_codes (
  carrier_code text not null,
  code text not null,
  name text not null,
  treatment text not null default 'review' check (treatment in ('fuel', 'included', 'review')),
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now(),
  primary key (carrier_code, code)
);
insert into public.carrier_charge_codes (carrier_code, code, name, treatment) values ('DHL', 'FF', 'FUEL SURCHARGE', 'fuel')
on conflict do nothing;

-- ---------------------------------------------------------------- carrier invoices and their lines
create table public.carrier_invoices (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,       -- load order, for spotting waybills charged twice
  carrier_code text not null,
  branch_code text not null references public.branches (code),
  invoice_number text not null,
  account_number text,
  invoice_date date,
  due_date date,
  currency text,
  total_ex numeric(12, 2) not null default 0,
  tax numeric(12, 2) not null default 0,
  file_name text,
  uploaded_by uuid references public.profiles (id),
  uploaded_at timestamptz not null default now(),
  matched_at timestamptz,
  unique (carrier_code, invoice_number)
);

create table public.carrier_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.carrier_invoices (id) on delete cascade,
  line_no integer not null,
  waybill text not null,
  reference text,                                -- the shipper's reference: Jet's connote
  shipped_on date,
  product text,
  product_name text,
  pieces integer,
  orig_country text,
  dest_country text,
  declared_kg numeric(10, 2),                    -- the customer's scale weight
  carrier_kg numeric(10, 2),                     -- the carrier's scale weight
  declared_vol_kg numeric(10, 2),
  carrier_vol_kg numeric(10, 2),
  weight_flag text,                              -- which weight the carrier billed on
  billed_kg numeric(10, 2),
  weight_charge numeric(12, 2) not null default 0,
  extras jsonb not null default '[]',            -- [{code, name, amount}], ex GST
  total_ex numeric(12, 2) not null default 0,
  tax numeric(12, 2) not null default 0,
  -- worked out by private.match_carrier_invoice
  connote text,
  customer_id uuid references public.customers (id),
  jet_kg numeric(10, 3),
  jet_billed numeric(12, 2),                     -- ex GST: charge + fuel + security on the job's freight lines
  jet_addons numeric(12, 2),                     -- the add-on part of that (lines other than .FREIGHT)
  review_extras numeric(12, 2) not null default 0,
  issues text[] not null default '{}',
  at_stake numeric(12, 2) not null default 0,
  decision text not null default 'pending' check (decision in ('pending', 'pass_on', 'absorb', 'dispute', 'ok')),
  decision_note text,
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  passed_charge_id uuid references public.charges (id) on delete set null,
  unique (invoice_id, line_no)
);
create index carrier_lines_waybill on public.carrier_invoice_lines (waybill);
create index carrier_lines_connote on public.carrier_invoice_lines (connote);
create index carrier_lines_open on public.carrier_invoice_lines (invoice_id) where decision = 'pending' and issues <> '{}';

create trigger carrier_invoices_audit after insert or update or delete on public.carrier_invoices for each row execute function private.audit();
create trigger carrier_charge_codes_audit after insert or update or delete on public.carrier_charge_codes for each row execute function private.audit();

alter table public.shipment_waybills enable row level security;
alter table public.carrier_charge_codes enable row level security;
alter table public.carrier_invoices enable row level security;
alter table public.carrier_invoice_lines enable row level security;
-- Carrier costs are Jet's business: staff read, and every change goes through the functions below.
create policy "Staff read waybills" on public.shipment_waybills for select to authenticated using ((select private.is_staff()));
create policy "Staff read carrier charge codes" on public.carrier_charge_codes for select to authenticated using ((select private.is_staff()));
create policy "Staff read carrier invoices" on public.carrier_invoices for select to authenticated using ((select private.is_staff()));
create policy "Staff read carrier invoice lines" on public.carrier_invoice_lines for select to authenticated using ((select private.is_staff()));
grant select on public.shipment_waybills, public.carrier_charge_codes, public.carrier_invoices, public.carrier_invoice_lines to authenticated;

drop policy "Managers read the audit log" on public.audit_log;
create policy "Managers read the audit log" on public.audit_log
  for select to authenticated
  using (
    (select private.can_manage_users())
    or ((select private.can_edit_billing()) and table_name in (
      'customers', 'jobs', 'reweighs', 'addon_rules', 'zones', 'zone_sets', 'base_tariffs', 'tariff_versions', 'tariff_rates',
      'sales_tariffs', 'sales_margins', 'customer_tariffs', 'invoice_runs', 'invoices', 'charges', 'carrier_invoices', 'carrier_charge_codes'))
  );

-- ---------------------------------------------------------------- matching
-- Re-runnable: Jet's side is looked up again each time (a job billed since, a code re-classified), and
-- decisions already made are kept.
create or replace function private.match_carrier_invoice(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_carrier text;
  v_seq bigint;
begin
  select carrier_code, seq into v_carrier, v_seq from public.carrier_invoices where id = p_id;

  -- Jet's connote: the reference when it is one, otherwise the job that has this waybill.
  update public.carrier_invoice_lines l
     set connote = coalesce(
           (select c.connote from public.charges c where c.connote = nullif(trim(l.reference), '') limit 1),
           (select w.connote from public.shipment_waybills w where w.waybill = l.waybill limit 1),
           (select c.connote from public.charges c where c.connote = l.waybill limit 1))
   where l.invoice_id = p_id;

  -- What Jet billed on that job (freight lines; do-not-bill lines left out, credit notes netted off).
  update public.carrier_invoice_lines l
     set customer_id = j.customer_id, jet_kg = j.kg, jet_billed = coalesce(j.billed, 0), jet_addons = coalesce(j.addons, 0)
    from (
      select l2.id,
             (select c.customer_id from public.charges c where c.connote = l2.connote order by (c.code = '.FREIGHT') desc, c.created_at limit 1) as customer_id,
             (select max(c.weight) from public.charges c where c.connote = l2.connote and c.kind = 'freight') as kg,
             (select sum(c.charge + c.fuel + c.security) from public.charges c where c.connote = l2.connote and c.kind = 'freight' and c.status <> 'no_bill') as billed,
             (select sum(c.charge) from public.charges c where c.connote = l2.connote and c.kind = 'freight' and c.status <> 'no_bill' and c.code <> '.FREIGHT') as addons
        from public.carrier_invoice_lines l2
       where l2.invoice_id = p_id
    ) j
   where l.id = j.id;

  update public.carrier_invoice_lines l
     set review_extras = coalesce((
           select sum((e ->> 'amount')::numeric)
             from jsonb_array_elements(l.extras) e
             left join public.carrier_charge_codes cc on cc.carrier_code = v_carrier and cc.code = e ->> 'code'
            where coalesce(cc.treatment, 'review') = 'review'), 0)
   where l.invoice_id = p_id;

  update public.carrier_invoice_lines l
     set issues = array_remove(array[
           case when l.connote is null then 'no_job' end,
           case when d.dup then 'duplicate' end,
           case when l.connote is not null and l.jet_billed < l.total_ex then 'below_cost' end,
           case when l.connote is not null and l.review_extras > l.jet_addons + 0.005 then 'surcharge' end,
           -- Carriers round up (whole kg within a country, half kg across borders), so only more than that counts.
           case when l.connote is not null and l.jet_kg > 0 and l.billed_kg >
                     case when l.orig_country = l.dest_country then ceil(l.jet_kg) else ceil(l.jet_kg * 2) / 2 end then 'heavier' end
         ], null),
         at_stake = case
           when l.connote is null or d.dup then greatest(l.total_ex, 0)
           else greatest(l.total_ex - l.jet_billed, l.review_extras - l.jet_addons, 0) end
    from (
      select l2.id, exists (
               select 1 from public.carrier_invoice_lines o join public.carrier_invoices oi on oi.id = o.invoice_id
                where o.waybill = l2.waybill and o.invoice_id <> l2.invoice_id and oi.carrier_code = v_carrier
                  and oi.seq < v_seq) as dup
        from public.carrier_invoice_lines l2 where l2.invoice_id = p_id
    ) d
   where l.id = d.id;

  update public.carrier_invoices set matched_at = now() where id = p_id;
end $$;
revoke all on function private.match_carrier_invoice(uuid) from public;

-- ---------------------------------------------------------------- loading a file
-- p_invoice: {carrier_code, branch_code, invoice_number, account_number, invoice_date, due_date, currency, total_ex, tax, file_name}
-- p_lines:   [{line_no, waybill, reference, shipped_on, product, product_name, pieces, orig_country, dest_country,
--              declared_kg, carrier_kg, declared_vol_kg, carrier_vol_kg, weight_flag, billed_kg, weight_charge,
--              extras: [{code, name, amount}], total_ex, tax}]
create or replace function public.import_carrier_invoice(p_invoice jsonb, p_lines jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_carrier text := upper(trim(coalesce(p_invoice ->> 'carrier_code', '')));
  v_number text := trim(coalesce(p_invoice ->> 'invoice_number', ''));
  v_branch text := p_invoice ->> 'branch_code';
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can load carrier invoices' using errcode = '42501';
  end if;
  if v_carrier = '' or v_number = '' then raise exception 'The file has no carrier or invoice number'; end if;
  if not exists (select 1 from public.branches where code = v_branch) then raise exception 'Unknown branch %', coalesce(v_branch, '(none)'); end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'The file has no shipment lines'; end if;
  if exists (select 1 from public.carrier_invoices where carrier_code = v_carrier and invoice_number = v_number) then
    raise exception '% invoice % is already loaded', v_carrier, v_number;
  end if;

  insert into public.carrier_invoices (carrier_code, branch_code, invoice_number, account_number, invoice_date, due_date, currency, total_ex, tax, file_name, uploaded_by)
  values (v_carrier, v_branch, v_number, p_invoice ->> 'account_number', (p_invoice ->> 'invoice_date')::date, (p_invoice ->> 'due_date')::date,
          p_invoice ->> 'currency', coalesce((p_invoice ->> 'total_ex')::numeric, 0), coalesce((p_invoice ->> 'tax')::numeric, 0),
          p_invoice ->> 'file_name', (select auth.uid()))
  returning id into v_id;

  insert into public.carrier_invoice_lines (invoice_id, line_no, waybill, reference, shipped_on, product, product_name, pieces, orig_country, dest_country,
    declared_kg, carrier_kg, declared_vol_kg, carrier_vol_kg, weight_flag, billed_kg, weight_charge, extras, total_ex, tax)
  select v_id, r.line_no, trim(r.waybill), nullif(trim(r.reference), ''), r.shipped_on, r.product, r.product_name, r.pieces, r.orig_country, r.dest_country,
         r.declared_kg, r.carrier_kg, r.declared_vol_kg, r.carrier_vol_kg, r.weight_flag, r.billed_kg, coalesce(r.weight_charge, 0),
         coalesce(r.extras, '[]'), coalesce(r.total_ex, 0), coalesce(r.tax, 0)
    from jsonb_to_recordset(p_lines) as r (line_no integer, waybill text, reference text, shipped_on date, product text, product_name text, pieces integer,
         orig_country text, dest_country text, declared_kg numeric, carrier_kg numeric, declared_vol_kg numeric, carrier_vol_kg numeric,
         weight_flag text, billed_kg numeric, weight_charge numeric, extras jsonb, total_ex numeric, tax numeric)
   where coalesce(trim(r.waybill), '') <> '';

  -- Surcharge codes seen for the first time start as "review".
  insert into public.carrier_charge_codes (carrier_code, code, name)
  select distinct on (e ->> 'code') v_carrier, e ->> 'code', coalesce(nullif(e ->> 'name', ''), e ->> 'code')
    from public.carrier_invoice_lines l, jsonb_array_elements(l.extras) e
   where l.invoice_id = v_id and coalesce(e ->> 'code', '') <> ''
  on conflict do nothing;

  perform private.match_carrier_invoice(v_id);
  return v_id;
end $$;

create or replace function public.rematch_carrier_invoice(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can re-match carrier invoices' using errcode = '42501';
  end if;
  perform private.match_carrier_invoice(p_id);
end $$;

-- Removing a file (loaded by mistake, or to load a corrected one). Not once anything on it was passed on.
create or replace function public.remove_carrier_invoice(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can remove carrier invoices' using errcode = '42501';
  end if;
  if exists (select 1 from public.carrier_invoice_lines where invoice_id = p_id and decision = 'pass_on') then
    raise exception 'Charges from this invoice were passed on to customers, so it stays';
  end if;
  delete from public.carrier_invoices where id = p_id;
end $$;

-- ---------------------------------------------------------------- decisions
--   pass_on  adds a charge line for the job's customer (the amount at stake, or p_amount for a single line),
--            picked up by the next invoice run; GST follows the carrier's own tax on the line
--   absorb   Jet carries the cost
--   dispute  challenged with the carrier
--   ok       checked, nothing to do
create or replace function public.decide_carrier_lines(p_ids uuid[], p_decision text, p_note text default null, p_amount numeric default null)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  l record;
  v_amount numeric;
  v_charge uuid;
  v_job record;
  n integer := 0;
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can decide carrier charges' using errcode = '42501';
  end if;
  if p_decision not in ('pass_on', 'absorb', 'dispute', 'ok') then raise exception 'Choose pass on, absorb, dispute or fine'; end if;
  if p_amount is not null and coalesce(array_length(p_ids, 1), 0) <> 1 then raise exception 'An amount can only be set for one line at a time'; end if;

  for l in
    select cl.*, ci.carrier_code from public.carrier_invoice_lines cl join public.carrier_invoices ci on ci.id = cl.invoice_id
     where cl.id = any (p_ids) and cl.decision = 'pending' for update of cl
  loop
    v_charge := null;
    if p_decision = 'pass_on' then
      v_amount := round(coalesce(p_amount, l.at_stake), 2);
      if l.customer_id is null then raise exception 'Waybill % has no Jet job, so there is no customer to pass it on to', l.waybill; end if;
      if v_amount <= 0 then raise exception 'Nothing to pass on for waybill % (enter an amount)', l.waybill; end if;
      select c.branch_code, c.service_code, c.shipped_on, c.pieces, c.orig_country, c.dest_country into v_job
        from public.charges c where c.connote = l.connote and c.customer_id = l.customer_id order by (c.code = '.FREIGHT') desc, c.created_at limit 1;
      insert into public.charges (branch_code, customer_id, connote, shipped_on, service_code, kind, code, description, charge, gst,
                                  pieces, weight, orig_country, dest_country, status, source)
      values (v_job.branch_code, l.customer_id, l.connote, coalesce(v_job.shipped_on, l.shipped_on), v_job.service_code, 'freight', 'zCARRIER',
              case
                when 'surcharge' = any (l.issues) then l.carrier_code || ' surcharges: ' || (
                  select string_agg(initcap(lower(e ->> 'name')), ', ') from jsonb_array_elements(l.extras) e
                    left join public.carrier_charge_codes cc on cc.carrier_code = l.carrier_code and cc.code = e ->> 'code'
                   where coalesce(cc.treatment, 'review') = 'review')
                when 'heavier' = any (l.issues) then 'Weight adjustment: carrier weight ' || trim(to_char(l.billed_kg, 'FM999990.0#')) || ' kg'
                else 'Carrier charge adjustment' end,
              v_amount,
              case when l.total_ex <> 0 and l.tax <> 0 then round(v_amount * round(l.tax / l.total_ex, 2), 2) else 0 end,
              v_job.pieces, l.billed_kg, v_job.orig_country, v_job.dest_country, 'new', 'carrier')
      returning id into v_charge;
    end if;
    update public.carrier_invoice_lines
       set decision = p_decision, decision_note = nullif(trim(p_note), ''), decided_by = (select auth.uid()), decided_at = now(),
           passed_charge_id = v_charge
     where id = l.id;
    perform private.log_change('carrier_invoices', l.invoice_id::text, jsonb_build_object(
      'waybill', l.waybill, 'connote', l.connote, 'decision', p_decision, 'amount', case when v_charge is not null then v_amount end, 'note', nullif(trim(p_note), '')));
    n := n + 1;
  end loop;
  return n;
end $$;

-- Re-classifying a surcharge code re-matches that carrier's invoices that still have open lines.
create or replace function public.set_carrier_charge_treatment(p_carrier text, p_code text, p_treatment text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can change carrier charge codes' using errcode = '42501';
  end if;
  update public.carrier_charge_codes set treatment = p_treatment, updated_by = (select auth.uid()), updated_at = now()
   where carrier_code = p_carrier and code = p_code;
  if not found then raise exception 'Unknown charge code % %', p_carrier, p_code; end if;
  for v_id in select distinct ci.id from public.carrier_invoices ci join public.carrier_invoice_lines cl on cl.invoice_id = ci.id
               where ci.carrier_code = p_carrier and cl.decision = 'pending' loop
    perform private.match_carrier_invoice(v_id);
  end loop;
end $$;

revoke all on function public.import_carrier_invoice(jsonb, jsonb), public.rematch_carrier_invoice(uuid), public.remove_carrier_invoice(uuid),
  public.decide_carrier_lines(uuid[], text, text, numeric), public.set_carrier_charge_treatment(text, text, text) from public, anon;
grant execute on function public.import_carrier_invoice(jsonb, jsonb), public.rematch_carrier_invoice(uuid), public.remove_carrier_invoice(uuid),
  public.decide_carrier_lines(uuid[], text, text, numeric), public.set_carrier_charge_treatment(text, text, text) to authenticated;

-- ---------------------------------------------------------------- list view
create view public.carrier_invoice_summary with (security_invoker = true) as
select ci.id, ci.carrier_code, ci.branch_code, ci.invoice_number, ci.account_number, ci.invoice_date, ci.due_date, ci.currency,
       ci.total_ex, ci.tax, ci.file_name, ci.uploaded_at, ci.matched_at, p.full_name as uploaded_by_name,
       count(cl.id)::integer as shipments,
       count(cl.connote)::integer as matched,
       coalesce(sum(cl.jet_billed), 0)::numeric(12, 2) as jet_billed,
       count(*) filter (where cl.issues <> '{}')::integer as exceptions,
       count(*) filter (where cl.issues <> '{}' and cl.decision = 'pending')::integer as open,
       coalesce(sum(cl.at_stake) filter (where cl.issues <> '{}' and cl.decision = 'pending'), 0)::numeric(12, 2) as open_at_stake,
       coalesce(sum(cl.total_ex) filter (where cl.connote is not null), 0)::numeric(12, 2) as matched_cost
  from public.carrier_invoices ci
  left join public.carrier_invoice_lines cl on cl.invoice_id = ci.id
  left join public.profiles p on p.id = ci.uploaded_by
 group by ci.id, p.full_name;
grant select on public.carrier_invoice_summary to authenticated;

notify pgrst, 'reload schema';

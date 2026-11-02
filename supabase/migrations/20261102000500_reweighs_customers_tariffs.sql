-- Reweigh decisions, customer holds and terms, zones and customer margins.
-- Fuel surcharges already exist (billing_core); scheduled changes are rows with a future effective_from.

-- ---------------------------------------------------------------- reweigh decisions
-- One call decides one or more reweighs and updates their jobs in the same transaction:
--   pass_on: the customer pays the extra; the job's charge goes up and it takes the carrier's weight
--   absorb:  Jet pays the extra; the customer's charge stays at the declared weight
--   dispute: challenged with the carrier; the customer is charged at the declared weight meanwhile
-- In every case the job's "reweigh" issue is cleared and it becomes ready to invoice.
-- Runs as the caller (security invoker), so the same row-level security applies as a direct edit.
create or replace function public.decide_reweighs(p_ids uuid[], p_decision public.reweigh_decision, p_note text default null)
returns integer
language plpgsql security invoker set search_path = '' as $$
declare
  n integer;
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can decide reweighs' using errcode = '42501';
  end if;
  if p_decision = 'pending' then
    raise exception 'Choose pass on, absorb or dispute';
  end if;

  with decided as (
    update public.reweighs r
       set decision = p_decision, decision_note = nullif(trim(p_note), ''), decided_by = (select auth.uid()), decided_at = now()
     where r.id = any (p_ids) and r.decision = 'pending'
     returning r.job_id, r.extra_charge, r.carrier_kg
  ), jobs_done as (
    update public.jobs j
       set sell_ex_gst = case when p_decision = 'pass_on' then coalesce(j.sell_ex_gst, 0) + d.extra_charge else j.sell_ex_gst end,
           carrier_weight_kg = d.carrier_kg,
           issue = case when j.issue = 'reweigh' then null else j.issue end,
           issue_note = case when j.issue = 'reweigh' then null else j.issue_note end,
           billing_status = case when j.issue = 'reweigh' and j.billing_status = 'needs_attention' then 'ready' else j.billing_status end
      from decided d
     where j.id = d.job_id
     returning j.id
  )
  select count(*) into n from decided;
  return n;
end $$;

revoke all on function public.decide_reweighs(uuid[], public.reweigh_decision, text) from public, anon;
grant execute on function public.decide_reweighs(uuid[], public.reweigh_decision, text) to authenticated;

-- ---------------------------------------------------------------- customer holds
create type public.hold_reason as enum ('overdue', 'credit_limit', 'disputed_invoice', 'customer_request', 'other');

alter table public.customers
  add column hold_reason public.hold_reason,
  add column hold_note text,
  add column held_at timestamptz;

-- Holds placed before these columns existed (the demo data), so the rule below holds for every row.
update public.customers set hold_reason = 'overdue', held_at = now() where status = 'on_hold' and hold_reason is null;

alter table public.customers
  add constraint customers_hold_check check ((status = 'on_hold') = (hold_reason is not null));

-- Finance places holds, so finance must be able to see a customer's history (the audit log was managers only).
drop policy "Managers read the audit log" on public.audit_log;
create policy "Managers read the audit log" on public.audit_log
  for select to authenticated
  using (
    (select private.can_manage_users())
    or ((select private.can_edit_billing()) and table_name in ('customers', 'jobs', 'reweighs', 'fuel_surcharges', 'customer_margins', 'zones'))
  );

-- ---------------------------------------------------------------- zones and customer margins
-- Working assumption D6: live carrier rate plus a per-customer margin, set by zone and weight band.
-- Chris can change margins himself at any time. (Stored tariff tables wait for Q2 and Wayne's data.)
create table public.zones (
  code text primary key,                       -- '1', '2', ... as on the DHL zone chart
  name text not null,
  sort integer not null default 0
);

create table public.customer_margins (
  customer_id uuid not null references public.customers (id) on delete cascade,
  zone_code text not null references public.zones (code),
  band text not null check (band in ('0.5', '5', '20', '20+')),   -- up to 0.5 kg, 5 kg, 20 kg, over 20 kg
  margin_pct numeric(5, 2) not null check (margin_pct between -50 and 300),
  updated_by uuid references public.profiles (id) default auth.uid(),
  updated_at timestamptz not null default now(),
  primary key (customer_id, zone_code, band)
);

create trigger customer_margins_touch before update on public.customer_margins
  for each row execute function private.touch_updated_at();
create trigger customer_margins_audit after insert or update or delete on public.customer_margins
  for each row execute function private.audit();
create trigger zones_audit after insert or update or delete on public.zones
  for each row execute function private.audit();

-- private.audit() records row_id from "id" or "code"; margins have neither, so give them a readable one.
create or replace function private.audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  old_row jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  new_row jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  r jsonb := coalesce(new_row, old_row);
begin
  if tg_op = 'UPDATE' and old_row = new_row then
    return new;
  end if;
  insert into public.audit_log (actor_id, actor_email, table_name, row_id, action, before, after)
  values (
    (select auth.uid()),
    (select auth.jwt() ->> 'email'),
    tg_table_name,
    coalesce(r ->> 'id', r ->> 'code', concat_ws('/', r ->> 'customer_id', r ->> 'zone_code', r ->> 'band')),
    lower(tg_op),
    old_row,
    new_row
  );
  return coalesce(new, old);
end $$;

alter table public.zones enable row level security;
alter table public.customer_margins enable row level security;

create policy "Signed-in users read zones" on public.zones for select to authenticated using (true);
create policy "Billing staff edit zones" on public.zones
  for all to authenticated using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));

-- Margins reveal cost, so staff only (not reps, not customers).
create policy "Staff read margins" on public.customer_margins for select to authenticated using ((select private.is_staff()));
create policy "Billing staff edit margins" on public.customer_margins
  for all to authenticated using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));

-- Explicit privileges (this project doesn't grant new tables automatically).
grant select on public.zones, public.customer_margins to authenticated;
grant insert, update, delete on public.zones, public.customer_margins to authenticated;
grant all on public.zones, public.customer_margins to service_role;

insert into public.zones (code, name, sort) values
  ('1', 'New Zealand', 1), ('2', 'Asia', 2), ('3', 'Pacific', 3), ('4', 'Middle East', 4),
  ('5', 'Africa', 5), ('6', 'Europe', 6), ('7', 'Americas', 7)
on conflict (code) do nothing;

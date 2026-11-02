-- Invoicing: JetStream's invoice run (frmAccRating / frmAccSendInvoices), automated so finance only handles exceptions.
--   * charges: the billable lines (JetStream's Transactions): freight, add-ons, manual charges and customs duties
--   * invoice_runs / invoices: a run gathers a branch's unbilled charges up to a period end and groups them into draft
--     invoices per bill-to account. Clean invoices are approved together; flagged ones wait for a person.
--   * numbers are given on approval, from a per-branch sequence (JetStream took max + 1, which could duplicate)
--   * due dates from the payment terms code (7D, 14D, 21D, 30D, 60D, EOM, 30EOM), counted from the invoice date
--   * duties are invoiced on their own, on 7-day terms, as in JetStream
-- Fixed on purpose, not copied: GST comes from the line for both branches (no hard-coded 10%), NZ totals include security.

alter table public.customers
  add column bill_to_id uuid references public.customers (id),          -- JetStream's BillTo: who pays (null = the customer)
  add column invoice_delivery text not null default 'email' check (invoice_delivery in ('email', 'post')),
  add column invoice_recipients text,                                    -- where invoices are emailed (comma-separated)
  add column invoice_csv boolean not null default false;                 -- also send the shipment CSV

create table public.invoice_sequences (
  branch_code text primary key references public.branches (code),
  next_number bigint not null
);
alter table public.invoice_sequences enable row level security;
grant all on public.invoice_sequences to service_role;

create table public.invoice_runs (
  id uuid primary key default gen_random_uuid(),
  branch_code text not null references public.branches (code),
  kind text not null check (kind in ('weekly', 'duties')),
  period_end date not null,
  invoice_date date not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'cancelled')),
  automatic boolean not null default false,             -- prepared by the schedule rather than a person
  created_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  approved_by uuid references public.profiles (id),
  approved_at timestamptz,
  source text                                           -- 'jetstream' for imported history
);
create index invoice_runs_branch on public.invoice_runs (branch_code, period_end desc);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.invoice_runs (id) on delete cascade,
  branch_code text not null references public.branches (code),
  number bigint,                                        -- given on approval
  kind text not null check (kind in ('weekly', 'duties', 'credit')),
  bill_to_id uuid not null references public.customers (id),
  invoice_date date not null,
  terms_code text,
  due_date date,
  charge_total numeric(12, 2) not null default 0,
  fuel_total numeric(12, 2) not null default 0,
  security_total numeric(12, 2) not null default 0,
  gst_total numeric(12, 2) not null default 0,
  total numeric(12, 2) not null default 0,
  status text not null default 'draft' check (status in ('draft', 'approved', 'sent', 'exported', 'void')),
  flags text[] not null default '{}',                   -- why a person should look before it goes
  sent_at timestamptz,
  exported_at timestamptz,
  source text,
  created_at timestamptz not null default now(),
  unique (branch_code, number)
);
create index invoices_bill_to on public.invoices (bill_to_id, invoice_date desc);
create index invoices_run on public.invoices (run_id);

create table public.charges (
  id uuid primary key default gen_random_uuid(),
  branch_code text not null references public.branches (code),
  customer_id uuid not null references public.customers (id) on delete cascade,   -- the account that shipped
  connote text not null,
  shipped_on date not null,
  service_code text,
  kind text not null default 'freight' check (kind in ('freight', 'duties')),
  code text not null,                                   -- .FREIGHT, add-on code, z... manual codes
  description text not null default '',
  charge numeric(12, 2) not null default 0,
  fuel numeric(12, 2) not null default 0,
  security numeric(12, 2) not null default 0,
  gst numeric(12, 2) not null default 0,
  income_account text,
  pieces integer,
  weight numeric(10, 3),
  orig_country text,
  dest_country text,
  reference text,
  status text not null default 'new' check (status in ('new', 'held', 'no_bill', 'invoiced')),
  invoice_id uuid references public.invoices (id) on delete set null,
  source text,                                          -- 'jetstream', 'rated', 'manual', 'demo'
  created_at timestamptz not null default now()
);
create index charges_unbilled on public.charges (branch_code, kind, status, shipped_on) where invoice_id is null;
create index charges_invoice on public.charges (invoice_id);
create index charges_customer on public.charges (customer_id, shipped_on desc);

create trigger invoice_runs_audit after insert or update or delete on public.invoice_runs for each row execute function private.audit();

alter table public.invoice_runs enable row level security;
alter table public.invoices enable row level security;
alter table public.charges enable row level security;
create policy "Staff read invoice runs" on public.invoice_runs for select to authenticated using ((select private.is_staff()));
create policy "People read their own invoices" on public.invoices for select to authenticated
  using ((select private.is_staff()) or (status in ('approved', 'sent', 'exported') and (select private.can_see_customer(bill_to_id))));
create policy "People read their own charges" on public.charges for select to authenticated
  using ((select private.is_staff()) or (status = 'invoiced' and (select private.can_see_customer(customer_id))));
create policy "Billing staff edit charges" on public.charges for all to authenticated
  using ((select private.can_edit_billing())) with check ((select private.can_edit_billing()));
grant select on public.invoice_runs, public.invoices to authenticated;
grant select, insert, update, delete on public.charges to authenticated;
grant all on public.invoice_runs, public.invoices, public.charges to service_role;

drop policy "Managers read the audit log" on public.audit_log;
create policy "Managers read the audit log" on public.audit_log
  for select to authenticated
  using (
    (select private.can_manage_users())
    or ((select private.can_edit_billing()) and table_name in (
      'customers', 'jobs', 'reweighs', 'addon_rules', 'zones', 'zone_sets', 'base_tariffs', 'tariff_versions', 'tariff_rates',
      'sales_tariffs', 'sales_margins', 'customer_tariffs', 'invoice_runs', 'invoices', 'charges'))
  );

-- ---------------------------------------------------------------- rules

-- Due date from JetStream's terms codes. EOM = end of the invoice month; 30EOM = 30 days after it. Unknown codes fall
-- back to the customer's days (and the invoice is flagged).
create or replace function private.due_date(p_terms text, p_date date, p_days integer default null)
returns date language sql immutable set search_path = '' as $$
  select case
    when upper(coalesce(p_terms, '')) ~ '^[0-9]+D$' then p_date + substring(upper(p_terms) from '^([0-9]+)')::integer
    when upper(p_terms) = 'EOM' then (date_trunc('month', p_date) + interval '1 month - 1 day')::date
    when upper(p_terms) ~ '^[0-9]+EOM$' then (date_trunc('month', p_date) + interval '1 month - 1 day')::date + substring(upper(p_terms) from '^([0-9]+)')::integer
    when p_days is not null then p_date + p_days
  end
$$;

-- Who pays for an account: its bill-to, or itself.
create or replace function private.bill_to(p_customer uuid)
returns uuid language sql stable set search_path = '' as $$
  select coalesce(c.bill_to_id, c.id) from public.customers c where c.id = p_customer
$$;

-- Build a run's draft invoices from unbilled charges: one per bill-to account. Runs without a permission check so the
-- schedule can call it; public.prepare_invoice_run() checks the caller.
create or replace function private.build_invoice_run(p_branch text, p_kind text, p_period_end date, p_invoice_date date, p_automatic boolean)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_run uuid;
  inv record;
  v_id uuid;
  v_flags text[];
  v_avg numeric;
begin
  if p_kind not in ('weekly', 'duties') then raise exception 'Unknown run type %', p_kind; end if;
  if exists (select 1 from public.invoice_runs where branch_code = p_branch and kind = p_kind and status = 'draft') then
    raise exception 'There is already a draft % run for %: approve or cancel it first', p_kind, p_branch;
  end if;
  insert into public.invoice_runs (branch_code, kind, period_end, invoice_date, automatic)
  values (p_branch, p_kind, p_period_end, p_invoice_date, p_automatic) returning id into v_run;

  for inv in
    select private.bill_to(ch.customer_id) as bill_to, array_agg(ch.id) as ids,
           sum(ch.charge) as charge, sum(ch.fuel) as fuel, sum(ch.security) as security, sum(ch.gst) as gst,
           bool_or(ch.code like 'z%' and p_kind = 'weekly') as manual,
           bool_or(ch.charge + ch.fuel + ch.security + ch.gst < 0) as credit_line
      from public.charges ch
     where ch.branch_code = p_branch and ch.kind = case p_kind when 'duties' then 'duties' else 'freight' end
       and ch.status = 'new' and ch.invoice_id is null and ch.shipped_on <= p_period_end
     group by private.bill_to(ch.customer_id)
  loop
    select array_remove(array[
      case when b.status = 'on_hold' then 'Account on hold' end,
      case when b.status = 'closed' then 'Account closed' end,
      case when p_kind = 'weekly' and b.payment_terms_code is not null and private.due_date(b.payment_terms_code, p_invoice_date) is null then 'Payment terms not recognised' end,
      case when inv.manual then 'Has manual charges' end,
      case when inv.credit_line then 'Has a credit line' end,
      case when inv.charge + inv.fuel + inv.security + inv.gst <= 0 then 'Total is zero or negative' end
    ], null) into v_flags
    from public.customers b where b.id = inv.bill_to;
    -- Much bigger than this account's usual invoice (average of its last 8).
    select avg(total) into v_avg from (select total from public.invoices where bill_to_id = inv.bill_to and kind = p_kind
      and status in ('approved', 'sent', 'exported') order by invoice_date desc limit 8) h;
    if v_avg > 0 and inv.charge + inv.fuel + inv.security + inv.gst > greatest(3 * v_avg, v_avg + 500) then
      v_flags := v_flags || format('About %s× the usual invoice', round((inv.charge + inv.fuel + inv.security + inv.gst) / v_avg));
    end if;

    insert into public.invoices (run_id, branch_code, kind, bill_to_id, invoice_date, terms_code, due_date,
                                 charge_total, fuel_total, security_total, gst_total, total, flags)
    select v_run, p_branch, p_kind, inv.bill_to, p_invoice_date,
           case when p_kind = 'duties' then '7D' else b.payment_terms_code end,
           case when p_kind = 'duties' then p_invoice_date + 7 else private.due_date(b.payment_terms_code, p_invoice_date, b.payment_terms_days) end,
           inv.charge, inv.fuel, inv.security, inv.gst, inv.charge + inv.fuel + inv.security + inv.gst, coalesce(v_flags, '{}')
      from public.customers b where b.id = inv.bill_to
    returning id into v_id;
    update public.charges set invoice_id = v_id where id = any (inv.ids);
  end loop;
  return v_run;
end $$;

create or replace function public.prepare_invoice_run(p_branch text, p_kind text, p_period_end date, p_invoice_date date default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_run uuid;
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can run invoicing' using errcode = '42501';
  end if;
  v_run := private.build_invoice_run(p_branch, p_kind, p_period_end, coalesce(p_invoice_date, p_period_end), false);
  perform private.log_change('invoice_runs', v_run::text, jsonb_build_object('prepared', p_kind, 'branch', p_branch, 'period_end', p_period_end,
    'invoices', (select count(*) from public.invoices where run_id = v_run)));
  return v_run;
end $$;

-- Approve draft invoices: numbers from the branch sequence (in number order by account), charges become invoiced.
-- p_invoices null = every unflagged draft in the run. The run is approved once no drafts are left.
create or replace function public.approve_invoices(p_run uuid, p_invoices uuid[] default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  r public.invoice_runs;
  i record;
  n integer := 0;
  v_no bigint;
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can approve invoices' using errcode = '42501';
  end if;
  select * into r from public.invoice_runs where id = p_run for update;
  if r.status <> 'draft' then raise exception 'This run is already %', r.status; end if;
  for i in
    select inv.id from public.invoices inv join public.customers c on c.id = inv.bill_to_id
     where inv.run_id = p_run and inv.status = 'draft'
       and (case when p_invoices is null then cardinality(inv.flags) = 0 else inv.id = any (p_invoices) end)
     order by c.account_code
  loop
    update public.invoice_sequences set next_number = next_number + 1 where branch_code = r.branch_code returning next_number - 1 into v_no;
    if v_no is null then raise exception 'No invoice numbering set for branch %', r.branch_code; end if;
    update public.invoices set number = v_no, status = 'approved' where id = i.id;
    update public.charges set status = 'invoiced' where invoice_id = i.id;
    n := n + 1;
  end loop;
  if not exists (select 1 from public.invoices where run_id = p_run and status = 'draft') then
    update public.invoice_runs set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = p_run;
  end if;
  if n > 0 then
    perform private.log_change('invoices', p_run::text, jsonb_build_object('approved', n, 'branch', r.branch_code, 'kind', r.kind, 'period_end', r.period_end));
  end if;
  return n;
end $$;

-- Take draft invoices out of a run: their charges go back to unbilled (next run picks them up), or are held.
create or replace function public.release_invoices(p_run uuid, p_invoices uuid[], p_hold boolean default false)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  n integer;
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can change invoice runs' using errcode = '42501';
  end if;
  update public.charges set invoice_id = null, status = case when p_hold then 'held' else status end
   where invoice_id in (select id from public.invoices where run_id = p_run and status = 'draft' and id = any (p_invoices));
  delete from public.invoices where run_id = p_run and status = 'draft' and id = any (p_invoices);
  get diagnostics n = row_count;
  if n > 0 then perform private.log_change('invoices', p_run::text, jsonb_build_object(case when p_hold then 'held' else 'carried_over' end, n)); end if;
  if not exists (select 1 from public.invoices where run_id = p_run and status = 'draft')
     and exists (select 1 from public.invoices where run_id = p_run) then
    update public.invoice_runs set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = p_run and status = 'draft';
  end if;
  return n;
end $$;

-- Cancel a draft run: every draft invoice is removed and its charges return to unbilled.
create or replace function public.cancel_invoice_run(p_run uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can change invoice runs' using errcode = '42501';
  end if;
  if exists (select 1 from public.invoices where run_id = p_run and status <> 'draft') then
    raise exception 'Some invoices in this run are approved; take out the drafts instead';
  end if;
  update public.charges set invoice_id = null where invoice_id in (select id from public.invoices where run_id = p_run);
  delete from public.invoices where run_id = p_run;
  update public.invoice_runs set status = 'cancelled' where id = p_run and status = 'draft';
end $$;

-- Put held charges back into billing.
create or replace function public.release_charges(p_ids uuid[])
returns integer language plpgsql security invoker set search_path = '' as $$
declare n integer;
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can change charges' using errcode = '42501';
  end if;
  update public.charges set status = 'new' where id = any (p_ids) and status in ('held', 'no_bill') and invoice_id is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- The schedule: every Thursday morning a weekly draft per branch up to last Sunday, and every weekday a duties draft,
-- so finance opens a prepared run instead of building one. Skips a branch that already has a draft or nothing to bill.
create or replace function private.prepare_scheduled_runs()
returns void language plpgsql security definer set search_path = '' as $$
declare
  b record;
  today date := (now() at time zone 'Australia/Sydney')::date;
  sunday date := today - extract(isodow from today)::integer;
begin
  for b in select code from public.branches loop
    if extract(isodow from today) = 4
       and not exists (select 1 from public.invoice_runs where branch_code = b.code and kind = 'weekly' and status = 'draft')
       and exists (select 1 from public.charges where branch_code = b.code and kind = 'freight' and status = 'new' and invoice_id is null and shipped_on <= sunday) then
      perform private.build_invoice_run(b.code, 'weekly', sunday, sunday, true);
    end if;
    if extract(isodow from today) between 1 and 5
       and not exists (select 1 from public.invoice_runs where branch_code = b.code and kind = 'duties' and status = 'draft')
       and exists (select 1 from public.charges where branch_code = b.code and kind = 'duties' and status = 'new' and invoice_id is null) then
      perform private.build_invoice_run(b.code, 'duties', today, today, true);
    end if;
  end loop;
end $$;

revoke all on function private.build_invoice_run(text, text, date, date, boolean), private.prepare_scheduled_runs() from public, anon, authenticated;
grant execute on function private.due_date(text, date, integer), private.bill_to(uuid) to authenticated;
revoke all on function public.prepare_invoice_run(text, text, date, date), public.approve_invoices(uuid, uuid[]),
  public.release_invoices(uuid, uuid[], boolean), public.cancel_invoice_run(uuid), public.release_charges(uuid[]) from public, anon;
grant execute on function public.prepare_invoice_run(text, text, date, date), public.approve_invoices(uuid, uuid[]),
  public.release_invoices(uuid, uuid[], boolean), public.cancel_invoice_run(uuid), public.release_charges(uuid[]) to authenticated;

-- Schedule it where pg_cron is available (the hosted project); local test databases skip this.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('prepare-invoice-runs', '0 19 * * *', 'select private.prepare_scheduled_runs()');   -- 6am Sydney (summer)
exception when others then
  raise notice 'pg_cron not available: invoice runs are prepared by hand';
end $$;

-- ---------------------------------------------------------------- summaries for the screens (run as the caller)
create view public.unbilled_summary with (security_invoker = true) as
select branch_code, kind, status, count(*)::integer as lines, count(distinct connote)::integer as shipments,
       sum(charge + fuel + security + gst) as total, min(shipped_on) as oldest
  from public.charges where invoice_id is null and status in ('new', 'held', 'no_bill')
 group by branch_code, kind, status;

create view public.invoice_run_summary with (security_invoker = true) as
select r.id, r.branch_code, r.kind, r.period_end, r.invoice_date, r.status, r.automatic, r.source, r.created_at, r.approved_at,
       count(i.id)::integer as invoices,
       (count(i.id) filter (where i.status = 'draft'))::integer as drafts,
       (count(i.id) filter (where i.status = 'draft' and cardinality(i.flags) > 0))::integer as flagged,
       coalesce(sum(i.total), 0) as total, min(i.number) as first_number, max(i.number) as last_number
  from public.invoice_runs r left join public.invoices i on i.run_id = r.id
 group by r.id;
grant select on public.unbilled_summary, public.invoice_run_summary to authenticated;

-- Shipments that aren't priced stay out of invoice runs, as in JetStream (which won't lock them): a line at JetStream's
-- rating-error placeholder (999,999) or a shipment totalling zero. They stay unbilled and show as "not ready".

create or replace function private.shipment_ready(p_branch text, p_connote text)
returns boolean language sql stable set search_path = '' as $$
  select coalesce(max(charge) < 999000 and sum(charge + fuel + security + gst) <> 0, false)
    from public.charges where branch_code = p_branch and connote = p_connote and invoice_id is null and status = 'new'
$$;
revoke all on function private.shipment_ready(text, text) from public, anon;
grant execute on function private.shipment_ready(text, text) to authenticated;

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
       and private.shipment_ready(ch.branch_code, ch.connote)
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

-- Unbilled work per branch, type and status, split into shipments ready to invoice and those that aren't priced.
create or replace view public.unbilled_summary with (security_invoker = true) as
with s as (
  select branch_code, kind, status, connote, count(*) as n, sum(charge + fuel + security + gst) as t, max(charge) as mx, min(shipped_on) as oldest
    from public.charges where invoice_id is null and status in ('new', 'held', 'no_bill')
   group by branch_code, kind, status, connote
)
select branch_code, kind, status, sum(n)::integer as lines, count(*)::integer as shipments,
       sum(t) as total, min(oldest) as oldest, (mx < 999000 and t <> 0) as ready
  from s group by branch_code, kind, status, (mx < 999000 and t <> 0);

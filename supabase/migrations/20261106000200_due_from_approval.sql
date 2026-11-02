-- Due dates count from the day an invoice is approved (and sent), not its invoice date: JetStream counts from its send
-- date, and weekly invoices dated Sunday go out on Thursday, so counting from the invoice date would cut 4 days from
-- customers' terms. Checked against JetStream's issued invoices (validate-invoices.sql).
-- Approve draft invoices: numbers from the branch sequence (in number order by account), charges become invoiced.
-- The due date is set on approval, counted from that day (a draft shows it counted from the invoice date).
-- p_invoices null = every unflagged draft in the run. The run is approved once no drafts are left.
create or replace function public.approve_invoices(p_run uuid, p_invoices uuid[] default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  r public.invoice_runs;
  i record;
  n integer := 0;
  v_no bigint;
  v_today date;
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can approve invoices' using errcode = '42501';
  end if;
  select * into r from public.invoice_runs where id = p_run for update;
  if r.status <> 'draft' then raise exception 'This run is already %', r.status; end if;
  select (now() at time zone b.timezone)::date into v_today from public.branches b where b.code = r.branch_code;
  for i in
    select inv.id from public.invoices inv join public.customers c on c.id = inv.bill_to_id
     where inv.run_id = p_run and inv.status = 'draft'
       and (case when p_invoices is null then cardinality(inv.flags) = 0 else inv.id = any (p_invoices) end)
     order by c.account_code
  loop
    update public.invoice_sequences set next_number = next_number + 1 where branch_code = r.branch_code returning next_number - 1 into v_no;
    if v_no is null then raise exception 'No invoice numbering set for branch %', r.branch_code; end if;
    -- Terms count from the day the invoice is approved and sent, as JetStream counts from its send date.
    update public.invoices inv set number = v_no, status = 'approved',
           due_date = case when inv.kind = 'duties' then v_today + 7 else coalesce(private.due_date(inv.terms_code, v_today, c.payment_terms_days), inv.due_date) end
      from public.customers c where inv.id = i.id and c.id = inv.bill_to_id;
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

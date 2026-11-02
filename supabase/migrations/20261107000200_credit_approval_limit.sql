-- Who approves a credit note. Finance (Monica, Maree) raise them and approve the small ones themselves; one over the
-- branch's limit (inc GST) needs management or the owner (Chris, Nigel), and never the person who raised it.
-- Management set the limit per branch, in the branch's currency.

alter table public.branches add column credit_approval_limit numeric(12, 2) not null default 500 check (credit_approval_limit >= 0);

-- Can the signed-in person approve this credit note? Null when they can; otherwise the reason they can't.
create or replace function private.credit_approval_blocker(p_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when not private.can_edit_billing() then 'Only finance and management can approve credit notes'
    when -cn.total <= b.credit_approval_limit then null
    when private.my_role() not in ('owner', 'management') then format('Credit notes over %s need management approval', b.credit_approval_limit)
    when cn.created_by = (select auth.uid()) then 'Someone else in management must approve a credit note you raised over the limit'
  end
  from public.invoices cn join public.branches b on b.code = cn.branch_code
  where cn.id = p_id
$$;

create or replace function public.approve_credit_note(p_id uuid)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  cn public.invoices;
  v_no bigint;
  v_block text;
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can approve credit notes' using errcode = '42501';
  end if;
  select * into cn from public.invoices where id = p_id and kind = 'credit' for update;
  if cn.id is null or cn.status <> 'draft' then raise exception 'Only a draft credit note can be approved'; end if;
  v_block := private.credit_approval_blocker(p_id);
  if v_block is not null then raise exception '%', v_block using errcode = '42501'; end if;
  update public.invoice_sequences set next_number = next_number + 1 where branch_code = cn.branch_code returning next_number - 1 into v_no;
  if v_no is null then raise exception 'No invoice numbering set for branch %', cn.branch_code; end if;
  update public.invoices set number = v_no, status = 'approved', approved_by = auth.uid(), approved_at = now() where id = p_id;
  update public.charges set status = 'invoiced' where invoice_id = p_id;
  if cn.rebill_to_id is not null then
    insert into public.charges (branch_code, customer_id, connote, shipped_on, service_code, kind, code, description,
                                charge, fuel, security, gst, income_account, pieces, weight, orig_country, dest_country, reference, source)
    select branch_code, cn.rebill_to_id, connote, shipped_on, service_code, kind, code, description,
           -charge, -fuel, -security, -gst, income_account, pieces, weight, orig_country, dest_country,
           format('Re-billed from invoice %s', (select number from public.invoices where id = cn.credit_for)), 'rebill'
      from public.charges where invoice_id = p_id;
  end if;
  perform private.log_change('invoices', p_id::text, jsonb_build_object('credit_approved', v_no, 'total', cn.total, 'rebilled', cn.rebill_to_id is not null));
  return v_no;
end $$;

create or replace function public.set_credit_approval_limit(p_branch text, p_limit numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare v_old numeric;
begin
  if coalesce(private.my_role() in ('owner', 'management'), false) is false then
    raise exception 'Only management can change the credit approval limit' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 0 then raise exception 'The limit must be zero or more'; end if;
  select credit_approval_limit into v_old from public.branches where code = p_branch;
  if v_old is null then raise exception 'Unknown branch %', p_branch; end if;
  update public.branches set credit_approval_limit = round(p_limit, 2) where code = p_branch;
  perform private.log_change('branches', p_branch, jsonb_build_object('credit_approval_limit', jsonb_build_object('from', v_old, 'to', round(p_limit, 2))));
end $$;

-- Drafts with who may approve them, for the screens.
create view public.credit_note_queue with (security_invoker = true) as
select cn.id, cn.branch_code, cn.invoice_date, cn.total, cn.reason, cn.created_by, cn.bill_to_id,
       -cn.total > b.credit_approval_limit as needs_management, b.credit_approval_limit,
       private.credit_approval_blocker(cn.id) is null as i_can_approve, p.full_name as raised_by
  from public.invoices cn join public.branches b on b.code = cn.branch_code
  left join public.profiles p on p.id = cn.created_by
 where cn.kind = 'credit' and cn.status = 'draft';

revoke all on function public.set_credit_approval_limit(text, numeric) from public, anon;
grant execute on function public.set_credit_approval_limit(text, numeric) to authenticated;
grant execute on function private.credit_approval_blocker(uuid) to authenticated;
grant select on public.credit_note_queue to authenticated;

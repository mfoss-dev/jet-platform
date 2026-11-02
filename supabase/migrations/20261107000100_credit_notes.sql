-- Credit notes (adjustment notes), which JetStream never had: finance credited by hand in MYOB.
--   * a credit note is raised against an issued invoice, for whole lines or part of a line, with a reason
--   * its lines are charges with negative amounts, each linked to the line it credits, so a line can't be credited
--     for more than was billed (draft credits count too)
--   * approval numbers it from the branch's invoice sequence; until then it can be discarded
--   * "re-bill" puts the credited amounts back into billing on another account (wrong account billed), so the next
--     run invoices them there

alter table public.invoices
  add column credit_for uuid references public.invoices (id),           -- the invoice a credit note adjusts
  add column reason text,
  add column rebill_to_id uuid references public.customers (id),        -- re-bill the credited lines to this account
  add column created_by uuid references public.profiles (id) default auth.uid(),
  add column approved_by uuid references public.profiles (id),
  add column approved_at timestamptz;
alter table public.invoices add constraint credit_has_invoice check ((kind = 'credit') = (credit_for is not null));
create index invoices_credit_for on public.invoices (credit_for) where credit_for is not null;

alter table public.charges add column credit_of uuid references public.charges (id);   -- the line a credit line credits
create index charges_credit_of on public.charges (credit_of) where credit_of is not null;

-- What is left to credit on each line of an invoice (ex GST and each part), after every credit note against it.
create or replace function private.creditable_lines(p_invoice uuid)
returns table (id uuid, charge numeric, fuel numeric, security numeric, gst numeric)
language sql stable set search_path = '' as $$
  select o.id, o.charge + coalesce(c.charge, 0), o.fuel + coalesce(c.fuel, 0), o.security + coalesce(c.security, 0), o.gst + coalesce(c.gst, 0)
    from public.charges o
    left join lateral (
      select sum(x.charge) as charge, sum(x.fuel) as fuel, sum(x.security) as security, sum(x.gst) as gst
        from public.charges x join public.invoices ci on ci.id = x.invoice_id
       where x.credit_of = o.id and ci.status <> 'void'
    ) c on true
   where o.invoice_id = p_invoice
$$;

-- Raise a draft credit note. p_lines: [{"id": charge id, "amount": ex-GST amount to credit}], or null for everything
-- still creditable on the invoice. Fuel, security and GST are credited in proportion.
create or replace function public.create_credit_note(p_invoice uuid, p_lines jsonb, p_reason text, p_rebill_to uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  inv public.invoices;
  v_id uuid;
  v_today date;
  l record;
  v_amount numeric;
  v_ex numeric;
  r numeric;
  c_fuel numeric; c_sec numeric; c_gst numeric;
  n integer := 0;
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can raise credit notes' using errcode = '42501';
  end if;
  select * into inv from public.invoices where id = p_invoice;
  if inv.id is null or inv.kind = 'credit' or inv.status not in ('approved', 'sent', 'exported') then
    raise exception 'Credit notes are raised against an issued invoice';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason for the credit'; end if;
  if p_rebill_to is not null and not exists (select 1 from public.customers where id = p_rebill_to and branch_code = inv.branch_code) then
    raise exception 'Re-bill to an account in the same branch';
  end if;
  select (now() at time zone b.timezone)::date into v_today from public.branches b where b.code = inv.branch_code;

  insert into public.invoices (branch_code, kind, bill_to_id, invoice_date, credit_for, reason, rebill_to_id)
  values (inv.branch_code, 'credit', inv.bill_to_id, v_today, inv.id, trim(p_reason), p_rebill_to) returning id into v_id;

  for l in
    select o.*, cl.charge as r_charge, cl.fuel as r_fuel, cl.security as r_security, cl.gst as r_gst,
           (select (x->>'amount')::numeric from jsonb_array_elements(p_lines) x where (x->>'id')::uuid = o.id limit 1) as wanted
      from public.charges o join private.creditable_lines(p_invoice) cl on cl.id = o.id
     where p_lines is null or o.id in (select (x->>'id')::uuid from jsonb_array_elements(p_lines) x)
     order by o.connote, o.code
  loop
    v_ex := l.r_charge + l.r_fuel + l.r_security;
    v_amount := round(coalesce(l.wanted, v_ex), 2);
    if v_amount = 0 then continue; end if;
    if v_amount < 0 or v_amount > v_ex + 0.005 then
      raise exception 'Line % % can be credited up to % ex GST', l.connote, coalesce(nullif(l.description, ''), l.code), v_ex;
    end if;
    if v_amount >= v_ex - 0.005 then         -- the rest of the line, exactly
      c_fuel := l.r_fuel; c_sec := l.r_security; c_gst := l.r_gst;
      v_amount := v_ex;
    else
      r := v_amount / v_ex;
      c_fuel := round(l.r_fuel * r, 2); c_sec := round(l.r_security * r, 2); c_gst := round(l.r_gst * r, 2);
    end if;
    insert into public.charges (branch_code, customer_id, connote, shipped_on, service_code, kind, code, description,
                                charge, fuel, security, gst, income_account, pieces, weight, orig_country, dest_country, reference,
                                invoice_id, credit_of, source)
    values (l.branch_code, l.customer_id, l.connote, l.shipped_on, l.service_code, l.kind, l.code, l.description,
            -(v_amount - c_fuel - c_sec), -c_fuel, -c_sec, -c_gst, l.income_account, l.pieces, l.weight, l.orig_country, l.dest_country, l.reference,
            v_id, l.id, 'credit');
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'Nothing left to credit on those lines'; end if;
  if p_lines is not null and n < (select count(*) from jsonb_array_elements(p_lines) x where coalesce((x->>'amount')::numeric, 1) <> 0) then
    raise exception 'Some lines are not on this invoice';
  end if;

  update public.invoices i set charge_total = s.charge, fuel_total = s.fuel, security_total = s.security, gst_total = s.gst,
         total = s.charge + s.fuel + s.security + s.gst
    from (select sum(charge) as charge, sum(fuel) as fuel, sum(security) as security, sum(gst) as gst from public.charges where invoice_id = v_id) s
   where i.id = v_id;
  perform private.log_change('invoices', v_id::text, jsonb_build_object('credit_raised_for', inv.number, 'reason', trim(p_reason), 'lines', n,
    'total', (select total from public.invoices where id = v_id), 'rebill_to', p_rebill_to));
  return v_id;
end $$;

-- Approve a draft credit note: numbered from the branch sequence; re-billed lines go back into billing.
create or replace function public.approve_credit_note(p_id uuid)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  cn public.invoices;
  v_no bigint;
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can approve credit notes' using errcode = '42501';
  end if;
  select * into cn from public.invoices where id = p_id and kind = 'credit' for update;
  if cn.id is null or cn.status <> 'draft' then raise exception 'Only a draft credit note can be approved'; end if;
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

-- Throw away a draft credit note.
create or replace function public.discard_credit_note(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can change credit notes' using errcode = '42501';
  end if;
  if not exists (select 1 from public.invoices where id = p_id and kind = 'credit' and status = 'draft') then
    raise exception 'Only a draft credit note can be discarded';
  end if;
  delete from public.charges where invoice_id = p_id;
  delete from public.invoices where id = p_id;
  perform private.log_change('invoices', p_id::text, jsonb_build_object('credit_discarded', true));
end $$;

revoke all on function private.creditable_lines(uuid) from public, anon;
grant execute on function private.creditable_lines(uuid) to authenticated;
revoke all on function public.create_credit_note(uuid, jsonb, text, uuid), public.approve_credit_note(uuid), public.discard_credit_note(uuid) from public, anon;
grant execute on function public.create_credit_note(uuid, jsonb, text, uuid), public.approve_credit_note(uuid), public.discard_credit_note(uuid) to authenticated;

-- Carrier invoices for any carrier: a waybill is looked up only among that carrier's jobs, so two carriers
-- with the same waybill number can't match the wrong job. Otherwise unchanged from 20261111000100.
create or replace function private.match_carrier_invoice(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_carrier text;
  v_seq bigint;
begin
  select carrier_code, seq into v_carrier, v_seq from public.carrier_invoices where id = p_id;

  -- Jet's connote: the reference when it is one, otherwise the job that has this waybill (on this carrier).
  update public.carrier_invoice_lines l
     set connote = coalesce(
           (select c.connote from public.charges c where c.connote = nullif(trim(l.reference), '') limit 1),
           (select w.connote from public.shipment_waybills w where w.waybill = l.waybill and w.carrier_code = v_carrier limit 1),
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

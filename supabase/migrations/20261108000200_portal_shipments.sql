-- My shipments (customer portal): one row per shipment the person's account sent, invoiced or not.
--   * The amount shows only once the shipment is invoiced: before that the price can still change (reweighs, holds,
--     shipments JetStream couldn't price).
--   * Shipments marked do-not-bill are left out for customers. Credit lines don't add rows, but they reduce the amount.
--   * Staff see every customer's shipments.
-- A function rather than a view: unbilled charges are hidden from customers by row-level security, so this reads
-- them as its owner and applies the same customer check itself.
create or replace function public.portal_shipments()
returns table (
  connote text, kind text, branch_code text, customer_id uuid, account_code text, customer_name text, shipped_on date,
  service_code text, service_name text, pieces integer, weight numeric, orig_country text, dest_country text, reference text,
  status text, total numeric, invoice_id uuid, invoice_number bigint
)
language sql stable security definer set search_path = '' as $$
  select ch.connote, ch.kind, ch.branch_code, ch.customer_id, c.account_code, c.name, min(ch.shipped_on),
         min(ch.service_code), min(ts.name), max(ch.pieces), max(ch.weight), min(ch.orig_country), min(ch.dest_country),
         min(ch.reference),
         case when bool_and(ch.status = 'invoiced' or ch.credit_of is not null) then 'invoiced' else 'to_invoice' end,
         case when bool_and(ch.status = 'invoiced' or ch.credit_of is not null)
              then sum(ch.charge + ch.fuel + ch.security + ch.gst) filter (where ch.status = 'invoiced') end,
         (array_agg(i.id order by i.invoice_date) filter (where i.kind <> 'credit'))[1],
         (array_agg(i.number order by i.invoice_date) filter (where i.kind <> 'credit'))[1]
    from public.charges ch
    join public.customers c on c.id = ch.customer_id
    left join public.invoices i on i.id = ch.invoice_id and i.status in ('approved', 'sent', 'exported')
    left join public.tariff_services ts on ts.code = ch.service_code
   where (private.is_staff() or private.can_see_customer(ch.customer_id))
     and (private.is_staff() or ch.status <> 'no_bill')
     and not (ch.credit_of is not null and i.id is null)                       -- lines of a draft credit note
   group by ch.connote, ch.kind, ch.branch_code, ch.customer_id, c.account_code, c.name
$$;
revoke all on function public.portal_shipments() from public, anon;
grant execute on function public.portal_shipments() to authenticated;

-- Customers see every line of an invoice they pay, including shipments sent from their other accounts (a bill-to
-- account pays for its branches' shipments), and their own invoiced lines as before. Draft credit lines stay hidden.
drop policy "People read their own charges" on public.charges;
create policy "People read their own charges" on public.charges for select to authenticated
  using (
    (select private.is_staff())
    or (status = 'invoiced' and (
      (select private.can_see_customer(customer_id))
      or exists (select 1 from public.invoices i where i.id = invoice_id and i.status in ('approved', 'sent', 'exported')
                 and (select private.can_see_customer(i.bill_to_id)))
    ))
  );

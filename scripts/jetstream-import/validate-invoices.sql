-- Compares the invoice run's rules with the invoices JetStream actually issued (imported history):
--   grouping  : does each line's bill-to account (our rule) match the account JetStream invoiced?
--   one each  : did JetStream issue one invoice per account per run, as our run does?
--   due dates : does our terms calculation (from the invoice date) give JetStream's due date? JetStream counts from
--               the day it sent the invoice, so invoices sent later than their date differ by design.
--   totals    : does each invoice's total equal the sum of its lines?
--   npx supabase db query --linked -f scripts/jetstream-import/validate-invoices.sql
with js as (
  select i.*, c.payment_terms_code, c.payment_terms_days from public.invoices i join public.customers c on c.id = i.bill_to_id where i.source = 'jetstream'
),
lines as (
  select js.kind, count(*) as lines, count(*) filter (where private.bill_to(ch.customer_id) = js.bill_to_id) as same_bill_to
    from public.charges ch join js on js.id = ch.invoice_id group by js.kind
),
per_account as (
  select kind, run_id, bill_to_id, count(*) as n from js group by kind, run_id, bill_to_id
),
dues as (
  select kind, count(*) as invoices,
         count(*) filter (where due_date = case when kind = 'duties' then invoice_date + 7
                                                else private.due_date(payment_terms_code, invoice_date, payment_terms_days) end) as same_due
    from js where due_date is not null group by kind
),
totals as (
  select js.kind, count(*) filter (where abs(js.total - coalesce(s.t, 0)) < 0.01) as same_total
    from js left join (select invoice_id, sum(charge + fuel + security + gst) as t from public.charges group by invoice_id) s on s.invoice_id = js.id
   group by js.kind
)
select d.kind, d.invoices,
       l.lines, round(100.0 * l.same_bill_to / l.lines, 1) as pct_lines_same_bill_to,
       (select count(*) from per_account p where p.kind = d.kind) as account_runs,
       round(100.0 * (select count(*) from per_account p where p.kind = d.kind and p.n = 1) / (select count(*) from per_account p where p.kind = d.kind), 1) as pct_one_invoice_per_account_run,
       round(100.0 * d.same_due / d.invoices, 1) as pct_same_due_date,
       round(100.0 * t.same_total / d.invoices, 1) as pct_total_equals_lines
  from dues d join lines l using (kind) join totals t using (kind)
 order by d.kind;

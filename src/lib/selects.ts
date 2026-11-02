// Every column list the app sends to Supabase, in one place, so `npm run test:api` can check each one
// against the real Test database (a typo or ambiguous join fails there, before anyone sees an error page).
// Node 24 runs this TypeScript file directly, so the check script imports it too.

export const SELECTS = {
  profile: { table: 'profiles', select: 'email, full_name, role, active, customer:customers!profiles_customer_id_fkey(name, account_code)' },
  feed: {
    table: 'job_list',
    select: 'id, connote, customer_name, account_code, carrier_code, service_name, booked_at, origin_city, dest_city, dest_country, declared_weight_kg, carrier_weight_kg, sell_ex_gst, cost_ex_gst, margin_pct, status, billing_status, issue, issue_note',
  },
  reweighs: {
    table: 'reweighs',
    select: 'id, source_file, declared_kg, carrier_kg, extra_charge, decision, decision_note, decided_at, created_at, job:jobs!reweighs_job_id_fkey(connote, sell_ex_gst, customer:customers!jobs_customer_id_fkey(name, account_code)), decider:profiles!reweighs_decided_by_fkey(full_name)',
  },
  customers: {
    table: 'customers',
    select: 'id, account_code, name, branch_code, status, payment_terms_days, billing_email, hold_reason, held_at, rep:profiles!customers_rep_id_fkey(full_name)',
  },
  customer: {
    table: 'customers',
    select: 'id, account_code, name, branch_code, status, payment_terms_days, billing_email, hold_reason, hold_note, held_at, created_at, rep:profiles!customers_rep_id_fkey(full_name)',
  },
  openJobs: { table: 'job_list', select: 'customer_id' },
  customerJobs: { table: 'job_list', select: 'id, connote, booked_at, carrier_code, dest_city, sell_ex_gst, billing_status, issue' },
  history: { table: 'audit_log', select: 'id, at, actor_email, action, before, after' },
  addonRules: { table: 'addon_rules', select: 'id, branch_code, customer_id, service_code, code, description, valid_from, valid_to, apply_when, percentage_of, percentage, fixed_fee, minimum, range_from, range_to, add_fuel, add_security, add_gst, source, customer:customers(name, account_code)' },
  carriers: { table: 'carriers', select: 'code, name' },
  branches: { table: 'branches', select: 'code, name' },
  services: { table: 'services', select: 'id, carrier_code, code, name' },
  zones: { table: 'zones', select: 'code, name, sort' },
  baseTariffs: { table: 'base_tariffs', select: 'id, code, name, carrier_code, branch_code, service_code, zone_set_id, cost_only' },
  zoneSets: { table: 'zone_sets', select: 'id, code, name, branch_code' },
  tariffServices: { table: 'tariff_services', select: 'code, name' },
  tariffVersions: { table: 'tariff_versions', select: 'id, tariff_id, version, status, valid_from, note, volumetric_divisor, published_at, publisher:profiles!tariff_versions_published_by_fkey(full_name)' },
  tariffRates: { table: 'tariff_rates', select: 'zone_code, kind, from_kg, to_kg, step_kg, method, charge, basic, minimum' },
  salesTariffs: { table: 'sales_tariffs', select: 'id, code, name, base_tariff_id, branch_code, service_code, base:base_tariffs(code, name)' },
  salesMargins: { table: 'sales_margins', select: 'zone_code, kind, to_kg, margin_pct' },
  customerTariffs: { table: 'customer_tariffs', select: 'customer_id, service_code, effective_from, effective_to, sales_tariff_id, volumetric_divisor, sales:sales_tariffs(code, name)' },
  audit: { table: 'audit_log', select: 'id, at, actor_email, table_name, row_id, action, before, after' },
  salesUsage: { table: 'sales_tariff_usage', select: 'sales_tariff_id, customers' },
  salesCustomers: { table: 'customer_tariffs', select: 'effective_from, effective_to, customer:customers(id, name, account_code)' },
  salesReview: { table: 'sales_tariff_review', select: 'id, code, name, branch_code, service_code, is_standard, base_tariff_id, rate_card, customers, cells, min_margin, avg_margin, max_margin, distinct_margins, jobs_12m, freight_12m' },
  runSummary: { table: 'invoice_run_summary', select: 'id, branch_code, kind, period_end, invoice_date, status, automatic, source, created_at, approved_at, invoices, drafts, flagged, total, first_number, last_number' },
  unbilled: { table: 'unbilled_summary', select: 'branch_code, kind, status, lines, shipments, total, oldest, ready' },
  invoiceList: { table: 'invoices', select: 'id, run_id, branch_code, number, kind, invoice_date, due_date, terms_code, total, gst_total, status, flags, reason, bill_to:customers!invoices_bill_to_id_fkey(id, name, account_code)' },
  invoice: { table: 'invoices', select: 'id, run_id, branch_code, number, kind, invoice_date, due_date, terms_code, charge_total, fuel_total, security_total, gst_total, total, status, flags, sent_at, exported_at, source, credit_for, reason, approved_at, bill_to:customers!invoices_bill_to_id_fkey(id, name, account_code, invoice_recipients), rebill_to:customers!invoices_rebill_to_id_fkey(name, account_code), original:invoices!invoices_credit_for_fkey(id, number)' },
  credits: { table: 'invoices', select: 'id, number, status, invoice_date, total, reason' },
  creditedLines: { table: 'charges', select: 'credit_of, charge, fuel, security, gst' },
  invoiceLines: { table: 'charges', select: 'id, connote, shipped_on, service_code, kind, code, description, charge, fuel, security, gst, income_account, pieces, weight, orig_country, dest_country, invoice_id, customer:customers!charges_customer_id_fkey(name, account_code)' },
  unpriced: { table: 'charges', select: 'id, branch_code, connote, shipped_on, code, description, charge, status, customer:customers!charges_customer_id_fkey(name, account_code)' },
  heldCharges: { table: 'charges', select: 'id, branch_code, connote, shipped_on, code, description, charge, fuel, security, gst, status, customer:customers!charges_customer_id_fkey(name, account_code)' },
  customerPicker: { table: 'customers', select: 'id, account_code, name' },
} as const;

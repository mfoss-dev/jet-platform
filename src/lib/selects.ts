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
  fuel: { table: 'fuel_surcharges', select: 'id, carrier_code, rate_pct, effective_from, created_at, carrier:carriers(name)' },
  carriers: { table: 'carriers', select: 'code, name' },
  zones: { table: 'zones', select: 'code, name, sort' },
  margins: { table: 'customer_margins', select: 'zone_code, band, margin_pct, updated_at' },
  audit: { table: 'audit_log', select: 'id, at, actor_email, table_name, row_id, action, before, after' },
  customerPicker: { table: 'customers', select: 'id, account_code, name' },
} as const;

-- Explicit table privileges. This Supabase project doesn't grant new tables to the API roles automatically,
-- so every table needs a GRANT. Privileges only open the door; the row-level security policies decide
-- which rows (and, through job_list, which columns) each person actually gets. New tables in later
-- migrations must add their own grants here-style, or the app gets "permission denied".

grant select on
  public.branches, public.carriers, public.services, public.fuel_surcharges,
  public.customers, public.jobs, public.reweighs, public.profiles, public.audit_log, public.user_invites
to authenticated;

grant insert, update, delete on
  public.customers, public.jobs, public.reweighs, public.carriers, public.services, public.fuel_surcharges, public.user_invites
to authenticated;

grant update on public.profiles to authenticated;

-- Server-side jobs (automations, imports) use the service role, which bypasses row-level security.
grant all on all tables in schema public to service_role;

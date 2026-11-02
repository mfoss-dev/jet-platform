-- Create a rate card with its first draft in one step, optionally starting from a copy of another card's
-- version (same weight breaks and prices, e.g. DHL Economy from DHL Express), so nothing is half-created.
create or replace function public.create_rate_card(
  p_code text, p_name text, p_branch text, p_carrier text, p_service uuid default null, p_copy_version uuid default null)
returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  t_id uuid;
  v_id uuid;
begin
  if not private.can_edit_billing() then
    raise exception 'Only finance and management can create rate cards' using errcode = '42501';
  end if;
  insert into public.base_tariffs (code, name, branch_code, carrier_code, service_id)
  values (upper(trim(p_code)), trim(p_name), p_branch, p_carrier, p_service)
  returning id into t_id;
  insert into public.tariff_versions (tariff_id, version, note)
  values (t_id, 1, case when p_copy_version is null then 'New rate card' else 'Copied from another rate card' end)
  returning id into v_id;
  if p_copy_version is not null then
    insert into public.tariff_breaks (version_id, kind, to_kg, method, step_kg)
      select v_id, kind, to_kg, method, step_kg from public.tariff_breaks where version_id = p_copy_version;
    insert into public.tariff_cells (version_id, kind, to_kg, zone_code, charge)
      select v_id, kind, to_kg, zone_code, charge from public.tariff_cells where version_id = p_copy_version;
  end if;
  return v_id;
end $$;

revoke all on function public.create_rate_card(text, text, text, text, uuid, uuid) from public, anon;
grant execute on function public.create_rate_card(text, text, text, text, uuid, uuid) to authenticated;

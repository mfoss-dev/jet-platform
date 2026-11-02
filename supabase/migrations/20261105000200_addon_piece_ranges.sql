-- Per-piece add-on ranges are decimals (JetStream's oversize rule is "over 100.001 cm"); they were read as whole numbers,
-- so a piece of exactly 100 cm was charged. Found by validate-addons.mjs against billed jobs.
create or replace function private.range_num(p text) returns numeric
language sql immutable set search_path = '' as $$
  select coalesce(nullif(substring(coalesce(p, '') from '^\s*(-?[0-9]*\.?[0-9]+)'), '')::numeric, 0)
$$;
grant execute on function private.range_num(text) to authenticated;

-- All the add-on lines for a shipment (the freight line included, via the .FREIGHT rule), as JetStream builds them.
-- p_pieces: [{"weight": kg, "max_dim": cm}, ...] for per-piece rules (oversize, overweight).
create or replace function public.charge_lines(
  p_customer uuid, p_service text, p_date date, p_freight numeric, p_weight numeric,
  p_orig_country text, p_orig_postcode text, p_dest_country text, p_dest_postcode text,
  p_declared numeric default 0, p_insured numeric default 0, p_priority boolean default false, p_dtp boolean default false,
  p_pieces jsonb default '[]')
returns table (code text, description text, charge numeric, fuel numeric, security numeric, gst numeric, income_account text, per_piece boolean)
language plpgsql stable security invoker set search_path = '' as $$
#variable_conflict use_column
declare
  fuel_pct numeric := 0;
  sec_pct numeric := 0;
  gst_pct numeric := 0;
  gst_on_fuel boolean := false;
  gst_on_sec boolean := false;
  seen text[] := '{}';
  prev text := '';
  fuel_base numeric := 0;
  r public.addon_rules;
  amt numeric;
  fv numeric;
  sv numeric;
  pc jsonb;
  resets constant text[] := array['DESTPC', 'ORIGPC', 'DESTCC', 'DESTCC/KG', 'ORIGCC/KG', 'DESTPC/KG', 'ORIGPC/KG', 'DESTCCPC', 'DESTCC.PC', 'ORIGCC.PC', 'ORIGCCPC'];
begin
  -- Percentages: the first #FUEL / #SEC / #GST rule in order.
  for r in select * from private.addon_rules_for(p_customer, p_service, p_date) where upper(code) in ('#FUEL', '#SEC', '#GST') loop
    continue when upper(r.code) = any (seen);
    seen := seen || upper(r.code);
    if upper(r.code) = '#FUEL' then fuel_pct := r.percentage; gst_on_fuel := r.add_gst;
    elsif upper(r.code) = '#SEC' then sec_pct := r.percentage; gst_on_sec := r.add_gst;
    else gst_pct := r.percentage;
    end if;
  end loop;

  -- Shipment-level add-ons: first matching rule per code (range conditions let later rules of the same code try).
  for r in select * from private.addon_rules_for(p_customer, p_service, p_date) loop
    continue when upper(r.code) in ('#FUEL', '#SEC', '#GST');
    continue when upper(r.code) = prev;
    prev := upper(r.code);
    continue when upper(r.apply_when) in ('PCWEIGHT', 'PCDIM');
    if not private.addon_matches(r, p_weight, p_orig_country, p_orig_postcode, p_dest_country, p_dest_postcode, p_declared, p_insured, p_priority, p_dtp) then
      if upper(r.apply_when) = any (resets) then prev := ''; end if;
      continue;
    end if;
    amt := private.addon_amount(case when upper(r.apply_when) = 'LAST' then fuel_base else p_freight end, p_insured,
                                upper(r.percentage_of), r.percentage, r.fixed_fee, r.minimum, p_weight);
    fv := case when r.add_fuel then amt * fuel_pct / 100 else 0 end;
    sv := case when r.add_security then amt * sec_pct / 100 else 0 end;
    code := r.code; description := r.description; charge := round(amt, 2); fuel := round(fv, 2); security := round(sv, 2);
    gst := round(case when r.add_gst then (amt + case when gst_on_fuel then fv else 0 end + case when gst_on_sec then sv else 0 end) * gst_pct / 100 else 0 end, 2);
    income_account := r.income_account; per_piece := false;
    return next;
    if r.add_fuel then fuel_base := fuel_base + amt; end if;
  end loop;

  -- Per-piece add-ons: every matching rule, for every piece (JetStream doesn't add GST on the fuel of these).
  for r in select * from private.addon_rules_for(p_customer, p_service, p_date) where upper(apply_when) in ('PCWEIGHT', 'PCDIM') loop
    for pc in select * from jsonb_array_elements(coalesce(p_pieces, '[]')) loop
      continue when not (case upper(r.apply_when)
        when 'PCWEIGHT' then coalesce((pc ->> 'weight')::numeric, 0) between private.range_num(r.range_from) and private.range_num(r.range_to)
        else coalesce((pc ->> 'max_dim')::numeric, 0) between private.range_num(r.range_from) and private.range_num(r.range_to) end);
      amt := private.addon_amount(0, 0, upper(r.percentage_of), r.percentage, r.fixed_fee, r.minimum, 0);
      fv := case when r.add_fuel then amt * fuel_pct / 100 else 0 end;
      sv := case when r.add_security then amt * sec_pct / 100 else 0 end;
      code := r.code; description := r.description; charge := round(amt, 2); fuel := round(fv, 2); security := round(sv, 2);
      gst := round(case when r.add_gst then amt * gst_pct / 100 else 0 end, 2);
      income_account := r.income_account; per_piece := true;
      return next;
    end loop;
  end loop;
end $$;

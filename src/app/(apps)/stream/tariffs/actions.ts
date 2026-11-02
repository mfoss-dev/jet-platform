'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

const back = (query: string, msg: string): never => redirect(`/stream/tariffs?${query}&msg=${encodeURIComponent(msg)}`);

// ---------------------------------------------------------------- fuel and add-ons

const dayBefore = (d: string) => new Date(new Date(`${d}T00:00:00Z`).getTime() - 864e5).toISOString().slice(0, 10);

// Set the fuel surcharge for a branch and service from a date (JetStream's #FUEL rule). The general rate running at that
// date is closed the day before, so exactly one general rate applies on any day.
export async function scheduleFuel(formData: FormData) {
  const branch = String(formData.get('branch_code') ?? '');
  const service = String(formData.get('service_code') ?? '');
  const rate = Number(formData.get('rate_pct'));
  const from = String(formData.get('valid_from') ?? '');
  if (!branch || !service || !/^\d{4}-\d{2}-\d{2}$/.test(from)) back('tab=fuel', 'Choose a branch, a service and a start date.');
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) back('tab=fuel', 'The rate must be between 0% and 100%.');
  const supabase = await createClient();
  const { data: open } = await supabase.from('addon_rules').select('id, valid_from')
    .eq('branch_code', branch).eq('service_code', service).eq('code', '#FUEL').is('customer_id', null).lte('valid_from', from).gte('valid_to', from);
  for (const r of open ?? []) {
    if (r.valid_from === from) await supabase.from('addon_rules').delete().eq('id', r.id);
    else await supabase.from('addon_rules').update({ valid_to: dayBefore(from) }).eq('id', r.id);
  }
  const { data: later } = await supabase.from('addon_rules').select('valid_from')
    .eq('branch_code', branch).eq('service_code', service).eq('code', '#FUEL').is('customer_id', null).gt('valid_from', from).order('valid_from').limit(1);
  const { data, error } = await supabase.from('addon_rules').insert({
    branch_code: branch, service_code: service, code: '#FUEL', description: 'Fuel surcharge', valid_from: from,
    valid_to: later?.[0] ? dayBefore(later[0].valid_from) : '9999-12-31', apply_when: 'ADD=Y', percentage: rate, add_gst: true,
  }).select('id');
  revalidatePath('/stream/tariffs');
  if (error) back('tab=fuel', `Not saved: ${error.message}`);
  if (!data?.length) back('tab=fuel', 'Not saved: you don’t have permission to change fuel.');
  back('tab=fuel', `${service} fuel (${branch}) set to ${rate}% from ${from} · logged`);
}

// Withdraw a fuel rate that hasn't started; the rate before it carries on.
export async function cancelFuel(formData: FormData) {
  const id = String(formData.get('id'));
  const today = new Date().toISOString().slice(0, 10);
  const supabase = await createClient();
  const { data: r } = await supabase.from('addon_rules').select('branch_code, service_code, valid_from, valid_to').eq('id', id).single();
  const { data, error } = await supabase.from('addon_rules').delete().eq('id', id).eq('code', '#FUEL').gt('valid_from', today).select('id');
  if (error || !data?.length) back('tab=fuel', `Not cancelled: ${error?.message ?? 'only future rates can be withdrawn'}`);
  if (r) {
    await supabase.from('addon_rules').update({ valid_to: r.valid_to }).eq('branch_code', r.branch_code).eq('service_code', r.service_code)
      .eq('code', '#FUEL').is('customer_id', null).eq('valid_to', dayBefore(r.valid_from));
  }
  revalidatePath('/stream/tariffs');
  back('tab=fuel', 'Scheduled fuel rate withdrawn · logged');
}

const APPLY_WHEN = ['ALWAYS', 'INSURED', 'PRIORITY', 'DTP', 'DESTPC', 'ORIGPC', 'DESTCC', 'DESTCC/KG', 'ORIGCC/KG', 'DESTPC/KG', 'ORIGPC/KG',
  'DESTCCPC', 'ORIGCCPC', 'DESTCC.PC', 'ORIGCC.PC', 'VALUE', 'TLWEIGHT', 'LAST', 'PCWEIGHT', 'PCDIM', 'MANUAL', 'ADHOC'];

// Create or update an add-on rule. Changing a rule's price from a date is done by ending it and adding a new one,
// so past jobs keep the price they were charged.
export async function saveAddon(formData: FormData) {
  const id = String(formData.get('id') ?? '');
  const f = (k: string) => String(formData.get(k) ?? '').trim();
  const row = {
    branch_code: f('branch_code'), service_code: f('service_code') || null, code: f('code').toUpperCase().replace(/^Z/, 'z'), description: f('description'),
    valid_from: f('valid_from'), valid_to: f('valid_to') || '9999-12-31', apply_when: f('apply_when').toUpperCase(), percentage_of: f('percentage_of') || null,
    percentage: Number(f('percentage') || 0), fixed_fee: Number(f('fixed_fee') || 0), minimum: Number(f('minimum') || 0),
    range_from: f('range_from') || null, range_to: f('range_to') || null,
    add_fuel: formData.get('add_fuel') === 'on', add_security: formData.get('add_security') === 'on', add_gst: formData.get('add_gst') === 'on',
  };
  const q = `tab=addons${id ? `&addon=${id}` : ''}`;
  if (!row.code || !row.branch_code || !/^\d{4}-\d{2}-\d{2}$/.test(row.valid_from) || !APPLY_WHEN.includes(row.apply_when)) {
    back(q, 'Give the add-on a code, branch, start date and when it applies.');
  }
  if ([row.percentage, row.fixed_fee, row.minimum].some((n) => !Number.isFinite(n))) back(q, 'Percent, fee and minimum must be numbers.');
  const supabase = await createClient();
  const { data, error } = id
    ? await supabase.from('addon_rules').update(row).eq('id', id).select('id')
    : await supabase.from('addon_rules').insert(row).select('id');
  revalidatePath('/stream/tariffs');
  if (error) back(q, `Not saved: ${error.message}`);
  if (!data?.length) back(q, 'Not saved: you don’t have permission to change add-ons.');
  back(`tab=addons&addon=${data![0].id}`, `Add-on ${row.code} saved · logged`);
}

export async function endAddon(formData: FormData) {
  const id = String(formData.get('id'));
  const to = String(formData.get('valid_to') ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) back(`tab=addons&addon=${id}`, 'Choose the last day the add-on applies.');
  const supabase = await createClient();
  const { data, error } = await supabase.from('addon_rules').update({ valid_to: to }).eq('id', id).select('id');
  revalidatePath('/stream/tariffs');
  if (error || !data?.length) back(`tab=addons&addon=${id}`, `Not saved: ${error?.message ?? 'no permission'}`);
  back(`tab=addons&addon=${id}`, `Add-on ends on ${to} · logged`);
}

// ---------------------------------------------------------------- rate cards

export type RateRow = {
  zone_code: string; kind: 'doc' | 'parcel'; from_kg: number; to_kg: number; step_kg: number;
  method: 'E' | 'I' | 'M'; charge: number; basic: number; minimum: number;
};
export type RateKey = { zone_code: string; kind: 'doc' | 'parcel'; to_kg: number };

// Saves changed rows (upsert) and removed rows (delete) on a draft. The database refuses published versions.
export async function saveRates(versionId: string, upserts: RateRow[], deletes: RateKey[], note: string) {
  const supabase = await createClient();
  let changed = 0;
  if (deletes.length) {
    const { data, error } = await supabase.rpc('delete_tariff_rates', { p_version: versionId, p_keys: deletes });
    if (error) return { ok: false, message: `Not saved: ${error.message}` };
    changed += Number(data ?? 0);
  }
  if (upserts.length) {
    const { data, error } = await supabase.rpc('upsert_tariff_rates', { p_version: versionId, p_rates: upserts, p_note: note });
    if (error) return { ok: false, message: `Not saved: ${error.message}` };
    changed += Number(data ?? 0);
  }
  revalidatePath('/stream/tariffs');
  return { ok: true, message: changed ? `Draft saved · ${changed} rate${changed === 1 ? '' : 's'} changed · logged` : 'Draft saved · nothing changed' };
}

// Percentage change on a draft, optionally only zones matching a filter (big domestic cards are changed this way).
export async function adjustDraft(formData: FormData) {
  const version = String(formData.get('version_id'));
  const tariff = String(formData.get('tariff_id'));
  const pct = Number(formData.get('pct'));
  const zone = String(formData.get('zone_like') ?? '').trim();
  const kind = String(formData.get('kind') ?? '');
  const q = `tab=rates&tariff=${tariff}&version=${version}${zone ? `&zq=${encodeURIComponent(zone)}` : ''}`;
  if (!Number.isFinite(pct) || pct === 0 || Math.abs(pct) > 100) back(q, 'Enter a percentage between -100 and 100, e.g. 3.5.');
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('adjust_tariff_draft', {
    p_version: version, p_pct: pct, p_zone_like: zone ? `%${zone}%` : null, p_kind: kind === 'doc' || kind === 'parcel' ? kind : null,
  });
  revalidatePath('/stream/tariffs');
  if (error) back(q, `Not changed: ${error.message}`);
  back(q, `${pct > 0 ? '+' : ''}${pct}% applied to ${Number(data)} rates${zone ? ` in zones matching "${zone}"` : ''} · logged`);
}

export async function newDraft(formData: FormData) {
  const from = String(formData.get('from_version'));
  const tariff = String(formData.get('tariff_id'));
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('new_tariff_draft', { p_from_version: from });
  revalidatePath('/stream/tariffs');
  if (error) back(`tab=rates&tariff=${tariff}`, `No draft created: ${error.message}`);
  back(`tab=rates&tariff=${tariff}&version=${data}`, 'New draft created. Nothing changes for customers until it is published.');
}

export async function publishVersion(formData: FormData) {
  const version = String(formData.get('version_id'));
  const tariff = String(formData.get('tariff_id'));
  const from = String(formData.get('valid_from') ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) back(`tab=rates&tariff=${tariff}&version=${version}`, 'Choose the date the new rates start.');
  const supabase = await createClient();
  const { error } = await supabase.rpc('publish_tariff_version', { p_version: version, p_valid_from: from });
  revalidatePath('/stream/tariffs');
  if (error) back(`tab=rates&tariff=${tariff}&version=${version}`, `Not published: ${error.message}`);
  back(`tab=rates&tariff=${tariff}&version=${version}`, `Published · jobs booked from ${from} use these rates · logged`);
}

export async function deleteDraft(formData: FormData) {
  const version = String(formData.get('version_id'));
  const tariff = String(formData.get('tariff_id'));
  const supabase = await createClient();
  const { data, error } = await supabase.from('tariff_versions').delete().eq('id', version).eq('status', 'draft').select('id');
  revalidatePath('/stream/tariffs');
  if (error || !data?.length) back(`tab=rates&tariff=${tariff}&version=${version}`, `Not deleted: ${error?.message ?? 'only drafts can be deleted'}`);
  back(`tab=rates&tariff=${tariff}`, 'Draft deleted · logged');
}

// A new rate card starts as a draft (version 1), blank or copied from another card's version.
export async function createRateCard(formData: FormData) {
  const code = String(formData.get('code') ?? '').trim().toUpperCase();
  const name = String(formData.get('name') ?? '').trim();
  const carrier = String(formData.get('carrier_code') ?? '');
  const branch = String(formData.get('branch_code') ?? '');
  const service = String(formData.get('service_code') ?? '');
  const zoneSet = String(formData.get('zone_set_id') ?? '') || null;
  const copy = String(formData.get('copy_version') ?? '') || null;
  if (!/^[A-Z0-9.-]{2,24}$/.test(code) || !name || !carrier || !branch || !service) {
    back('tab=rates', 'Give the rate card a code (letters, numbers, dots, dashes), a name, a carrier, a service and a branch.');
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('create_rate_card', {
    p_code: code, p_name: name, p_branch: branch, p_carrier: carrier, p_service: service, p_zone_set: zoneSet, p_copy_version: copy,
  });
  revalidatePath('/stream/tariffs');
  if (error) back('tab=rates', `Not created: ${error.message.includes('duplicate') ? `the code ${code} is already used in that branch` : error.message}`);
  const { data: v } = await supabase.from('tariff_versions').select('tariff_id').eq('id', data as string).single();
  back(`tab=rates&tariff=${v?.tariff_id}&version=${data}`, `Rate card ${code} created as a draft. Fill in the prices, then publish it.`);
}

// ---------------------------------------------------------------- sales tariffs

export type MarginRow = { zone_code: string; kind: 'doc' | 'parcel'; to_kg: number; margin_pct: number | null };

// Saves changed margins (null removes one). Changes apply straight away, as in JetStream.
export async function saveMargins(salesId: string, rows: MarginRow[]) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('save_sales_margins', { p_sales: salesId, p_margins: rows });
  revalidatePath('/stream/tariffs');
  if (error) return { ok: false, message: `Not saved: ${error.message}` };
  const n = Number(data ?? 0);
  return { ok: true, message: n ? `${n} margin${n === 1 ? '' : 's'} saved · logged` : 'Nothing changed' };
}

export async function createSalesTariff(formData: FormData) {
  const code = String(formData.get('code') ?? '').trim().toUpperCase();
  const name = String(formData.get('name') ?? '').trim();
  const base = String(formData.get('base_tariff_id') ?? '');
  const copyFrom = String(formData.get('copy_from') ?? '');
  if (!/^[A-Z0-9.-]{2,24}$/.test(code) || !name || !base) back('tab=sales', 'Give the sales tariff a code (letters, numbers, dots, dashes), a name and a rate card.');
  const supabase = await createClient();
  const { data: card } = await supabase.from('base_tariffs').select('branch_code, service_code').eq('id', base).single();
  const { data, error } = await supabase.from('sales_tariffs')
    .insert({ code, name, base_tariff_id: base, branch_code: card?.branch_code, service_code: card?.service_code }).select('id').single();
  if (error) back('tab=sales', `Not created: ${error.message.includes('duplicate') ? `the code ${code} is already used` : error.message}`);
  if (copyFrom) {
    const { data: src } = await supabase.from('sales_margins').select('zone_code, kind, to_kg, margin_pct').eq('sales_tariff_id', copyFrom);
    if (src?.length) await supabase.rpc('save_sales_margins', { p_sales: data!.id, p_margins: src });
  }
  revalidatePath('/stream/tariffs');
  back(`tab=sales&sales=${data!.id}`, `Sales tariff ${code} created · logged`);
}

// ---------------------------------------------------------------- standardising pricing

// Move the ticked customers from one sales tariff to another from a start date; earlier jobs keep their price.
export async function moveCustomers(formData: FormData) {
  const from = String(formData.get('from') ?? '');
  const to = String(formData.get('to') ?? '');
  const start = String(formData.get('start') ?? '');
  const customers = formData.getAll('customer').map(String).filter(Boolean);
  const q = `tab=standardise&from=${from}&to=${to}`;
  if (!customers.length) back(q, 'Choose at least one customer to move.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) back(q, 'Choose the date the new prices start.');
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('move_customers_to_tariff', { p_from: from, p_to: to, p_customers: customers, p_date: start });
  revalidatePath('/stream/tariffs');
  if (error) back(q, `Not moved: ${error.message}`);
  back(`tab=standardise&from=${from}&to=${to}`, `${data} customer${data === 1 ? '' : 's'} moved from ${start} · logged`);
}

export async function setStandard(formData: FormData) {
  const id = String(formData.get('id') ?? '');
  const on = formData.get('standard') !== 'off';
  const ret = String(formData.get('return') ?? 'tab=standardise');
  const supabase = await createClient();
  const { error } = await supabase.rpc('set_standard_tariff', { p_sales: id, p_standard: on });
  revalidatePath('/stream/tariffs');
  if (error) back(ret, `Not saved: ${error.message}`);
  back(ret, on ? 'Standard tariff set · logged' : 'No longer the standard tariff · logged');
}

'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

const back = (query: string, msg: string): never => redirect(`/stream/tariffs?${query}&msg=${encodeURIComponent(msg)}`);

// ---------------------------------------------------------------- fuel

// Schedule (or correct) a carrier's fuel surcharge from a date. Same carrier and date replaces the earlier entry.
export async function scheduleFuel(formData: FormData) {
  const carrier = String(formData.get('carrier_code') ?? '');
  const rate = Number(formData.get('rate_pct'));
  const from = String(formData.get('effective_from') ?? '');
  if (!carrier || !/^\d{4}-\d{2}-\d{2}$/.test(from)) back('tab=fuel', 'Choose a carrier and a start date.');
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) back('tab=fuel', 'The rate must be between 0% and 100%.');

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('fuel_surcharges')
    .upsert({ carrier_code: carrier, rate_pct: rate, effective_from: from }, { onConflict: 'carrier_code,effective_from' })
    .select('id');
  revalidatePath('/stream/tariffs');
  if (error) back('tab=fuel', `Not saved: ${error.message}`);
  if (!data?.length) back('tab=fuel', 'Not saved: you don’t have permission to change fuel surcharges.');
  back('tab=fuel', `${carrier} fuel set to ${rate}% from ${from} · logged`);
}

// Only changes that haven't started yet can be withdrawn; past rates stay as the record of what was charged.
export async function cancelFuel(formData: FormData) {
  const id = String(formData.get('id'));
  const today = new Date().toISOString().slice(0, 10);
  const supabase = await createClient();
  const { data, error } = await supabase.from('fuel_surcharges').delete().eq('id', id).gt('effective_from', today).select('id');
  revalidatePath('/stream/tariffs');
  if (error) back('tab=fuel', `Not cancelled: ${error.message}`);
  back('tab=fuel', data?.length ? 'Scheduled change cancelled · logged' : 'Not cancelled: only future changes can be withdrawn.');
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

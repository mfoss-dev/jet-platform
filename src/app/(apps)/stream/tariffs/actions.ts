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

export type BreakInput = { kind: 'doc' | 'parcel'; to_kg: number; method: 'E' | 'I' | 'M'; step_kg: number; cells: Record<string, number | null> };

// Saves a whole draft grid. The database refuses published versions and non-billing staff.
export async function saveDraft(versionId: string, breaks: BreakInput[], note: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('save_tariff_draft', { p_version: versionId, p_breaks: breaks, p_note: note });
  revalidatePath('/stream/tariffs');
  if (error) return { ok: false, message: `Not saved: ${error.message}` };
  const n = Number(data ?? 0);
  return { ok: true, message: n ? `Draft saved · ${n} rate${n === 1 ? '' : 's'} changed · logged` : 'Draft saved · no rates changed' };
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

// ---------------------------------------------------------------- sales tariffs

const BAND_KEYS = ['0.5', '5', '20', 'over'];

// Saves the margin grid for one sales tariff. Blank cells are removed.
export async function saveSalesMargins(formData: FormData) {
  const id = String(formData.get('sales_tariff_id'));
  const q = `tab=sales&sales=${id}`;
  const rows: { sales_tariff_id: string; zone_code: string; up_to_kg: number | null; margin_pct: number }[] = [];
  const blanks: { zone: string; band: string }[] = [];
  for (const [k, v] of formData.entries()) {
    const m = /^m\|([^|]+)\|(.+)$/.exec(k);
    if (!m || !BAND_KEYS.includes(m[2])) continue;
    const text = String(v).trim().replace('%', '');
    if (!text) { blanks.push({ zone: m[1], band: m[2] }); continue; }
    const pct = Number(text);
    if (!Number.isFinite(pct) || pct < -50 || pct > 500) back(q, `Zone ${m[1]}: margins must be between -50% and 500%.`);
    rows.push({ sales_tariff_id: id, zone_code: m[1], up_to_kg: m[2] === 'over' ? null : Number(m[2]), margin_pct: pct });
  }
  const supabase = await createClient();
  // Replace the grid: one delete and one insert keeps "over the last band" (a null) simple.
  const { error: delError } = await supabase.from('sales_margins').delete().eq('sales_tariff_id', id);
  if (delError) back(q, `Not saved: ${delError.message}`);
  if (rows.length) {
    const { error } = await supabase.from('sales_margins').insert(rows);
    if (error) back(q, `Not saved: ${error.message}`);
  }
  revalidatePath('/stream/tariffs');
  back(q, `Margins saved (${rows.length} cells${blanks.length ? `, ${blanks.length} blank` : ''}) · logged`);
}

export async function createSalesTariff(formData: FormData) {
  const code = String(formData.get('code') ?? '').trim().toUpperCase();
  const name = String(formData.get('name') ?? '').trim();
  const base = String(formData.get('base_tariff_id') ?? '');
  const copyFrom = String(formData.get('copy_from') ?? '');
  if (!/^[A-Z0-9-]{2,20}$/.test(code) || !name || !base) back('tab=sales', 'Give the sales tariff a code (letters, numbers, dashes), a name and a rate card.');
  const supabase = await createClient();
  const { data, error } = await supabase.from('sales_tariffs').insert({ code, name, base_tariff_id: base }).select('id').single();
  if (error) back('tab=sales', `Not created: ${error.message}`);
  if (copyFrom) {
    const { data: src } = await supabase.from('sales_margins').select('zone_code, up_to_kg, margin_pct').eq('sales_tariff_id', copyFrom);
    if (src?.length) await supabase.from('sales_margins').insert(src.map((m) => ({ ...m, sales_tariff_id: data!.id })));
  }
  revalidatePath('/stream/tariffs');
  back(`tab=sales&sales=${data!.id}`, `Sales tariff ${code} created · logged`);
}

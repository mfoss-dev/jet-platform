'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

const back = (query: string, msg: string): never => redirect(`/stream/tariffs?${query}&msg=${encodeURIComponent(msg)}`);
const BANDS = ['0.5', '5', '20', '20+'];

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

// Saves the whole margin grid for one customer. Blank cells are removed.
export async function saveMargins(formData: FormData) {
  const customer = String(formData.get('customer_id'));
  const q = `tab=margins&customer=${customer}`;
  const upserts: { customer_id: string; zone_code: string; band: string; margin_pct: number }[] = [];
  const blanks: { zone: string; band: string }[] = [];
  for (const [k, v] of formData.entries()) {
    const m = /^m\|([^|]+)\|(.+)$/.exec(k);
    if (!m || !BANDS.includes(m[2])) continue;
    const text = String(v).trim().replace('%', '');
    if (!text) { blanks.push({ zone: m[1], band: m[2] }); continue; }
    const pct = Number(text);
    if (!Number.isFinite(pct) || pct < -50 || pct > 300) back(q, `Zone ${m[1]}, ${m[2]} kg: margins must be between -50% and 300%.`);
    upserts.push({ customer_id: customer, zone_code: m[1], band: m[2], margin_pct: pct });
  }

  const supabase = await createClient();
  if (upserts.length) {
    const { data, error } = await supabase.from('customer_margins').upsert(upserts, { onConflict: 'customer_id,zone_code,band' }).select('band');
    if (error) back(q, `Not saved: ${error.message}`);
    if (!data?.length) back(q, 'Not saved: you don’t have permission to change margins.');
  }
  for (const b of blanks) {
    await supabase.from('customer_margins').delete().match({ customer_id: customer, zone_code: b.zone, band: b.band });
  }
  revalidatePath('/stream/tariffs');
  back(q, `Margins saved (${upserts.length} cells) · logged`);
}

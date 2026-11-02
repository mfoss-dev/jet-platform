'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

const REASONS = ['overdue', 'credit_limit', 'disputed_invoice', 'customer_request', 'other'] as const;

// Each action reports back through ?msg= on the customer page. Row-level security decides who may write:
// a refused update returns no rows, which we report instead of claiming success.
async function update(id: string, patch: Record<string, unknown>, done: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.from('customers').update(patch).eq('id', id).select('id');
  revalidatePath('/stream', 'layout');
  const msg = error ? `Not saved: ${error.message}` : data?.length ? done : 'Not saved: you don’t have permission to change customers.';
  redirect(`/stream/customers/${id}?msg=${encodeURIComponent(msg)}`);
}

export async function saveTerms(formData: FormData) {
  const id = String(formData.get('id'));
  const days = Number(formData.get('payment_terms_days'));
  const email = String(formData.get('billing_email') ?? '').trim();
  if (!Number.isInteger(days) || days < 0 || days > 120) redirect(`/stream/customers/${id}?msg=${encodeURIComponent('Terms must be 0 to 120 days.')}`);
  await update(id, { payment_terms_days: days, billing_email: email || null }, 'Billing and terms saved · logged');
}

export async function placeHold(formData: FormData) {
  const id = String(formData.get('id'));
  const reason = String(formData.get('hold_reason'));
  if (!REASONS.includes(reason as (typeof REASONS)[number])) redirect(`/stream/customers/${id}?msg=${encodeURIComponent('Choose a reason for the hold.')}`);
  const note = String(formData.get('hold_note') ?? '').trim();
  await update(id, { status: 'on_hold', hold_reason: reason, hold_note: note || null, held_at: new Date().toISOString() }, 'Account placed on hold · logged');
}

export async function releaseHold(formData: FormData) {
  const id = String(formData.get('id'));
  await update(id, { status: 'active', hold_reason: null, hold_note: null, held_at: null }, 'Hold released · logged');
}

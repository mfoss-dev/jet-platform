'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

const back = (path: string, msg: string): never => redirect(`${path}?msg=${encodeURIComponent(msg)}`);

// Raise a draft credit note from the ticked lines, each for the amount entered (ex GST).
export async function raiseCredit(formData: FormData) {
  const invoice = String(formData.get('invoice'));
  const form = `/stream/invoices/${invoice}/credit`;
  const lines = formData.getAll('line').map(String).map((id) => ({ id, amount: Number(formData.get(`amt_${id}`)) }));
  if (!lines.length) back(form, 'Tick the lines to credit.');
  if (lines.some((l) => !Number.isFinite(l.amount) || l.amount <= 0)) back(form, 'Enter an amount above zero for each ticked line.');
  const reason = [String(formData.get('reason') ?? ''), String(formData.get('note') ?? '').trim()].filter(Boolean).join(': ');
  const supabase = await createClient();
  let rebill: string | null = null;
  const code = String(formData.get('rebill') ?? '').trim().toUpperCase();
  if (code) {
    const { data } = await supabase.from('customers').select('id').eq('account_code', code).maybeSingle();
    if (!data) back(form, `Not raised: no account ${code}.`);
    rebill = data!.id;
  }
  const { data, error } = await supabase.rpc('create_credit_note', { p_invoice: invoice, p_lines: lines, p_reason: reason, p_rebill_to: rebill });
  revalidatePath('/stream/invoices');
  if (error) back(form, `Not raised: ${error.message}`);
  back(`/stream/invoices/${data}`, 'Draft credit note raised · logged. Check it, then approve.');
}

export async function approveCredit(formData: FormData) {
  const id = String(formData.get('id'));
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('approve_credit_note', { p_id: id });
  revalidatePath('/stream/invoices');
  if (error) back(`/stream/invoices/${id}`, `Not approved: ${error.message}`);
  back(`/stream/invoices/${id}`, `Credit note ${data} approved · logged`);
}

export async function discardCredit(formData: FormData) {
  const id = String(formData.get('id'));
  const invoice = String(formData.get('invoice'));
  const supabase = await createClient();
  const { error } = await supabase.rpc('discard_credit_note', { p_id: id });
  revalidatePath('/stream/invoices');
  if (error) back(`/stream/invoices/${id}`, `Not discarded: ${error.message}`);
  back(`/stream/invoices/${invoice}`, 'Draft credit note discarded · logged');
}

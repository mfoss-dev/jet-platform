'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

const back = (query: string, msg: string): never => redirect(`/stream/run?${query}&msg=${encodeURIComponent(msg)}`);
const ids = (formData: FormData) => formData.getAll('invoice').map(String).filter(Boolean);

export async function prepareRun(formData: FormData) {
  const branch = String(formData.get('branch') ?? '');
  const kind = String(formData.get('kind') ?? 'weekly');
  const periodEnd = String(formData.get('period_end') ?? '');
  const invoiceDate = String(formData.get('invoice_date') ?? '') || null;
  if (!branch || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) back('', 'Choose a branch and the period end.');
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('prepare_invoice_run', { p_branch: branch, p_kind: kind, p_period_end: periodEnd, p_invoice_date: invoiceDate });
  revalidatePath('/stream/run');
  if (error) back('', `Not prepared: ${error.message}`);
  back(`run=${data}`, 'Draft run prepared · logged');
}

// Approve every unflagged draft (no invoices ticked), or the ticked ones.
export async function approve(formData: FormData) {
  const run = String(formData.get('run'));
  const chosen = ids(formData);
  if (formData.get('only') === 'ticked' && !chosen.length) back(`run=${run}`, 'Tick the invoices to approve.');
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('approve_invoices', { p_run: run, p_invoices: formData.get('only') === 'ticked' ? chosen : null });
  revalidatePath('/stream/run');
  if (error) back(`run=${run}`, `Not approved: ${error.message}`);
  back(`run=${run}`, `${data} invoice${data === 1 ? '' : 's'} approved and numbered · logged`);
}

// Take ticked drafts out of the run: carried to the next run, or held until released.
export async function release(formData: FormData) {
  const run = String(formData.get('run'));
  const chosen = ids(formData);
  const hold = formData.get('how') === 'hold';
  if (!chosen.length) back(`run=${run}`, 'Tick the invoices to take out.');
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('release_invoices', { p_run: run, p_invoices: chosen, p_hold: hold });
  revalidatePath('/stream/run');
  if (error) back(`run=${run}`, `Not changed: ${error.message}`);
  back(`run=${run}`, `${data} invoice${data === 1 ? '' : 's'} ${hold ? 'held' : 'carried to the next run'} · logged`);
}

export async function cancelRun(formData: FormData) {
  const run = String(formData.get('run'));
  const supabase = await createClient();
  const { error } = await supabase.rpc('cancel_invoice_run', { p_run: run });
  revalidatePath('/stream/run');
  if (error) back(`run=${run}`, `Not cancelled: ${error.message}`);
  back('', 'Run cancelled; its charges are unbilled again · logged');
}

export async function releaseHeld(formData: FormData) {
  const chosen = formData.getAll('charge').map(String).filter(Boolean);
  if (!chosen.length) back('held=1', 'Tick the charges to release.');
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('release_charges', { p_ids: chosen });
  revalidatePath('/stream/run');
  if (error) back('held=1', `Not released: ${error.message}`);
  back('held=1', `${data} charge${data === 1 ? '' : 's'} back in billing for the next run`);
}

'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { readDhlFile } from '@/lib/carrier-csv';
import { createClient } from '@/lib/supabase/server';

const back = (path: string, msg: string): never => redirect(`${path}${path.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}`);

// Load one or more DHL invoice data files. Each invoice in them is loaded and matched by the database
// (import_carrier_invoice checks permission and refuses an invoice that is already loaded).
export async function uploadCarrierInvoices(formData: FormData) {
  const files = formData.getAll('file').filter((f): f is File => f instanceof File && f.size > 0);
  const branch = String(formData.get('branch') ?? '') || undefined;
  if (!files.length) back('/stream/cinv', 'Not loaded: choose a DHL invoice CSV first.');
  const supabase = await createClient();
  const done: string[] = [], failed: string[] = [];
  let lastId = '';
  for (const file of files) {
    let invoices;
    try {
      invoices = readDhlFile(await file.text(), file.name, branch);
    } catch (e) {
      failed.push((e as Error).message);
      continue;
    }
    for (const { lines, ...invoice } of invoices) {
      const { data, error } = await supabase.rpc('import_carrier_invoice', { p_invoice: invoice, p_lines: lines });
      if (error) failed.push(`${invoice.invoice_number}: ${error.message}`);
      else { done.push(`${invoice.invoice_number} (${lines.length} shipments)`); lastId = String(data); }
    }
  }
  revalidatePath('/stream', 'layout');
  const msg = [done.length ? `Loaded and matched ${done.join(', ')}` : '', failed.length ? `Not loaded: ${failed.join('; ')}` : ''].filter(Boolean).join(' · ');
  back(done.length === 1 && !failed.length ? `/stream/cinv/${lastId}` : '/stream/cinv', msg);
}

// Decide the ticked lines. Pass on adds a charge for the job's customer (the amount at stake, or the amount
// typed in when one line is ticked); the next invoice run picks it up.
export async function decideCarrierLines(formData: FormData) {
  const id = String(formData.get('invoice'));
  const view = String(formData.get('view') ?? '');
  const path = `/stream/cinv/${id}${view ? `?view=${encodeURIComponent(view)}` : ''}`;
  const ids = formData.getAll('line').map(String).filter(Boolean);
  const decision = String(formData.get('decision') ?? '');
  const amountText = String(formData.get('amount') ?? '').trim();
  if (!ids.length) back(path, 'Nothing changed: tick some lines first.');
  if (amountText && ids.length !== 1) back(path, 'Nothing changed: an amount can only be entered for one line at a time.');
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('decide_carrier_lines', {
    p_ids: ids, p_decision: decision, p_note: String(formData.get('note') ?? ''), p_amount: amountText ? Number(amountText) : null,
  });
  revalidatePath('/stream', 'layout');
  if (error) back(path, `Nothing changed: ${error.message}`);
  const n = Number(data ?? 0);
  const what = { pass_on: 'passed on (charges added for the next invoice run)', absorb: 'absorbed by Jet', dispute: 'marked as disputed with DHL', ok: 'marked fine' }[decision];
  back(path, n ? `${n} line${n === 1 ? '' : 's'} ${what} · logged` : 'Nothing changed: those lines were already decided.');
}

export async function rematchCarrierInvoice(formData: FormData) {
  const id = String(formData.get('invoice'));
  const supabase = await createClient();
  const { error } = await supabase.rpc('rematch_carrier_invoice', { p_id: id });
  revalidatePath('/stream', 'layout');
  back(`/stream/cinv/${id}`, error ? `Not matched: ${error.message}` : "Matched again against Jet's latest jobs");
}

export async function removeCarrierInvoice(formData: FormData) {
  const id = String(formData.get('invoice'));
  const supabase = await createClient();
  const { error } = await supabase.rpc('remove_carrier_invoice', { p_id: id });
  revalidatePath('/stream', 'layout');
  if (error) back(`/stream/cinv/${id}`, `Not removed: ${error.message}`);
  back('/stream/cinv', 'Carrier invoice removed · logged');
}

export async function setChargeTreatment(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.rpc('set_carrier_charge_treatment', {
    p_carrier: String(formData.get('carrier')), p_code: String(formData.get('code')), p_treatment: String(formData.get('treatment')),
  });
  revalidatePath('/stream', 'layout');
  back('/stream/cinv', error ? `Not saved: ${error.message}` : 'Saved · open invoices matched again · logged');
}

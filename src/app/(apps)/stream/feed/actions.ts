'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export type ActionResult = { ok: boolean; message: string };

// Billing feed actions. The database decides who may do this (finance, management, admin);
// a refused update comes back as zero rows, which we report rather than pretend it worked.
async function setStatus(ids: string[], status: 'ready' | 'on_hold', note?: string): Promise<ActionResult> {
  if (!ids.length) return { ok: false, message: 'Tick some rows first.' };
  const supabase = await createClient();
  const patch = status === 'ready' ? { billing_status: status, issue: null, issue_note: null } : { billing_status: status, issue_note: note ?? null };
  const { data, error } = await supabase.from('jobs').update(patch).in('id', ids).select('id');
  if (error) return { ok: false, message: error.message };
  revalidatePath('/stream', 'layout');
  if (!data.length) return { ok: false, message: 'You don’t have permission to change billing.' };
  const n = data.length;
  return { ok: true, message: `${n} job${n === 1 ? '' : 's'} ${status === 'ready' ? 'marked ready to invoice' : 'put on hold'} · logged` };
}

export async function markReady(ids: string[]) {
  return setStatus(ids, 'ready');
}

export async function putOnHold(ids: string[], note: string) {
  return setStatus(ids, 'on_hold', note.trim() || 'Held from the billing feed');
}

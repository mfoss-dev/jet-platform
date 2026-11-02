'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export type Decision = 'pass_on' | 'absorb' | 'dispute';
const DONE: Record<Decision, string> = { pass_on: 'passed on to the customer', absorb: 'absorbed by Jet', dispute: 'disputed with the carrier' };

// The decide_reweighs database function checks permission, updates the reweighs and their jobs together, and is audited.
export async function decideReweighs(ids: string[], decision: Decision, note: string) {
  if (!ids.length) return { ok: false, message: 'Tick some reweighs first.' };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('decide_reweighs', { p_ids: ids, p_decision: decision, p_note: note });
  if (error) return { ok: false, message: error.message };
  revalidatePath('/stream', 'layout');
  const n = Number(data ?? 0);
  if (!n) return { ok: false, message: 'Nothing changed: those reweighs were already decided.' };
  return { ok: true, message: `${n} reweigh${n === 1 ? '' : 's'} ${DONE[decision]} · jobs updated and ready to invoice` };
}

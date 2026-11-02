'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { appLink, emailConfigured, sendEmail } from '@/lib/email';
import { money } from '@/lib/format';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';

const back = (path: string, msg: string): never => redirect(`${path}?msg=${encodeURIComponent(msg)}`);
type Supabase = Awaited<ReturnType<typeof createClient>>;

// The facts an email about a credit note needs.
async function creditFacts(supabase: Supabase, id: string) {
  const { data } = await supabase.from('invoices')
    .select('number, total, reason, branch_code, credit_for, created_by, bill_to:customers!invoices_bill_to_id_fkey(name, account_code)').eq('id', id).maybeSingle();
  if (!data) return null;
  const who = Array.isArray(data.bill_to) ? data.bill_to[0] : data.bill_to;
  const [{ data: original }, { data: raiser }] = await Promise.all([
    supabase.from('invoices').select('number').eq('id', data.credit_for).maybeSingle(),
    supabase.from('profiles').select('email, full_name').eq('id', data.created_by).maybeSingle(),
  ]);
  return { ...data, who, original: original?.number, raiser, link: await appLink(`/stream/invoices/${id}`) };
}

// Over the limit: tell management it is waiting for them. Says what happened, for the banner.
async function notifyApprovers(supabase: Supabase, id: string) {
  const { data: queue } = await supabase.from('credit_note_queue').select('needs_management').eq('id', id).maybeSingle();
  if (!queue?.needs_management) return '';
  const [{ data: approvers }, f] = await Promise.all([supabase.rpc('credit_note_approvers', { p_id: id }), creditFacts(supabase, id)]);
  const to = ((approvers ?? []) as { email: string; full_name: string | null }[]).map((a) => a.email);
  const names = ((approvers ?? []) as { full_name: string | null; email: string }[]).map((a) => a.full_name || a.email).join(' or ');
  if (!f || !to.length) return ' It needs management approval.';
  const sent = await sendEmail({
    to,
    subject: `Credit note to approve: ${f.who?.name} ${money(f.total)}`,
    text: [
      `${f.raiser?.full_name || 'Finance'} raised a credit note that is over the approval limit and needs you to approve it.`,
      '',
      `Account: ${f.who?.name} (${f.who?.account_code})`,
      `Credits invoice: ${f.original}`,
      `Amount: ${money(f.total)} inc GST`,
      `Reason: ${f.reason}`,
      '',
      `Review and approve: ${f.link}`,
    ].join('\n'),
  });
  return sent ? ` ${names} emailed to approve it.` : ` It is waiting for ${names}${emailConfigured() ? ' (the email could not be sent)' : ''}.`;
}

// Tell whoever raised it that it was approved (unless they approved it themselves).
async function notifyRaiser(supabase: Supabase, id: string) {
  const [me, f] = await Promise.all([getMe(), creditFacts(supabase, id)]);
  if (!f?.raiser?.email || f.created_by === me.id) return '';
  const sent = await sendEmail({
    to: [f.raiser.email],
    subject: `Credit note ${f.number} approved: ${f.who?.name}`,
    text: [
      `${me.name || me.email} approved credit note ${f.number} for ${f.who?.name} (${f.who?.account_code}), ${money(f.total)} inc GST, against invoice ${f.original}.`,
      '',
      `View it: ${f.link}`,
    ].join('\n'),
  });
  return sent ? ` ${f.raiser.full_name || f.raiser.email} emailed.` : '';
}

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
  const told = await notifyApprovers(supabase, data);
  back(`/stream/invoices/${data}`, `Draft credit note raised · logged.${told || ' Check it, then approve.'}`);
}

export async function approveCredit(formData: FormData) {
  const id = String(formData.get('id'));
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('approve_credit_note', { p_id: id });
  revalidatePath('/stream/invoices');
  if (error) back(`/stream/invoices/${id}`, `Not approved: ${error.message}`);
  const told = await notifyRaiser(supabase, id);
  back(`/stream/invoices/${id}`, `Credit note ${data} approved · logged.${told}`);
}

export async function setCreditLimit(formData: FormData) {
  const branch = String(formData.get('branch'));
  const limit = Number(formData.get('limit'));
  if (!Number.isFinite(limit) || limit < 0) back('/stream/invoices', 'Not saved: the limit must be zero or more.');
  const supabase = await createClient();
  const { error } = await supabase.rpc('set_credit_approval_limit', { p_branch: branch, p_limit: limit });
  revalidatePath('/stream/invoices');
  if (error) redirect(`/stream/invoices?kind=credit&msg=${encodeURIComponent(`Not saved: ${error.message}`)}`);
  redirect(`/stream/invoices?kind=credit&msg=${encodeURIComponent(`Credit approval limit for ${branch} set to ${limit} · logged`)}`);
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

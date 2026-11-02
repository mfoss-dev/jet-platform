import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BILLING_EDITORS, day, money, one } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { raiseCredit } from '../../actions';

type Line = { id: string; connote: string; shipped_on: string; code: string; description: string; charge: number; fuel: number; security: number; gst: number; customer: { name: string; account_code: string } | null };
type Credited = { credit_of: string; charge: number; fuel: number; security: number; gst: number };

const REASONS = ['Wrong price', 'Billed to the wrong account', 'Weight or reweigh disputed', 'Charged twice', 'Charge not applicable', 'Service failure (goodwill)', 'Other'];
const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

// Raise a credit note against an issued invoice: tick lines, credit all or part of each (ex GST; fuel, security and
// GST follow in proportion), and optionally re-bill the credited lines to the right account.
export default async function RaiseCredit({ params, searchParams }: PageProps<'/stream/invoices/[id]/credit'>) {
  const me = await getMe();
  if (!me.apps.includes('stream') || !BILLING_EDITORS.includes(me.role)) notFound();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const msg = pick((await searchParams).msg);
  const supabase = await createClient();
  const [{ data }, { data: lineData }] = await Promise.all([
    supabase.from(SELECTS.invoiceList.table).select(SELECTS.invoiceList.select).eq('id', id).maybeSingle(),
    supabase.from(SELECTS.invoiceLines.table).select(SELECTS.invoiceLines.select).eq('invoice_id', id).order('connote').order('code').limit(5000),
  ]);
  if (!data) notFound();
  const inv = data as unknown as { id: string; number: number | null; kind: string; status: string; invoice_date: string; total: number; bill_to: { name: string; account_code: string } | { name: string; account_code: string }[] | null };
  if (inv.kind === 'credit' || inv.status === 'draft') notFound();
  const billTo = one(inv.bill_to);
  const lines = ((lineData ?? []) as unknown as Line[]).map((l) => ({ ...l, customer: one(l.customer) }));
  const { data: creditedData } = await supabase.from(SELECTS.creditedLines.table).select(SELECTS.creditedLines.select).in('credit_of', lines.map((l) => l.id)).limit(5000);
  const credited = (creditedData ?? []) as unknown as Credited[];
  const left = (l: Line) => {
    const c = credited.filter((x) => x.credit_of === l.id).reduce((a, x) => a + Number(x.charge) + Number(x.fuel) + Number(x.security), 0);
    return Math.round((Number(l.charge) + Number(l.fuel) + Number(l.security) + c) * 100) / 100;
  };
  const open = lines.filter((l) => left(l) > 0);

  return (
    <>
      <div className="top">
        <div>
          <h1>Credit invoice {inv.number}</h1>
          <div className="sub">{billTo?.name} {billTo?.account_code} · dated {day(inv.invoice_date)} · {money(inv.total)}</div>
        </div>
        <Link className="btn" href={`/stream/invoices/${id}`}>Back to the invoice</Link>
      </div>
      {msg && <div className="banner warn" role="status">{msg}</div>}

      {!open.length ? <div className="card"><p className="hint">Every line on this invoice has been credited.</p></div> : (
        <form action={raiseCredit} className="card">
          <input type="hidden" name="invoice" value={id} />
          <p className="hint">Tick the lines to credit and change the amount for a part credit. Amounts are ex GST; fuel, security and GST are credited in proportion. The credit note is a draft until approved: finance can approve one up to the branch&apos;s approval limit; above it, management approves.</p>
          <table className="mt8">
            <thead><tr><th /><th>Shipment</th><th>Line</th><th className="r">Billed ex GST</th><th className="r">Left to credit</th><th className="r">Credit ex GST</th></tr></thead>
            <tbody>
              {open.map((l) => (
                <tr key={l.id}>
                  <td><input type="checkbox" name="line" value={l.id} aria-label={`Credit ${l.connote} ${l.description || l.code}`} /></td>
                  <td><b>{l.connote}</b> <span className="hint">{day(l.shipped_on)}{l.customer?.account_code !== billTo?.account_code ? ` · ${l.customer?.account_code}` : ''}</span></td>
                  <td>{l.description || l.code}</td>
                  <td className="r">{money(Number(l.charge) + Number(l.fuel) + Number(l.security))}</td>
                  <td className="r">{money(left(l))}</td>
                  <td className="r"><input name={`amt_${l.id}`} type="number" step="0.01" min="0.01" max={left(l)} defaultValue={left(l).toFixed(2)} aria-label={`Amount for ${l.connote}`} style={{ width: 110, textAlign: 'right' }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="form mt" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div>
              <label htmlFor="c-reason">Reason</label>
              <select id="c-reason" name="reason" className="f" required>{REASONS.map((r) => <option key={r}>{r}</option>)}</select>
            </div>
            <div><label htmlFor="c-note">Details (shown on the credit note)</label><input id="c-note" name="note" placeholder="e.g. rate agreed with the customer on 3 Nov" /></div>
            <div>
              <label htmlFor="c-rebill">Re-bill to account (optional)</label>
              <input id="c-rebill" name="rebill" placeholder="Account code" />
              <div className="hint">The credited lines go into the next run on that account.</div>
            </div>
            <div className="s2"><button className="btn primary">Raise draft credit note</button></div>
          </div>
        </form>
      )}
    </>
  );
}

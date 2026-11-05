import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TREATMENT } from '@/lib/carrier-csv';
import { BILLING_EDITORS, day, dayTime, money } from '@/lib/format';
import { SELECTS } from '@/lib/selects';
import { getMe } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { setChargeTreatment, uploadCarrierInvoices } from './actions';

type Summary = {
  id: string; carrier_code: string; branch_code: string; invoice_number: string; account_number: string | null; invoice_date: string | null;
  due_date: string | null; total_ex: number; tax: number; file_name: string | null; uploaded_at: string; uploaded_by_name: string | null;
  shipments: number; matched: number; jet_billed: number; exceptions: number; open: number; open_at_stake: number; matched_cost: number;
};
type Code = { carrier_code: string; code: string; name: string; treatment: string };
const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const BRANCH: Record<string, string> = { AU: 'Sydney', NZ: 'Auckland' };

// Carrier invoices: load DHL's invoice data file, see how each invoice matched Jet's jobs, and open the exceptions.
export default async function CarrierInvoices({ searchParams }: PageProps<'/stream/cinv'>) {
  const me = await getMe();
  if (!me.apps.includes('stream')) notFound();
  const sp = await searchParams;
  const msg = pick(sp.msg);
  const canEdit = BILLING_EDITORS.includes(me.role);
  const supabase = await createClient();
  const [{ data, error }, { data: codeData }] = await Promise.all([
    supabase.from(SELECTS.carrierInvoices.table).select(SELECTS.carrierInvoices.select).order('invoice_date', { ascending: false }).order('uploaded_at', { ascending: false }).limit(200),
    supabase.from(SELECTS.carrierCodes.table).select(SELECTS.carrierCodes.select).order('carrier_code').order('code'),
  ]);
  const invoices = (data ?? []) as unknown as Summary[];
  const codes = (codeData ?? []) as Code[];
  const sum = (f: (i: Summary) => number) => invoices.reduce((a, i) => a + Number(f(i) || 0), 0);
  const open = sum((i) => i.open);

  return (
    <>
      <div className="top">
        <div>
          <h1>Carrier invoices</h1>
          <div className="sub">DHL&apos;s invoices matched to Jet&apos;s jobs: only the exceptions need a look</div>
        </div>
      </div>
      {msg && <div className={`banner ${/^Not |Not loaded/.test(msg) ? 'warn' : ''}`} role="status">{msg}</div>}
      {error && <div className="banner warn" role="alert">Couldn&apos;t load carrier invoices: {error.message}</div>}

      <div className="grid k4">
        <div className="card kpi"><div className="l">Exceptions to decide</div><div className="v">{open}</div><div className="d">{money(sum((i) => i.open_at_stake))} at stake</div></div>
        <div className="card kpi"><div className="l">Carrier charges loaded</div><div className="v">{money(sum((i) => i.total_ex))}</div><div className="d">{invoices.length} invoice{invoices.length === 1 ? '' : 's'} · ex GST</div></div>
        <div className="card kpi"><div className="l">Shipments matched</div><div className="v">{sum((i) => i.matched).toLocaleString()}</div><div className="d">of {sum((i) => i.shipments).toLocaleString()} on the invoices</div></div>
        <div className="card kpi"><div className="l">Margin on matched jobs</div><div className="v">{money(sum((i) => i.jet_billed) - sum((i) => i.matched_cost))}</div><div className="d">Jet billed {money(sum((i) => i.jet_billed))} · ex GST</div></div>
      </div>

      <div className="grid split mt">
        <div className="card" style={{ padding: 0, minWidth: 0 }}>
          <div className="tw">
            <table>
              <thead><tr><th>Invoice</th><th>Date</th><th className="r">Shipments</th><th className="r">Matched</th><th className="r">DHL ex GST</th><th className="r">Open</th><th className="r">At stake</th><th>Loaded</th></tr></thead>
              <tbody>
                {invoices.map((i) => (
                  <tr key={i.id}>
                    <td><Link href={`/stream/cinv/${i.id}`}><b>{i.invoice_number}</b></Link> <span className="hint">{i.carrier_code} · {BRANCH[i.branch_code] ?? i.branch_code}{i.account_number ? ` · acct ${i.account_number}` : ''}</span></td>
                    <td>{day(i.invoice_date)}<span className="hint"> · due {day(i.due_date)}</span></td>
                    <td className="r">{i.shipments}</td>
                    <td className="r">{i.matched}{i.shipments ? <span className="hint"> · {Math.round((100 * i.matched) / i.shipments)}%</span> : null}</td>
                    <td className="r">{money(i.total_ex)}</td>
                    <td className="r">{i.open ? <span className="pill warn">{i.open}</span> : i.exceptions ? <span className="pill ok">Done</span> : <span className="hint">None</span>}</td>
                    <td className="r">{i.open ? money(i.open_at_stake) : ''}</td>
                    <td>{dayTime(i.uploaded_at)}<span className="hint">{i.uploaded_by_name ? ` · ${i.uploaded_by_name}` : ''}</span></td>
                  </tr>
                ))}
                {!invoices.length && <tr><td colSpan={8} className="hint">No carrier invoices loaded yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="grid" style={{ alignSelf: 'start' }}>
          {canEdit && (
            <form className="card" action={uploadCarrierInvoices}>
              <h3>Load a DHL invoice</h3>
              <p className="hint">The invoice data CSV from DHL MyBill (not the PDF). Several files at once is fine. Names and addresses in the file aren&apos;t kept.</p>
              <input className="f mt8" type="file" name="file" accept=".csv,text/csv" multiple required aria-label="DHL invoice CSV" />
              <label className="hint mt8" htmlFor="cinv-branch">Branch</label>
              <select id="cinv-branch" name="branch" className="f" defaultValue="">
                <option value="">From the file (DHL station)</option><option value="AU">Sydney</option><option value="NZ">Auckland</option>
              </select>
              <button className="btn primary mt8">Load and match</button>
            </form>
          )}
          <div className="card">
            <h3>DHL surcharge codes</h3>
            <p className="hint">How each surcharge is checked. &quot;Check it was charged&quot; flags shipments where Jet&apos;s add-ons don&apos;t cover it; new codes start there.</p>
            <table className="mt8">
              <tbody>
                {codes.map((c) => (
                  <tr key={`${c.carrier_code}-${c.code}`}>
                    <td><b>{c.code}</b> <span className="hint">{c.name.toLowerCase()}</span></td>
                    <td>
                      {canEdit ? (
                        <form action={setChargeTreatment} className="flex">
                          <input type="hidden" name="carrier" value={c.carrier_code} /><input type="hidden" name="code" value={c.code} />
                          <select name="treatment" className="f" defaultValue={c.treatment} aria-label={`How ${c.code} is checked`}>
                            {Object.entries(TREATMENT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                          </select>
                          <button className="btn sm">Save</button>
                        </form>
                      ) : TREATMENT[c.treatment]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h3>How matching works</h3>
            <p className="hint">Each DHL line is matched to Jet&apos;s job by the connote (DHL&apos;s shipment reference) or the DHL waybill, then compared with what Jet billed: never billed, below cost, surcharges not passed on, heavier than billed, and waybills charged twice. Passing one on adds a charge to the customer&apos;s next invoice.</p>
          </div>
        </div>
      </div>
    </>
  );
}

'use client';

import { useState, useTransition } from 'react';
import { day, money } from '@/lib/format';
import { markReady, putOnHold, type ActionResult } from './actions';

export type FeedRow = {
  id: string;
  connote: string;
  customer_name: string;
  account_code: string;
  carrier_code: string;
  service_name: string | null;
  booked_at: string;
  origin_city: string | null;
  dest_city: string | null;
  dest_country: string | null;
  declared_weight_kg: number | null;
  carrier_weight_kg: number | null;
  sell_ex_gst: number | null;
  cost_ex_gst: number | null;
  margin_pct: number | null;
  status: string;
  billing_status: 'needs_attention' | 'ready' | 'on_hold' | 'invoiced';
  issue: string | null;
  issue_note: string | null;
};

const ISSUE: Record<string, [string, 'bad' | 'warn']> = {
  reweigh: ['Reweigh', 'bad'], below_cost: ['Below cost', 'bad'], no_rate: ['No rate', 'bad'], remote_area: ['Remote area', 'warn'],
  address_fee: ['Address fee', 'warn'], manual_job: ['Manual job', 'warn'], missing_fuel: ['Missing fuel', 'warn'], duties: ['Duties', 'warn'],
};
const STATUS: Record<FeedRow['billing_status'], [string, string]> = {
  needs_attention: ['Needs attention', 'bad'], ready: ['Ready', 'ok'], on_hold: ['On hold', 'warn'], invoiced: ['Invoiced', ''],
};

export function FeedTable({ rows, canEdit, showCost }: { rows: FeedRow[]; canEdit: boolean; showCost: boolean }) {
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [selId, setSelId] = useState<string | null>(rows[0]?.id ?? null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [holdNote, setHoldNote] = useState('');
  const [pending, start] = useTransition();

  const sel = rows.find((r) => r.id === selId) ?? null;
  const tickedRows = rows.filter((r) => ticked.has(r.id));
  const sum = (key: 'sell_ex_gst' | 'cost_ex_gst') => tickedRows.reduce((a, r) => a + Number(r[key] ?? 0), 0);
  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      const r = await fn();
      setResult(r);
      if (r.ok) setTicked(new Set());
    });
  const toggle = (id: string) => setTicked((t) => { const n = new Set(t); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  if (!rows.length) return <div className="card"><p className="hint">No jobs in this view.</p></div>;

  return (
    <div className="grid split">
      <div style={{ minWidth: 0 }}>
        {result && <div className={`banner ${result.ok ? '' : 'warn'}`} role="status">{result.message}</div>}
        {canEdit && ticked.size > 0 && (
          <div className="card flex between" style={{ marginBottom: 12, padding: '10px 14px' }}>
            <span>
              <b>{ticked.size} selected</b>
              {showCost && <> · cost {money(sum('cost_ex_gst'))}</>} · charge {money(sum('sell_ex_gst'))}
            </span>
            <span className="acts">
              <button className="btn sm primary" disabled={pending} onClick={() => run(() => markReady([...ticked]))}>Mark ready</button>
              <button className="btn sm" disabled={pending} onClick={() => run(() => putOnHold([...ticked], holdNote))}>Hold</button>
            </span>
          </div>
        )}
        <div className="card" style={{ padding: 0 }}>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  {canEdit && (
                    <th>
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={ticked.size === rows.length}
                        onChange={(e) => setTicked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                      />
                    </th>
                  )}
                  <th>Connote</th><th>Customer</th><th>Issue</th>
                  {showCost && <th className="r">Cost</th>}
                  <th className="r">Charge</th>
                  {showCost && <th className="r">Margin</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`click ${r.id === selId ? 'sel' : ''}`} onClick={() => setSelId(r.id)}>
                    {canEdit && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" aria-label={`Select ${r.connote}`} checked={ticked.has(r.id)} onChange={() => toggle(r.id)} />
                      </td>
                    )}
                    <td><b>{r.connote}</b></td>
                    <td>{r.customer_name}</td>
                    <td>
                      {r.issue
                        ? <span className={`pill ${ISSUE[r.issue]?.[1] ?? ''}`}>{ISSUE[r.issue]?.[0] ?? r.issue}</span>
                        : <span className={`pill ${STATUS[r.billing_status][1]}`}>{STATUS[r.billing_status][0]}</span>}
                    </td>
                    {showCost && <td className="r">{money(r.cost_ex_gst)}</td>}
                    <td className="r">{money(r.sell_ex_gst)}</td>
                    {showCost && <td className={`r ${r.margin_pct != null && r.margin_pct < 0 ? 'down' : ''}`}>{r.margin_pct == null ? '—' : `${r.margin_pct}%`}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="hint mt8">
          Showing {rows.length.toLocaleString()} · charge {money(rows.reduce((a, r) => a + Number(r.sell_ex_gst ?? 0), 0))}
          {showCost && <> · cost {money(rows.reduce((a, r) => a + Number(r.cost_ex_gst ?? 0), 0))}</>} · all ex GST
        </div>
      </div>

      {sel && (
        <div className="card" style={{ alignSelf: 'start' }}>
          <h3 style={{ margin: 0 }}>{sel.connote} · {sel.customer_name}</h3>
          <div className="hint">
            {sel.service_name ?? sel.carrier_code} · {sel.origin_city} → {sel.dest_city} · {day(sel.booked_at)} · {sel.account_code}
          </div>
          {sel.issue_note && <div className="banner mt">{sel.issue_note}</div>}
          <table className="mt">
            <tbody>
              <tr><td>Declared weight</td><td className="r">{sel.declared_weight_kg ?? '—'} kg</td></tr>
              <tr><td>Carrier weight</td><td className="r">{sel.carrier_weight_kg ?? '—'} kg</td></tr>
              {showCost && <tr><td>Cost</td><td className="r">{money(sel.cost_ex_gst)}</td></tr>}
              <tr><td>Charge</td><td className="r">{money(sel.sell_ex_gst)}</td></tr>
              {showCost && <tr><td>Margin</td><td className="r">{sel.margin_pct == null ? '—' : `${sel.margin_pct}%`}</td></tr>}
              <tr><td>Billing</td><td className="r"><span className={`pill ${STATUS[sel.billing_status][1]}`}>{STATUS[sel.billing_status][0]}</span></td></tr>
            </tbody>
          </table>
          {canEdit && sel.billing_status !== 'invoiced' && (
            <div className="mt" style={{ display: 'grid', gap: 8 }}>
              {sel.billing_status !== 'ready' && (
                <button className="btn primary block" disabled={pending} onClick={() => run(() => markReady([sel.id]))}>Mark ready to invoice</button>
              )}
              {sel.billing_status !== 'on_hold' && (
                <div className="flex">
                  <input value={holdNote} onChange={(e) => setHoldNote(e.target.value)} placeholder="Reason for hold" aria-label="Reason for hold" style={{ flex: 1 }} />
                  <button className="btn" disabled={pending} onClick={() => run(() => putOnHold([sel.id], holdNote))}>Hold</button>
                </div>
              )}
              <div className="hint">Every change is recorded in the audit log with your name.</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

'use client';

import { useState, useTransition } from 'react';
import { saveMargins, saveRates, type RateRow } from './actions';
import type { Rate } from './TariffGrid';

// Editor for rate cards with thousands of zones (domestic lanes such as "SYD-VC2"): one row per rate,
// filtered and paged on the server; only the rows you change are saved.
type Props = {
  mode: 'rates' | 'margins';
  id: string;
  editable: boolean;
  rows: Rate[];
  margins?: Record<string, number>;   // margins mode: `${zone}|${kind}|${to}` -> margin %
};

const METHOD: Record<string, string> = { E: 'Exact', I: 'Per step', M: 'Per kg' };
const key = (r: { zone_code: string; kind: string; to_kg: number }) => `${r.zone_code}|${r.kind}|${Number(r.to_kg)}`;
const fmt = (n: number | undefined) => (n == null ? '' : String(Math.round(n * 10000) / 10000));

export function LaneEditor({ mode, id, editable, rows, margins = {} }: Props) {
  const [vals, setVals] = useState<Record<string, { charge: string; basic: string; minimum: string; margin: string }>>(() =>
    Object.fromEntries(rows.map((r) => [key(r), { charge: fmt(r.charge), basic: fmt(r.basic), minimum: fmt(r.minimum), margin: fmt(margins[key(r)]) }])));
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();
  const set = (k: string, field: 'charge' | 'basic' | 'minimum' | 'margin', v: string) => {
    setVals((s) => ({ ...s, [k]: { ...s[k], [field]: v } }));
    setResult(null);
  };

  const changed = rows.filter((r) => {
    const v = vals[key(r)];
    return mode === 'rates'
      ? Number(v.charge) !== r.charge || Number(v.basic || 0) !== r.basic || Number(v.minimum || 0) !== r.minimum
      : (v.margin === '' ? margins[key(r)] != null : Number(v.margin) !== margins[key(r)]);
  });
  const invalid = changed.some((r) => {
    const v = vals[key(r)];
    return mode === 'rates' ? [v.charge, v.basic || '0', v.minimum || '0'].some((x) => !(Number(x) >= 0)) : v.margin !== '' && !Number.isFinite(Number(v.margin));
  });

  const save = () => start(async () => {
    const res = mode === 'rates'
      ? await saveRates(id, changed.map((r): RateRow => {
        const v = vals[key(r)];
        return { ...r, charge: Number(v.charge), basic: Number(v.basic || 0), minimum: Number(v.minimum || 0) };
      }), [], '')
      : await saveMargins(id, changed.map((r) => ({ zone_code: r.zone_code, kind: r.kind, to_kg: r.to_kg, margin_pct: vals[key(r)].margin === '' ? null : Number(vals[key(r)].margin) })));
    setResult(res);
  });

  const showExtras = mode === 'rates' && rows.some((r) => r.method === 'M' || r.basic || r.minimum);
  const input = (k: string, field: 'charge' | 'basic' | 'minimum' | 'margin', label: string) =>
    editable ? <input value={vals[k][field]} onChange={(e) => set(k, field, e.target.value)} aria-label={label} inputMode="decimal" style={{ width: 84, textAlign: 'right' }} />
      : vals[k][field] === '' ? <span className="hint">—</span> : field === 'margin' ? `${vals[k][field]}%` : `$${Number(vals[k][field]).toFixed(2)}`;

  return (
    <div>
      {result && <div className={`banner ${result.ok ? '' : 'warn'}`} role="status">{result.message}</div>}
      <div className="card" style={{ padding: 0 }}>
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Zone / lane</th><th>Type</th><th className="r">From kg</th><th className="r">Up to kg</th><th>How</th><th className="r">Step</th>
                {mode === 'rates' ? <><th className="r">Rate</th>{showExtras && <><th className="r">Basic</th><th className="r">Minimum</th></>}</> : <><th className="r">Base rate</th><th className="r">Margin</th></>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const k = key(r);
                return (
                  <tr key={k} style={changed.includes(r) ? { background: 'var(--note)' } : undefined}>
                    <td><b>{r.zone_code}</b></td>
                    <td>{r.kind === 'doc' ? 'Documents' : 'Parcels'}</td>
                    <td className="r">{r.from_kg}</td>
                    <td className="r">{r.to_kg >= 999999 ? 'and over' : r.to_kg}</td>
                    <td>{METHOD[r.method]}</td>
                    <td className="r">{r.step_kg}</td>
                    {mode === 'rates' ? (
                      <>
                        <td className="r">{input(k, 'charge', `${r.zone_code} up to ${r.to_kg} kg rate`)}</td>
                        {showExtras && <><td className="r">{input(k, 'basic', `${r.zone_code} basic charge`)}</td><td className="r">{input(k, 'minimum', `${r.zone_code} minimum charge`)}</td></>}
                      </>
                    ) : (
                      <><td className="r">${r.charge.toFixed(2)}</td><td className="r">{input(k, 'margin', `${r.zone_code} up to ${r.to_kg} kg margin`)}</td></>
                    )}
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={9} className="hint">No rates match.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {editable && (
        <div className="flex mt8">
          <button className="btn primary" disabled={pending || !changed.length || invalid} onClick={save}>
            {pending ? 'Saving…' : `Save ${changed.length || ''} change${changed.length === 1 ? '' : 's'}`}
          </button>
          {invalid && <span className="hint">Some values aren’t valid numbers.</span>}
          <span className="hint">Only the rows on this page that you change are saved.</span>
        </div>
      )}
    </div>
  );
}

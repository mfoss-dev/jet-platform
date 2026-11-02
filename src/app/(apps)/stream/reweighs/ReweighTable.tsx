'use client';

import { useState, useTransition } from 'react';
import { money } from '@/lib/format';
import { decideReweighs, type Decision } from './actions';

export type PendingReweigh = { id: string; connote: string; customer: string; declared: number; carrier: number; extra: number; file: string };

const ACTIONS: [Decision, string][] = [['pass_on', 'Pass on'], ['absorb', 'Absorb'], ['dispute', 'Dispute']];

export function ReweighTable({ rows, canEdit }: { rows: PendingReweigh[]; canEdit: boolean }) {
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();

  const decide = (ids: string[], d: Decision) =>
    start(async () => {
      const r = await decideReweighs(ids, d, note);
      setResult(r);
      if (r.ok) { setTicked(new Set()); setNote(''); }
    });
  const toggle = (id: string) => setTicked((t) => { const n = new Set(t); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const tickedExtra = rows.filter((r) => ticked.has(r.id)).reduce((a, r) => a + r.extra, 0);

  return (
    <div className="card" style={{ padding: 0 }}>
      <div style={{ padding: '14px 16px 0' }}>
        <h3>Waiting for a decision</h3>
        {result && <div className={`banner ${result.ok ? '' : 'warn'}`} role="status">{result.message}</div>}
      </div>
      {!rows.length ? (
        <p className="hint" style={{ padding: '0 16px 16px' }}>All reweighs are decided.</p>
      ) : (
        <>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  {canEdit && (
                    <th><input type="checkbox" aria-label="Select all" checked={ticked.size === rows.length}
                      onChange={(e) => setTicked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th>
                  )}
                  <th>Connote</th><th>Customer</th><th className="r">Declared</th><th className="r">Carrier</th><th className="r">Extra</th>
                  {canEdit && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} title={r.file}>
                    {canEdit && <td><input type="checkbox" aria-label={`Select ${r.connote}`} checked={ticked.has(r.id)} onChange={() => toggle(r.id)} /></td>}
                    <td><b>{r.connote}</b></td>
                    <td>{r.customer}</td>
                    <td className="r">{r.declared} kg</td>
                    <td className="r">{r.carrier} kg <span className="hint">(+{Math.round((r.carrier - r.declared) * 10) / 10})</span></td>
                    <td className="r">{money(r.extra)}</td>
                    {canEdit && (
                      <td className="r" style={{ whiteSpace: 'nowrap' }}>
                        {ACTIONS.map(([d, label]) => (
                          <button key={d} className={`btn sm ${d === 'pass_on' ? 'primary' : ''}`} style={{ marginLeft: 4 }} disabled={pending} onClick={() => decide([r.id], d)}>{label}</button>
                        ))}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canEdit && (
            <div className="flex" style={{ padding: '12px 16px 16px', borderTop: '1px solid var(--line)' }}>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional), e.g. customer agreed" aria-label="Decision note" style={{ flex: 1, minWidth: 200 }} />
              <span className="hint">{ticked.size ? `${ticked.size} ticked · ${money(tickedExtra)}` : 'Tick rows to decide several at once'}</span>
              {ACTIONS.map(([d, label]) => (
                <button key={d} className={`btn sm ${d === 'pass_on' ? 'primary' : ''}`} disabled={pending || !ticked.size} onClick={() => decide([...ticked], d)}>{label} ticked</button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

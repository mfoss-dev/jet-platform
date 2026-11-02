'use client';

import { useMemo, useState, useTransition } from 'react';
import { saveDraft, type BreakInput } from './actions';

type Kind = 'doc' | 'parcel';
type Method = 'E' | 'I' | 'M';
export type GridBreak = { kind: Kind; to_kg: number; method: Method; step_kg: number };
type Row = { id: number; kind: Kind; to: string; method: Method; step: string; cells: Record<string, string> };

const KINDS: [Kind, string][] = [['doc', 'Documents'], ['parcel', 'Parcels']];
const METHODS: [Method, string][] = [['E', 'Flat price'], ['I', 'Per step'], ['M', 'Per kg (whole weight)']];
const key = (kind: string, to: number | string, zone: string) => `${kind}|${Number(to)}|${zone}`;
const fmt = (n: number | undefined) => (n == null ? '' : String(Math.round(n * 100) / 100));

type Props = {
  versionId: string;
  editable: boolean;
  zones: { code: string; name: string }[];
  breaks: GridBreak[];
  cells: Record<string, number>;           // key(kind, to_kg, zone) -> charge
  compare: Record<string, number> | null;  // the live version, to highlight what this draft changes
  compareLabel?: string;
  note: string;
  fileName: string;
};

export function TariffGrid({ versionId, editable, zones, breaks, cells, compare, compareLabel, note: initialNote, fileName }: Props) {
  const initial = useMemo(
    () => breaks.map((b, i) => ({
      id: i, kind: b.kind, to: String(Number(b.to_kg)), method: b.method, step: String(Number(b.step_kg)),
      cells: Object.fromEntries(zones.map((z) => [z.code, fmt(cells[key(b.kind, b.to_kg, z.code)])])),
    })),
    [breaks, cells, zones],
  );
  const [rows, setRows] = useState<Row[]>(initial);
  const [nextId, setNextId] = useState(initial.length);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState(initialNote);
  const [pct, setPct] = useState('');
  const [scopeZone, setScopeZone] = useState('');
  const [scopeKind, setScopeKind] = useState<'' | Kind>('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();

  const update = (fn: (rs: Row[]) => Row[]) => { setRows(fn); setDirty(true); setResult(null); };
  const setCell = (id: number, zone: string, v: string) => update((rs) => rs.map((r) => (r.id === id ? { ...r, cells: { ...r.cells, [zone]: v } } : r)));
  const setField = (id: number, patch: Partial<Row>) => update((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addRow = (kind: Kind) => {
    const last = rows.filter((r) => r.kind === kind).at(-1);
    update((rs) => [...rs, { id: nextId, kind, to: last ? String(Number(last.to) + 5) : '0.5', method: 'I', step: '0.5', cells: Object.fromEntries(zones.map((z) => [z.code, ''])) }]);
    setNextId((n) => n + 1);
  };

  // Paste a block copied from Excel (tab-separated rows) starting at the clicked cell.
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>, kind: Kind, rowIndex: number, zoneIndex: number) => {
    const text = e.clipboardData.getData('text');
    if (!/[\t\n]/.test(text.trim())) return; // a single value pastes normally
    e.preventDefault();
    const block = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((l) => l.split('\t'));
    const kindRows = rows.filter((r) => r.kind === kind);
    update((rs) => rs.map((r) => {
      const i = kindRows.findIndex((k) => k.id === r.id) - rowIndex;
      if (r.kind !== kind || i < 0 || i >= block.length) return r;
      const cellsCopy = { ...r.cells };
      block[i].forEach((v, j) => {
        const z = zones[zoneIndex + j];
        if (z) cellsCopy[z.code] = v.replace(/[$,\s]/g, '');
      });
      return { ...r, cells: cellsCopy };
    }));
    setResult({ ok: true, message: `Pasted ${block.length} row${block.length === 1 ? '' : 's'} × ${block[0].length} column${block[0].length === 1 ? '' : 's'}. Check, then save the draft.` });
  };

  const applyPct = () => {
    const p = Number(pct);
    if (!Number.isFinite(p) || p === 0) return setResult({ ok: false, message: 'Enter a percentage, e.g. 3.5 or -2.' });
    update((rs) => rs.map((r) => (scopeKind && r.kind !== scopeKind ? r : {
      ...r,
      cells: Object.fromEntries(Object.entries(r.cells).map(([z, v]) => {
        if ((scopeZone && z !== scopeZone) || v === '' || !Number.isFinite(Number(v))) return [z, v];
        return [z, String(Math.round(Number(v) * (1 + p / 100) * 100) / 100)];
      })),
    })));
    setResult({ ok: true, message: `${p > 0 ? '+' : ''}${p}% applied to ${scopeZone ? `zone ${scopeZone}` : 'all zones'}${scopeKind ? `, ${scopeKind === 'doc' ? 'documents' : 'parcels'}` : ''}. Check, then save the draft.` });
  };

  const problems = useMemo(() => {
    const out: string[] = [];
    for (const [kind, label] of KINDS) {
      const tos = rows.filter((r) => r.kind === kind).map((r) => Number(r.to));
      if (tos.some((t) => !Number.isFinite(t) || t <= 0)) out.push(`${label}: every break needs an "up to" weight above 0.`);
      if (new Set(tos).size !== tos.length) out.push(`${label}: two breaks have the same "up to" weight.`);
    }
    if (rows.some((r) => Object.values(r.cells).some((v) => v !== '' && !(Number(v) >= 0)))) out.push('Some prices aren’t numbers.');
    return out;
  }, [rows]);

  const save = () => start(async () => {
    const payload: BreakInput[] = rows.map((r) => ({
      kind: r.kind, to_kg: Number(r.to), method: r.method, step_kg: Number(r.step) || 0.5,
      cells: Object.fromEntries(Object.entries(r.cells).map(([z, v]) => [z, v === '' ? null : Number(v)])),
    }));
    const res = await saveDraft(versionId, payload, note);
    setResult(res);
    if (res.ok) setDirty(false);
  });

  const exportCsv = () => {
    const head = ['Kind', 'Up to kg', 'Method', 'Step kg', ...zones.map((z) => `Zone ${z.code} ${z.name}`)];
    const lines = [...rows].sort((a, b) => a.kind.localeCompare(b.kind) || Number(a.to) - Number(b.to))
      .map((r) => [r.kind === 'doc' ? 'Documents' : 'Parcels', r.to, r.method, r.step, ...zones.map((z) => r.cells[z.code])]);
    const csv = [head, ...lines].map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${fileName}.csv`;
    a.click();
  };

  return (
    <div>
      {editable && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="flex">
            <b>Adjust prices</b>
            <input value={pct} onChange={(e) => setPct(e.target.value)} placeholder="e.g. 3.5 or -2" aria-label="Percent change" style={{ width: 130 }} inputMode="decimal" />
            <span>%</span>
            <select className="f" value={scopeZone} onChange={(e) => setScopeZone(e.target.value)} aria-label="Zones to adjust" style={{ width: 'auto' }}>
              <option value="">All zones</option>
              {zones.map((z) => <option key={z.code} value={z.code}>Zone {z.code} · {z.name}</option>)}
            </select>
            <select className="f" value={scopeKind} onChange={(e) => setScopeKind(e.target.value as '' | Kind)} aria-label="Documents or parcels" style={{ width: 'auto' }}>
              <option value="">Documents and parcels</option><option value="doc">Documents only</option><option value="parcel">Parcels only</option>
            </select>
            <button className="btn" onClick={applyPct}>Apply</button>
            <span className="hint">Tip: copy a block of prices in Excel and paste it into any cell.</span>
          </div>
        </div>
      )}

      {result && <div className={`banner ${result.ok ? '' : 'warn'}`} role="status">{result.message}</div>}
      {editable && problems.length > 0 && <div className="banner warn">{problems.map((p) => <div key={p}>{p}</div>)}</div>}

      {KINDS.map(([kind, label]) => {
        const kindRows = rows.filter((r) => r.kind === kind).sort((a, b) => Number(a.to) - Number(b.to) || a.id - b.id);
        return (
          <div className="card" key={kind} style={{ padding: 0, marginBottom: 12 }}>
            <div style={{ padding: '12px 16px 0' }}><h3>{label}</h3></div>
            <div className="tw">
              <table>
                <thead>
                  <tr>
                    <th>Up to kg</th><th>How it&apos;s priced</th><th>Step kg</th>
                    {zones.map((z) => <th key={z.code} className="r" title={z.name}>Zone {z.code}<div className="hint" style={{ textTransform: 'none' }}>{z.name}</div></th>)}
                    {editable && <th />}
                  </tr>
                </thead>
                <tbody>
                  {kindRows.map((r, ri) => (
                    <tr key={r.id}>
                      <td>{editable ? <input value={r.to} onChange={(e) => setField(r.id, { to: e.target.value })} aria-label="Up to kg" style={{ width: 70 }} inputMode="decimal" /> : r.to}</td>
                      <td>
                        {editable ? (
                          <select className="f" value={r.method} onChange={(e) => setField(r.id, { method: e.target.value as Method })} aria-label="How it's priced">
                            {METHODS.map(([m, l]) => <option key={m} value={m}>{l}</option>)}
                          </select>
                        ) : METHODS.find(([m]) => m === r.method)?.[1]}
                      </td>
                      <td>{r.method === 'E' ? <span className="hint">—</span> : editable
                        ? <input value={r.step} onChange={(e) => setField(r.id, { step: e.target.value })} aria-label="Step kg" style={{ width: 60 }} inputMode="decimal" />
                        : r.step}</td>
                      {zones.map((z, zi) => {
                        const v = r.cells[z.code];
                        const was = compare?.[key(kind, r.to, z.code)];
                        const changed = compare != null && v !== '' && was !== Number(v);
                        return (
                          <td key={z.code} className="r" style={changed ? { background: 'var(--note)' } : undefined}
                            title={changed ? (was == null ? `New (not in ${compareLabel})` : `Was $${was} in ${compareLabel}`) : undefined}>
                            {editable ? (
                              <input value={v} onChange={(e) => setCell(r.id, z.code, e.target.value)} onPaste={(e) => onPaste(e, kind, ri, zi)}
                                aria-label={`${label}, up to ${r.to} kg, zone ${z.code} price`} inputMode="decimal" style={{ width: 78, textAlign: 'right' }} />
                            ) : v === '' ? <span className="hint">—</span> : `$${Number(v).toFixed(2)}`}
                          </td>
                        );
                      })}
                      {editable && <td><button className="btn sm ghost" title="Remove this break" onClick={() => update((rs) => rs.filter((x) => x.id !== r.id))}>✕</button></td>}
                    </tr>
                  ))}
                  {!kindRows.length && <tr><td colSpan={zones.length + 4} className="hint">No {label.toLowerCase()} breaks.</td></tr>}
                </tbody>
              </table>
            </div>
            {editable && <div style={{ padding: '8px 16px 12px' }}><button className="btn sm" onClick={() => addRow(kind)}>+ Add break</button></div>}
          </div>
        );
      })}

      <div className="flex">
        {editable && (
          <>
            <input value={note} onChange={(e) => { setNote(e.target.value); setDirty(true); }} placeholder="What changed, e.g. DHL 2027 GRI" aria-label="Note" style={{ flex: 1, minWidth: 220 }} />
            <button className="btn primary" disabled={pending || !dirty || problems.length > 0} onClick={save}>{pending ? 'Saving…' : 'Save draft'}</button>
            {dirty && <span className="hint">Unsaved changes</span>}
          </>
        )}
        <button className="btn" onClick={exportCsv}>Export to Excel (CSV)</button>
      </div>
      <p className="hint mt8">
        Flat price: one price for any weight in the break. Per step: the price at the start of the break plus this much for each step into it.
        Per kg: this rate times the whole weight. Prices are Jet&apos;s base rates ex GST; the customer pays base × (1 + their sales tariff margin).
      </p>
    </div>
  );
}

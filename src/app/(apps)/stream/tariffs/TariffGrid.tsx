'use client';

import { useMemo, useState, useTransition } from 'react';
import { saveMargins, saveRates, type MarginRow, type RateKey, type RateRow } from './actions';

// Spreadsheet-style editor for rate cards with a handful of zones (international): weight breaks down, zones across.
// The same grid edits a sales tariff's margins (mode "margins"), laid out like its rate card.
type Kind = 'doc' | 'parcel';
type Method = 'E' | 'I' | 'M';
export type Rate = { zone_code: string; kind: Kind; from_kg: number; to_kg: number; step_kg: number; method: Method; charge: number; basic: number; minimum: number };
type Row = { id: number; kind: Kind; from: string; to: string; method: Method; step: string; cells: Record<string, string> };

const KINDS: [Kind, string][] = [['doc', 'Documents'], ['parcel', 'Parcels']];
const METHODS: [Method, string][] = [['E', 'Exact price'], ['I', 'Per step'], ['M', 'Per kg (whole weight)']];
const fmt = (n: number | undefined) => (n == null ? '' : String(Math.round(n * 10000) / 10000));
const cellKey = (kind: string, to: number | string, zone: string) => `${kind}|${Number(to)}|${zone}`;

type Props = {
  mode: 'rates' | 'margins';
  id: string;                               // version id (rates) or sales tariff id (margins)
  editable: boolean;
  zones: string[];
  rates: Rate[];                            // the rate card rows (margins mode: the live version, for the layout)
  margins?: Record<string, number>;         // margins mode: cellKey -> margin %
  compare?: Record<string, number> | null;  // rates mode: the live version's charges, to highlight a draft's changes
  compareLabel?: string;
  note?: string;
  fileName: string;
};

export function TariffGrid({ mode, id, editable, zones, rates, margins = {}, compare = null, compareLabel, note: initialNote = '', fileName }: Props) {
  // One grid row per distinct break (zones normally share their breaks on international cards).
  const initial = useMemo(() => {
    const byBreak = new Map<string, Row>();
    let i = 0;
    for (const r of [...rates].sort((a, b) => a.kind.localeCompare(b.kind) || a.to_kg - b.to_kg)) {
      const k = `${r.kind}|${r.to_kg}|${r.from_kg}|${r.step_kg}|${r.method}`;
      if (!byBreak.has(k)) byBreak.set(k, { id: i++, kind: r.kind, from: fmt(r.from_kg), to: fmt(r.to_kg), method: r.method, step: fmt(r.step_kg), cells: Object.fromEntries(zones.map((z) => [z, ''])) });
      byBreak.get(k)!.cells[r.zone_code] = mode === 'rates' ? fmt(r.charge) : fmt(margins[cellKey(r.kind, r.to_kg, r.zone_code)]);
    }
    return [...byBreak.values()];
  }, [rates, margins, zones, mode]);
  const extras = useMemo(() => new Map(rates.map((r) => [cellKey(r.kind, r.to_kg, r.zone_code), r])), [rates]);

  const [rows, setRows] = useState<Row[]>(initial);
  const [nextId, setNextId] = useState(initial.length);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState(initialNote);
  const [pct, setPct] = useState('');
  const [scopeZone, setScopeZone] = useState('');
  const [scopeKind, setScopeKind] = useState<'' | Kind>('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();
  const structure = mode === 'rates' && editable;

  const update = (fn: (rs: Row[]) => Row[]) => { setRows(fn); setDirty(true); setResult(null); };
  const setCell = (rid: number, zone: string, v: string) => update((rs) => rs.map((r) => (r.id === rid ? { ...r, cells: { ...r.cells, [zone]: v } } : r)));
  const setField = (rid: number, patch: Partial<Row>) => update((rs) => rs.map((r) => (r.id === rid ? { ...r, ...patch } : r)));
  const addRow = (kind: Kind) => {
    const last = rows.filter((r) => r.kind === kind).sort((a, b) => Number(a.to) - Number(b.to)).at(-1);
    update((rs) => [...rs, { id: nextId, kind, from: last ? last.to : '0', to: last ? String(Number(last.to) + 5) : '0.5', method: 'I', step: '0.5', cells: Object.fromEntries(zones.map((z) => [z, ''])) }]);
    setNextId((n) => n + 1);
  };

  // Paste a block copied from Excel (tab-separated rows) starting at the clicked cell.
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>, kind: Kind, rowIndex: number, zoneIndex: number) => {
    const text = e.clipboardData.getData('text');
    if (!/[\t\n]/.test(text.trim())) return;
    e.preventDefault();
    const block = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((l) => l.split('\t'));
    const kindRows = rows.filter((r) => r.kind === kind).sort((a, b) => Number(a.to) - Number(b.to) || a.id - b.id);
    update((rs) => rs.map((r) => {
      const i = kindRows.findIndex((k) => k.id === r.id) - rowIndex;
      if (r.kind !== kind || i < 0 || i >= block.length) return r;
      const cells = { ...r.cells };
      block[i].forEach((v, j) => { const z = zones[zoneIndex + j]; if (z) cells[z] = v.replace(/[$,%\s]/g, ''); });
      return { ...r, cells };
    }));
    setResult({ ok: true, message: `Pasted ${block.length} row${block.length === 1 ? '' : 's'} × ${block[0].length} column${block[0].length === 1 ? '' : 's'}. Check, then save.` });
  };

  const applyPct = () => {
    const p = Number(pct);
    if (!Number.isFinite(p) || p === 0) return setResult({ ok: false, message: 'Enter a percentage, e.g. 3.5 or -2.' });
    update((rs) => rs.map((r) => (scopeKind && r.kind !== scopeKind ? r : {
      ...r,
      cells: Object.fromEntries(Object.entries(r.cells).map(([z, v]) => (
        (scopeZone && z !== scopeZone) || v === '' || !Number.isFinite(Number(v)) ? [z, v]
          : [z, String(Math.round((mode === 'rates' ? Number(v) * (1 + p / 100) : Number(v) + p) * 100) / 100)]))),
    })));
    setResult({ ok: true, message: `${mode === 'rates' ? `${p > 0 ? '+' : ''}${p}%` : `${p > 0 ? '+' : ''}${p} points`} applied to ${scopeZone ? `zone ${scopeZone}` : 'all zones'}. Check, then save.` });
  };

  const problems = useMemo(() => {
    const out: string[] = [];
    for (const [kind, label] of KINDS) {
      const tos = rows.filter((r) => r.kind === kind).map((r) => Number(r.to));
      if (tos.some((t) => !Number.isFinite(t) || t <= 0)) out.push(`${label}: every break needs an "up to" weight above 0.`);
      if (new Set(tos).size !== tos.length) out.push(`${label}: two breaks have the same "up to" weight.`);
    }
    if (rows.some((r) => Object.values(r.cells).some((v) => v !== '' && !Number.isFinite(Number(v))))) out.push('Some cells aren’t numbers.');
    return out;
  }, [rows]);

  const save = () => start(async () => {
    if (mode === 'margins') {
      const changes: MarginRow[] = [];
      for (const r of rows) for (const z of zones) {
        if (!extras.has(cellKey(r.kind, r.to, z))) continue;           // no rate in this cell: no margin to set
        const was = margins[cellKey(r.kind, r.to, z)];
        const v = r.cells[z];
        if (v === '' && was != null) changes.push({ zone_code: z, kind: r.kind, to_kg: Number(r.to), margin_pct: null });
        else if (v !== '' && Number(v) !== was) changes.push({ zone_code: z, kind: r.kind, to_kg: Number(r.to), margin_pct: Number(v) });
      }
      const res = await saveMargins(id, changes);
      setResult(res);
      if (res.ok) setDirty(false);
      return;
    }
    const upserts: RateRow[] = [];
    const keep = new Set<string>();
    for (const r of rows) for (const z of zones) {
      const v = r.cells[z];
      if (v === '') continue;
      const k = cellKey(r.kind, r.to, z);
      keep.add(k);
      const old = extras.get(k);
      const row: RateRow = { zone_code: z, kind: r.kind, from_kg: Number(r.from), to_kg: Number(r.to), step_kg: Number(r.step) || 0.5, method: r.method,
        charge: Number(v), basic: old?.basic ?? 0, minimum: old?.minimum ?? 0 };
      if (!old || old.charge !== row.charge || old.from_kg !== row.from_kg || old.step_kg !== row.step_kg || old.method !== row.method) upserts.push(row);
    }
    const deletes: RateKey[] = rates.filter((r) => !keep.has(cellKey(r.kind, r.to_kg, r.zone_code))).map((r) => ({ zone_code: r.zone_code, kind: r.kind, to_kg: r.to_kg }));
    const res = await saveRates(id, upserts, deletes, note);
    setResult(res);
    if (res.ok) setDirty(false);
  });

  const exportCsv = () => {
    const head = ['Kind', 'From kg', 'Up to kg', 'Method', 'Step kg', ...zones.map((z) => `Zone ${z}`)];
    const lines = [...rows].sort((a, b) => a.kind.localeCompare(b.kind) || Number(a.to) - Number(b.to))
      .map((r) => [r.kind === 'doc' ? 'Documents' : 'Parcels', r.from, r.to, r.method, r.step, ...zones.map((z) => r.cells[z])]);
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
            <b>{mode === 'rates' ? 'Adjust prices' : 'Adjust margins'}</b>
            <input value={pct} onChange={(e) => setPct(e.target.value)} placeholder={mode === 'rates' ? 'e.g. 3.5 or -2' : 'e.g. 2 or -1'} aria-label="Change" style={{ width: 130 }} inputMode="decimal" />
            <span>{mode === 'rates' ? '%' : 'points'}</span>
            <select className="f" value={scopeZone} onChange={(e) => setScopeZone(e.target.value)} aria-label="Zones to adjust" style={{ width: 'auto' }}>
              <option value="">All zones</option>
              {zones.map((z) => <option key={z} value={z}>Zone {z}</option>)}
            </select>
            <select className="f" value={scopeKind} onChange={(e) => setScopeKind(e.target.value as '' | Kind)} aria-label="Documents or parcels" style={{ width: 'auto' }}>
              <option value="">Documents and parcels</option><option value="doc">Documents only</option><option value="parcel">Parcels only</option>
            </select>
            <button className="btn" onClick={applyPct}>Apply</button>
            <span className="hint">Tip: copy a block in Excel and paste it into any cell.</span>
          </div>
        </div>
      )}

      {result && <div className={`banner ${result.ok ? '' : 'warn'}`} role="status">{result.message}</div>}
      {structure && problems.length > 0 && <div className="banner warn">{problems.map((p) => <div key={p}>{p}</div>)}</div>}

      {KINDS.map(([kind, label]) => {
        const kindRows = rows.filter((r) => r.kind === kind).sort((a, b) => Number(a.to) - Number(b.to) || a.id - b.id);
        if (!kindRows.length && !structure) return null;
        return (
          <div className="card" key={kind} style={{ padding: 0, marginBottom: 12 }}>
            <div style={{ padding: '12px 16px 0' }}><h3>{label}</h3></div>
            <div className="tw">
              <table>
                <thead>
                  <tr>
                    <th>Up to kg</th><th>How it&apos;s priced</th><th>Step kg</th>
                    {zones.map((z) => <th key={z} className="r">Zone {z}</th>)}
                    {structure && <th />}
                  </tr>
                </thead>
                <tbody>
                  {kindRows.map((r, ri) => (
                    <tr key={r.id}>
                      <td>{structure ? <input value={r.to} onChange={(e) => setField(r.id, { to: e.target.value })} aria-label="Up to kg" style={{ width: 70 }} inputMode="decimal" /> : r.to}</td>
                      <td>
                        {structure ? (
                          <select className="f" value={r.method} onChange={(e) => setField(r.id, { method: e.target.value as Method })} aria-label="How it's priced">
                            {METHODS.map(([m, l]) => <option key={m} value={m}>{l}</option>)}
                          </select>
                        ) : METHODS.find(([m]) => m === r.method)?.[1]}
                      </td>
                      <td>{structure ? <input value={r.step} onChange={(e) => setField(r.id, { step: e.target.value })} aria-label="Step kg" style={{ width: 60 }} inputMode="decimal" /> : r.step}</td>
                      {zones.map((z, zi) => {
                        const v = r.cells[z];
                        const was = compare?.[cellKey(kind, r.to, z)];
                        const changed = compare != null && v !== '' && was !== Number(v);
                        const hasRate = mode === 'rates' || extras.has(cellKey(kind, r.to, z));
                        return (
                          <td key={z} className="r" style={changed ? { background: 'var(--note)' } : undefined}
                            title={changed ? (was == null ? `New (not in ${compareLabel})` : `Was $${was} in ${compareLabel}`) : undefined}>
                            {!hasRate ? <span className="hint">—</span> : editable ? (
                              <input value={v} onChange={(e) => setCell(r.id, z, e.target.value)} onPaste={(e) => onPaste(e, kind, ri, zi)}
                                aria-label={`${label}, up to ${r.to} kg, zone ${z} ${mode === 'rates' ? 'price' : 'margin'}`} inputMode="decimal" style={{ width: 78, textAlign: 'right' }} />
                            ) : v === '' ? <span className="hint">—</span> : mode === 'rates' ? `$${Number(v).toFixed(2)}` : `${v}%`}
                          </td>
                        );
                      })}
                      {structure && <td><button className="btn sm ghost" title="Remove this break" onClick={() => update((rs) => rs.filter((x) => x.id !== r.id))}>✕</button></td>}
                    </tr>
                  ))}
                  {!kindRows.length && <tr><td colSpan={zones.length + 4} className="hint">No {label.toLowerCase()} breaks.</td></tr>}
                </tbody>
              </table>
            </div>
            {structure && <div style={{ padding: '8px 16px 12px' }}><button className="btn sm" onClick={() => addRow(kind)}>+ Add break</button></div>}
          </div>
        );
      })}

      <div className="flex">
        {editable && (
          <>
            {mode === 'rates' && <input value={note} onChange={(e) => { setNote(e.target.value); setDirty(true); }} placeholder="What changed, e.g. DHL 2027 GRI" aria-label="Note" style={{ flex: 1, minWidth: 220 }} />}
            <button className="btn primary" disabled={pending || !dirty || (structure && problems.length > 0)} onClick={save}>{pending ? 'Saving…' : mode === 'rates' ? 'Save draft' : 'Save margins'}</button>
            {dirty && <span className="hint">Unsaved changes</span>}
          </>
        )}
        <button className="btn" onClick={exportCsv}>Export to Excel (CSV)</button>
      </div>
      <p className="hint mt8">
        {mode === 'rates'
          ? <>Exact price: the price for any weight in the break. Per step: add this for each step into the break. Per kg: this rate times the whole weight. Jet&apos;s base rates, ex GST.</>
          : <>Margin % on each base rate. The customer pays each rate × (1 + margin), added up step by step, as JetStream does. Changes apply straight away.</>}
      </p>
    </div>
  );
}

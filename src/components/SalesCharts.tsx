import { day, money } from '@/lib/format';

// Small single-series charts for JetSales, drawn as SVG in the brand colour. Each mark carries a <title>, which the
// browser shows on hover; the weekly chart also has a table view.

export function WeeklyBars({ values, mondays, label }: { values: number[]; mondays: string[]; label: string }) {
  const W = 640, H = 170, top = 14, bottom = 22, gap = 2;
  const max = Math.max(...values, 1);
  const bw = W / values.length;
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} style={{ width: '100%', height: 'auto', display: 'block' }}>
        <line x1={0} x2={W} y1={H - bottom} y2={H - bottom} stroke="var(--line)" strokeWidth={1} />
        {values.map((v, i) => {
          const h = (v / max) * (H - top - bottom);
          const x = i * bw + gap;
          return (
            <g key={mondays[i]}>
              <rect x={i * bw} y={top} width={bw} height={H - top - bottom} fill="transparent"><title>{`Week of ${day(mondays[i])}: ${money(v)}`}</title></rect>
              {h > 0 && <path d={roundedTop(x, H - bottom - h, bw - 2 * gap, h, 4)} fill="var(--brand-2)" pointerEvents="none" />}
              {(i % 2 === values.length % 2 || values.length <= 8) && (
                <text x={i * bw + bw / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--muted)">{day(mondays[i])}</text>
              )}
            </g>
          );
        })}
        <text x={0} y={10} fontSize={10} fill="var(--muted)">{money(max)}</text>
      </svg>
      <details className="mt8">
        <summary className="hint" style={{ cursor: 'pointer' }}>Show as a table</summary>
        <table className="mt8"><thead><tr><th>Week of</th><th className="r">Sales ex GST</th></tr></thead>
          <tbody>{values.map((v, i) => <tr key={mondays[i]}><td>{day(mondays[i])}</td><td className="r">{money(v)}</td></tr>)}</tbody></table>
      </details>
    </figure>
  );
}

// A bar with only its top corners rounded, anchored to the baseline.
function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

export function Sparkline({ values, mondays }: { values: number[]; mondays: string[] }) {
  const W = 110, H = 28, pad = 3;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => [pad + (i * (W - 2 * pad)) / Math.max(values.length - 1, 1), H - pad - (v / max) * (H - 2 * pad)]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`Weekly sales, last ${values.length} weeks`}>
      <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke="var(--brand-2)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {pts.map(([x, y], i) => (
        <circle key={mondays[i]} cx={x} cy={y} r={6} fill="transparent"><title>{`Week of ${day(mondays[i])}: ${money(values[i])}`}</title></circle>
      ))}
    </svg>
  );
}

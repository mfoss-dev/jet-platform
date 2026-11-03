import Link from 'next/link';
import { day } from '@/lib/format';

// The JetSales page heading: title, what the figures are, and the "include duties" switch.
export function SalesHeader({ title, sub, asOf, duties, path, query = {} }: { title: string; sub: string; asOf: string; duties: boolean; path: string; query?: Record<string, string> }) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="top">
      <div>
        <h1>{title}</h1>
        <div className="sub">
          {sub} · ex GST by ship date{duties ? ', customs duties included' : ''} · to {day(asOf)}
          {asOf < today && <span className="hint"> (latest shipments in the data)</span>}
        </div>
      </div>
      <Link className="btn sm ghost" href={{ pathname: path, query: { ...query, ...(duties ? {} : { duties: '1' }) } }}>{duties ? 'Leave out duties' : 'Include duties'}</Link>
    </div>
  );
}

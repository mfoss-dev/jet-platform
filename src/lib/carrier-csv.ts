// Reads a carrier's invoice data file into invoices and shipment lines for public.import_carrier_invoice.
// DHL MyBill's CSV: one "I" row per invoice (its totals) and one "S" row per shipment, with the weight charge,
// up to nine extra charges (XC1–XC9), other charges, discounts and the four weights.
// Only business fields are read: the file's names, addresses and contacts are never kept.

export type Extra = { code: string; name: string; amount: number };
export type CarrierLine = {
  line_no: number; waybill: string; reference: string | null; shipped_on: string | null; product: string | null; product_name: string | null;
  pieces: number | null; orig_country: string | null; dest_country: string | null;
  declared_kg: number | null; carrier_kg: number | null; declared_vol_kg: number | null; carrier_vol_kg: number | null;
  weight_flag: string | null; billed_kg: number | null; weight_charge: number; extras: Extra[]; total_ex: number; tax: number;
};
export type CarrierInvoice = {
  carrier_code: string; branch_code: string; invoice_number: string; account_number: string | null; invoice_date: string | null;
  due_date: string | null; currency: string | null; total_ex: number; tax: number; file_name: string; lines: CarrierLine[];
};

// RFC 4180: quoted fields, doubled quotes, commas and line breaks inside quotes.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim()));
}

const num = (s: string | undefined) => {
  const v = (s ?? '').replace(/[$,\s]/g, '');
  return v === '' || Number.isNaN(Number(v)) ? null : Number(v);
};
const money = (s: string | undefined) => Math.round((num(s) ?? 0) * 100) / 100;
const text = (s: string | undefined) => (s ?? '').trim() || null;
// yyyymmdd (DHL) or yyyy-mm-dd to an ISO date.
const isoDate = (s: string | undefined) => {
  const v = (s ?? '').trim();
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(v);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const STATION_BRANCH: Record<string, string> = { SYD: 'AU', MEL: 'AU', BNE: 'AU', AKL: 'NZ', CHC: 'NZ', WLG: 'NZ' };

export const isDhlFile = (header: string[]) => ['Line Type', 'Invoice Number', 'Shipment Number', 'XC1 Code'].every((h) => header.includes(h));

export function readDhlFile(csv: string, fileName: string, branchOverride?: string): CarrierInvoice[] {
  const [header, ...rows] = parseCsv(csv.replace(/^﻿/, ''));
  if (!header || !isDhlFile(header.map((h) => h.trim()))) {
    throw new Error(`${fileName} isn't a DHL invoice data file (the CSV from MyBill, with "Shipment Number" and "XC1 Code" columns)`);
  }
  const col = new Map(header.map((h, i) => [h.trim(), i]));
  const get = (r: string[], name: string) => r[col.get(name) ?? -1];

  const invoices = new Map<string, CarrierInvoice>();
  const invoiceFor = (r: string[]) => {
    const number = (get(r, 'Invoice Number') ?? '').trim();
    let inv = invoices.get(number);
    if (!inv) {
      const station = (get(r, 'Station Code') ?? '').trim().toUpperCase();
      const source = (get(r, 'Billing Source') ?? '').trim().toUpperCase();
      inv = {
        carrier_code: 'DHL', branch_code: branchOverride || STATION_BRANCH[station] || (source.startsWith('NZ') ? 'NZ' : 'AU'),
        invoice_number: number, account_number: text(get(r, 'Billing Account')), invoice_date: isoDate(get(r, 'Invoice Date')),
        due_date: isoDate(get(r, 'Due Date')), currency: text(get(r, 'Currency')), total_ex: 0, tax: 0, file_name: fileName, lines: [],
      };
      invoices.set(number, inv);
    }
    return inv;
  };

  for (const r of rows) {
    const type = (get(r, 'Line Type') ?? '').trim().toUpperCase();
    const inv = invoiceFor(r);
    if (type === 'I') {
      inv.total_ex = money(get(r, 'Total amount (excl. VAT)'));
      inv.tax = money(get(r, 'Total Tax'));
      continue;
    }
    if (type !== 'S') continue;
    const extras: Extra[] = [];
    for (let i = 1; i <= 9; i++) {
      const code = (get(r, `XC${i} Code`) ?? '').trim();
      const amount = money(get(r, `XC${i} Charge`)) - Math.abs(money(get(r, `XC${i} Discount`)));
      if (code && code !== '0' && amount) extras.push({ code, name: (get(r, `XC${i} Name`) ?? '').trim() || code, amount: Math.round(amount * 100) / 100 });
    }
    for (const i of [1, 2]) {
      const name = (get(r, `Other Charges ${i}`) ?? '').trim();
      const amount = money(get(r, `Other Charges ${i} Amount`));
      if (amount) extras.push({ code: name || `OTHER${i}`, name: name || 'Other charge', amount });
    }
    const fee = money(get(r, 'Invoice Fee'));
    if (fee) extras.push({ code: 'FEE', name: 'INVOICE FEE', amount: fee });
    const discount = [1, 2, 3].reduce((a, i) => a + Math.abs(money(get(r, `Discount ${i} Amount`))), 0);
    if (discount) extras.push({ code: 'DISC', name: 'DISCOUNT', amount: -Math.round(discount * 100) / 100 });

    inv.lines.push({
      line_no: inv.lines.length + 1,
      waybill: (get(r, 'Shipment Number') ?? '').trim(),
      reference: text(get(r, 'Shipment Reference 1')),
      shipped_on: isoDate(get(r, 'Shipment Date')),
      product: text(get(r, 'Product')), product_name: text(get(r, 'Product Name')),
      pieces: num(get(r, 'Pieces')),
      orig_country: text(get(r, 'Orig Country Code')), dest_country: text(get(r, 'Dest Country Code')),
      declared_kg: num(get(r, 'Cust Scale Weight (A)')), carrier_kg: num(get(r, 'DHL Scale Weight (B)')),
      declared_vol_kg: num(get(r, 'Cust Vol Weight (V)')), carrier_vol_kg: num(get(r, 'DHL Vol Weight (W)')),
      weight_flag: text(get(r, 'Weight Flag')), billed_kg: num(get(r, 'Weight (kg)')),
      weight_charge: money(get(r, 'Weight Charge')), extras,
      total_ex: money(get(r, 'Total amount (excl. VAT)')), tax: money(get(r, 'Total Tax')),
    });
  }
  const list = [...invoices.values()].filter((i) => i.invoice_number && i.lines.length);
  if (!list.length) throw new Error(`${fileName} has no shipment lines`);
  // Without an invoice total row, the total is the sum of the lines.
  for (const i of list) {
    if (!i.total_ex) i.total_ex = Math.round(i.lines.reduce((a, l) => a + l.total_ex, 0) * 100) / 100;
    if (!i.tax) i.tax = Math.round(i.lines.reduce((a, l) => a + l.tax, 0) * 100) / 100;
  }
  return list;
}

export const ISSUES: Record<string, [string, string, string]> = {
  no_job: ['Never billed', 'bad', 'DHL charged for a shipment Jet has no job for'],
  duplicate: ['Charged twice', 'bad', 'This waybill is already on an earlier DHL invoice'],
  below_cost: ['Below cost', 'warn', 'Jet billed less than DHL charged (ex GST)'],
  surcharge: ['Surcharge', 'warn', "DHL surcharges that Jet's add-ons on the job don't cover"],
  heavier: ['Heavier', '', 'DHL billed a heavier weight than Jet did'],
};
export const DECISIONS: Record<string, [string, string]> = {
  pass_on: ['Passed on', 'ok'], absorb: ['Absorbed', 'warn'], dispute: ['Disputed', ''], ok: ['Fine', 'ok'],
};
export const TREATMENT: Record<string, string> = {
  review: 'Check it was charged', fuel: "Covered by Jet's fuel", included: "In Jet's rates",
};

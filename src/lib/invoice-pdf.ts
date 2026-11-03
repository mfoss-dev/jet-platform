import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { ENTITY, lineTotal, type InvoiceDoc } from '@/lib/invoice-doc';

// The invoice as a PDF (A4), laid out like JetStream's: header, a summary by service with the total due, then
// shipment detail (Charge + Fuel + Sec. + GST = Total), with the entity, date, number and page on every page.
// Built with pdf-lib's standard Helvetica, so no font files are needed on the server.

const W = 595.28, H = 841.89, M = 40;
const INK = rgb(0.13, 0.13, 0.13), MUTED = rgb(0.45, 0.45, 0.45), BAND = rgb(0.74, 0.89, 0.92), BLUE = rgb(0.05, 0.31, 0.65), RULE = rgb(0.8, 0.8, 0.8);

// Standard fonts only carry Latin characters; swap the few others the data or labels use.
const safe = (s: string) => s.replace(/→/g, '->').replace(/[−–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const amt = (n: number) => (n ? money(n) : '');
const dmy = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-') : '-');

export async function invoicePdf({ inv, shipments, byService }: InvoiceDoc): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const credit = inv.kind === 'credit';
  pdf.setTitle(safe(`${credit ? 'Credit note' : 'Invoice'} ${inv.number ?? 'draft'}`));
  pdf.setAuthor(safe(ENTITY[inv.branch_code] ?? 'Jet Worldwide'));

  let page: PDFPage = pdf.addPage([W, H]);
  let y = H - M;
  const text = (s: string, x: number, yy: number, o: { size?: number; f?: PDFFont; color?: ReturnType<typeof rgb>; right?: boolean } = {}) => {
    const size = o.size ?? 9, f = o.f ?? font, t = safe(s);
    page.drawText(t, { x: o.right ? x - f.widthOfTextAtSize(t, size) : x, y: yy, size, font: f, color: o.color ?? INK });
  };
  const rule = (yy: number, dashed = false) => page.drawLine({ start: { x: M, y: yy }, end: { x: W - M, y: yy }, thickness: 0.5, color: RULE, dashArray: dashed ? [2, 2] : undefined });
  // Shipment detail columns: label x, then right edges of the money columns.
  const COL = { ship: M, svc: M + 150, charge: 375, fuel: 420, sec: 465, gst: 510, total: W - M };
  const detailHead = () => {
    page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 16, color: BAND });
    text('Shipment', COL.ship + 4, y); text('Service / product', COL.svc, y);
    text('Charge', COL.charge, y, { right: true }); text('+ Fuel', COL.fuel, y, { right: true }); text('+ Sec.', COL.sec, y, { right: true });
    text('+ GST', COL.gst, y, { right: true }); text('= Total', COL.total - 4, y, { right: true });
    y -= 20;
  };
  const newPage = () => { page = pdf.addPage([W, H]); y = H - M; text('Shipment detail', M, y, { color: MUTED }); y -= 18; detailHead(); };
  const need = (h: number) => { if (y - h < M + 30) newPage(); };

  // ---- header
  text(credit ? 'ADJUSTMENT NOTE' : 'TAX INVOICE', M, y - 6, { size: 20, f: bold });
  text(ENTITY[inv.branch_code] ?? 'Jet Worldwide', M, y - 24, { color: MUTED });
  if (inv.kind === 'duties') text('Customs duties and charges', M, y - 36, { color: MUTED });
  if (credit) text(`Adjusts invoice ${inv.original ?? ''}${inv.reason ? ` - ${inv.reason}` : ''}`.slice(0, 95), M, y - 36);
  const facts: [string, string][] = [
    [credit ? 'Credit note no' : 'Invoice no', String(inv.number ?? 'draft')], ['Date', dmy(inv.invoice_date)], ['Account', inv.bill_to?.account_code ?? ''],
    ...(credit ? [] : [['Terms', inv.terms_code ?? '-'] as [string, string]]),
  ];
  facts.forEach(([k, v], i) => { text(k, 400, y - 4 - i * 13, { color: MUTED }); text(v, W - M, y - 4 - i * 13, { f: bold, right: true }); });
  y -= 70;
  text('Bill to', M, y, { color: MUTED });
  text(inv.bill_to?.name ?? '', M, y - 15, { size: 13, f: bold });
  y -= 40;

  // ---- summary
  page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 16, color: BAND });
  text('Summary', M + 4, y); text('Shipments', 330, y, { right: true }); text('Ex GST', 420, y, { right: true }); text('GST', 480, y, { right: true }); text('Total', W - M - 4, y, { right: true });
  y -= 18;
  for (const s of byService) {
    text(`${s.name} services`, M + 4, y); text(String(s.count), 330, y, { right: true }); text(money(s.exGst), 420, y, { right: true });
    text(money(s.gst), 480, y, { right: true }); text(money(s.exGst + s.gst), W - M - 4, y, { right: true });
    y -= 14;
  }
  rule(y + 8);
  const ex = Number(inv.charge_total) + Number(inv.fuel_total) + Number(inv.security_total);
  text(credit ? 'TOTAL CREDIT' : `TOTAL DUE ${dmy(inv.due_date)}`, M + 4, y - 4, { f: bold, color: BLUE });
  text(String(shipments.length), 330, y - 4, { right: true }); text(money(ex), 420, y - 4, { right: true }); text(money(Number(inv.gst_total)), 480, y - 4, { right: true });
  text(money(Number(inv.total)), W - M - 4, y - 4, { f: bold, right: true, color: BLUE });
  y -= 22;
  if (!credit) { text('Claims must be made within 21 days of the invoice date.', M + 4, y, { size: 8, color: MUTED }); y -= 24; } else y -= 10;

  // ---- shipment detail
  text('Shipment detail', M, y, { color: MUTED }); y -= 18;
  detailHead();
  for (const s of shipments) {
    const f = s.lines[0];
    const left = [
      [dmy(f.shipped_on), f.pieces != null ? `${f.pieces} pc` : '', f.weight != null ? `${Number(f.weight)} kg` : ''].filter(Boolean).join('  '),
      [[f.orig_country, f.dest_country].filter(Boolean).join(' -> '), f.reference ? `Ref: ${f.reference}` : ''].filter(Boolean).join('  ').slice(0, 38),
    ].filter(Boolean);
    const rows = Math.max(s.lines.filter((l) => l.code !== '.FREIGHT').length + 1, left.length + 1);
    need(rows * 11 + 8);
    text(s.connote, COL.ship + 4, y, { f: bold, color: BLUE });
    left.forEach((t, i) => text(t, COL.ship + 4, y - 11 * (i + 1), { size: 7.5, color: MUTED }));
    text(s.service, COL.svc, y, { f: bold, color: BLUE });
    s.lines.forEach((l, i) => {
      const extra = s.lines.slice(0, i + 1).filter((x) => x.code !== '.FREIGHT').length;
      const yy = y - 11 * (l.code === '.FREIGHT' ? 0 : extra);
      if (l.code !== '.FREIGHT') text(`- ${l.description || l.code}`.slice(0, 48), COL.svc, yy, { size: 8 });
      text(amt(l.charge), COL.charge, yy, { size: 8, right: true }); text(amt(l.fuel), COL.fuel, yy, { size: 8, right: true });
      text(amt(l.security), COL.sec, yy, { size: 8, right: true }); text(amt(l.gst), COL.gst, yy, { size: 8, right: true });
      text(money(lineTotal(l)), COL.total - 4, yy, { size: 8, right: true });
    });
    y -= rows * 11 + 2;
    rule(y + 6, true);
    y -= 6;
  }
  need(30);
  text(credit ? '' : `DUE DATE ${dmy(inv.due_date)}`, M + 4, y - 6, { f: bold, color: BLUE });
  text(`${credit ? 'TOTAL CREDIT' : 'TOTAL AMOUNT DUE'}   ${money(Number(inv.total))}`, W - M - 4, y - 6, { f: bold, right: true, color: BLUE });

  // ---- footer on every page
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    page = p;
    page.drawRectangle({ x: M, y: M - 14, width: W - 2 * M, height: 16, color: BAND });
    text(ENTITY[inv.branch_code] ?? 'Jet Worldwide', M + 4, M - 9, { size: 8 });
    text(`${credit ? 'Credited' : 'Invoiced'}: ${dmy(inv.invoice_date)}    ${credit ? 'Credit note' : 'Invoice'} No: ${inv.number ?? 'draft'}    Page ${i + 1} of ${pages.length}`, W - M - 4, M - 9, { size: 8, right: true });
  });
  return pdf.save();
}

// NRRL Billing — receipt and barcode-label layouts, and silent printing
'use strict';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n2 = n => (Math.round((+n || 0) * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qf = n => { const v = Math.round((+n || 0) * 100) / 100; return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, ''); };
const PAY = { cash: 'Cash', upi: 'UPI', card: 'Card', udhaar: 'Udhaar (credit)' };

function paperOf(s) {
  const paper = s.paper === '58' ? 58 : 80;
  const margin = s.print_margin !== '' && s.print_margin != null && isFinite(+s.print_margin) ? Math.max(0, +s.print_margin) : (paper === 58 ? 2 : 3);
  const fs = +s.font_size > 0 ? +s.font_size : (paper === 58 ? 11 : 12.5);
  return { paper, margin, fs };
}
function fmtDate(str) {
  // "YYYY-MM-DD HH:MM:SS" -> "19/10/2026 2:24 PM"
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(str || '');
  if (!m) return str || '';
  let h = +m[4]; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${m[3]}/${m[2]}/${m[1]} ${h}:${m[5]} ${ap}`;
}

function receiptHTML(b, s, opts = {}) {
  const { paper, margin, fs } = paperOf(s);
  const lines = b.lines.map(l => `
    <tr><td colspan="2" class="nm">${esc(l.name)}</td></tr>
    <tr><td class="sm">${qf(l.qty)} ${esc(l.unit)} × ${n2(l.rate)}</td><td class="r">${n2(l.amount)}</td></tr>`).join('');
  let gstBlock = '';
  if (s.gstin && b.subtotal > 0) {
    const f = b.total / b.subtotal, by = {};
    for (const l of b.lines) {
      const g = +l.gst || 0, gross = l.amount * f, taxable = gross * 100 / (100 + g);
      by[g] = by[g] || { t: 0, tax: 0 }; by[g].t += taxable; by[g].tax += gross - taxable;
    }
    const rows = Object.keys(by).map(Number).sort((a, c) => a - c).map(g =>
      `<tr><td>${g}%</td><td class="r">${n2(by[g].t)}</td><td class="r">${n2(by[g].tax / 2)}</td><td class="r">${n2(by[g].tax / 2)}</td></tr>`).join('');
    gstBlock = `<div class="hr"></div><table class="gst"><tr><th>GST</th><th class="r">Taxable</th><th class="r">CGST</th><th class="r">SGST</th></tr>${rows}</table>`;
  }
  const addr = String(s.shop_address || '').split(/\r?\n/).filter(Boolean).map(esc).join('<br>');
  const foot = String(s.footer || '').split(/\r?\n/).filter(Boolean).map(esc).join('<br>');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:${paper}mm auto;margin:0}
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;background:#fff;color:#000}
    body{width:${paper}mm;padding:2mm ${margin}mm 3mm;font-family:"Segoe UI",Arial,sans-serif;font-size:${fs}px;line-height:1.3;font-weight:500;-webkit-print-color-adjust:exact}
    .c{text-align:center}
    .shop{font-size:${(fs * 1.55).toFixed(1)}px;font-weight:800;line-height:1.15}
    .hr{border-top:1px dashed #000;margin:5px 0}
    .title{font-weight:800;letter-spacing:.08em;font-size:${(fs * .95).toFixed(1)}px}
    table{width:100%;border-collapse:collapse}
    td,th{padding:1px 0;vertical-align:top;text-align:left}
    th{font-weight:700}
    .r{text-align:right;white-space:nowrap}
    .nm{font-weight:700;padding-top:3px}
    .sm{font-size:${(fs * .92).toFixed(1)}px}
    .tot td{font-size:${(fs * 1.45).toFixed(1)}px;font-weight:800;padding-top:3px}
    .gst{font-size:${(fs * .85).toFixed(1)}px}
    .big{font-size:${(fs * 1.3).toFixed(1)}px;font-weight:800}
    .meta td{font-size:${(fs * .92).toFixed(1)}px}
  </style></head><body>
    <div class="c"><div class="shop">${esc(s.shop_name || 'Shop')}</div>
      ${addr ? `<div>${addr}</div>` : ''}
      ${s.shop_phone ? `<div>Ph: ${esc(s.shop_phone)}</div>` : ''}
      ${s.gstin ? `<div>GSTIN: ${esc(s.gstin)}</div>` : ''}
      <div class="hr"></div><div class="title">${opts.title ? esc(opts.title) : (s.gstin ? 'TAX INVOICE' : 'BILL')}${opts.duplicate ? ' (REPRINT)' : ''}</div>
      ${b.cancelled ? '<div class="big">*** CANCELLED ***</div>' : ''}
    </div>
    <table class="meta">
      <tr><td>${opts.title ? 'No' : 'Bill No'}: <b>${esc(b.bill_no)}</b></td><td class="r">${esc(fmtDate(b.created_at))}</td></tr>
      ${b.customer ? `<tr><td colspan="2">Customer: ${esc(b.customer)}${b.phone ? ' · ' + esc(b.phone) : ''}</td></tr>` : ''}
      ${b.mode === 'wholesale' ? '<tr><td colspan="2">Rate: Wholesale</td></tr>' : ''}
    </table>
    <div class="hr"></div>
    <table>${lines}</table>
    <div class="hr"></div>
    <table>
      <tr><td>Items ${b.items_count ?? b.lines.length} · Qty ${qf(b.qty ?? b.lines.reduce((a, l) => a + l.qty, 0))}</td><td class="r">${n2(b.subtotal)}</td></tr>
      ${+b.discount ? `<tr><td>Discount</td><td class="r">-${n2(b.discount)}</td></tr>` : ''}
      <tr class="tot"><td>TOTAL</td><td class="r">₹${n2(b.total)}</td></tr>
      <tr><td colspan="2">${b.payLabel ? esc(b.payLabel) : 'Paid by: ' + esc(PAY[b.payment] || b.payment)}</td></tr>
      ${b.balance != null ? `<tr><td>Udhaar balance now</td><td class="r">₹${n2(b.balance)}</td></tr>` : ''}
    </table>
    ${gstBlock}
    <div class="hr"></div>
    <div class="c">${foot}</div>
  </body></html>`;
}

/* A return printed like a bill: the items that came back and the money given back. */
function returnBill(r, bill) {
  const MODE = { cash: 'Refunded in cash', upi: 'Refunded by UPI', card: 'Refunded to card', account: 'Taken off udhaar account' };
  return {
    bill_no: `${r.return_no} (bill ${r.bill_no})`, created_at: r.created_at, mode: bill ? bill.mode : 'retail', payment: r.refund_mode, payLabel: MODE[r.refund_mode] || r.refund_mode,
    customer: r.customer || (bill && bill.customer) || '', phone: bill ? bill.phone : '', items_count: r.lines.length, qty: r.lines.reduce((a, l) => a + l.qty, 0),
    subtotal: r.total, discount: 0, total: r.total, gst: r.gst, cancelled: 0,
    lines: r.lines.map(l => ({ ...l })),
  };
}
function sampleBill() {
  const now = new Date(), p = n => String(n).padStart(2, '0');
  return {
    bill_no: 'TEST', created_at: `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:00`,
    mode: 'retail', payment: 'cash', customer: '', phone: '', items_count: 2, qty: 3, subtotal: 270, discount: 10, total: 260, gst: 39.66, cancelled: 0,
    lines: [
      { code: 'TEST1', name: 'Metallic balloons, pack of 50', unit: 'pkt', gst: 18, qty: 2, rate: 120, amount: 240 },
      { code: 'TEST2', name: 'Gold number candle', unit: 'pcs', gst: 18, qty: 1, rate: 30, amount: 30 },
    ],
  };
}

function labelSize(s) {
  const num = (v, d) => (v === '' || v == null || !isFinite(+v)) ? d : +v;
  const across = Math.max(1, Math.min(4, parseInt(s.label_across, 10) || 1));
  const w = Math.max(15, num(s.label_w, 50)), h = Math.max(10, num(s.label_h, 25));
  const gap = across > 1 ? Math.max(0, num(s.label_gap, 2)) : 0;
  return { w, h, across, gap, shift: num(s.label_shift, 0), pageW: across * w + (across - 1) * gap };
}
/* The barcode is a picture where every bar is a whole number of printer dots.
   Thermal printers are 203 dpi (8 dots per mm) or 300 dpi. Bars that fall between dots
   print uneven, and scanners reject them. */
function symbology(code) {
  const c = String(code);
  const ok = (d, w1, w2) => { const n = d.split('').map(Number), last = n.pop(); const sum = n.reduce((a, v, i) => a + v * (i % 2 ? w2 : w1), 0); return (10 - sum % 10) % 10 === last; };
  if (/^\d{13}$/.test(c) && ok(c, 1, 3)) return 'ean13';
  if (/^\d{12}$/.test(c) && ok(c, 3, 1)) return 'upca';
  if (/^\d{8}$/.test(c) && ok(c, 3, 1)) return 'ean8';
  return 'code128';
}
async function barcodeImage(code, s) {
  const bwip = require('bwip-js');
  const dpi = String(s.label_dpi) === '300' ? 300 : 203, dpm = dpi / 25.4;
  const { w } = labelSize(s);
  const avail = w - 1.5;
  const quiet = 10;
  const bcid = symbology(code);
  const probe = bwip.toSVG({ bcid, text: String(code), scale: 1, height: 5, includetext: false, paddingwidth: quiet, paddingheight: 0 });
  const modules = +(/viewBox="0 0 (\d+)/.exec(probe) || [])[1] || 120;
  const minDots = dpi === 300 ? 3 : 2;          // narrowest bar most scanners read (about 0.25 mm)
  let dots = parseInt(s.label_bar, 10);
  if (!(dots >= 1)) {
    dots = 1;
    for (let d = 6; d >= 1; d--) if (modules * d / dpm <= avail && d / dpm <= 0.42) { dots = d; break; }
  }
  // bars in module units: [left, width]. Drawn as solid black rectangles (never a resized picture,
  // which some printer drivers turn into grey dots).
  const bars = [];
  for (const m of probe.matchAll(/<path[^>]*stroke-width="([\d.]+)"[^>]*d="([^"]+)"/g)) {
    const bw = +m[1];
    for (const x of m[2].matchAll(/M([\d.]+) /g)) bars.push([Math.round((+x[1] - bw / 2) * 2) / 2, bw]);
  }
  const widthMm = modules * dots / dpm;
  // longest code that would still scan on this label
  const maxModules = Math.floor(avail * dpm / minDots);
  return { bars, dpm, widthMm, moduleMm: dots / dpm, dots, fits: dots >= minDots && widthMm <= w, maxModules, modules };
}

const UNIT_SHORT = { pcs: 'pc', pc: 'pc', piece: 'pc', dozen: 'doz', doz: 'doz', pkt: 'pkt', packet: 'pkt', pack: 'pack' };
const unitShort = u => UNIT_SHORT[String(u || 'pcs').toLowerCase()] || String(u || 'pc');
const plain = n => n2(n).replace(/\.00$/, '');
/* Rates printed on a label: retail as is, wholesale as a code (e.g. NRRL90 = ₹45 wholesale when the multiplier is 2). */
function labelRates(item, s) {
  const retail = s.label_price !== '0' ? { cur: true, amt: plain(item.retail), unit: unitShort(item.unit) } : null;
  let ws = null;
  if (s.label_wcode !== '0' && +item.wholesale > 0) {
    const mult = isFinite(+s.wcode_mult) && +s.wcode_mult > 0 ? +s.wcode_mult : 2;
    ws = { code: (s.wcode_prefix ?? 'NRRL') + plain(+item.wholesale * mult).replace(/,/g, ''), unit: unitShort(item.wholesale_unit || item.unit) };
  }
  return { retail, ws };
}
// biggest font (pt) at which a rate still fits across the label on its own line
const capPt = (wMm, main, unit) => ((wMm - 3.5) * 2.835 / (main * 0.62 + unit * 0.72 * 0.56)).toFixed(1);
/* Rate text size: 100 = normal, up to 250 = two and a half times bigger */
const rateScale = s => { const v = parseInt(s.label_rate_size, 10); return (v >= 70 && v <= 300 ? v : 100) / 100; };
/* The shop logo on a label: a black-and-white picture made when it was added in Settings. */
const logoOn = s => !!(s.label_logo && s.label_show_logo !== '0');
const logoMm = s => { const { h } = labelSize(s); return Math.max(3.5, Math.min(10, h * 0.2)); };
function labelCell(item, s, bc, xMm) {
  const showPrice = s.label_price !== '0';
  if (!item) return `<div class="lab" style="left:${xMm.toFixed(3)}mm"></div>`;
  const { w } = labelSize(s);
  // put the barcode's left edge exactly on a printer dot, counted from the edge of the roll
  const absLeft = Math.round((xMm + (w - bc.widthMm) / 2) * bc.dpm) / bc.dpm;
  const vw = Math.round(bc.widthMm * bc.dpm);
  const rects = bc.bars.map(([x, bw]) => `<rect x="${x * bc.dots}" y="0" width="${bw * bc.dots}" height="100"/>`).join('');
  return `<div class="lab" style="left:${xMm.toFixed(3)}mm">
      ${logoOn(s) ? `<div class="hd"><img class="logo" src="${s.label_logo}" alt=""><div class="nm">${esc(item.name)}</div></div>` : `<div class="nm">${esc(item.name)}</div>`}
      <div class="bc"><svg class="bars" style="left:${(absLeft - xMm).toFixed(4)}mm;width:${bc.widthMm.toFixed(4)}mm" viewBox="0 0 ${vw} 100" preserveAspectRatio="none" shape-rendering="crispEdges" fill="#000">${rects}</svg></div>
      <div class="code">${esc(item.code)}</div>
      ${(() => { const r = labelRates(item, s); return (r.retail || r.ws) ? `<div class="row">${r.retail ? `<span class="pr" style="--cap:${capPt(w, ('₹' + r.retail.amt).length, r.retail.unit.length + 1)}pt">₹${r.retail.amt}<small>/${esc(r.retail.unit)}</small></span>` : '<span></span>'}${r.ws ? `<span class="ws" style="--cap:${capPt(w, r.ws.code.length, r.ws.unit.length + 1)}pt">${esc(r.ws.code)}<small>/${esc(r.ws.unit)}</small></span>` : ''}</div>` : ''; })()}
    </div>`;
}
/* list = one entry per label (item or null for a blank). Each printed page is one row of the roll. */
function labelsHTML(list, s, bcs) {
  const { w, h, across, gap, shift, pageW } = labelSize(s);
  const rows = [];
  for (let i = 0; i < list.length; i += across) rows.push(list.slice(i, i + across));
  const small = h < 22 || w < 40, big = h >= 40 && w >= 60;
  const fz = (sm, md, bg) => small ? sm : big ? bg : md;
  const rs = rateScale(s); // rate text size chosen in Settings / print window
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:${pageW}mm ${h}mm;margin:0}
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;background:#fff;color:#000;font-family:"Segoe UI",Arial,sans-serif}
    .pg{position:relative;width:${pageW}mm;height:${h}mm;overflow:hidden;page-break-after:always;break-after:page}
    .pg:last-child{page-break-after:auto;break-after:auto}
    .lab{position:absolute;top:0;width:${w}mm;height:${h}mm;padding:${fz(.6, 1, 2.5)}mm 0 ${fz(.4, .8, 2)}mm;display:flex;flex-direction:column;justify-content:space-between;overflow:hidden}
    .nm{font-size:${fz(6.5, 8, 13)}pt;font-weight:700;line-height:1.1;max-height:1.15em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 1.5mm}
    .bc{flex:1;min-height:0;position:relative;margin:.4mm 0}
    .hd{display:flex;align-items:center;gap:1mm;padding:0 1.5mm;flex:none}
    .hd .nm{padding:0;flex:1;min-width:0;max-height:2.3em;white-space:normal;line-height:1.1;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
    .logo{height:${logoMm(s).toFixed(2)}mm;width:auto;max-width:45%;object-fit:contain;image-rendering:pixelated;flex:none}
    .bars{position:absolute;top:0;height:100%}
    .row{display:flex;justify-content:space-between;align-items:baseline;gap:0 1mm;padding:0 1.5mm;white-space:nowrap;flex-wrap:wrap;flex:none}
    .row .ws{margin-left:auto}
    .bc{min-height:${rs > 1.2 ? 5 : 4}mm}
    .code{font-size:${fz(5, 6, 9)}pt;font-family:Consolas,monospace;text-align:center;line-height:1.1;white-space:nowrap;overflow:hidden}
    .pr{font-size:min(${(fz(8.5, 11, 18) * rs).toFixed(1)}pt,var(--cap,99pt));font-weight:800;line-height:1}
    .ws{font-size:min(${(fz(7.5, 9.5, 15) * rs).toFixed(1)}pt,var(--cap,99pt));font-weight:800;line-height:1;font-family:"Segoe UI",Arial,sans-serif}
    .pr small,.ws small{font-size:.72em;font-weight:700}
  </style></head><body>${rows.map(r => `<div class="pg">${r.map((it, i) => labelCell(it, s, it && bcs[it.code], shift + i * (w + gap))).join('')}</div>`).join('')}</body></html>`;
}
async function buildLabels(entries, s) {
  const list = [], bcs = {};
  for (const { item, count } of entries) {
    const n = Math.max(0, Math.min(1000, parseInt(count, 10) || 0));
    if (!n) continue;
    if (!bcs[item.code]) bcs[item.code] = await barcodeImage(item.code, s);
    for (let i = 0; i < n; i++) list.push(item);
  }
  if (!list.length) throw new Error('No labels to print.');
  if (list.length > 2000) throw new Error('Print at most 2000 labels at a time.');
  return { html: labelsHTML(list, s, bcs), count: list.length };
}

/* Render HTML in a hidden window and send it straight to a printer, no dialog. */
async function printHTML(html, { deviceName, widthMm, heightMm, copies = 1, exact = false }) {
  const { BrowserWindow } = require('electron');
  const win = new BrowserWindow({ show: false, width: Math.round(widthMm * 96 / 25.4) + 4, height: 800, webPreferences: { sandbox: true } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    let h = heightMm;
    if (!h) {
      const px = await win.webContents.executeJavaScript('Math.ceil(document.body.getBoundingClientRect().height)');
      h = Math.ceil(px * 25.4 / 96) + 4;
    }
    await new Promise((resolve, reject) => {
      win.webContents.print({
        silent: true, printBackground: true, deviceName: deviceName || undefined, copies: Math.max(1, Math.min(5, +copies || 1)),
        margins: { marginType: 'none' }, ...(exact ? { scaleFactor: 100 } : {}), pageSize: { width: Math.round(widthMm * 1000), height: Math.round(Math.max(h, 20) * 1000) },
      }, (ok, why) => ok ? resolve() : reject(new Error(why === 'cancelled' ? 'Printing was cancelled.' : 'Printer did not respond' + (why ? ` (${why})` : '') + '. Check that it is on, connected and has paper.')));
    });
  } finally { if (!win.isDestroyed()) win.destroy(); }
}

async function printReceipt(bill, s, opts) {
  const { paper } = paperOf(s);
  await printHTML(receiptHTML(bill, s, opts), { deviceName: s.printer, widthMm: paper, copies: opts && opts.duplicate ? 1 : s.copies });
}
async function printLabels(entries, s) {
  if (s.label_mode === 'tspl') return printLabelsDirect(entries, s);
  const { pageW, h } = labelSize(s);
  const { html, count } = await buildLabels(entries, s);
  await printHTML(html, { deviceName: s.label_printer || s.printer, widthMm: pageW, heightMm: h, exact: true });
  return count;
}

module.exports = { returnBill, receiptHTML, labelsHTML, buildLabels, barcodeImage, labelSize, sampleBill, printReceipt, printLabels, printHTML };

/* ---------- Direct label printing (TSPL) ----------
   Most barcode label printers (TSC, TVS, Xprinter, Gainscha, iDPRT…) understand TSPL commands.
   Sending commands lets the printer draw each barcode itself at full sharpness, with no
   Windows driver resizing a picture of it. */
function tsplText(t) { return String(t ?? '').replace(/₹/g, 'Rs.').replace(/[^\x20-\x7e]/g, '').replace(/"/g, "'"); }
async function tsplLabels(entries, s) {
  const dpi = String(s.label_dpi) === '300' ? 300 : 203, dpm = dpi / 25.4;
  const { w, h, across, gap, shift, pageW } = labelSize(s);
  const vgap = s.label_vgap === '' || s.label_vgap == null || !isFinite(+s.label_vgap) ? 2 : Math.max(0, +s.label_vgap);
  const D = mm => Math.round(mm * dpm);
  const list = [], bcs = {};
  for (const { item, count } of entries) {
    const n = Math.max(0, Math.min(1000, parseInt(count, 10) || 0));
    if (!n) continue;
    if (!bcs[item.code]) bcs[item.code] = await barcodeImage(item.code, s);
    for (let i = 0; i < n; i++) list.push(item);
  }
  if (!list.length) throw new Error('No labels to print.');
  const TYPE = { ean13: 'EAN13', upca: 'UPCA', ean8: 'EAN8', code128: '128' };
  const out = [
    `SIZE ${pageW.toFixed(1)} mm,${h.toFixed(1)} mm`, `GAP ${vgap} mm,0 mm`, `DIRECTION ${s.label_flip === '1' ? 0 : 1}`,
    'REFERENCE 0,0', 'OFFSET 0 mm', 'SET TEAR ON', `DENSITY ${Math.max(0, Math.min(15, parseInt(s.label_density, 10) || 10))}`, 'SPEED 3',
  ];
  const wD = D(w), hD = D(h), pad = D(1.5);
  const logo = logoOn(s) ? tsplLogo(s, D(logoMm(s)), Math.round(wD * 0.45)) : null;
  for (let r = 0; r < list.length; r += across) {
    out.push('CLS');
    list.slice(r, r + across).forEach((it, i) => {
      const x0 = D(shift + i * (w + gap)), bc = bcs[it.code];
      const kind = symbology(it.code);
      const dataModules = kind === 'code128' ? bc.modules - 20 : ({ ean13: 95, upca: 95, ean8: 67 })[kind];
      const bw = dataModules * bc.dots;
      const nameMax = Math.max(4, Math.floor((wD - 2 * pad) / 12));
      const name = tsplText(it.name).slice(0, nameMax);
      const r = labelRates(it, s);
      const left = r.retail ? `Rs.${r.retail.amt}/${r.retail.unit}`.replace(/,/g, '') : '';
      const right = r.ws ? `${r.ws.code}/${r.ws.unit}` : '';
      // pick the biggest built-in font that fits both rates on one line
      const avail = wD - 2 * pad - 8;
      // printer's built-in fonts, smallest to largest; pick by the rate size chosen, as big as fits
      const FONTS = [{ f: '1', cw: 8, ch: 12 }, { f: '2', cw: 12, ch: 20 }, { f: '3', cw: 16, ch: 24 }, { f: '4', cw: 24, ch: 32 }, { f: '5', cw: 32, ch: 48 }];
      const wantH = 20 * rateScale(s) * (dpi === 300 ? 1.5 : 1);
      const fit = n => FONTS.filter(x => x.ch <= Math.max(12, wantH) && n * x.cw <= wD - 2 * pad);
      let font = fit(left.length + right.length + 1).pop(), twoLines = false;
      const one = fit(Math.max(left.length, right.length)).pop() || FONTS[0];
      if (!font || one.ch > font.ch) { font = one; twoLines = !!(left && right); }
      const topY = D(1), nameH = 20;
      const rateY = hD - D(0.8) - font.ch, codeY = (twoLines ? rateY - font.ch - 2 : rateY) - 2 - 12;
      const bcY = topY + (logo ? Math.max(nameH, logo.h) : nameH) + D(0.6), bcH = Math.max(D(5), codeY - D(0.4) - bcY);
      let nameX = x0 + pad, headH = nameH;
      if (logo) {
        out.push(`BITMAP ${x0 + pad},${topY},${logo.wb},${logo.h},0,` + logo.data);
        nameX += logo.w + D(1); headH = Math.max(nameH, logo.h);
      }
      out.push(`TEXT ${nameX},${topY + Math.max(0, Math.round((headH - nameH) / 2))},"2",0,1,1,"${name.slice(0, Math.max(3, Math.floor((x0 + wD - pad - nameX) / 12)))}"`);
      out.push(`BARCODE ${x0 + Math.max(0, Math.round((wD - bw) / 2))},${bcY},"${TYPE[kind]}",${bcH},0,0,${bc.dots},${bc.dots},"${tsplText(it.code)}"`);
      const codeTxt = tsplText(it.code).slice(0, Math.floor((wD - 2 * pad) / 8));
      out.push(`TEXT ${x0 + Math.round((wD - codeTxt.length * 8) / 2)},${codeY},"1",0,1,1,"${codeTxt}"`);
      if (left) out.push(`TEXT ${x0 + pad},${twoLines ? rateY - font.ch - 2 : rateY},"${font.f}",0,1,1,"${left}"`);
      if (right) out.push(`TEXT ${x0 + wD - pad - right.length * font.cw},${rateY},"${font.f}",0,1,1,"${right}"`);
    });
    out.push('PRINT 1,1');
  }
  return { data: out.join('\r\n') + '\r\n', count: list.length };
}
/* Logo for TSPL: scale the stored black-and-white picture to printer dots.
   TSPL bitmaps print a dot where the bit is 0, so black pixels become 0 bits. */
function tsplLogo(s, hDots, maxW) {
  let b; try { b = JSON.parse(s.label_logo_bits || ''); } catch (e) { return null; }
  if (!b || !b.w || !b.h || !b.data) return null;
  const src = Buffer.from(b.data, 'base64'), srcWb = Math.ceil(b.w / 8);
  let h = Math.max(8, hDots), w = Math.max(8, Math.round(b.w * h / b.h));
  if (w > maxW) { w = maxW; h = Math.max(8, Math.round(b.h * w / b.w)); }
  const wb = Math.ceil(w / 8), out = Buffer.alloc(wb * h, 0xff);
  const invert = s.label_logo_invert === '1';
  for (let y = 0; y < h; y++) {
    const sy = Math.min(b.h - 1, Math.floor(y * b.h / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(b.w - 1, Math.floor(x * b.w / w));
      let black = (src[sy * srcWb + (sx >> 3)] >> (7 - (sx & 7))) & 1;
      if (invert) black ^= 1;
      if (black) out[y * wb + (x >> 3)] &= ~(0x80 >> (x & 7));
    }
  }
  return { w, h, wb, data: out.toString('latin1') };
}
/* Send bytes straight to a Windows printer queue (RAW), using the Windows print spooler. */
function sendRaw(printerName, text) {
  const { execFile } = require('child_process');
  const fs = require('fs'), os = require('os'), path = require('path');
  if (!printerName) return Promise.reject(new Error('Choose the label printer in Settings first.'));
  const file = path.join(os.tmpdir(), `nrrl-labels-${Date.now()}.prn`);
  fs.writeFileSync(file, Buffer.from(text, 'latin1'));
  const ps = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class NrrlRaw {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", EntryPoint="OpenPrinterW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint="StartDocPrinterW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, byte[] b, int c, out int w);
  public static void Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("Cannot open printer '" + printer + "' (Windows error " + Marshal.GetLastWin32Error() + ")");
    try {
      DOCINFO di = new DOCINFO(); di.pDocName = "NRRL labels"; di.pDataType = "RAW";
      if (StartDocPrinter(h, 1, di) == 0) throw new Exception("Printer would not start the job (Windows error " + Marshal.GetLastWin32Error() + ")");
      StartPagePrinter(h);
      int written;
      if (!WritePrinter(h, data, data.Length, out written)) throw new Exception("Could not send to printer (Windows error " + Marshal.GetLastWin32Error() + ")");
      EndPagePrinter(h); EndDocPrinter(h);
    } finally { ClosePrinter(h); }
  }
}
"@
[NrrlRaw]::Send($env:NRRL_PRINTER, [System.IO.File]::ReadAllBytes($env:NRRL_FILE))`;
  const enc = Buffer.from(ps, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
      { env: { ...process.env, NRRL_PRINTER: printerName, NRRL_FILE: file }, windowsHide: true, timeout: 30000 },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(file); } catch (e) {}
        if (err) {
          const msg = String(stderr || err.message).split(/\r?\n/).find(l => /Cannot open|would not|Could not|Exception/.test(l)) || 'The label printer did not accept the job.';
          reject(new Error(msg.replace(/^.*?:\s*"?/, '').replace(/"\s*$/, '').trim()));
        } else resolve();
      });
  });
}
async function printLabelsDirect(entries, s) {
  const { data, count } = await tsplLabels(entries, s);
  await sendRaw(s.label_printer || s.printer, data);
  return count;
}
module.exports.tsplLabels = tsplLabels;
module.exports.printLabelsDirect = printLabelsDirect;

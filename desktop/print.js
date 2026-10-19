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
      <div class="hr"></div><div class="title">${s.gstin ? 'TAX INVOICE' : 'BILL'}${opts.duplicate ? ' (REPRINT)' : ''}</div>
      ${b.cancelled ? '<div class="big">*** CANCELLED ***</div>' : ''}
    </div>
    <table class="meta">
      <tr><td>Bill No: <b>${esc(b.bill_no)}</b></td><td class="r">${esc(fmtDate(b.created_at))}</td></tr>
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
      <tr><td colspan="2">Paid by: ${esc(PAY[b.payment] || b.payment)}</td></tr>
    </table>
    ${gstBlock}
    <div class="hr"></div>
    <div class="c">${foot}</div>
  </body></html>`;
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
  const png = await bwip.toBuffer({ bcid, text: String(code), scale: dots, height: 8, includetext: false, paddingwidth: quiet, paddingheight: 0 });
  const widthMm = modules * dots / dpm;
  // longest code that would still scan on this label
  const maxModules = Math.floor(avail * dpm / minDots);
  return { src: 'data:image/png;base64,' + png.toString('base64'), widthMm, moduleMm: dots / dpm, dots, fits: dots >= minDots && widthMm <= w, maxModules, modules };
}

function labelCell(item, s, bc) {
  const showPrice = s.label_price !== '0';
  if (!item) return '<div class="lab"></div>';
  return `<div class="lab">
      <div class="nm">${esc(item.name)}</div>
      <div class="bc"><img src="${bc.src}" style="width:${bc.widthMm.toFixed(3)}mm" alt=""></div>
      <div class="row"><span class="code">${esc(item.code)}</span>${showPrice ? `<span class="pr">₹${n2(item.retail).replace(/\.00$/, '')}</span>` : ''}</div>
    </div>`;
}
/* list = one entry per label (item or null for a blank). Each printed page is one row of the roll. */
function labelsHTML(list, s, bcs) {
  const { w, h, across, gap, shift, pageW } = labelSize(s);
  const rows = [];
  for (let i = 0; i < list.length; i += across) rows.push(list.slice(i, i + across));
  const small = h < 22 || w < 40;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:${pageW}mm ${h}mm;margin:0}
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;background:#fff;color:#000;font-family:"Segoe UI",Arial,sans-serif}
    .pg{width:${pageW}mm;height:${h}mm;display:flex;gap:${gap}mm;overflow:hidden;page-break-after:always;break-after:page}
    .pg:last-child{page-break-after:auto;break-after:auto}
    .in{display:flex;gap:${gap}mm;transform:translateX(${shift}mm)}
    .lab{width:${w}mm;height:${h}mm;flex:none;padding:${small ? .6 : 1}mm 0 ${small ? .4 : .8}mm;display:flex;flex-direction:column;justify-content:space-between;overflow:hidden}
    .nm{font-size:${small ? 6.5 : 8}pt;font-weight:700;line-height:1.1;max-height:1.15em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 1.5mm}
    .bc{flex:1;min-height:0;display:flex;justify-content:center;align-items:stretch;padding:.4mm 0}
    .bc img{height:100%;max-width:none;image-rendering:pixelated;image-rendering:crisp-edges}
    .row{display:flex;justify-content:space-between;align-items:baseline;gap:1mm;padding:0 1.5mm;white-space:nowrap}
    .code{font-size:${small ? 5.5 : 6.5}pt;font-family:Consolas,monospace;overflow:hidden;text-overflow:ellipsis}
    .pr{font-size:${small ? 8.5 : 11}pt;font-weight:800}
  </style></head><body>${rows.map(r => `<div class="pg"><div class="in">${r.map(it => labelCell(it, s, it && bcs[it.code])).join('')}${'<div class="lab"></div>'.repeat(across - r.length)}</div></div>`).join('')}</body></html>`;
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
  const { pageW, h } = labelSize(s);
  const { html, count } = await buildLabels(entries, s);
  await printHTML(html, { deviceName: s.label_printer || s.printer, widthMm: pageW, heightMm: h, exact: true });
  return count;
}

module.exports = { receiptHTML, labelsHTML, buildLabels, barcodeImage, labelSize, sampleBill, printReceipt, printLabels, printHTML };

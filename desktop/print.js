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

function labelsHTML(item, count, s, svg) {
  const w = Math.max(20, +s.label_w || 50), h = Math.max(15, +s.label_h || 25);
  const showPrice = s.label_price !== '0';
  const one = `<div class="lab">
      <div class="nm">${esc(item.name)}</div>
      <div class="bc">${svg}</div>
      <div class="row"><span class="code">${esc(item.code)}</span>${showPrice ? `<span class="pr">₹${n2(item.retail).replace(/\.00$/, '')}</span>` : ''}</div>
    </div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:${w}mm ${h}mm;margin:0}
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;background:#fff;color:#000;font-family:"Segoe UI",Arial,sans-serif}
    .lab{width:${w}mm;height:${h}mm;padding:1.2mm 2mm 1mm;display:flex;flex-direction:column;justify-content:space-between;overflow:hidden;page-break-after:always;break-after:page}
    .lab:last-child{page-break-after:auto;break-after:auto}
    .nm{font-size:${h < 22 ? 7 : 8}pt;font-weight:700;line-height:1.1;max-height:2.2em;overflow:hidden}
    .bc{flex:1;min-height:0;display:flex;align-items:stretch;padding:.6mm 0}
    .bc svg{width:100%;height:100%}
    .row{display:flex;justify-content:space-between;align-items:baseline;gap:2mm}
    .code{font-size:6.5pt;font-family:Consolas,monospace;letter-spacing:.04em}
    .pr{font-size:${h < 22 ? 9 : 11}pt;font-weight:800}
  </style></head><body>${Array.from({ length: count }, () => one).join('')}</body></html>`;
}

function barcodeSVG(code) {
  const bwip = require('bwip-js');
  const svg = bwip.toSVG({ bcid: 'code128', text: String(code), scale: 2, height: 10, includetext: false, paddingwidth: 8, paddingheight: 0 });
  // stretch bars to fill the label area
  return svg.replace('<svg ', '<svg preserveAspectRatio="none" ');
}

/* Render HTML in a hidden window and send it straight to a printer, no dialog. */
async function printHTML(html, { deviceName, widthMm, heightMm, copies = 1 }) {
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
        margins: { marginType: 'none' }, pageSize: { width: Math.round(widthMm * 1000), height: Math.round(Math.max(h, 20) * 1000) },
      }, (ok, why) => ok ? resolve() : reject(new Error(why === 'cancelled' ? 'Printing was cancelled.' : 'Printer did not respond' + (why ? ` (${why})` : '') + '. Check that it is on, connected and has paper.')));
    });
  } finally { if (!win.isDestroyed()) win.destroy(); }
}

async function printReceipt(bill, s, opts) {
  const { paper } = paperOf(s);
  await printHTML(receiptHTML(bill, s, opts), { deviceName: s.printer, widthMm: paper, copies: opts && opts.duplicate ? 1 : s.copies });
}
async function printLabels(item, count, s) {
  count = Math.max(1, Math.min(500, parseInt(count, 10) || 1));
  const w = Math.max(20, +s.label_w || 50), h = Math.max(15, +s.label_h || 25);
  await printHTML(labelsHTML(item, count, s, barcodeSVG(item.code)), { deviceName: s.label_printer || s.printer, widthMm: w, heightMm: h });
}

module.exports = { receiptHTML, labelsHTML, barcodeSVG, sampleBill, printReceipt, printLabels, printHTML };

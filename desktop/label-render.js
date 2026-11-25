// NRRL Billing — draws barcode labels from the shared layouts (label-layouts.js):
//   svgLabels  → an HTML page of SVG labels, printed through the Windows driver
//   tsplLabels → printer commands for TSPL label printers (direct mode)
// Everything is placed in printer dots, so bars always fall exactly on the print head's dots.
'use strict';
const LL = (() => { try { return require('./label-layouts'); } catch (e) { return require('../label-layouts'); } })();

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v, d) => (v === '' || v == null || !isFinite(+v)) ? d : +v;

function sizeOf(s) {
  const across = Math.max(1, Math.min(4, parseInt(s.label_across, 10) || 1));
  const w = Math.max(15, num(s.label_w, 50)), h = Math.max(10, num(s.label_h, 25));
  const gap = across > 1 ? Math.max(0, num(s.label_gap, 2)) : 0;
  const dpi = String(s.label_dpi) === '300' ? 300 : 203;
  return { w, h, across, gap, shift: num(s.label_shift, 0), pageW: across * w + (across - 1) * gap, dpi, dpm: dpi / 25.4 };
}
function symbology(code) {
  const c = String(code);
  const ok = (d, w1, w2) => { const n = d.split('').map(Number), last = n.pop(); const sum = n.reduce((a, v, i) => a + v * (i % 2 ? w2 : w1), 0); return (10 - sum % 10) % 10 === last; };
  if (/^\d{13}$/.test(c) && ok(c, 1, 3)) return 'ean13';
  if (/^\d{12}$/.test(c) && ok(c, 3, 1)) return 'upca';
  if (/^\d{8}$/.test(c) && ok(c, 3, 1)) return 'ean8';
  return 'code128';
}
// bars of a code in module units: [[left, width], …] and the total number of modules (no quiet zone)
const barCache = new Map();
function bars(code) {
  code = String(code);
  if (barCache.has(code)) return barCache.get(code);
  const bwip = require('bwip-js');
  const kind = symbology(code);
  const svg = bwip.toSVG({ bcid: kind, text: code, scale: 1, height: 5, includetext: false, paddingwidth: 0, paddingheight: 0 });
  const modules = +(/viewBox="0 0 (\d+)/.exec(svg) || [])[1] || 100;
  const list = [];
  for (const m of svg.matchAll(/<path[^>]*stroke-width="([\d.]+)"[^>]*d="([^"]+)"/g)) {
    const bw = +m[1];
    for (const x of m[2].matchAll(/M([\d.]+) /g)) list.push([Math.round((+x[1] - bw / 2) * 2) / 2, bw]);
  }
  const r = { kind, modules, bars: list };
  barCache.set(code, r);
  return r;
}
// the widest whole-dot bar width that fits, never thinner than scanners read (about 0.25 mm)
function barcodeFit(code, maxW, maxH, sz, s) {
  const b = bars(code);
  const minD = sz.dpi === 300 ? 3 : 2, maxD = Math.max(minD, Math.floor(0.42 * sz.dpm));
  const forced = parseInt(s.label_bar, 10);
  let d = 0;
  for (let k = maxD; k >= minD; k--) if ((b.modules + 8) * k <= maxW) { d = k; break; }
  if (forced >= 1 && (b.modules + 8) * forced <= maxW) d = forced;
  if (!d || maxH < 4 * sz.dpm) return null;
  return { w: b.modules * d, d, ...b };
}
function logoFit(s, maxW, maxH) {
  if (!s.label_logo || s.label_show_logo === '0') return null;
  let b; try { b = JSON.parse(s.label_logo_bits || ''); } catch (e) { b = null; }
  const aspect = b && b.w && b.h ? b.w / b.h : 2;
  let h = Math.round(maxH), w = Math.round(h * aspect);
  if (w > maxW) { w = Math.round(maxW); h = Math.round(w / aspect); }
  return w > 4 && h > 4 ? { w, h } : null;
}
function opts(s, sz) {
  return {
    wD: Math.round(sz.w * sz.dpm), hD: Math.round(sz.h * sz.dpm), dpm: sz.dpm,
    layout: /^[A-H]$/.test(s.label_layout || '') ? s.label_layout : 'A', emph: s.label_style || 'both',
    rateScale: LL.rateSize(parseInt(s.label_rate_size, 10) || 100).v / 100,
    showRetail: s.label_price !== '0', showWholesale: s.label_wcode !== '0',
    prefix: s.wcode_prefix ?? 'NRRL', mult: s.wcode_mult, shop: s.label_shop || 'NRRL',
    logo: !!(s.label_logo && s.label_show_logo !== '0'),
  };
}
function expand(entries) {
  const list = [];
  for (const { item, count } of entries) {
    const n = Math.max(0, Math.min(1000, parseInt(count, 10) || 0));
    for (let i = 0; i < n; i++) list.push(item);
  }
  if (!list.length) throw new Error('No labels to print.');
  if (list.length > 2000) throw new Error('Print at most 2000 labels at a time.');
  return list;
}

/* ---------- SVG (printed through the Windows driver) ---------- */
// widths of bold sans-serif letters at font size 1; textLength then makes the printed width exactly this
const W_BOLD = c => /[MW@]/.test(c) ? 0.86 : /[A-Z]/.test(c) ? 0.68 : /[0-9]/.test(c) ? 0.58 : c === '₹' ? 0.6 : /[mw]/.test(c) ? 0.82 : /[ijlf.,:;'!|]/.test(c) ? 0.28 : /[rt]/.test(c) ? 0.38 : c === ' ' ? 0.27 : c === '/' ? 0.36 : c === '…' ? 0.8 : /[a-z]/.test(c) ? 0.56 : 0.5;
const svgWidth = (t, k, style) => [...String(t)].reduce((a, c) => a + (style && style.mono ? 0.6 : W_BOLD(c)), 0) * k;
function svgBackend(s, sz) {
  return {
    fit: LL.smoothFit(svgWidth),
    barcode: (code, maxW, maxH) => barcodeFit(code, maxW, maxH, sz, s),
    logo: (maxW, maxH) => logoFit(s, maxW, maxH),
  };
}
function svgOne(item, s, sz) {
  const o = opts(s, sz), be = svgBackend(s, sz);
  const els = LL.layout(item, o, be).map(e => {
    if (e.kind === 'text') {
      const f = e.fit, fill = e.color === 'white' ? '#fff' : '#000';
      const fam = f.style.mono ? 'Consolas,&quot;Courier New&quot;,monospace' : '&quot;Segoe UI&quot;,Arial,sans-serif';
      const tspans = f.parts.map(p => `<tspan font-size="${p.size.toFixed(2)}">${esc(p.t)}</tspan>`).join('');
      return `<text x="${e.x}" y="${(e.y + f.base).toFixed(2)}" font-family="${fam}" font-weight="${f.style.mono ? 700 : 800}" fill="${fill}" textLength="${f.w.toFixed(2)}" lengthAdjust="spacingAndGlyphs">${tspans}</text>`;
    }
    if (e.kind === 'barcode') return e.item.bars.map(([x, w]) => `<rect x="${e.x + Math.round(x * e.item.d)}" y="${e.y}" width="${Math.round(w * e.item.d)}" height="${e.h}"/>`).join('');
    if (e.kind === 'line') return `<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}"/>`;
    if (e.kind === 'rect') return e.fill ? `<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" rx="${e.r || 0}"/>`
      : `<rect x="${e.x + e.stroke / 2}" y="${e.y + e.stroke / 2}" width="${e.w - e.stroke}" height="${e.h - e.stroke}" rx="${e.r || 0}" fill="none" stroke="#000" stroke-width="${e.stroke}"/>`;
    if (e.kind === 'logo') return `<image href="${esc(s.label_logo)}" x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" preserveAspectRatio="xMinYMid meet" style="image-rendering:pixelated"/>`;
    return '';
  }).join('');
  return { svg: els, wD: o.wD, hD: o.hD };
}
function svgLabels(entries, s) {
  const sz = sizeOf(s), list = expand(entries);
  const rows = [];
  for (let i = 0; i < list.length; i += sz.across) rows.push(list.slice(i, i + sz.across));
  const cache = new Map();
  const one = it => { if (!cache.has(it.code)) cache.set(it.code, svgOne(it, s, sz)); return cache.get(it.code); };
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:${sz.pageW}mm ${sz.h}mm;margin:0}
    html,body{margin:0;padding:0;background:#fff}
    .pg{position:relative;width:${sz.pageW}mm;height:${sz.h}mm;overflow:hidden;page-break-after:always;break-after:page}
    .pg:last-child{page-break-after:auto;break-after:auto}
    .pg svg{position:absolute;top:0}
  </style></head><body>${rows.map(r => `<div class="pg">${r.map((it, i) => {
      const L = one(it);
      // each label starts on a whole printer dot, counted from the edge of the roll
      const left = Math.round((sz.shift + i * (sz.w + sz.gap)) * sz.dpm) / sz.dpm;
      return `<svg style="left:${left.toFixed(4)}mm;width:${(L.wD / sz.dpm).toFixed(4)}mm;height:${(L.hD / sz.dpm).toFixed(4)}mm" viewBox="0 0 ${L.wD} ${L.hD}" shape-rendering="crispEdges" fill="#000" xmlns="http://www.w3.org/2000/svg">${L.svg}</svg>`;
    }).join('')}</div>`).join('')}</body></html>`;
  return { html, count: list.length };
}

/* ---------- TSPL (direct to the label printer) ---------- */
// the printer's own fonts (cell width × height in dots). TSPL can enlarge them up to ×10, width and height
// separately, so a rate can be made taller with narrower letters (condensed) when the label is narrow.
const BASE = [{ f: '1', cw: 8, ch: 12 }, { f: '2', cw: 12, ch: 20 }, { f: '3', cw: 16, ch: 24 }, { f: '4', cw: 24, ch: 32 }, { f: '5', cw: 32, ch: 48 }];
const FONTS = [];
for (const b of BASE) for (let my = 1; my <= 6; my++) for (let mx = Math.max(1, Math.ceil(my * 0.5)); mx <= my; mx++)
  FONTS.push({ f: b.f, mx, my, cw: b.cw * mx, ch: b.ch * my, q: mx / my });
FONTS.sort((a, b) => b.ch - a.ch || b.q - a.q || b.cw - a.cw);
const ascii = t => String(t ?? '').replace(/₹/g, 'Rs.').replace(/…/g, '..').replace(/[^\x20-\x7e]/g, '').replace(/"/g, "'");
function tsplFit(runs, maxW, maxH, style) {
  runs = runs.map(([t, k]) => [ascii(t), k]);
  const sq = Math.max(0.5, Math.min(1, +(style && style.squeeze) || 1));
  const ok = FONTS.filter(f => f.q >= sq - 1e-9);
  const smallFor = (h, q) => ok.find(g => g.ch <= h && g.q >= q - 1e-9) || ok.find(g => g.ch <= h) || FONTS[FONTS.length - 1];
  // tallest first; at the same height the widest letters (least condensed) first
  for (const main of ok) {
    if (main.ch > maxH) continue;
    let x = 0;
    const parts = runs.map(([t, k]) => {
      const f = k >= 1 ? main : smallFor(main.ch * Math.max(k + 0.05, 0.55), main.q);
      const p = { t, font: f, x, dy: main.ch - f.ch }; x += t.length * f.cw; return p;
    });
    if (x <= maxW) return { w: x, h: main.ch, base: main.ch, parts, style: style || {} };
  }
  const f = FONTS[FONTS.length - 1];
  let x = 0;
  return { w: runs.reduce((a, [t]) => a + t.length * f.cw, 0), h: f.ch, base: f.ch, parts: runs.map(([t]) => { const p = { t, font: f, x, dy: 0 }; x += t.length * f.cw; return p; }), style: style || {} };
}
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
const TYPE = { ean13: 'EAN13', upca: 'UPCA', ean8: 'EAN8', code128: '128' };
function tsplLabels(entries, s) {
  const sz = sizeOf(s), list = expand(entries), o = opts(s, sz);
  const vgap = s.label_vgap === '' || s.label_vgap == null || !isFinite(+s.label_vgap) ? 2 : Math.max(0, +s.label_vgap);
  const be = {
    fit: (runs, maxW, maxH, style) => tsplFit(runs, maxW, maxH, style),
    barcode: (code, maxW, maxH) => barcodeFit(code, maxW, maxH, sz, s),
    logo: (maxW, maxH) => { const l = tsplLogo(s, Math.round(maxH), Math.round(maxW)); return l ? { w: l.w, h: l.h, bmp: l } : null; },
  };
  const out = [
    `SIZE ${sz.pageW.toFixed(1)} mm,${sz.h.toFixed(1)} mm`, `GAP ${vgap} mm,0 mm`, `DIRECTION ${s.label_flip === '1' ? 0 : 1}`,
    'REFERENCE 0,0', 'OFFSET 0 mm', 'SET TEAR ON', `DENSITY ${Math.max(0, Math.min(15, parseInt(s.label_density, 10) || 10))}`, 'SPEED 3',
  ];
  const cache = new Map();
  const cmds = it => {
    if (cache.has(it.code)) return cache.get(it.code);
    const els = LL.layout(it, o, be), first = [], texts = [], last = [];
    for (const e of els) {
      if (e.kind === 'rect') {
        if (!e.fill) first.push(`BOX ${e.x},${e.y},${e.x + e.w - 1},${e.y + e.h - 1},${e.stroke}`);
        else if (els.some(t => t.kind === 'text' && t.color === 'white' && t.x >= e.x && t.y >= e.y && t.x < e.x + e.w && t.y < e.y + e.h)) last.push({ rev: [e.x, e.y, e.w, e.h] });
        else first.push(`BAR ${e.x},${e.y},${e.w},${e.h}`);
      } else if (e.kind === 'line') first.push(`BAR ${e.x},${e.y},${e.w},${e.h}`);
      else if (e.kind === 'barcode') first.push({ bc: e });
      else if (e.kind === 'logo') first.push({ logo: e });
      else if (e.kind === 'text') for (const p of e.fit.parts) texts.push({ x: e.x + p.x, y: e.y + p.dy, p });
    }
    cache.set(it.code, { first, texts, last });
    return cache.get(it.code);
  };
  for (let r = 0; r < list.length; r += sz.across) {
    out.push('CLS');
    list.slice(r, r + sz.across).forEach((it, i) => {
      const x0 = Math.round((sz.shift + i * (sz.w + sz.gap)) * sz.dpm), c = cmds(it);
      for (const f of c.first) {
        if (typeof f === 'string') out.push(f.replace(/^(BAR|BOX) (\d+),(\d+),(\d+),(\d+)/, (m, k, x, y, a, b) => k === 'BOX' ? `BOX ${+x + x0},${y},${+a + x0},${b}` : `BAR ${+x + x0},${y},${a},${b}`));
        else if (f.bc) out.push(`BARCODE ${f.bc.x + x0},${f.bc.y},"${TYPE[f.bc.item.kind]}",${f.bc.h},0,0,${f.bc.item.d},${f.bc.item.d},"${ascii(it.code)}"`);
        else if (f.logo) out.push(`BITMAP ${f.logo.x + x0},${f.logo.y},${f.logo.item.bmp.wb},${f.logo.item.bmp.h},0,` + f.logo.item.bmp.data);
      }
      for (const t of c.texts) out.push(`TEXT ${t.x + x0},${t.y},"${t.p.font.f}",0,${t.p.font.mx},${t.p.font.my},"${t.p.t}"`);
      for (const l of c.last) out.push(`REVERSE ${l.rev[0] + x0},${l.rev[1]},${l.rev[2]},${l.rev[3]}`);
    });
    out.push('PRINT 1,1');
  }
  return { data: out.join('\r\n') + '\r\n', count: list.length };
}

// one label as a standalone SVG picture (the design pictures in the print window)
function svgLabel(item, s) {
  const sz = sizeOf(s), L = svgOne(item, s, sz);
  return `<svg viewBox="0 0 ${L.wD} ${L.hD}" width="${L.wD}" height="${L.hD}" fill="#000" xmlns="http://www.w3.org/2000/svg"><rect width="${L.wD}" height="${L.hD}" fill="#fff"/>${L.svg}</svg>`;
}

module.exports = { svgLabels, svgLabel, tsplLabels, sizeOf, bars, LL, _svgBackend: (s, sz) => svgBackend(s, sz), _opts: (s, sz) => opts(s, sz) };

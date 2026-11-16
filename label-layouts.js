/* NRRL — barcode label layouts, shared by the laptop app (normal and direct printing) and the phone app.
   The engine decides where everything goes, in printer dots; a "backend" measures text, draws barcodes
   and turns the result into SVG, printer commands (TSPL) or a canvas picture.

   Rules (from the owner):
   1. Retail and wholesale rates must both be big and readable.
   2. A retail customer must not get any idea of the wholesale rate: it is only ever printed as a code
      (prefix + wholesale rate × multiplier, e.g. NRRL300 for ₹150) or, in layout G, as a "batch number". */
(function (root) {
  'use strict';

  const LAYOUTS = [
    ['A', 'Two lines, full width'], ['B', 'Two columns'], ['C', 'Black price strip'], ['D', 'Price on top'],
    ['E', 'Boxed rates'], ['F', 'Barcode left, rates right'], ['G', 'Code looks like a batch number'], ['H', 'Shop name band'],
  ];
  const EMPHASIS = [['both', 'Both equal'], ['retail', 'Retail bigger'], ['wholesale', 'Wholesale bigger']];

  const UNIT_SHORT = { pcs: 'pc', pc: 'pc', piece: 'pc', pieces: 'pc', dozen: 'doz', doz: 'doz', pkt: 'pkt', packet: 'pkt', pack: 'pack', box: 'box', set: 'set', roll: 'roll', mtr: 'mtr', kg: 'kg' };
  const unitShort = u => UNIT_SHORT[String(u || 'pcs').toLowerCase()] || String(u || 'pc');
  const plain = n => { const v = Math.round((+n || 0) * 100) / 100; return (v % 1 ? v.toFixed(2) : String(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };

  /* What the label says. o: { showRetail, showWholesale, prefix, mult } */
  function rates(item, o) {
    const r = o.showRetail !== false && +item.retail > 0 ? { k: 'r', main: '₹' + plain(item.retail), unit: '/' + unitShort(item.unit) } : null;
    let w = null, batch = '';
    if (o.showWholesale !== false && +item.wholesale > 0) {
      const mult = isFinite(+o.mult) && +o.mult > 0 ? +o.mult : 2;
      const val = plain(+item.wholesale * mult).replace(/,/g, '');
      const wu = unitShort(item.wholesale_unit || item.unit);
      w = { k: 'w', main: (o.prefix == null ? 'NRRL' : String(o.prefix)) + val, unit: '/' + wu };
      batch = 'B/' + val + '-' + wu.slice(0, 1).toUpperCase(); // layout G: looks like a stock/batch number
    }
    return { r, w, batch };
  }
  const runsOf = x => [[x.main, 1], [x.unit, 0.62]];

  /* Text fitting for backends whose fonts scale smoothly (SVG, canvas).
     width(text, size, style) gives the width in dots at font size `size` (dots). */
  function smoothFit(width) {
    return function fit(runs, maxW, maxH, style) {
      const w1 = runs.reduce((a, [t, k]) => a + width(t, k, style), 0); // width at font size 1
      const asc = style && style.mono ? 0.78 : 0.76;
      let size = Math.min(maxH / 0.98, maxW / Math.max(w1, 0.001));
      size = Math.max(size, 1);
      let x = 0;
      const parts = runs.map(([t, k]) => { const p = { t, size: size * k, x }; x += width(t, k, style) * size; return p; });
      return { w: x, h: size * 0.98, base: size * asc, size, parts, style: style || {} };
    };
  }

  /* --- the layouts ---
     L = { wD, hD, dpm, layout, emph, rateScale, showRetail, showWholesale, prefix, mult, shop, logo }
     be = backend: fit(runs, maxW, maxH, style), barcode(code, maxW, maxH) → {w,h} | null, logo(maxW, maxH) → {w,h} | null */
  function layout(item, L, be) {
    const out = [], W = L.wD, H = L.hD, mm = v => Math.round(v * L.dpm);
    const pad = mm(1.3), gap = mm(1), avW = W - 2 * pad;
    const rs = Math.max(0.7, Math.min(2.5, +L.rateScale || 1));
    const R = rates(item, L);
    const emph = L.emph === 'retail' || L.emph === 'wholesale' ? L.emph : 'both';
    let list = [R.r, R.w].filter(Boolean);
    if (emph === 'wholesale') list = [R.w, R.r].filter(Boolean);
    const ratio = emph === 'both' ? 1 : 0.8;
    const text = (fit, x, y, extra) => { out.push({ kind: 'text', x: Math.round(x), y: Math.round(y), fit, ...(extra || {}) }); return fit; };

    // the item name across the top (with the logo in front of it when there is one)
    function nameRow(y, x0, x1, color) {
      const hN = Math.max(mm(2.2), Math.min(mm(6), H * 0.13));
      let x = x0;
      if (L.logo && be.logo && !color) {
        const lg = be.logo(Math.round((x1 - x0) * 0.4), hN);
        if (lg) { out.push({ kind: 'logo', x, y, w: lg.w, h: lg.h, item: lg }); x += lg.w + gap; }
      }
      const f = fitName(item.name, x1 - x, hN, { bold: true });
      text(f, x, y + Math.max(0, (hN - f.h) / 2), color ? { color } : null);
      return hN;
    }
    // shrink a long name down to 70%, then cut it with "…"
    function fitName(name, maxW, maxH, style) {
      name = String(name || '');
      let f = be.fit([[name, 1]], maxW, maxH, style);
      if (f.h >= maxH * 0.7 || name.length < 4) return f;
      let n = name;
      while (n.length > 3) { n = n.slice(0, -1); f = be.fit([[n.replace(/\s+$/, '') + '…', 1]], maxW, maxH, style); if (f.h >= maxH * 0.7) break; }
      return f;
    }
    function codeText(code, y, x0, x1, align) {
      const f = be.fit([[code, 1]], x1 - x0, Math.max(mm(1.5), Math.min(mm(3.2), H * 0.085)), { mono: true });
      const x = align === 'left' ? x0 : align === 'right' ? x1 - f.w : x0 + (x1 - x0 - f.w) / 2;
      text(f, x, y, null);
      return f.h;
    }
    function barcodeIn(x0, y0, x1, y1) {
      const b = be.barcode(item.code, x1 - x0, y1 - y0);
      if (!b) return null;
      out.push({ kind: 'barcode', x: Math.round(x0 + (x1 - x0 - b.w) / 2), y: Math.round(y0), w: b.w, h: Math.round(y1 - y0), item: b });
      return b;
    }
    // two rates on one line, as big as possible; null if they would be too small that way
    function sideBySide(maxH, width, minFrac) {
      if (list.length < 2) return null;
      let lo = maxH * minFrac, hi = maxH, best = null;
      for (let i = 0; i < 18; i++) {
        const h = i === 0 ? hi : (lo + hi) / 2;
        const a = be.fit(runsOf(list[0]), width, h, { bold: true }), b = be.fit(runsOf(list[1]), width, h * ratio, { bold: true });
        if (a.w + b.w + gap * 2 <= width) { best = { a, b, h: Math.max(a.h, b.h) }; if (i === 0) break; lo = h; } else hi = h;
      }
      return best;
    }
    // the usual rates block: side by side, or one under the other when that keeps them bigger
    function ratesBlock(maxH, width) {
      if (!list.length) return { h: 0, draw() {} };
      if (list.length === 1) {
        const a = be.fit(runsOf(list[0]), width, maxH, { bold: true });
        return { h: a.h, draw(x0, y, color) { text(a, x0, y + (maxH > a.h ? 0 : 0), color ? { color } : null); } };
      }
      const s = sideBySide(maxH, width, 0.62);
      if (s) return { h: s.h, draw(x0, y, color) { text(s.a, x0, y + s.h - s.a.h, color ? { color } : null); text(s.b, x0 + width - s.b.w, y + s.h - s.b.h + (s.a.base - s.a.h) - (s.b.base - s.b.h), color ? { color } : null); } };
      const lineH = maxH * 0.78;
      const a = be.fit(runsOf(list[0]), width, lineH, { bold: true }), b = be.fit(runsOf(list[1]), width, lineH * ratio, { bold: true });
      return { h: a.h + b.h + mm(0.4), draw(x0, y, color) { text(a, x0, y, color ? { color } : null); text(b, x0 + width - b.w, y + a.h + mm(0.4), color ? { color } : null); } };
    }
    const minBar = Math.max(mm(5), H * 0.24);
    const kind = L.layout || 'A';

    if (kind === 'F') {
      // the barcode half only as wide as the barcode needs (at least 40%), so the rates get more room
      let lw = Math.round(avW * 0.55);
      for (const f of [0.4, 0.45, 0.5]) { const t = be.barcode(item.code, Math.round(avW * f), H); if (t) { lw = Math.round(avW * f); break; } }
      const dx = pad + lw + gap;
      const hN = Math.max(mm(2.2), Math.min(mm(6), H * 0.13));
      const nf = fitName(item.name, lw, hN, { bold: true });
      const codeH = Math.max(mm(1.5), Math.min(mm(3.2), H * 0.085));
      const bTop = pad * 0.6 + hN + gap * 0.6, bBot = H - pad * 0.6 - codeH - mm(0.3);
      const b = be.barcode(item.code, lw, bBot - bTop);
      if (b && bBot - bTop >= minBar) {
        text(nf, pad, pad * 0.6, null);
        out.push({ kind: 'barcode', x: pad, y: Math.round(bTop), w: b.w, h: Math.round(bBot - bTop), item: b });
        codeText(item.code, bBot + mm(0.3), pad, pad + lw, 'left');
        out.push({ kind: 'line', x: dx, y: pad, w: Math.max(1, mm(0.25)), h: H - 2 * pad });
        const rw = W - pad - (dx + gap), rx = dx + gap;
        const fits = list.map((x, i) => be.fit(runsOf(x), rw, Math.min(H * 0.3 * rs, H * 0.42) * (i ? ratio : 1), { bold: true }));
        if (fits.some(f => f.h < H * 0.11)) { out.length = 0; return layout(item, { ...L, layout: 'A' }, be); } // rates would be too small: use A
        const tot = fits.reduce((a, f) => a + f.h, 0) + (fits.length - 1) * gap;
        let y = (H - tot) / 2;
        fits.forEach(f => { text(f, rx + (rw - f.w) / 2, y, null); y += f.h + gap; });
        return out;
      }
      return layout(item, { ...L, layout: 'A' }, be); // barcode too long for half the label: use A
    }

    if (kind === 'G') {
      const hN = Math.max(mm(2.2), Math.min(mm(6), H * 0.13));
      let rowH = Math.min(H * 0.3 * rs, H * 0.42);
      // keep the barcode at least 5 mm tall: shrink the rate row if needed
      for (let i = 0; i < 6 && H - pad * 1.2 - hN - gap * 0.5 - mm(0.6) - rowH - (R.batch ? 0 : mm(3.5)) < minBar; i++) rowH *= 0.88;
      nameRow(pad * 0.6, pad, W - pad);
      const leftW = Math.round(avW * (R.batch ? 0.56 : 1));
      const main = R.r ? be.fit(runsOf(R.r), leftW, rowH, { bold: true }) : null;
      const lines = R.batch ? [item.code, R.batch] : [];
      const lh = Math.min(rowH / 2, H * 0.12);
      const lf = lines.map(t => be.fit([[t, 1]], avW - leftW - gap, lh, { mono: true, bold: true }));
      const blockH = Math.max(main ? main.h : 0, lf.reduce((a, f) => a + f.h, 0));
      const yB = H - pad * 0.6 - blockH;
      const cH = Math.max(mm(1.5), Math.min(mm(3.2), H * 0.085));
      const bTop = pad * 0.6 + hN + gap * 0.5, bBot = yB - mm(0.6) - (lines.length ? 0 : cH + mm(0.3));
      barcodeIn(pad, bTop, W - pad, bBot);
      if (!lines.length) codeText(item.code, bBot + mm(0.3), pad, W - pad);
      if (main) text(main, pad, yB + blockH - main.h, null);
      let y = yB + blockH - lf.reduce((a, f) => a + f.h, 0);
      lf.forEach(f => { text(f, W - pad - f.w, y, null); y += f.h; });
      return out;
    }

    // A, B, C, D, E, H: name / barcode / code / rates, in different arrangements
    let maxRH = Math.min(H * 0.27 * rs, H * 0.42);
    for (let tries = 0; tries < 8; tries++) {
      const parts = [];
      let blk, blkH, bandH = 0;
      const codeH = Math.max(mm(1.5), Math.min(mm(3.2), H * 0.085));
      if (kind === 'B' || kind === 'E') {
        const colW = Math.round((avW - gap * 2) / 2);
        const inner = kind === 'E' ? mm(0.8) : 0;
        let fits = list.map((x, i) => be.fit(runsOf(x), (list.length > 1 ? colW : avW) - inner * 2, (maxRH - inner * 2) * (i ? ratio : 1), { bold: true }));
        // a long code doesn't fit in half the width: put the two rates one under the other, full width
        const stacked = fits.length > 1 && Math.min(...fits.map(f => f.h)) < (maxRH - inner * 2) * 0.55;
        if (stacked) {
          const lh = maxRH * 0.72;
          fits = list.map((x, i) => be.fit(runsOf(x), avW - inner * 2, (lh - inner * 2) * (i ? ratio : 1), { bold: true }));
          const rowH = fits.map(f => f.h + inner * 2);
          blkH = rowH[0] + rowH[1] + mm(0.5) + (kind === 'B' ? mm(0.6) : 0);
          blk = (y) => {
            let top = y + (kind === 'B' ? mm(0.6) : 0);
            if (kind === 'B') out.push({ kind: 'line', x: pad, y: Math.round(y), w: avW, h: Math.max(1, mm(0.25)) });
            fits.forEach((f, i) => {
              if (kind === 'E') {
                const filled = list[i].k === 'w';
                out.push({ kind: 'rect', x: pad, y: Math.round(top), w: avW, h: Math.round(rowH[i]), fill: filled, stroke: Math.max(1, mm(0.3)), r: mm(0.8) });
                text(f, pad + (avW - f.w) / 2, top + inner, filled ? { color: 'white' } : null);
              } else text(f, i ? W - pad - f.w : pad, top, null);
              top += rowH[i] + mm(0.5);
            });
          };
        } else {
        // equal emphasis: both rates the same size (the smaller of the two)
        if (fits.length > 1 && ratio === 1) { const hh = Math.min(...fits.map(f => f.h)); fits = list.map(x => be.fit(runsOf(x), colW - inner * 2, hh + 0.01, { bold: true })); }
        blkH = (fits.length ? Math.max(...fits.map(f => f.h)) : 0) + inner * 2 + (kind === 'B' ? mm(0.6) : 0);
        blk = (y) => {
          if (!fits.length) return;
          if (kind === 'B') out.push({ kind: 'line', x: pad, y: Math.round(y), w: avW, h: Math.max(1, mm(0.25)) });
          const top = y + (kind === 'B' ? mm(0.6) : 0);
          fits.forEach((f, i) => {
            const cx = list.length > 1 ? pad + i * (colW + gap * 2) : pad, cw = list.length > 1 ? colW : avW;
            if (kind === 'E') {
              const filled = list[i].k === 'w';
              out.push({ kind: 'rect', x: cx, y: Math.round(top), w: cw, h: Math.round(blkH), fill: filled, stroke: Math.max(1, mm(0.3)), r: mm(0.8) });
              text(f, cx + (cw - f.w) / 2, top + (blkH - f.h) / 2, filled ? { color: 'white' } : null);
            } else text(f, cx + (cw - f.w) / 2, top + (blkH - mm(0.6) - f.h) / 2, null);
          });
          if (kind === 'B' && fits.length > 1) out.push({ kind: 'line', x: pad + colW + gap, y: Math.round(top), w: Math.max(1, mm(0.25)), h: Math.round(blkH - mm(0.6)) });
        };
        }
      } else {
        const r = ratesBlock(maxRH, kind === 'C' ? W - 2 * pad : avW);
        blkH = r.h + (kind === 'C' && r.h ? pad : 0);
        blk = (y) => {
          if (kind === 'C' && r.h) { out.push({ kind: 'rect', x: 0, y: Math.round(y), w: W, h: H - Math.round(y), fill: true }); r.draw(pad, y + pad * 0.5, 'white'); }
          else r.draw(pad, y);
        };
      }
      // vertical arrangement
      let top = pad * 0.6, bottom = H - (kind === 'C' ? 0 : pad * 0.6);
      if (kind === 'H') bandH = Math.max(mm(2.6), Math.min(mm(6.5), H * 0.15));
      const nameH = kind === 'H' ? 0 : Math.max(mm(2.2), Math.min(mm(6), H * 0.13));
      let rateY, barTop, barBot, codeY;
      if (kind === 'D') {
        rateY = top; const nameY = rateY + blkH + gap * 0.3;
        barTop = nameY + nameH + gap * 0.4; codeY = bottom - codeH; barBot = codeY - mm(0.3);
        parts.push(() => blk(rateY), () => nameRow(nameY, pad, W - pad));
      } else {
        rateY = bottom - blkH; codeY = rateY - codeH - mm(0.3); barBot = codeY - mm(0.2);
        barTop = (kind === 'H' ? bandH : top + nameH) + gap * 0.5;
        parts.push(() => blk(rateY));
        if (kind === 'H') parts.push(() => {
          out.push({ kind: 'rect', x: 0, y: 0, w: W, h: bandH, fill: true });
          const sf = be.fit([[String(L.shop || 'NRRL'), 1]], avW * 0.4, bandH - mm(0.9), { bold: true });
          text(sf, pad, (bandH - sf.h) / 2, { color: 'white' });
          const nf = fitName(item.name, avW - sf.w - gap * 2, bandH - mm(0.9), { bold: true });
          text(nf, W - pad - nf.w, (bandH - nf.h) / 2, { color: 'white' });
        });
        else parts.push(() => nameRow(top, pad, W - pad));
      }
      if (barBot - barTop >= minBar || tries === 7) {
        parts.forEach(p => p());
        barcodeIn(pad, barTop, W - pad, barBot);
        codeText(item.code, codeY, pad, W - pad);
        return out;
      }
      maxRH *= 0.88; // make room for the barcode
    }
    return out;
  }

  const api = { LAYOUTS, EMPHASIS, layout, rates, smoothFit, unitShort, plain };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NrrlLabels = api;
})(typeof window !== 'undefined' ? window : this);

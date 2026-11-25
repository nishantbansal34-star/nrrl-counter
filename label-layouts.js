/* NRRL — barcode label layouts, shared by the laptop app (normal and direct printing) and the phone app.
   The engine decides where everything goes, in printer dots; a "backend" measures text, draws barcodes
   and turns the result into SVG, printer commands (TSPL) or a canvas picture.

   Rules (from the owner):
   1. Retail and wholesale rates must both be big and readable.
   2. A retail customer must not get any idea of the wholesale rate: it is only ever printed as a code
      (prefix + wholesale rate × multiplier, e.g. NRRL300 for ₹150) or, in layout G, as a "batch number".

   How space is shared (top to bottom on most layouts): name, barcode, the small code under the barcode,
   rates. "Rate size" decides how much of the label height the rates get. When a rate is too wide for the
   label at that height, its letters are drawn narrower (condensed), so a bigger rate size always makes the
   rates taller. The barcode always keeps a scannable height; at Huge and Biggest the small code under it
   is left out when that is the only way to make the rates bigger (the barcode still has the code). */
(function (root) {
  'use strict';

  const LAYOUTS = [
    ['A', 'Two lines, full width'], ['B', 'Two columns'], ['C', 'Black price strip'], ['D', 'Price on top'],
    ['E', 'Boxed rates'], ['F', 'Barcode left, rates right'], ['G', 'Code looks like a batch number'], ['H', 'Shop name band'],
  ];
  const EMPHASIS = [['both', 'Both equal'], ['retail', 'Retail bigger'], ['wholesale', 'Wholesale bigger']];
  // rate sizes: the value saved in settings (percent), its name, the share of the label height the rates may
  // take, and how narrow the letters may get (1 = normal width) to reach that height
  const RATE_SIZES = [
    { v: 100, name: 'Normal', share: 0.30, squeeze: 1 },
    { v: 130, name: 'Large', share: 0.38, squeeze: 0.9 },
    { v: 160, name: 'Extra large', share: 0.46, squeeze: 0.8 },
    { v: 200, name: 'Huge', share: 0.54, squeeze: 0.72 },
    { v: 250, name: 'Biggest', share: 0.62, squeeze: 0.64 },
  ];
  // the rate size for a saved percent (old values like 120 or 300 go to the nearest one)
  const rateSize = pct => {
    const p = +pct > 3 ? +pct : (+pct || 1) * 100;
    return RATE_SIZES.reduce((a, b) => Math.abs(b.v - p) < Math.abs(a.v - p) ? b : a);
  };

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
  const UNIT_K = 0.6; // "/pc" next to the rate, this much of the rate's size
  const runsOf = x => [[x.main, 1], [x.unit, UNIT_K]];

  /* Text fitting for backends whose fonts scale smoothly (SVG, canvas).
     width(text, k, style) gives the width in dots of `text` at font size k (k = 1 for the main text).
     style.squeeze: the letters may be drawn this narrow (0.64 … 1) to make the text taller.
     Returns { w, h, base, size, xs, parts:[{t, size, x, w}], style }. */
  function smoothFit(width) {
    return function fit(runs, maxW, maxH, style) {
      style = style || {};
      const sq = Math.max(0.5, Math.min(1, +style.squeeze || 1));
      const w1 = Math.max(runs.reduce((a, [t, k]) => a + width(t, k, style), 0), 0.001); // width at font size 1
      const asc = style.mono ? 0.78 : 0.76;
      const size = Math.max(1, Math.min(maxH / 0.98, maxW / (w1 * sq)));
      const xs = Math.min(1, maxW / (w1 * size));
      let x = 0;
      const parts = runs.map(([t, k]) => { const w = width(t, k, style) * size * xs; const p = { t, size: size * k, x, w }; x += w; return p; });
      return { w: x, h: size * 0.98, base: size * asc, size, xs, parts, style };
    };
  }

  /* --- the layouts ---
     L = { wD, hD, dpm, layout, emph, rateScale, showRetail, showWholesale, prefix, mult, shop, logo }
     be = backend: fit(runs, maxW, maxH, style), barcode(code, maxW, maxH) → {w,h,…} | null, logo(maxW, maxH) → {w,h} | null */
  const rateHeight = els => { const t = els.filter(e => e.rate); return t.length ? Math.min(...t.map(e => e.fit.h)) : 0; };
  function layout(item, L, be) {
    const els = layoutOne(item, L, be);
    const i = RATE_SIZES.indexOf(rateSize(L.rateScale));
    if (i > 0) {
      const prev = layout(item, { ...L, rateScale: RATE_SIZES[i - 1].v / 100 }, be);
      if (rateHeight(prev) > rateHeight(els) + 0.5) return prev;
    }
    return els;
  }
  function layoutOne(item, L, be) {
    const out = [], W = L.wD, H = L.hD, mm = v => Math.round(v * L.dpm);
    // 1.8 mm from the sides and 1.1 mm from top and bottom: printers can shift the print about a millimetre
    const pad = mm(1.8), vpad = mm(1.1), gap = mm(1), avW = W - 2 * pad, inH = H - 2 * vpad;
    const RS = rateSize(L.rateScale), lvl = RATE_SIZES.indexOf(RS);
    const SQ = RS.squeeze, BIG = { bold: true, squeeze: SQ };
    const R = rates(item, L);
    const emph = L.emph === 'retail' || L.emph === 'wholesale' ? L.emph : 'both';
    let list = [R.r, R.w].filter(Boolean);
    if (emph === 'wholesale') list = [R.w, R.r].filter(Boolean);
    const ratio = emph === 'both' || list.length < 2 ? 1 : 0.78; // the other rate, when one is bigger
    const text = (fit, x, y, extra) => { out.push({ kind: 'text', x: Math.round(x), y: Math.round(y), fit, ...(extra || {}) }); return fit; };
    const col = c => c ? { color: c } : null;
    const rt = c => c ? { color: c, rate: true } : { rate: true }; // rate text (tests and the size check use it)
    const minBar = Math.max(mm(4.5), Math.min(mm(9), inH * 0.22)); // never shorter than this: it must scan
    const NAME_MAX = Math.max(mm(2.4), Math.min(mm(6), H * 0.14)), NAME_MIN = mm(2.5);
    const CODE_H = Math.max(mm(1.5), Math.min(mm(3), H * 0.08));

    // a long name gets a little smaller (not below 80% of its row), then is cut with "…"
    function fitName(name, maxW, maxH, style) {
      name = String(name || '');
      const st = { bold: true, squeeze: 0.86, ...(style || {}) };
      let f = be.fit([[name, 1]], maxW, maxH, st);
      const least = Math.min(maxH, Math.max(maxH * 0.8, NAME_MIN));
      if (f.h >= least - 0.5 || name.length < 4) return f;
      let n = name;
      while (n.length > 3) { n = n.slice(0, -1); f = be.fit([[n.replace(/\s+$/, '') + '…', 1]], maxW, maxH, st); if (f.h >= least - 0.5) break; }
      return f;
    }
    // the item name (with the logo in front of it when there is one)
    function nameRow(y, h, x0, x1) {
      let x = x0;
      if (L.logo && be.logo) {
        const lg = be.logo(Math.round((x1 - x0) * 0.4), h);
        if (lg) { out.push({ kind: 'logo', x, y: Math.round(y), w: lg.w, h: lg.h, item: lg }); x += lg.w + gap; }
      }
      const f = fitName(item.name, x1 - x, h);
      text(f, x, y + Math.max(0, (h - f.h) / 2));
    }
    function codeText(y, h, x0, x1, align) {
      const f = be.fit([[String(item.code), 1]], x1 - x0, h, { mono: true });
      text(f, align === 'left' ? x0 : align === 'right' ? x1 - f.w : x0 + (x1 - x0 - f.w) / 2, y);
    }
    function barcodeAt(x0, y0, x1, y1, align) {
      const b = be.barcode(item.code, x1 - x0, y1 - y0);
      if (!b) return null;
      out.push({ kind: 'barcode', x: Math.round(align === 'left' ? x0 : x0 + (x1 - x0 - b.w) / 2), y: Math.round(y0), w: b.w, h: Math.round(y1 - y0), item: b });
      return b;
    }

    /* The rates, as big as possible inside width × maxH. Tries them side by side and one under the other and
       keeps whichever makes them bigger. cols: two equal columns (layouts B and E). inner: room inside a box.
       Returns { h, rows, draw(x, y, color) } — rows: 1 when side by side, 2 when stacked. */
    function ratesBlock(maxH, width, cols, inner) {
      inner = inner || 0;
      if (!list.length || maxH <= 0) return { h: 0, score: 0, draw() {} };
      if (list.length === 1) {
        const a = be.fit(runsOf(list[0]), width - inner * 2, maxH - inner * 2, BIG);
        return { h: a.h + inner * 2, score: a.h, rows: 1, fits: [a], draw(x, y, c) { text(a, x + (width - a.w) / 2, y + inner, rt(c)); } };
      }
      const cand = [];
      // side by side
      const colW = cols ? Math.round((width - gap * 2) / 2) : 0;
      if (cols) {
        const fa = be.fit(runsOf(list[0]), colW - inner * 2, maxH - inner * 2, BIG);
        let fb = be.fit(runsOf(list[1]), colW - inner * 2, (maxH - inner * 2) * ratio, BIG);
        let a = fa;
        if (ratio === 1) { const hh = Math.min(fa.h, fb.h) / 0.98 * 0.98; a = be.fit(runsOf(list[0]), colW - inner * 2, hh, BIG); fb = be.fit(runsOf(list[1]), colW - inner * 2, hh, BIG); }
        else if (fb.h > a.h * ratio + 0.5) fb = be.fit(runsOf(list[1]), colW - inner * 2, a.h * ratio, BIG);
        const h = Math.max(a.h, fb.h) + inner * 2;
        cand.push({ h, rows: 1, score: Math.min(a.h, fb.h / ratio), fits: [a, fb], colW });
      } else {
        // largest height at which both fit on one line (letters at most as narrow as the rate size allows)
        let lo = 0, hi = maxH, best = null;
        for (let i = 0; i < 20; i++) {
          const h = i === 0 ? hi : (lo + hi) / 2;
          const na = be.fit(runsOf(list[0]), 1e6, h, { bold: true }), nb = be.fit(runsOf(list[1]), 1e6, h * ratio, { bold: true });
          const room = width - mm(2);
          const need = na.w + nb.w;
          if (need * SQ <= room) {
            const k = Math.min(1, room / need);
            best = { a: be.fit(runsOf(list[0]), na.w * k, h, BIG), b: be.fit(runsOf(list[1]), nb.w * k, h * ratio, BIG) };
            if (i === 0) break; lo = h;
          } else hi = h;
          if (hi - lo < 0.5) break;
        }
        if (best) cand.push({ h: Math.max(best.a.h, best.b.h), rows: 1, score: Math.min(best.a.h, best.b.h / ratio), fits: [best.a, best.b] });
      }
      // one under the other, full width
      {
        const lg = Math.max(1, mm(0.5)) + (inner ? mm(0.4) : 0);
        const lineH = (maxH - lg - inner * 4) / (1 + ratio);
        let a = be.fit(runsOf(list[0]), width - inner * 2, lineH, BIG), b = be.fit(runsOf(list[1]), width - inner * 2, lineH * ratio, BIG);
        if (ratio === 1 && Math.abs(a.h - b.h) > 0.5) { const hh = Math.min(a.h, b.h); a = be.fit(runsOf(list[0]), width - inner * 2, hh, BIG); b = be.fit(runsOf(list[1]), width - inner * 2, hh, BIG); }
        cand.push({ h: a.h + b.h + lg + inner * 4, rows: 2, score: Math.min(a.h, b.h / ratio), fits: [a, b], lg });
      }
      // stacking costs a line: only worth it when the rates get clearly bigger
      cand.sort((p, q) => (q.score * (q.rows === 1 ? 1.12 : 1)) - (p.score * (p.rows === 1 ? 1.12 : 1)));
      const c = cand[0];
      const [a, b] = c.fits;
      return {
        h: c.h, score: c.score, rows: c.rows, fits: c.fits, colW: c.colW,
        draw(x, y, color) {
          if (c.rows === 1 && cols) {
            [a, b].forEach((f, i) => text(f, x + i * (c.colW + gap * 2) + (c.colW - f.w) / 2, y + (c.h - f.h) / 2, rt(color)));
          } else if (c.rows === 1) {
            // left one and right one, on the same baseline
            const baseY = y + c.h - Math.max(a.h - a.base, b.h - b.base);
            text(a, x, baseY - a.base, rt(color));
            text(b, x + width - b.w, baseY - b.base, rt(color));
          } else {
            text(a, x + (width - a.w) / 2 * (inner ? 1 : 0), y + inner, rt(color));
            text(b, inner ? x + (width - b.w) / 2 : x + width - b.w, y + a.h + c.lg + inner * 3, rt(color));
          }
        },
      };
    }

    const kind = L.layout || 'A';

    /* F: barcode on the left, the rates on the right, one under the other */
    if (kind === 'F') {
      let lw = 0;
      for (const f of [0.4, 0.45, 0.5, 0.55]) { if (be.barcode(item.code, Math.round(avW * f), H)) { lw = Math.round(avW * f); break; } }
      if (!lw || !list.length) return layoutOne(item, { ...L, layout: 'A' }, be);
      const rx = pad + lw + gap * 2, rw = W - pad - rx;
      const each = [0.34, 0.4, 0.45, 0.48, 0.5][lvl] * inH;
      const fits = list.map((x, i) => be.fit(runsOf(x), rw, each * (i ? ratio : 1), BIG));
      if (fits.some(f => f.h < H * 0.13)) return layoutOne(item, { ...L, layout: 'A' }, be); // rates too small this way: use A
      const nameH = Math.min(NAME_MAX, Math.max(NAME_MIN, inH * 0.16));
      const codeH = CODE_H;
      const bTop = vpad + nameH + mm(0.5), bBot = H - vpad - codeH - mm(0.4);
      if (bBot - bTop < minBar) return layoutOne(item, { ...L, layout: 'A' }, be);
      nameRow(vpad, nameH, pad, pad + lw);
      barcodeAt(pad, bTop, pad + lw, bBot, 'left');
      codeText(bBot + mm(0.4), codeH, pad, pad + lw, 'left');
      out.push({ kind: 'line', x: pad + lw + gap, y: vpad, w: Math.max(1, mm(0.25)), h: inH });
      const tot = fits.reduce((a, f) => a + f.h, 0) + (fits.length - 1) * mm(1.2);
      let y = vpad + (inH - tot) / 2;
      fits.forEach(f => { text(f, rx + (rw - f.w) / 2, y, rt()); y += f.h + mm(1.2); });
      return out;
    }

    /* G: name, barcode, then the retail rate big on the left and the code + "batch number" on the right */
    if (kind === 'G') {
      let codeLine = !R.batch;
      const leftW = Math.round(avW * (R.batch ? (R.r ? 0.56 : 0) : 1));
      const roomFor = (rowH, nameH) => inH - nameH - mm(0.5) - rowH - mm(0.6) - (codeLine ? CODE_H + mm(0.3) : 0);
      let nameH = NAME_MAX, rowH = inH * RS.share;
      if (roomFor(rowH, nameH) < minBar && lvl >= 3) codeLine = false; // Huge / Biggest: the small code goes first
      if (roomFor(rowH, nameH) < minBar) nameH = NAME_MIN;
      if (roomFor(rowH, nameH) < minBar) rowH = Math.max(mm(2), inH - nameH - mm(0.5) - mm(0.6) - (codeLine ? CODE_H + mm(0.3) : 0) - minBar);
      const main = R.r ? be.fit(runsOf(R.r), leftW || avW, rowH, BIG) : null;
      const lines = R.batch ? [String(item.code), R.batch] : [];
      const rightW = avW - leftW - (leftW ? gap * 2 : 0), lgap = mm(0.3);
      const lf = lines.map((t, i) => be.fit([[t, 1]], rightW, (rowH - lgap) * (i ? 0.58 : 0.42), { mono: true, bold: true, squeeze: Math.max(0.75, SQ) }));
      const blockH = Math.max(main ? main.h : 0, lf.reduce((a, f) => a + f.h, 0) + (lf.length > 1 ? lgap : 0));
      const yB = H - vpad - blockH;
      nameRow(vpad, nameH, pad, W - pad);
      const bTop = vpad + nameH + mm(0.5), bBot = yB - mm(0.6) - (codeLine ? CODE_H + mm(0.3) : 0);
      barcodeAt(pad, bTop, W - pad, bBot);
      if (codeLine) codeText(bBot + mm(0.3), CODE_H, pad, W - pad);
      if (main) text(main, pad, yB + blockH - main.h, rt());
      let y = yB + blockH - lf.reduce((a, f) => a + f.h, 0) - (lf.length > 1 ? lgap : 0);
      lf.forEach((f, i) => { text(f, W - pad - f.w, y, i ? rt() : null); y = Math.ceil(y + f.h + lgap); });
      return out;
    }

    /* A, B, C, D, E, H: name, barcode, code and rates, in different arrangements */
    const bandH = kind === 'H' ? Math.max(mm(3.6), Math.min(mm(7), H * 0.18)) : 0;
    const cols = kind === 'B' || kind === 'E';
    const inner = kind === 'E' ? mm(0.7) : 0;
    const stripPad = kind === 'C' ? mm(0.8) : 0;
    const rateW = kind === 'C' ? W - 2 * pad : avW;
    const nameFull = kind === 'H' ? 0 : NAME_MAX, nameSmall = kind === 'H' ? 0 : NAME_MIN;
    // what can give way so the rates get bigger: at Huge and Biggest the small code under the barcode first
    const plans = lvl >= 3
      ? [[nameFull, CODE_H], [nameFull, 0], [nameSmall, 0]]
      : [[nameFull, CODE_H], [nameSmall, CODE_H], [nameSmall, mm(1.5)]];
    const tryWith = (want, nameH, codeH) => {
      const b = ratesBlock(want, rateW, cols, inner);
      const bh = b.h + (kind === 'C' && b.h ? stripPad * 2 : 0) + (kind === 'B' && b.h ? mm(0.7) : 0);
      const fixed = (kind === 'H' ? bandH - vpad + mm(0.6) : nameH + mm(0.5)) + (codeH ? codeH + mm(0.3) : 0) + mm(0.6) + bh - (kind === 'C' ? vpad : 0);
      return { blk: b, blkH: bh, nameH, codeH, ok: inH - fixed >= minBar };
    };
    const target = inH * RS.share;
    let got = null;
    for (const [nh, ch] of plans) { const t = tryWith(target, nh, ch); if (t.ok) { got = t; break; } }
    if (!got) {
      // even the simplest label has no room for rates this big: the biggest that leave the barcode its height
      const [nh, ch] = plans[plans.length - 1];
      let lo = 0, hi = target;
      got = tryWith(0, nh, ch);
      for (let i = 0; i < 16 && hi - lo > 0.5; i++) {
        const mid = (lo + hi) / 2, t = tryWith(mid, nh, ch);
        if (t.ok) { got = t; lo = mid; } else hi = mid;
      }
    }
    const { blk, blkH, nameH, codeH } = got;
    // where things go
    let y0 = vpad, y1 = H - vpad;
    let rateY;
    if (kind === 'D') {
      rateY = y0; y0 += blkH + mm(0.6);
    } else if (kind === 'C') {
      rateY = H - blkH; y1 = rateY - mm(0.6);
    } else {
      rateY = y1 - blkH; y1 = rateY - mm(0.6);
    }
    if (kind === 'H') {
      out.push({ kind: 'rect', x: 0, y: 0, w: W, h: bandH, fill: true });
      const sf = be.fit([[String(L.shop || 'NRRL'), 1]], avW * 0.4, bandH - mm(0.9), { bold: true });
      text(sf, pad, (bandH - sf.h) / 2, col('white'));
      const nf = fitName(item.name, avW - sf.w - gap * 2, bandH - mm(0.9));
      text(nf, W - pad - nf.w, (bandH - nf.h) / 2, col('white'));
      y0 = bandH + mm(0.6);
    } else {
      nameRow(y0, nameH, pad, W - pad);
      y0 += nameH + mm(0.5);
    }
    // the barcode takes the room that is left (not more than half the label; any extra goes around it)
    let barH = y1 - y0 - (codeH ? codeH + mm(0.3) : 0);
    const maxBar = Math.max(minBar, inH * 0.5);
    if (barH > maxBar) { const extra = barH - maxBar; barH = maxBar; y0 += extra / 2; }
    barcodeAt(pad, y0, W - pad, y0 + barH);
    if (codeH) codeText(y0 + barH + mm(0.3), codeH, pad, W - pad);
    // the rates
    if (blk.h) {
      if (kind === 'C') {
        out.push({ kind: 'rect', x: 0, y: Math.round(rateY), w: W, h: H - Math.round(rateY), fill: true });
        blk.draw(pad, rateY + stripPad, 'white');
      } else if (kind === 'B') {
        out.push({ kind: 'line', x: pad, y: Math.round(rateY), w: avW, h: Math.max(1, mm(0.25)) });
        blk.draw(pad, rateY + mm(0.7));
        if (blk.rows === 1 && list.length > 1) out.push({ kind: 'line', x: pad + blk.colW + gap, y: Math.round(rateY + mm(0.7)), w: Math.max(1, mm(0.25)), h: Math.round(blk.h) });
      } else if (kind === 'E') {
        // a box round each rate; the wholesale code's box is filled black
        const fits = blk.fits || [];
        if (blk.rows === 1 && list.length > 1) {
          list.forEach((r, i) => {
            const x = pad + i * (blk.colW + gap * 2), filled = r.k === 'w', f = fits[i];
            out.push({ kind: 'rect', x, y: Math.round(rateY), w: blk.colW, h: Math.round(blk.h), fill: filled, stroke: Math.max(1, mm(0.3)), r: mm(0.8) });
            text(f, x + (blk.colW - f.w) / 2, rateY + (blk.h - f.h) / 2, rt(filled ? 'white' : ''));
          });
        } else {
          let y = rateY;
          list.forEach((r, i) => {
            const f = fits[i], filled = r.k === 'w', h = f.h + inner * 2;
            out.push({ kind: 'rect', x: pad, y: Math.round(y), w: avW, h: Math.round(h), fill: filled, stroke: Math.max(1, mm(0.3)), r: mm(0.8) });
            text(f, pad + (avW - f.w) / 2, y + inner, rt(filled ? 'white' : ''));
            y += h + mm(0.5);
          });
        }
      } else blk.draw(pad, rateY);
    }
    return out;
  }

  const api = { LAYOUTS, EMPHASIS, RATE_SIZES, rateSize, rateHeight, layout, rates, smoothFit, unitShort, plain };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NrrlLabels = api;
})(typeof window !== 'undefined' ? window : this);

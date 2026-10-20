/* NRRL Billing — counter screen */
'use strict';
(() => {
/* ================= helpers ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = n => Math.round((+n || 0) * 100) / 100;
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = n => inr.format(r2(n));
const qf = n => { const v = r2(n); return Number.isInteger(v) ? String(v) : String(v); };
const p2 = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const today = () => ymd(new Date());
const fmtTime = s => { const m = /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(s || ''); if (!m) return s || ''; let h = +m[4]; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${m[3]}/${m[2]} ${h}:${m[5]} ${ap}`; };
const LS = {
  get(k, d) { try { const v = localStorage.getItem('nrrl.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('nrrl.' + k, JSON.stringify(v)); } catch (e) {} },
};
const rpc = (m, ...a) => window.api.call(m, ...a);
const PAY = [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['udhaar', 'Udhaar']];
const PAYNAME = Object.fromEntries(PAY);

let actx;
function beep(ok) {
  try {
    actx = actx || new AudioContext();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'square'; o.frequency.value = ok ? 2300 : 240; g.gain.value = ok ? .04 : .07;
    o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + (ok ? .06 : .3));
  } catch (e) {}
}
function toast(msg, opts = {}) {
  const t = document.createElement('div');
  t.className = 'toast' + (opts.err ? ' err' : '');
  t.innerHTML = `<span>${esc(msg)}</span>${opts.action ? `<button type="button">${esc(opts.action)}</button>` : ''}`;
  if (opts.action) t.querySelector('button').addEventListener('click', () => { t.remove(); opts.onAction && opts.onAction(); });
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), opts.ms || (opts.err ? 6000 : 2200));
}

/* ================= state ================= */
const S = {
  items: new Map(), settings: {}, view: 'bill',
  cart: LS.get('cart', null) || newCart(),
  sel: 0, unlockedUntil: 0, lastBill: null, printers: null,
};
function newCart(prev) { return { lines: [], mode: prev?.mode || 'retail', payment: 'cash', discount: 0, customer: '', phone: '', received: '' }; }
const saveCart = () => LS.set('cart', S.cart);
async function reloadItems() {
  const list = await rpc('items.all');
  S.items.clear();
  for (const it of list) S.items.set(it.code, it);
}
function findItem(code) {
  code = String(code || '').trim();
  if (!code) return null;
  if (S.items.has(code)) return S.items.get(code);
  const up = code.toUpperCase();
  for (const it of S.items.values()) if (it.code.toUpperCase() === up) return it;
  if (/^\d+$/.test(code)) { // EAN/UPC leading zeros
    const z = code.replace(/^0+/, '');
    for (const it of S.items.values()) if (/^\d+$/.test(it.code) && it.code.replace(/^0+/, '') === z) return it;
  }
  return null;
}
function searchItems(q, limit = 12) {
  q = q.trim().toLowerCase();
  if (q.length < 2) return [];
  const words = q.split(/\s+/), starts = [], rest = [];
  for (const it of S.items.values()) {
    const hay = (it.name + ' ' + it.code).toLowerCase();
    if (words.every(w => hay.includes(w))) (it.name.toLowerCase().startsWith(q) || it.code.toLowerCase().startsWith(q) ? starts : rest).push(it);
    if (starts.length >= limit) break;
  }
  return starts.concat(rest).slice(0, limit);
}
const lowLevel = it => it.min_stock != null ? +it.min_stock : (+S.settings.low_stock || 5);

/* ================= owner lock ================= */
const locked = () => S.settings.hasPin && Date.now() > S.unlockedUntil;
function renderLock() {
  const b = $('#lockBtn');
  b.hidden = !S.settings.hasPin;
  b.textContent = locked() ? 'Owner: locked' : 'Owner: unlocked · Lock';
}
$('#lockBtn').addEventListener('click', async () => {
  if (locked()) await requireOwner('Unlock owner access');
  else { S.unlockedUntil = 0; toast('Owner access locked'); }
  renderLock(); refreshView();
});
setInterval(() => { if (S.settings.hasPin) renderLock(); }, 30000);
function requireOwner(title = 'Owner PIN needed') {
  if (!locked()) return Promise.resolve(true);
  return new Promise(resolve => {
    const m = openModal(`<h2>${esc(title)}</h2><p class="muted">Enter the owner PIN to continue.</p>
      <form class="pinpad" id="pinForm"><input type="password" id="pinIn" inputmode="numeric" maxlength="8" autocomplete="off">
      <div class="err" id="pinErr"></div>
      <div class="foot"><button class="btn" type="button" data-close>Cancel</button><button class="btn accent" type="submit">Unlock</button></div></form>`,
      { onClose: () => resolve(false) });
    setTimeout(() => $('#pinIn', m).focus(), 30);
    $('#pinForm', m).addEventListener('submit', async e => {
      e.preventDefault();
      const ok = await rpc('auth.check', $('#pinIn', m).value).catch(() => false);
      if (!ok) { $('#pinErr', m).textContent = 'Wrong PIN.'; $('#pinIn', m).select(); beep(false); return; }
      S.unlockedUntil = Date.now() + 15 * 60e3;
      m._onClose = null; closeModal(m); renderLock(); resolve(true);
    });
  });
}

/* ================= modals ================= */
function openModal(html, opts = {}) {
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="card${opts.wide ? ' wide' : ''}">${html}</div>`;
  m._onClose = opts.onClose || null;
  m.addEventListener('mousedown', e => { if (e.target === m) m._down = true; });
  m.addEventListener('click', e => {
    if ((e.target === m && m._down) || e.target.closest('[data-close]')) closeModal(m);
    m._down = false;
  });
  $('#modals').appendChild(m);
  return m;
}
function closeModal(m) {
  m = m || $('#modals').lastElementChild;
  if (!m) return;
  const f = m._onClose; m._onClose = null; m.remove(); f && f();
  if (!$('#modals').children.length && S.view === 'bill') focusScan();
}
const modalOpen = () => !!$('#modals').children.length;

/* ================= navigation & keys ================= */
$('#nav').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) show(b.dataset.view); });
async function show(v) {
  if (v === 'settings' && !(await requireOwner('Settings need the owner PIN'))) return;
  S.view = v;
  $$('#nav [data-view]').forEach(b => b.dataset.view === v ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  for (const k of ['bill', 'items', 'sales', 'settings']) $('#v-' + k).hidden = k !== v;
  refreshView();
}
function refreshView() {
  if (S.view === 'bill') { renderCart(); focusScan(); }
  if (S.view === 'items') renderItems();
  if (S.view === 'sales') renderSales();
  if (S.view === 'settings') renderSettings();
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && modalOpen()) { e.preventDefault(); closeModal(); return; }
  if (modalOpen()) return;
  const k = e.key;
  if (k === 'F1') { e.preventDefault(); show('bill'); return; }
  if (k === 'F3') { e.preventDefault(); show('items'); return; }
  if (k === 'F5') { e.preventDefault(); show('sales'); return; }
  if (k === 'F11') { e.preventDefault(); show('settings'); return; }
  if (S.view !== 'bill') return;
  if (k === 'F2') { e.preventDefault(); focusScan(); }
  else if (k === 'F4') { e.preventDefault(); const q = $(`#lines [data-q="${S.sel}"]`); if (q) { q.focus(); q.select(); } }
  else if (k === 'F6') { e.preventDefault(); setMode(S.cart.mode === 'retail' ? 'wholesale' : 'retail'); }
  else if (k === 'F7') { e.preventDefault(); $('#cName').focus(); }
  else if (k === 'F8') { e.preventDefault(); $('#disc').focus(); $('#disc').select(); }
  else if (k === 'F9') { e.preventDefault(); saveBill(true); }
  else if (k === 'F10') { e.preventDefault(); saveBill(false); }
  else if (e.ctrlKey && k.toLowerCase() === 'p') { e.preventDefault(); reprintLast(); }
  else if (e.altKey && /^[1-4]$/.test(k)) { e.preventDefault(); S.cart.payment = PAY[+k - 1][0]; saveCart(); renderTotals(); }
  else if (document.activeElement === document.body && k.length === 1 && !e.ctrlKey && !e.altKey) { focusScan(); }
});

/* ================= billing screen ================= */
function buildBill() {
  $('#v-bill').innerHTML = `
  <div class="bill">
    <div class="bill-left">
      <div class="scanrow">
        <div class="scanbox" id="scanbox">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8v8M10 8v8M13 8v8M16.5 8v8"/></svg>
          <input type="text" id="scan" autocomplete="off" spellcheck="false" placeholder="Scan barcode, or type item name / code">
          <div class="sugg" id="sugg" hidden></div>
        </div>
        <div class="seg" role="group" aria-label="Price list" id="modeSeg"><button type="button" data-mode="retail">Retail</button><button type="button" data-mode="wholesale">Wholesale</button></div>
      </div>
      <div class="hintline"><span><kbd>5*</kbd> before a scan = qty 5</span><span><kbd>+</kbd><kbd>−</kbd> change qty</span><span><kbd>Del</kbd> remove line</span><span><kbd>↑</kbd><kbd>↓</kbd> pick line</span><span><kbd>F4</kbd> type qty</span><span><kbd>F6</kbd> retail/wholesale</span><span><kbd>Ctrl+P</kbd> reprint last</span></div>
      <div class="lines" id="linesWrap"><table class="grid" id="lines"></table></div>
    </div>
    <aside class="bill-right" id="totals"></aside>
  </div>`;
  const scan = $('#scan');
  scan.addEventListener('keydown', onScanKey);
  scan.addEventListener('input', () => renderSugg(scan.value));
  scan.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== scan) hideSugg(); }, 150));
  $('#sugg').addEventListener('mousedown', e => e.preventDefault());
  $('#sugg').addEventListener('click', e => { const b = e.target.closest('[data-code]'); if (b) pickSugg(b.dataset.code); });
  $('#modeSeg').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });
  $('#lines').addEventListener('click', onLineClick);
  $('#lines').addEventListener('change', onLineChange);
  $('#lines').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); focusScan(); } });
  $('#v-bill').addEventListener('mouseup', e => {
    if (!e.target.closest('input,select,textarea,button,a') && !window.getSelection().toString()) focusScan();
  });
}
function focusScan() { if (S.view === 'bill' && !modalOpen()) { const s = $('#scan'); if (s && document.activeElement !== s) s.focus(); } }
function flashScan(ok) { const b = $('#scanbox'); b.classList.remove('flash-ok', 'flash-bad'); void b.offsetWidth; b.classList.add(ok ? 'flash-ok' : 'flash-bad'); clearTimeout(flashScan.t); flashScan.t = setTimeout(() => b.classList.remove('flash-ok', 'flash-bad'), 300); }

let sugg = [], suggIdx = -1;
function renderSugg(v) {
  const q = v.replace(/^\d+(\.\d+)?\*/, '');
  sugg = /^\s*$/.test(q) ? [] : searchItems(q);
  suggIdx = sugg.length ? 0 : -1;
  const box = $('#sugg');
  if (!sugg.length || findItem(q)) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = sugg.map((it, i) => `<button type="button" data-code="${esc(it.code)}" aria-selected="${i === suggIdx}"><span class="nm">${esc(it.name)}</span><span class="num muted small">${esc(it.code)}</span><span class="num">${money(priceFor(it))}</span></button>`).join('');
}
function moveSugg(d) {
  if (!sugg.length) return;
  suggIdx = (suggIdx + d + sugg.length) % sugg.length;
  $$('#sugg button').forEach((b, i) => b.setAttribute('aria-selected', i === suggIdx));
  $$('#sugg button')[suggIdx]?.scrollIntoView({ block: 'nearest' });
}
function hideSugg() { $('#sugg').hidden = true; sugg = []; suggIdx = -1; }
function pickSugg(code) {
  const scan = $('#scan'), m = /^(\d+(?:\.\d+)?)\*/.exec(scan.value);
  addItem(S.items.get(code), m ? +m[1] : 1);
  scan.value = ''; hideSugg(); focusScan();
}
function onScanKey(e) {
  const scan = e.target, v = scan.value;
  if (e.key === 'Enter') { e.preventDefault(); handleEntry(v); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); if (!$('#sugg').hidden) moveSugg(1); else selectLine(S.sel + 1); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); if (!$('#sugg').hidden) moveSugg(-1); else selectLine(S.sel - 1); return; }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (!$('#sugg').hidden) hideSugg();
    else if (v) scan.value = '';
    else clearBill();
    return;
  }
  if (!v && (e.key === '+' || e.key === '-')) { e.preventDefault(); bumpQty(S.sel, e.key === '+' ? 1 : -1); return; }
  if (!v && e.key === 'Delete') { e.preventDefault(); removeLine(S.sel); return; }
}
function handleEntry(raw) {
  const scan = $('#scan');
  let v = String(raw || '').trim();
  if (!v) return;
  if (!$('#sugg').hidden && suggIdx >= 0 && sugg[suggIdx] && !findItem(v.replace(/^\d+(\.\d+)?\*/, ''))) { pickSugg(sugg[suggIdx].code); return; }
  let qty = 1;
  const m = /^(\d+(?:\.\d+)?)\*(.*)$/.exec(v);
  if (m) { qty = +m[1]; v = m[2].trim(); }
  scan.value = ''; hideSugg();
  if (!v) return;
  const it = findItem(v);
  if (it) { addItem(it, qty); return; }
  const found = searchItems(v);
  if (found.length === 1) { addItem(found[0], qty); return; }
  if (found.length > 1) { scan.value = raw; renderSugg(raw); return; }
  beep(false); flashScan(false);
  openItemForm({ code: v }, { fromBill: true, qty });
}
const priceFor = it => S.cart.mode === 'wholesale' && +it.wholesale > 0 ? +it.wholesale : +it.retail;
const unitFor = it => S.cart.mode === 'wholesale' && +it.wholesale > 0 && it.wholesale_unit ? it.wholesale_unit : it.unit;
function addItem(it, qty = 1) {
  if (!it) return;
  const L = S.cart.lines;
  let i = L.findIndex(l => l.code === it.code);
  if (i >= 0) L[i].qty = r2(L[i].qty + qty);
  else { L.push({ code: it.code, name: it.name, unit: unitFor(it), gst: it.gst, rate: priceFor(it), listRate: true, qty: r2(qty) }); i = L.length - 1; }
  S.sel = i; saveCart(); renderCart(i);
  beep(true); flashScan(true);
  if (it.stock != null && it.stock - L[i].qty < 0) toast(`${it.name}: only ${qf(it.stock)} ${it.unit} in stock`, { err: true, ms: 2500 });
}
function setMode(m) {
  S.cart.mode = m;
  for (const l of S.cart.lines) { const it = S.items.get(l.code); if (it) { l.unit = unitFor(it); if (l.listRate) l.rate = priceFor(it); } }
  saveCart(); renderCart();
}
function selectLine(i) {
  const n = S.cart.lines.length; if (!n) return;
  S.sel = Math.max(0, Math.min(n - 1, i));
  $$('#lines tbody tr').forEach((tr, j) => tr.classList.toggle('sel', j === S.sel));
  $$('#lines tbody tr')[S.sel]?.scrollIntoView({ block: 'nearest' });
}
function bumpQty(i, d) {
  const l = S.cart.lines[i]; if (!l) return;
  l.qty = r2(l.qty + d);
  if (l.qty <= 0) { removeLine(i); return; }
  saveCart(); renderCart();
}
function removeLine(i) {
  if (!S.cart.lines[i]) return;
  S.cart.lines.splice(i, 1);
  S.sel = Math.min(S.sel, S.cart.lines.length - 1);
  saveCart(); renderCart();
}
let clearArm = 0;
function clearBill() {
  if (!S.cart.lines.length) return;
  if (Date.now() - clearArm > 2000) { clearArm = Date.now(); toast('Press Esc again to clear this bill'); return; }
  S.cart = newCart(S.cart); S.sel = 0; saveCart(); renderCart(); toast('Bill cleared');
}
function onLineClick(e) {
  const b = e.target.closest('button');
  const tr = e.target.closest('tr[data-i]');
  if (tr && !b) { selectLine(+tr.dataset.i); return; }
  if (!b) return;
  if (b.dataset.inc != null) bumpQty(+b.dataset.inc, 1);
  else if (b.dataset.dec != null) bumpQty(+b.dataset.dec, -1);
  else if (b.dataset.rm != null) removeLine(+b.dataset.rm);
  focusScan();
}
async function onLineChange(e) {
  const L = S.cart.lines, q = e.target.dataset.q, p = e.target.dataset.p;
  if (q != null) { const v = r2(e.target.value); if (v <= 0) L.splice(+q, 1); else L[+q].qty = v; }
  if (p != null) {
    if (!(await requireOwner('Changing a rate needs the owner PIN'))) { renderCart(); return; }
    L[+p].rate = Math.max(0, r2(e.target.value)); L[+p].listRate = false;
  }
  saveCart(); renderCart();
}
function totals() {
  const c = S.cart;
  const sub = r2(c.lines.reduce((a, l) => a + l.rate * l.qty, 0));
  const disc = Math.min(Math.max(r2(c.discount), 0), sub);
  return { sub, disc, total: r2(sub - disc), qty: r2(c.lines.reduce((a, l) => a + l.qty, 0)) };
}
function renderCart(popIdx) {
  if (!$('#lines')) return;
  const c = S.cart, canRate = !locked();
  $$('#modeSeg [data-mode]').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === c.mode));
  if (!c.lines.length) {
    $('#lines').innerHTML = `<tbody><tr><td><div class="empty"><b>Ready to bill</b>${S.items.size ? 'Scan the first item, or type its name.' : 'Your item list is empty. Scan a barcode to add the item, or import your list from Items &amp; stock.'}</div></td></tr></tbody>`;
  } else {
    S.sel = Math.max(0, Math.min(S.sel, c.lines.length - 1));
    $('#lines').innerHTML = `<thead><tr><th style="width:42px">#</th><th>Item</th><th class="r" style="width:215px">Qty</th><th class="r" style="width:120px">Rate</th><th class="r" style="width:130px">Amount</th><th style="width:44px"></th></tr></thead>
    <tbody>${c.lines.map((l, i) => `<tr data-i="${i}" class="${i === S.sel ? 'sel' : ''}${i === popIdx ? ' pop' : ''}">
      <td class="muted num">${i + 1}</td>
      <td><div class="nm">${esc(l.name)}</div><div class="code">${esc(l.code)}</div></td>
      <td class="r"><span class="qtyctl"><button type="button" data-dec="${i}" tabindex="-1">−</button><input type="number" step="any" data-q="${i}" value="${l.qty}" aria-label="Quantity"><button type="button" data-inc="${i}" tabindex="-1">+</button></span> <span class="muted small">${esc(l.unit)}</span></td>
      <td class="r">${canRate ? `<input class="rate" type="number" step="any" data-p="${i}" value="${l.rate}" aria-label="Rate">` : `<span class="num">${money(l.rate)}</span>`}</td>
      <td class="r num"><b>${money(l.rate * l.qty)}</b></td>
      <td><button type="button" class="xbtn" data-rm="${i}" tabindex="-1" aria-label="Remove">×</button></td></tr>`).join('')}</tbody>`;
    if (popIdx != null) $$('#lines tbody tr')[popIdx]?.scrollIntoView({ block: 'nearest' });
  }
  renderTotals();
}
function renderTotals() {
  const c = S.cart, t = totals(), el = $('#totals');
  if (!el) return;
  const rec = r2(c.received), change = rec > 0 ? r2(rec - t.total) : null;
  const lb = S.lastBill;
  el.innerHTML = `
    <div class="totbox">
      <div class="totrow"><span class="muted">${c.lines.length} items · ${qf(t.qty)} qty</span><span class="num">${money(t.sub)}</span></div>
      <div class="totrow"><label for="disc">Discount ₹ <kbd>F8</kbd></label><input type="number" step="any" id="disc" value="${c.discount || ''}" placeholder="0"></div>
      <div class="grand"><div class="lbl">Total to pay</div><div class="v" id="grand">${money(t.total)}</div></div>
    </div>
    <div><div class="lbl" style="margin-bottom:6px">Payment</div>
      <div class="paygrid">${PAY.map(([k, l], i) => `<button type="button" data-pay="${k}" aria-pressed="${c.payment === k}">${l}<small>Alt+${i + 1}</small></button>`).join('')}</div></div>
    ${c.payment === 'cash' ? `<div class="totrow"><label for="recv">Cash received ₹</label><input type="number" step="any" id="recv" value="${c.received || ''}" placeholder="—"></div>
      ${change != null ? `<div class="change"><span>${change >= 0 ? 'Return to customer' : 'Still to collect'}</span><span class="num">${money(Math.abs(change))}</span></div>` : ''}` : ''}
    <div><div class="lbl" style="margin-bottom:6px">Customer <kbd>F7</kbd>${c.payment === 'udhaar' ? ' <span class="chip low">needed for udhaar</span>' : ''}</div>
      <div class="custgrid"><input type="text" id="cName" placeholder="Name" value="${esc(c.customer)}"><input type="tel" id="cPhone" placeholder="Phone" value="${esc(c.phone)}"></div></div>
    <div class="actions">
      <button type="button" class="btn primary big wide" id="savePrint" ${c.lines.length ? '' : 'disabled'}>Save &amp; print <kbd>F9</kbd></button>
      <button type="button" class="btn" id="saveOnly" ${c.lines.length ? '' : 'disabled'}>Save only <kbd>F10</kbd></button>
      <button type="button" class="btn" id="clearB" ${c.lines.length ? '' : 'disabled'}>Clear <kbd>Esc</kbd></button>
    </div>
    ${lb ? `<div class="lastbill"><span>Last bill <b>#${esc(lb.bill_no)}</b> · <span class="num">${money(lb.total)}</span></span><button type="button" class="btn" id="reprint">Reprint <kbd>Ctrl+P</kbd></button></div>` : ''}`;
  $('#disc').addEventListener('change', e => { c.discount = Math.max(0, r2(e.target.value)); saveCart(); renderTotals(); });
  $('#disc').addEventListener('keydown', e => { if (e.key === 'Enter') { e.target.blur(); focusScan(); } });
  $('#recv')?.addEventListener('input', e => { c.received = e.target.value; saveCart(); const ch = $('.change'); const rec2 = r2(e.target.value); if (rec2 > 0) { if (!ch) renderTotalsKeepFocus('recv'); else { const d = r2(rec2 - t.total); ch.innerHTML = `<span>${d >= 0 ? 'Return to customer' : 'Still to collect'}</span><span class="num">${money(Math.abs(d))}</span>`; } } else if (ch) ch.remove(); });
  $('#recv')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveBill(true); } });
  el.querySelector('.paygrid').addEventListener('click', e => { const b = e.target.closest('[data-pay]'); if (!b) return; c.payment = b.dataset.pay; saveCart(); renderTotals(); if (c.payment === 'udhaar' && !c.customer) $('#cName').focus(); else focusScan(); });
  $('#cName').addEventListener('input', e => { c.customer = e.target.value; saveCart(); });
  $('#cPhone').addEventListener('input', e => { c.phone = e.target.value; saveCart(); });
  for (const id of ['cName', 'cPhone']) $('#' + id).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); focusScan(); } });
  $('#savePrint').addEventListener('click', () => saveBill(true));
  $('#saveOnly').addEventListener('click', () => saveBill(false));
  $('#clearB').addEventListener('click', () => { clearArm = Date.now(); clearBill(); });
  $('#reprint')?.addEventListener('click', reprintLast);
}
function renderTotalsKeepFocus(id) { const pos = $('#' + id)?.selectionStart; renderTotals(); const el = $('#' + id); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (e) {} } }

let saving = false;
async function saveBill(print) {
  const c = S.cart;
  if (saving || !c.lines.length || modalOpen()) return;
  if (c.payment === 'udhaar' && !c.customer.trim()) { toast('Add the customer’s name for an udhaar bill.', { err: true }); $('#cName').focus(); return; }
  saving = true;
  try {
    const bill = await rpc('bills.save', {
      mode: c.mode, payment: c.payment, customer: c.customer, phone: c.phone, discount: totals().disc,
      lines: c.lines.map(l => ({ code: l.code, qty: l.qty, rate: l.rate, name: l.name, unit: l.unit, gst: l.gst })),
    });
    S.lastBill = bill;
    for (const l of bill.lines) { const it = S.items.get(l.code); if (it && it.stock != null) it.stock = r2(it.stock - l.qty * (l.factor || 1)); }
    S.cart = newCart(c); S.sel = 0; saveCart();
    renderCart(); focusScan();
    if (print) {
      toast(`Bill #${bill.bill_no} saved · ${money(bill.total)} · printing…`);
      rpc('print.receipt', bill.id).catch(err => toast(`Bill #${bill.bill_no} is saved, but it did not print: ${err.message}`, { err: true, ms: 9000, action: 'Retry', onAction: () => reprintLast() }));
    } else toast(`Bill #${bill.bill_no} saved · ${money(bill.total)}`);
  } catch (err) {
    toast(err.message, { err: true });
  } finally { saving = false; }
}
async function reprintLast() {
  const b = S.lastBill || await rpc('bills.last').catch(() => null);
  if (!b) { toast('No bills yet.'); return; }
  toast(`Reprinting bill #${b.bill_no}…`);
  rpc('print.receipt', b.id, true).catch(err => toast('Did not print: ' + err.message, { err: true, ms: 8000 }));
}

/* ================= item form ================= */
async function openItemForm(it, opts = {}) {
  const editing = !!(it && it.name != null);
  if (editing && !(await requireOwner('Editing an item needs the owner PIN'))) return;
  const units = ['pcs', 'pkt', 'box', 'dozen', 'set', 'roll', 'kg', 'g', 'mtr', 'ltr', 'pair'];
  const unit = it?.unit || 'pcs';
  const m = openModal(`
    <h2>${editing ? 'Edit item' : opts.fromBill ? 'New barcode' : 'Add item'}</h2>
    ${opts.fromBill ? `<p class="muted">Code <b class="num">${esc(it.code)}</b> is not in your item list. Add it once and it scans straight into bills after this.</p>` : ''}
    <form id="itemForm" class="form2" novalidate>
      <label class="f w"><span>Barcode / code</span><div style="display:flex;gap:8px"><input type="text" id="fCode" value="${esc(it?.code ?? '')}" autocomplete="off" spellcheck="false"><button type="button" class="btn" id="fGen" title="For items without a barcode">Make code</button></div></label>
      <label class="f w"><span>Item name</span><input type="text" id="fName" value="${esc(it?.name ?? '')}" placeholder="e.g. Metallic balloons, pack of 50"></label>
      <label class="f"><span>Retail price ₹ (incl. GST)</span><input type="number" step="any" id="fRetail" value="${it?.retail ?? ''}"></label>
      <label class="f"><span>Wholesale price ₹</span><input type="number" step="any" id="fWhole" value="${it?.wholesale || ''}" placeholder="Optional"></label>
      <label class="f"><span>Wholesale price is per</span><select id="fWUnit"><option value="">Same as retail unit</option>${['pcs', 'dozen', 'pkt', 'box', 'set', 'roll', 'kg', 'mtr', 'pair'].map(u => `<option${it?.wholesale_unit === u ? ' selected' : ''}>${u}</option>`).join('')}</select></label>
      <label class="f" id="fWQtyWrap"><span id="fWQtyLbl">Retail units in one wholesale unit</span><input type="number" step="any" id="fWQty" value="${it?.wholesale_qty && it.wholesale_qty !== 1 ? it.wholesale_qty : ''}" placeholder="e.g. 12"></label>
      <label class="f"><span>Stock in hand</span><input type="number" step="any" id="fStock" value="${it?.stock ?? ''}" placeholder="Blank = don’t track"></label>
      <label class="f"><span>Retail rate is per</span><select id="fUnit">${(units.includes(unit) ? units : [unit, ...units]).map(u => `<option${u === unit ? ' selected' : ''}>${esc(u)}</option>`).join('')}</select></label>
      <label class="f"><span>GST %</span><select id="fGst">${[0, 5, 12, 18, 28].map(g => `<option value="${g}"${(it?.gst ?? 18) == g ? ' selected' : ''}>${g}%</option>`).join('')}</select></label>
      <label class="f"><span>HSN code</span><input type="text" id="fHsn" value="${esc(it?.hsn ?? '')}" placeholder="Optional"></label>
      <label class="f"><span>Purchase price ₹</span><input type="number" step="any" id="fCost" value="${it?.cost || ''}" placeholder="Optional, for your reference"></label>
      <label class="f"><span>Low-stock alert at</span><input type="number" step="any" id="fMin" value="${it?.min_stock ?? ''}" placeholder="Default ${esc(S.settings.low_stock || 5)}"></label>
      <div class="err w" id="fErr"></div>
      <div class="foot w">
        ${editing ? '<button type="button" class="btn danger left" id="fDel">Remove item</button>' : ''}
        <button type="button" class="btn" data-close>Cancel</button>
        ${!opts.fromBill ? '<button type="button" class="btn" id="fSaveLabel">Save &amp; print labels</button>' : ''}
        <button type="submit" class="btn primary">${opts.fromBill ? 'Save &amp; add to bill' : 'Save item'}</button>
      </div>
      <div class="confirmbar w" id="fConfirm" hidden><span>Remove this item from your list? Old bills keep their copy.</span><button type="button" class="btn" id="fNo">Keep</button><button type="button" class="btn danger" id="fYes">Remove</button></div>
    </form>`);
  setTimeout(() => (it?.code ? $('#fName', m) : $('#fCode', m)).focus(), 30);
  const syncW = () => {
    const wu = $('#fWUnit', m).value, ru = $('#fUnit', m).value;
    const show = wu && wu !== ru;
    $('#fWQtyWrap', m).hidden = !show;
    $('#fWQtyLbl', m).textContent = `How many ${ru} in one ${wu}`;
    if (show && !$('#fWQty', m).value && wu === 'dozen' && ru === 'pcs') $('#fWQty', m).value = 12;
  };
  $('#fWUnit', m).addEventListener('change', syncW); $('#fUnit', m).addEventListener('change', syncW); syncW();
  $('#fGen', m).addEventListener('click', async () => { $('#fCode', m).value = await rpc('items.nextCode'); $('#fName', m).focus(); });
  $('#fDel', m)?.addEventListener('click', () => { $('#fConfirm', m).hidden = false; });
  $('#fNo', m)?.addEventListener('click', () => { $('#fConfirm', m).hidden = true; });
  $('#fYes', m)?.addEventListener('click', async () => {
    try { await rpc('items.remove', it.code); S.items.delete(it.code); closeModal(m); toast('Removed ' + it.name); refreshView(); }
    catch (err) { $('#fErr', m).textContent = err.message; }
  });
  const submit = async labels => {
    if ($('#fWUnit', m).value && $('#fWUnit', m).value !== $('#fUnit', m).value && !(+$('#fWQty', m).value > 0)) { $('#fErr', m).textContent = `Enter how many ${$('#fUnit', m).value} are in one ${$('#fWUnit', m).value}.`; return; }
    const item = {
      code: $('#fCode', m).value.trim(), name: $('#fName', m).value.trim(), retail: $('#fRetail', m).value, wholesale: $('#fWhole', m).value,
      stock: $('#fStock', m).value.trim(), unit: $('#fUnit', m).value,
      wholesale_unit: $('#fWUnit', m).value === $('#fUnit', m).value ? '' : $('#fWUnit', m).value,
      wholesale_qty: $('#fWUnit', m).value && $('#fWUnit', m).value !== $('#fUnit', m).value ? ($('#fWQty', m).value || 1) : 1, gst: $('#fGst', m).value, hsn: $('#fHsn', m).value, cost: $('#fCost', m).value, min_stock: $('#fMin', m).value.trim(),
    };
    try {
      const saved = await rpc('items.save', item, editing ? it.code : null);
      if (editing && it.code !== saved.code) S.items.delete(it.code);
      S.items.set(saved.code, saved);
      closeModal(m);
      if (opts.fromBill) addItem(saved, opts.qty || 1); else toast('Saved ' + saved.name);
      if (labels) openLabels(saved);
      if (S.view === 'items') renderItemRows();
    } catch (err) { $('#fErr', m).textContent = err.message; }
  };
  $('#itemForm', m).addEventListener('submit', e => { e.preventDefault(); submit(false); });
  $('#fSaveLabel', m)?.addEventListener('click', () => submit(true));
}

/* ---------- barcode labels ---------- */
S.labelQ = LS.get('labelQ', []);
const saveQ = () => { LS.set('labelQ', S.labelQ); const b = $('#qBtn'); if (b) b.textContent = `Label list (${S.labelQ.length})`; };
function rowsText(n, across) {
  if (across <= 1) return `${n} label${n === 1 ? '' : 's'}`;
  const rows = Math.ceil(n / across), blank = rows * across - n;
  return `${n} labels = ${rows} row${rows === 1 ? '' : 's'} of ${across}${blank ? ` · <b class="warn">${blank} label${blank === 1 ? '' : 's'} left blank</b>` : ' · no blanks'}`;
}
async function openLabels(it) {
  let info;
  try { info = await rpc('print.labelInfo', it.code); } catch (err) { toast(err.message, { err: true }); return; }
  const across = info.across;
  const def = across * Math.max(1, Math.ceil(Math.min(it.stock > 0 ? it.stock : 1, 300) / across));
  const m = openModal(`<h2>Print barcode labels</h2>
    <p><b>${esc(it.name)}</b> <span class="num muted">${esc(it.code)}</span></p>
    ${info.fits ? '' : `<div class="confirmbar" style="background:color-mix(in srgb,var(--warn) 14%,transparent)"><span><b>This code is too long for a ${esc(info.w)} mm label.</b> The bars come out too thin and scanners can’t read them. Give the item a short code like NR10023 and it will scan.</span><button type="button" class="btn" id="lShort">Use a short code</button></div>`}
    <div class="form2">
      <label class="f"><span>How many labels</span><input type="number" id="lCount" min="1" max="1000" value="${def}"></label>
      <div class="f"><span class="lbl">Roll</span><div style="padding-top:8px">${across} across · ${esc(info.w)} × ${esc(info.h)} mm</div></div>
<div class="w" style="display:flex;gap:18px;flex-wrap:wrap">
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="lRetail" ${S.settings.label_price !== '0' ? 'checked' : ''}> Show retail price</label>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="lWs" ${S.settings.label_wcode !== '0' ? 'checked' : ''}> Show wholesale code (${esc(S.settings.wcode_prefix ?? 'NRRL')})</label>
      </div>
      <p class="muted small w" id="lRows"></p>
      <p class="muted small w">To mix different items on the same sheet with no blank labels, use <b>Add to label list</b>, then print the whole list at once from Items &amp; stock.</p>
    </div>
    <div class="err" id="lErr"></div>
    <div class="foot"><button type="button" class="btn" data-close>Close</button><button type="button" class="btn" id="lAdd">Add to label list</button><button type="button" class="btn accent" id="lGo">Print now</button></div>`);
  const cnt = () => Math.max(1, parseInt($('#lCount', m).value, 10) || 1);
  const upd = () => { $('#lRows', m).innerHTML = rowsText(cnt(), across); };
  upd(); $('#lCount', m).addEventListener('input', upd);
  setTimeout(() => { $('#lCount', m).focus(); $('#lCount', m).select(); }, 30);
  $('#lShort', m)?.addEventListener('click', async () => {
    if (!(await requireOwner('Changing an item code needs the owner PIN'))) return;
    try {
      const code = await rpc('items.nextCode');
      const saved = await rpc('items.save', { ...it, code }, it.code);
      S.items.delete(it.code); S.items.set(saved.code, saved);
      S.labelQ = S.labelQ.map(q => q.code === it.code ? { ...q, code: saved.code } : q); saveQ();
      closeModal(m); toast(`${saved.name} now has code ${saved.code}`); renderItemRows(); openLabels(saved);
    } catch (err) { $('#lErr', m).textContent = err.message; }
  });
  $('#lAdd', m).addEventListener('click', () => {
    const q = S.labelQ.find(x => x.code === it.code);
    if (q) q.count += cnt(); else S.labelQ.push({ code: it.code, count: cnt() });
    saveQ(); closeModal(m); toast(`Added ${cnt()} labels of ${it.name} to the label list`);
  });
  const go = async () => {
    $('#lGo', m).disabled = true;
    try { await rpc('print.labels', [{ code: it.code, count: cnt() }], showOpts(m)); S.settings = await rpc('settings.get'); toast('Labels sent to printer'); closeModal(m); }
    catch (err) { $('#lErr', m).textContent = err.message; $('#lGo', m).disabled = false; }
  };
  $('#lGo', m).addEventListener('click', go);
  $('#lCount', m).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
}
const showOpts = m => ({ retail: $('#lRetail', m).checked, wholesale: $('#lWs', m).checked });
async function openLabelList() {
  const across = Math.max(1, parseInt(S.settings.label_across, 10) || 1);
  const m = openModal(`<h2>Label list</h2><div id="qBody"></div>
    <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:6px">
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="lRetail" ${S.settings.label_price !== '0' ? 'checked' : ''}> Show retail price</label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="lWs" ${S.settings.label_wcode !== '0' ? 'checked' : ''}> Show wholesale code (${esc(S.settings.wcode_prefix ?? 'NRRL')})</label>
    </div><div class="err" id="qErr"></div>
    <div class="foot"><button type="button" class="btn danger left" id="qClear">Clear list</button><button type="button" class="btn" data-close>Close</button><button type="button" class="btn accent" id="qGo">Print all</button></div>`, { wide: true });
  const draw = () => {
    S.labelQ = S.labelQ.filter(q => S.items.has(q.code));
    const total = S.labelQ.reduce((a, q) => a + q.count, 0);
    const blank = across > 1 ? (Math.ceil(total / across) * across - total) : 0;
    $('#qBody', m).innerHTML = !S.labelQ.length ? `<div class="empty"><b>The label list is empty</b>Click <b>Labels</b> on any item and choose <b>Add to label list</b>.</div>` : `
      <div class="tablewrap" style="max-height:50vh"><table class="grid"><thead><tr><th>Item</th><th>Code</th><th class="r" style="width:140px">Labels</th><th style="width:44px"></th></tr></thead>
      <tbody>${S.labelQ.map((q, i) => { const it = S.items.get(q.code); return `<tr><td><b>${esc(it.name)}</b></td><td class="num muted">${esc(it.code)}</td><td class="r"><input type="number" min="0" data-qi="${i}" value="${q.count}" style="width:90px;text-align:right"></td><td><button type="button" class="xbtn" data-qrm="${i}" aria-label="Remove">×</button></td></tr>`; }).join('')}</tbody></table></div>
      <p>${rowsText(total, across)}${blank ? ` <button type="button" class="btn" id="qFill">Fill the last row (+${blank} of the last item)</button>` : ''}</p>`;
    $('#qGo', m).disabled = !total;
    $('#qFill', m)?.addEventListener('click', () => { S.labelQ[S.labelQ.length - 1].count += blank; saveQ(); draw(); });
  };
  draw();
  $('#qBody', m).addEventListener('change', e => { const i = e.target.dataset.qi; if (i == null) return; S.labelQ[+i].count = Math.max(0, parseInt(e.target.value, 10) || 0); S.labelQ = S.labelQ.filter(q => q.count > 0); saveQ(); draw(); });
  $('#qBody', m).addEventListener('click', e => { const b = e.target.closest('[data-qrm]'); if (!b) return; S.labelQ.splice(+b.dataset.qrm, 1); saveQ(); draw(); });
  $('#qClear', m).addEventListener('click', () => { S.labelQ = []; saveQ(); draw(); });
  $('#qGo', m).addEventListener('click', async () => {
    $('#qGo', m).disabled = true;
    try { const n = await rpc('print.labels', S.labelQ, showOpts(m)); S.settings = await rpc('settings.get'); toast(`${n} labels sent to printer`); S.labelQ = []; saveQ(); closeModal(m); }
    catch (err) { $('#qErr', m).textContent = err.message; $('#qGo', m).disabled = false; }
  });
}

async function openStockIn(it) {
  if (!(await requireOwner('Adding stock needs the owner PIN'))) return;
  const hist = await rpc('items.history', it.code).catch(() => []);
  const KIND = { sale: 'Sold', purchase: 'Stock in', adjust: 'Adjusted', cancel: 'Bill cancelled', opening: 'Opening stock' };
  const m = openModal(`<h2>Add stock</h2>
    <p><b>${esc(it.name)}</b> · now <b class="num">${it.stock == null ? 'not tracked' : qf(it.stock) + ' ' + esc(it.unit)}</b></p>
    <form id="sForm" class="form2">
      <label class="f"><span>Quantity received</span><input type="number" step="any" id="sQty" placeholder="e.g. 50"></label>
      <label class="f"><span>Note (supplier, bill no.)</span><input type="text" id="sNote" placeholder="Optional"></label>
      <div class="err w" id="sErr"></div>
      <div class="foot w"><button type="button" class="btn" data-close>Close</button><button type="submit" class="btn primary">Add to stock</button></div>
    </form>
    ${hist.length ? `<div><div class="lbl" style="margin:6px 0">Recent stock movement</div><div class="tablewrap" style="max-height:220px"><table class="grid"><tbody>${hist.map(h => `<tr><td>${esc(fmtTime(h.at))}</td><td>${esc(KIND[h.kind] || h.kind)}${h.ref ? ` <span class="muted small">${esc(h.ref)}</span>` : ''}</td><td class="r num">${h.qty > 0 ? '+' : ''}${qf(h.qty)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}`);
  setTimeout(() => $('#sQty', m).focus(), 30);
  $('#sForm', m).addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const saved = await rpc('items.stockIn', it.code, $('#sQty', m).value, $('#sNote', m).value);
      S.items.set(saved.code, saved); closeModal(m); toast(`${saved.name}: stock now ${qf(saved.stock)}`); renderItemRows();
    } catch (err) { $('#sErr', m).textContent = err.message; }
  });
}

/* ================= items screen ================= */
let itemFilter = 'all';
function renderItems() {
  $('#v-items').innerHTML = `<div class="page">
    <div class="ph"><h1>Items &amp; stock</h1>
      <div class="toolbar">
        <button type="button" class="btn" id="qBtn">Label list (${S.labelQ.length})</button>
        <button type="button" class="btn" id="impBtn">Import CSV</button>
        <button type="button" class="btn" id="expBtn">Export CSV</button>
        <button type="button" class="btn primary" id="addBtn">+ Add item <kbd>Ins</kbd></button>
      </div></div>
    <div class="toolbar">
      <input type="search" id="itemQ" placeholder="Search name or code" value="${esc(LS.get('itemQ', ''))}">
      <div class="seg" id="itemSeg">${[['all', 'All'], ['low', 'Low stock'], ['nostock', 'Stock not tracked']].map(([k, l]) => `<button type="button" data-f="${k}" aria-pressed="${itemFilter === k}">${l}</button>`).join('')}</div>
      <span class="muted small" id="itemCount"></span>
    </div>
    <div class="tablewrap"><table class="grid" id="itemTable"></table></div></div>`;
  $('#addBtn').addEventListener('click', () => openItemForm(null));
  $('#impBtn').addEventListener('click', importCsv);
  $('#qBtn').addEventListener('click', openLabelList);
  $('#expBtn').addEventListener('click', exportItems);
  $('#itemQ').addEventListener('input', e => { LS.set('itemQ', e.target.value); renderItemRows(); });
  $('#itemSeg').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (!b) return; itemFilter = b.dataset.f; $$('#itemSeg button').forEach(x => x.setAttribute('aria-pressed', x === b)); renderItemRows(); });
  $('#itemTable').addEventListener('click', e => {
    const b = e.target.closest('button[data-act]'); const tr = e.target.closest('tr[data-code]');
    if (!tr) return;
    const it = S.items.get(tr.dataset.code); if (!it) return;
    if (!b) return openItemForm(it);
    if (b.dataset.act === 'stock') openStockIn(it);
    if (b.dataset.act === 'label') openLabels(it);
    if (b.dataset.act === 'edit') openItemForm(it);
  });
  renderItemRows();
  setTimeout(() => $('#itemQ')?.focus(), 30);
}
document.addEventListener('keydown', e => { if (e.key === 'Insert' && S.view === 'items' && !modalOpen()) { e.preventDefault(); openItemForm(null); } });
function stockChip(it) {
  if (it.stock == null) return '<span class="chip">—</span>';
  if (it.stock <= 0) return `<span class="chip out">${qf(it.stock)} ${esc(it.unit)}</span>`;
  if (it.stock <= lowLevel(it)) return `<span class="chip low">${qf(it.stock)} ${esc(it.unit)}</span>`;
  return `<span class="chip ok">${qf(it.stock)} ${esc(it.unit)}</span>`;
}
function renderItemRows() {
  const t = $('#itemTable'); if (!t) return;
  const q = ($('#itemQ')?.value || '').trim().toLowerCase();
  let list = [...S.items.values()];
  if (q) { const w = q.split(/\s+/); list = list.filter(it => { const h = (it.name + ' ' + it.code).toLowerCase(); return w.every(x => h.includes(x)); }); }
  if (itemFilter === 'low') list = list.filter(it => it.stock != null && it.stock <= lowLevel(it));
  if (itemFilter === 'nostock') list = list.filter(it => it.stock == null);
  list.sort((a, b) => a.name.localeCompare(b.name));
  const shown = list.slice(0, 600);
  $('#itemCount').textContent = `${list.length} of ${S.items.size} items${list.length > 600 ? ' · showing first 600, search to narrow' : ''}`;
  t.innerHTML = !S.items.size
    ? `<tbody><tr><td><div class="empty"><b>No items yet</b>Click <b>+ Add item</b>, import your list as a CSV, or just scan a barcode on the Billing screen to add it.</div></td></tr></tbody>`
    : !list.length ? `<tbody><tr><td><div class="empty">Nothing matches.</div></td></tr></tbody>`
    : `<thead><tr><th>Item</th><th>Code</th><th class="r">Retail</th><th class="r">Wholesale</th><th class="r">Stock</th><th class="r">GST</th><th class="r" style="width:250px"></th></tr></thead>
      <tbody>${shown.map(it => `<tr class="click" data-code="${esc(it.code)}">
        <td><b>${esc(it.name)}</b></td><td class="num muted">${esc(it.code)}</td>
        <td class="r num">${money(it.retail)}<span class="muted small">/${esc(it.unit)}</span></td><td class="r num">${+it.wholesale ? money(it.wholesale) + (it.wholesale_unit ? `<span class="muted small">/${esc(it.wholesale_unit)}</span>` : '') : '<span class="muted">—</span>'}</td>
        <td class="r">${stockChip(it)}</td><td class="r num muted">${qf(it.gst)}%</td>
        <td class="r"><button type="button" class="btn" data-act="stock">+ Stock</button> <button type="button" class="btn" data-act="label">Labels</button> <button type="button" class="btn" data-act="edit">Edit</button></td></tr>`).join('')}</tbody>`;
}

/* ================= CSV ================= */
function parseCSV(t) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',' || c === '\t' || c === ';' && !t.includes(',')) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.map(r => r.map(s => s.trim())).filter(r => r.some(Boolean));
}
const HEAD = {
  code: ['code', 'barcode', 'item code', 'sku', 'ean', 'item_code'],
  name: ['name', 'item', 'item name', 'product', 'description', 'item_name'],
  retail: ['retail', 'price', 'mrp', 'sale price', 'selling price', 'rate', 'sp'],
  wholesale: ['wholesale', 'wholesale price', 'dealer price', 'w price'],
  cost: ['cost', 'purchase', 'purchase price', 'cp', 'buy price'],
  stock: ['stock', 'qty', 'quantity', 'opening stock', 'closing stock'],
  unit: ['unit', 'uom'],
  gst: ['gst', 'gst %', 'gst%', 'tax', 'tax %'],
  hsn: ['hsn', 'hsn code', 'hsn/sac'],
  wholesale_unit: ['wholesale unit', 'w unit', 'wholesale per'],
  wholesale_qty: ['wholesale qty', 'pcs per wholesale', 'units per wholesale', 'qty per wholesale'],
};
function rowsToItems(rows) {
  if (!rows.length) return [];
  const head = rows[0].map(h => h.toLowerCase().replace(/[^a-z%/ _]/g, '').trim());
  let map = null;
  if (head.some(h => HEAD.name.includes(h) || HEAD.code.includes(h))) {
    map = {};
    for (const [k, names] of Object.entries(HEAD)) { const i = head.findIndex(h => names.includes(h)); if (i >= 0) map[k] = i; }
    rows = rows.slice(1);
  } else map = { code: 0, name: 1, retail: 2, wholesale: 3, stock: 4, unit: 5, gst: 6, hsn: 7, cost: 8 };
  const num = v => String(v ?? '').replace(/[₹,\s]|rs\.?/gi, '').replace(/%$/, '');
  return rows.map(r => ({
    code: r[map.code] ?? '', name: r[map.name] ?? '', retail: num(r[map.retail]), wholesale: num(r[map.wholesale]), cost: num(r[map.cost]),
    stock: map.stock != null ? num(r[map.stock]) : '', unit: (r[map.unit] || 'pcs').toLowerCase(),
    wholesale_unit: map.wholesale_unit != null ? String(r[map.wholesale_unit] || '').toLowerCase() : '', wholesale_qty: map.wholesale_qty != null ? num(r[map.wholesale_qty]) || 1 : 1, gst: map.gst != null && r[map.gst] !== '' ? num(r[map.gst]) : 18, hsn: r[map.hsn] ?? '',
  }));
}
async function importCsv() {
  if (S.items.size && !(await requireOwner('Importing items needs the owner PIN'))) return;
  const m = openModal(`<h2>Import items from Excel / CSV</h2>
    <p class="muted">In Excel, use <b>File → Save As → CSV</b>. The first row can be headings like <span class="num">Code, Name, Price, Wholesale, Stock, Unit, GST, HSN</span>. Items that already exist are updated; a blank stock keeps the current stock. Items with no barcode: leave Code blank and the app makes one.</p>
    <div class="err" id="iErr"></div>
    <div id="iPrev"></div>
    <div class="foot"><button type="button" class="btn" data-close>Close</button><button type="button" class="btn" id="iPick">Choose CSV file…</button><button type="button" class="btn primary" id="iGo" disabled>Import</button></div>`, { wide: true });
  let items = [];
  $('#iPick', m).addEventListener('click', async () => {
    try {
      const text = await rpc('file.openText'); if (text == null) return;
      items = rowsToItems(parseCSV(text));
      const noCode = items.filter(i => !String(i.code).trim() && String(i.name).trim()).length;
      $('#iPrev', m).innerHTML = `<p><b>${items.length}</b> rows found${noCode ? ` · ${noCode} without a code will get a new one` : ''}. First rows:</p>
        <div class="tablewrap" style="max-height:260px"><table class="grid"><thead><tr><th>Code</th><th>Name</th><th class="r">Retail</th><th class="r">Wholesale</th><th class="r">Stock</th><th>Unit</th><th class="r">GST</th></tr></thead>
        <tbody>${items.slice(0, 8).map(i => `<tr><td class="num">${esc(i.code) || '<span class="muted">new</span>'}</td><td>${esc(i.name)}</td><td class="r">${esc(i.retail)}</td><td class="r">${esc(i.wholesale)}</td><td class="r">${esc(i.stock)}</td><td>${esc(i.unit)}</td><td class="r">${esc(i.gst)}</td></tr>`).join('')}</tbody></table></div>`;
      $('#iGo', m).disabled = !items.length;
    } catch (err) { $('#iErr', m).textContent = err.message; }
  });
  $('#iGo', m).addEventListener('click', async () => {
    $('#iGo', m).disabled = true;
    try {
      for (const i of items) if (!String(i.code).trim() && String(i.name).trim()) i.code = await rpc('items.nextCode');
      const r = await rpc('items.import', items);
      await reloadItems();
      $('#iPrev', m).innerHTML = `<p><b>Imported ${r.imported} items.</b>${r.skipped ? ` Skipped ${r.skipped} rows.` : ''}</p>${r.errors.length ? `<p class="muted small">${r.errors.map(esc).join('<br>')}</p>` : ''}`;
      renderItemRows();
    } catch (err) { $('#iErr', m).textContent = err.message; $('#iGo', m).disabled = false; }
  });
}
const csvCell = v => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const toCsv = rows => rows.map(r => r.map(csvCell).join(',')).join('\r\n');
async function saveCsv(name, rows) {
  try { const p = await rpc('file.saveText', name, toCsv(rows)); if (p) toast('Saved ' + p); }
  catch (err) { toast(err.message, { err: true }); }
}
function exportItems() {
  saveCsv(`nrrl-items-${today()}.csv`, [['Code', 'Name', 'Retail', 'Wholesale', 'Stock', 'Unit', 'GST', 'HSN', 'Cost', 'Wholesale unit', 'Wholesale qty'],
    ...[...S.items.values()].map(i => [i.code, i.name, i.retail, i.wholesale, i.stock ?? '', i.unit, i.gst, i.hsn, i.cost, i.wholesale_unit || '', i.wholesale_unit ? i.wholesale_qty : ''])]);
}

/* ================= sales screen ================= */
const sales = { range: 'today', from: today(), to: today(), tab: 'bills', bills: [], items: [], sum: null };
function rangeDates(r) {
  const d = new Date(), t = ymd(d);
  if (r === 'today') return [t, t];
  if (r === 'yesterday') { d.setDate(d.getDate() - 1); const y = ymd(d); return [y, y]; }
  if (r === 'week') { const f = new Date(); f.setDate(f.getDate() - 6); return [ymd(f), t]; }
  if (r === 'month') return [ymd(new Date(d.getFullYear(), d.getMonth(), 1)), t];
  if (r === 'lastmonth') return [ymd(new Date(d.getFullYear(), d.getMonth() - 1, 1)), ymd(new Date(d.getFullYear(), d.getMonth(), 0))];
  return [sales.from, sales.to];
}
async function renderSales(reload = true) {
  const el = $('#v-sales');
  if (reload) {
    if (sales.range !== 'today' && locked() && !(await requireOwner('Older sales need the owner PIN'))) sales.range = 'today';
    [sales.from, sales.to] = rangeDates(sales.range);
    try {
      [sales.sum, sales.bills, sales.items] = await Promise.all([rpc('reports.summary', sales.from, sales.to), rpc('bills.list', sales.from, sales.to), rpc('reports.items', sales.from, sales.to)]);
    } catch (err) { toast(err.message, { err: true }); return; }
  }
  const s = sales.sum, pay = k => s.pay[k] ? s.pay[k].total : 0;
  el.innerHTML = `<div class="page">
    <div class="ph"><h1>Sales</h1>
      <div class="toolbar">
        <div class="seg" id="rangeSeg">${[['today', 'Today'], ['yesterday', 'Yesterday'], ['week', '7 days'], ['month', 'This month'], ['lastmonth', 'Last month'], ['custom', 'Dates']].map(([k, l]) => `<button type="button" data-r="${k}" aria-pressed="${sales.range === k}">${l}</button>`).join('')}</div>
        ${sales.range === 'custom' ? `<input type="date" id="dFrom" value="${sales.from}" style="width:150px"><input type="date" id="dTo" value="${sales.to}" style="width:150px"><button type="button" class="btn" id="dGo">Show</button>` : ''}
        <button type="button" class="btn" id="expSales">Export CSV</button>
      </div></div>
    <div class="stats">
      <div class="stat main"><div class="lbl">Total sales</div><div class="v">${money(s.total)}</div></div>
      <div class="stat"><div class="lbl">Bills</div><div class="v">${s.bills}${s.cancelled ? ` <span class="chip out">${s.cancelled} cancelled</span>` : ''}</div></div>
      <div class="stat"><div class="lbl">Cash</div><div class="v">${money(pay('cash'))}</div></div>
      <div class="stat"><div class="lbl">UPI</div><div class="v">${money(pay('upi'))}</div></div>
      <div class="stat"><div class="lbl">Card</div><div class="v">${money(pay('card'))}</div></div>
      <div class="stat"><div class="lbl">Udhaar</div><div class="v">${money(pay('udhaar'))}</div></div>
      <div class="stat"><div class="lbl">GST included</div><div class="v">${money(s.gst)}</div></div>
    </div>
    <div class="toolbar"><div class="seg" id="tabSeg"><button type="button" data-t="bills" aria-pressed="${sales.tab === 'bills'}">Bills (${sales.bills.length})</button><button type="button" data-t="items" aria-pressed="${sales.tab === 'items'}">Item-wise (${sales.items.length})</button></div>
      <span class="muted small">${sales.from === sales.to ? sales.from.split('-').reverse().join('/') : sales.from.split('-').reverse().join('/') + ' to ' + sales.to.split('-').reverse().join('/')}</span></div>
    <div class="tablewrap"><table class="grid" id="salesTable">${sales.tab === 'bills' ? billsTable() : itemsTable()}</table></div></div>`;
  $('#rangeSeg').addEventListener('click', e => { const b = e.target.closest('[data-r]'); if (!b) return; sales.range = b.dataset.r; if (sales.range === 'custom') renderSales(false); else renderSales(); });
  $('#dGo')?.addEventListener('click', () => { sales.from = $('#dFrom').value || today(); sales.to = $('#dTo').value || sales.from; if (sales.to < sales.from) [sales.from, sales.to] = [sales.to, sales.from]; renderSales(); });
  $('#tabSeg').addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (!b) return; sales.tab = b.dataset.t; renderSales(false); });
  $('#expSales').addEventListener('click', exportSales);
  $('#salesTable').addEventListener('click', e => { const tr = e.target.closest('tr[data-id]'); if (tr) openBill(+tr.dataset.id); });
}
function billsTable() {
  if (!sales.bills.length) return `<tbody><tr><td><div class="empty"><b>No bills</b>Bills for these dates will show here.</div></td></tr></tbody>`;
  return `<thead><tr><th>Bill</th><th>Time</th><th>Customer</th><th class="r">Items</th><th>Payment</th><th class="r">Discount</th><th class="r">Total</th></tr></thead>
    <tbody>${sales.bills.map(b => `<tr class="click${b.cancelled ? ' cx' : ''}" data-id="${b.id}">
      <td class="num"><b>${esc(b.bill_no)}</b></td><td>${esc(fmtTime(b.created_at))}</td>
      <td>${esc(b.customer || 'Walk-in')}${b.mode === 'wholesale' ? ' <span class="chip acc">Wholesale</span>' : ''}${b.cancelled ? ' <span class="chip out">Cancelled</span>' : ''}</td>
      <td class="r num">${b.items_count}</td><td>${b.payment === 'udhaar' ? '<span class="chip low">Udhaar</span>' : esc(PAYNAME[b.payment] || b.payment)}</td>
      <td class="r num">${+b.discount ? money(b.discount) : ''}</td><td class="r num"><b>${money(b.total)}</b></td></tr>`).join('')}</tbody>`;
}
function itemsTable() {
  if (!sales.items.length) return `<tbody><tr><td><div class="empty"><b>Nothing sold</b>Item-wise sales for these dates will show here.</div></td></tr></tbody>`;
  return `<thead><tr><th>Item</th><th>Code</th><th class="r">Qty sold</th><th class="r">Bills</th><th class="r">Amount</th></tr></thead>
    <tbody>${sales.items.map(i => `<tr><td><b>${esc(i.name)}</b></td><td class="num muted">${esc(i.code)}</td><td class="r num">${qf(i.qty)} ${esc(i.unit)}</td><td class="r num">${i.bills}</td><td class="r num"><b>${money(i.amount)}</b></td></tr>`).join('')}</tbody>`;
}
async function exportSales() {
  if (sales.tab === 'items') return saveCsv(`nrrl-itemwise-${sales.from}_to_${sales.to}.csv`, [['Code', 'Item', 'Qty', 'Unit', 'Bills', 'Amount'], ...sales.items.map(i => [i.code, i.name, i.qty, i.unit, i.bills, i.amount])]);
  const rows = [['Bill No', 'Date time', 'Customer', 'Phone', 'Payment', 'Rate list', 'Items', 'Qty', 'Subtotal', 'Discount', 'Total', 'GST incl.', 'Status']];
  for (const b of sales.bills) rows.push([b.bill_no, b.created_at, b.customer, b.phone, PAYNAME[b.payment] || b.payment, b.mode, b.items_count, b.qty, b.subtotal, b.discount, b.total, b.gst, b.cancelled ? 'Cancelled' : 'OK']);
  saveCsv(`nrrl-bills-${sales.from}_to_${sales.to}.csv`, rows);
}
async function openBill(id) {
  let b, html;
  try { [b, html] = await Promise.all([rpc('bills.get', id), rpc('print.preview', id, true)]); }
  catch (err) { toast(err.message, { err: true }); return; }
  const m = openModal(`<h2>Bill #${esc(b.bill_no)}${b.cancelled ? ' <span class="chip out">Cancelled</span>' : ''}</h2>
    <div class="preview">
      <div>
        <p class="muted">${esc(fmtTime(b.created_at))} · ${esc(b.customer || 'Walk-in')}${b.phone ? ' · ' + esc(b.phone) : ''} · ${esc(PAYNAME[b.payment])}</p>
        <div class="tablewrap" style="max-height:360px"><table class="grid"><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
          <tbody>${b.lines.map(l => `<tr><td>${esc(l.name)}<div class="muted small num">${esc(l.code)}</div></td><td class="r num">${qf(l.qty)} ${esc(l.unit)}</td><td class="r num">${money(l.rate)}</td><td class="r num">${money(l.amount)}</td></tr>`).join('')}</tbody></table></div>
        <p style="margin-top:10px">Subtotal <b class="num">${money(b.subtotal)}</b>${+b.discount ? ` · Discount <b class="num">${money(b.discount)}</b>` : ''} · Total <b class="num">${money(b.total)}</b></p>
        <div class="err" id="bErr"></div>
        <div class="confirmbar" id="bConfirm" hidden><span>Cancel bill #${esc(b.bill_no)}? Its items go back into stock. The bill stays in the records marked cancelled.</span><button type="button" class="btn" id="bNo">Keep bill</button><button type="button" class="btn danger" id="bYes">Cancel bill</button></div>
      </div>
      <iframe title="Receipt preview" sandbox srcdoc="${esc(html)}"></iframe>
    </div>
    <div class="foot">${b.cancelled ? '' : '<button type="button" class="btn danger left" id="bCancel">Cancel bill</button>'}<button type="button" class="btn" data-close>Close</button><button type="button" class="btn accent" id="bPrint">Reprint</button></div>`, { wide: true });
  $('#bPrint', m).addEventListener('click', () => rpc('print.receipt', b.id, true).then(() => toast('Sent to printer')).catch(err => { $('#bErr', m).textContent = err.message; }));
  $('#bCancel', m)?.addEventListener('click', async () => { if (await requireOwner('Cancelling a bill needs the owner PIN')) $('#bConfirm', m).hidden = false; });
  $('#bNo', m)?.addEventListener('click', () => { $('#bConfirm', m).hidden = true; });
  $('#bYes', m)?.addEventListener('click', async () => {
    try { await rpc('bills.cancel', b.id); await reloadItems(); closeModal(m); toast(`Bill #${b.bill_no} cancelled, stock restored`); renderSales(); }
    catch (err) { $('#bErr', m).textContent = err.message; }
  });
}

/* ================= settings ================= */
async function renderSettings() {
  const s = S.settings;
  const [info, backups] = await Promise.all([rpc('app.info'), rpc('backup.list').catch(() => [])]);
  if (!S.printers) S.printers = await rpc('printers.list').catch(() => []);
  const opt = (sel) => [`<option value="">Windows default printer</option>`, ...S.printers.map(p => `<option value="${esc(p.name)}"${p.name === sel ? ' selected' : ''}>${esc(p.label)}${p.isDefault ? ' (default)' : ''}</option>`)].join('');
  $('#v-settings').innerHTML = `<div class="settings"><h1>Settings</h1><div class="cards">
    <section class="card"><h2>Shop details on the receipt</h2>
      <div class="form2">
        <label class="f w"><span>Shop name</span><input type="text" id="s_shop_name" value="${esc(s.shop_name)}"></label>
        <label class="f w"><span>Address (each line prints on its own line)</span><textarea id="s_shop_address" rows="2">${esc(s.shop_address)}</textarea></label>
        <label class="f"><span>Phone</span><input type="text" id="s_shop_phone" value="${esc(s.shop_phone)}"></label>
        <label class="f"><span>GSTIN (leave blank if not registered)</span><input type="text" id="s_gstin" value="${esc(s.gstin)}"></label>
        <label class="f w"><span>Message at the bottom</span><textarea id="s_footer" rows="2">${esc(s.footer)}</textarea></label>
        <label class="f"><span>Bill number prefix</span><input type="text" id="s_bill_prefix" value="${esc(s.bill_prefix)}" placeholder="e.g. NR-"></label>
        <label class="f"><span>Next bill number</span><input type="number" id="s_next_bill" value="${esc(s.next_bill)}"></label>
      </div></section>
    <section class="card"><h2>Receipt printer</h2>
      <div class="form2">
        <label class="f w"><span>Printer</span><select id="s_printer">${opt(s.printer)}</select></label>
        <label class="f"><span>Paper width</span><select id="s_paper"><option value="80"${s.paper !== '58' ? ' selected' : ''}>80 mm (3 inch)</option><option value="58"${s.paper === '58' ? ' selected' : ''}>58 mm (2 inch)</option></select></label>
        <label class="f"><span>Copies per bill</span><select id="s_copies">${[1, 2, 3].map(n => `<option${+s.copies === n ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="f"><span>Side margin (mm)</span><input type="number" step="0.5" id="s_print_margin" value="${esc(s.print_margin)}" placeholder="Auto"></label>
        <label class="f"><span>Text size (px)</span><input type="number" step="0.5" id="s_font_size" value="${esc(s.font_size)}" placeholder="Auto"></label>
      </div>
      <div class="toolbar"><button type="button" class="btn" id="testPrint">Print test receipt</button><button type="button" class="btn" id="prevPrint">Preview</button><button type="button" class="btn" id="refPrinters">Refresh printer list</button></div></section>
    <section class="card"><h2>Barcode labels</h2>
      <p class="muted">For items without a barcode: click <b>Make code</b> on the item, then print labels and stick them on the packet or bin.</p>
      <div class="form2">
        <label class="f w"><span>Label printer</span><select id="s_label_printer">${opt(s.label_printer).replace('Windows default printer', 'Same as receipt printer')}</select></label>
        <label class="f w"><span>How to print labels</span><select id="s_label_mode"><option value="tspl"${s.label_mode === 'tspl' ? ' selected' : ''}>Send commands to the label printer (sharpest — TSC, TVS, Xprinter, most barcode printers)</option><option value="windows"${s.label_mode !== 'tspl' ? ' selected' : ''}>Through the Windows printer driver (any printer)</option></select></label>
        <label class="f"><span>Labels across the roll</span><select id="s_label_across">${[1, 2, 3, 4].map(n => `<option value="${n}"${(+s.label_across || 1) === n ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="f"><span>Gap between labels (mm)</span><input type="number" step="0.5" id="s_label_gap" value="${esc(s.label_gap)}"></label>
        <label class="f"><span>One label width (mm)</span><input type="number" step="0.5" id="s_label_w" value="${esc(s.label_w)}"></label>
        <label class="f"><span>One label height (mm)</span><input type="number" step="0.5" id="s_label_h" value="${esc(s.label_h)}"></label>
        <label class="f"><span>Printer resolution</span><select id="s_label_dpi"><option value="203"${s.label_dpi !== '300' ? ' selected' : ''}>203 dpi (most printers)</option><option value="300"${s.label_dpi === '300' ? ' selected' : ''}>300 dpi</option></select></label>
        <label class="f"><span>Bar thickness</span><select id="s_label_bar">${[['', 'Automatic'], ['2', 'Thin'], ['3', 'Medium'], ['4', 'Thick']].map(([v, l]) => `<option value="${v}"${(s.label_bar || '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="f"><span>Gap between rows (mm)</span><input type="number" step="0.5" id="s_label_vgap" value="${esc(s.label_vgap)}" placeholder="2"></label>
        <label class="f"><span>Print darkness (0–15)</span><input type="number" min="0" max="15" id="s_label_density" value="${esc(s.label_density)}" placeholder="10"></label>
        <label class="f" style="flex-direction:row;align-items:center;gap:8px;padding-top:18px"><input type="checkbox" id="s_label_flip" ${s.label_flip === '1' ? 'checked' : ''}> <span style="text-transform:none;letter-spacing:0;font-size:14px;color:var(--fg);font-weight:500">Print upside down</span></label>
        <label class="f"><span>Move print right (mm)</span><input type="number" step="0.5" id="s_label_shift" value="${esc(s.label_shift)}" placeholder="0"></label>
        <label class="f w" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="s_label_price" ${s.label_price !== '0' ? 'checked' : ''}> <span style="text-transform:none;letter-spacing:0;font-size:14px;color:var(--fg);font-weight:500">Show price on label</span></label>
        <label class="f w" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="s_label_wcode" ${s.label_wcode !== '0' ? 'checked' : ''}> <span style="text-transform:none;letter-spacing:0;font-size:14px;color:var(--fg);font-weight:500">Show wholesale rate as a code</span></label>
        <label class="f"><span>Wholesale code starts with</span><input type="text" id="s_wcode_prefix" value="${esc(s.wcode_prefix ?? 'NRRL')}"></label>
        <label class="f"><span>Wholesale code = wholesale rate ×</span><input type="number" step="any" id="s_wcode_mult" value="${esc(s.wcode_mult || '2')}"></label>
        <p class="muted small w" id="wcodeEx"></p>
        <label class="f"><span>Low-stock alert at (default)</span><input type="number" id="s_low_stock" value="${esc(s.low_stock)}"></label>
        <p class="muted small w">The size is printed on the roll’s box, e.g. “38×25 mm, 3 up”. If the print sits off the labels, change the gap or move it left/right (negative moves it left).</p>
      </div>
      <div class="toolbar"><button type="button" class="btn" id="prevLabel">Preview one row</button><button type="button" class="btn" id="testLabel">Print one test row</button></div></section>
    <section class="card"><h2>Data &amp; backups</h2>
      <p>All your items and bills are saved on this laptop in:</p><div class="path">${esc(info.dbFile)}</div>
      <p>A backup copy is made when the app opens, every 30 minutes while you work, and when you close it. The last 60 copies are kept in:</p><div class="path">${esc(info.backupDir)}</div>
      <p class="muted">Last backup: <b>${info.lastBackup ? esc(new Date(info.lastBackup).toLocaleString('en-IN')) : 'not yet'}</b> · ${backups.length} copies · ${info.counts.items} items · ${info.counts.bills} bills</p>
      <label class="f"><span>Second backup folder (pen drive, Google Drive, OneDrive)</span>
        <div style="display:flex;gap:8px"><input type="text" id="s_backup_extra" value="${esc(s.backup_extra)}" placeholder="Not set" readonly><button type="button" class="btn" id="pickExtra">Choose…</button>${s.backup_extra ? '<button type="button" class="btn" id="clearExtra">Remove</button>' : ''}</div></label>
      <div class="toolbar"><button type="button" class="btn accent" id="bkNow">Back up now</button><button type="button" class="btn" id="bkOpen">Open backup folder</button><button type="button" class="btn" id="dataOpen">Open data folder</button><button type="button" class="btn danger" id="bkRestore">Restore a backup…</button></div>
      <div class="confirmbar" id="rConfirm" hidden><span>Restoring replaces all current items and bills with the backup you choose. A copy of the current data is saved first.</span><button type="button" class="btn" id="rNo">Cancel</button><button type="button" class="btn danger" id="rYes">Choose backup</button></div></section>
    <section class="card" id="linkCard"><h2>Phone app link (NRRL Counter)</h2>
      <div id="linkBody"><p class="muted">Loading…</p></div></section>
    <section class="card" id="sheetCard"><h2>Google Sheet — see sales live on your phone</h2>
      <div id="sheetBody"><p class="muted">Loading…</p></div></section>
    <section class="card"><h2>Owner PIN</h2>
      <p class="muted">With a PIN set, staff can bill and add new items, but these need the PIN: changing prices or rates, editing or removing items, adding stock, cancelling bills, sales older than today, and Settings.</p>
      <div class="form2">
        ${s.hasPin ? '<label class="f"><span>Current PIN</span><input type="password" id="pOld" inputmode="numeric" maxlength="8"></label>' : ''}
        <label class="f"><span>${s.hasPin ? 'New PIN (blank = remove PIN)' : 'New PIN (4–8 digits)'}</span><input type="password" id="pNew" inputmode="numeric" maxlength="8"></label>
      </div>
      <div class="err" id="pErr"></div>
      <div class="toolbar"><button type="button" class="btn" id="pSave">${s.hasPin ? 'Change PIN' : 'Set PIN'}</button></div></section>
    </div>
    <div class="toolbar" style="position:sticky;bottom:0;padding:14px 0 0;background:var(--bg);margin-top:14px"><button type="button" class="btn primary big" id="sSave" style="min-width:220px">Save settings</button><span class="muted small" id="sMsg"></span><span class="muted small" style="margin-left:auto">NRRL Billing v${esc(info.version)}</span></div>
  </div>`;
  const keys = ['shop_name', 'shop_address', 'shop_phone', 'gstin', 'footer', 'bill_prefix', 'next_bill', 'printer', 'paper', 'copies', 'print_margin', 'font_size', 'label_printer', 'label_w', 'label_h', 'low_stock', 'label_across', 'label_gap', 'label_dpi', 'label_bar', 'label_shift', 'label_mode', 'label_vgap', 'label_density', 'wcode_prefix', 'wcode_mult'];
  const collect = () => {
    const o = {}; for (const k of keys) o[k] = $('#s_' + k).value;
    o.label_price = $('#s_label_price').checked ? '1' : '0'; o.label_flip = $('#s_label_flip').checked ? '1' : '0'; o.label_wcode = $('#s_label_wcode').checked ? '1' : '0';
    return o;
  };
  const save = async quiet => {
    try { S.settings = await rpc('settings.save', collect()); if (!quiet) { toast('Settings saved'); $('#sMsg').textContent = 'Saved'; } return true; }
    catch (err) { toast(err.message, { err: true }); return false; }
  };
  const wEx = () => { const m2 = +$('#s_wcode_mult').value || 2; $('#wcodeEx').textContent = `Example: wholesale ₹45 per dozen prints as ${$('#s_wcode_prefix').value}${Math.round(45 * m2 * 100) / 100}/doz. Only your staff know to read it as ₹45.`; };
  $('#s_wcode_prefix').addEventListener('input', wEx); $('#s_wcode_mult').addEventListener('input', wEx); wEx();
  $('#sSave').addEventListener('click', () => save(false));
  $('#testPrint').addEventListener('click', async () => { if (!(await save(true))) return; rpc('print.test').then(() => toast('Test receipt sent')).catch(err => toast(err.message, { err: true, ms: 9000 })); });
  $('#prevPrint').addEventListener('click', async () => { if (!(await save(true))) return; const html = await rpc('print.preview', 'sample'); openModal(`<h2>Receipt preview</h2><p class="muted">Paper ${esc(S.settings.paper)} mm. The real print may look slightly different depending on the printer.</p><div style="display:flex;justify-content:center"><iframe title="Receipt preview" sandbox srcdoc="${esc(html)}" style="border:1px solid var(--line);width:${S.settings.paper === '58' ? 240 : 330}px;height:560px;background:#fff"></iframe></div><div class="foot"><button type="button" class="btn" data-close>Close</button></div>`); });
  $('#prevLabel').addEventListener('click', async () => {
    if (!(await save(true))) return;
    const first = S.items.values().next().value;
    const [html, info] = await Promise.all([rpc('print.labelPreview', first ? first.code : ''), rpc('print.labelInfo', first ? first.code : '')]);
    const k = 3.78, w = Math.round(info.pageW * k), h = Math.round(info.h * k), sc = Math.min(2.2, 760 / w);
    openModal(`<h2>Label preview</h2><p class="muted">One row of the roll: ${info.across} × ${esc(info.w)} × ${esc(info.h)} mm. Bars are ${info.moduleMm.toFixed(2)} mm (${info.dots} printer dots) wide${info.fits ? '.' : ' — <b>too thin to scan; use a shorter code or a wider label</b>.'}</p>
      <div style="display:flex;justify-content:center;padding:16px;background:var(--sunk);border-radius:8px;overflow:auto"><div style="width:${Math.round(w * sc)}px;height:${Math.round(h * sc)}px"><iframe title="Label preview" sandbox srcdoc="${esc(html)}" style="border:0;width:${w}px;height:${h}px;background:#fff;transform:scale(${sc});transform-origin:0 0"></iframe></div></div>
      <div class="foot"><button type="button" class="btn" data-close>Close</button></div>`, { wide: true });
  });
  $('#testLabel').addEventListener('click', async () => { if (!(await save(true))) return; rpc('print.testLabel').then(() => toast('Test row sent to label printer')).catch(err => toast(err.message, { err: true, ms: 9000 })); });
  $('#refPrinters').addEventListener('click', async () => { S.printers = await rpc('printers.list').catch(() => []); await save(true); renderSettings(); });
  $('#pickExtra').addEventListener('click', async () => { const p = await rpc('backup.chooseExtra'); if (p) { S.settings = await rpc('settings.get'); renderSettings(); toast('Backups will also be copied to ' + p); } });
  $('#clearExtra')?.addEventListener('click', async () => { S.settings = await rpc('settings.save', { backup_extra: '' }); renderSettings(); });
  $('#bkNow').addEventListener('click', async () => {
    try { const r = await rpc('backup.now'); toast(r.extraOk === false ? 'Backed up on this laptop, but the second folder could not be reached.' : 'Backup saved', { err: r.extraOk === false }); renderBackupState(); renderSettings(); }
    catch (err) { toast(err.message, { err: true }); }
  });
  $('#bkOpen').addEventListener('click', () => rpc('backup.openFolder'));
  $('#dataOpen').addEventListener('click', () => rpc('app.openDataFolder'));
  $('#bkRestore').addEventListener('click', () => { $('#rConfirm').hidden = false; });
  $('#rNo').addEventListener('click', () => { $('#rConfirm').hidden = true; });
  $('#rYes').addEventListener('click', async () => {
    try {
      const ok = await rpc('backup.restore');
      if (!ok) return;
      S.settings = await rpc('settings.get'); await reloadItems(); S.cart = newCart(); saveCart(); S.lastBill = null;
      toast('Backup restored'); renderSettings();
    } catch (err) { toast(err.message, { err: true }); }
  });
  renderSheetCard(); renderLinkCard();
  $('#pSave').addEventListener('click', async () => {
    try {
      const has = await rpc('auth.setPin', $('#pOld')?.value || '', $('#pNew').value);
      S.settings = await rpc('settings.get'); S.unlockedUntil = has ? Date.now() + 15 * 60e3 : 0;
      toast(has ? 'Owner PIN saved' : 'Owner PIN removed'); renderLock(); renderSettings();
    } catch (err) { $('#pErr').textContent = err.message; }
  });
}
async function renderLinkCard() {
  const el = $('#linkBody'); if (!el) return;
  let st; try { st = await rpc('link.status'); } catch (e) { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  if (st.linked) {
    el.innerHTML = `<p>Linked. This laptop and the phone app share one item list, stock and sales. Changes on either side show on the other within about 15 seconds.</p>
      <p class="${st.lastError ? 'err' : 'muted'}">${st.lastError ? esc(st.lastError) + (st.pending ? ` · ${st.pending} changes waiting, will retry` : '') : (st.lastOk ? 'Last synced ' + esc(new Date(st.lastOk).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', second: '2-digit' })) : 'Linked') + (st.pending ? ` · ${st.pending} changes waiting` : ' · up to date')}</p>
      <div class="toolbar"><button type="button" class="btn accent" id="lkNow">Sync now</button><button type="button" class="btn danger" id="lkOff">Unlink</button></div>
      <div class="confirmbar" id="lkConfirm" hidden><span>Unlink this laptop from the phone app? Both keep their own data, but stop updating each other.</span><button type="button" class="btn" id="lkNo">Keep linked</button><button type="button" class="btn danger" id="lkYes">Unlink</button></div>`;
    $('#lkNow').addEventListener('click', async () => { $('#lkNow').disabled = true; try { await rpc('link.now'); } catch (e) {} renderLinkCard(); });
    $('#lkOff').addEventListener('click', () => { $('#lkConfirm').hidden = false; });
    $('#lkNo').addEventListener('click', () => { $('#lkConfirm').hidden = true; });
    $('#lkYes').addEventListener('click', async () => { await rpc('link.unlink'); toast('Unlinked from the phone app'); renderLinkCard(); });
    return;
  }
  el.innerHTML = `<p>Link once, and bills, items and stock stay the same on this laptop and in the NRRL Counter phone app.</p>
    <p class="muted small">On the first link, this laptop’s items and stock are copied to the phone app, and items only the phone app has are added here. Needs internet.</p>
    <div class="form2"><label class="f"><span>Owner</span><select id="lkOwner"><option>Loading…</option></select></label>
      <label class="f"><span>Owner PIN (phone app)</span><input type="password" id="lkPin" inputmode="numeric" maxlength="8"></label></div>
    <div class="toolbar"><button type="button" class="btn accent" id="lkGo">Link with phone app</button><span class="muted small" id="lkProg"></span></div>
    <p class="err" id="lkErr"></p>`;
  try {
    const owners = await rpc('link.owners');
    $('#lkOwner').innerHTML = owners.map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('') || '<option value="">No owner found</option>';
  } catch (e) { $('#lkErr').textContent = e.message; }
  $('#lkGo').addEventListener('click', async () => {
    $('#lkErr').textContent = ''; $('#lkGo').disabled = true;
    try {
      const r = await rpc('link.connect', $('#lkOwner').value, $('#lkPin').value);
      await reloadItems();
      toast(`Linked. Sent ${r.items} items and ${r.bills} bills to the phone app.`);
      renderLinkCard();
    } catch (e) { $('#lkErr').textContent = e.message; $('#lkGo').disabled = false; $('#lkProg').textContent = ''; }
  });
}
async function renderSheetCard() {
  const el = $('#sheetBody'); if (!el) return;
  let st; try { st = await rpc('sync.status'); } catch (e) { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  if (st.url) {
    el.innerHTML = `<p>Connected. Every bill appears in your sheet within about 15 seconds, and the item list with stock updates every minute. Open the sheet in the Google Sheets app on your phone to watch it.</p>
      <p class="${st.lastError ? 'err' : 'muted'}">${st.lastError ? 'Last try failed: ' + esc(st.lastError) + (st.pending ? ` · ${st.pending} waiting, will retry` : '') : (st.lastOk ? 'Last sent ' + esc(new Date(st.lastOk).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })) : 'Connected') + (st.pending ? ` · ${st.pending} waiting to send` : ' · all sent')}</p>
      <div class="toolbar"><button type="button" class="btn accent" id="shNow">Send now</button><button type="button" class="btn danger" id="shOff">Disconnect</button></div>
      <div class="confirmbar" id="shConfirm" hidden><span>Stop sending to the Google Sheet? What’s already in the sheet stays there.</span><button type="button" class="btn" id="shNo">Keep</button><button type="button" class="btn danger" id="shYes">Disconnect</button></div>`;
    $('#shNow').addEventListener('click', async () => { $('#shNow').disabled = true; try { await rpc('sync.now'); } catch (e) {} renderSheetCard(); });
    $('#shOff').addEventListener('click', () => { $('#shConfirm').hidden = false; });
    $('#shNo').addEventListener('click', () => { $('#shConfirm').hidden = true; });
    $('#shYes').addEventListener('click', async () => { await rpc('sync.disconnect'); toast('Disconnected from Google Sheet'); renderSheetCard(); });
    return;
  }
  el.innerHTML = `<p class="muted">One-time setup, about 5 minutes. Do it on this laptop.</p>
    <ol style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px">
      <li><button type="button" class="btn" id="shCopy">Copy setup script</button></li>
      <li>Open <a href="https://sheets.new" target="_blank" rel="noopener">sheets.new</a> (a new Google Sheet). Name it <b>NRRL Sales</b>.</li>
      <li>In the sheet: <b>Extensions → Apps Script</b>. Delete what’s there, paste (Ctrl+V), click <b>Save</b>.</li>
      <li>Click <b>Deploy → New deployment</b> → gear icon → <b>Web app</b>. Set <b>Execute as: Me</b> and <b>Who has access: Anyone</b>. Click <b>Deploy</b>, then <b>Authorize access</b>. If Google says the app isn’t verified, click <b>Advanced → Go to … (unsafe) → Allow</b>. It’s your own script.</li>
      <li>Copy the <b>Web app URL</b> (ends with /exec) and paste it here:</li>
    </ol>
    <div style="display:flex;gap:8px"><input type="text" id="shUrl" placeholder="https://script.google.com/macros/s/…/exec" spellcheck="false"><button type="button" class="btn accent" id="shGo">Connect</button></div>
    <p class="err" id="shErr"></p>`;
  $('#shCopy').addEventListener('click', async () => {
    try { await rpc('clipboard.write', await rpc('sync.script')); toast('Setup script copied. Paste it into Apps Script.'); $('#shCopy').textContent = 'Copied ✓'; }
    catch (e) { toast(e.message, { err: true }); }
  });
  $('#shGo').addEventListener('click', async () => {
    $('#shErr').textContent = ''; $('#shGo').disabled = true; $('#shGo').textContent = 'Checking…';
    try { const r = await rpc('sync.connect', $('#shUrl').value); toast(`Connected. Sending ${r.queued} past bills to the sheet.`); renderSheetCard(); }
    catch (e) { $('#shErr').textContent = e.message; $('#shGo').disabled = false; $('#shGo').textContent = 'Connect'; }
  });
}
async function renderBackupState() {
  try {
    const info = await rpc('app.info');
    $('#backupState').textContent = info.lastBackup ? 'Backed up ' + new Date(info.lastBackup).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'No backup yet';
  } catch (e) {}
}

/* ================= start ================= */
window.api.on && window.api.on('link-progress', msg => { const p = $('#lkProg'); if (p) p.textContent = msg; });
window.api.on && window.api.on('data-changed', async ch => {
  await reloadItems().catch(() => {});
  if (S.view === 'items') renderItemRows();
  if (S.view === 'sales' && ch.bills) renderSales();
  if (ch.bills) toast(`${ch.bills} new bill${ch.bills === 1 ? '' : 's'} from the phone app`);
});
async function init() {
  try {
    S.settings = await rpc('settings.get');
    await reloadItems();
    S.lastBill = await rpc('bills.last').catch(() => null);
  } catch (err) { document.body.innerHTML = `<div class="empty"><b>NRRL Billing could not start</b>${esc(err.message)}</div>`; return; }
  // keep cart lines in sync with any price changes since last time
  for (const l of S.cart.lines) { const it = S.items.get(l.code); if (it) { l.name = it.name; l.unit = unitFor(it); l.gst = it.gst; if (l.listRate !== false) l.rate = priceFor(it); } }
  buildBill(); renderLock(); renderBackupState();
  setInterval(renderBackupState, 5 * 60e3);
  window.addEventListener('focus', () => focusScan());
  show('bill');
}
init();
})();

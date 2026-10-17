/* NRRL Counter — fast barcode billing. Data lives in Supabase (schema "counter"), reached only through PIN-session RPCs. */
(() => {
'use strict';
const CFG = {
  url: 'https://nbsrlpubmukksdpusxpx.supabase.co',
  key: 'sb_publishable_-b7urbpGemxGRtC-__5cyw_LB1j3lRR',
  shop: 'Nathu Ram Ram Lal',
};

/* ---------------- helpers ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const money = n => inr.format(Math.round((+n || 0) * 100) / 100);
const r2 = n => Math.round((+n || 0) * 100) / 100;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem('nrrlc.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('nrrlc.' + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem('nrrlc.' + k); } catch (e) {} },
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
let toastT;
function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, err ? 4000 : 1600); }
let actx;
function beep(ok) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'square'; o.frequency.value = ok ? 2200 : 260; g.gain.value = ok ? .05 : .08;
    o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + (ok ? .07 : .28));
  } catch (e) {}
  try { navigator.vibrate && navigator.vibrate(ok ? 35 : [70, 50, 70]); } catch (e) {}
}

const ERR = {
  BAD_PIN: 'Wrong PIN. Try again.',
  LOCKED: 'Too many wrong PINs. Wait 10 minutes, or ask the owner.',
  SESSION_EXPIRED: 'Please log in again.',
  OWNER_ONLY: 'Only the owner can do this.',
  CODE_TAKEN: 'That code is already used by another item.',
  MISSING_FIELDS: 'Fill in the code and name.',
  NEED_PRICE: 'Add a retail price above ₹0.',
  EMPTY_BILL: 'The bill has no items.',
  UNKNOWN_ITEM: 'An item on this bill was removed from the item list. Remove it and try again.',
  PIN_FORMAT: 'PIN must be 4 to 8 digits.',
  CANT_DEMOTE_SELF: 'You can’t remove your own owner access.',
};
class ApiError extends Error { constructor(code, net) { super(ERR[code] || code); this.code = code; this.net = !!net; } }
async function api(fn, args = {}) {
  let res;
  try {
    res = await fetch(`${CFG.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: CFG.key },
      body: JSON.stringify(args),
    });
  } catch (e) { setNet(false); throw new ApiError('No internet connection.', true); }
  setNet(true);
  const txt = await res.text();
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
  if (!res.ok) {
    const code = (data && (data.message || data.hint)) || ('Server error ' + res.status);
    if (res.status >= 500 && !(data && data.code === 'P0001')) throw new ApiError('Server is not responding. Try again.', true);
    if (code === 'SESSION_EXPIRED' && fn !== 'counter_login') { logout(true); }
    throw new ApiError(code);
  }
  return data;
}
let netOk = true;
function setNet(ok) { if (ok === netOk) return; netOk = ok; const d = $('#net'); if (d) d.className = 'net' + (ok ? '' : ' off'); }

/* ---------------- state ---------------- */
const S = {
  token: LS.get('token', null),
  me: LS.get('me', null),
  items: new Map(),
  view: 'bill',
  cart: LS.get('cart', null) || freshCart(),
  pending: LS.get('pending', []),
};
function freshCart(prev) { return { id: uid(), lines: [], mode: prev?.mode || 'retail', payment: 'cash', discount: 0, customer: '', phone: '' }; }
const isOwner = () => S.me?.role === 'owner';
function saveCart() { LS.set('cart', S.cart); }
(LS.get('items', []) || []).forEach(i => S.items.set(i.code, i));

async function loadItems(quiet) {
  try {
    const list = await api('counter_items', { p_token: S.token });
    S.items.clear(); list.forEach(i => S.items.set(i.code, normItem(i)));
    LS.set('items', [...S.items.values()]);
    if (S.view === 'items') renderItems();
  } catch (e) { if (!quiet && !e.net) toast(e.message, true); }
}
function normItem(i) { return { code: String(i.code), name: i.name, retail: +i.retail, wholesale: +i.wholesale, stock: i.stock == null ? null : +i.stock, unit: i.unit || 'pcs', gst: +i.gst, hsn: i.hsn || '' }; }
function findItem(code) {
  code = String(code || '').trim();
  if (!code) return null;
  if (S.items.has(code)) return S.items.get(code);
  const up = code.toUpperCase();
  for (const it of S.items.values()) if (it.code.toUpperCase() === up) return it;
  // EAN-13 / UPC-A leading-zero tolerance
  if (/^\d+$/.test(code)) {
    const z = code.replace(/^0+/, '');
    for (const it of S.items.values()) if (/^\d+$/.test(it.code) && it.code.replace(/^0+/, '') === z) return it;
  }
  return null;
}

/* ---------------- scanner ---------------- */
const Scanner = (() => {
  let stream = null, video = null, onCode = null, running = false, busy = false, det, reader, cv, cx, lastZx = 0, frameCb = 0;
  const seen = new Map();   // code -> last time seen in a frame
  async function detector() {
    if (det !== undefined) return det;
    det = null;
    try {
      if ('BarcodeDetector' in window) {
        const want = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar', 'qr_code', 'data_matrix'];
        const sup = await BarcodeDetector.getSupportedFormats();
        const f = want.filter(x => sup.includes(x));
        if (f.length) det = new BarcodeDetector({ formats: f });
      }
    } catch (e) { det = null; }
    return det;
  }
  function zx() {
    if (reader || !window.ZXing) return reader;
    const h = new Map();
    const F = ZXing.BarcodeFormat;
    h.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF, F.QR_CODE]);
    reader = new ZXing.MultiFormatReader(); reader.setHints(h);
    cv = document.createElement('canvas'); cx = cv.getContext('2d', { willReadFrequently: true });
    return reader;
  }
  function hit(code) {
    const now = performance.now();
    const prev = seen.get(code) || 0;
    seen.set(code, now);
    // A code counts again only after it has left the camera view for a moment.
    if (now - prev > 750) onCode && onCode(code);
  }
  async function tick() {
    if (!running) return;
    if (!busy && video.readyState >= 2) {
      busy = true;
      try {
        const d = await detector();
        if (d) {
          const r = await d.detect(video);
          for (const b of r) if (b.rawValue) hit(b.rawValue);
        } else if (zx() && performance.now() - lastZx > 90) {
          lastZx = performance.now();
          const vw = video.videoWidth, vh = video.videoHeight;
          const cw = vw * .8, ch = vh * .6, sx = (vw - cw) / 2, sy = (vh - ch) / 2;
          const sc = Math.min(1, 900 / cw);
          cv.width = Math.round(cw * sc); cv.height = Math.round(ch * sc);
          cx.drawImage(video, sx, sy, cw, ch, 0, 0, cv.width, cv.height);
          try {
            const lum = new ZXing.HTMLCanvasElementLuminanceSource(cv);
            const res = reader.decodeWithState(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(lum)));
            if (res) hit(res.getText());
          } catch (e) { /* nothing found in this frame */ }
        }
      } catch (e) {}
      busy = false;
    }
    schedule();
  }
  function schedule() {
    if (!running) return;
    if (video.requestVideoFrameCallback) frameCb = video.requestVideoFrameCallback(() => tick());
    else frameCb = requestAnimationFrame(() => tick());
  }
  async function start(videoEl, cb) {
    onCode = cb;
    if (stream && video === videoEl) { running = true; schedule(); return true; }
    stop();
    video = videoEl;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot open the camera.');
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
    const tr = stream.getVideoTracks()[0];
    try { await tr.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) {}
    video.srcObject = stream; video.muted = true; video.setAttribute('playsinline', '');
    try { await video.play(); } catch (e) {}
    running = true; schedule();
    return true;
  }
  function stop() {
    running = false;
    try { if (video?.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameCb); else cancelAnimationFrame(frameCb); } catch (e) {}
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; if (video) video.srcObject = null; video = null;
  }
  function torchAvailable() { try { return !!stream?.getVideoTracks()[0].getCapabilities?.().torch; } catch (e) { return false; } }
  async function torch(on) { try { await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: on }] }); return true; } catch (e) { return false; } }
  return { start, stop, torch, torchAvailable, get active() { return !!stream; } };
})();

/* ---------------- shell ---------------- */
const ICON = {
  bill: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/>',
  items: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
  bills: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
  staff: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .8 3.2 2.5 3.6 5.2"/>',
};
const svg = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;

function boot() {
  if (!S.token || !S.me) return showLogin();
  showApp();
  api('counter_me', { p_token: S.token }).then(me => { S.me = me; LS.set('me', me); renderWho(); }).catch(() => {});
}

/* ---------------- login ---------------- */
let loginStaff = null, pin = '';
async function showLogin() {
  Scanner.stop();
  $('#app').innerHTML = `<div class="login">
    <h1>NRRL Counter</h1><div class="sub">${esc(CFG.shop)}</div>
    <div id="lg"></div></div>`;
  let staff = LS.get('staff', []);
  renderLoginNames(staff);
  try { staff = await api('counter_staff_list'); LS.set('staff', staff); renderLoginNames(staff); }
  catch (e) { if (!staff.length) $('#lg').innerHTML = `<p class="err">${esc(e.message)}</p><button class="btn" id="retry">Try again</button>`; $('#retry')?.addEventListener('click', showLogin); }
}
function renderLoginNames(staff) {
  if (!staff.length) { $('#lg').innerHTML = '<p class="hint">Loading…</p>'; return; }
  const last = LS.get('lastStaff', null);
  if (last && staff.find(s => s.id === last) && !loginStaff) return pickStaff(staff.find(s => s.id === last));
  $('#lg').innerHTML = `<p class="lbl" style="text-align:center">Who is billing?</p><div class="names">${staff.map(s => `<button type="button" data-id="${esc(s.id)}">${esc(s.name)}<small>${s.role === 'owner' ? 'Owner' : 'Staff'}</small></button>`).join('')}</div>`;
  $('#lg .names').addEventListener('click', e => { const b = e.target.closest('button'); if (b) pickStaff(staff.find(s => s.id === b.dataset.id)); });
}
function pickStaff(s) {
  loginStaff = s; pin = '';
  $('#lg').innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;gap:16px">
    <div style="text-align:center"><div class="lbl">Logging in as</div><div style="font-family:var(--f-display);font-weight:800;font-size:1.4rem">${esc(s.name)}</div>
    <button type="button" class="btn sm" id="chg" style="margin-top:6px">Not you?</button></div>
    <div class="pinbox" id="pinbox"></div>
    <div class="err" id="perr"></div>
    <div class="pad" id="pad">${[1,2,3,4,5,6,7,8,9].map(n => `<button type="button" data-k="${n}">${n}</button>`).join('')}<button type="button" data-k="del" aria-label="Delete">⌫</button><button type="button" data-k="0">0</button><button type="button" data-k="ok" style="background:var(--accent);color:var(--accent-fg);border:0" aria-label="Log in">✓</button></div></div>`;
  drawPin();
  $('#chg').addEventListener('click', () => { loginStaff = null; LS.del('lastStaff'); renderLoginNames(LS.get('staff', [])); });
  $('#pad').addEventListener('click', e => { const b = e.target.closest('button'); if (b) padKey(b.dataset.k); });
}
function drawPin() { $('#pinbox').innerHTML = Array.from({ length: Math.max(4, pin.length) }, (_, i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join(''); }
function padKey(k) {
  if (k === 'del') pin = pin.slice(0, -1);
  else if (k === 'ok') return doLogin();
  else if (pin.length < 8) pin += k;
  $('#perr').textContent = ''; drawPin();
}
document.addEventListener('keydown', e => {
  if (!$('#pad')) return;
  if (/^\d$/.test(e.key)) padKey(e.key); else if (e.key === 'Backspace') padKey('del'); else if (e.key === 'Enter') padKey('ok');
});
async function doLogin() {
  if (pin.length < 4) { $('#perr').textContent = 'Enter your PIN.'; return; }
  $('#perr').textContent = 'Checking…';
  try {
    const r = await api('counter_login', { p_staff: loginStaff.id, p_pin: pin });
    S.token = r.token; S.me = { id: r.id, name: r.name, role: r.role };
    LS.set('token', S.token); LS.set('me', S.me); LS.set('lastStaff', r.id);
    pin = ''; showApp();
  } catch (e) { pin = ''; drawPin(); $('#perr').textContent = e.message; beep(false); }
}
async function logout(expired) {
  const t = S.token;
  S.token = null; S.me = null; LS.del('token'); LS.del('me');
  if (t && !expired) api('counter_logout', { p_token: t }).catch(() => {});
  loginStaff = null;
  if (expired) toast('Session ended. Please log in again.', true);
  showLogin();
}

/* ---------------- main app ---------------- */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; const b = $('#installBtn'); if (b) b.hidden = false; });
function showApp() {
  const tabs = [['bill', 'Bill'], ['bills', 'Sales'], ['items', 'Items']].concat(isOwner() ? [['staff', 'Staff']] : []);
  $('#app').innerHTML = `
    <header class="topbar"><h1>NRRL Counter</h1>
      <div class="who"><button class="btn sm" id="installBtn" hidden>Install app</button><span class="net${netOk ? '' : ' off'}" id="net"></span><b id="whoName"></b><button class="btn sm" id="logoutBtn">Log out</button></div></header>
    <div class="banner" id="pendBanner" hidden></div>
    <main id="main">
      <section id="v-bill"></section>
      <section id="v-bills" hidden></section>
      <section id="v-items" hidden></section>
      <section id="v-staff" hidden></section>
    </main>
    <nav class="tabs">${tabs.map(([k, l]) => `<button type="button" data-tab="${k}">${svg(ICON[k === 'bills' ? 'bills' : k])}${l}</button>`).join('')}</nav>`;
  renderWho();
  $('#logoutBtn').addEventListener('click', () => { Scanner.stop(); logout(false); });
  $('#installBtn').hidden = !installEvt;
  $('#installBtn').addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); installEvt = null; $('#installBtn').hidden = true; });
  $('nav.tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) show(b.dataset.tab); });
  buildBill();
  show('bill');
  loadItems(true);
  syncPending();
}
function renderWho() { const w = $('#whoName'); if (w && S.me) w.textContent = S.me.name + (isOwner() ? ' · Owner' : ''); }
function show(v) {
  S.view = v;
  $$('nav.tabs [data-tab]').forEach(b => b.dataset.tab === v ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  ['bill', 'bills', 'items', 'staff'].forEach(k => { const el = $('#v-' + k); if (el) el.hidden = k !== v; });
  if (v === 'bill') startCam(); else Scanner.stop();
  if (v === 'bills') renderBills(true);
  if (v === 'items') { renderItems(); loadItems(true); }
  if (v === 'staff') renderStaff();
}
document.addEventListener('visibilitychange', () => {
  if (!S.token) return;
  if (document.hidden) Scanner.stop(); else if (S.view === 'bill' && !anySheetOpen()) startCam();
});
const anySheetOpen = () => !!$('.sheet');

/* ---------------- bill screen ---------------- */
function buildBill() {
  $('#v-bill').innerHTML = `
    <div class="cam" id="cam">
      <video id="camVideo" playsinline muted></video>
      <div class="aim"></div>
      <div class="camtools"><button type="button" id="torchBtn" aria-pressed="false" hidden>Light</button></div>
      <div class="flash" id="flash">Point at a barcode or QR code</div>
      <div class="off" id="camOff" hidden><span id="camMsg">Camera is off</span><button type="button" class="btn" id="camOn">Start camera</button></div>
    </div>
    <div class="billtools">
      <input type="search" id="find" placeholder="Search item or type code" autocomplete="off" enterkeyhint="go">
      <div class="seg" role="group" aria-label="Price list"><button type="button" data-mode="retail">Retail</button><button type="button" data-mode="wholesale">Wholesale</button></div>
    </div>
    <ul class="results" id="results"></ul>
    <ul class="lines" id="lines"></ul>
    <div class="paybar" id="paybar"></div>`;
  $('#camOn').addEventListener('click', startCam);
  $('#torchBtn').addEventListener('click', async e => { const on = e.currentTarget.getAttribute('aria-pressed') !== 'true'; if (await Scanner.torch(on)) e.currentTarget.setAttribute('aria-pressed', on); });
  const find = $('#find');
  find.addEventListener('input', () => renderResults(find.value.trim()));
  find.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return; e.preventDefault();
    const v = find.value.trim(); if (!v) return;
    const it = findItem(v); const m = search(v);
    if (it) { addItem(it); find.value = ''; renderResults(''); }
    else if (m.length === 1) { addItem(m[0]); find.value = ''; renderResults(''); }
    else if (!m.length) { find.value = ''; renderResults(''); unknownCode(v); }
  });
  $('#results').addEventListener('click', e => { const b = e.target.closest('[data-code]'); if (!b) return; addItem(S.items.get(b.dataset.code)); find.value = ''; renderResults(''); });
  $('.billtools .seg').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (!b) return; setMode(b.dataset.mode); });
  $('#lines').addEventListener('click', onLineClick);
  $('#lines').addEventListener('change', onLineChange);
  renderCart();
}
async function startCam() {
  const off = $('#camOff'); if (!off) return;
  try {
    await Scanner.start($('#camVideo'), onScan);
    off.hidden = true;
    setTimeout(() => { $('#torchBtn').hidden = !Scanner.torchAvailable(); }, 600);
  } catch (e) {
    off.hidden = false;
    $('#camMsg').textContent = e && e.name === 'NotAllowedError' ? 'Camera permission is blocked. Allow camera for this site in your browser settings, then tap Start camera.' : 'Camera could not start. Tap to try again.';
  }
}
function flash(kind, text) {
  const c = $('#cam'); if (!c) return;
  c.classList.remove('hit', 'miss'); void c.offsetWidth; c.classList.add(kind);
  clearTimeout(flash.t); flash.t = setTimeout(() => c.classList.remove(kind), 350);
  if (text) $('#flash').textContent = text;
}
function onScan(code) {
  if (anySheetOpen()) {
    if ($('#doneSheet')) { closeSheet(); } else return;
  }
  const it = findItem(code);
  if (it) addItem(it);
  else unknownCode(code);
}
function unknownCode(code) {
  beep(false); flash('miss', 'Not in item list: ' + code);
  openItemSheet({ code }, { fromBill: true });
}
function priceFor(it) { return S.cart.mode === 'wholesale' && it.wholesale > 0 ? it.wholesale : it.retail; }
function addItem(it, qty = 1) {
  if (!it) return;
  const c = S.cart;
  let i = c.lines.findIndex(l => l.code === it.code);
  let l;
  if (i >= 0) { l = c.lines[i]; l.qty = r2(l.qty + qty); c.lines.splice(i, 1); c.lines.unshift(l); }
  else { l = { code: it.code, name: it.name, unit: it.unit, gst: it.gst, price: priceFor(it), qty }; c.lines.unshift(l); }
  saveCart(); renderCart(true);
  beep(true); flash('hit', `✓ ${it.name} · ${l.qty} ${it.unit}`);
  if (it.stock != null && it.stock - l.qty < 0) toast(`${it.name}: stock shows ${it.stock} left`, true);
}
function setMode(m) {
  S.cart.mode = m;
  S.cart.lines.forEach(l => { const it = S.items.get(l.code); if (it) l.price = priceFor(it); });
  saveCart(); renderCart();
}
function totals() {
  const c = S.cart;
  const sub = r2(c.lines.reduce((a, l) => a + l.price * l.qty, 0));
  const disc = Math.min(r2(c.discount), sub);
  const total = r2(sub - disc);
  const f = sub > 0 ? total / sub : 0;
  const gst = r2(c.lines.reduce((a, l) => a + l.price * l.qty * (l.gst / (100 + l.gst)), 0) * f);
  const qty = r2(c.lines.reduce((a, l) => a + l.qty, 0));
  return { sub, disc, total, gst, qty };
}
function renderCart(fresh) {
  const c = S.cart, own = isOwner();
  $$('.billtools [data-mode]').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === c.mode));
  const ul = $('#lines');
  ul.innerHTML = c.lines.length ? c.lines.map((l, i) => `<li class="line${fresh && i === 0 ? ' new' : ''}">
      <div><div class="nm">${esc(l.name)}</div><div class="sub">${esc(l.code)} · ${money(l.price)}/${esc(l.unit)}</div></div>
      <div class="amt num">${money(l.price * l.qty)}</div>
      <div class="ctr">
        <button class="qb" type="button" data-dec="${i}" aria-label="One less">−</button>
        <input type="number" inputmode="decimal" data-q="${i}" value="${l.qty}" aria-label="Quantity">
        <button class="qb" type="button" data-inc="${i}" aria-label="One more">+</button>
        ${own ? `<span class="sub">rate</span><input class="rate" type="number" inputmode="decimal" data-p="${i}" value="${l.price}" aria-label="Rate">` : ''}
        <button class="rm" type="button" data-rm="${i}">Remove</button>
      </div></li>`).join('')
    : `<li class="empty"><b>Scan to start a bill</b>Hold each item’s barcode in the box. It adds itself with a beep. Scan the same item again for one more.</li>`;
  const t = totals();
  $('#paybar').innerHTML = `
    <div><div class="tot">${money(t.total)}</div><div class="meta">${c.lines.length} items · ${t.qty} qty${t.disc ? ' · discount ' + money(t.disc) : ''}</div></div>
    <button class="btn primary save" type="button" id="saveBtn" ${c.lines.length ? '' : 'disabled'}>Save bill</button>
    <div class="opts">
      <div class="seg" role="group" aria-label="Payment">${['cash', 'upi', 'udhaar'].map(p => `<button type="button" data-pay="${p}" aria-pressed="${c.payment === p}">${p === 'upi' ? 'UPI' : p === 'cash' ? 'Cash' : 'Udhaar'}</button>`).join('')}</div>
      <label class="sub" for="disc" style="margin-left:auto">Disc ₹</label><input type="number" inputmode="decimal" id="disc" value="${c.discount || ''}" placeholder="0">
      <button class="btn sm" type="button" id="custBtn" aria-expanded="${!!(c.customer || c.phone || c.payment === 'udhaar')}">${c.customer ? esc(c.customer) : 'Customer'}</button>
    </div>
    <div class="more" id="custFields" ${c.customer || c.phone || c.payment === 'udhaar' ? '' : 'hidden'}>
      <input type="text" id="cName" placeholder="Customer name" value="${esc(c.customer)}">
      <input type="tel" id="cPhone" placeholder="WhatsApp number" inputmode="numeric" value="${esc(c.phone)}">
    </div>`;
  $('#saveBtn').addEventListener('click', saveBill);
  $('#paybar .seg').addEventListener('click', e => { const b = e.target.closest('[data-pay]'); if (!b) return; c.payment = b.dataset.pay; saveCart(); renderCart(); });
  $('#disc').addEventListener('change', e => { c.discount = Math.max(0, r2(e.target.value)); saveCart(); renderCart(); });
  $('#custBtn').addEventListener('click', () => { const f = $('#custFields'); f.hidden = !f.hidden; if (!f.hidden) $('#cName').focus(); });
  $('#cName').addEventListener('input', e => { c.customer = e.target.value; saveCart(); });
  $('#cPhone').addEventListener('input', e => { c.phone = e.target.value; saveCart(); });
}
function onLineClick(e) {
  const b = e.target.closest('button'); if (!b) return;
  const L = S.cart.lines;
  if (b.dataset.inc != null) L[b.dataset.inc].qty = r2(L[b.dataset.inc].qty + 1);
  else if (b.dataset.dec != null) { const l = L[b.dataset.dec]; l.qty = r2(l.qty - 1); if (l.qty <= 0) L.splice(b.dataset.dec, 1); }
  else if (b.dataset.rm != null) L.splice(b.dataset.rm, 1);
  else return;
  saveCart(); renderCart();
}
function onLineChange(e) {
  const L = S.cart.lines, q = e.target.dataset.q, p = e.target.dataset.p;
  if (q != null) { const v = r2(e.target.value); if (v <= 0) L.splice(q, 1); else L[q].qty = v; }
  if (p != null) L[p].price = Math.max(0, r2(e.target.value));
  saveCart(); renderCart();
}
function search(q) {
  q = q.toLowerCase(); const out = [];
  if (q.length < 2) return out;
  for (const it of S.items.values()) { if (it.name.toLowerCase().includes(q) || it.code.toLowerCase().includes(q)) { out.push(it); if (out.length >= 8) break; } }
  return out;
}
function renderResults(q) {
  $('#results').innerHTML = search(q).map(it => `<li><button type="button" data-code="${esc(it.code)}"><span class="nm">${esc(it.name)}</span><span class="num">${money(priceFor(it))}</span></button></li>`).join('');
}

/* USB / Bluetooth scanner typing anywhere outside a text box */
let kb = '', kbT = 0;
document.addEventListener('keydown', e => {
  if (!S.token || S.view !== 'bill' || (anySheetOpen() && !$('#doneSheet'))) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  const now = performance.now();
  if (now - kbT > 120) kb = '';
  kbT = now;
  if (e.key === 'Enter') { if (kb.length >= 3) { e.preventDefault(); onScan(kb); } kb = ''; return; }
  if (e.key.length === 1) kb += e.key;
});

/* ---------------- saving ---------------- */
let saving = false;
async function saveBill() {
  const c = S.cart; if (saving || !c.lines.length) return;
  if (c.payment === 'udhaar' && !c.customer.trim()) { toast('Add the customer’s name for an udhaar bill.', true); $('#custFields').hidden = false; $('#cName').focus(); return; }
  saving = true; $('#saveBtn').disabled = true; $('#saveBtn').textContent = 'Saving…';
  const t = totals();
  const payload = {
    client_id: c.id, mode: c.mode, payment: c.payment, customer: c.customer.trim(), phone: c.phone.trim(), discount: t.disc,
    lines: c.lines.map(l => isOwner() ? { code: l.code, qty: l.qty, price: l.price } : { code: l.code, qty: l.qty }),
  };
  const local = { id: null, created_at: new Date().toISOString(), staff_name: S.me.name, mode: c.mode, payment: c.payment, customer: payload.customer, phone: payload.phone,
    lines: c.lines.map(l => ({ code: l.code, name: l.name, unit: l.unit, qty: l.qty, price: l.price, amount: r2(l.price * l.qty) })), subtotal: t.sub, discount: t.disc, total: t.total, gst: t.gst };
  let bill = null, offline = false;
  try { bill = await api('counter_bill_save', { p_token: S.token, p_bill: payload }); }
  catch (e) {
    if (e.net) { offline = true; S.pending.push({ payload, local, token: S.token }); LS.set('pending', S.pending); }
    else { toast(e.message, true); saving = false; renderCart(); return; }
  }
  // apply stock locally so warnings stay right between refreshes
  c.lines.forEach(l => { const it = S.items.get(l.code); if (it && it.stock != null) it.stock = r2(it.stock - l.qty); });
  S.cart = freshCart(c); saveCart(); saving = false; renderCart(); renderPendingBanner();
  showDone(bill || local, offline);
}
async function syncPending() {
  renderPendingBanner();
  if (!S.pending.length || syncPending.busy) return;
  syncPending.busy = true;
  const keep = [];
  for (const p of S.pending) {
    try { await api('counter_bill_save', { p_token: S.token || p.token, p_bill: p.payload }); }
    catch (e) { if (e.net) keep.push(p); else { p.error = e.message; keep.push(p); } }
  }
  const before = S.pending.length;
  S.pending = keep; LS.set('pending', S.pending); syncPending.busy = false;
  if (before && !keep.length) toast('Offline bills uploaded');
  renderPendingBanner();
}
function renderPendingBanner() {
  const b = $('#pendBanner'); if (!b) return;
  const n = S.pending.length, failed = S.pending.filter(p => p.error).length;
  b.hidden = !n;
  b.textContent = failed ? `${failed} bill(s) could not upload: ${S.pending.find(p => p.error).error}` : `${n} bill(s) saved on this phone, uploading when internet is back…`;
}
setInterval(() => { if (S.token) syncPending(); }, 20000);
window.addEventListener('online', () => S.token && syncPending());
setInterval(() => { if (S.token && !document.hidden) loadItems(true); }, 120000);

/* ---------------- WhatsApp text ---------------- */
function billText(b) {
  const d = new Date(b.created_at);
  let s = `*${CFG.shop}*\n${b.id ? 'Bill no. ' + b.id + ' · ' : ''}${d.toLocaleDateString('en-IN')} ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}\n`;
  if (b.customer) s += `Customer: ${b.customer}\n`;
  s += '\n' + b.lines.map(l => `${l.name}\n   ${l.qty} ${l.unit || ''} × ₹${l.price} = ₹${l.amount}`).join('\n');
  s += `\n\nSubtotal: ₹${b.subtotal}`;
  if (+b.discount) s += `\nDiscount: −₹${b.discount}`;
  s += `\n*Total: ₹${b.total}*  (incl. GST ₹${b.gst})`;
  s += `\nPaid by: ${b.payment === 'upi' ? 'UPI' : b.payment === 'udhaar' ? 'Udhaar (credit)' : 'Cash'}`;
  s += `\n\nThank you for shopping with us! 🎈\nnrrl.in`;
  return s;
}
function waLink(b) { let p = String(b.phone || '').replace(/\D/g, ''); if (p.length === 10) p = '91' + p; return 'https://wa.me/' + p + '?text=' + encodeURIComponent(billText(b)); }

/* ---------------- sheets ---------------- */
function openSheet(id, html, onClose) {
  closeSheet();
  const d = document.createElement('div'); d.className = 'sheet'; d.id = id; d.innerHTML = `<div class="card">${html}</div>`;
  d.addEventListener('click', e => { if (e.target === d) closeSheet(); });
  d._onClose = onClose;
  document.body.appendChild(d);
  return d;
}
function closeSheet() { const s = $('.sheet'); if (!s) return; const f = s._onClose; s.remove(); f && f(); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

function showDone(b, offline) {
  const d = openSheet('doneSheet', `
    <div class="lbl">${offline ? 'Saved on this phone' : 'Bill saved' + (b.id ? ' · No. ' + b.id : '')}</div>
    <div class="done-total">${money(b.total)}</div>
    <p class="s">${b.lines.length} items · ${b.payment === 'upi' ? 'UPI' : b.payment === 'udhaar' ? 'Udhaar' : 'Cash'}${b.customer ? ' · ' + esc(b.customer) : ''}${offline ? '<br>No internet right now. It uploads by itself when the connection is back.' : ''}</p>
    <div class="acts2">
      <a class="btn" href="${esc(waLink(b))}" target="_blank" rel="noopener">WhatsApp bill</a>
      <button class="btn primary" type="button" id="nextBtn">Next customer</button>
    </div>
    <p class="hint" style="margin-top:10px">Scanning the next item also starts a new bill.</p>`);
  $('#nextBtn', d).addEventListener('click', closeSheet);
  $('#nextBtn', d).focus();
}

function openItemSheet(it, opts = {}) {
  const editing = !!(it && it.name != null);
  const canEdit = isOwner() || !editing;
  const d = openSheet('itemSheet', `
    <form id="itemForm" novalidate>
      <h3>${editing ? (canEdit ? 'Edit item' : esc(it.name)) : opts.fromBill ? 'New barcode' : 'Add item'}</h3>
      <p class="s">${opts.fromBill ? `Code <b class="num">${esc(it.code)}</b> isn’t in the item list. Add it once; after that it scans straight into bills.` : editing && !canEdit ? 'Only the owner can change prices.' : 'Prices include GST.'}</p>
      <div class="grid2">
        <div class="field w"><label class="lbl" for="fCode">Barcode / code</label><div style="display:flex;gap:8px"><input type="text" id="fCode" value="${esc(it?.code ?? '')}" autocomplete="off" ${canEdit ? '' : 'disabled'}>${canEdit ? '<button type="button" class="btn sm" id="fScan">Scan</button>' : ''}</div></div>
        <div class="field w"><label class="lbl" for="fName">Item name</label><input type="text" id="fName" value="${esc(it?.name ?? '')}" placeholder="e.g. Metallic balloons, pack of 50" ${canEdit ? '' : 'disabled'}></div>
        <div class="field"><label class="lbl" for="fRetail">Retail ₹</label><input type="number" inputmode="decimal" id="fRetail" value="${it?.retail ?? ''}" ${canEdit ? '' : 'disabled'}></div>
        <div class="field"><label class="lbl" for="fWhole">Wholesale ₹</label><input type="number" inputmode="decimal" id="fWhole" value="${it?.wholesale || ''}" ${canEdit ? '' : 'disabled'}></div>
        <div class="field"><label class="lbl" for="fStock">Stock</label><input type="number" inputmode="decimal" id="fStock" value="${it?.stock ?? ''}" placeholder="Leave blank to not track" ${canEdit ? '' : 'disabled'}></div>
        <div class="field"><label class="lbl" for="fUnit">Unit</label><select id="fUnit" ${canEdit ? '' : 'disabled'}>${['pcs', 'pkt', 'box', 'dozen', 'set', 'roll', 'kg', 'mtr'].map(u => `<option${(it?.unit || 'pcs') === u ? ' selected' : ''}>${u}</option>`).join('')}</select></div>
        <div class="field"><label class="lbl" for="fGst">GST %</label><select id="fGst" ${canEdit ? '' : 'disabled'}>${[0, 5, 12, 18, 28].map(g => `<option value="${g}"${(it?.gst ?? 18) == g ? ' selected' : ''}>${g}%</option>`).join('')}</select></div>
        <div class="field"><label class="lbl" for="fHsn">HSN</label><input type="text" inputmode="numeric" id="fHsn" value="${esc(it?.hsn ?? '')}" ${canEdit ? '' : 'disabled'}></div>
      </div>
      <p class="err" id="fErr" style="text-align:left"></p>
      <div class="acts2">
        <button class="btn" type="button" id="fCancel">${canEdit ? 'Cancel' : 'Close'}</button>
        ${canEdit ? `<button class="btn primary" type="submit" id="fSave">${opts.fromBill ? 'Save & add to bill' : 'Save item'}</button>` : ''}
        ${editing && isOwner() ? '<button class="btn danger w" type="button" id="fDel">Remove item</button>' : ''}
      </div>
      <div class="confirm" id="fConfirm" hidden><span>Remove this item from the list? Old bills keep their copy.</span><button class="btn sm" type="button" id="fNo">Keep</button><button class="btn sm danger" type="button" id="fYes">Remove</button></div>
    </form>`, () => { if (S.view === 'bill') startCam(); });
  if (S.view === 'bill' && opts.fromBill) { /* keep camera; scans are ignored while this is open */ }
  $('#fCancel', d).addEventListener('click', closeSheet);
  $('#fScan', d)?.addEventListener('click', () => scanInto($('#fCode', d)));
  if (canEdit) setTimeout(() => (it?.code ? $('#fName', d) : $('#fCode', d)).focus(), 60);
  $('#fDel', d)?.addEventListener('click', () => { $('#fConfirm', d).hidden = false; });
  $('#fNo', d)?.addEventListener('click', () => { $('#fConfirm', d).hidden = true; });
  $('#fYes', d)?.addEventListener('click', async () => {
    try { await api('counter_item_remove', { p_token: S.token, p_code: it.code }); S.items.delete(it.code); LS.set('items', [...S.items.values()]); closeSheet(); renderItems(); toast('Removed ' + it.name); }
    catch (e) { $('#fErr', d).textContent = e.message; }
  });
  $('#itemForm', d).addEventListener('submit', async e => {
    e.preventDefault();
    const item = { code: $('#fCode', d).value.trim(), name: $('#fName', d).value.trim(), retail: r2($('#fRetail', d).value), wholesale: r2($('#fWhole', d).value) || 0,
      stock: $('#fStock', d).value.trim() === '' ? '' : r2($('#fStock', d).value), unit: $('#fUnit', d).value, gst: +$('#fGst', d).value, hsn: $('#fHsn', d).value.trim() };
    const err = m => { $('#fErr', d).textContent = m; };
    if (!item.code) return err('Add a barcode or short code, for example BLN-50.');
    if (!item.name) return err('Add the item name.');
    if (!(item.retail > 0)) return err('Add a retail price above ₹0.');
    const clash = findItem(item.code);
    if (clash && (!editing || clash.code !== it.code)) return err(`Code ${item.code} is already “${clash.name}”.`);
    $('#fSave', d).disabled = true;
    try {
      await api('counter_item_save', { p_token: S.token, p_item: item, p_old_code: editing ? it.code : null });
      if (editing && it.code !== item.code) S.items.delete(it.code);
      const n = normItem({ ...item, stock: item.stock === '' ? null : item.stock });
      S.items.set(n.code, n); LS.set('items', [...S.items.values()]);
      closeSheet();
      if (opts.fromBill) addItem(n); else toast('Saved ' + n.name);
      if (S.view === 'items') renderItems();
    } catch (ex) { err(ex.message); $('#fSave', d).disabled = false; }
  });
}

/* full-screen scan used to fill a code field */
async function scanInto(input) {
  const wasBill = S.view === 'bill';
  Scanner.stop();
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:70;background:#000;display:flex;flex-direction:column';
  ov.innerHTML = `<div class="cam" style="height:auto;flex:1"><video playsinline muted></video><div class="aim"></div><div class="flash">Scan the item’s barcode</div></div>
    <div style="padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px));background:#000"><button class="btn" type="button" style="width:100%">Cancel</button></div>`;
  document.body.appendChild(ov);
  const done = () => { Scanner.stop(); ov.remove(); if (wasBill && !anySheetOpen()) startCam(); };
  ov.querySelector('button').addEventListener('click', done);
  try {
    await Scanner.start(ov.querySelector('video'), code => { input.value = code; beep(true); done(); });
  } catch (e) { toast('Camera could not start.', true); done(); }
}

/* ---------------- sales (bills) ---------------- */
let billRange = 'today', bills = [], openBill = null;
function rangeDates(r) {
  const now = new Date(), d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (r === 'today') return [d0, null];
  if (r === 'yesterday') { const y = new Date(d0); y.setDate(y.getDate() - 1); return [y, d0]; }
  if (r === 'week') { const w = new Date(d0); w.setDate(w.getDate() - 6); return [w, null]; }
  if (r === 'month') return [new Date(now.getFullYear(), now.getMonth(), 1), null];
  return [d0, null];
}
async function renderBills(reload) {
  const el = $('#v-bills');
  const own = isOwner();
  if (reload) {
    el.innerHTML = `<div class="page"><p class="hint">Loading sales…</p></div>`;
    try { const [f, t] = rangeDates(own ? billRange : 'today'); bills = await api('counter_bills', { p_token: S.token, p_from: f.toISOString(), p_to: t ? t.toISOString() : null }); }
    catch (e) { el.innerHTML = `<div class="page"><p class="err">${esc(e.message)}</p><button class="btn" id="rl">Try again</button></div>`; $('#rl').addEventListener('click', () => renderBills(true)); return; }
  }
  const live = bills.filter(b => !b.voided);
  const sum = a => a.reduce((s, b) => s + +b.total, 0);
  const by = k => { const m = {}; live.forEach(b => { m[b[k]] = (m[b[k]] || 0) + +b.total; }); return m; };
  const pay = by('payment'), staff = by('staff_name');
  el.innerHTML = `<div class="page">
    <div class="ph"><h2>${own ? 'Sales' : 'Today’s sales'}</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${own ? `<div class="seg" id="rangeSeg">${[['today', 'Today'], ['yesterday', 'Yesterday'], ['week', '7 days'], ['month', 'Month']].map(([k, l]) => `<button type="button" data-r="${k}" aria-pressed="${billRange === k}">${l}</button>`).join('')}</div><button class="btn sm" id="expBills">Download CSV</button>` : ''}<button class="btn sm" id="refBills">Refresh</button></div></div>
    <div class="stats">
      <div class="stat"><div class="lbl">Total</div><div class="v">${money(sum(live))}</div></div>
      <div class="stat"><div class="lbl">Bills</div><div class="v">${live.length}</div></div>
      <div class="stat"><div class="lbl">Cash</div><div class="v">${money(pay.cash || 0)}</div></div>
      <div class="stat"><div class="lbl">UPI</div><div class="v">${money(pay.upi || 0)}</div></div>
      <div class="stat"><div class="lbl">Udhaar</div><div class="v">${money(pay.udhaar || 0)}</div></div>
    </div>
    ${own && Object.keys(staff).length > 1 ? `<p class="hint" style="margin:-4px 0 12px">By person: ${Object.entries(staff).map(([n, v]) => `${esc(n)} ${money(v)}`).join(' · ')}</p>` : ''}
    ${S.pending.length ? `<p class="hint" style="margin-bottom:10px">${S.pending.length} bill(s) on this phone are waiting to upload and aren’t counted yet.</p>` : ''}
    <ul class="list" id="billList">${bills.length ? bills.map(b => billRow(b)).join('') : '<li class="empty"><b>No bills yet</b>Saved bills show up here.</li>'}</ul>
  </div>`;
  $('#rangeSeg')?.addEventListener('click', e => { const b = e.target.closest('[data-r]'); if (!b) return; billRange = b.dataset.r; openBill = null; renderBills(true); });
  $('#refBills').addEventListener('click', () => renderBills(true));
  $('#expBills')?.addEventListener('click', exportBills);
  $('#billList').addEventListener('click', onBillClick);
}
function billRow(b) {
  const d = new Date(b.created_at), open = openBill === b.id;
  return `<li><button class="row" type="button" data-open="${b.id}" aria-expanded="${open}">
    <span class="nm">${b.voided ? '<s>' : ''}${esc(b.customer || 'Walk-in')}${b.voided ? '</s>' : ''}</span>
    <span class="rt num" style="font-weight:600">${money(b.total)}</span>
    <span class="meta"><span class="num">#${b.id}</span><span>${d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span><span>${esc(b.staff_name || '')}</span>
      <span class="chip${b.payment === 'udhaar' ? ' low' : ''}">${b.payment === 'upi' ? 'UPI' : b.payment === 'udhaar' ? 'Udhaar' : 'Cash'}</span>${b.mode === 'wholesale' ? '<span class="chip acc">Wholesale</span>' : ''}${b.voided ? '<span class="chip out">Cancelled</span>' : ''}</span>
  </button>${open ? `<div class="detail"><table>${b.lines.map(l => `<tr><td>${esc(l.name)}<div class="hint">${l.qty} ${esc(l.unit || '')} × ${money(l.price)}</div></td><td>${money(l.amount)}</td></tr>`).join('')}
    ${+b.discount ? `<tr><td>Discount</td><td>−${money(b.discount)}</td></tr>` : ''}<tr><td><b>Total</b> <span class="hint">incl. GST ${money(b.gst)}</span></td><td><b>${money(b.total)}</b></td></tr></table>
    <div class="acts">${b.voided ? '' : `<a class="btn sm primary" href="${esc(waLink(b))}" target="_blank" rel="noopener">WhatsApp</a>`}
    ${isOwner() && !b.voided ? `<button class="btn sm danger" type="button" data-void="${b.id}">Cancel bill</button>` : ''}</div>
    <div class="confirm" data-vc="${b.id}" hidden><span>Cancel bill #${b.id}? Items go back into stock.</span><button class="btn sm" type="button" data-keep>Keep</button><button class="btn sm danger" type="button" data-voidyes="${b.id}">Cancel bill</button></div>
  </div>` : ''}</li>`;
}
async function onBillClick(e) {
  const t = e.target.closest('[data-open],[data-void],[data-voidyes],[data-keep]'); if (!t) return;
  if (t.dataset.open) { const id = +t.dataset.open; openBill = openBill === id ? null : id; renderBills(false); return; }
  if (t.hasAttribute('data-keep')) { t.closest('.confirm').hidden = true; return; }
  if (t.dataset.void) { $(`[data-vc="${t.dataset.void}"]`).hidden = false; return; }
  if (t.dataset.voidyes) {
    try { await api('counter_bill_void', { p_token: S.token, p_id: +t.dataset.voidyes }); toast('Bill cancelled, stock restored'); renderBills(true); loadItems(true); }
    catch (err) { toast(err.message, true); }
  }
}

/* ---------------- items ---------------- */
let itemFilter = 'all';
function renderItems() {
  const el = $('#v-items'); if (!el) return;
  const prevQ = $('#itemQ')?.value || '';
  const own = isOwner();
  el.innerHTML = `<div class="page">
    <div class="ph"><h2>Items</h2><div style="display:flex;gap:8px;flex-wrap:wrap">
      ${own ? '<button class="btn sm" id="impBtn">Import CSV</button><button class="btn sm" id="expBtn">Download CSV</button>' : ''}
      <button class="btn sm accent" id="addBtn">+ Add item</button></div></div>
    <div class="bar"><input type="search" id="itemQ" placeholder="Search name or code" value="${esc(prevQ)}">
      <div class="seg" id="itemSeg"><button type="button" data-f="all" aria-pressed="${itemFilter === 'all'}">All</button><button type="button" data-f="low" aria-pressed="${itemFilter === 'low'}">Low stock</button></div></div>
    <ul class="list" id="itemList"></ul><p class="hint" id="itemCount" style="margin-top:8px"></p></div>`;
  $('#addBtn').addEventListener('click', () => openItemSheet(null));
  $('#impBtn')?.addEventListener('click', openImport);
  $('#expBtn')?.addEventListener('click', exportItems);
  $('#itemQ').addEventListener('input', drawItemList);
  $('#itemSeg').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (!b) return; itemFilter = b.dataset.f; $$('#itemSeg button').forEach(x => x.setAttribute('aria-pressed', x === b)); drawItemList(); });
  $('#itemList').addEventListener('click', e => { const b = e.target.closest('[data-code]'); if (b) openItemSheet(S.items.get(b.dataset.code)); });
  drawItemList();
}
function stockChip(it) {
  if (it.stock == null) return '';
  if (it.stock <= 0) return `<span class="chip out">Out · ${it.stock}</span>`;
  if (it.stock <= 5) return `<span class="chip low">Low · ${it.stock} ${esc(it.unit)}</span>`;
  return `<span class="chip">${it.stock} ${esc(it.unit)}</span>`;
}
function drawItemList() {
  const q = ($('#itemQ')?.value || '').trim().toLowerCase();
  let list = [...S.items.values()];
  if (q) list = list.filter(i => i.name.toLowerCase().includes(q) || i.code.toLowerCase().includes(q));
  if (itemFilter === 'low') list = list.filter(i => i.stock != null && i.stock <= 5);
  list.sort((a, b) => a.name.localeCompare(b.name));
  $('#itemList').innerHTML = !S.items.size ? '<li class="empty"><b>No items yet</b>Add items here, import a CSV, or just scan an unknown barcode on the Bill screen.</li>'
    : !list.length ? '<li class="empty">Nothing matches.</li>'
    : list.slice(0, 300).map(it => `<li><button class="row" type="button" data-code="${esc(it.code)}">
        <span class="nm">${esc(it.name)}</span>
        <span class="rt"><b class="num">${money(it.retail)}</b>${it.wholesale > 0 ? `<div class="hint num">W ${money(it.wholesale)}</div>` : ''}</span>
        <span class="meta"><span class="num">${esc(it.code)}</span>${stockChip(it)}</span></button></li>`).join('');
  $('#itemCount').textContent = S.items.size ? `${Math.min(list.length, 300)} of ${list.length} shown · ${S.items.size} items total` : '';
}
function downloadText(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
  a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const csvCell = v => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
function exportItems() {
  const rows = [['code', 'name', 'retail', 'wholesale', 'stock', 'unit', 'gst', 'hsn'], ...[...S.items.values()].map(i => [i.code, i.name, i.retail, i.wholesale, i.stock ?? '', i.unit, i.gst, i.hsn])];
  downloadText('nrrl-items.csv', rows.map(r => r.map(csvCell).join(',')).join('\n'));
}
function exportBills() {
  const rows = [['bill_no', 'date', 'staff', 'customer', 'phone', 'payment', 'price_list', 'item_code', 'item', 'qty', 'rate', 'amount', 'bill_total', 'status']];
  bills.forEach(b => b.lines.forEach(l => rows.push([b.id, new Date(b.created_at).toLocaleString('en-IN'), b.staff_name, b.customer, b.phone, b.payment, b.mode, l.code, l.name, l.qty, l.price, l.amount, b.total, b.voided ? 'cancelled' : 'ok'])));
  downloadText(`nrrl-sales-${billRange}.csv`, rows.map(r => r.map(csvCell).join(',')).join('\n'));
}
function parseCSV(t) { const rows = []; let row = [], cur = '', q = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; } else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; } else cur += c; } if (cur || row.length) { row.push(cur); rows.push(row); } return rows.map(r => r.map(s => s.trim().replace(/^﻿/, ''))).filter(r => r.some(Boolean)); }
function openImport() {
  const d = openSheet('impSheet', `<h3>Import items</h3>
    <p class="s">One item per row: <span class="num">code, name, retail, wholesale, stock, unit, gst, hsn</span>. A header row is skipped. Existing codes get updated; leave stock blank to keep the current stock.</p>
    <input type="file" id="csvFile" accept=".csv,text/csv,text/plain" style="margin-bottom:10px">
    <textarea id="csvText" rows="7" style="font-family:var(--f-mono);font-size:.82rem" placeholder="8901234567890,Metallic balloons pack 50,120,95,40,pkt,18,9505"></textarea>
    <p class="hint" id="impMsg"></p>
    <div class="acts2"><button class="btn" type="button" id="impClose">Close</button><button class="btn primary" type="button" id="impGo">Import</button></div>`);
  $('#impClose', d).addEventListener('click', closeSheet);
  $('#csvFile', d).addEventListener('change', async e => { const f = e.target.files[0]; if (f) $('#csvText', d).value = await f.text(); });
  $('#impGo', d).addEventListener('click', async () => {
    const rows = parseCSV($('#csvText', d).value);
    if (rows.length && isNaN(parseFloat(rows[0][2]))) rows.shift();
    if (!rows.length) { $('#impMsg', d).textContent = 'Paste rows or choose a CSV file first.'; return; }
    const objs = rows.map(([code, name, retail, wholesale, stock, unit, gst, hsn]) => ({ code, name, retail, wholesale, stock: stock ?? '', unit, gst, hsn }));
    $('#impGo', d).disabled = true;
    let ok = 0, bad = 0;
    for (let i = 0; i < objs.length; i += 300) {
      $('#impMsg', d).textContent = `Importing ${Math.min(i + 300, objs.length)} of ${objs.length}…`;
      try { const r = await api('counter_items_import', { p_token: S.token, p_rows: objs.slice(i, i + 300) }); ok += r.imported; bad += r.skipped; }
      catch (e) { $('#impMsg', d).textContent = e.message; $('#impGo', d).disabled = false; return; }
    }
    $('#impMsg', d).textContent = `Imported ${ok} items${bad ? `, skipped ${bad} rows missing a code, name or price` : ''}.`;
    $('#impGo', d).disabled = false;
    loadItems(true);
  });
}

/* ---------------- staff (owner) ---------------- */
async function renderStaff() {
  const el = $('#v-staff');
  el.innerHTML = `<div class="page"><p class="hint">Loading…</p></div>`;
  let list;
  try { list = await api('counter_staff_all', { p_token: S.token }); }
  catch (e) { el.innerHTML = `<div class="page"><p class="err">${esc(e.message)}</p></div>`; return; }
  el.innerHTML = `<div class="page"><div class="ph"><h2>Staff</h2><button class="btn sm accent" id="addStaff">+ Add person</button></div>
    <p class="hint" style="margin:-4px 0 12px">Staff can make bills, see today’s sales and add new items. They can’t change prices, cancel bills or see older sales.</p>
    <ul class="list">${list.map(s => `<li><button class="row" type="button" data-sid="${s.id}"><span class="nm">${esc(s.name)}</span>
      <span class="rt">${s.active ? '' : '<span class="chip out">Blocked</span>'}</span><span class="meta"><span class="chip${s.role === 'owner' ? ' acc' : ''}">${s.role === 'owner' ? 'Owner' : 'Staff'}</span></span></button></li>`).join('')}</ul></div>`;
  $('#addStaff').addEventListener('click', () => staffSheet(null));
  $$('[data-sid]', el).forEach(b => b.addEventListener('click', () => staffSheet(list.find(s => s.id === b.dataset.sid))));
}
function staffSheet(s) {
  const self = s && s.id === S.me.id;
  const d = openSheet('staffSheet', `<form id="sf" novalidate><h3>${s ? esc(s.name) : 'Add person'}</h3>
    <p class="s">${s ? 'Leave PIN blank to keep the current one.' : 'They log in by tapping their name and typing this PIN.'}</p>
    <div class="grid2">
      <div class="field w"><label class="lbl" for="sName">Name</label><input type="text" id="sName" value="${esc(s?.name || '')}" placeholder="e.g. Ramesh"></div>
      <div class="field"><label class="lbl" for="sPin">${s ? 'New PIN' : 'PIN'}</label><input type="tel" inputmode="numeric" id="sPin" maxlength="8" placeholder="4–8 digits" autocomplete="off"></div>
      <div class="field"><label class="lbl" for="sRole">Access</label><select id="sRole" ${self ? 'disabled' : ''}><option value="staff"${s?.role !== 'owner' ? ' selected' : ''}>Staff</option><option value="owner"${s?.role === 'owner' ? ' selected' : ''}>Owner (full access)</option></select></div>
      ${s && !self ? `<label class="w" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="sActive" ${s.active ? 'checked' : ''}> Allowed to log in</label>` : ''}
    </div>
    <p class="err" id="sErr" style="text-align:left"></p>
    <div class="acts2"><button class="btn" type="button" id="sCancel">Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`);
  $('#sCancel', d).addEventListener('click', closeSheet);
  $('#sf', d).addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#sName', d).value.trim(), pinV = $('#sPin', d).value.trim();
    if (!name) return $('#sErr', d).textContent = 'Add a name.';
    if ((!s || pinV) && !/^\d{4,8}$/.test(pinV)) return $('#sErr', d).textContent = 'PIN must be 4 to 8 digits.';
    try {
      await api('counter_staff_save', { p_token: S.token, p_id: s?.id || null, p_name: name, p_pin: pinV || null, p_role: self ? 'owner' : $('#sRole', d).value, p_active: s && !self ? $('#sActive', d).checked : true });
      closeSheet(); toast('Saved ' + name);
      LS.set('staff', await api('counter_staff_list').catch(() => LS.get('staff', [])));
      if (self && pinV) { toast('PIN changed. Log in with the new PIN.'); logout(true); return; }
      renderStaff();
    } catch (ex) { $('#sErr', d).textContent = ex.message; }
  });
}

/* ---------------- start ---------------- */
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
boot();
})();

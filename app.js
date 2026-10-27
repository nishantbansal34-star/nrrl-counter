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
  CART_GONE: 'That bill was already saved or closed.',
  CANT_BILL: 'That person can’t make bills (switched off, or blocked).',
  NO_ACCESS: 'You don’t have access to this. Ask the owner.',
  'Request timed out': 'The internet is too slow right now. Try again.',
};
class ApiError extends Error { constructor(code, net) { super(ERR[code] || code); this.code = code; this.net = !!net; } }
async function api(fn, args = {}) {
  let res;
  // a slow or stuck connection must not leave the screen waiting forever: after 20 s it counts as offline
  // (a bill is then kept on the phone and sent again later; the server ignores a bill it already has)
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    res = await fetch(`${CFG.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: CFG.key },
      body: JSON.stringify(args), signal: ctrl.signal,
    });
  } catch (e) { setNet(false); throw new ApiError(e && e.name === 'AbortError' ? 'The internet is too slow right now. Try again.' : 'No internet connection.', true); }
  finally { clearTimeout(timer); }
  setNet(true);
  const txt = await res.text();
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
  if (!res.ok) {
    const code = (data && (data.message || data.hint)) || ('Server error ' + res.status);
    if (res.status >= 500 && !(data && data.code === 'P0001')) throw new ApiError('Server is not responding. Try again.', true);
    if (code === 'SESSION_EXPIRED' && fn !== 'counter_login') { logout(true); }
    throw new ApiError(code);
  }
  if (data && typeof data === 'object' && !Array.isArray(data) && data.error) throw new ApiError(data.error);
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
/* What each person may do. The owner switches these on or off per person (Staff tab). */
const PERMS = [
  ['bill', 'Make bills'], ['rate', 'Change rates & give discount'], ['stock', 'See stock'], ['add', 'Add new items'],
  ['edit', 'Edit items, prices & stock'], ['sales', 'See today’s sales'], ['reports', 'See older sales & totals'],
  ['cancel', 'Cancel bills'], ['labels', 'Print labels'], ['settings', 'Laptop settings'],
];
const PERM_DEF = { bill: true, rate: false, stock: true, add: true, edit: false, sales: true, reports: false, cancel: false, labels: true, settings: false };
const can = k => isOwner() || !!((S.me?.perms && k in S.me.perms) ? S.me.perms[k] : PERM_DEF[k]);
function saveCart() { LS.set('cart', S.cart); scheduleLive(); }
(LS.get('items', []) || []).forEach(i => S.items.set(i.code, i));

/* Item list: the whole list at start and every 10 minutes; in between only what changed (much less mobile data
   when there are thousands of items). If the server doesn't offer changes-only yet, the whole list is used. */
let itemsAt = null, itemsFullAt = 0, sinceOk = true;
async function loadItems(quiet) {
  try {
    if (sinceOk) {
      const full = !itemsAt || Date.now() - itemsFullAt > 10 * 60e3;
      try {
        const r = await api('counter_items_since', { p_token: S.token, p_since: full ? null : itemsAt });
        if (!r || !Array.isArray(r.items)) { const e = new Error('Could not find counter_items_since'); e.code = 'PGRST202'; throw e; }
        itemsAt = r.now; // the server's clock, so a wrong phone clock can't make it miss changes
        if (full) { itemsFullAt = Date.now(); S.items.clear(); }
        if (full || (r.items && r.items.length)) {
          for (const i of r.items || []) { if (i.removed) S.items.delete(String(i.code)); else S.items.set(String(i.code), normItem(i)); }
          LS.set('items', [...S.items.values()]);
          if (S.view === 'items') renderItems();
          renderQuick();
        }
        return;
      } catch (e) {
        if (e.net) throw e;
        // older server without changes-only: fall back to the whole list
        if (/counter_items_since|PGRST202|Could not find|Server error 404/i.test(String(e.message) + ' ' + String(e.code))) sinceOk = false; else throw e;
      }
    }
    const list = await api('counter_items', { p_token: S.token });
    S.items.clear(); list.forEach(i => S.items.set(i.code, normItem(i)));
    LS.set('items', [...S.items.values()]);
    if (S.view === 'items') renderItems();
    renderQuick();
  } catch (e) { if (!quiet && !e.net) toast(e.message, true); }
}
function normItem(i) { return { code: String(i.code), name: i.name, retail: +i.retail, wholesale: +i.wholesale, wholesale_unit: i.wholesale_unit || '', wholesale_qty: +i.wholesale_qty || 1, stock: i.stock == null ? null : +i.stock, unit: i.unit || 'pcs', gst: +i.gst, hsn: i.hsn || '' }; }
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

/* Load a script only when it is needed (keeps start-up fast on older phones). Tries each address in turn. */
const loaded = {};
function loadScript(urls) {
  const key = urls.join('|');
  if (loaded[key]) return loaded[key];
  return (loaded[key] = new Promise((resolve, reject) => {
    let i = 0;
    const next = () => {
      if (i >= urls.length) { delete loaded[key]; return reject(new Error('Could not load ' + urls[0])); }
      const el = document.createElement('script'); el.src = urls[i++]; el.async = true;
      el.onload = () => resolve(); el.onerror = () => { el.remove(); next(); };
      document.head.appendChild(el);
    };
    next();
  }));
}
// barcode reader for phones without a built-in one; the Android app carries its own copy
const ZXING = ['zxing.min.js', 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js'];

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
    // A code counts again once it has been out of view briefly (a quick away-and-back is enough).
    if (now - prev > REPEAT_GAP) onCode && onCode(code);
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
    if (!window.ZXing && !('BarcodeDetector' in window)) loadScript(ZXING).catch(() => {});
    else if (!window.ZXing) detector().then(d => { if (!d) loadScript(ZXING).catch(() => {}); });
    if (stream && video === videoEl) { running = true; schedule(); return true; }
    stop();
    video = videoEl;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot open the camera.');
    const want = (deviceId) => ({ audio: false, video: { ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }), width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } });
    let saved = LS.get('camId', null);
    try { stream = await navigator.mediaDevices.getUserMedia(want(saved)); }
    catch (e) { if (!saved) throw e; LS.del('camId'); saved = null; stream = await navigator.mediaDevices.getUserMedia(want(null)); }
    if (!saved) {
      // Phones have several back cameras; the wide-angle ones often can't focus up close. Use the main one (lowest number).
      const main = await mainBackCamera();
      const cur = stream.getVideoTracks()[0].getSettings().deviceId;
      if (main && main !== cur) { stream.getTracks().forEach(t => t.stop()); try { stream = await navigator.mediaDevices.getUserMedia(want(main)); } catch (e) { stream = await navigator.mediaDevices.getUserMedia(want(null)); } }
    }
    const tr = stream.getVideoTracks()[0];
    try { await tr.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) {}
    // a little zoom lets the label sit at a distance the lens can focus, while still filling the frame
    const z = zoomRange();
    if (z) await setZoom(Math.min(z.max, LS.get('camZoom', 2)));
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
  async function backCameras() {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    const back = devs.filter(d => /back|rear|environment/i.test(d.label));
    return back.length ? back : devs;
  }
  async function mainBackCamera() {
    try {
      const back = await backCameras();
      if (back.length < 2) return null;
      const num = d => { const m = /(\d+)/.exec(d.label); return m ? +m[1] : 99; };
      return back.slice().sort((a, b) => num(a) - num(b))[0].deviceId;
    } catch (e) { return null; }
  }
  async function nextCamera() {
    const back = await backCameras();
    if (back.length < 2) return false;
    const cur = stream?.getVideoTracks()[0].getSettings().deviceId;
    const i = back.findIndex(d => d.deviceId === cur);
    LS.set('camId', back[(i + 1) % back.length].deviceId);
    const v = video, cb = onCode; stop(); await start(v, cb);
    return true;
  }
  function zoomRange() { try { const c = stream?.getVideoTracks()[0].getCapabilities?.(); return c && c.zoom && c.zoom.max > 1 ? c.zoom : null; } catch (e) { return null; } }
  async function setZoom(z) { const r = zoomRange(); if (!r) return false; z = Math.max(r.min || 1, Math.min(r.max, z)); try { await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ zoom: z }] }); LS.set('camZoom', z); return z; } catch (e) { return false; } }
  function getZoom() { try { return stream?.getVideoTracks()[0].getSettings().zoom || 1; } catch (e) { return 1; } }
  async function focusNow() {
    const tr = stream?.getVideoTracks()[0]; if (!tr) return;
    try { await tr.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] }); setTimeout(() => tr.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}), 1200); } catch (e) {}
  }
  function torchAvailable() { try { return !!stream?.getVideoTracks()[0].getCapabilities?.().torch; } catch (e) { return false; } }
  async function torch(on) { try { await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: on }] }); return true; } catch (e) { return false; } }
  return { start, stop, torch, torchAvailable, zoomRange, setZoom, getZoom, nextCamera, focusNow, backCameras, get active() { return !!stream; } };
})();

/* ---------------- fast scanner (Android app only) ----------------
   Google ML Kit reads barcodes from the camera natively — much faster than reading video frames in
   the page, and it handles small, tilted or slightly blurry labels. The camera picture sits behind
   the page; the page is see-through only inside the scan window. Only barcodes inside that window count,
   so other labels on the shelf around the item are ignored. */
const REPEAT_GAP = 400; // ms a barcode must be out of view before the same code counts again
const Native = (() => {
  const B = () => window.NrrlNative && window.NrrlNative.native && window.NrrlNative.BarcodeScanner;
  let on = false, starting = null, listener = null, onCode = null, rectFn = null, zoomMax = 1, zoom = 1, torchOn = false;
  const seen = new Map();
  let ok;
  async function available() {
    if (ok !== undefined) return ok;
    if (!B() || LS.get('scanEngine', 'fast') === 'basic') return (ok = false);
    try { ok = !!(await B().isSupported()).supported; } catch (e) { ok = false; }
    return ok;
  }
  function inside(bc) {
    const r = rectFn && rectFn();
    if (!r || !bc.cornerPoints || bc.cornerPoints.length < 4) return true;
    const dpr = window.devicePixelRatio || 1;
    const cx = bc.cornerPoints.reduce((a, p) => a + p[0], 0) / 4 / dpr, cy = bc.cornerPoints.reduce((a, p) => a + p[1], 0) / 4 / dpr;
    // only the box itself counts, so moving the label just out of the box is enough to count it again
    // (the camera picture is measured from the top of the screen, the page from below the status bar: a little extra slack below)
    const mx = r.width * 0.04;
    return cx >= r.left - mx && cx <= r.right + mx && cy >= r.top - 12 && cy <= r.bottom + 36;
  }
  async function start(cb, rect) {
    onCode = cb; rectFn = rect;
    if (on) return true;
    if (starting) return starting;
    starting = (async () => {
      const b = B();
      let perm = await b.checkPermissions();
      if (perm.camera !== 'granted') perm = await b.requestPermissions();
      if (perm.camera !== 'granted') throw Object.assign(new Error('Camera permission is blocked'), { name: 'NotAllowedError' });
      listener = await b.addListener('barcodeScanned', ev => {
        const bc = ev && ev.barcode; if (!bc || !onCode) return;
        const code = String(bc.rawValue || bc.displayValue || '').trim(); if (!code || !inside(bc)) return;
        const now = performance.now(), prev = seen.get(code) || 0; seen.set(code, now);
        if (now - prev > REPEAT_GAP) onCode(code); // counts again after a quick move out of the box and back
      });
      document.documentElement.classList.add('native-scan');
      await b.startScan({ formats: ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128', 'CODE_39', 'ITF', 'QR_CODE'] });
      on = true; torchOn = false;
      try { zoomMax = (await b.getMaxZoomRatio()).zoomRatio || 1; } catch (e) { zoomMax = 1; }
      zoom = 1;
      const want = Math.min(zoomMax, LS.get('nZoom', 1.5));
      if (want > 1) await setZoom(want);
      return true;
    })();
    try { return await starting; }
    catch (e) { await stop(); throw e; }
    finally { starting = null; }
  }
  async function stop() {
    onCode = null;
    if (starting) { try { await starting; } catch (e) {} }
    document.documentElement.classList.remove('native-scan');
    if (!on && !listener) return;
    on = false;
    try { await listener?.remove(); } catch (e) {}
    listener = null;
    try { await B()?.stopScan(); } catch (e) {}
  }
  async function setZoom(z) { z = Math.max(1, Math.min(zoomMax, z)); try { await B().setZoomRatio({ zoomRatio: z }); zoom = z; LS.set('nZoom', z); return z; } catch (e) { return false; } }
  async function torchAvail() { try { return (await B().isTorchAvailable()).available; } catch (e) { return false; } }
  async function torch() { try { await B().toggleTorch(); torchOn = !torchOn; return torchOn; } catch (e) { return null; } }
  async function reset() { await stop(); ok = undefined; }
  return { available, reset, start, stop, setZoom, torch, torchAvail, get active() { return on; }, get zoom() { return zoom; }, get zoomMax() { return zoomMax; } };
})();

/* ---------------- live bills ----------------
   Every open bill (and every bill on hold) is kept on the server while it is being made, so it can be passed to
   another person, and the owner can see all of them as they happen. */
const LIVE = { sent: LS.get('liveSent', {}), rows: [], busy: false, t: 0 };
const liveHash = c => JSON.stringify([c.lines, c.discount, c.customer, c.phone, c.mode, c.payment]);
function scheduleLive() { clearTimeout(LIVE.t); LIVE.t = setTimeout(() => liveSync().catch(() => {}), 1200); }
async function liveSync() {
  if (!S.token || LIVE.busy) return;
  LIVE.busy = true;
  try {
    const want = {};
    if (S.cart.lines.length) want[S.cart.id] = { cart: S.cart, state: 'open' };
    for (const h of S.held || []) if (h.cart.lines.length) want[h.cart.id] = { cart: h.cart, state: 'held' };
    for (const [id, w] of Object.entries(want)) {
      const hash = w.state + liveHash(w.cart);
      if (LIVE.sent[id] === hash) continue;
      const r = await api('counter_cart_put', { p_token: S.token, p_id: id, p_cart: w.cart, p_state: w.state, p_device: 'Phone' });
      if (r && r.moved) { lostCart(id, r.to); continue; }
      LIVE.sent[id] = hash;
    }
    for (const id of Object.keys(LIVE.sent)) {
      if (want[id]) continue;
      await api('counter_cart_close', { p_token: S.token, p_id: id }).catch(e => { if (e.net) throw e; });
      delete LIVE.sent[id];
    }
  } catch (e) { /* offline: tried again on the next change or refresh */ }
  finally { LS.set('liveSent', LIVE.sent); LIVE.busy = false; }
}
// a bill that was passed on, or taken over by the owner, leaves this phone
function lostCart(id, to) {
  delete LIVE.sent[id];
  if (S.cart.id === id) { S.cart = freshCart(S.cart); LS.set('cart', S.cart); renderCart(); toast(`This bill is now with ${to}.`, true); }
  const n = (S.held || []).length; S.held = (S.held || []).filter(h => h.cart.id !== id);
  if (S.held.length !== n) { LS.set('held', S.held); renderHeld(); toast(`A held bill is now with ${to}.`, true); }
}
async function liveRefresh() {
  if (!S.token || document.hidden || LIVE.refreshing) return;
  LIVE.refreshing = true;
  try { await liveRefreshNow(); } finally { LIVE.refreshing = false; }
}
async function liveRefreshNow() {
  await liveSync().catch(() => {});
  const before = Object.keys(LIVE.sent);
  try { LIVE.rows = await api('counter_carts', { p_token: S.token }) || []; } catch (e) { return; }
  // a bill of mine that is gone from my list was passed on or taken over: sending it again tells us who has it now
  let check = false;
  for (const id of before) { const r = LIVE.rows.find(x => x.id === id); if (r && !r.mine) lostCart(id, r.staff_name); else if (!r && LIVE.sent[id]) { LIVE.sent[id] = 'check'; check = true; } }
  if (check) await liveSync().catch(() => {});
  renderIncoming();
  if (S.view === 'live') renderLive();
}
setInterval(liveRefresh, 8000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) liveRefresh(); });
function lineTotal(c) { return c.lines.reduce((a, l) => a + (+l.price || +l.rate || 0) * l.qty, 0) - (+c.discount || 0); }
function renderIncoming() {
  const el = $('#incoming'); if (!el) return;
  const inc = LIVE.rows.filter(r => r.mine && r.state === 'sent');
  el.hidden = !inc.length;
  el.innerHTML = inc.map(r => `<div class="inc"><span>📥 <b>${esc(r.from_name || 'Someone')}</b> sent you a bill · ${r.items} item${r.items === 1 ? '' : 's'} · ${money(r.total)}</span><button class="btn sm primary" type="button" data-take="${esc(r.id)}">Open</button></div>`).join('');
}
async function takeCart(id) {
  try {
    await liveSync();
    const r = await api('counter_cart_take', { p_token: S.token, p_id: id, p_device: 'Phone' });
    if (S.cart.lines.length) { S.held.push({ id: Date.now(), at: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }), cart: S.cart }); LS.set('held', S.held); toast('Your current bill was put on hold'); }
    const c = r.cart || {};
    S.cart = { ...freshCart(c), ...c, id: r.id, lines: Array.isArray(c.lines) ? c.lines : [] };
    LIVE.sent[r.id] = 'open' + liveHash(S.cart); LS.set('liveSent', LIVE.sent);
    LS.set('cart', S.cart);
    LIVE.rows = LIVE.rows.map(x => x.id === r.id ? { ...x, mine: true, state: 'open' } : x);
    if (S.view !== 'bill') show('bill');
    renderCart(); renderIncoming();
    toast(r.from ? `Bill from ${r.from} — carry on billing` : 'Bill opened');
  } catch (e) { toast(e.message, true); liveRefresh(); }
}
async function chooseStaff(title, exceptId) {
  let staff = []; try { staff = await api('counter_staff_list'); } catch (e) { staff = LS.get('staff', []); }
  staff = staff.filter(x => x.id !== exceptId);
  if (!staff.length) { toast('There is nobody else to send it to.', true); return null; }
  return new Promise(resolve => {
    const d = openSheet('pickSheet', `<h3>${esc(title)}</h3><div class="names" style="margin-top:10px">${staff.map(x => `<button type="button" data-id="${esc(x.id)}">${esc(x.name)}<small>${x.role === 'owner' ? 'Owner' : 'Staff'}</small></button>`).join('')}</div>
      <div class="acts2"><button class="btn w" type="button" id="pkCancel">Cancel</button></div>`, () => resolve(null));
    $('#pkCancel', d).addEventListener('click', closeSheet);
    $('.names', d).addEventListener('click', e => { const b = e.target.closest('[data-id]'); if (!b) return; d._onClose = null; closeSheet(); resolve(staff.find(x => x.id === b.dataset.id)); });
  });
}
async function transferCart(id, cart) {
  const to = await chooseStaff('Send this bill to', S.me.id);
  if (!to) return;
  try {
    if (cart) { const r = await api('counter_cart_put', { p_token: S.token, p_id: id, p_cart: cart, p_state: 'open', p_device: 'Phone' }); if (r && r.moved) { lostCart(id, r.to); return; } }
    const r = await api('counter_cart_transfer', { p_token: S.token, p_id: id, p_to: to.id });
    delete LIVE.sent[id]; LS.set('liveSent', LIVE.sent);
    if (S.cart.id === id) { S.cart = freshCart(S.cart); LS.set('cart', S.cart); renderCart(); }
    toast(`Bill sent to ${r.to}. It shows on their phone or laptop.`);
    liveRefresh();
  } catch (e) { toast(e.net ? 'No internet — the bill can be sent once the connection is back.' : e.message, true); }
}
/* Owner: every bill being made right now, on every phone and laptop */
function renderLive() {
  const el = $('#v-live'); if (!el) return;
  const rows = LIVE.rows, ago = t => { const m = Math.round((Date.now() - new Date(t)) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };
  const ST = { open: ['chip ok', 'Billing now'], held: ['chip low', 'On hold'], sent: ['chip acc', 'Waiting to be opened'] };
  el.innerHTML = `<div class="page"><div class="ph"><h2>Live bills</h2><button class="btn sm" id="lvRef">Refresh</button></div>
    <p class="hint" style="margin:-4px 0 12px">Bills being made right now on every phone and laptop. Updates every few seconds.</p>
    <ul class="list">${rows.length ? rows.map(r => `<li><button class="row" type="button" data-lv="${esc(r.id)}"><span class="nm">${esc(r.staff_name)} <small class="hint">· ${esc(r.device || '')}</small></span>
      <span class="rt"><b class="num">${money(r.total)}</b></span><span class="meta"><span class="${ST[r.state]?.[0] || 'chip'}">${ST[r.state]?.[1] || r.state}</span><span>${r.items} item${r.items === 1 ? '' : 's'}</span>${r.cart?.customer ? `<span>${esc(r.cart.customer)}</span>` : ''}${r.from_name ? `<span>from ${esc(r.from_name)}</span>` : ''}<span>${ago(r.updated_at)}</span></span></button>
      ${LIVE.open === r.id ? `<div class="detail"><table>${(r.cart?.lines || []).map(l => `<tr><td>${esc(l.name)}<div class="hint">${l.qty} ${esc(l.unit || '')} × ${money(+l.price || +l.rate || 0)}</div></td><td>${money((+l.price || +l.rate || 0) * l.qty)}</td></tr>`).join('')}</table>
        <div class="acts">${r.mine ? '' : `<button class="btn sm primary" type="button" data-lvtake="${esc(r.id)}">Take over</button>`}<button class="btn sm" type="button" data-lvsend="${esc(r.id)}">Send to…</button></div></div>` : ''}</li>`).join('')
      : '<li class="empty"><b>No bills in progress</b>When anyone starts a bill on a phone or laptop, it shows here.</li>'}</ul></div>`;
  $('#lvRef').addEventListener('click', liveRefresh);
  el.querySelector('.list').addEventListener('click', e => {
    const t = e.target.closest('[data-lvtake]'), sd = e.target.closest('[data-lvsend]'), o = e.target.closest('[data-lv]');
    if (t) return takeCart(t.dataset.lvtake);
    if (sd) return transferCart(sd.dataset.lvsend, null);
    if (o) { LIVE.open = LIVE.open === o.dataset.lv ? null : o.dataset.lv; renderLive(); }
  });
}

/* ---------------- shell ---------------- */
const ICON = {
  bill: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/>',
  items: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
  bills: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
  live: '<circle cx="12" cy="12" r="3"/><path d="M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7"/>',
  staff: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .8 3.2 2.5 3.6 5.2"/>',
};
const svg = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;

function boot() {
  if (!S.token || !S.me) return showLogin();
  showApp();
  refreshMe();
}

async function refreshMe() {
  if (!S.token) return;
  try {
    const me = await api('counter_me', { p_token: S.token });
    const changed = !!(S.me && S.me.perms) && JSON.stringify([S.me.role, S.me.perms]) !== JSON.stringify([me.role, me.perms]);
    S.me = me; LS.set('me', me); renderWho();
    if (changed && !anySheetOpen() && !saving) { toast('Your access was updated by the owner'); showApp(S.view); }
  } catch (e) {}
}
setInterval(() => { if (S.token && !document.hidden) refreshMe(); }, 30000);

/* ---------------- login ---------------- */
let loginStaff = null, pin = '';
async function showLogin() {
  Scanner.stop(); Native.stop();
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
    S.token = r.token; S.me = { id: r.id, name: r.name, role: r.role, perms: r.perms };
    LS.set('token', S.token); LS.set('me', S.me); LS.set('lastStaff', r.id);
    pin = ''; showApp();
  } catch (e) { pin = ''; drawPin(); $('#perr').textContent = e.message; beep(false); }
}
async function logout(expired) {
  const t = S.token;
  // the open bill stays on this phone for whoever logs in next: take it off this person's live list first
  if (t && !expired) for (const id of Object.keys(LIVE.sent)) await api('counter_cart_close', { p_token: t, p_id: id }).catch(() => {});
  LIVE.sent = {}; LIVE.rows = []; LS.set('liveSent', {});
  S.cart.id = uid(); LS.set('cart', S.cart);
  (S.held || []).forEach(h => { h.cart.id = uid(); }); LS.set('held', S.held || []);
  S.token = null; S.me = null; LS.del('token'); LS.del('me');
  if (t && !expired) api('counter_logout', { p_token: t }).catch(() => {});
  loginStaff = null;
  if (expired) toast('Session ended. Please log in again.', true);
  showLogin();
}

/* ---------------- main app ---------------- */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; const b = $('#installBtn'); if (b) b.hidden = false; });
function showApp(view) {
  Native.stop(); Scanner.stop();
  const tabs = [['bill', 'Bill']].concat(isOwner() ? [['live', 'Live']] : [], can('sales') ? [['bills', 'Sales']] : [], [['items', 'Items']], isOwner() ? [['staff', 'Staff']] : []);
  $('#app').innerHTML = `
    <header class="topbar"><h1>NRRL Counter</h1>
      <div class="who"><button class="themebtn" id="themeBtn" type="button"></button><button class="btn sm" id="installBtn" hidden>Install app</button><span class="net${netOk ? '' : ' off'}" id="net"></span><b id="whoName"></b><button class="btn sm" id="logoutBtn">Log out</button></div></header>
    <div class="banner" id="pendBanner" hidden></div>
    <main id="main">
      <section id="v-bill"></section>
      <section id="v-bills" hidden></section>
      <section id="v-items" hidden></section>
      <section id="v-staff" hidden></section>
      <section id="v-live" hidden></section>
    </main>
    <nav class="tabs">${tabs.map(([k, l]) => `<button type="button" data-tab="${k}">${svg(ICON[k === 'bills' ? 'bills' : k])}${l}</button>`).join('')}</nav>`;
  renderWho();
  $('#logoutBtn').addEventListener('click', () => { Scanner.stop(); Native.stop(); logout(false); });
  const THEMES = { light: 'Light', dark: 'Dark', auto: 'Auto' }, TICON = { light: '☀', dark: '☾', auto: '◐' };
  const drawTheme = () => { const t = document.documentElement.dataset.theme || 'light'; $('#themeBtn').textContent = TICON[t] || '☀'; $('#themeBtn').setAttribute('aria-label', 'Theme: ' + THEMES[t]); };
  drawTheme();
  $('#themeBtn').addEventListener('click', () => {
    const order = ['light', 'dark', 'auto'], cur = document.documentElement.dataset.theme || 'light';
    const next = order[(order.indexOf(cur) + 1) % 3];
    document.documentElement.dataset.theme = next; LS.set('theme', next); drawTheme();
    toast(next === 'auto' ? 'Theme follows your phone' : (THEMES[next] + ' theme'));
  });
  $('#installBtn').hidden = !installEvt;
  $('#installBtn').addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); installEvt = null; $('#installBtn').hidden = true; });
  $('nav.tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) show(b.dataset.tab); });
  buildBill();
  show(tabs.some(t => t[0] === view) ? view : 'bill');
  loadItems(true);
  syncPending();
  liveRefresh();
}
function renderWho() { const w = $('#whoName'); if (w && S.me) w.textContent = S.me.name + (isOwner() ? ' · Owner' : ''); }
function show(v) {
  S.view = v;
  $$('nav.tabs [data-tab]').forEach(b => b.dataset.tab === v ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  ['bill', 'bills', 'items', 'staff', 'live'].forEach(k => { const el = $('#v-' + k); if (el) el.hidden = k !== v; });
  if (v === 'bill' && can('bill')) startCam(); else { Scanner.stop(); Native.stop(); }
  if (v === 'bills') renderBills(true);
  if (v === 'items') { renderItems(); loadItems(true); }
  if (v === 'staff') renderStaff();
  if (v === 'live') { renderLive(); liveRefresh(); }
}
document.addEventListener('visibilitychange', () => {
  if (!S.token) return;
  if (document.hidden) { Scanner.stop(); Native.stop(); } else if (S.view === 'bill' && can('bill') && !anySheetOpen()) startCam();
});
const anySheetOpen = () => !!$('.sheet');

/* ---------------- bill screen ---------------- */
function buildBill() {
  if (!can('bill')) { $('#v-bill').innerHTML = `<div class="page"><div class="empty" style="padding:40px 16px"><b>Billing is switched off for you</b>Ask the owner to switch on “Make bills” for you in the Staff tab.</div></div>`; return; }
  $('#v-bill').innerHTML = `
    <div class="cam" id="cam">
      <video id="camVideo" playsinline muted></video>
      <div class="aim"></div>
      <div class="camtools"><button type="button" id="zoomBtn" hidden>2×</button><button type="button" id="camBtn" hidden>Switch</button><button type="button" id="torchBtn" aria-pressed="false" hidden>Light</button><button type="button" id="engBtn" hidden></button></div>
      <div class="flash" id="flash">Point at a barcode or QR code</div>
      <button type="button" class="again" id="againBtn" hidden aria-label="Add one more of the last item">+1</button>
      <div class="off" id="camOff" hidden><span id="camMsg">Camera is off</span><button type="button" class="btn" id="camOn">Start camera</button></div>
    </div>
    <div class="billtools">
      <input type="search" id="find" placeholder="Search item or type code" autocomplete="off" enterkeyhint="go">
      <div class="seg" role="group" aria-label="Price list"><button type="button" data-mode="retail">Retail</button><button type="button" data-mode="wholesale">Wholesale</button></div>
    </div>
    <div class="quick" id="quick" hidden aria-label="Often sold"></div>
    <ul class="results" id="results"></ul>
    <div class="incoming" id="incoming" hidden></div>
    <div class="heldbar" id="heldBar" hidden></div>
    <ul class="lines" id="lines"></ul>
    <div class="paybar" id="paybar"></div>`;
  $('#camOn').addEventListener('click', startCam);
  $('#againBtn').addEventListener('click', () => { const it = S.items.get(S.lastAdded); if (it) addItem(it); });
  $('#engBtn').addEventListener('click', async () => {
    const basic = LS.get('scanEngine', 'fast') === 'basic';
    LS.set('scanEngine', basic ? 'fast' : 'basic');
    await Native.reset(); Scanner.stop();
    toast(basic ? 'Fast scanner on' : 'Normal camera on (slower). Tap again for the fast scanner.');
    startCam();
  });
  $('#zoomBtn').addEventListener('click', async () => {
    if (Native.active) {
      const steps = [1, 1.5, 2, 3, 4].filter(z => z <= Native.zoomMax), next = steps.find(z => z > Native.zoom + 0.05) || steps[0];
      const z = await Native.setZoom(next); if (z) $('#zoomBtn').textContent = (Math.round(z * 10) / 10) + '×';
      return;
    }
    const r = Scanner.zoomRange(); if (!r) return;
    const steps = [1, 1.5, 2, 3, 4].filter(z => z <= r.max);
    const cur = Scanner.getZoom(), next = steps.find(z => z > cur + 0.05) || steps[0];
    const z = await Scanner.setZoom(next); if (z) $('#zoomBtn').textContent = (Math.round(z * 10) / 10) + '×';
  });
  $('#camBtn').addEventListener('click', async () => { $('#camBtn').disabled = true; try { await Scanner.nextCamera(); camTools(); toast('Switched camera'); } catch (e) { toast('Could not switch camera', true); } $('#camBtn').disabled = false; });
  $('#camVideo').addEventListener('click', () => { Scanner.focusNow(); flash('hit', 'Focusing…'); });
  $('#torchBtn').addEventListener('click', async e => { if (Native.active) { const t = await Native.torch(); if (t != null) e.currentTarget.setAttribute('aria-pressed', t); return; } const on = e.currentTarget.getAttribute('aria-pressed') !== 'true'; if (await Scanner.torch(on)) e.currentTarget.setAttribute('aria-pressed', on); });
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
  $('#quick').addEventListener('click', e => { const b = e.target.closest('[data-code]'); if (b) addItem(S.items.get(b.dataset.code)); });
  renderQuick();
  $('#results').addEventListener('click', e => { const b = e.target.closest('[data-code]'); if (!b) return; addItem(S.items.get(b.dataset.code)); find.value = ''; renderResults(''); });
  $('.billtools .seg').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (!b) return; setMode(b.dataset.mode); });
  $('#lines').addEventListener('click', onLineClick);
  $('#lines').addEventListener('change', onLineChange);
  renderCart();
}
async function camTools() {
  if (!$('#torchBtn')) return;
  $('#engBtn').hidden = !(window.NrrlNative && window.NrrlNative.native);
  $('#engBtn').textContent = Native.active ? 'Fast' : 'Normal';
  if (Native.active) {
    $('#torchBtn').hidden = !(await Native.torchAvail());
    $('#zoomBtn').hidden = Native.zoomMax <= 1; $('#zoomBtn').textContent = (Math.round(Native.zoom * 10) / 10) + '×';
    $('#camBtn').hidden = true;
    return;
  }
  $('#torchBtn').hidden = !Scanner.torchAvailable();
  const r = Scanner.zoomRange();
  $('#zoomBtn').hidden = !r; if (r) $('#zoomBtn').textContent = (Math.round(Scanner.getZoom() * 10) / 10) + '×';
  try { $('#camBtn').hidden = (await Scanner.backCameras()).length < 2; } catch (e) {}
}
async function startCam() {
  const off = $('#camOff'); if (!off) return;
  if (await Native.available()) {
    try {
      await Native.start(onScan, () => { const a = $('#cam .aim') || $('#cam'); return a && a.getBoundingClientRect(); });
      if (S.view !== 'bill' || document.hidden) { Native.stop(); return; }
      off.hidden = true; $('#flash').textContent = 'Fast scanner on · hold the barcode in the box';
      setTimeout(camTools, 300);
      return;
    } catch (e) {
      if (e && e.name === 'NotAllowedError') { off.hidden = false; $('#camMsg').textContent = 'Camera permission is blocked. Allow camera for NRRL Counter in phone Settings → Apps, then tap Start camera.'; return; }
      toast('Fast scanner could not start, using the normal camera', true);
    }
  }
  try {
    await Scanner.start($('#camVideo'), onScan);
    off.hidden = true;
    setTimeout(camTools, 600);
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
  if (!can('add')) { toast(`Code ${code} isn’t in the item list. Ask the owner to add it.`, true); return; }
  openItemSheet({ code }, { fromBill: true });
}
function priceFor(it) { return S.cart.mode === 'wholesale' && it.wholesale > 0 ? it.wholesale : it.retail; }
function unitFor(it) { return S.cart.mode === 'wholesale' && it.wholesale > 0 && it.wholesale_unit ? it.wholesale_unit : it.unit; }
function addItem(it, qty = 1) {
  if (!it) return;
  const c = S.cart;
  let i = c.lines.findIndex(l => l.code === it.code);
  let l;
  if (i >= 0) { l = c.lines[i]; l.qty = r2(l.qty + qty); c.lines.splice(i, 1); c.lines.unshift(l); }
  else { l = { code: it.code, name: it.name, unit: unitFor(it), gst: it.gst, price: priceFor(it), qty }; c.lines.unshift(l); }
  saveCart(); renderCart(true); bumpFreq(it.code);
  beep(true); flash('hit', `✓ ${it.name} · ${l.qty} ${l.unit}`);
  S.lastAdded = it.code; showAgain();
  if (it.stock != null && it.stock - l.qty < 0) toast(`${it.name}: stock shows ${it.stock} left`, true);
}
// big "+1" on the camera: one more of the item just scanned, without scanning it again
function showAgain() {
  const ag = $('#againBtn'); if (!ag) return;
  const on = !!S.lastAdded && S.cart.lines.some(l => l.code === S.lastAdded);
  ag.hidden = !on; $('#cam').classList.toggle('again-on', on);
}
function setMode(m) {
  S.cart.mode = m;
  S.cart.lines.forEach(l => { const it = S.items.get(l.code); if (it) { l.price = priceFor(it); l.unit = unitFor(it); } });
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
  const c = S.cart, own = can('rate');
  if (!$('#lines')) return;
  $('#v-bill').classList.toggle('has-lines', c.lines.length > 0);
  showAgain();
  if (!own && c.discount) c.discount = 0;
  $$('.billtools [data-mode]').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === c.mode));
  const ul = $('#lines');
  ul.innerHTML = c.lines.length ? c.lines.map((l, i) => `<li class="line${fresh && i === 0 ? ' new' : ''}">
      <div><div class="nm">${esc(l.name)}</div><div class="sub">${esc(l.code)} · ${money(l.price)}/${esc(l.unit)}</div></div>
      <div class="amt num">${money(l.price * l.qty)}</div>
      <div class="ctr">
        <button class="qb" type="button" data-dec="${i}" aria-label="One less">−</button>
        <input type="number" inputmode="decimal" data-q="${i}" value="${l.qty}" aria-label="Quantity">
        <button class="qb" type="button" data-inc="${i}" aria-label="One more">+</button>
        ${quickKeys(l).map(k => `<button class="qk" type="button" data-qk="${k.k}" data-qi="${i}" title="${esc(k.title)}">${esc(k.label)}</button>`).join('')}
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
      ${own ? `<label class="sub" for="disc" style="margin-left:auto">Disc ₹</label><input type="number" inputmode="decimal" id="disc" value="${c.discount || ''}" placeholder="0">` : '<span style="margin-left:auto"></span>'}
      <button class="btn sm" type="button" id="holdBtn" ${c.lines.length ? '' : 'disabled'}>Hold</button>
      <button class="btn sm" type="button" id="sendBtn" ${c.lines.length ? '' : 'disabled'}>Send to…</button>
      <button class="btn sm" type="button" id="custBtn" aria-expanded="${!!(c.customer || c.phone || c.payment === 'udhaar')}">${c.customer ? esc(c.customer) : 'Customer'}</button>
    </div>
    <div class="more" id="custFields" ${c.customer || c.phone || c.payment === 'udhaar' ? '' : 'hidden'}>
      <input type="text" id="cName" placeholder="Customer name" value="${esc(c.customer)}">
      <input type="tel" id="cPhone" placeholder="WhatsApp number" inputmode="numeric" value="${esc(c.phone)}">
    </div>`;
  $('#saveBtn').addEventListener('click', saveBill);
  $('#paybar .seg').addEventListener('click', e => { const b = e.target.closest('[data-pay]'); if (!b) return; c.payment = b.dataset.pay; saveCart(); renderCart(); });
  $('#disc')?.addEventListener('change', e => { c.discount = Math.max(0, r2(e.target.value)); saveCart(); renderCart(); });
  $('#holdBtn').addEventListener('click', holdBill);
  $('#sendBtn').addEventListener('click', () => transferCart(c.id, c));
  if (!$('#incoming')._wired) { $('#incoming')._wired = true; $('#incoming').addEventListener('click', e => { const b = e.target.closest('[data-take]'); if (b) takeCart(b.dataset.take); }); }
  renderIncoming();
  renderHeld();
  $('#custBtn').addEventListener('click', () => { const f = $('#custFields'); f.hidden = !f.hidden; if (!f.hidden) $('#cName').focus(); });
  $('#cName').addEventListener('input', e => { c.customer = e.target.value; saveCart(); });
  $('#cPhone').addEventListener('input', e => { c.phone = e.target.value; saveCart(); });
}
/* one tap for a dozen, ten, or the item's own pack (its wholesale unit). First tap sets it, next tap adds another. */
function quickKeys(l) {
  const it = S.items.get(l.code), out = [], u = String(l.unit || '').toLowerCase();
  if (!/^doz/.test(u)) out.push({ k: 'doz', n: 12, label: 'Doz', title: '12 ' + l.unit });
  out.push({ k: 'ten', n: 10, label: '10', title: '10 ' + l.unit });
  if (it && it.wholesale_unit && it.wholesale_unit !== l.unit && it.wholesale_qty > 1) out.push({ k: 'pack', n: it.wholesale_qty, label: `1 ${it.wholesale_unit}`, title: `${it.wholesale_qty} ${l.unit}` });
  return out;
}
/* Hold a bill while the customer keeps shopping; serve the next person; tap it to continue. */
S.held = LS.get('held', []);
function holdText(c) { return `${c.customer || 'Customer'} · ${c.lines.length} item${c.lines.length === 1 ? '' : 's'} · ${money(c.lines.reduce((a, l) => a + l.price * l.qty, 0))}`; }
function holdBill() {
  if (!S.cart.lines.length) return;
  S.held.push({ id: Date.now(), at: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }), cart: S.cart });
  LS.set('held', S.held); toast('Bill on hold: ' + holdText(S.cart));
  S.cart = freshCart(S.cart); saveCart(); renderCart();
}
function renderHeld() {
  scheduleLive();
  const el = $('#heldBar'); if (!el) return;
  el.hidden = !S.held.length;
  el.innerHTML = '<span class="lbl">On hold</span>' + S.held.map(h => `<span class="hchip"><button type="button" data-hold="${h.id}">${esc(holdText(h.cart))} <small>${esc(h.at)}</small></button><button type="button" class="hx" data-hdel="${h.id}" aria-label="Delete held bill">×</button></span>`).join('');
  if (!el._wired) {
    el._wired = true;
    el.addEventListener('click', e => {
      const o = e.target.closest('[data-hold]'), x = e.target.closest('[data-hdel]');
      if (o) {
        const i = S.held.findIndex(h => h.id === +o.dataset.hold); if (i < 0) return;
        const h = S.held.splice(i, 1)[0];
        if (S.cart.lines.length) S.held.push({ id: Date.now(), at: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }), cart: S.cart });
        S.cart = h.cart; S.cart.lines.forEach(l => { const it = S.items.get(l.code); if (it && !can('rate')) l.price = priceFor(it); });
        LS.set('held', S.held); saveCart(); renderCart();
      }
      if (x) { if (!confirmTap(x)) return; S.held = S.held.filter(h => h.id !== +x.dataset.hdel); LS.set('held', S.held); renderHeld(); }
    });
  }
}
function confirmTap(btn) { if (btn.dataset.armed) return true; btn.dataset.armed = '1'; btn.textContent = 'Delete?'; setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = '×'; } }, 2500); return false; }
function onLineClick(e) {
  const b = e.target.closest('button'); if (!b) return;
  const L = S.cart.lines;
  if (b.dataset.qk) { const l = L[+b.dataset.qi], k = l && quickKeys(l).find(x => x.k === b.dataset.qk); if (k) { l.qty = r2(l.qty === 1 ? k.n : l.qty + k.n); beep(true); } }
  else if (b.dataset.inc != null) L[b.dataset.inc].qty = r2(L[b.dataset.inc].qty + 1);
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
/* Search: every word must match the start of a word in the name, anywhere in the name or code,
   or be one letter off (typo). Best matches and often-sold items come first. */
const normQ = t => String(t || '').toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, ' ').trim();
function near(a, b) { // true if a and b differ by at most one letter
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, d = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++d > 1) return false;
    if (a[i] === b[j + 1] && a[i + 1] === b[j]) { i += 2; j += 2; continue; } // swapped letters
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return d + (a.length - i) + (b.length - j) <= 1;
}
function rankItems(list, q, limit = 8) {
  const nq = normQ(q); if (!nq) return [];
  const words = nq.split(' '), lq = String(q).trim().toLowerCase(), freq = LS.get('freq', {}), out = [];
  for (const it of list) {
    const code = it.code.toLowerCase(), name = normQ(it.name), nw = name.split(' ');
    let sc;
    if (code === lq) sc = 1000; else if (lq.length >= 2 && code.startsWith(lq)) sc = 500;
    else {
      sc = 0;
      for (const w of words) {
        if (nw.some(x => x.startsWith(w))) sc += 30;
        else if (name.includes(w)) sc += 15;
        else if (code.includes(w)) sc += 12;
        else if (w.length >= 4 && nw.some(x => near(x.slice(0, w.length), w) || near(x.slice(0, w.length + 1), w) || near(x, w))) sc += 6;
        else { sc = -1; break; }
      }
      if (sc < 0 || (nq.length < 2 && !nw.some(x => x.startsWith(nq)))) continue;
      if (name.startsWith(nq)) sc += 40;
    }
    out.push([sc + Math.min(25, freq[it.code] || 0), it]);
  }
  return out.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name)).slice(0, limit).map(x => x[1]);
}
const search = q => rankItems(S.items.values(), q, 8);
function bumpFreq(code) { const f = LS.get('freq', {}); f[code] = (f[code] || 0) + 1; LS.set('freq', f); }
function topItems(n) { const f = LS.get('freq', {}); return Object.keys(f).filter(c => S.items.has(c)).sort((a, b) => f[b] - f[a]).slice(0, n).map(c => S.items.get(c)); }
function hl(text, q) { // highlight the typed words
  const ws = normQ(q).split(' ').filter(w => w.length > 1); let h = esc(text);
  for (const w of ws) h = h.replace(new RegExp('(^|[^a-z0-9])(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'i'), '$1<mark>$2</mark>');
  return h;
}
function renderResults(q) {
  $('#results').innerHTML = search(q).map(it => `<li><button type="button" data-code="${esc(it.code)}"><span class="nm">${hl(it.name, q)} <span class="code">${esc(it.code)}</span></span><span class="num">${money(priceFor(it))}</span></button></li>`).join('');
}
function renderQuick() {
  const el = $('#quick'); if (!el) return;
  const top = topItems(10);
  el.hidden = !top.length;
  el.innerHTML = top.map(it => `<button type="button" data-code="${esc(it.code)}">${esc(it.name)}</button>`).join('');
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
    lines: c.lines.map(l => can('rate') ? { code: l.code, qty: l.qty, price: l.price } : { code: l.code, qty: l.qty }),
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
  // wholesale lines in packs/dozens take out that many pieces
  c.lines.forEach(l => { const it = S.items.get(l.code); if (it && it.stock != null) { const f = it.wholesale_unit && l.unit === it.wholesale_unit && it.wholesale_unit !== it.unit && it.wholesale_qty > 0 ? it.wholesale_qty : 1; it.stock = r2(it.stock - l.qty * f); } });
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
  b.textContent = failed ? `${failed} bill(s) could not upload: ${S.pending.find(p => p.error).error} — tap to see` : `${n} bill(s) saved on this phone, uploading when internet is back…`;
  b.style.cursor = failed ? 'pointer' : '';
  b.onclick = failed ? failedBillsSheet : null;
}
/* Bills the server refused (not a connection problem) would otherwise retry forever: show them and let the owner remove them. */
function failedBillsSheet() {
  const bad = S.pending.filter(p => p.error);
  if (!bad.length) return;
  const d = openSheet('failSheet', `<h3>Bills that could not upload</h3>
    <p class="s">The server refused these. Check the reason, fix it (for example add the missing item), then tap Try again. Remove a bill only if you are sure it should not count.</p>
    <ul class="list">${bad.map((p, i) => `<li style="padding:8px 0;border-bottom:1px solid var(--line)"><b>${money(p.local.total)}</b> · ${esc(p.local.customer || 'Walk-in')} · ${new Date(p.local.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}<div class="hint">${esc(p.error)}</div>
      <div class="hint">${p.local.lines.map(l => esc(`${l.qty} × ${l.name}`)).join(', ')}</div><button class="btn sm danger" type="button" data-drop="${i}" data-twotap style="margin-top:6px">Remove this bill</button></li>`).join('')}</ul>
    <div class="acts2"><button class="btn" type="button" id="fsClose">Close</button><button class="btn primary" type="button" id="fsRetry">Try again</button></div>`);
  $('#fsClose', d).addEventListener('click', closeSheet);
  $('#fsRetry', d).addEventListener('click', () => { S.pending.forEach(p => { delete p.error; }); LS.set('pending', S.pending); closeSheet(); syncPending(); });
  d.addEventListener('click', e => {
    const x = e.target.closest('[data-drop]'); if (!x) return;
    if (!confirmTap(x)) return;
    const p = bad[+x.dataset.drop]; S.pending = S.pending.filter(y => y !== p); LS.set('pending', S.pending);
    closeSheet(); renderPendingBanner(); toast('Bill removed'); if (S.pending.some(y => y.error)) failedBillsSheet();
  });
}
setInterval(() => { if (S.token) syncPending(); }, 20000);
window.addEventListener('online', () => S.token && syncPending());
setInterval(() => { if (S.token && !document.hidden) loadItems(true); }, 20000);
setInterval(() => { if (S.token && !document.hidden && S.view === 'bills' && !document.querySelector('.sheet')) renderBills(true); }, 30000);

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
/* Bill as a PDF, shared from the phone (pick WhatsApp, then the customer). Android app only. */
function billPdf(b) {
  const { jsPDF } = window.NrrlPdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const R = n => 'Rs. ' + (Math.round((+n || 0) * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const asc = t => String(t ?? '').replace(/₹/g, 'Rs.').replace(/[^\x20-\x7e]/g, '');
  const d = new Date(b.created_at);
  let y = 18;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text(asc(CFG.shop), 15, y);
  doc.setFontSize(13); doc.text('BILL', 195, y, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  y += 7; doc.text(asc('nrrl.in'), 15, y);
  doc.text(`No. ${b.id ? b.id : 'pending'}   ${d.toLocaleDateString('en-IN')} ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`, 195, y, { align: 'right' });
  y += 4; doc.setLineWidth(0.5); doc.line(15, y, 195, y);
  y += 7; doc.setFont('helvetica', 'bold'); doc.text('Bill to: ', 15, y); doc.setFont('helvetica', 'normal'); doc.text(asc(b.customer || 'Cash customer') + (b.phone ? '   ' + asc(b.phone) : ''), 31, y);
  doc.text('Payment: ' + (b.payment === 'upi' ? 'UPI' : b.payment === 'udhaar' ? 'Udhaar (credit)' : 'Cash') + (b.mode === 'wholesale' ? '  (wholesale rates)' : ''), 195, y, { align: 'right' });
  y += 8; doc.setFillColor(240, 238, 247); doc.rect(15, y - 5, 180, 7, 'F'); doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
  doc.text('#', 17, y); doc.text('ITEM', 25, y); doc.text('QTY', 130, y, { align: 'right' }); doc.text('RATE', 160, y, { align: 'right' }); doc.text('AMOUNT', 193, y, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  b.lines.forEach((l, i) => {
    y += 7;
    if (y > 270) { doc.addPage(); y = 20; }
    const nm = doc.splitTextToSize(asc(l.name), 95);
    doc.text(String(i + 1), 17, y); doc.text(nm, 25, y);
    doc.text(`${l.qty} ${asc(l.unit || '')}`, 130, y, { align: 'right' }); doc.text(R(l.price).slice(4), 160, y, { align: 'right' }); doc.text(R(l.amount).slice(4), 193, y, { align: 'right' });
    y += (nm.length - 1) * 4.5;
    doc.setDrawColor(220); doc.line(15, y + 2.5, 195, y + 2.5);
  });
  y += 10; doc.setFontSize(10);
  const row = (k, v, bold) => { doc.setFont('helvetica', bold ? 'bold' : 'normal'); if (bold) doc.setFontSize(13); doc.text(k, 140, y); doc.text(v, 193, y, { align: 'right' }); doc.setFontSize(10); y += bold ? 8 : 6; };
  row('Subtotal', R(b.subtotal));
  if (+b.discount) row('Discount', '- ' + R(b.discount));
  row('Total', R(b.total), true);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text(`Prices include GST (${R(b.gst)}).`, 15, y);
  y += 12; doc.setFontSize(11); doc.text('Thank you for shopping with us!', 15, y);
  return doc.output('datauristring').split(',')[1];
}
const canPdf = () => !!(window.NrrlNative && window.NrrlNative.native && window.NrrlNative.Share);
async function sharePdf(b) {
  const N = window.NrrlNative;
  try {
    toast('Making the PDF…');
    if (!window.NrrlPdf) await loadScript(['pdf.js']); // the PDF maker loads the first time it is used
    const name = `Bill-${b.id || Date.now()}.pdf`;
    const w = await N.Filesystem.writeFile({ path: name, data: billPdf(b), directory: N.Directory.Cache });
    await N.Share.share({ title: 'Bill ' + (b.id || ''), text: `${CFG.shop} · Bill ${b.id || ''} · ₹${b.total}`, files: [w.uri], dialogTitle: 'Send bill PDF' });
  } catch (e) { if (!/cancel/i.test(String(e && e.message))) toast('Could not share the PDF: ' + (e.message || e), true); }
}
function waLink(b) { let p = String(b.phone || '').replace(/\D/g, ''); if (p.length === 10) p = '91' + p; return 'https://wa.me/' + p + '?text=' + encodeURIComponent(billText(b)); }

/* ---------------- barcodes and labels ----------------
   Code 128 (what the laptop prints for NR… codes). Bars are drawn as whole printer dots
   (8 dots per mm, the usual 203 dpi label printer), so the label scans first time. */
const C128 = ['212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212','112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131','311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321','112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121','313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111','314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114','122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212','124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113','114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','2331112'];
// bars as [start, width] in modules (quiet zones not included); null when the code can't be a Code 128
function code128(text) {
  text = String(text || '');
  if (!text || /[^\x20-\x7e]/.test(text)) return null;
  let vals;
  if (/^\d+$/.test(text) && text.length % 2 === 0 && text.length >= 4) { vals = [105]; for (let i = 0; i < text.length; i += 2) vals.push(+text.substr(i, 2)); }
  else { vals = [104]; for (const ch of text) vals.push(ch.charCodeAt(0) - 32); }
  let sum = vals[0]; for (let i = 1; i < vals.length; i++) sum += vals[i] * i;
  vals.push(sum % 103, 106);
  const bars = []; let x = 0;
  for (const v of vals) { const p = C128[v]; for (let i = 0; i < p.length; i++) { const w = +p[i]; if (i % 2 === 0) bars.push([x, w]); x += w; } }
  return { bars, modules: x };
}
function barcodeSvg(text, h = 56) {
  const c = code128(text); if (!c) return '';
  const q = 10, W = c.modules + 2 * q;
  return `<svg viewBox="0 0 ${W} ${h}" preserveAspectRatio="none" role="img" aria-label="Barcode ${esc(text)}"><rect width="${W}" height="${h}" fill="#fff"/>${c.bars.map(([x, w]) => `<rect x="${x + q}" y="0" width="${w}" height="${h}" fill="#000"/>`).join('')}</svg>`;
}
const LABEL_SIZES = { '50x25': [50, 25], '38x25': [38, 25], '100x50': [100, 50] };
const DOT = 8; // printer dots per mm (203 dpi)
// one label as a black-and-white picture, exactly the label's size in printer dots
function labelCanvas(it, size) {
  const [wmm, hmm] = LABEL_SIZES[size] || LABEL_SIZES['50x25'];
  const W = wmm * DOT, H = hmm * DOT, k = hmm / 25; // text scales with the label height
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.fillStyle = '#000'; g.textBaseline = 'top';
  const pad = Math.round(1.5 * DOT);
  const fit = (t, px, weight, maxW) => { let f = px; do { g.font = `${weight} ${f}px Inter, Roboto, Arial, sans-serif`; if (g.measureText(t).width <= maxW) break; f--; } while (f > 10); return f; };
  // name: up to two lines
  const namePx = Math.round(2.6 * DOT * k);
  g.font = `700 ${namePx}px Inter, Roboto, Arial, sans-serif`;
  const words = String(it.name || '').split(/\s+/); const lines = []; let cur = '';
  for (const w of words) { const t = cur ? cur + ' ' + w : w; if (g.measureText(t).width <= W - 2 * pad || !cur) cur = t; else { lines.push(cur); cur = w; } }
  if (cur) lines.push(cur);
  let y = Math.round(1.2 * DOT);
  const twoLines = lines.length > 1 && hmm >= 30;
  const shown = twoLines ? lines.slice(0, 2) : [lines.join(' ')];
  for (const ln of shown) { fit(ln, namePx, 700, W - 2 * pad); g.fillText(ln, pad, y); y += namePx + 2; }
  // rate
  const ratePx = Math.round(3.8 * DOT * k);
  const rate = '₹' + (Math.round(it.retail * 100) / 100) + '/' + ({ pcs: 'pc', dozen: 'doz' }[it.unit] || it.unit || 'pc');
  fit(rate, ratePx, 800, W - 2 * pad); g.fillText(rate, pad, y); y += ratePx + Math.round(0.8 * DOT * k);
  // barcode: widest whole-dot module that fits, at least 2 dots
  const c = code128(it.code);
  const codePx = Math.round(2.2 * DOT * k);
  if (c) {
    const total = c.modules + 20;
    const m = Math.max(1, Math.min(4, Math.floor((W - 2 * Math.round(0.6 * DOT)) / total)));
    const bw = c.modules * m, x0 = Math.round((W - bw) / 2);
    const bh = Math.max(4 * DOT, H - y - codePx - Math.round(1.2 * DOT));
    for (const [x, w] of c.bars) g.fillRect(x0 + x * m, y, w * m, bh);
    y += bh + 2;
  }
  g.font = `600 ${codePx}px Inter, Roboto, Arial, sans-serif`; g.textAlign = 'center';
  g.fillText(it.code, W / 2, y); g.textAlign = 'left';
  // pure black and white: thermal printers turn grey into speckles
  const im = g.getImageData(0, 0, W, H), d = im.data;
  for (let i = 0; i < d.length; i += 4) { const v = d[i] * .3 + d[i + 1] * .59 + d[i + 2] * .11 < 150 ? 0 : 255; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  g.putImageData(im, 0, 0);
  return { cv, wmm, hmm, fits: !!c && c.modules + 20 <= W / 2 };
}
async function shareLabels(it, size, copies) {
  const { cv, wmm, hmm } = labelCanvas(it, size);
  const N = window.NrrlNative;
  const safe = String(it.code).replace(/[^\w-]+/g, '_');
  if (canPdf()) {
    try {
      toast('Making the labels…');
      if (!window.NrrlPdf) await loadScript(['pdf.js']);
      const { jsPDF } = window.NrrlPdf;
      const doc = new jsPDF({ unit: 'mm', format: [wmm, hmm], orientation: wmm > hmm ? 'landscape' : 'portrait' });
      const png = cv.toDataURL('image/png');
      for (let i = 0; i < copies; i++) { if (i) doc.addPage([wmm, hmm], wmm > hmm ? 'landscape' : 'portrait'); doc.addImage(png, 'PNG', 0, 0, wmm, hmm); }
      const w = await N.Filesystem.writeFile({ path: `Label-${safe}.pdf`, data: doc.output('datauristring').split(',')[1], directory: N.Directory.Cache });
      await N.Share.share({ title: 'Label ' + it.code, text: `${it.name} · ${it.code}`, files: [w.uri], dialogTitle: 'Print or send the label' });
    } catch (e) { if (!/cancel/i.test(String(e && e.message))) toast('Could not make the label: ' + (e.message || e), true); }
    return;
  }
  // in the browser: save the label picture
  const a = document.createElement('a'); a.href = cv.toDataURL('image/png'); a.download = `Label-${safe}.png`; document.body.appendChild(a); a.click(); a.remove();
}
function openLabelSheet(it, opts = {}) {
  let size = LS.get('lblSize', '50x25'); if (!LABEL_SIZES[size]) size = '50x25';
  let copies = 1;
  const d = openSheet('labelSheet', `
    <h3>${opts.fresh ? 'Item saved' : 'Barcode label'}</h3>
    <p class="s">${esc(it.name)} · ${money(it.retail)}</p>
    <div class="lblprev" id="lPrev"></div>
    <div class="field" style="margin-top:12px"><span class="lbl">Label size</span>
      <div class="seg" role="group" aria-label="Label size" id="lSize">${Object.keys(LABEL_SIZES).map(k => `<button type="button" data-size="${k}" aria-pressed="${k === size}">${k.replace('x', ' × ')} mm</button>`).join('')}</div></div>
    <div class="field" style="margin-top:12px"><span class="lbl">How many labels</span>
      <div class="ctr" style="margin:0"><button class="qb" type="button" id="lLess" aria-label="One less">−</button><input type="number" inputmode="numeric" id="lCopies" value="1" min="1" max="500" aria-label="Copies"><button class="qb" type="button" id="lMore" aria-label="One more">+</button></div></div>
    <p class="hint" style="margin-top:10px">${canPdf() ? 'Share opens the label as a PDF: print it from your label printer’s app, or send it on WhatsApp.' : 'Saves the label as a picture.'} The laptop can print it too: Labels → search ${esc(it.code)}.</p>
    <div class="acts2">
      ${opts.fresh ? '<button class="btn" type="button" id="lAnother">Add another item</button>' : '<button class="btn" type="button" id="lClose">Close</button>'}
      <button class="btn primary" type="button" id="lShare">${canPdf() ? 'Share label' : 'Save label'}</button>
      ${opts.fresh ? '<button class="btn w" type="button" id="lClose">Done</button>' : ''}
    </div>`, opts.onClose);
  const draw = () => { const { cv } = labelCanvas(it, size); cv.className = 'lblcv'; const p = $('#lPrev', d); p.innerHTML = ''; p.appendChild(cv); };
  draw();
  $('#lSize', d).addEventListener('click', e => { const b = e.target.closest('[data-size]'); if (!b) return; size = b.dataset.size; LS.set('lblSize', size); $$('#lSize button', d).forEach(x => x.setAttribute('aria-pressed', x === b)); draw(); });
  const setC = n => { copies = Math.max(1, Math.min(500, Math.round(+n) || 1)); $('#lCopies', d).value = copies; };
  $('#lLess', d).addEventListener('click', () => setC(copies - 1));
  $('#lMore', d).addEventListener('click', () => setC(copies + 1));
  $('#lCopies', d).addEventListener('change', e => setC(e.target.value));
  $('#lShare', d).addEventListener('click', () => shareLabels(it, size, copies));
  $$('#lClose', d).forEach(b => b.addEventListener('click', closeSheet));
  $('#lAnother', d)?.addEventListener('click', () => { closeSheet(); openItemSheet(null); });
}
// next free code made on a phone. Phones use NR50001 upwards and laptops NR10001 upwards, so a laptop
// working offline never hands out the same code as a phone.
function nextPhoneCode(after) {
  let n = 50000;
  for (const c of S.items.keys()) { const m = /^NR(5\d{4,})$/.exec(c); if (m && +m[1] > n) n = +m[1]; }
  if (after) { const m = /^NR(\d+)$/.exec(after); if (m && +m[1] > n) n = +m[1]; }
  return 'NR' + (n + 1);
}

/* ---------------- sheets ---------------- */
function openSheet(id, html, onClose) {
  closeSheet();
  const d = document.createElement('div'); d.className = 'sheet'; d.id = id; d.innerHTML = `<div class="card">${html}</div>`;
  d.addEventListener('click', e => { if (e.target === d) closeSheet(); });
  d._onClose = onClose;
  document.body.appendChild(d);
  return d;
}
// a second tap on a sheet's main button within a moment is ignored (no double bills, double staff, double cancels)
document.addEventListener('click', e => {
  const b = e.target.closest('.sheet button.primary, .sheet button.danger, .sheet button[type=submit], .confirm button.danger');
  if (!b || b.hasAttribute('data-twotap')) return; // "tap again to confirm" buttons need the second tap
  const t = +b.dataset.lastTap || 0;
  if (Date.now() - t < 1500) { e.stopImmediatePropagation(); e.preventDefault(); return; }
  b.dataset.lastTap = String(Date.now());
}, true);
function closeSheet() { const s = $('.sheet'); if (!s) return; const f = s._onClose; s.remove(); f && f(); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

function showDone(b, offline) {
  const d = openSheet('doneSheet', `
    <div class="lbl">${offline ? 'Saved on this phone' : 'Bill saved' + (b.id ? ' · No. ' + b.id : '')}</div>
    <div class="done-total">${money(b.total)}</div>
    <p class="s">${b.lines.length} items · ${b.payment === 'upi' ? 'UPI' : b.payment === 'udhaar' ? 'Udhaar' : 'Cash'}${b.customer ? ' · ' + esc(b.customer) : ''}${offline ? '<br>No internet right now. It uploads by itself when the connection is back.' : ''}</p>
    <div class="acts2">
      ${canPdf() ? '<button class="btn" type="button" id="pdfBtn">WhatsApp PDF</button>' : ''}
      <a class="btn" href="${esc(waLink(b))}" target="_blank" rel="noopener">${canPdf() ? 'WhatsApp text' : 'WhatsApp bill'}</a>
      <button class="btn primary${canPdf() ? ' w' : ''}" type="button" id="nextBtn">Next customer</button>
    </div>
    <p class="hint" style="margin-top:10px">Scanning the next item also starts a new bill.</p>`);
  $('#nextBtn', d).addEventListener('click', closeSheet);
  $('#pdfBtn', d)?.addEventListener('click', () => sharePdf(b));
  $('#nextBtn', d).focus();
}

function openItemSheet(it, opts = {}) {
  const editing = !!(it && it.name != null);
  const canEdit = editing ? can('edit') : can('add');
  if (!editing && !canEdit) { toast('Adding items is switched off for you.', true); return; }
  const seeStock = can('stock');
  const d = openSheet('itemSheet', `
    <form id="itemForm" novalidate>
      <h3>${editing ? (canEdit ? 'Edit item' : esc(it.name)) : opts.fromBill ? 'New barcode' : 'Add item'}</h3>
      <p class="s">${opts.fromBill ? `Code <b class="num">${esc(it.code)}</b> isn’t in the item list. Add it once; after that it scans straight into bills.` : editing && !canEdit ? 'Changing items is switched off for you.' : 'Prices include GST.'}</p>
      <div class="grid2">
        <div class="field w"><label class="lbl" for="fCode">Barcode / code</label><div style="display:flex;gap:8px"><input type="text" id="fCode" value="${esc(it?.code ?? '')}" autocomplete="off" placeholder="${editing ? '' : 'Leave blank for a new code'}" ${canEdit ? '' : 'disabled'}>${canEdit ? '<button type="button" class="btn sm" id="fScan">Scan</button>' + (opts.fromBill ? '' : '<button type="button" class="btn sm" id="fGen">New code</button>') : ''}</div>
          <div class="bcprev" id="fBc"></div></div>
        <div class="field w"><label class="lbl" for="fName">Item name</label><input type="text" id="fName" value="${esc(it?.name ?? '')}" placeholder="e.g. Metallic balloons, pack of 50" ${canEdit ? '' : 'disabled'}></div>
        <div class="field"><label class="lbl" for="fRetail">Retail ₹</label><input type="number" inputmode="decimal" id="fRetail" value="${it?.retail ?? ''}" ${canEdit ? '' : 'disabled'}></div>
        <div class="field"><label class="lbl" for="fWhole">Wholesale ₹</label><input type="number" inputmode="decimal" id="fWhole" value="${it?.wholesale || ''}" ${canEdit ? '' : 'disabled'}></div>
        <div class="field"${seeStock ? '' : ' hidden'}><label class="lbl" for="fStock">Stock</label><input type="number" inputmode="decimal" id="fStock" value="${it?.stock ?? ''}" placeholder="Leave blank to not track" ${canEdit ? '' : 'disabled'}></div>
        <div class="field"><label class="lbl" for="fUnit">Unit</label><select id="fUnit" ${canEdit ? '' : 'disabled'}>${['pcs', 'pkt', 'box', 'dozen', 'set', 'roll', 'kg', 'mtr'].map(u => `<option${(it?.unit || 'pcs') === u ? ' selected' : ''}>${u}</option>`).join('')}</select></div>
        <div class="field"><label class="lbl" for="fGst">GST %</label><select id="fGst" ${canEdit ? '' : 'disabled'}>${[0, 5, 12, 18, 28].map(g => `<option value="${g}"${(it?.gst ?? 18) == g ? ' selected' : ''}>${g}%</option>`).join('')}</select></div>
        <div class="field"><label class="lbl" for="fWunit">Wholesale rate is per</label><select id="fWunit" ${canEdit ? '' : 'disabled'}>${[...new Set(['', 'dozen', 'pkt', 'box', 'set', 'roll', it?.wholesale_unit || ''])].map(u => `<option value="${u}"${(it?.wholesale_unit || '') === u ? ' selected' : ''}>${u || 'same unit'}</option>`).join('')}</select></div>
        <div class="field" id="fWqtyF"><label class="lbl" for="fWqty">Pieces in one</label><input type="number" inputmode="numeric" id="fWqty" value="${it?.wholesale_qty > 1 ? it.wholesale_qty : ''}" placeholder="e.g. 12" ${canEdit ? '' : 'disabled'}></div>
        <div class="field"><label class="lbl" for="fHsn">HSN</label><input type="text" inputmode="numeric" id="fHsn" value="${esc(it?.hsn ?? '')}" ${canEdit ? '' : 'disabled'}></div>
      </div>
      <p class="err" id="fErr" style="text-align:left"></p>
      <div class="acts2">
        <button class="btn" type="button" id="fCancel">${canEdit ? 'Cancel' : 'Close'}</button>
        ${canEdit ? `<button class="btn primary" type="submit" id="fSave">${opts.fromBill ? 'Save & add to bill' : 'Save item'}</button>` : ''}
        ${editing && can('labels') ? '<button class="btn w" type="button" id="fLabel">Barcode label</button>' : ''}
        ${editing && can('edit') ? '<button class="btn danger w" type="button" id="fDel">Remove item</button>' : ''}
      </div>
      <div class="confirm" id="fConfirm" hidden><span>Remove this item from the list? Old bills keep their copy.</span><button class="btn sm" type="button" id="fNo">Keep</button><button class="btn sm danger" type="button" id="fYes">Remove</button></div>
    </form>`, () => { if (S.view === 'bill') startCam(); });
  if (S.view === 'bill' && opts.fromBill) { /* keep camera; scans are ignored while this is open */ }
  $('#fCancel', d).addEventListener('click', closeSheet);
  let genCode = null; // the code this sheet made up, if any
  const bc = () => { const v = $('#fCode', d).value.trim(); $('#fBc', d).innerHTML = v ? (barcodeSvg(v) ? barcodeSvg(v) + `<span class="num">${esc(v)}</span>` : '<span class="s">This code has letters a barcode can’t hold. Use New code.</span>') : ''; };
  const wq = () => { $('#fWqtyF', d).hidden = !$('#fWunit', d).value; };
  bc(); wq();
  $('#fCode', d).addEventListener('input', bc);
  $('#fWunit', d).addEventListener('change', () => { wq(); if ($('#fWunit', d).value === 'dozen' && !$('#fWqty', d).value) $('#fWqty', d).value = 12; });
  $('#fScan', d)?.addEventListener('click', async () => { await scanInto($('#fCode', d)); });
  $('#fGen', d)?.addEventListener('click', () => { genCode = nextPhoneCode(); $('#fCode', d).value = genCode; bc(); $('#fName', d).focus(); });
  $('#fLabel', d)?.addEventListener('click', () => { closeSheet(); openLabelSheet(S.items.get(it.code) || it); });
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
      stock: $('#fStock', d).value.trim() === '' ? '' : r2($('#fStock', d).value), unit: $('#fUnit', d).value, gst: +$('#fGst', d).value, hsn: $('#fHsn', d).value.trim(),
      wholesale_unit: $('#fWunit', d).value, wholesale_qty: $('#fWunit', d).value ? (+$('#fWqty', d).value > 0 ? +$('#fWqty', d).value : 1) : 1 };
    const err = m => { $('#fErr', d).textContent = m; };
    if (!item.code && !editing) { genCode = item.code = nextPhoneCode(); $('#fCode', d).value = item.code; bc(); }
    if (!item.code) return err('Add a barcode or short code, for example BLN-50.');
    if (!item.name) return err('Add the item name.');
    if (!(item.retail > 0)) return err('Add a retail price above ₹0.');
    const clash = findItem(item.code);
    if (clash && (!editing || clash.code !== it.code)) return err(`Code ${item.code} is already “${clash.name}”.`);
    $('#fSave', d).disabled = true;
    try {
      for (let tries = 0; ; tries++) {
        try { await api('counter_item_save', { p_token: S.token, p_item: item, p_old_code: editing ? it.code : null }); break; }
        catch (ex) {
          // a code made up here was just taken on another phone: take the next one
          if (ex.code === 'CODE_TAKEN' && genCode && item.code === genCode && tries < 8) { genCode = item.code = nextPhoneCode(item.code); $('#fCode', d).value = item.code; bc(); continue; }
          throw ex;
        }
      }
      if (editing && it.code !== item.code) S.items.delete(it.code);
      const n = normItem({ ...item, stock: item.stock === '' ? null : item.stock });
      S.items.set(n.code, n); LS.set('items', [...S.items.values()]);
      const showLabel = !editing && !opts.fromBill && can('labels');
      closeSheet();
      if (opts.fromBill) addItem(n);
      else if (showLabel) openLabelSheet(n, { fresh: true });
      else toast('Saved ' + n.name);
      if (S.view === 'items') renderItems();
    } catch (ex) { err(ex.message); $('#fSave', d).disabled = false; }
  });
}

/* full-screen scan used to fill a code field */
async function scanInto(input) {
  const wasBill = S.view === 'bill';
  if (await Native.available()) {
    await Native.stop();
    const sh = $('.sheet'); if (sh) sh.style.visibility = 'hidden';
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:70;display:flex;flex-direction:column;justify-content:space-between;background:transparent';
    ov.innerHTML = `<div class="flash" style="margin:calc(16px + env(safe-area-inset-top,0px)) 16px 0;background:rgba(0,0,0,.65);color:#fff;border-radius:10px;padding:8px 12px;font-weight:600">Scan the item’s barcode</div>
      <div style="align-self:center;width:72vw;height:28vh;border:2px solid rgba(255,255,255,.9);border-radius:14px;box-shadow:0 0 0 999px rgba(0,0,0,.3)"></div>
      <div style="padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px))"><button class="btn" type="button" style="width:100%">Cancel</button></div>`;
    document.body.appendChild(ov);
    const hideMain = $('#app'); hideMain.style.visibility = 'hidden';
    const done = async () => { await Native.stop(); ov.remove(); hideMain.style.visibility = ''; if (sh) sh.style.visibility = ''; if (wasBill && !anySheetOpen()) startCam(); };
    ov.querySelector('button').addEventListener('click', done);
    try { await Native.start(code => { input.value = code; input.dispatchEvent(new Event('input')); beep(true); done(); }, null); }
    catch (e) { toast('Camera could not start.', true); done(); }
    return;
  }
  Scanner.stop();
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:70;background:#000;display:flex;flex-direction:column';
  ov.innerHTML = `<div class="cam" style="height:auto;flex:1"><video playsinline muted></video><div class="aim"></div><div class="flash">Scan the item’s barcode</div></div>
    <div style="padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px));background:#000"><button class="btn" type="button" style="width:100%">Cancel</button></div>`;
  document.body.appendChild(ov);
  const done = () => { Scanner.stop(); ov.remove(); if (wasBill && !anySheetOpen()) startCam(); };
  ov.querySelector('button').addEventListener('click', done);
  try {
    await Scanner.start(ov.querySelector('video'), code => { input.value = code; input.dispatchEvent(new Event('input')); beep(true); done(); });
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
  const own = can('reports');
  if (!can('sales')) { el.innerHTML = '<div class="page"><div class="empty"><b>Sales are switched off for you</b></div></div>'; return; }
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
    ${isOwner() && Object.keys(staff).length > 1 ? `<p class="hint" style="margin:-4px 0 12px">By person: ${Object.entries(staff).map(([n, v]) => `${esc(n)} ${money(v)}`).join(' · ')}</p>` : ''}
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
    <div class="acts">${b.voided ? '' : `${canPdf() ? `<button class="btn sm primary" type="button" data-pdf="${b.id}">WhatsApp PDF</button>` : ''}<a class="btn sm${canPdf() ? '' : ' primary'}" href="${esc(waLink(b))}" target="_blank" rel="noopener">WhatsApp${canPdf() ? ' text' : ''}</a>`}
    ${can('cancel') && !b.voided ? `<button class="btn sm danger" type="button" data-void="${b.id}">Cancel bill</button>` : ''}</div>
    <div class="confirm" data-vc="${b.id}" hidden><span>Cancel bill #${b.id}? Items go back into stock.</span><button class="btn sm" type="button" data-keep>Keep</button><button class="btn sm danger" type="button" data-voidyes="${b.id}">Cancel bill</button></div>
  </div>` : ''}</li>`;
}
async function onBillClick(e) {
  const pb = e.target.closest('[data-pdf]'); if (pb) { const bb = bills.find(x => x.id === +pb.dataset.pdf); if (bb) sharePdf(bb); return; }
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
  const own = can('edit');
  el.innerHTML = `<div class="page">
    <div class="ph"><h2>Items</h2><div style="display:flex;gap:8px;flex-wrap:wrap">
      ${own ? '<button class="btn sm" id="impBtn">Import CSV</button><button class="btn sm" id="expBtn">Download CSV</button>' : ''}
      ${can('add') || can('edit') ? '<button class="btn sm accent" id="addBtn">+ Add item</button>' : ''}</div></div>
    <div class="bar"><input type="search" id="itemQ" placeholder="Search name or code" value="${esc(prevQ)}">
      <div class="seg" id="itemSeg"${can('stock') ? '' : ' hidden'}><button type="button" data-f="all" aria-pressed="${itemFilter === 'all'}">All</button><button type="button" data-f="low" aria-pressed="${itemFilter === 'low'}">Low stock</button></div></div>
    <ul class="list" id="itemList"></ul><p class="hint" id="itemCount" style="margin-top:8px"></p></div>`;
  $('#addBtn')?.addEventListener('click', () => openItemSheet(null));
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
  const q = ($('#itemQ')?.value || '').trim();
  let list = [...S.items.values()];
  if (itemFilter === 'low') list = list.filter(i => i.stock != null && i.stock <= 5);
  if (q) list = rankItems(list, q, 300); else list.sort((a, b) => a.name.localeCompare(b.name));
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
    <p class="hint" style="margin:-4px 0 12px">Tap a person to choose what they can do on the phone and the laptop, or to block them. Changes reach their phone within 30 seconds.</p>
    <ul class="list">${list.map(s => { const p = s.perms || PERM_DEF, on = PERMS.filter(([k]) => p[k]).length; return `<li><button class="row" type="button" data-sid="${s.id}"><span class="nm">${esc(s.name)}</span>
      <span class="rt">${s.active ? '' : '<span class="chip out">Blocked</span>'}</span><span class="meta"><span class="chip${s.role === 'owner' ? ' acc' : ''}">${s.role === 'owner' ? 'Owner · full access' : `Staff · ${on} of ${PERMS.length} allowed`}</span>${s.role !== 'owner' && s.active ? `<span>${PERMS.filter(([k]) => !p[k]).map(([, l]) => l).slice(0, 2).map(esc).join(', ')}${PERMS.filter(([k]) => !p[k]).length > 2 ? '…' : ''} off</span>` : ''}</span></button></li>`; }).join('')}</ul></div>`;
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
      ${s && !self ? `<label class="w perm-row perm-main"><span><b>Allowed to log in</b><small>Switch off to block this person on every phone and laptop at once</small></span><input type="checkbox" class="sw" id="sActive" ${s.active ? 'checked' : ''}></label>` : ''}
    </div>
    <div id="permBox" class="perms"${s?.role === 'owner' ? ' hidden' : ''}>
      <div class="lbl" style="margin:12px 0 4px">What they can do</div>
      ${PERMS.map(([k, l]) => `<label class="perm-row"><span>${esc(l)}</span><input type="checkbox" class="sw" data-perm="${k}" ${((s?.perms && k in s.perms) ? s.perms[k] : PERM_DEF[k]) ? 'checked' : ''}></label>`).join('')}
    </div>
    <p class="err" id="sErr" style="text-align:left"></p>
    <div class="acts2"><button class="btn" type="button" id="sCancel">Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`);
  $('#sCancel', d).addEventListener('click', closeSheet);
  $('#sRole', d)?.addEventListener('change', e => { $('#permBox', d).hidden = e.target.value === 'owner'; });
  $('#sf', d).addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#sName', d).value.trim(), pinV = $('#sPin', d).value.trim();
    if (!name) return $('#sErr', d).textContent = 'Add a name.';
    if ((!s || pinV) && !/^\d{4,8}$/.test(pinV)) return $('#sErr', d).textContent = 'PIN must be 4 to 8 digits.';
    try {
      const r = await api('counter_staff_save', { p_token: S.token, p_id: s?.id || null, p_name: name, p_pin: pinV || null, p_role: self ? 'owner' : $('#sRole', d).value, p_active: s && !self ? $('#sActive', d).checked : true });
      const perms = {}; $$('[data-perm]', d).forEach(x => { perms[x.dataset.perm] = x.checked; });
      if (!self) await api('counter_staff_perms', { p_token: S.token, p_id: r.id || s.id, p_perms: perms });
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

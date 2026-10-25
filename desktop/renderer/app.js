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

/* ================= theme ================= */
function applyTheme(t) {
  t = ['light', 'dark', 'auto'].includes(t) ? t : 'light';
  document.documentElement.dataset.theme = t;
  LS.set('theme', t);
  $$('#themeSeg [data-t]').forEach(b => b.setAttribute('aria-pressed', b.dataset.t === t));
}
applyTheme(LS.get('theme', 'light'));
$('#themeSeg').addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b) { applyTheme(b.dataset.t); focusScan(); } });

/* ================= state ================= */
const S = {
  items: new Map(), settings: {}, view: 'bill',
  cart: LS.get('cart', null) || newCart(),
  sel: 0, unlockedUntil: 0, lastBill: null, printers: null,
};
function cartId() { return 'pc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function newCart(prev) { return { id: cartId(), lines: [], mode: prev?.mode || 'retail', payment: 'cash', discount: 0, customer: '', phone: '', received: '' }; }
const saveCart = () => { LS.set('cart', S.cart); scheduleLive(); };
if (!S.cart.id) S.cart.id = cartId();
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
/* Search: every typed word must match the start of a word in the name, appear in the name or code,
   or be one letter off (typo). Exact and starting matches first, then items sold most often. */
const normQ = t => String(t || '').toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, ' ').trim();
function near(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, d = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++d > 1) return false;
    if (a[i] === b[j + 1] && a[i + 1] === b[j]) { i += 2; j += 2; continue; }
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return d + (a.length - i) + (b.length - j) <= 1;
}
function rankItems(list, q, limit = 12) {
  const nq = normQ(q); if (nq.length < 2 && !/^\d$/.test(nq)) return [];
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
      if (sc < 0) continue;
      if (name.startsWith(nq)) sc += 40;
    }
    out.push([sc + Math.min(25, freq[it.code] || 0), it]);
  }
  return out.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name)).slice(0, limit).map(x => x[1]);
}
const searchItems = (q, limit = 12) => rankItems(S.items.values(), q, limit);
function hl(text, q) {
  let h = esc(text);
  for (const w of normQ(q).split(' ').filter(w => w.length > 1)) h = h.replace(new RegExp('(^|[^a-z0-9])(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'i'), '$1<mark>$2</mark>');
  return h;
}
function bumpFreq(code) { const f = LS.get('freq', {}); f[code] = (f[code] || 0) + 1; LS.set('freq', f); }
function topItems(n) { const f = LS.get('freq', {}); return Object.keys(f).filter(c => S.items.has(c)).sort((a, b) => f[b] - f[a]).slice(0, n).map(c => S.items.get(c)); }
const lowLevel = it => it.min_stock != null ? +it.min_stock : (+S.settings.low_stock || 5);

/* ================= who is using the laptop, and what they may do =================
   Linked to the phone app: everyone signs in with their own PIN, and the owner's switches (Staff tab
   in the phone app) decide what each person can do. Not linked: the optional owner PIN locks the
   owner-only actions, as before. The owner's PIN always unlocks everything for 15 minutes. */
const PERM_DEF = { bill: true, rate: false, stock: true, add: true, edit: false, sales: true, reports: false, cancel: false, labels: true, settings: false };
S.auth = { user: null, staff: [], linked: false };
const staffMode = () => !!S.auth.user;
const ownerOn = () => Date.now() < S.unlockedUntil;
const locked = () => staffMode() ? !(S.auth.user.role === 'owner' || ownerOn()) : (S.settings.hasPin && !ownerOn());
function can(k) {
  if (!locked()) return true;
  const p = staffMode() ? (S.auth.user.perms || {}) : {};
  return !!(k in p ? p[k] : PERM_DEF[k]);
}
const requirePerm = (k, title) => can(k) ? Promise.resolve(true) : ownerPrompt(title);
const requireOwner = title => locked() ? ownerPrompt(title) : Promise.resolve(true);
function renderLock() {
  const b = $('#lockBtn'), u = $('#userBox');
  if (u) {
    u.hidden = !staffMode();
    if (staffMode()) u.innerHTML = `<span class="who"><b>${esc(S.auth.user.name)}</b><small>${S.auth.user.role === 'owner' ? 'Owner' : 'Staff'}</small></span><button type="button" class="btn sm" id="switchUser">Switch</button>`;
    $('#switchUser')?.addEventListener('click', () => signOut());
  }
  const lvBtn = $('#nav [data-view="live"]'); if (lvBtn) lvBtn.hidden = !(liveOn() && S.auth.user.role === 'owner');
  const needs = staffMode() ? S.auth.user.role !== 'owner' : S.settings.hasPin;
  b.hidden = !needs;
  b.textContent = locked() ? 'Owner: locked' : 'Owner: unlocked · Lock';
}
$('#lockBtn').addEventListener('click', async () => {
  if (locked()) await ownerPrompt('Unlock owner access');
  else { S.unlockedUntil = 0; rpc('auth.lockOwner').catch(() => {}); toast('Owner access locked'); }
  renderLock(); refreshView();
});
setInterval(() => { renderLock(); }, 30000);
// with two owners, the PIN is checked against the one chosen, so a mistake doesn't count against both
const owners = () => (S.auth.staff || []).filter(x => x.role === 'owner');
function ownerPrompt(title = 'Owner PIN needed') {
  return new Promise(resolve => {
    const m = openModal(`<h2>${esc(title)}</h2><p class="muted">${staffMode() ? 'You don’t have access to this. The owner can enter their PIN to allow it.' : 'Enter the owner PIN to continue.'}</p>
      <form class="pinpad" id="pinForm">${owners().length > 1 ? `<select id="pinWho" aria-label="Which owner">${owners().map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select>` : ''}<input type="password" id="pinIn" inputmode="numeric" maxlength="8" autocomplete="off">
      <div class="err" id="pinErr"></div>
      <div class="foot"><button class="btn" type="button" data-close>Cancel</button><button class="btn accent" type="submit">Unlock</button></div></form>`,
      { onClose: () => resolve(false) });
    setTimeout(() => $('#pinIn', m).focus(), 30);
    $('#pinForm', m).addEventListener('submit', async e => {
      e.preventDefault();
      $('#pinErr', m).textContent = 'Checking…';
      let ok = false;
      try { ok = await rpc('auth.owner', $('#pinIn', m).value, $('#pinWho', m)?.value || null); } catch (err) { $('#pinErr', m).textContent = err.message; return; }
      if (!ok) { $('#pinErr', m).textContent = 'Wrong PIN.'; $('#pinIn', m).select(); beep(false); return; }
      S.unlockedUntil = Date.now() + 15 * 60e3;
      m._onClose = null; closeModal(m); renderLock(); resolve(true);
    });
  });
}
/* Sign-in screen: shown when the laptop is linked and has the staff list. */
async function loadAuth() {
  try { S.auth = { ...S.auth, ...(await rpc('auth.state')) }; } catch (e) {}
  if (S.auth.ownerUntil) S.unlockedUntil = S.auth.ownerUntil;
}
const needSignIn = () => S.auth.linked && S.auth.staff.length > 0 && !S.auth.user;
function showSignIn() {
  if ($('#signin')) return;
  const el = document.createElement('div');
  el.id = 'signin'; el.className = 'signin';
  document.body.appendChild(el);
  let pick = null;
  const draw = err => {
    const staff = S.auth.staff;
    el.innerHTML = `<div class="signin-card">
      <div class="brand big"><b>NRRL</b><span>Billing</span></div>
      ${!pick ? `<h2>Who is billing?</h2><div class="names">${staff.map(x => `<button type="button" data-id="${esc(x.id)}">${esc(x.name)}<small>${x.role === 'owner' ? 'Owner' : 'Staff'}</small></button>`).join('')}</div>
        <p class="muted small">Same names and PINs as the NRRL Counter phone app. The owner adds people and chooses what each person can do in the phone app’s Staff tab.</p>`
      : `<h2>${esc(pick.name)}</h2><form id="siForm" class="pinpad"><input type="password" id="siPin" inputmode="numeric" maxlength="8" autocomplete="off" placeholder="PIN" aria-label="PIN">
        <div class="err" id="siErr">${esc(err || '')}</div>
        <div class="foot"><button type="button" class="btn" id="siBack">Back</button><button type="submit" class="btn accent">Sign in</button></div></form>`}
    </div>`;
    if (!pick) {
      $$('[data-id]', el).forEach(b => b.addEventListener('click', () => { pick = staff.find(x => x.id === b.dataset.id); LS.set('lastUser', pick.id); draw(); }));
    } else {
      setTimeout(() => $('#siPin', el)?.focus(), 30);
      $('#siBack', el).addEventListener('click', () => { pick = null; draw(); });
      $('#siForm', el).addEventListener('submit', async e => {
        e.preventDefault();
        $('#siErr', el).textContent = 'Checking…';
        try {
          S.auth.user = await rpc('auth.login', pick.id, $('#siPin', el).value);
          S.unlockedUntil = 0;
          el.remove(); renderLock(); toast('Signed in as ' + S.auth.user.name); LIVE.sent = {}; LS.set('liveSent', {}); liveRefresh();
          buildBill(); show(can('bill') ? 'bill' : 'items');
        } catch (err) { $('#siErr', el).textContent = err.message; $('#siPin', el).value = ''; beep(false); }
      });
    }
  };
  const last = S.auth.staff.find(x => x.id === LS.get('lastUser', null));
  if (last) pick = last;
  draw();
}
async function signOut(msg) {
  // bills on this laptop stay here for whoever signs in next: take them off this person's live list first,
  // and give them new numbers so they can't clash with what the server still has under this person
  for (const id of Object.keys(LIVE.sent)) await rpc('carts.close', id).catch(() => {});
  LIVE.sent = {}; LIVE.rows = []; LS.set('liveSent', {});
  if (S.cart.id) { S.cart.id = cartId(); LS.set('cart', S.cart); }
  for (const h of S.held) h.cart.id = cartId(); saveHeld();
  await rpc('auth.logout').catch(() => {});
  S.auth.user = null; S.unlockedUntil = 0;
  closeModal(); renderLock();
  if (msg) toast(msg, { err: true, ms: 6000 });
  await loadAuth();
  if (needSignIn()) showSignIn();
}

/* ================= live bills =================
   With the laptop linked and someone signed in, every open bill (and every bill on hold) is kept on the server while
   it is being made: it can be sent to another person on a phone or laptop, and the owner sees all of them. */
const LIVE = { sent: LS.get('liveSent', {}), rows: [], busy: false, t: 0, open: null };
const liveOn = () => !!(S.auth && S.auth.user && S.auth.linked);
const liveHash = c => JSON.stringify([c.lines, c.discount, c.customer, c.phone, c.mode, c.payment]);
function scheduleLive() { clearTimeout(LIVE.t); LIVE.t = setTimeout(() => liveSync().catch(() => {}), 1200); }
// phone bills keep "price", laptop bills "rate": send both so either side can open the other's bill
const liveCart = c => ({ ...c, lines: c.lines.map(l => ({ ...l, price: l.rate ?? l.price, rate: l.rate ?? l.price })) });
async function liveSync() {
  if (!liveOn() || LIVE.busy) return;
  LIVE.busy = true;
  try {
    const want = {};
    if (S.cart.lines.length) want[S.cart.id] = { cart: S.cart, state: 'open' };
    for (const h of S.held || []) if (h.cart.lines.length) { if (!h.cart.id) h.cart.id = cartId(); want[h.cart.id] = { cart: h.cart, state: 'held' }; }
    for (const [id, w] of Object.entries(want)) {
      const hash = w.state + liveHash(w.cart);
      if (LIVE.sent[id] === hash) continue;
      const r = await rpc('carts.put', id, liveCart(w.cart), w.state);
      if (r && r.moved) { lostCart(id, r.to); continue; }
      LIVE.sent[id] = hash;
    }
    for (const id of Object.keys(LIVE.sent)) { if (want[id]) continue; await rpc('carts.close', id); delete LIVE.sent[id]; }
  } catch (e) { /* offline: tried again on the next change or refresh */ }
  finally { LS.set('liveSent', LIVE.sent); LIVE.busy = false; }
}
function lostCart(id, to) {
  delete LIVE.sent[id];
  if (S.cart.id === id) { S.cart = newCart(S.cart); LS.set('cart', S.cart); renderCart(); toast(`This bill is now with ${to}.`, { err: true, ms: 6000 }); }
  const n = S.held.length; S.held = S.held.filter(h => h.cart.id !== id);
  if (S.held.length !== n) { saveHeld(); renderHeld(); toast(`A held bill is now with ${to}.`, { err: true }); }
}
async function liveRefresh() {
  if (!liveOn()) { LIVE.rows = []; renderIncoming(); return; }
  if (LIVE.refreshing) return;
  LIVE.refreshing = true;
  try { await liveRefreshNow(); } finally { LIVE.refreshing = false; }
}
async function liveRefreshNow() {
  await liveSync().catch(() => {});
  const before = Object.keys(LIVE.sent);
  try { LIVE.rows = await rpc('carts.list') || []; } catch (e) { return; }
  // a bill of mine that is gone from my list was passed on or taken over: sending it again tells us who has it now
  let check = false;
  for (const id of before) { const r = LIVE.rows.find(x => x.id === id); if (r && !r.mine) lostCart(id, r.staff_name); else if (!r && LIVE.sent[id]) { LIVE.sent[id] = 'check'; check = true; } }
  if (check) await liveSync().catch(() => {});
  renderIncoming();
  if (S.view === 'live') renderLive();
}
setInterval(liveRefresh, 8000);
function renderIncoming() {
  const el = $('#incoming'); if (!el) return;
  const inc = LIVE.rows.filter(r => r.mine && r.state === 'sent');
  el.hidden = !inc.length;
  el.innerHTML = inc.map(r => `<div class="inc"><span>📥 <b>${esc(r.from_name || 'Someone')}</b> sent you a bill · ${r.items} item${r.items === 1 ? '' : 's'} · <b class="num">${money(r.total)}</b></span><button type="button" class="btn accent sm" data-take="${esc(r.id)}">Open bill</button></div>`).join('');
}
async function takeCart(id) {
  try {
    await liveSync();
    const r = await rpc('carts.take', id);
    if (S.cart.lines.length) holdBill(true);
    const c = r.cart || {};
    S.cart = { ...newCart(c), ...c, id: r.id, lines: (Array.isArray(c.lines) ? c.lines : []).map(l => ({ ...l, rate: l.rate ?? l.price, qty: +l.qty || 1 })) };
    LIVE.sent[r.id] = 'open' + liveHash(S.cart); LS.set('liveSent', LIVE.sent); LS.set('cart', S.cart);
    LIVE.rows = LIVE.rows.map(x => x.id === r.id ? { ...x, mine: true, state: 'open' } : x);
    if (S.view !== 'bill') await show('bill');
    S.sel = 0; renderCart(); renderIncoming(); focusScan();
    toast(r.from ? `Bill from ${r.from} — carry on billing` : 'Bill opened');
  } catch (err) { toast(err.message, { err: true }); liveRefresh(); }
}
function chooseStaff(title) {
  const me = S.auth.user && S.auth.user.id, staff = (S.auth.staff || []).filter(x => x.id !== me);
  if (!staff.length) { toast('There is nobody else to send it to.', { err: true }); return Promise.resolve(null); }
  return new Promise(resolve => {
    const m = openModal(`<h2>${esc(title)}</h2><div class="names pick">${staff.map(x => `<button type="button" data-id="${esc(x.id)}">${esc(x.name)}<small>${x.role === 'owner' ? 'Owner' : 'Staff'}</small></button>`).join('')}</div>
      <p class="muted small">It appears on their phone or laptop straight away, with an “Open bill” button.</p>
      <div class="foot"><button type="button" class="btn" data-close>Cancel</button></div>`, { onClose: () => resolve(null) });
    m.querySelector('.pick').addEventListener('click', e => { const b = e.target.closest('[data-id]'); if (!b) return; m._onClose = null; closeModal(m); resolve(staff.find(x => x.id === b.dataset.id)); });
  });
}
async function transferCart(id, cart) {
  if (!liveOn()) { toast('Sign in on a linked laptop to send bills to others.', { err: true }); return; }
  const to = await chooseStaff('Send this bill to');
  if (!to) return;
  try {
    if (cart) { const r = await rpc('carts.put', id, liveCart(cart), 'open'); if (r && r.moved) { lostCart(id, r.to); return; } }
    const r = await rpc('carts.transfer', id, to.id);
    delete LIVE.sent[id]; LS.set('liveSent', LIVE.sent);
    if (S.cart.id === id) { S.cart = newCart(S.cart); LS.set('cart', S.cart); renderCart(); }
    toast(`Bill sent to ${r.to}.`);
    liveRefresh();
  } catch (err) { toast(err.message, { err: true }); }
}
function renderLive() {
  const el = $('#v-live'); if (!el) return;
  const ago = t => { const m = Math.round((Date.now() - new Date(t)) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };
  const ST = { open: ['chip ok', 'Billing now'], held: ['chip low', 'On hold'], sent: ['chip acc', 'Waiting to be opened'] };
  const rows = LIVE.rows;
  el.innerHTML = `<div class="page"><div class="ph"><h1>Live bills</h1><div class="toolbar"><button type="button" class="btn" id="lvRef">Refresh</button></div></div>
    <p class="muted small" style="margin:0">Bills being made right now on every phone and laptop, updated every few seconds. Click one to see its items, take it over, or send it to someone else.</p>
    <div class="tablewrap"><table class="grid" id="lvTable">${!rows.length ? '<tbody><tr><td><div class="empty"><b>No bills in progress</b>When anyone starts a bill on a phone or laptop, it shows here.</div></td></tr></tbody>' : `
      <thead><tr><th>Person</th><th>Where</th><th>Status</th><th>Customer</th><th class="r">Items</th><th class="r">Total</th><th>Last change</th><th></th></tr></thead>
      <tbody>${rows.map(r => `<tr class="click" data-lv="${esc(r.id)}"><td><b>${esc(r.staff_name)}</b>${r.from_name ? ` <span class="muted small">from ${esc(r.from_name)}</span>` : ''}</td><td>${esc(r.device || '')}</td>
        <td><span class="${ST[r.state]?.[0] || 'chip'}">${ST[r.state]?.[1] || esc(r.state)}</span></td><td>${esc(r.cart?.customer || '')}</td><td class="r num">${r.items}</td><td class="r num"><b>${money(r.total)}</b></td><td>${ago(r.updated_at)}</td>
        <td class="r">${r.mine ? '' : `<button type="button" class="btn sm" data-lvtake="${esc(r.id)}">Take over</button>`} <button type="button" class="btn sm" data-lvsend="${esc(r.id)}">Send to…</button></td></tr>
        ${LIVE.open === r.id ? `<tr><td colspan="8"><div class="muted small">${(r.cart?.lines || []).map(l => `${esc(l.name)} — ${qf(l.qty)} ${esc(l.unit || '')} × ${money(l.rate ?? l.price)}`).join('<br>')}</div></td></tr>` : ''}`).join('')}</tbody>`}</table></div></div>`;
  $('#lvRef').addEventListener('click', liveRefresh);
  $('#lvTable').addEventListener('click', e => {
    const t = e.target.closest('[data-lvtake]'), sd = e.target.closest('[data-lvsend]'), o = e.target.closest('tr[data-lv]');
    if (t) return takeCart(t.dataset.lvtake);
    if (sd) return transferCart(sd.dataset.lvsend, null);
    if (o) { LIVE.open = LIVE.open === o.dataset.lv ? null : o.dataset.lv; renderLive(); }
  });
}

/* ================= modals ================= */
// A second click on a dialog's main button within a moment is ignored, so a double-click can't save twice
// (two payments, two purchases, two cancellations).
document.addEventListener('click', e => {
  const b = e.target.closest('.modal .foot button.accent, .modal .foot button.danger, .modal .confirmbar button.danger, .modal .foot button.primary');
  if (!b) return;
  const t = +b.dataset.lastClick || 0;
  if (Date.now() - t < 1500) { e.stopImmediatePropagation(); e.preventDefault(); return; }
  b.dataset.lastClick = String(Date.now());
}, true);
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
  if (v === 'settings' && !(await requirePerm('settings', 'Settings need the owner'))) return;
  if (v === 'sales' && !(await requirePerm('sales', 'Sales are switched off for you'))) return;
  if (v === 'customers' && !(await requirePerm('sales', 'Udhaar accounts are switched off for you'))) return;
  if (v === 'purchases' && !(await requirePerm('edit', 'Purchases need the owner'))) return;
  if (v === 'log' && !(await requirePerm('settings', 'The change log is for the owner'))) return;
  if (v === 'live') liveRefresh();
  S.view = v;
  $$('#nav [data-view]').forEach(b => b.dataset.view === v ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  for (const k of ['bill', 'items', 'sales', 'settings', 'customers', 'purchases', 'log', 'live']) $('#v-' + k).hidden = k !== v;
  refreshView();
}
function refreshView() {
  if (S.view === 'bill') { renderCart(); focusScan(); }
  if (S.view === 'items') renderItems();
  if (S.view === 'sales') renderSales();
  if (S.view === 'settings') renderSettings();
  if (S.view === 'customers') renderCustomers();
  if (S.view === 'purchases') renderPurchases();
  if (S.view === 'log') renderLog();
  if (S.view === 'live') renderLive();
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
  else if (e.altKey && k.toLowerCase() === 'w') { e.preventDefault(); if (S.lastBill) sendWhatsApp(S.lastBill); }
  else if (e.altKey && ['d', 't', 'k'].includes(k.toLowerCase())) { e.preventDefault(); if (!quickQty(S.sel, { d: 'doz', t: 'ten', k: 'pack' }[k.toLowerCase()])) beep(false); focusScan(); }
  else if (e.ctrlKey && k.toLowerCase() === 'h') { e.preventDefault(); holdBill(); }
  else if (e.ctrlKey && /^[1-9]$/.test(k)) { const it = topItems(9)[+k - 1]; if (it) { e.preventDefault(); addItem(it); focusScan(); } }
  else if (e.altKey && /^[1-4]$/.test(k)) { e.preventDefault(); S.cart.payment = PAY[+k - 1][0]; saveCart(); renderTotals(); }
  else if ((document.activeElement === document.body || /^(BUTTON|A)$/.test(document.activeElement?.tagName)) && k.length === 1 && !e.ctrlKey && !e.altKey) { focusScan(); }
});
/* A barcode gun types very fast and ends with Enter. If that lands in another box on the billing screen
   (customer name, discount, a quantity), take it back out of that box and add the item instead. */
let burst = { t: 0, s: '', el: null, val: '' };
document.addEventListener('keydown', e => {
  if (S.view !== 'bill' || modalOpen() || e.ctrlKey || e.altKey || e.metaKey) return;
  const el = e.target;
  if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName) || el.id === 'scan') { burst.s = ''; return; }
  const now = performance.now();
  if (e.key.length === 1) {
    if (now - burst.t > 45 || burst.el !== el) burst = { t: now, s: '', el, val: el.value };
    burst.s += e.key; burst.t = now; return;
  }
  if (e.key === 'Enter' && burst.el === el && burst.s.length >= 4 && now - burst.t < 80) {
    e.preventDefault(); e.stopImmediatePropagation();
    el.value = burst.val;
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    const code = burst.s; burst = { t: 0, s: '', el: null, val: '' };
    handleEntry(code); focusScan();
  }
}, true);

/* ================= billing screen ================= */
function buildBill() {
  if (!can('bill')) { $('#v-bill').innerHTML = `<div class="page"><div class="empty"><b>Billing is switched off for ${esc(S.auth.user ? S.auth.user.name : 'you')}</b>The owner can switch on “Make bills” in the phone app’s Staff tab.</div></div>`; return; }
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
      <div class="hintline"><span><kbd>5*</kbd> before a scan = qty 5</span><span><kbd>+</kbd><kbd>−</kbd> change qty</span><span><kbd>Del</kbd> remove line</span><span><kbd>↑</kbd><kbd>↓</kbd> pick line</span><span><kbd>F4</kbd> type qty</span><span><kbd>F6</kbd> retail/wholesale</span><span><kbd>Alt+D</kbd> dozen <kbd>Alt+T</kbd> ten <kbd>Alt+K</kbd> pack</span><span><kbd>Ctrl+H</kbd> hold bill</span><span><kbd>Ctrl+P</kbd> reprint last</span></div>
      <div class="incoming" id="incoming" hidden></div>
      <div class="heldbar" id="heldBar" hidden></div>
      <div class="quick" id="quick" hidden></div>
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
  $('#incoming').addEventListener('click', e => { const b = e.target.closest('[data-take]'); if (b) takeCart(b.dataset.take); });
  renderIncoming();
  $('#heldBar').addEventListener('click', e => {
    const o = e.target.closest('[data-hold]'), x = e.target.closest('[data-hdel]');
    if (o) resumeHeld(+o.dataset.hold);
    if (x) { const id = +x.dataset.hdel, h = S.held.find(y => y.id === id); if (h && Date.now() - (S.hdelArm || 0) > 2500) { S.hdelArm = Date.now(); toast('Click × again to delete this held bill'); return; } S.held = S.held.filter(y => y.id !== id); saveHeld(); renderHeld(); }
    focusScan();
  });
  renderHeld();
  $('#quick').addEventListener('click', e => { const b = e.target.closest('[data-code]'); if (b) { addItem(S.items.get(b.dataset.code)); focusScan(); } });
  renderQuick();
  $('#lines').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); focusScan(); } });
  $('#v-bill').addEventListener('mouseup', e => {
    if (!e.target.closest('input,select,textarea,button,a') && !window.getSelection().toString()) focusScan();
  });
}
function renderQuick() {
  const el = $('#quick'); if (!el) return;
  const top = topItems(9);
  el.hidden = !top.length;
  el.innerHTML = `<span class="lbl2">Often sold:</span>` + top.map((it, i) => `<button type="button" data-code="${esc(it.code)}" title="${esc(it.name)} — Ctrl+${i + 1}">${esc(it.name)}<kbd>^${i + 1}</kbd></button>`).join('');
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
  box.innerHTML = sugg.map((it, i) => `<button type="button" data-code="${esc(it.code)}" aria-selected="${i === suggIdx}"><span class="nm">${hl(it.name, q)}</span><span class="num muted small">${esc(it.code)}</span><span class="num">${money(priceFor(it))}</span></button>`).join('');
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
  if (it) bumpFreq(it.code);
  if (!it) return;
  const L = S.cart.lines;
  let i = L.findIndex(l => l.code === it.code);
  if (i >= 0) L[i].qty = r2(L[i].qty + qty);
  else { L.push({ code: it.code, name: it.name, unit: unitFor(it), gst: it.gst, rate: priceFor(it), listRate: true, qty: r2(qty) }); i = L.length - 1; }
  S.sel = i; saveCart(); renderCart(i);
  beep(true); flashScan(true);
  if (can('stock') && it.stock != null && it.stock - L[i].qty < 0) toast(`${it.name}: only ${qf(it.stock)} ${it.unit} in stock`, { err: true, ms: 2500 });
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
/* One key for common pack sizes: dozen (Alt+D), ten (Alt+T), and the item's own pack (Alt+K) —
   e.g. a balloon packet of 50 set as its wholesale unit. First press sets it, the next press adds another. */
function quickKeys(l) {
  const it = S.items.get(l.code), out = [];
  const u = String(l.unit || '').toLowerCase();
  if (!/^doz/.test(u)) out.push({ k: 'doz', n: 12, label: 'Dozen', key: 'Alt+D', title: '12 ' + l.unit });
  out.push({ k: 'ten', n: 10, label: '10', key: 'Alt+T', title: '10 ' + l.unit });
  if (it && it.wholesale_unit && it.wholesale_unit !== l.unit && +it.wholesale_qty > 1) out.push({ k: 'pack', n: +it.wholesale_qty, label: `1 ${it.wholesale_unit} (${+it.wholesale_qty})`, key: 'Alt+K', title: `${+it.wholesale_qty} ${l.unit} = 1 ${it.wholesale_unit}` });
  return out;
}
function quickQty(i, kind) {
  const l = S.cart.lines[i]; if (!l) return false;
  const k = quickKeys(l).find(x => x.k === kind); if (!k) return false;
  l.qty = r2(l.qty === 1 ? k.n : l.qty + k.n);
  saveCart(); renderCart(i); beep(true);
  return true;
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
/* Hold a bill: park it while the customer keeps shopping, bill the next person, pick it up again later. */
S.held = LS.get('held', []);
const saveHeld = () => LS.set('held', S.held);
function holdLabel(c) { const t = c.lines.reduce((a, l) => a + l.rate * l.qty, 0); return `${c.customer || 'Customer'} · ${c.lines.length} item${c.lines.length === 1 ? '' : 's'} · ${money(t)}`; }
function holdBill(quiet) {
  if (!S.cart.lines.length) { if (!quiet) toast('Nothing to hold — the bill is empty.'); return false; }
  const d = new Date();
  S.held.push({ id: Date.now(), at: `${p2(d.getHours())}:${p2(d.getMinutes())}`, cart: S.cart });
  saveHeld();
  if (!quiet) toast(`Bill on hold: ${holdLabel(S.cart)}`);
  S.cart = newCart(S.cart); S.sel = 0; saveCart(); renderCart(); renderHeld(); focusScan();
  return true;
}
function resumeHeld(id) {
  const i = S.held.findIndex(h => h.id === id); if (i < 0) return;
  const h = S.held.splice(i, 1)[0];
  if (S.cart.lines.length) { const d = new Date(); S.held.push({ id: Date.now(), at: `${p2(d.getHours())}:${p2(d.getMinutes())}`, cart: S.cart }); toast('Current bill put on hold'); }
  S.cart = h.cart; S.sel = 0;
  // prices may have changed while it waited
  for (const l of S.cart.lines) { const it = S.items.get(l.code); if (it && l.listRate !== false) l.rate = priceFor(it); }
  saveHeld(); saveCart(); renderCart(); renderHeld(); focusScan();
}
function renderHeld() {
  scheduleLive();
  const el = $('#heldBar'); if (!el) return;
  el.hidden = !S.held.length;
  el.innerHTML = `<span class="lbl2">On hold:</span>` + S.held.map(h => `<span class="heldchip"><button type="button" data-hold="${h.id}" title="Open this bill">${esc(holdLabel(h.cart))} <span class="muted small">${esc(h.at)}</span></button><button type="button" class="xbtn" data-hdel="${h.id}" aria-label="Delete held bill" title="Delete this held bill">×</button></span>`).join('');
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
  if (b.dataset.qk) quickQty(+b.dataset.qi, b.dataset.qk);
  else if (b.dataset.inc != null) bumpQty(+b.dataset.inc, 1);
  else if (b.dataset.dec != null) bumpQty(+b.dataset.dec, -1);
  else if (b.dataset.rm != null) removeLine(+b.dataset.rm);
  focusScan();
}
async function onLineChange(e) {
  const L = S.cart.lines, q = e.target.dataset.q, p = e.target.dataset.p;
  if (q != null) { const v = r2(e.target.value); if (v <= 0) L.splice(+q, 1); else L[+q].qty = v; }
  if (p != null) {
    if (!(await requirePerm('rate', 'Changing a rate needs the owner'))) { renderCart(); return; }
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
  const c = S.cart, canRate = can('rate');
  $$('#modeSeg [data-mode]').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === c.mode));
  if (!c.lines.length) {
    $('#lines').innerHTML = `<tbody><tr><td><div class="empty"><b>Ready to bill</b>${S.items.size ? 'Scan the first item, or type its name.' : 'Your item list is empty. Scan a barcode to add the item, or import your list from Items &amp; stock.'}</div></td></tr></tbody>`;
  } else {
    S.sel = Math.max(0, Math.min(S.sel, c.lines.length - 1));
    $('#lines').innerHTML = `<thead><tr><th style="width:42px">#</th><th>Item</th><th class="r" style="width:215px">Qty</th><th class="r" style="width:120px">Rate</th><th class="r" style="width:130px">Amount</th><th style="width:44px"></th></tr></thead>
    <tbody>${c.lines.map((l, i) => `<tr data-i="${i}" class="${i === S.sel ? 'sel' : ''}${i === popIdx ? ' pop' : ''}">
      <td class="muted num">${i + 1}</td>
      <td><div class="nm">${esc(l.name)}</div><div class="code">${esc(l.code)}</div></td>
      <td class="r"><span class="qtyctl"><button type="button" data-dec="${i}" tabindex="-1">−</button><input type="number" step="any" data-q="${i}" value="${l.qty}" aria-label="Quantity"><button type="button" data-inc="${i}" tabindex="-1">+</button></span> <span class="muted small">${esc(l.unit)}</span>
        ${i === S.sel ? `<div class="qkeys">${quickKeys(l).map(k => `<button type="button" data-qk="${k.k}" data-qi="${i}" tabindex="-1" title="${esc(k.title)}">${esc(k.label)}<kbd>${k.key}</kbd></button>`).join('')}</div>` : ''}</td>
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
      <div class="custgrid"><input type="text" id="cName" placeholder="Name" value="${esc(c.customer)}" list="custNames" autocomplete="off"><input type="tel" id="cPhone" placeholder="Phone" value="${esc(c.phone)}"></div>
      <datalist id="custNames">${(S.custNames || []).map(x => `<option value="${esc(x.name)}">${esc(x.phone)}${x.balance > 0 ? ' · owes ' + money(x.balance) : ''}</option>`).join('')}</datalist>
      <div class="muted small" id="custBal" style="margin-top:4px"></div></div>
    ${c.payment === 'udhaar' ? `<div class="totrow"><label for="paidNow">Paid now ₹ <span class="muted small">(rest on udhaar)</span></label><input type="number" step="any" id="paidNow" value="${c.paidNow || ''}" placeholder="0"></div>
      ${+c.paidNow > 0 ? `<div class="totrow"><span class="muted">Paid by</span><div class="seg" id="paidMode">${[['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card']].map(([k, l]) => `<button type="button" data-pm="${k}" aria-pressed="${(c.paidMode || 'cash') === k}">${l}</button>`).join('')}</div></div>
      <div class="change"><span>On udhaar</span><span class="num">${money(Math.max(0, t.total - r2(c.paidNow)))}</span></div>` : ''}` : ''}
    <div class="actions">
      <button type="button" class="btn primary big wide" id="savePrint" ${c.lines.length ? '' : 'disabled'}>Save &amp; print <kbd>F9</kbd></button>
      <button type="button" class="btn" id="saveOnly" ${c.lines.length ? '' : 'disabled'}>Save only <kbd>F10</kbd></button>
      <button type="button" class="btn" id="holdB" ${c.lines.length ? '' : 'disabled'}>Hold <kbd>Ctrl+H</kbd></button>
      ${liveOn() ? `<button type="button" class="btn" id="sendB" ${c.lines.length ? '' : 'disabled'}>Send to…</button>` : ''}
      <button type="button" class="btn" id="clearB" ${c.lines.length ? '' : 'disabled'}>Clear <kbd>Esc</kbd></button>
    </div>
    ${lb ? `<div class="lastbill"><span>Last bill <b>#${esc(lb.bill_no)}</b> · <span class="num">${money(lb.total)}</span></span><span style="display:flex;gap:6px"><button type="button" class="btn" id="waLast" title="Send the bill as a PDF on WhatsApp">WhatsApp <kbd>Alt+W</kbd></button><button type="button" class="btn" id="reprint">Reprint <kbd>Ctrl+P</kbd></button></span></div>` : ''}`;
  $('#disc').addEventListener('change', e => { c.discount = Math.max(0, r2(e.target.value)); saveCart(); renderTotals(); });
  $('#disc').addEventListener('keydown', e => { if (e.key === 'Enter') { e.target.blur(); focusScan(); } });
  $('#recv')?.addEventListener('input', e => { c.received = e.target.value; saveCart(); const ch = $('.change'); const rec2 = r2(e.target.value); if (rec2 > 0) { if (!ch) renderTotalsKeepFocus('recv'); else { const d = r2(rec2 - t.total); ch.innerHTML = `<span>${d >= 0 ? 'Return to customer' : 'Still to collect'}</span><span class="num">${money(Math.abs(d))}</span>`; } } else if (ch) ch.remove(); });
  $('#recv')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveBill(true); } });
  el.querySelector('.paygrid').addEventListener('click', e => { const b = e.target.closest('[data-pay]'); if (!b) return; c.payment = b.dataset.pay; saveCart(); renderTotals(); if (c.payment === 'udhaar' && !c.customer) $('#cName').focus(); else focusScan(); });
  $('#cName').addEventListener('input', e => {
    c.customer = e.target.value;
    const hit = (S.custNames || []).find(x => x.name.toLowerCase() === c.customer.trim().toLowerCase());
    if (hit && hit.phone && !c.phone) { c.phone = hit.phone; $('#cPhone').value = hit.phone; }
    saveCart(); showCustBal();
  });
  $('#cPhone').addEventListener('input', e => { c.phone = e.target.value; saveCart(); showCustBal(); });
  $('#paidNow')?.addEventListener('change', e => { c.paidNow = Math.max(0, r2(e.target.value)); saveCart(); renderTotals(); });
  $('#paidMode')?.addEventListener('click', e => { const b = e.target.closest('[data-pm]'); if (b) { c.paidMode = b.dataset.pm; saveCart(); renderTotals(); } });
  showCustBal();
  for (const id of ['cName', 'cPhone']) $('#' + id).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); focusScan(); } });
  $('#savePrint').addEventListener('click', () => saveBill(true));
  $('#saveOnly').addEventListener('click', () => saveBill(false));
  $('#holdB').addEventListener('click', () => holdBill());
  $('#sendB')?.addEventListener('click', () => transferCart(c.id, c));
  $('#clearB').addEventListener('click', () => { clearArm = Date.now(); clearBill(); });
  $('#reprint')?.addEventListener('click', reprintLast);
  $('#waLast')?.addEventListener('click', () => S.lastBill && sendWhatsApp(S.lastBill));
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
      ...(c.payment === 'udhaar' ? { paid_now: r2(c.paidNow), paid_mode: c.paidMode || 'cash' } : {}),
      lines: c.lines.map(l => ({ code: l.code, qty: l.qty, rate: l.rate, name: l.name, unit: l.unit, gst: l.gst })),
    });
    S.lastBill = bill;
    for (const l of bill.lines) { const it = S.items.get(l.code); if (it && it.stock != null) it.stock = r2(it.stock - l.qty * (l.factor || 1)); }
    S.cart = newCart(c); S.sel = 0; saveCart(); renderQuick();
    if (bill.payment === 'udhaar') loadCustNames();
    renderCart(); focusScan();
    if (print) {
      toast(`Bill #${bill.bill_no} saved · ${money(bill.total)} · printing…`);
      rpc('print.bill', bill.id, '').catch(err => toast(`Bill #${bill.bill_no} is saved, but it did not print: ${err.message}`, { err: true, ms: 9000, action: 'Retry', onAction: () => reprintLast() }));
    } else toast(`Bill #${bill.bill_no} saved · ${money(bill.total)}`);
  } catch (err) {
    toast(err.message, { err: true });
  } finally { saving = false; }
}
/* Bill as a PDF on WhatsApp: the PDF is made and copied, WhatsApp opens on the customer's chat — press Ctrl+V, then Enter. */
async function sendWhatsApp(b) {
  let phone = b.phone || '';
  if (String(phone).replace(/\D/g, '').length < 10) {
    phone = await new Promise(resolve => {
      const m = openModal(`<h2>Send bill #${esc(b.bill_no)} on WhatsApp</h2><label class="f"><span>Customer’s WhatsApp number</span><input type="tel" id="waNo" placeholder="10-digit mobile number" value="${esc(b.phone || '')}"></label>
        <p class="muted small">Leave it blank to choose the chat yourself in WhatsApp.</p>
        <div class="foot"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn accent" id="waGo">Make PDF &amp; open WhatsApp</button></div>`, { onClose: () => resolve(null) });
      setTimeout(() => $('#waNo', m).focus(), 30);
      const go = () => { const v = $('#waNo', m).value; m._onClose = null; closeModal(m); resolve(v); };
      $('#waGo', m).addEventListener('click', go);
      $('#waNo', m).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    });
    if (phone === null) return;
  }
  toast('Making the PDF…');
  try {
    const r = await rpc('bills.whatsapp', b.id, phone);
    toast(r.copied ? 'WhatsApp is opening. In the chat press Ctrl+V to attach the bill PDF, then Enter.' : 'WhatsApp is opening. Attach the PDF from the folder that opens.', { ms: 12000, action: 'Show PDF file', onAction: () => rpc('bills.showFile', r.file) });
    if (!r.copied) rpc('bills.showFile', r.file);
  } catch (err) { toast('Could not make the PDF: ' + err.message, { err: true, ms: 8000 }); }
}
async function reprintLast() {
  const b = S.lastBill || await rpc('bills.last').catch(() => null);
  if (!b) { toast('No bills yet.'); return; }
  toast(`Reprinting bill #${b.bill_no}…`);
  rpc('print.bill', b.id, '', true).catch(err => toast('Did not print: ' + err.message, { err: true, ms: 8000 }));
}

/* ================= item form ================= */
async function openItemForm(it, opts = {}) {
  const editing = !!(it && it.name != null);
  if (editing && !(await requirePerm('edit', 'Editing an item needs the owner'))) return;
  if (!editing && !(await requirePerm('add', 'Adding items is switched off for you'))) return;
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
async function sizeChips() {
  const z = await rpc('labels.sizes').catch(() => ({ list: [] }));
  return z.list.length > 1 ? `<div class="sizes w" id="lSizes">${z.list.map(x => `<button type="button" data-size="${esc(x.id)}" aria-pressed="${x.id === z.active}"><b>${+x.w} × ${+x.h} mm</b><small>${+x.across} across</small></button>`).join('')}</div>` : '';
}
const RATE_SIZES = [['100', 'Normal'], ['130', 'Large'], ['160', 'Extra large'], ['200', 'Huge'], ['250', 'Biggest']];
const rateSel = (id, v) => `<select id="${id}" style="width:auto">${RATE_SIZES.map(([k, l]) => `<option value="${k}"${String(v || '100') === k ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
const rateField = () => `<label style="display:flex;gap:8px;align-items:center">Rate size ${rateSel('lRate', S.settings.label_rate_size)}</label>`;
const logoTick = () => S.settings.label_logo ? `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="lLogo" ${S.settings.label_show_logo !== '0' ? 'checked' : ''}> Show logo</label>` : '';
async function openLabels(it, keepCount) {
  if (!(await requirePerm('labels', 'Printing labels is switched off for you'))) return;
  let info;
  try { info = await rpc('print.labelInfo', it.code); } catch (err) { toast(err.message, { err: true }); return; }
  const across = info.across, chips = await sizeChips();
  const def = keepCount || across * Math.max(1, Math.ceil(Math.min(it.stock > 0 ? it.stock : 1, 300) / across));
  const m = openModal(`<h2>Print barcode labels</h2>
    <p><b>${esc(it.name)}</b> <span class="num muted">${esc(it.code)}</span></p>
    ${info.fits ? '' : `<div class="confirmbar" style="background:color-mix(in srgb,var(--warn) 14%,transparent)"><span><b>This code is too long for a ${esc(info.w)} mm label.</b> The bars come out too thin and scanners can’t read them. Give the item a short code like NR10023 and it will scan.</span><button type="button" class="btn" id="lShort">Use a short code</button></div>`}
    <div class="form2">
      <label class="f"><span>How many labels</span><input type="number" id="lCount" min="1" max="1000" value="${def}"></label>
      ${chips ? '' : `<div class="f"><span class="lbl">Roll</span><div style="padding-top:8px">${across} across · ${esc(info.w)} × ${esc(info.h)} mm</div></div>`}
      ${chips ? `<div class="f w"><span class="lbl">Label size</span>${chips}</div>` : ''}
<div class="w" style="display:flex;gap:18px;flex-wrap:wrap;align-items:center">${rateField()}${logoTick()}
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
  $('#lSizes', m)?.addEventListener('click', async e => {
    const b = e.target.closest('[data-size]'); if (!b || b.getAttribute('aria-pressed') === 'true') return;
    try { S.settings = await rpc('labels.useSize', b.dataset.size); } catch (err) { toast(err.message, { err: true }); return; }
    const n = cnt(); m._onClose = null; closeModal(m); openLabels(it, n);
  });
  upd(); $('#lCount', m).addEventListener('input', upd);
  setTimeout(() => { $('#lCount', m).focus(); $('#lCount', m).select(); }, 30);
  $('#lShort', m)?.addEventListener('click', async () => {
    if (!(await requirePerm('edit', 'Changing an item code needs the owner'))) return;
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
const showOpts = m => ({ retail: $('#lRetail', m).checked, wholesale: $('#lWs', m).checked, ...($('#lLogo', m) ? { logo: $('#lLogo', m).checked } : {}), ...($('#lRate', m) ? { rateSize: $('#lRate', m).value } : {}) });
async function openLabelList() {
  if (!(await requirePerm('labels', 'Printing labels is switched off for you'))) return;
  const across = Math.max(1, parseInt(S.settings.label_across, 10) || 1), chips = await sizeChips();
  const m = openModal(`<h2>Label list</h2>${chips ? `<div class="f"><span class="lbl">Label size</span>${chips}</div>` : ''}<div id="qLong"></div><div id="qBody"></div>
    <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:6px;align-items:center">${rateField()}${logoTick()}
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
  $('#lSizes', m)?.addEventListener('click', async e => {
    const b = e.target.closest('[data-size]'); if (!b || b.getAttribute('aria-pressed') === 'true') return;
    try { S.settings = await rpc('labels.useSize', b.dataset.size); } catch (err) { toast(err.message, { err: true }); return; }
    m._onClose = null; closeModal(m); openLabelList();
  });
  // codes that are too long to scan on this label size: offer short codes for all of them at once
  (async () => {
    const long = [];
    for (const q of S.labelQ) { try { const inf = await rpc('print.labelInfo', q.code); if (!inf.fits) long.push(q.code); } catch (e) {} }
    if (!long.length || !$('#qLong', m)) return;
    $('#qLong', m).innerHTML = `<div class="confirmbar" style="background:color-mix(in srgb,var(--warn) 14%,transparent)"><span><b>${long.length} item${long.length === 1 ? ' has a code' : 's have codes'} too long to scan on this label</b> (${long.slice(0, 3).map(c => esc(S.items.get(c)?.name || c)).join(', ')}${long.length > 3 ? '…' : ''}). Short codes like NR10023 scan first time.</span><button type="button" class="btn" id="qFix">Give them short codes</button></div>`;
    $('#qFix', m).addEventListener('click', async () => {
      if (!(await requirePerm('edit', 'Changing item codes needs the owner'))) return;
      try {
        const ch = await rpc('items.fixCodes', long);
        await reloadItems();
        for (const c of ch) S.labelQ.forEach(q => { if (q.code === c.from) q.code = c.to; });
        saveQ(); $('#qLong', m).innerHTML = ''; draw();
        toast(`${ch.length} item${ch.length === 1 ? '' : 's'} now have short codes`);
      } catch (err) { toast(err.message, { err: true }); }
    });
  })();
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
  if (!(await requirePerm('edit', 'Adding stock needs the owner'))) return;
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

/* ================= logo for labels =================
   The picture becomes pure black and white (thermal printers can't print grey), trimmed to the logo. */
function pickLogo() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp,image/bmp,image/gif';
  inp.addEventListener('change', () => {
    const f = inp.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { const img = new Image(); img.onload = () => logoDialog(img); img.onerror = () => toast('That file is not a picture.', { err: true }); img.src = rd.result; };
    rd.readAsDataURL(f);
  });
  inp.click();
}
function logoBW(img, level, maxH = 160) {
  const sc = Math.min(1, 600 / img.width, (maxH * 3) / img.height);
  const W = Math.max(1, Math.round(img.width * sc)), H = Math.max(1, Math.round(img.height * sc));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.drawImage(img, 0, 0, W, H);
  const d = x.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  const blk = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const l = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    if (l < level) { blk[i] = 1; const px = i % W, py = (i / W) | 0; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
  }
  if (x1 < 0) return null;
  // trim, then scale to the stored height
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, k = Math.min(1, maxH / ch, 480 / cw);
  const w = Math.max(1, Math.round(cw * k)), h = Math.max(1, Math.round(ch * k)), wb = Math.ceil(w / 8);
  const bits = new Uint8Array(wb * h);
  const o = document.createElement('canvas'); o.width = w; o.height = h;
  const ox = o.getContext('2d'), od = ox.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
    const sx = x0 + Math.min(cw - 1, Math.floor(xx / k)), sy = y0 + Math.min(ch - 1, Math.floor(y / k));
    const b = blk[sy * W + sx], j = (y * w + xx) * 4;
    od.data[j] = od.data[j + 1] = od.data[j + 2] = b ? 0 : 255; od.data[j + 3] = b ? 255 : 0;
    if (b) bits[y * wb + (xx >> 3)] |= 0x80 >> (xx & 7);
  }
  ox.putImageData(od, 0, 0);
  let bin = ''; for (let i = 0; i < bits.length; i++) bin += String.fromCharCode(bits[i]);
  return { png: o.toDataURL('image/png'), bits: { w, h, data: btoa(bin) } };
}
function logoDialog(img) {
  let level = 150, cur = null;
  const m = openModal(`<h2>Logo for labels</h2>
    <p class="muted">Labels print in black only. Move the slider until the logo looks clear and solid.</p>
    <div style="display:flex;justify-content:center;background:#fff;border:1px solid var(--line);border-radius:8px;padding:16px"><img id="lgPrev" alt="Logo preview" style="max-width:100%;max-height:140px;image-rendering:pixelated"></div>
    <label class="f"><span>Darkness</span><input type="range" id="lgLvl" min="40" max="240" value="${level}"></label>
    <div class="err" id="lgErr"></div>
    <div class="foot"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn accent" id="lgSave">Use this logo</button></div>`);
  const draw = () => { cur = logoBW(img, level); $('#lgPrev', m).src = cur ? cur.png : ''; $('#lgErr', m).textContent = cur ? '' : 'Nothing dark enough — move the slider right.'; };
  draw();
  $('#lgLvl', m).addEventListener('input', e => { level = +e.target.value; draw(); });
  $('#lgSave', m).addEventListener('click', async () => {
    if (!cur) return;
    try { S.settings = await rpc('labels.setLogo', cur.png, cur.bits); closeModal(m); toast('Logo added to labels'); if (S.view === 'settings') renderSettings(); }
    catch (err) { $('#lgErr', m).textContent = err.message; }
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
  if (!can('stock')) return '<span class="chip">hidden</span>';
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
  if (S.items.size && !(await requirePerm('edit', 'Importing items needs the owner'))) return;
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
    if (sales.range !== 'today' && !(await requirePerm('reports', 'Older sales need the owner'))) sales.range = 'today';
    [sales.from, sales.to] = rangeDates(sales.range);
    try {
      [sales.sum, sales.bills, sales.items, sales.returns] = await Promise.all([rpc('reports.summary', sales.from, sales.to), rpc('bills.list', sales.from, sales.to), rpc('reports.items', sales.from, sales.to), rpc('returns.list', sales.from, sales.to).catch(() => [])]);
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
      ${s.returns && s.returns.n ? `<div class="stat"><div class="lbl">Returns (${s.returns.n})</div><div class="v">−${money(s.returns.total)}</div></div><div class="stat"><div class="lbl">Net sales</div><div class="v">${money(s.net)}</div></div>` : ''}
      ${s.collected && Object.keys(s.collected).length ? `<div class="stat"><div class="lbl">Udhaar collected</div><div class="v">${money(Object.values(s.collected).reduce((a, x) => a + x.total, 0))}</div></div>` : ''}
    </div>
    ${s.returns && s.returns.n ? `<p class="muted small" style="margin:0">Money given back: ${Object.entries(s.returns.by).map(([k, v]) => `${k === 'account' ? 'off udhaar accounts' : esc(PAYNAME[k] || k)} ${money(v)}`).join(' · ')}. Cash in drawer = cash sales + udhaar collected in cash − cash refunds.</p>` : ''}
    <div class="toolbar"><div class="seg" id="tabSeg"><button type="button" data-t="bills" aria-pressed="${sales.tab === 'bills'}">Bills (${sales.bills.length})</button><button type="button" data-t="items" aria-pressed="${sales.tab === 'items'}">Item-wise (${sales.items.length})</button><button type="button" data-t="returns" aria-pressed="${sales.tab === 'returns'}">Returns (${(sales.returns || []).length})</button></div>
      <span class="muted small">${sales.from === sales.to ? sales.from.split('-').reverse().join('/') : sales.from.split('-').reverse().join('/') + ' to ' + sales.to.split('-').reverse().join('/')}</span></div>
    <div class="tablewrap"><table class="grid" id="salesTable">${sales.tab === 'bills' ? billsTable() : sales.tab === 'returns' ? returnsTable() : itemsTable()}</table></div></div>`;
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
      <td>${esc(b.customer || 'Walk-in')}${b.mode === 'wholesale' ? ' <span class="chip acc">Wholesale</span>' : ''}${b.cancelled ? ' <span class="chip out">Cancelled</span>' : ''}${+b.returned ? ` <span class="chip low">returned ${money(b.returned)}</span>` : ''}</td>
      <td class="r num">${b.items_count}</td><td>${b.payment === 'udhaar' ? '<span class="chip low">Udhaar</span>' : esc(PAYNAME[b.payment] || b.payment)}</td>
      <td class="r num">${+b.discount ? money(b.discount) : ''}</td><td class="r num"><b>${money(b.total)}</b></td></tr>`).join('')}</tbody>`;
}
function returnsTable() {
  const r = sales.returns || [];
  if (!r.length) return `<tbody><tr><td><div class="empty"><b>No returns</b>Open a bill and click <b>Return items</b> when a customer brings something back.</div></td></tr></tbody>`;
  const MODE = { cash: 'Cash refund', upi: 'UPI refund', card: 'Card refund', account: 'Off udhaar account' };
  return `<thead><tr><th>Return</th><th>Time</th><th>Bill</th><th>Customer</th><th>Money back</th><th>By</th><th class="r">Amount</th></tr></thead>
    <tbody>${r.map(x => `<tr class="click" data-id="${x.bill_id}"><td class="num"><b>${esc(x.return_no)}</b></td><td>${esc(fmtTime(x.created_at))}</td><td class="num">${esc(x.bill_no)}</td><td>${esc(x.customer || 'Walk-in')}</td><td>${esc(MODE[x.refund_mode] || x.refund_mode)}${x.note ? ` <span class="muted small">${esc(x.note)}</span>` : ''}</td><td>${esc(x.staff || '')}</td><td class="r num"><b>−${money(x.total)}</b></td></tr>`).join('')}</tbody>`;
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
        ${+b.returned ? `<p class="muted">Items worth <b class="num">${money(b.returned)}</b> were returned from this bill (see Sales → Returns).</p>` : ''}
        <p style="margin-top:10px">Subtotal <b class="num">${money(b.subtotal)}</b>${+b.discount ? ` · Discount <b class="num">${money(b.discount)}</b>` : ''} · Total <b class="num">${money(b.total)}</b></p>
        <div class="err" id="bErr"></div>
        <div class="confirmbar" id="bConfirm" hidden><span>Cancel bill #${esc(b.bill_no)}? Its items go back into stock. The bill stays in the records marked cancelled.</span><button type="button" class="btn" id="bNo">Keep bill</button><button type="button" class="btn danger" id="bYes">Cancel bill</button></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;min-height:0"><div class="seg" id="bPrev"><button type="button" data-v="thermal" aria-pressed="true">Receipt</button><button type="button" data-v="a4" aria-pressed="false">A4 invoice</button></div>
      <iframe title="Bill preview" id="bFrame" sandbox srcdoc="${esc(html)}"></iframe></div>
    </div>
    <div class="foot">${b.cancelled || +b.returned ? '' : '<button type="button" class="btn danger left" id="bCancel">Cancel bill</button>'}${b.cancelled ? '' : '<button type="button" class="btn" id="bReturn">Return items</button>'}<button type="button" class="btn" data-close>Close</button><button type="button" class="btn" id="bPdf">Save PDF</button><button type="button" class="btn" id="bWa">WhatsApp PDF</button><button type="button" class="btn" id="bA4">Print A4</button><button type="button" class="btn accent" id="bPrint">Print receipt</button></div>`, { wide: true });
  $('#bPrev', m).addEventListener('click', async e => {
    const x = e.target.closest('[data-v]'); if (!x) return;
    $$('#bPrev button', m).forEach(y => y.setAttribute('aria-pressed', y === x));
    const f = $('#bFrame', m);
    if (x.dataset.v === 'a4') { f.srcdoc = await rpc('print.a4preview', b.id); f.classList.add('a4'); } else { f.srcdoc = html; f.classList.remove('a4'); }
  });
  $('#bA4', m).addEventListener('click', () => rpc('print.bill', b.id, 'a4', true).then(() => toast('Sent to the A4 printer')).catch(err => { $('#bErr', m).textContent = err.message; }));
  $('#bWa', m).addEventListener('click', () => sendWhatsApp(b));
  $('#bPdf', m).addEventListener('click', () => rpc('bills.pdf', b.id).then(f => toast('PDF saved', { action: 'Show file', onAction: () => rpc('bills.showFile', f) })).catch(err => { $('#bErr', m).textContent = err.message; }));
  $('#bReturn', m)?.addEventListener('click', async () => { if (await requirePerm('cancel', 'Returns need the owner')) { m._onClose = null; closeModal(m); openReturn(b.id); } });
  $('#bPrint', m).addEventListener('click', () => rpc('print.bill', b.id, 'thermal', true).then(() => toast('Sent to printer')).catch(err => { $('#bErr', m).textContent = err.message; }));
  $('#bCancel', m)?.addEventListener('click', async () => { if (await requirePerm('cancel', 'Cancelling a bill needs the owner')) $('#bConfirm', m).hidden = false; });
  $('#bNo', m)?.addEventListener('click', () => { $('#bConfirm', m).hidden = true; });
  $('#bYes', m)?.addEventListener('click', async () => {
    try { await rpc('bills.cancel', b.id); await reloadItems(); closeModal(m); toast(`Bill #${b.bill_no} cancelled, stock restored`); renderSales(); }
    catch (err) { $('#bErr', m).textContent = err.message; }
  });
}

/* ================= udhaar accounts ================= */
const MODEN = { cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank' };
async function loadCustNames() { try { S.custNames = (await rpc('customers.list')).slice(0, 800); } catch (e) { S.custNames = []; } }
let custBalT = 0;
function showCustBal() {
  clearTimeout(custBalT);
  custBalT = setTimeout(async () => {
    const el = $('#custBal'); if (!el) return;
    const c = S.cart; if (!c.customer.trim() && !c.phone.trim()) { el.textContent = ''; return; }
    const x = await rpc('customers.find', c.customer, c.phone).catch(() => null);
    if (!$('#custBal')) return;
    $('#custBal').innerHTML = x ? (x.balance > 0 ? `<span class="chip low">Already owes ${money(x.balance)}</span>` : x.balance < 0 ? `<span class="chip ok">Advance ${money(-x.balance)}</span>` : '<span class="chip ok">No udhaar due</span>') : '';
  }, 250);
}
function waReminder(c) {
  let p = String(c.phone || '').replace(/\D/g, ''); if (p.length === 10) p = '91' + p;
  const shop = S.settings.shop_name || 'NRRL';
  const text = `Namaste ${c.name}, this is a reminder from ${shop}. Your pending amount is ₹${r2(c.balance)}. Please pay at your convenience. Thank you!`;
  return 'https://wa.me/' + p + '?text=' + encodeURIComponent(text);
}
const cust = { q: '', filter: 'due' };
async function renderCustomers() {
  const el = $('#v-customers');
  let list, tot;
  try { [list, tot] = await Promise.all([rpc('customers.list', cust.q), rpc('customers.udhaarTotal')]); } catch (err) { toast(err.message, { err: true }); return; }
  const shown = cust.filter === 'due' ? list.filter(c => c.balance > 0.009) : list;
  el.innerHTML = `<div class="page">
    <div class="ph"><h1>Udhaar accounts</h1><div class="toolbar"><button type="button" class="btn" id="cuExp">Export CSV</button><button type="button" class="btn primary" id="cuAdd">+ Add customer</button></div></div>
    <div class="stats"><div class="stat main"><div class="lbl">Total udhaar to collect</div><div class="v">${money(tot.total)}</div></div><div class="stat"><div class="lbl">Customers who owe</div><div class="v">${tot.n}</div></div></div>
    <div class="toolbar"><input type="search" id="cuQ" placeholder="Search name or phone" value="${esc(cust.q)}">
      <div class="seg" id="cuSeg"><button type="button" data-f="due" aria-pressed="${cust.filter === 'due'}">Owe money</button><button type="button" data-f="all" aria-pressed="${cust.filter === 'all'}">All customers</button></div>
      <span class="muted small">Every udhaar bill — from this laptop, other laptops and the phone app — goes to the customer’s account by phone number (or name).</span></div>
    <div class="tablewrap"><table class="grid" id="cuTable">${!shown.length ? `<tbody><tr><td><div class="empty"><b>${cust.filter === 'due' ? 'Nobody owes money' : 'No customers yet'}</b>Customers appear here when you make an udhaar bill.</div></td></tr></tbody>` : `
      <thead><tr><th>Customer</th><th>Phone</th><th>Last bill</th><th>Last payment</th><th class="r">Balance</th><th style="width:200px"></th></tr></thead>
      <tbody>${shown.map(c => `<tr class="click" data-cid="${c.id}"><td><b>${esc(c.name)}</b>${c.gstin ? ` <span class="chip">${esc(c.gstin)}</span>` : ''}</td><td class="num">${esc(c.phone)}</td><td>${c.last_bill ? esc(fmtTime(c.last_bill)) : ''}</td><td>${c.last_payment ? esc(fmtTime(c.last_payment)) : ''}</td>
        <td class="r num"><b class="${c.balance > 0 ? 'warn' : ''}">${c.balance < 0 ? 'Advance ' + money(-c.balance) : money(c.balance)}</b></td>
        <td class="r">${c.balance > 0 ? `<button type="button" class="btn sm" data-pay="${c.id}">Receive</button>${c.phone ? ` <button type="button" class="btn sm" data-wa="${c.id}">WhatsApp</button>` : ''}` : ''}</td></tr>`).join('')}</tbody>`}</table></div></div>`;
  $('#cuQ').addEventListener('input', e => { cust.q = e.target.value; clearTimeout(cust.t); cust.t = setTimeout(() => renderCustomers().then(() => { const q = $('#cuQ'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }), 250); });
  $('#cuSeg').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (b) { cust.filter = b.dataset.f; renderCustomers(); } });
  $('#cuAdd').addEventListener('click', () => editCustomer(null));
  $('#cuExp').addEventListener('click', () => saveCsv(`nrrl-udhaar-${today()}.csv`, [['Customer', 'Phone', 'GSTIN', 'Balance', 'Last bill', 'Last payment'], ...list.map(c => [c.name, c.phone, c.gstin, c.balance, c.last_bill || '', c.last_payment || ''])]));
  $('#cuTable').addEventListener('click', e => {
    const p = e.target.closest('[data-pay]'), w = e.target.closest('[data-wa]'), tr = e.target.closest('tr[data-cid]');
    if (p) return receivePayment(+p.dataset.pay);
    if (w) { const c = list.find(x => x.id === +w.dataset.wa); return rpc('app.openUrl', waReminder(c)).catch(err => toast(err.message, { err: true })); }
    if (tr) openCustomer(+tr.dataset.cid);
  });
}
async function openCustomer(id) {
  let c; try { c = await rpc('customers.get', id); } catch (err) { toast(err.message, { err: true }); return; }
  const KIND = { bill: 'Udhaar bill', payment: 'Payment received', return: 'Return' };
  const m = openModal(`<h2>${esc(c.name)} ${c.balance > 0 ? `<span class="chip low">owes ${money(c.balance)}</span>` : c.balance < 0 ? `<span class="chip ok">advance ${money(-c.balance)}</span>` : '<span class="chip ok">settled</span>'}</h2>
    <p class="muted">${esc(c.phone || 'No phone')}${c.gstin ? ' · GSTIN ' + esc(c.gstin) : ''}${c.address ? ' · ' + esc(c.address) : ''}${+c.opening ? ' · opening balance ' + money(c.opening) : ''}</p>
    <div class="tablewrap" style="max-height:52vh"><table class="grid"><thead><tr><th>Date</th><th>What</th><th class="r">Udhaar</th><th class="r">Paid / returned</th><th class="r">Balance</th><th></th></tr></thead>
      <tbody>${+c.opening ? `<tr><td></td><td>Opening balance</td><td class="r num">${money(c.opening)}</td><td></td><td class="r num">${money(c.opening)}</td><td></td></tr>` : ''}
      ${c.statement.map(r => `<tr class="${r.cancelled ? 'cx' : ''}${r.kind === 'bill' ? ' click' : ''}" ${r.kind === 'bill' ? `data-bill="${r.id}"` : ''}><td>${esc(fmtTime(r.at))}</td>
        <td>${KIND[r.kind]} ${r.kind === 'payment' ? esc(MODEN[r.ref] || r.ref) : `<b class="num">${esc(r.ref)}</b>`}${r.note ? ` <span class="muted small">${esc(r.note)}</span>` : ''}${r.cancelled ? ' <span class="chip out">cancelled</span>' : ''}</td>
        <td class="r num">${r.kind === 'bill' ? money(r.amount) : ''}</td><td class="r num">${r.kind !== 'bill' ? money(r.amount) : ''}</td><td class="r num">${money(r.balance)}</td>
        <td>${r.kind === 'payment' && !r.cancelled ? `<button type="button" class="btn sm" data-undo="${r.id}" title="Cancel this payment">Undo</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6"><div class="empty">No udhaar bills or payments yet.</div></td></tr>'}</tbody></table></div>
    <div class="err" id="coErr"></div>
    <div class="foot"><button type="button" class="btn left" id="coEdit">Edit details</button>${c.phone && c.balance > 0 ? '<button type="button" class="btn" id="coWa">WhatsApp reminder</button>' : ''}<button type="button" class="btn" data-close>Close</button><button type="button" class="btn accent" id="coPay">Receive payment</button></div>`, { wide: true });
  $('#coPay', m).addEventListener('click', () => { m._onClose = null; closeModal(m); receivePayment(c.id); });
  $('#coEdit', m).addEventListener('click', () => { m._onClose = null; closeModal(m); editCustomer(c); });
  $('#coWa', m)?.addEventListener('click', () => rpc('app.openUrl', waReminder(c)).catch(err => toast(err.message, { err: true })));
  m.querySelector('tbody').addEventListener('click', async e => {
    const u = e.target.closest('[data-undo]');
    if (u) {
      if (!(await requirePerm('cancel', 'Undoing a payment needs the owner'))) return;
      try { await rpc('payments.cancel', +u.dataset.undo); m._onClose = null; closeModal(m); toast('Payment cancelled'); openCustomer(c.id); if (S.view === 'customers') renderCustomers(); } catch (err) { $('#coErr', m).textContent = err.message; }
      return;
    }
    const tr = e.target.closest('tr[data-bill]'); if (tr) openBill(+tr.dataset.bill);
  });
}
async function receivePayment(id) {
  if (!(await requirePerm('bill', 'Receiving payments is switched off for you'))) return;
  let c; try { c = await rpc('customers.get', id); } catch (err) { toast(err.message, { err: true }); return; }
  const m = openModal(`<h2>Receive payment · ${esc(c.name)}</h2>
    <p>Owes <b class="num">${money(Math.max(0, c.balance))}</b></p>
    <div class="form2"><label class="f"><span>Amount received ₹</span><input type="number" step="any" id="rpAmt" value="${c.balance > 0 ? c.balance : ''}"></label>
      <div class="f"><span class="lbl">Paid by</span><div class="seg" id="rpMode">${['cash', 'upi', 'card', 'bank'].map((k, i) => `<button type="button" data-m="${k}" aria-pressed="${i === 0}">${MODEN[k]}</button>`).join('')}</div></div>
      <label class="f w"><span>Note (optional)</span><input type="text" id="rpNote" placeholder="e.g. paid by son"></label></div>
    <div class="err" id="rpErr"></div>
    <div class="foot"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn accent" id="rpGo">Save payment</button></div>`);
  let mode = 'cash';
  $('#rpMode', m).addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (!b) return; mode = b.dataset.m; $$('#rpMode button', m).forEach(x => x.setAttribute('aria-pressed', x === b)); });
  setTimeout(() => { $('#rpAmt', m).focus(); $('#rpAmt', m).select(); }, 30);
  const go = async () => {
    try { const r = await rpc('payments.receive', c.id, $('#rpAmt', m).value, mode, $('#rpNote', m).value); closeModal(m); toast(`Saved. ${r.customer.name} now ${r.customer.balance > 0 ? 'owes ' + money(r.customer.balance) : 'owes nothing'}.`); loadCustNames(); if (S.view === 'customers') renderCustomers(); }
    catch (err) { $('#rpErr', m).textContent = err.message; }
  };
  $('#rpGo', m).addEventListener('click', go);
  $('#rpAmt', m).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
}
function editCustomer(c) {
  const m = openModal(`<h2>${c ? 'Edit customer' : 'Add customer'}</h2>
    <div class="form2"><label class="f w"><span>Name</span><input type="text" id="ecName" value="${esc(c?.name || '')}"></label>
      <label class="f"><span>Phone (WhatsApp)</span><input type="tel" id="ecPhone" value="${esc(c?.phone || '')}"></label>
      <label class="f"><span>GSTIN (for business customers)</span><input type="text" id="ecGst" value="${esc(c?.gstin || '')}"></label>
      <label class="f w"><span>Address</span><input type="text" id="ecAddr" value="${esc(c?.address || '')}"></label>
      <label class="f"><span>Opening balance ₹ (old udhaar from before)</span><input type="number" step="any" id="ecOpen" value="${c ? c.opening || '' : ''}" placeholder="0"></label>
      <label class="f"><span>Note</span><input type="text" id="ecNote" value="${esc(c?.note || '')}"></label></div>
    <div class="err" id="ecErr"></div>
    <div class="foot"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn accent" id="ecGo">Save</button></div>`);
  setTimeout(() => $('#ecName', m).focus(), 30);
  $('#ecGo', m).addEventListener('click', async () => {
    const p = { name: $('#ecName', m).value, phone: $('#ecPhone', m).value, gstin: $('#ecGst', m).value, address: $('#ecAddr', m).value, opening: $('#ecOpen', m).value, note: $('#ecNote', m).value };
    if (c && r2(p.opening) !== r2(c.opening) && !(await requirePerm('edit', 'Changing an opening balance needs the owner'))) return;
    try { const r = c ? await rpc('customers.save', c.id, p) : await rpc('customers.add', p); closeModal(m); toast('Saved ' + r.name); loadCustNames(); if (S.view === 'customers') renderCustomers(); openCustomer(r.id); }
    catch (err) { $('#ecErr', m).textContent = err.message; }
  });
}

/* ================= returns ================= */
async function openReturn(billId) {
  let info; try { info = await rpc('returns.info', billId); } catch (err) { toast(err.message, { err: true }); return; }
  const b = info.bill, left = info.lines.filter(l => l.left > 0);
  if (!left.length) { toast('Everything on this bill was already returned.'); return; }
  const m = openModal(`<h2>Return items · bill #${esc(b.bill_no)}</h2>
    <p class="muted">${esc(fmtTime(b.created_at))} · ${esc(b.customer || 'Walk-in')} · ${esc(PAYNAME[b.payment] || b.payment)}${+b.discount ? ` · the bill’s discount is shared, so each item comes back at what the customer actually paid` : ''}</p>
    <div class="tablewrap" style="max-height:45vh"><table class="grid"><thead><tr><th>Item</th><th class="r">Bought</th><th class="r">Already back</th><th class="r" style="width:150px">Coming back</th><th class="r">Refund</th></tr></thead>
      <tbody id="rtBody">${info.lines.map((l, i) => `<tr><td><b>${esc(l.name)}</b><div class="muted small num">${esc(l.code)} · ${money(l.net_rate)}/${esc(l.unit)}</div></td><td class="r num">${qf(l.qty)} ${esc(l.unit)}</td><td class="r num">${l.returned ? qf(l.returned) : ''}</td>
        <td class="r">${l.left > 0 ? `<input type="number" min="0" max="${l.left}" step="any" data-ri="${i}" value="" placeholder="0" style="width:100px;text-align:right">` : '<span class="muted small">all back</span>'}</td><td class="r num" data-ra="${i}"></td></tr>`).join('')}</tbody></table></div>
    <div class="form2" style="margin-top:6px">
      <div class="f w"><span class="lbl">Money back</span><div class="seg" id="rtMode">${[['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['account', 'Take off udhaar account']].map(([k, l]) => `<button type="button" data-m="${k}" aria-pressed="${k === (b.payment === 'udhaar' ? 'account' : 'cash')}" ${k === 'account' && !b.customer ? 'disabled title="This bill has no customer"' : ''}>${l}</button>`).join('')}</div></div>
      <label class="f w"><span>Reason (optional)</span><input type="text" id="rtNote" placeholder="e.g. damaged, wrong size, not needed"></label>
      <label class="f w" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="rtPrint" checked> <span style="text-transform:none;letter-spacing:0;font-size:14px;color:var(--fg);font-weight:500">Print a return slip</span></label></div>
    <p style="font-size:18px">Refund <b class="num" id="rtTot">${money(0)}</b></p>
    <div class="err" id="rtErr"></div>
    <div class="foot"><button type="button" class="btn left" id="rtAll">Return everything</button><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn accent" id="rtGo" disabled>Save return</button></div>`, { wide: true });
  let mode = b.payment === 'udhaar' && b.customer ? 'account' : 'cash';
  const calc = () => {
    let t = 0;
    $$('[data-ri]', m).forEach(inp => { const l = info.lines[+inp.dataset.ri]; let q = Math.max(0, r2(inp.value)); if (q > l.left) { q = l.left; inp.value = q; } const a = r2(q * l.net_rate); t += a; $(`[data-ra="${inp.dataset.ri}"]`, m).textContent = q ? money(a) : ''; });
    $('#rtTot', m).textContent = money(t); $('#rtGo', m).disabled = !(t > 0);
  };
  m.addEventListener('input', e => { if (e.target.dataset.ri != null) calc(); });
  $('#rtAll', m).addEventListener('click', () => { $$('[data-ri]', m).forEach(inp => { inp.value = info.lines[+inp.dataset.ri].left; }); calc(); });
  $('#rtMode', m).addEventListener('click', e => { const x = e.target.closest('[data-m]'); if (!x || x.disabled) return; mode = x.dataset.m; $$('#rtMode button', m).forEach(y => y.setAttribute('aria-pressed', y === x)); });
  setTimeout(() => $('[data-ri]', m)?.focus(), 30);
  $('#rtGo', m).addEventListener('click', async () => {
    const lines = $$('[data-ri]', m).map(inp => ({ code: info.lines[+inp.dataset.ri].code, unit: info.lines[+inp.dataset.ri].unit, qty: r2(inp.value) })).filter(x => x.qty > 0);
    $('#rtGo', m).disabled = true;
    try {
      const r = await rpc('returns.save', { bill_id: b.id, refund_mode: mode, lines, note: $('#rtNote', m).value });
      await reloadItems(); closeModal(m);
      toast(`Return ${r.return_no} saved · ${mode === 'account' ? money(r.total) + ' taken off the udhaar account' : 'give back ' + money(r.total)}`, { ms: 5000 });
      if ($('#rtPrint', m).checked) rpc('print.return', r.id).catch(err => toast('Return saved, but the slip did not print: ' + err.message, { err: true }));
      if (S.view === 'sales') renderSales();
    } catch (err) { $('#rtErr', m).textContent = err.message; $('#rtGo', m).disabled = false; }
  });
}

/* ================= purchases & suppliers ================= */
const pur = { tab: 'purchases', range: 'month', from: today(), to: today() };
async function renderPurchases() {
  const el = $('#v-purchases');
  [pur.from, pur.to] = (() => { const d = new Date(), t = ymd(d); if (pur.range === 'month') return [ymd(new Date(d.getFullYear(), d.getMonth(), 1)), t]; if (pur.range === 'last') return [ymd(new Date(d.getFullYear(), d.getMonth() - 1, 1)), ymd(new Date(d.getFullYear(), d.getMonth(), 0))]; const f = new Date(); f.setFullYear(f.getFullYear() - 1); return [ymd(f), t]; })();
  let list = [], sups = [], owed;
  try { [list, sups, owed] = await Promise.all([rpc('purchases.list', pur.from, pur.to), rpc('suppliers.list'), rpc('suppliers.owed')]); } catch (err) { toast(err.message, { err: true }); return; }
  const live = list.filter(p => !p.cancelled);
  el.innerHTML = `<div class="page">
    <div class="ph"><h1>Purchases</h1><div class="toolbar"><button type="button" class="btn" id="puSup">+ Add supplier</button><button type="button" class="btn primary" id="puNew">+ New purchase</button></div></div>
    <div class="stats"><div class="stat main"><div class="lbl">Bought (${pur.range === 'month' ? 'this month' : pur.range === 'last' ? 'last month' : 'last 12 months'})</div><div class="v">${money(live.reduce((a, p) => a + p.total, 0))}</div></div>
      <div class="stat"><div class="lbl">You owe suppliers</div><div class="v">${money(owed.total)}</div></div><div class="stat"><div class="lbl">Suppliers owed</div><div class="v">${owed.n}</div></div></div>
    <div class="toolbar"><div class="seg" id="puTab"><button type="button" data-t="purchases" aria-pressed="${pur.tab === 'purchases'}">Purchase bills (${list.length})</button><button type="button" data-t="suppliers" aria-pressed="${pur.tab === 'suppliers'}">Suppliers (${sups.length})</button></div>
      ${pur.tab === 'purchases' ? `<div class="seg" id="puRange">${[['month', 'This month'], ['last', 'Last month'], ['year', '12 months']].map(([k, l]) => `<button type="button" data-r="${k}" aria-pressed="${pur.range === k}">${l}</button>`).join('')}</div>` : ''}</div>
    <div class="tablewrap"><table class="grid" id="puTable">${pur.tab === 'purchases' ? (!list.length ? `<tbody><tr><td><div class="empty"><b>No purchases yet</b>Click <b>New purchase</b> when stock arrives from a supplier. Stock goes up and the cost price is saved.</div></td></tr></tbody>` : `
      <thead><tr><th>No</th><th>Date</th><th>Supplier</th><th>Supplier bill</th><th class="r">Items</th><th class="r">Total</th><th class="r">Paid</th><th>By</th></tr></thead>
      <tbody>${list.map(p => `<tr class="click${p.cancelled ? ' cx' : ''}" data-pid="${p.id}"><td class="num"><b>${esc(p.purchase_no)}</b></td><td>${esc(fmtTime(p.created_at))}</td><td>${esc(p.supplier || '—')}${p.cancelled ? ' <span class="chip out">Cancelled</span>' : ''}</td><td class="num">${esc(p.supplier_bill)}</td><td class="r num">${p.items_count}</td><td class="r num"><b>${money(p.total)}</b></td><td class="r num">${p.paid ? money(p.paid) : ''}</td><td>${esc(p.staff)}</td></tr>`).join('')}</tbody>`)
      : (!sups.length ? `<tbody><tr><td><div class="empty"><b>No suppliers yet</b>They are added when you save a purchase, or with <b>Add supplier</b>.</div></td></tr></tbody>` : `
      <thead><tr><th>Supplier</th><th>Phone</th><th>GSTIN</th><th>Last purchase</th><th class="r">You owe</th><th></th></tr></thead>
      <tbody>${sups.map(x => `<tr class="click" data-sid="${x.id}"><td><b>${esc(x.name)}</b></td><td class="num">${esc(x.phone)}</td><td class="num">${esc(x.gstin)}</td><td>${x.last_purchase ? esc(fmtTime(x.last_purchase)) : ''}</td><td class="r num"><b>${x.balance < 0 ? 'Advance ' + money(-x.balance) : money(x.balance)}</b></td><td class="r">${x.balance > 0 ? `<button type="button" class="btn sm" data-spay="${x.id}">Pay</button>` : ''}</td></tr>`).join('')}</tbody>`)}</table></div></div>`;
  $('#puNew').addEventListener('click', () => openPurchaseForm());
  $('#puSup').addEventListener('click', () => editSupplier(null));
  $('#puTab').addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b) { pur.tab = b.dataset.t; renderPurchases(); } });
  $('#puRange')?.addEventListener('click', e => { const b = e.target.closest('[data-r]'); if (b) { pur.range = b.dataset.r; renderPurchases(); } });
  $('#puTable').addEventListener('click', e => {
    const sp = e.target.closest('[data-spay]'); if (sp) return paySupplier(+sp.dataset.spay);
    const tr = e.target.closest('tr[data-pid]'); if (tr) return openPurchase(+tr.dataset.pid);
    const ts = e.target.closest('tr[data-sid]'); if (ts) openSupplier(+ts.dataset.sid);
  });
}
async function openPurchaseForm() {
  let sups = []; try { sups = await rpc('suppliers.list'); } catch (e) {}
  const lines = [];
  const m = openModal(`<h2>New purchase</h2>
    <div class="form2" style="grid-template-columns:2fr 1fr 1fr">
      <label class="f"><span>Supplier</span><input type="text" id="pSup" list="supList" placeholder="Type or pick a supplier" autocomplete="off"><datalist id="supList">${sups.map(x => `<option value="${esc(x.name)}">`).join('')}</datalist></label>
      <label class="f"><span>Supplier’s bill no.</span><input type="text" id="pBill"></label>
      <label class="f"><span>Bill date</span><input type="date" id="pDate" value="${today()}"></label></div>
    <div class="scanbox" style="margin-top:6px"><input type="text" id="pScan" placeholder="Scan barcode or type item name, then Enter" autocomplete="off" spellcheck="false"><div class="sugg" id="pSugg" hidden></div></div>
    <div class="tablewrap" style="max-height:42vh;margin-top:8px"><table class="grid" id="pLines"></table></div>
    <div class="form2" style="grid-template-columns:1fr 1fr 2fr;margin-top:6px">
      <label class="f"><span>Paid now ₹</span><input type="number" step="any" id="pPaid" placeholder="0"></label>
      <label class="f"><span>Paid by</span><select id="pMode">${['cash', 'upi', 'bank', 'card'].map(k => `<option value="${k}">${MODEN[k]}</option>`).join('')}</select></label>
      <label class="f"><span>Note</span><input type="text" id="pNote"></label></div>
    <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="pLabels" ${LS.get('purLabels', true) ? 'checked' : ''}> Print barcode labels for these items after saving (one per piece received)</label>
    <p style="font-size:18px">Total <b class="num" id="pTot">${money(0)}</b> <span class="muted small" id="pOwe"></span></p>
    <div class="err" id="pErr"></div>
    <div class="foot"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn accent" id="pGo">Save purchase · add to stock</button></div>`, { wide: true });
  const draw = () => {
    $('#pLines', m).innerHTML = !lines.length ? '<tbody><tr><td><div class="empty" style="padding:20px">Scan or search the items that arrived.</div></td></tr></tbody>' : `<thead><tr><th>Item</th><th class="r" style="width:110px">Qty</th><th class="r" style="width:120px">Cost / unit ₹</th><th class="r" style="width:120px">New retail ₹</th><th class="r" style="width:120px">New wholesale ₹</th><th class="r">Amount</th><th style="width:40px"></th></tr></thead>
      <tbody>${lines.map((l, i) => `<tr><td><b>${esc(l.name)}</b><div class="muted small num">${esc(l.code)} · stock ${l.stock ?? '—'} · now ₹${l.oldRetail}${l.oldCost ? ' · last cost ₹' + l.oldCost : ''}</div></td>
        <td class="r"><input type="number" step="any" data-k="qty" data-i="${i}" value="${l.qty}" style="width:90px;text-align:right"> <span class="muted small">${esc(l.unit)}</span></td>
        <td class="r"><input type="number" step="any" data-k="cost" data-i="${i}" value="${l.cost}" style="width:100px;text-align:right"></td>
        <td class="r"><input type="number" step="any" data-k="retail" data-i="${i}" value="${l.retail}" placeholder="${l.oldRetail}" style="width:100px;text-align:right"></td>
        <td class="r"><input type="number" step="any" data-k="wholesale" data-i="${i}" value="${l.wholesale}" placeholder="${l.oldWs || ''}" style="width:100px;text-align:right"></td>
        <td class="r num">${money(r2(l.qty * l.cost))}</td><td><button type="button" class="xbtn" data-rm="${i}" aria-label="Remove">×</button></td></tr>`).join('')}</tbody>`;
    const t = r2(lines.reduce((a, l) => a + r2(l.qty * l.cost), 0)), paid = r2($('#pPaid', m).value);
    $('#pTot', m).textContent = money(t); $('#pOwe', m).textContent = t ? (paid >= t ? 'fully paid' : `you will owe ${money(t - Math.max(0, paid))}`) : '';
  };
  const add = it => {
    if (!it) return;
    const l = lines.find(x => x.code === it.code);
    if (l) l.qty = r2(l.qty + 1);
    else lines.push({ code: it.code, name: it.name, unit: it.unit, stock: it.stock, qty: 1, cost: it.cost || '', oldCost: it.cost, oldRetail: it.retail, oldWs: it.wholesale, retail: '', wholesale: '' });
    draw();
  };
  draw();
  const scan = $('#pScan', m), sg = $('#pSugg', m);
  let hits = [];
  scan.addEventListener('input', () => { hits = scan.value.trim() ? searchItems(scan.value) : []; sg.hidden = !hits.length || !!findItem(scan.value); sg.innerHTML = hits.map((it, i) => `<button type="button" data-code="${esc(it.code)}" aria-selected="${i === 0}"><span class="nm">${hl(it.name, scan.value)}</span><span class="num muted small">${esc(it.code)}</span></button>`).join(''); });
  scan.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return; e.preventDefault();
    const v = scan.value.trim(); if (!v) return;
    const it = findItem(v) || (hits.length ? hits[0] : null);
    if (!it) { $('#pErr', m).textContent = `“${v}” is not in the item list. Add it in Items & stock first.`; return; }
    $('#pErr', m).textContent = ''; add(it); scan.value = ''; sg.hidden = true; hits = [];
  });
  sg.addEventListener('mousedown', e => e.preventDefault());
  sg.addEventListener('click', e => { const b = e.target.closest('[data-code]'); if (b) { add(S.items.get(b.dataset.code)); scan.value = ''; sg.hidden = true; scan.focus(); } });
  $('#pLines', m).addEventListener('change', e => { const i = e.target.dataset.i; if (i == null) return; lines[+i][e.target.dataset.k] = e.target.value === '' ? '' : r2(e.target.value); draw(); });
  $('#pLines', m).addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) { lines.splice(+b.dataset.rm, 1); draw(); } });
  $('#pPaid', m).addEventListener('input', draw);
  setTimeout(() => $('#pSup', m).focus(), 30);
  $('#pGo', m).addEventListener('click', async () => {
    $('#pGo', m).disabled = true;
    try {
      const p = await rpc('purchases.save', { supplier: $('#pSup', m).value, supplier_bill: $('#pBill', m).value, bill_date: $('#pDate', m).value, paid: $('#pPaid', m).value, paid_mode: $('#pMode', m).value, note: $('#pNote', m).value,
        lines: lines.map(l => ({ code: l.code, qty: l.qty, cost: l.cost || 0, retail: l.retail, wholesale: l.wholesale })) });
      const wantLabels = $('#pLabels', m).checked; LS.set('purLabels', wantLabels);
      await reloadItems(); closeModal(m); toast(`Purchase ${p.purchase_no} saved · stock added for ${p.items_count} items`); if (S.view === 'purchases') renderPurchases();
      if (wantLabels) labelsForPurchase(p);
    } catch (err) { $('#pErr', m).textContent = err.message; $('#pGo', m).disabled = false; }
  });
}
/* Labels straight from a purchase: every item that arrived goes on the label list, one label per piece. */
function labelsForPurchase(p) {
  let n = 0;
  for (const l of p.lines) {
    const count = Math.max(0, Math.ceil(l.qty)); if (!count || !S.items.has(l.code)) continue;
    const q = S.labelQ.find(x => x.code === l.code);
    if (q) q.count += count; else S.labelQ.push({ code: l.code, count });
    n += count;
  }
  saveQ();
  if (!n) { toast('Nothing to print labels for.'); return; }
  toast(`${n} labels added to the label list`);
  openLabelList();
}
async function openPurchase(id) {
  let p; try { p = await rpc('purchases.get', id); } catch (err) { toast(err.message, { err: true }); return; }
  const m = openModal(`<h2>Purchase ${esc(p.purchase_no)}${p.cancelled ? ' <span class="chip out">Cancelled</span>' : ''}</h2>
    <p class="muted">${esc(fmtTime(p.created_at))} · ${esc(p.supplier || 'No supplier')}${p.supplier_bill ? ' · bill ' + esc(p.supplier_bill) : ''}${p.bill_date ? ' · dated ' + esc(p.bill_date.split('-').reverse().join('/')) : ''} · entered by ${esc(p.staff || '—')}</p>
    <div class="tablewrap" style="max-height:45vh"><table class="grid"><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Cost</th><th class="r">Amount</th></tr></thead>
      <tbody>${p.lines.map(l => `<tr><td>${esc(l.name)}<div class="muted small num">${esc(l.code)}</div></td><td class="r num">${qf(l.qty)} ${esc(l.unit)}</td><td class="r num">${money(l.cost)}</td><td class="r num">${money(l.amount)}</td></tr>`).join('')}</tbody></table></div>
    <p>Total <b class="num">${money(p.total)}</b>${p.paid ? ` · paid now <b class="num">${money(p.paid)}</b> ${esc(MODEN[p.paid_mode] || '')}` : ''}${p.note ? ' · ' + esc(p.note) : ''}</p>
    <div class="err" id="opErr"></div>
    <div class="confirmbar" id="opConfirm" hidden><span>Cancel this purchase? Its stock is taken back out and the supplier’s balance goes down.</span><button type="button" class="btn" id="opNo">Keep</button><button type="button" class="btn danger" id="opYes">Cancel purchase</button></div>
    <div class="foot">${p.cancelled ? '' : '<button type="button" class="btn danger left" id="opCancel">Cancel purchase</button>'}<button type="button" class="btn" data-close>Close</button>${p.cancelled ? '' : '<button type="button" class="btn accent" id="opLabels">Print labels for these items</button>'}</div>`, { wide: true });
  $('#opLabels', m)?.addEventListener('click', () => { m._onClose = null; closeModal(m); labelsForPurchase(p); });
  $('#opCancel', m)?.addEventListener('click', () => { $('#opConfirm', m).hidden = false; });
  $('#opNo', m)?.addEventListener('click', () => { $('#opConfirm', m).hidden = true; });
  $('#opYes', m)?.addEventListener('click', async () => { try { await rpc('purchases.cancel', p.id); await reloadItems(); closeModal(m); toast('Purchase cancelled, stock taken back out'); renderPurchases(); } catch (err) { $('#opErr', m).textContent = err.message; } });
}
async function openSupplier(id) {
  let s; try { s = await rpc('suppliers.get', id); } catch (err) { toast(err.message, { err: true }); return; }
  const m = openModal(`<h2>${esc(s.name)} ${s.balance > 0 ? `<span class="chip low">you owe ${money(s.balance)}</span>` : s.balance < 0 ? `<span class="chip ok">advance ${money(-s.balance)}</span>` : '<span class="chip ok">settled</span>'}</h2>
    <p class="muted">${esc(s.phone || 'No phone')}${s.gstin ? ' · GSTIN ' + esc(s.gstin) : ''}${+s.opening ? ' · opening balance ' + money(s.opening) : ''}</p>
    <div class="tablewrap" style="max-height:52vh"><table class="grid"><thead><tr><th>Date</th><th>What</th><th class="r">Bought</th><th class="r">Paid</th><th class="r">You owe</th><th></th></tr></thead>
      <tbody>${s.statement.map(r => `<tr class="${r.cancelled ? 'cx' : ''}${r.kind === 'purchase' ? ' click' : ''}" ${r.kind === 'purchase' ? `data-pid="${r.id}"` : ''}><td>${esc(fmtTime(r.at))}</td>
        <td>${r.kind === 'purchase' ? `Purchase <b class="num">${esc(r.ref)}</b>${r.note ? ' · bill ' + esc(r.note) : ''}` : `Payment ${esc(MODEN[r.ref] || r.ref)}${r.note ? ' · ' + esc(r.note) : ''}`}${r.cancelled ? ' <span class="chip out">cancelled</span>' : ''}</td>
        <td class="r num">${r.kind === 'purchase' ? money(r.amount) : ''}</td><td class="r num">${r.kind === 'payment' ? money(r.amount) : r.paid ? money(r.paid) : ''}</td><td class="r num">${money(r.balance)}</td>
        <td>${r.kind === 'payment' && !r.cancelled ? `<button type="button" class="btn sm" data-undo="${r.id}">Undo</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6"><div class="empty">No purchases or payments yet.</div></td></tr>'}</tbody></table></div>
    <div class="err" id="osErr"></div>
    <div class="foot"><button type="button" class="btn left" id="osEdit">Edit details</button><button type="button" class="btn" data-close>Close</button><button type="button" class="btn accent" id="osPay">Pay supplier</button></div>`, { wide: true });
  $('#osPay', m).addEventListener('click', () => { m._onClose = null; closeModal(m); paySupplier(s.id); });
  $('#osEdit', m).addEventListener('click', () => { m._onClose = null; closeModal(m); editSupplier(s); });
  m.querySelector('tbody').addEventListener('click', async e => {
    const u = e.target.closest('[data-undo]');
    if (u) { try { await rpc('suppliers.cancelPay', +u.dataset.undo); m._onClose = null; closeModal(m); openSupplier(s.id); renderPurchases(); } catch (err) { $('#osErr', m).textContent = err.message; } return; }
    const tr = e.target.closest('tr[data-pid]'); if (tr) openPurchase(+tr.dataset.pid);
  });
}
async function paySupplier(id) {
  let s; try { s = await rpc('suppliers.get', id); } catch (err) { toast(err.message, { err: true }); return; }
  const m = openModal(`<h2>Pay ${esc(s.name)}</h2><p>You owe <b class="num">${money(Math.max(0, s.balance))}</b></p>
    <div class="form2"><label class="f"><span>Amount paid ₹</span><input type="number" step="any" id="spAmt" value="${s.balance > 0 ? s.balance : ''}"></label>
      <label class="f"><span>Paid by</span><select id="spMode">${['cash', 'upi', 'bank', 'card'].map(k => `<option value="${k}">${MODEN[k]}</option>`).join('')}</select></label>
      <label class="f w"><span>Note</span><input type="text" id="spNote" placeholder="e.g. cheque no., UTR"></label></div>
    <div class="err" id="spErr"></div>
    <div class="foot"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn accent" id="spGo">Save payment</button></div>`);
  setTimeout(() => { $('#spAmt', m).focus(); $('#spAmt', m).select(); }, 30);
  $('#spGo', m).addEventListener('click', async () => { try { const r = await rpc('suppliers.pay', s.id, $('#spAmt', m).value, $('#spMode', m).value, $('#spNote', m).value); closeModal(m); toast(`Saved. You now owe ${r.name} ${money(Math.max(0, r.balance))}.`); renderPurchases(); } catch (err) { $('#spErr', m).textContent = err.message; } });
}
function editSupplier(s) {
  const m = openModal(`<h2>${s ? 'Edit supplier' : 'Add supplier'}</h2>
    <div class="form2"><label class="f w"><span>Name</span><input type="text" id="esName" value="${esc(s?.name || '')}"></label>
      <label class="f"><span>Phone</span><input type="tel" id="esPhone" value="${esc(s?.phone || '')}"></label><label class="f"><span>GSTIN</span><input type="text" id="esGst" value="${esc(s?.gstin || '')}"></label>
      <label class="f w"><span>Address</span><input type="text" id="esAddr" value="${esc(s?.address || '')}"></label>
      <label class="f"><span>Opening balance ₹ (what you owed before)</span><input type="number" step="any" id="esOpen" value="${s ? s.opening || '' : ''}" placeholder="0"></label></div>
    <div class="err" id="esErr"></div>
    <div class="foot"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn accent" id="esGo">Save</button></div>`);
  setTimeout(() => $('#esName', m).focus(), 30);
  $('#esGo', m).addEventListener('click', async () => { try { await rpc('suppliers.save', s ? s.id : null, { name: $('#esName', m).value, phone: $('#esPhone', m).value, gstin: $('#esGst', m).value, address: $('#esAddr', m).value, opening: $('#esOpen', m).value }); closeModal(m); toast('Supplier saved'); pur.tab = 'suppliers'; renderPurchases(); } catch (err) { $('#esErr', m).textContent = err.message; } });
}

/* ================= change log ================= */
const ACT = {
  'item.add': 'Item added', 'item.edit': 'Item changed', 'item.remove': 'Item removed', 'stock.in': 'Stock added / adjusted', 'items.import': 'Items imported',
  'bill.price': 'Bill with changed rate / discount', 'bill.cancel': 'Bill cancelled', 'bill.return': 'Items returned',
  'payment.receive': 'Udhaar payment received', 'payment.cancel': 'Udhaar payment undone', 'customer.add': 'Customer added', 'customer.edit': 'Customer changed',
  'purchase.save': 'Purchase entered', 'purchase.cancel': 'Purchase cancelled', 'supplier.add': 'Supplier added', 'supplier.edit': 'Supplier changed', 'supplier.pay': 'Supplier paid', 'supplier.pay.cancel': 'Supplier payment undone',
  settings: 'Settings changed', 'owner.pin': 'Owner PIN changed', 'owner.unlock': 'Owner PIN used', 'owner.pin.wrong': 'Wrong owner PIN', signin: 'Signed in', signout: 'Signed out', 'signin.failed': 'Sign-in failed',
};
const logq = { range: 'week', who: '', action: '', text: '' };
async function renderLog() {
  const el = $('#v-log');
  const d = new Date(), t = ymd(d); let from = t;
  if (logq.range === 'week') { const f = new Date(); f.setDate(f.getDate() - 6); from = ymd(f); } else if (logq.range === 'month') { const f = new Date(); f.setDate(f.getDate() - 30); from = ymd(f); } else if (logq.range === 'all') from = '';
  let res; try { res = await rpc('audit.list', { from, to: t, who: logq.who, action: logq.action, text: logq.text }); } catch (err) { toast(err.message, { err: true }); return; }
  const groups = [['', 'Everything'], ['item', 'Items & prices'], ['stock', 'Stock'], ['bill', 'Bills, discounts, returns'], ['payment', 'Udhaar payments'], ['purchase', 'Purchases'], ['supplier', 'Suppliers'], ['settings', 'Settings'], ['owner', 'Owner PIN'], ['sign', 'Sign-ins']];
  el.innerHTML = `<div class="page">
    <div class="ph"><h1>Change log</h1><div class="toolbar"><button type="button" class="btn" id="lgExp">Export CSV</button></div></div>
    <p class="muted small" style="margin:0">Every change made on this laptop: who did it, when, and what changed. It can’t be edited or deleted.</p>
    <div class="toolbar">
      <div class="seg" id="lgRange">${[['today', 'Today'], ['week', '7 days'], ['month', '30 days'], ['all', 'All']].map(([k, l]) => `<button type="button" data-r="${k}" aria-pressed="${logq.range === k}">${l}</button>`).join('')}</div>
      <select id="lgWho" style="width:auto"><option value="">Everyone</option>${res.people.map(p => `<option${p === logq.who ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select>
      <select id="lgAct" style="width:auto">${groups.map(([k, l]) => `<option value="${k}"${k === logq.action ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <input type="search" id="lgText" placeholder="Search item, bill no, customer…" value="${esc(logq.text)}"></div>
    <div class="tablewrap"><table class="grid">${!res.rows.length ? '<tbody><tr><td><div class="empty"><b>Nothing here</b>Changes will be listed as they happen.</div></td></tr></tbody>' : `
      <thead><tr><th style="width:130px">When</th><th style="width:140px">Who</th><th style="width:220px">What</th><th>Details</th></tr></thead>
      <tbody>${res.rows.map(r => `<tr class="${/cancel|remove|wrong|failed/.test(r.action) ? 'warnrow' : ''}"><td>${esc(fmtTime(r.at))}</td><td><b>${esc(r.who)}</b></td><td>${esc(ACT[r.action] || r.action)}${r.ref ? ` <span class="muted">· ${esc(r.ref)}</span>` : ''}</td><td class="small">${esc(r.detail)}</td></tr>`).join('')}</tbody>`}</table></div></div>`;
  $('#lgRange').addEventListener('click', e => { const b = e.target.closest('[data-r]'); if (b) { logq.range = b.dataset.r; renderLog(); } });
  $('#lgWho').addEventListener('change', e => { logq.who = e.target.value; renderLog(); });
  $('#lgAct').addEventListener('change', e => { logq.action = e.target.value; renderLog(); });
  $('#lgText').addEventListener('change', e => { logq.text = e.target.value.trim(); renderLog(); });
  $('#lgExp').addEventListener('click', () => saveCsv(`nrrl-change-log-${today()}.csv`, [['When', 'Who', 'What', 'Ref', 'Details'], ...res.rows.map(r => [r.at, r.who, ACT[r.action] || r.action, r.ref, r.detail])]));
}

/* ================= settings ================= */
async function renderSettings() {
  const s = S.settings;
  const [info, backups, sizes] = await Promise.all([rpc('app.info'), rpc('backup.list').catch(() => []), rpc('labels.sizes').catch(() => ({ list: [], active: '' }))]);
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
      <div class="form2" style="margin-top:4px">
        <label class="f"><span>“Save &amp; print” prints</span><select id="s_bill_format"><option value="thermal"${s.bill_format !== 'a4' ? ' selected' : ''}>Thermal receipt</option><option value="a4"${s.bill_format === 'a4' ? ' selected' : ''}>A4 invoice</option></select></label>
        <label class="f"><span>A4 printer</span><select id="s_a4_printer">${opt(s.a4_printer).replace('Windows default printer', 'Ask each time (Windows print window)')}</select></label>
        <label class="f"><span>Bill PDF for WhatsApp</span><select id="s_pdf_format"><option value="a4"${s.pdf_format !== 'thermal' ? ' selected' : ''}>A4 invoice</option><option value="thermal"${s.pdf_format === 'thermal' ? ' selected' : ''}>Receipt size</option></select></label>
        <label class="f"><span>WhatsApp on this laptop</span><select id="s_wa_mode"><option value="app"${s.wa_mode !== 'web' ? ' selected' : ''}>WhatsApp app</option><option value="web"${s.wa_mode === 'web' ? ' selected' : ''}>WhatsApp Web (browser)</option></select></label>
        <label class="f w"><span>Terms printed on A4 invoices (optional)</span><textarea id="s_invoice_terms" rows="2" placeholder="e.g. Goods once sold will be exchanged within 7 days with bill.">${esc(s.invoice_terms)}</textarea></label>
      </div>
      <div class="toolbar"><button type="button" class="btn" id="testPrint">Print test receipt</button><button type="button" class="btn" id="prevPrint">Preview</button><button type="button" class="btn" id="prevA4">Preview A4</button><button type="button" class="btn" id="refPrinters">Refresh printer list</button></div></section>
    <section class="card"><h2>Barcode labels</h2>
      <p class="muted">For items without a barcode: click <b>Make code</b> on the item, then print labels and stick them on the packet or bin.</p>
      <div><div class="lbl" style="margin-bottom:6px">Label sizes — click one to use and adjust it</div>
        <div class="sizes" id="sizeList">${sizes.list.map(z => `<button type="button" data-size="${esc(z.id)}" aria-pressed="${z.id === sizes.active}"><b>${+z.w} × ${+z.h} mm</b><small>${+z.across} across${z.id === sizes.active ? ' · in use' : ''}</small></button>`).join('')}
          <button type="button" data-size="new"><b>+ Add size</b><small>another roll</small></button></div>
        <div class="form2" id="newSize" hidden style="margin-top:10px">
          <label class="f"><span>Width (mm)</span><input type="number" step="0.5" id="nzW" placeholder="50"></label>
          <label class="f"><span>Height (mm)</span><input type="number" step="0.5" id="nzH" placeholder="25"></label>
          <label class="f"><span>Labels across</span><select id="nzA">${[1, 2, 3, 4].map(n => `<option>${n}</option>`).join('')}</select></label>
          <div class="f" style="justify-content:flex-end;flex-direction:row;gap:8px;align-items:flex-end"><button type="button" class="btn" id="nzCancel">Cancel</button><button type="button" class="btn accent" id="nzAdd">Add size</button></div>
        </div>
        ${sizes.list.length > 1 ? '<div class="toolbar" style="margin-top:8px"><button type="button" class="btn sm danger" id="sizeDel">Remove the size in use</button></div>' : ''}
      </div>
      <div><div class="lbl" style="margin-bottom:6px">Shop logo on labels</div>
        <div class="logo-prev"><div class="box">${s.label_logo ? `<img src="${s.label_logo}" alt="Logo">` : '<span class="muted small">No logo</span>'}</div>
          <div class="toolbar"><button type="button" class="btn" id="logoPick">${s.label_logo ? 'Change logo…' : 'Add logo…'}</button>${s.label_logo ? '<button type="button" class="btn danger" id="logoDel">Remove</button>' : ''}</div></div>
        ${s.label_logo ? `<div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:8px"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="s_label_show_logo" ${s.label_show_logo !== '0' ? 'checked' : ''}> Print logo on labels</label>
          <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="s_label_logo_invert" ${s.label_logo_invert === '1' ? 'checked' : ''}> Logo prints as a negative (direct printing only) — tick to fix</label></div>` : ''}
        <p class="muted small">A PNG or JPG of your logo. It is turned into black and white for the label printer; you can adjust how dark it comes out.</p>
      </div>
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
        <label class="f"><span>Rate size on labels</span>${rateSel('s_label_rate_size', s.label_rate_size)}</label>
        <p class="muted small" style="align-self:end">Bigger rates are easier to read; the barcode gets a little shorter. Use <b>Preview one row</b> to check.</p>
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
      <p class="muted">${S.auth.linked ? 'This laptop is linked, so everyone signs in with their own phone-app PIN and you choose what each person can do in the phone app’s <b>Staff</b> tab. Your PIN there also unlocks this laptop. A separate laptop PIN below is optional.' : 'With a PIN set, staff can bill and add new items, but these need the PIN: changing prices or rates, editing or removing items, adding stock, cancelling bills, sales older than today, and Settings. Link the phone app (above) to give each person their own PIN and switches.'}</p>
      <div class="form2">
        ${s.hasPin ? '<label class="f"><span>Current PIN</span><input type="password" id="pOld" inputmode="numeric" maxlength="8"></label>' : ''}
        <label class="f"><span>${s.hasPin ? 'New PIN (blank = remove PIN)' : 'New PIN (4–8 digits)'}</span><input type="password" id="pNew" inputmode="numeric" maxlength="8"></label>
      </div>
      <div class="err" id="pErr"></div>
      <div class="toolbar"><button type="button" class="btn" id="pSave">${s.hasPin ? 'Change PIN' : 'Set PIN'}</button></div></section>
    </div>
    <div class="toolbar" style="position:sticky;bottom:0;padding:14px 0 0;background:var(--bg);margin-top:14px"><button type="button" class="btn primary big" id="sSave" style="min-width:220px">Save settings</button><span class="muted small" id="sMsg"></span><span class="muted small" style="margin-left:auto">NRRL Billing v${esc(info.version)}</span></div>
  </div>`;
  const keys = ['shop_name', 'shop_address', 'shop_phone', 'gstin', 'footer', 'bill_prefix', 'next_bill', 'printer', 'paper', 'copies', 'print_margin', 'font_size', 'label_printer', 'label_w', 'label_h', 'low_stock', 'label_across', 'label_gap', 'label_dpi', 'label_bar', 'label_shift', 'label_mode', 'label_vgap', 'label_density', 'label_rate_size', 'bill_format', 'a4_printer', 'pdf_format', 'wa_mode', 'invoice_terms', 'wcode_prefix', 'wcode_mult'];
  const collect = () => {
    const o = {}; for (const k of keys) o[k] = $('#s_' + k).value;
    if ($('#s_label_show_logo')) { o.label_show_logo = $('#s_label_show_logo').checked ? '1' : '0'; o.label_logo_invert = $('#s_label_logo_invert').checked ? '1' : '0'; }
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
  $('#prevA4').addEventListener('click', async () => { if (!(await save(true))) return; const html = await rpc('print.a4preview', 'sample'); openModal(`<h2>A4 invoice preview</h2><div style="display:flex;justify-content:center;background:var(--sunk);border-radius:8px;padding:12px;overflow:auto"><iframe title="A4 preview" sandbox srcdoc="${esc(html)}" style="border:0;width:794px;height:70vh;background:#fff"></iframe></div><div class="foot"><button type="button" class="btn" data-close>Close</button></div>`, { wide: true }); });
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
  $('#sizeList').addEventListener('click', async e => {
    const b = e.target.closest('[data-size]'); if (!b) return;
    if (b.dataset.size === 'new') { $('#newSize').hidden = false; $('#nzW').focus(); return; }
    if (!(await save(true))) return;
    try { S.settings = await rpc('labels.useSize', b.dataset.size); renderSettings(); toast('Label size changed'); } catch (err) { toast(err.message, { err: true }); }
  });
  $('#nzCancel').addEventListener('click', () => { $('#newSize').hidden = true; });
  $('#nzAdd').addEventListener('click', async () => {
    if (!(await save(true))) return;
    try { S.settings = await rpc('labels.addSize', { w: $('#nzW').value, h: $('#nzH').value, across: $('#nzA').value }); renderSettings(); toast('Label size added and in use'); } catch (err) { toast(err.message, { err: true }); }
  });
  $('#sizeDel')?.addEventListener('click', async () => {
    try { S.settings = await rpc('labels.removeSize', sizes.active); renderSettings(); toast('Label size removed'); } catch (err) { toast(err.message, { err: true }); }
  });
  $('#logoPick').addEventListener('click', async () => { if (!(await save(true))) return; pickLogo(); });
  $('#logoDel')?.addEventListener('click', async () => { S.settings = await rpc('labels.setLogo', '', null); renderSettings(); toast('Logo removed'); });
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
    el.innerHTML = `<p>Linked as <b>${esc(st.code || 'laptop')}</b>${st.prefix ? ` · this laptop's bills are numbered <b>${esc(st.prefix)}1, ${esc(st.prefix)}2…</b>` : ''}. This laptop, other linked laptops and the phone app share one item list, stock and sales. Changes on either side show on the other within about 15 seconds.</p>
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
      <div class="toolbar"><button type="button" class="btn accent" id="shNow">Send now</button><button type="button" class="btn" id="shKey">Copy key for another laptop</button><button type="button" class="btn danger" id="shOff">Disconnect</button></div>
      <p class="muted small">To connect another laptop to the same sheet: on that laptop paste the same Web app link and this key.</p>
      <div class="confirmbar" id="shConfirm" hidden><span>Stop sending to the Google Sheet? What’s already in the sheet stays there.</span><button type="button" class="btn" id="shNo">Keep</button><button type="button" class="btn danger" id="shYes">Disconnect</button></div>`;
    $('#shKey').addEventListener('click', async () => { try { await rpc('clipboard.write', await rpc('sync.key')); toast('Key copied. Paste it on the other laptop.'); } catch (e) { toast(e.message, { err: true }); } });
    $('#shNow').addEventListener('click', async () => { $('#shNow').disabled = true; try { await rpc('sync.now'); } catch (e) {} renderSheetCard(); });
    $('#shOff').addEventListener('click', () => { $('#shConfirm').hidden = false; });
    $('#shNo').addEventListener('click', () => { $('#shConfirm').hidden = true; });
    $('#shYes').addEventListener('click', async () => { await rpc('sync.disconnect'); toast('Disconnected from Google Sheet'); renderSheetCard(); });
    return;
  }
  el.innerHTML = `<div class="confirmbar" style="background:var(--accent-soft);margin-bottom:12px"><span><b>Second laptop?</b> If the sheet is already set up on another laptop, skip steps 1–4: paste the same Web app link below, and the key from that laptop (Settings → Google Sheet → Copy key, or the KEY line at the top of the Apps Script).</span></div>
    <p class="muted">First laptop: one-time setup, about 5 minutes.</p>
    <ol style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px">
      <li><button type="button" class="btn" id="shCopy">Copy setup script</button></li>
      <li>Open <a href="https://sheets.new" target="_blank" rel="noopener">sheets.new</a> (a new Google Sheet). Name it <b>NRRL Sales</b>.</li>
      <li>In the sheet: <b>Extensions → Apps Script</b>. Delete what’s there, paste (Ctrl+V), click <b>Save</b>.</li>
      <li>Click <b>Deploy → New deployment</b> → gear icon → <b>Web app</b>. Set <b>Execute as: Me</b> and <b>Who has access: Anyone</b>. Click <b>Deploy</b>, then <b>Authorize access</b>. If Google says the app isn’t verified, click <b>Advanced → Go to … (unsafe) → Allow</b>. It’s your own script.</li>
      <li>Copy the <b>Web app URL</b> (ends with /exec) and paste it here:</li>
    </ol>
    <div style="display:flex;gap:8px"><input type="text" id="shUrl" placeholder="https://script.google.com/macros/s/…/exec" spellcheck="false"><button type="button" class="btn accent" id="shGo">Connect</button></div>
    <label class="f"><span>Key — only for a second laptop</span><input type="text" id="shKeyIn" placeholder="Leave blank on the first laptop" spellcheck="false"></label>
    <p class="err" id="shErr"></p>`;
  $('#shCopy').addEventListener('click', async () => {
    try { await rpc('clipboard.write', await rpc('sync.script')); toast('Setup script copied. Paste it into Apps Script.'); $('#shCopy').textContent = 'Copied ✓'; }
    catch (e) { toast(e.message, { err: true }); }
  });
  $('#shGo').addEventListener('click', async () => {
    $('#shErr').textContent = ''; $('#shGo').disabled = true; $('#shGo').textContent = 'Checking…';
    try { const r = await rpc('sync.connect', $('#shUrl').value, $('#shKeyIn').value); toast(`Connected. Sending ${r.queued} past bills to the sheet.`); renderSheetCard(); }
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
  if (ch.staff) {
    const had = S.auth.user, before = JSON.stringify(had && [had.role, had.perms]);
    await loadAuth();
    if (had) {
      const me = await rpc('auth.refresh').catch(() => null);
      if (!me) { signOut(`${had.name} was blocked by the owner.`); return; }
      S.auth.user = me;
      if (before !== JSON.stringify([me.role, me.perms])) { toast('Your access was changed by the owner'); renderLock(); buildBill(); refreshView(); }
    } else if (needSignIn()) showSignIn();
  }
});
async function init() {
  try {
    S.settings = await rpc('settings.get');
    await reloadItems();
    S.lastBill = await rpc('bills.last').catch(() => null);
  } catch (err) { document.body.innerHTML = `<div class="empty"><b>NRRL Billing could not start</b>${esc(err.message)}</div>`; return; }
  // keep cart lines in sync with any price changes since last time
  for (const l of S.cart.lines) { const it = S.items.get(l.code); if (it) { l.name = it.name; l.unit = unitFor(it); l.gst = it.gst; if (l.listRate !== false) l.rate = priceFor(it); } }
  await loadAuth();
  loadCustNames();
  buildBill(); renderLock(); renderBackupState();
  if (needSignIn()) showSignIn();
  setInterval(renderBackupState, 5 * 60e3);
  window.addEventListener('focus', () => focusScan());
  show('bill');
}
init();
})();

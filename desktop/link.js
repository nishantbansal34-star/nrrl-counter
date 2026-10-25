// NRRL Billing — keeps this laptop and the NRRL Counter phone app on one shared item list, stock and sales.
// Laptop changes wait in a queue (nothing is lost offline) and are sent first; then phone changes are pulled in.
'use strict';
const os = require('os');

const SUPA = { url: 'https://nbsrlpubmukksdpusxpx.supabase.co', key: 'sb_publishable_-b7urbpGemxGRtC-__5cyw_LB1j3lRR' };
const ERR = {
  BAD_PIN: 'Wrong PIN.', LOCKED: 'Too many wrong PINs. Wait 10 minutes.', OWNER_ONLY: 'Only an owner can link a laptop.',
  DEVICE_UNLINKED: 'This laptop was unlinked. Link it again in Settings.', SESSION_EXPIRED: 'Please try again.',
  CART_GONE: 'That bill was already saved or closed.', CANT_BILL: 'That person can’t make bills (switched off, or blocked).', NO_ACCESS: 'You don’t have access to this.',
};

async function rpc(fn, args) {
  let res;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    res = await fetch(`${SUPA.url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPA.key }, body: JSON.stringify(args), signal: ctrl.signal });
  } catch (e) { throw Object.assign(new Error('No internet connection.'), { net: true }); }
  finally { clearTimeout(t); }
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) {}
  if (!res.ok) {
    const code = (data && data.message) || ('Server error ' + res.status);
    throw Object.assign(new Error(ERR[code] || code), { code, net: res.status >= 500 });
  }
  if (data && typeof data === 'object' && !Array.isArray(data) && data.error) throw Object.assign(new Error(ERR[data.error] || data.error), { code: data.error });
  return data;
}

function createLink(getStore, onChange) {
  const state = { busy: false, lastOk: null, lastError: '' };
  let timer = null;

  // One change the server keeps refusing (not a connection problem) must not hold up everything behind it:
  // after 5 refusals it is set aside, written to the change log, and the rest carry on.
  const GIVE_UP = 5;
  function setAside(st, rows, e) {
    st.linkDone(rows.map(x => x.id));
    for (const x of rows) { st.who = 'Sync'; st.audit('sync.failed', x.kind, `${e.message} · ${x.payload.slice(0, 300)}`); }
    state.setAside = (state.setAside || 0) + rows.length;
  }
  async function sendOne(key, r) {
    const p = JSON.parse(r.payload);
    if (r.kind === 'item') return rpc('counter_dev_items_put', { p_key: key, p_items: [p], p_force_stock: false });
    if (r.kind === 'bill') return rpc('counter_dev_bill_push', { p_key: key, p_bill: p });
    if (r.kind === 'cancel') return rpc('counter_dev_bill_cancel', { p_key: key, p_bill_no: p.bill_no });
    if (r.kind === 'stock') return rpc('counter_dev_stock_add', { p_key: key, p_code: p.code, p_delta: p.delta });
  }
  async function pushQueue(st, key) {
    for (let round = 0; round < 40; round++) {
      const rows = st.linkPeek(50);
      if (!rows.length) return;
      // send runs of item changes together, everything else one by one, in order
      let i = 0;
      while (i < rows.length) {
        const r = rows[i];
        if (r.kind === 'item') {
          const run = [];
          while (i < rows.length && rows[i].kind === 'item') run.push(rows[i++]);
          try { await rpc('counter_dev_items_put', { p_key: key, p_items: run.map(x => JSON.parse(x.payload)), p_force_stock: false }); st.linkDone(run.map(x => x.id)); }
          catch (e) {
            if (e.net || run.length === 1) { st.linkFail(run.map(x => x.id), e.message); if (!e.net && run[0].tries + 1 >= GIVE_UP) { setAside(st, run, e); continue; } throw e; }
            // the batch was refused: send them one at a time to find the one at fault
            for (const x of run) {
              try { await sendOne(key, x); st.linkDone([x.id]); }
              catch (e2) { st.linkFail([x.id], e2.message); if (e2.net) throw e2; if (x.tries + 1 >= GIVE_UP) setAside(st, [x], e2); }
            }
          }
          continue;
        }
        try { await sendOne(key, r); st.linkDone([r.id]); }
        catch (e) {
          st.linkFail([r.id], e.message);
          if (!e.net && r.tries + 1 >= GIVE_UP) { setAside(st, [r], e); i++; continue; }
          throw e;
        }
        i++;
      }
    }
  }
  async function pull(st, key) {
    const since = st.getSetting('link_items_at') || null;
    const r = await rpc('counter_dev_items_since', { p_key: key, p_since: since });
    let changed = 0;
    if (st.linkCount() === 0) { // never overwrite a laptop change that hasn't been sent yet
      changed = st.applyRemoteItems(r.items || []);
      st.setSetting('link_items_at', r.now);
    }
    let after = parseInt(st.getSetting('link_bills_after'), 10) || 0, newBills = 0;
    for (let round = 0; round < 20; round++) {
      const bills = await rpc('counter_dev_bills_since', { p_key: key, p_after: after });
      if (!bills.length) break;
      newBills += st.importPhoneBills(bills);
      after = Math.max(after, ...bills.map(b => +b.id));
      st.setSetting('link_bills_after', String(after));
      if (bills.length < 500) break;
    }
    // bills cancelled on the phone app or another laptop after they were copied here
    let voided = 0;
    if (state.voidedOk !== false) {
      try {
        const v = await rpc('counter_dev_bills_voided', { p_key: key, p_since: st.getSetting('link_voided_at') || null });
        voided = st.markRemoteCancelled(v.bills || []);
        st.setSetting('link_voided_at', v.now);
      } catch (e) { if (e.net) throw e; if (/counter_dev_bills_voided|PGRST202|Could not find|404/i.test(String(e.message) + String(e.code))) state.voidedOk = false; }
    }
    if (changed || newBills || voided) onChange({ items: changed, bills: newBills, voided });
  }
  // give each laptop its own bill numbers (L2-1, L2-2…) so two laptops never clash
  function useCode(st, code) {
    st.setSetting('link_code', code || '');
    if (code && code !== 'L1' && !st.getSetting('bill_prefix')) st.setSetting('bill_prefix', code + '-');
  }
  let lastStaff = 0;
  async function syncStaff(st, key) {
    const before = st.getSetting('staff_cache');
    st.cacheStaff(await rpc('counter_dev_staff', { p_key: key }));
    lastStaff = Date.now();
    if (before !== st.getSetting('staff_cache')) onChange({ staff: true });
  }
  async function tick() {
    const st = getStore();
    if (!st || state.busy) return;
    const key = st.getSetting('link_key');
    if (!key) return;
    state.busy = true;
    try {
      if (!st.getSetting('link_code')) { try { useCode(st, (await rpc('counter_dev_info', { p_key: key })).code); } catch (e) { if (e.code === 'DEVICE_UNLINKED') throw e; } }
      await pushQueue(st, key);
      await pull(st, key);
      if (Date.now() - lastStaff > 30000) await syncStaff(st, key);
      state.lastOk = new Date().toISOString(); state.lastError = '';
    } catch (e) {
      state.lastError = e.message;
      if (e.code === 'DEVICE_UNLINKED') { st.setSetting('link_key', ''); st.linkClear(); }
    } finally { state.busy = false; }
  }

  return {
    start() { if (!timer) timer = setInterval(() => tick().catch(() => {}), 10000); setTimeout(() => tick().catch(() => {}), 2000); },
    soon() { setTimeout(() => tick().catch(() => {}), 300); },
    tick,
    status() { const st = getStore(); return { linked: !!st.getSetting('link_key'), name: st.getSetting('link_name'), code: st.getSetting('link_code'), prefix: st.getSetting('bill_prefix'), setAside: state.setAside || 0, pending: st.linkCount(), lastOk: state.lastOk, lastError: state.lastError, busy: state.busy }; },
    owners: async () => (await rpc('counter_staff_list', {})).filter(s => s.role === 'owner'),
    /* First link: log in as an owner, register this laptop, send everything the laptop has (its stock wins),
       then bring in what only the phone app has. */
    async link(staffId, pin, progress) {
      const st = getStore();
      const login = await rpc('counter_login', { p_staff: staffId, p_pin: String(pin || '') });
      const name = 'Laptop (' + os.hostname() + ') #' + String(st.getSetting('install_id')).slice(0, 6);
      const reg = await rpc('counter_device_register', { p_token: login.token, p_name: name });
      rpc('counter_logout', { p_token: login.token }).catch(() => {});
      const key = reg.key;
      const items = st.db.prepare('select code from items').all().map(r => st._itemPayload(r.code, true));
      for (let i = 0; i < items.length; i += 300) {
        progress && progress(`Sending items ${Math.min(i + 300, items.length)} of ${items.length}…`);
        await rpc('counter_dev_items_put', { p_key: key, p_items: items.slice(i, i + 300), p_force_stock: true });
      }
      const ids = st.db.prepare("select id from bills where bill_no not like 'M%' order by id").all().map(r => r.id);
      for (let i = 0; i < ids.length; i++) {
        if (i % 20 === 0) progress && progress(`Sending past bills ${i + 1} of ${ids.length}…`);
        await rpc('counter_dev_bill_push', { p_key: key, p_bill: { ...st.getBill(ids[i]), skip_stock: true } });
      }
      st.linkClear();
      st.setSetting('link_key', key); st.setSetting('link_name', name); useCode(st, reg.code);
      st.setSetting('link_items_at', ''); st.setSetting('link_bills_after', '0');
      progress && progress('Bringing in items and bills from the phone app…');
      await pull(st, key);
      try { await syncStaff(st, key); st.rememberStaffPin(staffId, pin); } catch (e) {}
      state.lastOk = new Date().toISOString(); state.lastError = '';
      return { items: items.length, bills: ids.length };
    },
    /* Sign a person in on this laptop with their phone-app PIN. Checked online when possible;
       without internet, a PIN that already worked on this laptop is accepted. */
    async staffLogin(staffId, pin) {
      const st = getStore(), key = st.getSetting('link_key');
      const cached = st.staffList().find(x => x.id === staffId);
      try {
        if (!key) throw Object.assign(new Error('offline'), { net: true });
        const r = await rpc('counter_dev_login', { p_key: key, p_staff: staffId, p_pin: String(pin || '') });
        st.rememberStaffPin(staffId, pin);
        const list = st.staffList(); const i = list.findIndex(x => x.id === r.id);
        const me = { id: r.id, name: r.name, role: r.role, active: true, perms: r.perms || {} };
        if (i >= 0) list[i] = me; else list.push(me);
        st.cacheStaff(list);
        return me;
      } catch (e) {
        if (!e.net) throw e;
        if (!cached || !cached.active) throw new Error('This person is blocked.');
        const ok = st.checkStaffPin(staffId, pin);
        if (ok === null) throw new Error('No internet. The first sign-in on this laptop needs internet; after that it works offline.');
        if (!ok) throw new Error('Wrong PIN.');
        return cached;
      }
    },
    // live bills: called for the person signed in on this laptop
    cartCall: async (fn, staffId, args) => {
      const st = getStore(), key = st.getSetting('link_key');
      if (!key) throw new Error('This laptop is not linked to the phone app.');
      return rpc(fn, { p_key: key, p_staff: staffId, ...args });
    },
    syncStaff: async () => { const st = getStore(); if (st.getSetting('link_key')) await syncStaff(st, st.getSetting('link_key')); return st.staffList(); },
    unlink() { const st = getStore(); st.setSetting('link_key', ''); st.linkClear(); },
  };
}
module.exports = { createLink };

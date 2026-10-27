// NRRL Billing — sends bills and the item list to the owner's Google Sheet.
// Everything goes through a queue in the database, so nothing is lost when the internet is down.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// the same rows on every laptop (numbers as all devices know them), so whichever laptop sends last, the tabs agree
function ledgerTables(st) {
  const at = new Date().toLocaleString('en-IN');
  const day = t => String(t || '').slice(0, 16);
  const cust = st.customers().filter(c => Math.abs(c.balance) > 0.009 || +c.opening || c.gstin);
  const pays = st.db.prepare('select p.*, c.name cname, c.phone cphone from payments p join customers c on c.id=p.customer_id order by p.created_at desc limit 20000').all();
  const rets = st.db.prepare("select r.*, (select group_concat(printf('%g', l.qty) || ' ' || l.unit || ' ' || l.name, ', ') from return_lines l where l.return_id=r.id) items from returns r order by r.created_at desc limit 20000").all();
  const purs = st.db.prepare('select * from purchases order by created_at desc limit 20000').all();
  const sups = st.suppliers();
  return [
    { type: 'table', name: 'Udhaar', at, header: ['Customer', 'Phone', 'GSTIN', 'Opening', 'Owes now', 'Last bill', 'Last payment'],
      rows: cust.map(c => [c.name, c.phone ? "'" + c.phone : '', c.gstin, c.opening, c.balance, day(c.last_bill), day(c.last_payment)]) },
    { type: 'table', name: 'Payments', at, header: ['Date', 'Customer', 'Phone', 'Amount', 'By', 'Note', 'Received by', 'Status'],
      rows: pays.map(p => ["'" + day(p.created_at), p.cname, p.cphone ? "'" + p.cphone : '', p.amount, String(p.mode).toUpperCase(), p.note, p.staff, p.cancelled ? 'Cancelled' : 'OK']) },
    { type: 'table', name: 'Returns', at, header: ['Return no', 'Date', 'Bill no', 'Customer', 'Refund', 'Amount', 'Items', 'By'],
      rows: rets.map(r => ["'" + st.gref(r.return_no), "'" + day(r.created_at), "'" + st.gref(r.bill_no), r.customer, r.refund_mode === 'account' ? 'To udhaar' : String(r.refund_mode).toUpperCase(), r.total, r.items || '', r.staff]) },
    { type: 'table', name: 'Purchases', at, header: ['Purchase no', 'Date', 'Supplier', 'Supplier bill', 'Items', 'Total', 'Paid then', 'Status'],
      rows: purs.map(p => ["'" + st.gref(p.purchase_no), "'" + day(p.created_at), p.supplier, p.supplier_bill, p.items_count, p.total, p.paid, p.cancelled ? 'Cancelled' : 'OK']) },
    { type: 'table', name: 'Suppliers', at, header: ['Supplier', 'Phone', 'GSTIN', 'Opening', 'We owe', 'Last purchase'],
      rows: sups.map(s => [s.name, s.phone ? "'" + s.phone : '', s.gstin, s.opening, s.balance, day(s.last_purchase)]) },
  ];
}

function createSync(getStore) {
  const state = { lastOk: null, lastError: '', sending: false, lastItems: 0, lastLedger: 0, oldScript: false };
  let timer = null;

  async function post(url, body) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 45000);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow', signal: ctrl.signal });
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch (e) {
        if (/<html/i.test(text)) throw new Error('The sheet link did not answer. Check that the Apps Script is deployed with access “Anyone”.');
        throw new Error('Unexpected answer from the sheet.');
      }
      if (!data.ok) {
        if (/wrong key/i.test(data.error || '')) throw new Error('Wrong key. If this sheet was set up on another laptop, paste that laptop\'s key in the Key box (on that laptop: Settings → Google Sheet → Copy key, or the KEY line at the top of the Apps Script).');
        throw new Error(data.error || 'The sheet refused the data.');
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('The sheet took too long to answer.');
      if (/fetch failed|ENOTFOUND|ECONN|network/i.test(e.message)) throw new Error('No internet connection.');
      throw e;
    } finally { clearTimeout(t); }
  }

  async function tick() {
    const st = getStore();
    if (!st || state.sending) return;
    const url = st.getSetting('sheet_url'), key = st.getSetting('sheet_key');
    if (!url) return;
    state.sending = true;
    try {
      // bills and cancellations, oldest first, 20 at a time
      for (let round = 0; round < 10; round++) {
        const rows = st.queuePeek(20);
        if (!rows.length) break;
        // a second laptop's older bills (made before it had its own prefix) get its code in the sheet, so numbers never clash
        const code = st.getSetting('link_code');
        const tag = no => (code && code !== 'L1' && !/^(M\d+|L\d+-)/.test(no)) ? code + '-' + no : no;
        const events = rows.map(r => {
          const p = JSON.parse(r.payload);
          if (r.kind === 'bill') return { type: 'bill', bill: { ...p, bill_no: tag(p.bill_no) } };
          if (r.kind === 'cancel') return { type: 'cancel', bill_no: tag(p.bill_no) };
          return null;
        }).filter(Boolean);
        try { await post(url, { key, events }); st.queueDone(rows.map(r => r.id)); }
        catch (e) { st.queueFail(rows.map(r => r.id), e.message); throw e; }
      }
      // item list with stock: at most once a minute, only after something changed
      if (st.getSetting('items_dirty') === '1' && Date.now() - state.lastItems > 60e3) {
        st.setSetting('items_dirty', '0');
        try { await post(url, { key, events: [{ type: 'items', at: new Date().toLocaleString('en-IN'), items: st.allItems() }] }); state.lastItems = Date.now(); }
        catch (e) { st.setSetting('items_dirty', '1'); throw e; }
      }
      // udhaar, payments, returns, purchases and suppliers: whole tabs, at most every 2 minutes, only after something changed
      if (st.getSetting('ledger_dirty') === '1' && Date.now() - state.lastLedger > 120e3) {
        st.setSetting('ledger_dirty', '0');
        try {
          const r = await post(url, { key, events: ledgerTables(st) });
          state.lastLedger = Date.now();
          state.oldScript = !(r && r.v >= 2); // an older Apps Script ignores these tabs
        } catch (e) { st.setSetting('ledger_dirty', '1'); throw e; }
      }
      state.lastOk = new Date().toISOString(); state.lastError = '';
    } catch (e) {
      state.lastError = e.message;
    } finally { state.sending = false; }
  }

  return {
    start() { if (!timer) timer = setInterval(() => tick().catch(() => {}), 15000); setTimeout(() => tick().catch(() => {}), 3000); },
    soon() { setTimeout(() => tick().catch(() => {}), 500); },
    tick,
    status() { const st = getStore(); return { url: st.getSetting('sheet_url'), pending: st.queueCount(), lastOk: state.lastOk, lastError: state.lastError, sending: state.sending, oldScript: state.oldScript }; },
    key() { return getStore().getSetting('sheet_key'); },
    async test(url, key) {
      const st = getStore();
      url = String(url || '').trim().replace(/\?.*$/, '');
      key = String(key || '').trim();
      if (key) st.setSetting('sheet_key', key);
      if (!st.getSetting('sheet_key')) throw new Error('Click “Copy setup script” first, or paste the key from your first laptop.');
      if (!/^https:\/\/script\.google\.com\/(a\/macros\/[^/]+|macros)\/s\/[\w-]+\/exec$/.test(url)) throw new Error('Paste the Web app link that ends with /exec.');
      await post(url, { key: st.getSetting('sheet_key'), events: [] });
      st.setSetting('sheet_url', url);
      const n = st.queueAllBills();
      st.setSetting('ledger_dirty', '1');
      setTimeout(() => tick().catch(() => {}), 200);
      return { queued: n };
    },
    disconnect() { const st = getStore(); st.setSetting('sheet_url', ''); st.db.prepare('delete from sync_queue').run(); },
    script() {
      const st = getStore();
      let key = st.getSetting('sheet_key');
      if (!key) { key = crypto.randomBytes(18).toString('base64url'); st.setSetting('sheet_key', key); }
      return fs.readFileSync(path.join(__dirname, 'sheets-script.gs'), 'utf8').replace('__KEY__', key);
    },
  };
}
module.exports = { createSync };

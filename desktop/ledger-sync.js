// NRRL Billing — sharing udhaar accounts, payments, returns, suppliers and purchases with the other laptops
// and the phone app. This laptop sends what it records (through the link queue) and copies in what the others
// recorded. Stock is NOT touched when copying: the stock change already travelled on its own.
'use strict';

const r2 = n => Math.round((+n || 0) * 100) / 100;
const p2 = n => String(n).padStart(2, '0');
const nowLocal = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
const supKey = name => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
const KIND = { payments: 'pay', returns: 'ret', purchases: 'pur', supplier_payments: 'spay' };

const syncMethods = {
  /* numbers as every device knows them: phone bills M12, a laptop's bills with its code (L1-15) */
  gref(no) {
    no = String(no || '');
    const code = this.getSetting('link_code');
    if (!code || !no || /^(M\d+|L\d+-)/.test(no)) return no;
    return code + '-' + no;
  },
  lref(ref, table = 'bills', col = 'bill_no') {
    ref = String(ref || '');
    const code = this.getSetting('link_code');
    if (code && ref.startsWith(code + '-')) {
      const rest = ref.slice(code.length + 1);
      if (this.db.prepare(`select 1 from ${table} where ${col}=?`).get(rest)) return rest;
    }
    return ref;
  },
  _uidOf(table, id) {
    const row = this.db.prepare(`select uid from ${table} where id=?`).get(id);
    if (!row) return '';
    if (row.uid) return row.uid;
    const uid = `${String(this.getSetting('install_id')).slice(0, 10)}-${KIND[table]}-${id}`;
    this.db.prepare(`update ${table} set uid=? where id=?`).run(uid, id);
    return uid;
  },
  _custPayload(id, oldKey) {
    const c = this.db.prepare('select * from customers where id=?').get(id);
    return { key: c.key, old_key: oldKey || '', name: c.name, phone: c.phone, gstin: c.gstin, address: c.address, opening: c.opening, note: c.note };
  },
  _supPayload(id, oldKey) {
    const s = this.db.prepare('select * from suppliers where id=?').get(id);
    return { key: supKey(s.name), old_key: oldKey || '', name: s.name, phone: s.phone, gstin: s.gstin, address: s.address, opening: s.opening };
  },
  _rowPayload(table, id) {
    const uid = this._uidOf(table, id);
    if (table === 'payments') {
      const p = this.db.prepare('select p.*, c.key ckey from payments p join customers c on c.id=p.customer_id where p.id=?').get(id);
      const b = p.bill_id ? this.db.prepare('select bill_no from bills where id=?').get(p.bill_id) : null;
      return { k: 'payment', d: { uid, customer_key: p.ckey, amount: p.amount, mode: p.mode, note: p.note, bill_ref: b ? this.gref(b.bill_no) : '', at: p.created_at, staff: p.staff, cancelled: !!p.cancelled } };
    }
    if (table === 'returns') {
      const r = this.getReturn(id);
      const c = r.customer_id ? this.db.prepare('select key from customers where id=?').get(r.customer_id) : null;
      return { k: 'return', d: { uid, return_no: this.gref(r.return_no), bill_ref: this.gref(r.bill_no), at: r.created_at, refund_mode: r.refund_mode, customer_key: c ? c.key : '',
        customer: r.customer, total: r.total, gst: r.gst, note: r.note, staff: r.staff, lines: r.lines } };
    }
    if (table === 'purchases') {
      const p = this.getPurchase(id);
      return { k: 'purchase', d: { uid, purchase_no: this.gref(p.purchase_no), supplier_key: supKey(p.supplier), supplier: p.supplier, supplier_bill: p.supplier_bill, bill_date: p.bill_date,
        at: p.created_at, items_count: p.items_count, total: p.total, gst: p.gst, paid: p.paid, paid_mode: p.paid_mode, note: p.note, staff: p.staff, lines: p.lines, cancelled: !!p.cancelled } };
    }
    const x = this.db.prepare('select x.*, s.name sname from supplier_payments x join suppliers s on s.id=x.supplier_id where x.id=?').get(id);
    return { k: 'spay', d: { uid, supplier_key: supKey(x.sname), amount: x.amount, mode: x.mode, note: x.note, at: x.created_at, staff: x.staff, cancelled: !!x.cancelled } };
  },
  _pushRow(table, id) { if (this.linkOn()) this.linkPush('ledger', this._rowPayload(table, id)); },
  /* first time a laptop is linked with this version: send everything it already has */
  ledgerBackfill() {
    if (!this.linkOn() || this.getSetting('ledger_sent') === '1') return 0;
    let n = 0;
    this.db.transaction(() => {
      for (const c of this.db.prepare('select id from customers order by id').all()) { this.linkPush('ledger', { k: 'customer', d: { ...this._custPayload(c.id), only_new: true } }); n++; }
      for (const s of this.db.prepare('select id from suppliers order by id').all()) { this.linkPush('ledger', { k: 'supplier', d: { ...this._supPayload(s.id), only_new: true } }); n++; }
      for (const t of ['payments', 'returns', 'purchases', 'supplier_payments']) {
        for (const r of this.db.prepare(`select id from ${t} where uid is null or uid like ? order by id`).all(String(this.getSetting('install_id')).slice(0, 10) + '-%')) { this.linkPush('ledger', this._rowPayload(t, r.id)); n++; }
      }
      this.setSetting('ledger_sent', '1');
    })();
    return n;
  },
  _custByKey(key, name, phone) {
    let c = this.db.prepare('select * from customers where key=?').get(key);
    if (!c) {
      const id = this.db.prepare('insert into customers(key,name,phone,created_at) values(?,?,?,?)').run(key, String(name || key.replace(/^[pn]:/, '')).slice(0, 120), String(phone || '').slice(0, 20), nowLocal()).lastInsertRowid;
      c = this.db.prepare('select * from customers where id=?').get(id);
    }
    return c;
  },
  _supByKey(key, name) {
    const s = this.db.prepare('select * from suppliers').all().find(x => supKey(x.name) === key);
    if (s) return s;
    const id = this.db.prepare('insert into suppliers(name,created_at) values(?,?)').run(String(name || key).slice(0, 120), nowLocal()).lastInsertRowid;
    return this.db.prepare('select * from suppliers where id=?').get(id);
  },
  _freeNo(table, col, no) { let x = no, i = 2; while (this.db.prepare(`select 1 from ${table} where ${col}=?`).get(x)) x = `${no}#${i++}`; return x; },
  /* records from the server, oldest first. Returns how far it got (a return whose bill hasn't arrived yet waits). */
  applyLedger(list) {
    let applied = 0, upto = null;
    const has = (t, uid) => this.db.prepare(`select * from ${t} where uid=?`).get(uid);
    const WAIT = new Error('wait');
    for (const ev of list) {
      try { this.db.transaction(() => {
        const r = ev.r || {};
        if (ev.t === 'customer') {
          const c = this._custByKey(r.key, r.name, r.phone);
          this.db.prepare('update customers set name=?, phone=?, gstin=?, address=?, opening=?, note=? where id=?')
            .run(r.name || c.name, r.phone || '', r.gstin || '', r.address || '', r2(r.opening), r.note || '', c.id);
        } else if (ev.t === 'alias') {
          const from = this.db.prepare('select * from customers where key=?').get(r.old_key);
          if (from && r.old_key !== r.key) {
            const to = this.db.prepare('select * from customers where key=?').get(r.key);
            if (!to) this.db.prepare('update customers set key=? where id=?').run(r.key, from.id);
            else {
              for (const t of ['bills', 'payments', 'returns']) this.db.prepare(`update ${t} set customer_id=? where customer_id=?`).run(to.id, from.id);
              this.db.prepare('update customers set key=?, opening=0 where id=?').run('merged:' + from.id + ':' + r.old_key, from.id);
            }
          }
        } else if (ev.t === 'payment') {
          const ex = has('payments', r.uid);
          if (ex) { if (r.cancelled && !ex.cancelled) this.db.prepare('update payments set cancelled=1, cancelled_at=? where id=?').run(nowLocal(), ex.id); }
          else {
            const c = this._custByKey(r.customer_key);
            const b = r.bill_ref ? this.db.prepare('select id from bills where bill_no=?').get(this.lref(r.bill_ref)) : null;
            this.db.prepare('insert into payments(customer_id,amount,mode,note,bill_id,created_at,staff,cancelled,cancelled_at,uid) values(?,?,?,?,?,?,?,?,?,?)')
              .run(c.id, r2(r.amount), r.mode || 'cash', r.note || '', b ? b.id : null, r.at || nowLocal(), r.staff || '', r.cancelled ? 1 : 0, r.cancelled ? nowLocal() : null, r.uid);
          }
        } else if (ev.t === 'return') {
          if (!has('returns', r.uid)) {
            const b = this.db.prepare('select * from bills where bill_no=?').get(this.lref(r.bill_ref));
            if (!b) throw WAIT; // its bill hasn't reached this laptop yet: try again next time
            const c = r.customer_key ? this._custByKey(r.customer_key, r.customer) : null;
            const rid = this.db.prepare('insert into returns(return_no,bill_id,bill_no,created_at,refund_mode,customer_id,customer,total,gst,note,staff,uid) values(?,?,?,?,?,?,?,?,?,?,?,?)')
              .run(this._freeNo('returns', 'return_no', r.return_no || r.uid), b.id, b.bill_no, r.at || nowLocal(), r.refund_mode || 'cash', c ? c.id : null, r.customer || '', r2(r.total), r2(r.gst), r.note || '', r.staff || '', r.uid).lastInsertRowid;
            const ins = this.db.prepare('insert into return_lines(return_id,code,name,unit,factor,gst,qty,rate,amount) values(?,?,?,?,?,?,?,?,?)');
            for (const l of r.lines || []) ins.run(rid, String(l.code), String(l.name || l.code), l.unit || 'pcs', +l.factor || 1, +l.gst || 0, +l.qty || 0, r2(l.rate), r2(l.amount));
            this.db.prepare('update bills set returned=round(returned+?,2) where id=?').run(r2(r.total), b.id);
          }
        } else if (ev.t === 'supplier') {
          const s = this._supByKey(r.key, r.name);
          this.db.prepare('update suppliers set name=?, phone=?, gstin=?, address=?, opening=? where id=?').run(r.name || s.name, r.phone || '', r.gstin || '', r.address || '', r2(r.opening), s.id);
        } else if (ev.t === 'purchase') {
          const ex = has('purchases', r.uid);
          if (ex) { if (r.cancelled && !ex.cancelled) this.db.prepare('update purchases set cancelled=1, cancelled_at=? where id=?').run(nowLocal(), ex.id); }
          else {
            const s = r.supplier_key ? this._supByKey(r.supplier_key, r.supplier) : null;
            const pid = this.db.prepare(`insert into purchases(purchase_no,supplier_id,supplier,supplier_bill,bill_date,created_at,items_count,total,gst,paid,paid_mode,note,staff,cancelled,cancelled_at,uid)
              values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(this._freeNo('purchases', 'purchase_no', r.purchase_no || r.uid), s ? s.id : null, s ? s.name : r.supplier || '', r.supplier_bill || '', r.bill_date || '',
                r.at || nowLocal(), +r.items_count || 0, r2(r.total), r2(r.gst), r2(r.paid), r.paid_mode || 'cash', r.note || '', r.staff || '', r.cancelled ? 1 : 0, r.cancelled ? nowLocal() : null, r.uid).lastInsertRowid;
            const ins = this.db.prepare('insert into purchase_lines(purchase_id,code,name,unit,gst,qty,cost,amount) values(?,?,?,?,?,?,?,?)');
            for (const l of r.lines || []) ins.run(pid, String(l.code), String(l.name || l.code), l.unit || 'pcs', +l.gst || 0, +l.qty || 0, r2(l.cost), r2(l.amount));
          }
        } else if (ev.t === 'spay') {
          const ex = has('supplier_payments', r.uid);
          if (ex) { if (r.cancelled && !ex.cancelled) this.db.prepare('update supplier_payments set cancelled=1, cancelled_at=? where id=?').run(nowLocal(), ex.id); }
          else {
            const s = this._supByKey(r.supplier_key);
            this.db.prepare('insert into supplier_payments(supplier_id,amount,mode,note,created_at,staff,cancelled,cancelled_at,uid) values(?,?,?,?,?,?,?,?,?)')
              .run(s.id, r2(r.amount), r.mode || 'cash', r.note || '', r.at || nowLocal(), r.staff || '', r.cancelled ? 1 : 0, r.cancelled ? nowLocal() : null, r.uid);
          }
        }
      })(); }
      catch (e) {
        if (e === WAIT) break;
        this.who = 'Sync'; this.audit('sync.failed', 'ledger ' + ev.t, `${e.message} · ${JSON.stringify(ev.r || {}).slice(0, 300)}`); // a broken record must not stop the rest
      }
      upto = +ev.seq; applied++;
    }
    if (applied) this.setSetting('ledger_dirty', '1');
    return { applied, upto };
  },
};

module.exports = { syncMethods, supKey };

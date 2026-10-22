// NRRL Billing — udhaar accounts, returns, purchases & suppliers, and the change log.
// Added onto the Store (db.js); everything here lives in the same local SQLite file.
'use strict';

const r2 = n => Math.round((+n || 0) * 100) / 100;
const p2 = n => String(n).padStart(2, '0');
const nowLocal = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
const MODES = ['cash', 'upi', 'card', 'bank'];
const clean = (s, n = 120) => String(s ?? '').trim().slice(0, n);
// one customer per phone number (last 10 digits); without a phone, per name
const custKey = (name, phone) => {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length >= 10) return 'p:' + d.slice(-10);
  const n = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return n ? 'n:' + n : '';
};

function migrateLedger(st) {
  st.db.exec(`
    create table if not exists customers(
      id integer primary key autoincrement, key text not null unique, name text not null, phone text not null default '',
      gstin text not null default '', address text not null default '', opening real not null default 0, note text not null default '',
      created_at text not null);
    create table if not exists payments(
      id integer primary key autoincrement, customer_id integer not null references customers(id), amount real not null,
      mode text not null default 'cash', note text not null default '', bill_id integer, created_at text not null, staff text not null default '',
      cancelled integer not null default 0, cancelled_at text);
    create index if not exists payments_cust on payments(customer_id);
    create table if not exists returns(
      id integer primary key autoincrement, return_no text not null unique, bill_id integer not null references bills(id), bill_no text not null,
      created_at text not null, refund_mode text not null, customer_id integer, customer text not null default '',
      total real not null, gst real not null default 0, note text not null default '', staff text not null default '');
    create index if not exists returns_bill on returns(bill_id);
    create index if not exists returns_created on returns(created_at);
    create table if not exists return_lines(
      id integer primary key autoincrement, return_id integer not null references returns(id), code text not null, name text not null,
      unit text not null default 'pcs', factor real not null default 1, gst real not null default 0, qty real not null, rate real not null, amount real not null);
    create index if not exists return_lines_ret on return_lines(return_id);
    create table if not exists suppliers(
      id integer primary key autoincrement, name text not null, phone text not null default '', gstin text not null default '',
      address text not null default '', opening real not null default 0, created_at text not null);
    create table if not exists purchases(
      id integer primary key autoincrement, purchase_no text not null unique, supplier_id integer references suppliers(id), supplier text not null default '',
      supplier_bill text not null default '', bill_date text not null default '', created_at text not null,
      items_count integer not null default 0, total real not null, gst real not null default 0,
      paid real not null default 0, paid_mode text not null default 'cash', note text not null default '', staff text not null default '',
      cancelled integer not null default 0, cancelled_at text);
    create index if not exists purchases_created on purchases(created_at);
    create table if not exists purchase_lines(
      id integer primary key autoincrement, purchase_id integer not null references purchases(id), code text not null, name text not null,
      unit text not null default 'pcs', gst real not null default 0, qty real not null, cost real not null, amount real not null);
    create table if not exists supplier_payments(
      id integer primary key autoincrement, supplier_id integer not null references suppliers(id), amount real not null,
      mode text not null default 'cash', note text not null default '', created_at text not null, staff text not null default '',
      cancelled integer not null default 0, cancelled_at text);
    create table if not exists audit(
      id integer primary key autoincrement, at text not null, who text not null default '', action text not null, ref text not null default '', detail text not null default '');
    create index if not exists audit_at on audit(at);
  `);
  const addCol = (t, c, def) => { if (!st.db.prepare(`pragma table_info(${t})`).all().some(r => r.name === c)) st.db.exec(`alter table ${t} add column ${c} ${def}`); };
  addCol('bills', 'customer_id', 'integer');
  addCol('bills', 'returned', 'real not null default 0');
  // udhaar bills made before accounts existed get their customer
  for (const b of st.db.prepare("select id, customer, phone from bills where payment='udhaar' and customer_id is null").all()) {
    const c = st.ensureCustomer(b.customer, b.phone);
    if (c) st.db.prepare('update bills set customer_id=? where id=?').run(c.id, b.id);
  }
}

const methods = {
  /* ---------- change log ---------- */
  audit(action, ref, detail) {
    this.db.prepare('insert into audit(at,who,action,ref,detail) values(?,?,?,?,?)')
      .run(nowLocal(), clean(this.who || 'Counter', 60), action, clean(ref, 80), clean(typeof detail === 'string' ? detail : JSON.stringify(detail ?? ''), 600));
  },
  auditList(q = {}) {
    const where = [], args = [];
    if (q.from) { where.push('at>=?'); args.push(q.from + ' 00:00:00'); }
    if (q.to) { where.push('at<?'); args.push(q.to + ' 23:59:60'); }
    if (q.who) { where.push('who=?'); args.push(q.who); }
    if (q.action) { where.push('action like ?'); args.push(q.action + '%'); }
    if (q.text) { where.push('(ref like ? or detail like ?)'); args.push('%' + q.text + '%', '%' + q.text + '%'); }
    const rows = this.db.prepare(`select * from audit ${where.length ? 'where ' + where.join(' and ') : ''} order by id desc limit 2000`).all(...args);
    const people = this.db.prepare('select distinct who from audit order by who').all().map(r => r.who);
    return { rows, people };
  },

  /* ---------- customers & udhaar ---------- */
  ensureCustomer(name, phone) {
    const key = custKey(name, phone);
    if (!key) return null;
    let c = this.db.prepare('select * from customers where key=?').get(key);
    if (!c) {
      const id = this.db.prepare('insert into customers(key,name,phone,created_at) values(?,?,?,?)').run(key, clean(name) || clean(phone), clean(phone, 20), nowLocal()).lastInsertRowid;
      c = this.db.prepare('select * from customers where id=?').get(id);
    } else if (phone && !c.phone) this.db.prepare('update customers set phone=? where id=?').run(clean(phone, 20), c.id);
    return c;
  },
  _balanceSql() {
    return `c.opening
      + coalesce((select sum(b.total) from bills b where b.customer_id=c.id and b.payment='udhaar' and b.cancelled=0),0)
      - coalesce((select sum(p.amount) from payments p where p.customer_id=c.id and p.cancelled=0),0)
      - coalesce((select sum(r.total) from returns r where r.customer_id=c.id and r.refund_mode='account'),0)`;
  },
  customers(q) {
    const rows = this.db.prepare(`select c.*, round(${this._balanceSql()},2) balance,
        (select max(b.created_at) from bills b where b.customer_id=c.id) last_bill,
        (select max(p.created_at) from payments p where p.customer_id=c.id and p.cancelled=0) last_payment
      from customers c order by balance desc, c.name collate nocase limit 5000`).all();
    if (!q) return rows;
    const s = String(q).toLowerCase();
    return rows.filter(c => c.name.toLowerCase().includes(s) || c.phone.includes(s));
  },
  customer(id) {
    const c = this.db.prepare(`select c.*, round(${this._balanceSql()},2) balance from customers c where c.id=?`).get(id);
    if (!c) throw new Error('Customer not found.');
    // statement: what they took on udhaar, what they paid, what they returned
    const rows = [
      ...this.db.prepare("select 'bill' kind, id, bill_no ref, created_at at, total amount, cancelled from bills where customer_id=? and payment='udhaar'").all(id),
      ...this.db.prepare("select 'payment' kind, id, mode ref, created_at at, amount, cancelled, note from payments where customer_id=?").all(id),
      ...this.db.prepare("select 'return' kind, id, return_no ref, created_at at, total amount, 0 cancelled, bill_no note from returns where customer_id=? and refund_mode='account'").all(id),
    ].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
    let bal = c.opening;
    for (const r of rows) {
      if (!r.cancelled) bal = r2(bal + (r.kind === 'bill' ? r.amount : -r.amount));
      r.balance = bal;
    }
    return { ...c, statement: rows };
  },
  customerFind(name, phone) {
    const key = custKey(name, phone);
    if (!key) return null;
    const c = this.db.prepare('select id from customers where key=?').get(key);
    return c ? this.customers().find(x => x.id === c.id) || null : null;
  },
  saveCustomer(id, p) {
    const c = this.db.prepare('select * from customers where id=?').get(id);
    if (!c) throw new Error('Customer not found.');
    const name = clean(p.name) || c.name, phone = clean(p.phone, 20), opening = r2(p.opening);
    const key = custKey(name, phone);
    const other = this.db.prepare('select id, name from customers where key=? and id<>?').get(key, id);
    if (other) throw new Error(`That phone number already belongs to ${other.name}.`);
    this.db.prepare('update customers set key=?, name=?, phone=?, gstin=?, address=?, opening=?, note=? where id=?')
      .run(key, name, phone, clean(p.gstin, 20).toUpperCase(), clean(p.address, 300), opening, clean(p.note, 300), id);
    const ch = [];
    for (const k of ['name', 'phone', 'gstin', 'opening']) if (String(c[k]) !== String(k === 'opening' ? opening : k === 'gstin' ? clean(p.gstin, 20).toUpperCase() : k === 'name' ? name : phone)) ch.push(`${k}: ${c[k]} → ${k === 'opening' ? opening : p[k]}`);
    if (ch.length) this.audit('customer.edit', name, ch.join('; '));
    return this.customer(id);
  },
  addCustomer(p) {
    const name = clean(p.name), phone = clean(p.phone, 20);
    if (!name) throw new Error('Add the customer’s name.');
    if (this.db.prepare('select 1 from customers where key=?').get(custKey(name, phone))) throw new Error('This customer is already in the list.');
    const c = this.ensureCustomer(name, phone);
    const out = this.saveCustomer(c.id, { ...c, ...p, name, phone });
    this.audit('customer.add', name, +p.opening ? `opening balance ${r2(p.opening)}` : '');
    return out;
  },
  receivePayment(customerId, amount, mode, note, billId) {
    const c = this.db.prepare('select * from customers where id=?').get(customerId);
    if (!c) throw new Error('Customer not found.');
    amount = r2(amount);
    if (!(amount > 0)) throw new Error('Enter the amount received.');
    mode = MODES.includes(mode) ? mode : 'cash';
    const id = this.db.prepare('insert into payments(customer_id,amount,mode,note,bill_id,created_at,staff) values(?,?,?,?,?,?,?)')
      .run(c.id, amount, mode, clean(note, 200), billId || null, nowLocal(), clean(this.who || '', 60)).lastInsertRowid;
    this.audit('payment.receive', c.name, `₹${amount} ${mode}${note ? ' · ' + note : ''}`);
    return { id, customer: this.customer(c.id) };
  },
  cancelPayment(id) {
    const p = this.db.prepare('select p.*, c.name from payments p join customers c on c.id=p.customer_id where p.id=?').get(id);
    if (!p) throw new Error('Payment not found.');
    if (!p.cancelled) {
      this.db.prepare('update payments set cancelled=1, cancelled_at=? where id=?').run(nowLocal(), id);
      this.audit('payment.cancel', p.name, `₹${p.amount} ${p.mode} from ${p.created_at}`);
    }
    return this.customer(p.customer_id);
  },
  udhaarTotal() {
    const r = this.db.prepare(`select count(*) n, round(coalesce(sum(bal),0),2) total from (select ${this._balanceSql()} bal from customers c) where bal > 0.009`).get();
    return r;
  },
  paymentsBetween(a, b) {
    return this.db.prepare('select p.mode, round(sum(p.amount),2) total, count(*) n from payments p where p.cancelled=0 and p.created_at>=? and p.created_at<? group by p.mode').all(a, b);
  },

  /* ---------- returns ---------- */
  // what can still be returned from a bill: qty sold minus qty already returned, per line
  returnable(billId) {
    const b = this.getBill(billId);
    if (!b) throw new Error('Bill not found.');
    const done = {};
    for (const r of this.db.prepare('select l.code, l.unit, sum(l.qty) qty from return_lines l join returns r on r.id=l.return_id where r.bill_id=? group by l.code, l.unit').all(billId)) done[r.code + '|' + r.unit] = r.qty;
    const f = b.subtotal > 0 ? b.total / b.subtotal : 1; // the bill's discount is shared across lines
    const lines = b.lines.map(l => { const back = done[l.code + '|' + l.unit] || 0; return { ...l, returned: r2(back), left: r2(l.qty - back), net_rate: r2(l.rate * f) }; });
    const returns = this.db.prepare('select * from returns where bill_id=? order by id').all(billId);
    return { bill: b, lines, returns };
  },
  saveReturn(p) {
    const { bill, lines } = this.returnable(p.bill_id);
    if (bill.cancelled) throw new Error('This bill is cancelled; nothing to return.');
    const mode = ['cash', 'upi', 'card', 'account'].includes(p.refund_mode) ? p.refund_mode : 'cash';
    const want = (p.lines || []).map(x => ({ ...x, qty: r2(x.qty) })).filter(x => x.qty > 0);
    if (!want.length) throw new Error('Choose how many of each item came back.');
    const f = bill.subtotal > 0 ? bill.total / bill.subtotal : 1;
    const out = [];
    for (const w of want) {
      const l = lines.find(x => x.code === w.code && x.unit === (w.unit || x.unit));
      if (!l) throw new Error(`Item ${w.code} is not on this bill.`);
      if (w.qty > l.left + 1e-9) throw new Error(`Only ${l.left} ${l.unit} of ${l.name} can be returned.`);
      out.push({ ...l, qty: w.qty, amount: r2(w.qty * l.rate * f) });
    }
    let cust = null;
    if (mode === 'account') {
      cust = bill.customer_id ? this.db.prepare('select * from customers where id=?').get(bill.customer_id) : this.ensureCustomer(bill.customer, bill.phone);
      if (!cust) throw new Error('This bill has no customer name, so it can’t go to an udhaar account. Refund in cash or UPI.');
    }
    const total = r2(out.reduce((a, l) => a + l.amount, 0));
    const gst = r2(out.reduce((a, l) => a + l.amount * l.gst / (100 + l.gst), 0));
    const id = this.db.transaction(() => {
      const prefix = (this.getSetting('bill_prefix') || '') + 'R';
      let n = parseInt(this.getSetting('next_return'), 10) || 1;
      const taken = this.db.prepare('select 1 from returns where return_no=?');
      while (taken.get(prefix + n)) n++;
      this.setSetting('next_return', String(n + 1));
      const no = prefix + n;
      const rid = this.db.prepare(`insert into returns(return_no,bill_id,bill_no,created_at,refund_mode,customer_id,customer,total,gst,note,staff) values(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(no, bill.id, bill.bill_no, nowLocal(), mode, cust ? cust.id : null, bill.customer || '', total, gst, clean(p.note, 200), clean(this.who || '', 60)).lastInsertRowid;
      const ins = this.db.prepare('insert into return_lines(return_id,code,name,unit,factor,gst,qty,rate,amount) values(?,?,?,?,?,?,?,?,?)');
      const inc = this.db.prepare('update items set stock=round(stock+?,2) where code=? and stock is not null');
      for (const l of out) {
        ins.run(rid, l.code, l.name, l.unit, l.factor || 1, l.gst, l.qty, l.net_rate, l.amount);
        const it = this.getItem(l.code), sq = r2(l.qty * (l.factor || 1));
        // back on the shelf; reaches the phone app and other laptops as a stock change
        if (it && it.stock != null) { inc.run(sq, l.code); this._move(l.code, sq, 'adjust', 'return ' + no); }
      }
      this.db.prepare('update bills set returned=round(returned+?,2) where id=?').run(total, bill.id);
      this.audit('bill.return', no, `bill ${bill.bill_no} · ₹${total} ${mode === 'account' ? 'to udhaar account' : 'refunded ' + mode} · ${out.map(l => `${l.qty} ${l.unit} ${l.name}`).join(', ')}${p.note ? ' · ' + p.note : ''}`);
      return rid;
    })();
    return this.getReturn(id);
  },
  getReturn(id) {
    const r = this.db.prepare('select * from returns where id=?').get(id);
    if (!r) return null;
    r.lines = this.db.prepare('select code,name,unit,factor,gst,qty,rate,amount from return_lines where return_id=? order by id').all(id);
    return r;
  },
  listReturns(a, b) {
    return this.db.prepare('select id,return_no,bill_no,bill_id,created_at,refund_mode,customer,total,staff,note from returns where created_at>=? and created_at<? order by id desc limit 5000').all(a, b);
  },

  /* ---------- suppliers & purchases ---------- */
  _supBalanceSql() {
    return `s.opening
      + coalesce((select sum(p.total - p.paid) from purchases p where p.supplier_id=s.id and p.cancelled=0),0)
      - coalesce((select sum(x.amount) from supplier_payments x where x.supplier_id=s.id and x.cancelled=0),0)`;
  },
  suppliers() {
    return this.db.prepare(`select s.*, round(${this._supBalanceSql()},2) balance, (select max(p.created_at) from purchases p where p.supplier_id=s.id and p.cancelled=0) last_purchase
      from suppliers s order by s.name collate nocase`).all();
  },
  supplier(id) {
    const s = this.db.prepare(`select s.*, round(${this._supBalanceSql()},2) balance from suppliers s where s.id=?`).get(id);
    if (!s) throw new Error('Supplier not found.');
    const rows = [
      ...this.db.prepare("select 'purchase' kind, id, purchase_no ref, created_at at, total amount, paid, cancelled, supplier_bill note from purchases where supplier_id=?").all(id),
      ...this.db.prepare("select 'payment' kind, id, mode ref, created_at at, amount, 0 paid, cancelled, note from supplier_payments where supplier_id=?").all(id),
    ].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
    let bal = s.opening;
    for (const r of rows) { if (!r.cancelled) bal = r2(bal + (r.kind === 'purchase' ? r.amount - r.paid : -r.amount)); r.balance = bal; }
    return { ...s, statement: rows };
  },
  saveSupplier(id, p) {
    const name = clean(p.name);
    if (!name) throw new Error('Add the supplier’s name.');
    const dup = this.db.prepare('select id from suppliers where lower(name)=lower(?) and id<>?').get(name, id || 0);
    if (dup) throw new Error('A supplier with this name already exists.');
    const v = [name, clean(p.phone, 20), clean(p.gstin, 20).toUpperCase(), clean(p.address, 300), r2(p.opening)];
    if (id) {
      const old = this.db.prepare('select * from suppliers where id=?').get(id);
      this.db.prepare('update suppliers set name=?, phone=?, gstin=?, address=?, opening=? where id=?').run(...v, id);
      if (old && r2(old.opening) !== r2(p.opening)) this.audit('supplier.edit', name, `opening ${old.opening} → ${r2(p.opening)}`);
    } else {
      id = this.db.prepare('insert into suppliers(name,phone,gstin,address,opening,created_at) values(?,?,?,?,?,?)').run(...v, nowLocal()).lastInsertRowid;
      this.audit('supplier.add', name, +p.opening ? `opening balance ${r2(p.opening)}` : '');
    }
    return this.supplier(id);
  },
  savePurchase(p) {
    let sup = null;
    if (p.supplier_id) sup = this.db.prepare('select * from suppliers where id=?').get(p.supplier_id);
    else if (clean(p.supplier)) sup = this.db.prepare('select * from suppliers where lower(name)=lower(?)').get(clean(p.supplier)) || this.saveSupplier(null, { name: p.supplier });
    const lines = (p.lines || []).map(l => ({ code: String(l.code || ''), qty: r2(l.qty), cost: r2(l.cost), retail: l.retail, wholesale: l.wholesale })).filter(l => l.code && l.qty > 0);
    if (!lines.length) throw new Error('Add at least one item with a quantity.');
    const out = [];
    for (const l of lines) {
      const it = this.getItem(l.code);
      if (!it || !it.active) throw new Error(`Item ${l.code} is not in the item list. Add it first.`);
      if (l.cost < 0) throw new Error('Cost can’t be negative.');
      out.push({ it, ...l, amount: r2(l.qty * l.cost) });
    }
    const total = r2(out.reduce((a, l) => a + l.amount, 0));
    const gst = r2(out.reduce((a, l) => a + l.amount * l.it.gst / (100 + l.it.gst), 0));
    const paid = Math.min(Math.max(r2(p.paid), 0), total);
    const id = this.db.transaction(() => {
      let n = parseInt(this.getSetting('next_purchase'), 10) || 1;
      const pre = (this.getSetting('bill_prefix') || '') + 'P';
      const taken = this.db.prepare('select 1 from purchases where purchase_no=?');
      while (taken.get(pre + n)) n++;
      this.setSetting('next_purchase', String(n + 1));
      const no = pre + n;
      const pid = this.db.prepare(`insert into purchases(purchase_no,supplier_id,supplier,supplier_bill,bill_date,created_at,items_count,total,gst,paid,paid_mode,note,staff)
        values(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(no, sup ? sup.id : null, sup ? sup.name : clean(p.supplier), clean(p.supplier_bill, 40), clean(p.bill_date, 10),
          nowLocal(), out.length, total, gst, paid, MODES.includes(p.paid_mode) ? p.paid_mode : 'cash', clean(p.note, 200), clean(this.who || '', 60)).lastInsertRowid;
      const ins = this.db.prepare('insert into purchase_lines(purchase_id,code,name,unit,gst,qty,cost,amount) values(?,?,?,?,?,?,?,?)');
      for (const l of out) {
        ins.run(pid, l.it.code, l.it.name, l.it.unit, l.it.gst, l.qty, l.cost, l.amount);
        this.db.prepare('update items set stock=round(coalesce(stock,0)+?,2), updated_at=? where code=?').run(l.qty, nowLocal(), l.it.code);
        this._move(l.it.code, l.qty, 'purchase', no);
        const ch = [];
        if (l.cost > 0 && r2(l.it.cost) !== l.cost) { this.db.prepare('update items set cost=? where code=?').run(l.cost, l.it.code); ch.push(`cost ${l.it.cost} → ${l.cost}`); }
        for (const k of ['retail', 'wholesale']) {
          const v = l[k] === '' || l[k] == null ? null : r2(l[k]);
          if (v != null && v > 0 && v !== r2(l.it[k])) { this.db.prepare(`update items set ${k}=? where code=?`).run(v, l.it.code); ch.push(`${k} ${l.it[k]} → ${v}`); }
        }
        if (ch.length) { this.linkPush('item', this._itemPayload(l.it.code, false)); this.audit('item.edit', l.it.name, ch.join('; ') + ` (purchase ${no})`); }
      }
      this.audit('purchase.save', no, `${sup ? sup.name : 'no supplier'}${p.supplier_bill ? ' bill ' + clean(p.supplier_bill, 40) : ''} · ${out.length} items · ₹${total}${paid ? ` · paid ₹${paid}` : ''}`);
      return pid;
    })();
    return this.getPurchase(id);
  },
  getPurchase(id) {
    const p = this.db.prepare('select * from purchases where id=?').get(id);
    if (!p) return null;
    p.lines = this.db.prepare('select code,name,unit,gst,qty,cost,amount from purchase_lines where purchase_id=? order by id').all(id);
    return p;
  },
  listPurchases(a, b) {
    return this.db.prepare('select * from purchases where created_at>=? and created_at<? order by id desc limit 5000').all(a, b);
  },
  cancelPurchase(id) {
    const p = this.getPurchase(id);
    if (!p) throw new Error('Purchase not found.');
    if (p.cancelled) return p;
    this.db.transaction(() => {
      for (const l of p.lines) {
        const it = this.getItem(l.code);
        if (it && it.stock != null) { this.db.prepare('update items set stock=round(stock-?,2) where code=?').run(l.qty, l.code); this._move(l.code, -l.qty, 'adjust', 'cancel ' + p.purchase_no); }
      }
      this.db.prepare('update purchases set cancelled=1, cancelled_at=? where id=?').run(nowLocal(), id);
      this.audit('purchase.cancel', p.purchase_no, `${p.supplier} · ₹${p.total} · stock taken back out`);
    })();
    return this.getPurchase(id);
  },
  paySupplier(supplierId, amount, mode, note) {
    const s = this.db.prepare('select * from suppliers where id=?').get(supplierId);
    if (!s) throw new Error('Supplier not found.');
    amount = r2(amount);
    if (!(amount > 0)) throw new Error('Enter the amount paid.');
    mode = MODES.includes(mode) ? mode : 'cash';
    this.db.prepare('insert into supplier_payments(supplier_id,amount,mode,note,created_at,staff) values(?,?,?,?,?,?)').run(s.id, amount, mode, clean(note, 200), nowLocal(), clean(this.who || '', 60));
    this.audit('supplier.pay', s.name, `₹${amount} ${mode}${note ? ' · ' + note : ''}`);
    return this.supplier(s.id);
  },
  cancelSupplierPayment(id) {
    const x = this.db.prepare('select x.*, s.name from supplier_payments x join suppliers s on s.id=x.supplier_id where x.id=?').get(id);
    if (!x) throw new Error('Payment not found.');
    if (!x.cancelled) { this.db.prepare('update supplier_payments set cancelled=1, cancelled_at=? where id=?').run(nowLocal(), id); this.audit('supplier.pay.cancel', x.name, `₹${x.amount} ${x.mode} from ${x.created_at}`); }
    return this.supplier(x.supplier_id);
  },
  suppliersOwed() {
    return this.db.prepare(`select count(*) n, round(coalesce(sum(bal),0),2) total from (select ${this._supBalanceSql()} bal from suppliers s) where bal > 0.009`).get();
  },
};

module.exports = { migrateLedger, ledgerMethods: methods, custKey };

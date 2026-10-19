// NRRL Billing — local SQLite store (items, bills, stock, settings)
'use strict';
const Database = require('better-sqlite3');
const crypto = require('crypto');

const r2 = n => Math.round((+n || 0) * 100) / 100;
const p2 = n => String(n).padStart(2, '0');
function nowLocal(d = new Date()) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
function dayStart(dateStr) { return `${dateStr} 00:00:00`; }
function nextDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(y, m - 1, d + 1);
  return `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())} 00:00:00`;
}
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const numOrNull = v => (v === '' || v == null || !isFinite(+v)) ? null : r2(v);

const DEFAULTS = {
  shop_name: 'Nathu Ram Ram Lal',
  shop_address: 'Aligarh',
  shop_phone: '',
  gstin: '',
  footer: 'Thank you! Visit again.',
  printer: '',
  paper: '80',
  print_margin: '',
  font_size: '',
  auto_print: '1',
  copies: '1',
  bill_prefix: '',
  next_bill: '1',
  label_printer: '',
  label_w: '50',
  label_h: '25',
  label_price: '1',
  label_dpi: '203',
  label_across: '1',
  label_mode: 'windows',
  sheet_url: '',
  link_key: '',
  link_name: '',
  link_items_at: '',
  link_bills_after: '0',
  sheet_key: '',
  label_wcode: '1',
  wcode_prefix: 'NRRL',
  wcode_mult: '2',
  label_vgap: '2',
  label_flip: '0',
  label_density: '10',
  label_gap: '2',
  label_shift: '0',
  label_bar: '',
  low_stock: '5',
  backup_extra: '',
  owner_pin: '',
  last_backup: '',
  next_code: '10001',
};
const EDITABLE = new Set(['shop_name', 'shop_address', 'shop_phone', 'gstin', 'footer', 'printer', 'paper', 'print_margin', 'font_size',
  'auto_print', 'copies', 'bill_prefix', 'next_bill', 'label_printer', 'label_w', 'label_h', 'label_price', 'label_dpi', 'label_bar', 'label_across', 'label_gap', 'label_shift', 'label_mode', 'label_vgap', 'label_flip', 'label_density', 'label_wcode', 'wcode_prefix', 'wcode_mult', 'low_stock', 'backup_extra']);

class Store {
  constructor(file) {
    this.file = file;
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }
  static validate(file) {
    const d = new Database(file, { readonly: true, fileMustExist: true });
    try {
      d.prepare('select count(*) c from items').get();
      d.prepare('select count(*) c from bills').get();
    } finally { d.close(); }
  }
  close() { try { this.db.close(); } catch (e) {} }

  migrate() {
    this.db.exec(`
      create table if not exists items(
        code text primary key, name text not null,
        retail real not null default 0, wholesale real not null default 0, cost real not null default 0,
        stock real, min_stock real, unit text not null default 'pcs', gst real not null default 18, hsn text not null default '',
        active integer not null default 1, created_at text, updated_at text);
      create table if not exists bills(
        id integer primary key autoincrement, bill_no text not null unique, created_at text not null,
        mode text not null default 'retail', payment text not null default 'cash',
        customer text not null default '', phone text not null default '',
        items_count integer not null default 0, qty real not null default 0,
        subtotal real not null, discount real not null default 0, total real not null, gst real not null default 0,
        cancelled integer not null default 0, cancelled_at text);
      create index if not exists bills_created on bills(created_at);
      create table if not exists bill_lines(
        id integer primary key autoincrement, bill_id integer not null references bills(id),
        code text not null, name text not null, unit text not null default 'pcs', hsn text not null default '',
        gst real not null default 0, qty real not null, rate real not null, amount real not null);
      create index if not exists bill_lines_bill on bill_lines(bill_id);
      create index if not exists bill_lines_code on bill_lines(code);
      create table if not exists stock_moves(
        id integer primary key autoincrement, code text not null, qty real not null, kind text not null, ref text, at text not null);
      create table if not exists settings(key text primary key, value text);
      create table if not exists link_queue(id integer primary key autoincrement, kind text not null, payload text not null, created_at text not null, tries integer not null default 0, last_error text);
      create table if not exists sync_queue(id integer primary key autoincrement, kind text not null, payload text not null, created_at text not null, tries integer not null default 0, last_error text);
    `);
    const addCol = (t, c, def) => { if (!this.db.prepare(`pragma table_info(${t})`).all().some(r => r.name === c)) this.db.exec(`alter table ${t} add column ${c} ${def}`); };
    addCol('items', 'wholesale_unit', "text not null default ''");
    addCol('items', 'wholesale_qty', 'real not null default 1');
    addCol('bill_lines', 'factor', 'real not null default 1');
    const ins = this.db.prepare('insert or ignore into settings(key,value) values(?,?)');
    for (const [k, v] of Object.entries(DEFAULTS)) ins.run(k, v);
  }

  /* ---------- settings ---------- */
  getSetting(k) { const r = this.db.prepare('select value from settings where key=?').get(k); return r ? r.value : (DEFAULTS[k] ?? ''); }
  setSetting(k, v) { this.db.prepare('insert into settings(key,value) values(?,?) on conflict(key) do update set value=excluded.value').run(k, String(v ?? '')); }
  getSettings() {
    const o = {};
    for (const r of this.db.prepare('select key,value from settings').all()) o[r.key] = r.value;
    o.hasPin = !!o.owner_pin; delete o.owner_pin;
    return o;
  }
  saveSettings(obj) {
    this.db.transaction(() => {
      for (const [k, v] of Object.entries(obj || {})) {
        if (!EDITABLE.has(k)) continue;
        let val = String(v ?? '').trim();
        if (k === 'next_bill') {
          const n = parseInt(val, 10);
          if (!(n >= 1)) throw new Error('Next bill number must be 1 or more.');
          val = String(n);
        }
        if (k === 'paper' && !['58', '80'].includes(val)) val = '80';
        this.setSetting(k, val);
      }
    })();
    return this.getSettings();
  }
  hasPin() { return !!this.getSetting('owner_pin'); }
  checkPin(pin) {
    const stored = this.getSetting('owner_pin');
    if (!stored) return true;
    const [salt, hash] = stored.split(':');
    const h = crypto.scryptSync(String(pin || ''), salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
  }
  setPin(oldPin, newPin) {
    if (this.hasPin() && !this.checkPin(oldPin)) throw new Error('Current PIN is wrong.');
    newPin = String(newPin || '');
    if (newPin && !/^\d{4,8}$/.test(newPin)) throw new Error('PIN must be 4 to 8 digits.');
    if (!newPin) { this.setSetting('owner_pin', ''); return false; }
    const salt = crypto.randomBytes(16).toString('hex');
    this.setSetting('owner_pin', salt + ':' + crypto.scryptSync(newPin, salt, 32).toString('hex'));
    return true;
  }

  /* ---------- items ---------- */
  allItems() {
    return this.db.prepare(`select code,name,retail,wholesale,wholesale_unit,wholesale_qty,cost,stock,min_stock,unit,gst,hsn from items where active=1 order by name collate nocase`).all();
  }
  getItem(code) { return this.db.prepare('select * from items where code=?').get(String(code)); }
  nextCode() {
    let n = parseInt(this.getSetting('next_code'), 10) || 10001;
    const has = this.db.prepare('select 1 from items where code=?');
    while (has.get('NR' + n)) n++;
    this.setSetting('next_code', String(n + 1));
    return 'NR' + n;
  }
  _row(it) {
    const code = String(it.code ?? '').trim(), name = String(it.name ?? '').trim();
    if (!code) throw new Error('Add a barcode or code.');
    if (code.length > 64) throw new Error('Code is too long.');
    if (!name) throw new Error('Add the item name.');
    const retail = r2(it.retail);
    if (!(retail > 0)) throw new Error('Retail price must be more than ₹0.');
    const gst = [0, 0.25, 3, 5, 12, 18, 28, 40].includes(+it.gst) ? +it.gst : (isFinite(+it.gst) && it.gst !== '' && it.gst != null ? r2(it.gst) : 18);
    return {
      code, name, retail, wholesale: Math.max(0, r2(it.wholesale)), cost: Math.max(0, r2(it.cost)),
      stock: numOrNull(it.stock), min_stock: numOrNull(it.min_stock),
      unit: String(it.unit || 'pcs').trim() || 'pcs', gst, hsn: String(it.hsn ?? '').trim(), now: nowLocal(),
      wholesale_unit: String(it.wholesale_unit || '').trim(), wholesale_qty: +it.wholesale_qty > 0 ? r2(it.wholesale_qty) : 1,
    };
  }
  saveItem(it, oldCode) {
    const row = this._row(it);
    oldCode = oldCode == null || oldCode === '' ? null : String(oldCode);
    const ex = this.getItem(row.code);
    if (ex && ex.active && row.code !== oldCode) throw new Error(`Code ${row.code} is already used by “${ex.name}”.`);
    this.db.transaction(() => {
      let prevStock = null;
      if (oldCode && oldCode !== row.code) {
        const old = this.getItem(oldCode);
        if (!old) throw new Error('That item no longer exists.');
        prevStock = old.stock;
        if (ex) this.db.prepare('delete from items where code=?').run(row.code); // a removed item held this code
        this.db.prepare('update items set code=? where code=?').run(row.code, oldCode);
        this.db.prepare('update stock_moves set code=? where code=?').run(row.code, oldCode);
      } else if (ex) prevStock = ex.active ? ex.stock : null;
      this.db.prepare(`insert into items(code,name,retail,wholesale,wholesale_unit,wholesale_qty,cost,stock,min_stock,unit,gst,hsn,active,created_at,updated_at)
        values(@code,@name,@retail,@wholesale,@wholesale_unit,@wholesale_qty,@cost,@stock,@min_stock,@unit,@gst,@hsn,1,@now,@now)
        on conflict(code) do update set name=excluded.name, retail=excluded.retail, wholesale=excluded.wholesale, wholesale_unit=excluded.wholesale_unit,
          wholesale_qty=excluded.wholesale_qty, cost=excluded.cost,
          stock=excluded.stock, min_stock=excluded.min_stock, unit=excluded.unit, gst=excluded.gst, hsn=excluded.hsn, active=1, updated_at=excluded.updated_at`).run(row);
      const renamed = !!(oldCode && oldCode !== row.code);
      const isNew = renamed || !ex || !ex.active;
      if (renamed) this.linkPush('item', { ...this._itemPayload(row.code, false), code: oldCode, removed: true });
      this.linkPush('item', this._itemPayload(row.code, isNew));
      const diff = r2((row.stock ?? 0) - (prevStock ?? 0));
      if (row.stock != null && diff !== 0) this._move(row.code, diff, isNew ? 'opening' : 'adjust', 'edit');
    })();
    return this.getItem(row.code);
  }
  removeItem(code) {
    this.db.prepare('update items set active=0, updated_at=? where code=?').run(nowLocal(), String(code));
    if (this.getItem(code)) this.linkPush('item', { ...this._itemPayload(String(code), false), removed: true });
    return true;
  }
  stockIn(code, qty, note) {
    qty = r2(qty);
    if (!qty) throw new Error('Enter the quantity.');
    const it = this.getItem(code);
    if (!it || !it.active) throw new Error('Item not found.');
    this.db.transaction(() => {
      this.db.prepare('update items set stock=coalesce(stock,0)+?, updated_at=? where code=?').run(qty, nowLocal(), it.code);
      this._move(it.code, qty, qty > 0 ? 'purchase' : 'adjust', note || '');
    })();
    return this.getItem(code);
  }
  importItems(rows) {
    let imported = 0, skipped = 0; const errors = [];
    const has = this.db.prepare('select stock, active from items where code=?');
    const up = this.db.prepare(`insert into items(code,name,retail,wholesale,wholesale_unit,wholesale_qty,cost,stock,min_stock,unit,gst,hsn,active,created_at,updated_at)
      values(@code,@name,@retail,@wholesale,@wholesale_unit,@wholesale_qty,@cost,@stock,@min_stock,@unit,@gst,@hsn,1,@now,@now)
      on conflict(code) do update set name=excluded.name, retail=excluded.retail,
        wholesale=case when excluded.wholesale>0 then excluded.wholesale else items.wholesale end,
        wholesale_unit=case when excluded.wholesale_unit<>'' then excluded.wholesale_unit else items.wholesale_unit end,
        wholesale_qty=case when excluded.wholesale_unit<>'' then excluded.wholesale_qty else items.wholesale_qty end,
        cost=case when excluded.cost>0 then excluded.cost else items.cost end,
        stock=coalesce(excluded.stock, items.stock), min_stock=coalesce(excluded.min_stock, items.min_stock),
        unit=excluded.unit, gst=excluded.gst, hsn=case when excluded.hsn<>'' then excluded.hsn else items.hsn end, active=1, updated_at=excluded.updated_at`);
    this.db.transaction(() => {
      rows.forEach((r, i) => {
        let row;
        try { row = this._row(r); } catch (e) { skipped++; if (errors.length < 5) errors.push(`Row ${i + 1}: ${e.message}`); return; }
        const prev = has.get(row.code);
        up.run(row);
        const isNew = !prev || !prev.active;
        this.linkPush('item', this._itemPayload(row.code, isNew));
        if (row.stock != null) {
          const diff = r2(row.stock - (!isNew ? (prev.stock ?? 0) : 0));
          if (diff) this._move(row.code, diff, isNew ? 'opening' : 'adjust', 'import');
        }
        imported++;
      });
    })();
    return { imported, skipped, errors };
  }
  _move(code, qty, kind, ref) {
    this.db.prepare('insert into stock_moves(code,qty,kind,ref,at) values(?,?,?,?,?)').run(code, qty, kind, ref || '', nowLocal());
    // sales and cancellations reach the phone app with the bill; new items carry their opening stock
    if (kind === 'adjust' || kind === 'purchase') this.linkPush('stock', { code, delta: qty });
  }
  _itemPayload(code, withStock) {
    const it = this.getItem(code);
    if (!it) return { code };
    return { code: it.code, name: it.name, retail: it.retail, wholesale: it.wholesale, wholesale_unit: it.wholesale_unit, wholesale_qty: it.wholesale_qty,
      cost: it.cost, min_stock: it.min_stock, unit: it.unit, gst: it.gst, hsn: it.hsn, removed: !it.active, stock: withStock ? it.stock : null };
  }
  itemHistory(code) {
    return this.db.prepare('select qty,kind,ref,at from stock_moves where code=? order by id desc limit 50').all(String(code));
  }

  /* ---------- bills ---------- */
  saveBill(p) {
    const lines = (p && Array.isArray(p.lines) ? p.lines : []).filter(l => r2(l.qty) > 0);
    if (!lines.length) throw new Error('The bill has no items.');
    const mode = p.mode === 'wholesale' ? 'wholesale' : 'retail';
    const payment = ['cash', 'upi', 'card', 'udhaar'].includes(p.payment) ? p.payment : 'cash';
    if (payment === 'udhaar' && !String(p.customer || '').trim()) throw new Error('Add the customer’s name for an udhaar bill.');
    const id = this.db.transaction(() => {
      let sub = 0, gst = 0, qty = 0; const out = [];
      for (const l of lines) {
        const it = this.getItem(l.code);
        if (!it && !l.name) throw new Error(`Item ${l.code} is not in the item list.`);
        const ws = !!(it && mode === 'wholesale' && it.wholesale > 0);
        const listRate = it ? (ws ? it.wholesale : it.retail) : 0;
        const unit = it ? (ws && it.wholesale_unit ? it.wholesale_unit : it.unit) : (l.unit || 'pcs');
        const factor = ws && it.wholesale_unit && it.wholesale_unit !== it.unit ? (+it.wholesale_qty > 0 ? +it.wholesale_qty : 1) : 1;
        const rate = l.rate !== '' && l.rate != null && isFinite(+l.rate) && +l.rate >= 0 ? r2(l.rate) : listRate;
        const q = r2(l.qty), amt = r2(rate * q), g = it ? +it.gst : (+l.gst || 0);
        sub += amt; gst += amt * g / (100 + g); qty += q;
        out.push({ code: String(l.code), name: it ? it.name : String(l.name), unit, factor, hsn: it ? it.hsn : '', gst: g, qty: q, rate, amount: amt, tracked: !!(it && it.stock != null) });
      }
      sub = r2(sub);
      const disc = Math.min(Math.max(r2(p.discount), 0), sub);
      const total = r2(sub - disc);
      gst = sub > 0 ? r2(gst * total / sub) : 0;
      const prefix = this.getSetting('bill_prefix') || '';
      let n = parseInt(this.getSetting('next_bill'), 10) || 1;
      const taken = this.db.prepare('select 1 from bills where bill_no=?');
      while (taken.get(prefix + n)) n++;
      const billNo = prefix + n;
      this.setSetting('next_bill', String(n + 1));
      const now = nowLocal();
      const info = this.db.prepare(`insert into bills(bill_no,created_at,mode,payment,customer,phone,items_count,qty,subtotal,discount,total,gst)
        values(?,?,?,?,?,?,?,?,?,?,?,?)`).run(billNo, now, mode, payment, String(p.customer || '').trim(), String(p.phone || '').trim(), out.length, r2(qty), sub, disc, total, gst);
      const bid = info.lastInsertRowid;
      const insL = this.db.prepare('insert into bill_lines(bill_id,code,name,unit,hsn,gst,qty,rate,amount,factor) values(?,?,?,?,?,?,?,?,?,?)');
      const dec = this.db.prepare('update items set stock=round(stock-?,2) where code=? and stock is not null');
      for (const l of out) {
        insL.run(bid, l.code, l.name, l.unit, l.hsn, l.gst, l.qty, l.rate, l.amount, l.factor);
        const sq = r2(l.qty * l.factor);
        if (l.tracked) { dec.run(sq, l.code); this._move(l.code, -sq, 'sale', billNo); }
      }
      return bid;
    })();
    const saved = this.getBill(id);
    this.enqueue('bill', saved);
    this.linkPush('bill', saved);
    return saved;
  }
  getBill(id) {
    const b = this.db.prepare('select * from bills where id=?').get(id);
    if (!b) return null;
    b.lines = this.db.prepare('select code,name,unit,hsn,gst,qty,rate,amount,factor from bill_lines where bill_id=? order by id').all(id);
    return b;
  }
  lastBill() { const r = this.db.prepare('select id from bills order by id desc limit 1').get(); return r ? this.getBill(r.id) : null; }
  _range(from, to) {
    if (!isDate(from) || !isDate(to)) throw new Error('Pick a valid date range.');
    return [dayStart(from), nextDay(to)];
  }
  listBills(from, to) {
    const [a, b] = this._range(from, to);
    return this.db.prepare(`select id,bill_no,created_at,mode,payment,customer,phone,items_count,qty,subtotal,discount,total,gst,cancelled
      from bills where created_at>=? and created_at<? order by id desc limit 5000`).all(a, b);
  }
  cancelBill(id) {
    const b = this.getBill(id);
    if (!b) throw new Error('Bill not found.');
    if (b.cancelled) return b;
    this.db.transaction(() => {
      const inc = this.db.prepare('update items set stock=round(stock+?,2) where code=? and stock is not null');
      for (const l of b.lines) {
        const it = this.getItem(l.code);
        const sq = r2(l.qty * (l.factor || 1));
        if (it && it.stock != null) { inc.run(sq, l.code); this._move(l.code, sq, 'cancel', b.bill_no); }
      }
      this.db.prepare('update bills set cancelled=1, cancelled_at=? where id=?').run(nowLocal(), id);
    })();
    this.enqueue('cancel', { bill_no: b.bill_no });
    if (!/^M\d+$/.test(b.bill_no)) this.linkPush('cancel', { bill_no: b.bill_no });
    return this.getBill(id);
  }
  summary(from, to) {
    const [a, b] = this._range(from, to);
    const t = this.db.prepare(`select count(*) bills, coalesce(sum(total),0) total, coalesce(sum(gst),0) gst, coalesce(sum(discount),0) discount, coalesce(sum(qty),0) qty
      from bills where cancelled=0 and created_at>=? and created_at<?`).get(a, b);
    const pay = {};
    for (const r of this.db.prepare(`select payment, count(*) n, sum(total) total from bills where cancelled=0 and created_at>=? and created_at<? group by payment`).all(a, b)) pay[r.payment] = { n: r.n, total: r2(r.total) };
    const cancelled = this.db.prepare('select count(*) n from bills where cancelled=1 and created_at>=? and created_at<?').get(a, b).n;
    return { bills: t.bills, total: r2(t.total), gst: r2(t.gst), discount: r2(t.discount), qty: r2(t.qty), pay, cancelled };
  }
  itemSales(from, to) {
    const [a, b] = this._range(from, to);
    return this.db.prepare(`select l.code, max(l.name) name, l.unit unit, round(sum(l.qty),2) qty, round(sum(l.amount),2) amount, count(distinct l.bill_id) bills
      from bill_lines l join bills b on b.id=l.bill_id
      where b.cancelled=0 and b.created_at>=? and b.created_at<? group by l.code, l.unit order by amount desc limit 2000`).all(a, b);
  }
  /* ---------- Google Sheet sync queue ---------- */
  syncOn() { return !!this.getSetting('sheet_url'); }
  enqueue(kind, payload) {
    if (kind !== 'items') this.setSetting('items_dirty', '1');
    if (!this.syncOn()) return;
    this.db.prepare('insert into sync_queue(kind,payload,created_at) values(?,?,?)').run(kind, JSON.stringify(payload), nowLocal());
  }
  queuePeek(n) { return this.db.prepare('select id,kind,payload,tries from sync_queue order by id limit ?').all(n); }
  queueDone(ids) { const d = this.db.prepare('delete from sync_queue where id=?'); this.db.transaction(() => ids.forEach(i => d.run(i)))(); }
  queueFail(ids, err) { const u = this.db.prepare('update sync_queue set tries=tries+1, last_error=? where id=?'); this.db.transaction(() => ids.forEach(i => u.run(String(err).slice(0, 300), i)))(); }
  queueCount() { return this.db.prepare('select count(*) n from sync_queue').get().n; }
  queueAllBills() {
    const ids = this.db.prepare('select id from bills order by id').all().map(r => r.id);
    const ins = this.db.prepare('insert into sync_queue(kind,payload,created_at) values(?,?,?)');
    this.db.transaction(() => { for (const id of ids) ins.run('bill', JSON.stringify(this.getBill(id)), nowLocal()); })();
    this.setSetting('items_dirty', '1');
    return ids.length;
  }
  /* ---------- link with the phone app ---------- */
  linkOn() { return !!this.getSetting('link_key'); }
  linkPush(kind, payload) {
    if (!this.linkOn()) return;
    this.db.prepare('insert into link_queue(kind,payload,created_at) values(?,?,?)').run(kind, JSON.stringify(payload), nowLocal());
  }
  linkPeek(n) { return this.db.prepare('select id,kind,payload,tries from link_queue order by id limit ?').all(n); }
  linkDone(ids) { const d = this.db.prepare('delete from link_queue where id=?'); this.db.transaction(() => ids.forEach(i => d.run(i)))(); }
  linkFail(ids, err) { const u = this.db.prepare('update link_queue set tries=tries+1, last_error=? where id=?'); this.db.transaction(() => ids.forEach(i => u.run(String(err).slice(0, 300), i)))(); }
  linkCount() { return this.db.prepare('select count(*) n from link_queue').get().n; }
  linkClear() { this.db.prepare('delete from link_queue').run(); }
  /* Items as the phone app's server has them (server stock is the shared truth once linked). */
  applyRemoteItems(list) {
    let changed = 0;
    const get = this.db.prepare('select * from items where code=?');
    const up = this.db.prepare(`insert into items(code,name,retail,wholesale,wholesale_unit,wholesale_qty,cost,stock,min_stock,unit,gst,hsn,active,created_at,updated_at)
      values(@code,@name,@retail,@wholesale,@wholesale_unit,@wholesale_qty,@cost,@stock,@min_stock,@unit,@gst,@hsn,@active,@now,@now)
      on conflict(code) do update set name=excluded.name, retail=excluded.retail, wholesale=excluded.wholesale, wholesale_unit=excluded.wholesale_unit,
        wholesale_qty=excluded.wholesale_qty, cost=excluded.cost, stock=excluded.stock, min_stock=excluded.min_stock, unit=excluded.unit, gst=excluded.gst,
        hsn=excluded.hsn, active=excluded.active, updated_at=excluded.updated_at`);
    this.db.transaction(() => {
      for (const r of list) {
        const row = { code: String(r.code), name: String(r.name || r.code), retail: r2(r.retail), wholesale: r2(r.wholesale), wholesale_unit: r.wholesale_unit || '',
          wholesale_qty: +r.wholesale_qty > 0 ? +r.wholesale_qty : 1, cost: r2(r.cost), stock: r.stock == null ? null : r2(r.stock), min_stock: r.min_stock == null ? null : r2(r.min_stock),
          unit: r.unit || 'pcs', gst: +r.gst || 0, hsn: r.hsn || '', active: r.removed ? 0 : 1, now: nowLocal() };
        const cur = get.get(row.code);
        if (!cur && !row.active) continue;
        const same = cur && ['name', 'retail', 'wholesale', 'wholesale_unit', 'wholesale_qty', 'cost', 'stock', 'min_stock', 'unit', 'gst', 'hsn', 'active'].every(k => (cur[k] ?? null) == (row[k] ?? null));
        if (same) continue;
        up.run(row); changed++;
      }
    })();
    return changed;
  }
  /* Bills made on phones, kept here for sales reports. Stock already counted on the server. */
  importPhoneBills(list) {
    let n = 0;
    const has = this.db.prepare('select id from bills where bill_no=?');
    this.db.transaction(() => {
      for (const b of list) {
        const no = 'M' + b.id;
        if (has.get(no)) { if (b.deleted) this.db.prepare('update bills set cancelled=1 where bill_no=? and cancelled=0').run(no); continue; }
        const lines = Array.isArray(b.lines) ? b.lines : [];
        const qty = r2(lines.reduce((a, l) => a + (+l.qty || 0), 0));
        const info = this.db.prepare(`insert into bills(bill_no,created_at,mode,payment,customer,phone,items_count,qty,subtotal,discount,total,gst,cancelled)
          values(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(no, String(b.created_at).slice(0, 19), b.mode || 'retail', b.payment || 'cash', b.customer || '', b.phone || '',
          lines.length, qty, r2(b.subtotal), r2(b.discount), r2(b.total), r2(b.gst), b.deleted ? 1 : 0);
        const ins = this.db.prepare('insert into bill_lines(bill_id,code,name,unit,hsn,gst,qty,rate,amount,factor) values(?,?,?,?,?,?,?,?,?,?)');
        for (const l of lines) ins.run(info.lastInsertRowid, String(l.code), String(l.name || l.code), l.unit || 'pcs', l.hsn || '', +l.gst || 0, +l.qty || 0, r2(l.price), r2(l.amount), +l.factor || 1);
        this.enqueue('bill', this.getBill(info.lastInsertRowid));
        n++;
      }
    })();
    return n;
  }
  counts() {
    return this.db.prepare(`select (select count(*) from items where active=1) items, (select count(*) from bills) bills`).get();
  }
}

module.exports = { Store, nowLocal, r2 };

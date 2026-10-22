// NRRL Billing — every action the screen can ask for. Shared by the app and the test harness.
'use strict';
const P = require('./print');

const WRITES = new Set(['sync.connect', 'items.save', 'items.remove', 'items.import', 'items.stockIn', 'items.nextCode', 'bills.save', 'bills.cancel',
  'settings.save', 'auth.setPin', 'items.fixCodes', 'labels.useSize', 'labels.addSize', 'labels.removeSize', 'labels.setLogo',
  'customers.save', 'customers.add', 'payments.receive', 'payments.cancel', 'returns.save', 'suppliers.save', 'suppliers.pay', 'suppliers.cancelPay',
  'purchases.save', 'purchases.cancel']);

// What a signed-in staff member needs for each action (the owner switches these per person in the phone app).
const NEED = {
  'items.remove': 'edit', 'items.import': 'edit', 'items.stockIn': 'edit', 'items.fixCodes': 'edit',
  'bills.save': 'bill', 'bills.cancel': 'cancel', 'print.labels': 'labels', 'print.testLabel': 'labels',
  'settings.save': 'settings', 'auth.setPin': 'settings', 'link.connect': 'settings', 'link.unlink': 'settings',
  'sync.connect': 'settings', 'sync.disconnect': 'settings', 'backup.restore': 'settings', 'backup.chooseExtra': 'settings',
  'labels.addSize': 'settings',
  'customers.list': 'sales', 'customers.get': 'sales', 'customers.save': 'edit', 'customers.add': 'bill', 'payments.receive': 'bill', 'payments.cancel': 'cancel',
  'returns.save': 'cancel', 'purchases.save': 'edit', 'purchases.cancel': 'edit', 'purchases.list': 'edit', 'purchases.get': 'edit',
  'suppliers.list': 'edit', 'suppliers.get': 'edit', 'suppliers.save': 'edit', 'suppliers.pay': 'edit', 'suppliers.cancelPay': 'edit',
  'audit.list': 'settings', 'labels.removeSize': 'settings', 'labels.setLogo': 'settings',
};
const PERM_DEF = { bill: true, rate: false, stock: true, add: true, edit: false, sales: true, reports: false, cancel: false, labels: true, settings: false };

function makeHandlers(ctx) {
  const st = () => ctx.getStore();
  const settings = () => { const s = st().getSettings(); return s; };
  let user = null, ownerUntil = 0;
  const can = k => !user || user.role === 'owner' || Date.now() < ownerUntil || !!((user.perms && k in user.perms) ? user.perms[k] : PERM_DEF[k]);
  const deny = k => { if (!can(k)) throw new Error('You don’t have access to this. Ask the owner.'); };
  const who = () => user ? user.name + (user.role !== 'owner' && Date.now() < ownerUntil ? ' (owner PIN)' : '') : (Date.now() < ownerUntil ? 'Owner (PIN)' : 'Counter');
  const range = (from, to) => st()._range(from, to);
  const H = {
    'customers.list': q => st().customers(q),
    'customers.get': id => st().customer(id),
    'customers.find': (name, phone) => st().customerFind(name, phone),
    'customers.save': (id, p) => st().saveCustomer(id, p),
    'customers.add': p => { if (+p.opening && !can('edit')) throw new Error('Only the owner can set an opening balance.'); return st().addCustomer(p); },
    'customers.udhaarTotal': () => st().udhaarTotal(),
    'payments.receive': (id, amount, mode, note) => st().receivePayment(id, amount, mode, note),
    'payments.cancel': id => st().cancelPayment(id),
    'returns.info': billId => st().returnable(billId),
    'returns.save': p => st().saveReturn(p),
    'returns.list': (from, to) => st().listReturns(...range(from, to)),
    'returns.get': id => st().getReturn(id),
    'print.return': async id => { const r = st().getReturn(id); if (!r) throw new Error('Return not found.'); await ctx.printReceipt(P.returnBill(r, st().getBill(r.bill_id)), settings(), { title: 'RETURN / CREDIT NOTE' }); return true; },
    'suppliers.list': () => st().suppliers(),
    'suppliers.get': id => st().supplier(id),
    'suppliers.save': (id, p) => st().saveSupplier(id, p),
    'suppliers.pay': (id, amount, mode, note) => st().paySupplier(id, amount, mode, note),
    'suppliers.cancelPay': id => st().cancelSupplierPayment(id),
    'suppliers.owed': () => st().suppliersOwed(),
    'purchases.save': p => st().savePurchase(p),
    'purchases.list': (from, to) => st().listPurchases(...range(from, to)),
    'purchases.get': id => st().getPurchase(id),
    'purchases.cancel': id => st().cancelPurchase(id),
    'audit.list': q => st().auditList(q || {}),
    'app.openUrl': url => { if (!/^https:\/\/(wa\.me|api\.whatsapp\.com)\//.test(String(url))) throw new Error('Not allowed.'); return ctx.openUrl ? ctx.openUrl(url) : false; },
    'auth.state': () => ({ linked: !!st().getSetting('link_key'), staff: st().staffList().filter(x => x.active).map(x => ({ id: x.id, name: x.name, role: x.role })), user, ownerUntil }),
    'auth.login': async (id, pin) => {
      if (!ctx.link || !ctx.link.staffLogin) throw new Error('Not available.');
      try { user = await ctx.link.staffLogin(id, pin); }
      catch (e) { const x = st().staffList().find(s => s.id === id); st().who = x ? x.name : '?'; st().audit('signin.failed', x ? x.name : id, e.message); throw e; }
      ownerUntil = 0; st().who = user.name; st().audit('signin', user.name, '');
      return user;
    },
    'auth.logout': () => { if (user) { st().who = user.name; st().audit('signout', user.name, ''); } user = null; ownerUntil = 0; return true; },
    // the owner's PIN unlocks everything for 15 minutes (laptop owner PIN, or an owner's phone-app PIN)
    'auth.owner': async (pin, ownerId) => {
      let ok = st().hasPin() && st().checkPin(pin);
      if (!ok && ctx.link && ctx.link.staffLogin) {
        const owners = st().staffList().filter(x => x.role === 'owner' && x.active && (!ownerId || x.id === ownerId));
        for (const o of owners) { try { await ctx.link.staffLogin(o.id, pin); ok = true; break; } catch (e) { if (/blocked|internet/i.test(e.message) && owners.length === 1) throw e; } }
      }
      st().who = user ? user.name : 'Counter';
      st().audit(ok ? 'owner.unlock' : 'owner.pin.wrong', '', ok ? 'owner PIN entered (15 minutes)' : 'wrong owner PIN');
      if (ok) ownerUntil = Date.now() + 15 * 60e3;
      return ok;
    },
    'auth.lockOwner': () => { ownerUntil = 0; return true; },
    'auth.refresh': () => { // perms changed on the phone app: pick up the new switches, sign out if blocked
      if (!user) return null;
      const me = st().staffList().find(x => x.id === user.id);
      if (!me || !me.active) { user = null; return null; }
      user = { ...user, ...me };
      return user;
    },
    'app.info': () => ({ ...ctx.info(), counts: st().counts() }),
    'app.openDataFolder': () => ctx.openDataFolder(),

    'items.all': () => st().allItems(),
    'items.save': (item, oldCode) => {
      const exists = oldCode != null || !!st().getItem(item && item.code);
      deny(exists ? 'edit' : 'add');
      if (exists && !can('stock')) { const cur = st().getItem(oldCode != null ? oldCode : item.code); if (cur) item = { ...item, stock: cur.stock }; }
      return st().saveItem(item, oldCode);
    },
    // give every item whose code is too long for the label in use a short code (NR10023…) that scans easily
    'items.fixCodes': async codes => {
      const s = settings(), out = [];
      for (const code of (codes || [])) {
        const it = st().getItem(code); if (!it) continue;
        if ((await P.barcodeImage(it.code, s)).fits) continue;
        const nc = st().nextCode();
        const saved = st().saveItem({ ...it, code: nc }, it.code);
        out.push({ from: code, to: saved.code });
      }
      return out;
    },
    'labels.sizes': () => { const list = st().labelSizes(); return { active: st().getSetting('label_size'), list: list.map(z => ({ ...z, name: st().labelSizeName(z) })) }; },
    'labels.useSize': id => st().useLabelSize(id),
    'labels.addSize': z => st().addLabelSize(z),
    'labels.removeSize': id => st().removeLabelSize(id),
    'labels.setLogo': (png, bits) => st().setLabelLogo(png, bits),
    'items.remove': code => st().removeItem(code),
    'items.import': rows => st().importItems(rows),
    'items.stockIn': (code, qty, note) => st().stockIn(code, qty, note),
    'items.nextCode': () => st().nextCode(),
    'items.history': code => st().itemHistory(code),

    'bills.save': p => { if (!can('rate')) { p = { ...p, discount: 0, lines: (p.lines || []).map(l => ({ ...l, rate: '' })) }; } return st().saveBill({ ...p, staff: user ? user.name : '' }); },
    'bills.get': id => st().getBill(id),
    'bills.last': () => st().lastBill(),
    'bills.list': (from, to) => st().listBills(from, to),
    'bills.cancel': id => st().cancelBill(id),
    'reports.summary': (from, to) => st().summary(from, to),
    'reports.items': (from, to) => st().itemSales(from, to),

    'print.receipt': async (id, duplicate) => {
      const b = st().billFull(id);
      if (!b) throw new Error('Bill not found.');
      await ctx.printReceipt(b, settings(), { duplicate: !!duplicate });
      return true;
    },
    'print.preview': (id, duplicate) => {
      const b = id === 'sample' ? P.sampleBill() : st().getBill(id);
      if (!b) throw new Error('Bill not found.');
      return P.receiptHTML(id === 'sample' ? b : st().billFull(id), settings(), { duplicate: !!duplicate });
    },
    // A4 invoice or thermal receipt; format '' = the default chosen in Settings
    'print.bill': async (id, format, duplicate) => {
      const b = st().billFull(id); if (!b) throw new Error('Bill not found.');
      const s = settings(), f = format || s.bill_format || 'thermal';
      if (f === 'a4') await ctx.printA4(b, s, { duplicate: !!duplicate });
      else await ctx.printReceipt(b, s, { duplicate: !!duplicate });
      return f;
    },
    'print.a4preview': id => { const b = id === 'sample' ? P.sampleBill() : st().billFull(id); if (!b) throw new Error('Bill not found.'); return P.a4HTML(b, settings(), {}); },
    'bills.pdf': async id => { const b = st().billFull(id); if (!b) throw new Error('Bill not found.'); return ctx.billPdf(b, settings()); },
    // makes the PDF, puts it on the clipboard and opens the customer's WhatsApp chat: press Ctrl+V, then Enter
    'bills.whatsapp': async (id, phone) => {
      const b = st().billFull(id); if (!b) throw new Error('Bill not found.');
      const s = settings(), file = await ctx.billPdf(b, s);
      const copied = await ctx.copyFile(file).catch(() => false);
      let p = String(phone || b.phone || '').replace(/\D/g, ''); if (p.length === 10) p = '91' + p;
      const text = `${s.shop_name || 'NRRL'} · Bill ${b.bill_no} · ₹${b.total}. Thank you!`;
      await ctx.openWhatsApp(p, text, s.wa_mode);
      return { file, copied, phone: p };
    },
    'bills.showFile': file => ctx.showFile(file),
    'print.test': async () => { await ctx.printReceipt(P.sampleBill(), settings(), {}); return true; },
    'print.labels': async (list, show) => {
      // list: [{code, count}]; show: {retail, wholesale} chosen in the print window (remembered for next time)
      const entries = (Array.isArray(list) ? list : []).map(e => ({ item: st().getItem(e.code), count: e.count }));
      const missing = entries.find(e => !e.item);
      if (missing) throw new Error('An item on the label list no longer exists. Remove it and try again.');
      if (show && show.size && show.size !== st().getSetting('label_size')) st().useLabelSize(show.size);
      if (show) st().saveSettings({ label_price: show.retail ? '1' : '0', label_wcode: show.wholesale ? '1' : '0', ...(show.logo != null ? { label_show_logo: show.logo ? '1' : '0' } : {}), ...(show.rateSize ? { label_rate_size: String(show.rateSize) } : {}) });
      return ctx.printLabels(entries, settings());
    },
    'print.labelPreview': async code => {
      const s = settings();
      const it = (code && st().getItem(code)) || { code: 'NR10001', name: 'Sample item name', retail: 99 };
      const { across } = P.labelSize(s);
      return (await P.buildLabels([{ item: it, count: across }], s)).html;
    },
    'print.testLabel': async () => {
      const first = st().allItems()[0];
      const it = first ? st().getItem(first.code) : { code: 'NR10001', name: 'Test label', retail: 99 };
      return ctx.printLabels([{ item: it, count: P.labelSize(settings()).across }], settings());
    },
    'print.labelInfo': async code => {
      const s = settings();
      const bc = await P.barcodeImage(code || 'NR10001', s);
      return { widthMm: bc.widthMm, moduleMm: bc.moduleMm, dots: bc.dots, fits: bc.fits, ...P.labelSize(s) };
    },
    'printers.list': () => ctx.listPrinters(),

    'settings.get': () => settings(),
    'settings.save': obj => st().saveSettings(obj),
    'auth.check': pin => { const ok = st().checkPin(pin); if (ok && st().hasPin()) ownerUntil = Date.now() + 15 * 60e3; return ok; },
    'auth.setPin': (oldPin, newPin) => st().setPin(oldPin, newPin),

    'link.status': () => ctx.link.status(),
    'link.owners': () => ctx.link.owners(),
    'link.connect': (staffId, pin) => ctx.link.link(staffId, pin, ctx.progress),
    'link.now': async () => { await ctx.link.tick(); return ctx.link.status(); },
    'link.unlink': () => ctx.link.unlink(),
    'sync.status': () => ctx.sync.status(),
    'sync.script': () => ctx.sync.script(),
    'sync.connect': (url, key) => ctx.sync.test(url, key),
    'sync.key': () => ctx.sync.key(),
    'sync.now': async () => { await ctx.sync.tick(); return ctx.sync.status(); },
    'sync.disconnect': () => ctx.sync.disconnect(),
    'clipboard.write': text => ctx.copy(text),

    'backup.now': () => ctx.backupNow('manual'),
    'backup.list': () => ctx.backupList(),
    'backup.openFolder': () => ctx.openBackupFolder(),
    'backup.chooseExtra': () => ctx.chooseExtraFolder(),
    'backup.restore': () => ctx.restore(),

    'file.saveText': (name, text) => ctx.saveText(name, text),
    'file.openText': () => ctx.openText(),
  };
  for (const [m, k] of Object.entries(NEED)) {
    const fn = H[m]; if (!fn) continue;
    H[m] = (...a) => { deny(k); return fn(...a); };
  }
  // every change is written to the change log under the name of whoever is signed in
  for (const m of Object.keys(H)) { if (m.startsWith('auth.')) continue; const fn = H[m]; H[m] = (...a) => { try { st().who = who(); } catch (e) {} return fn(...a); }; }
  return H;
}

module.exports = { makeHandlers, WRITES };

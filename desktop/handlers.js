// NRRL Billing — every action the screen can ask for. Shared by the app and the test harness.
'use strict';
const P = require('./print');

const WRITES = new Set(['sync.connect', 'items.save', 'items.remove', 'items.import', 'items.stockIn', 'items.nextCode', 'bills.save', 'bills.cancel',
  'settings.save', 'auth.setPin']);

function makeHandlers(ctx) {
  const st = () => ctx.getStore();
  const settings = () => { const s = st().getSettings(); return s; };
  return {
    'app.info': () => ({ ...ctx.info(), counts: st().counts() }),
    'app.openDataFolder': () => ctx.openDataFolder(),

    'items.all': () => st().allItems(),
    'items.save': (item, oldCode) => st().saveItem(item, oldCode),
    'items.remove': code => st().removeItem(code),
    'items.import': rows => st().importItems(rows),
    'items.stockIn': (code, qty, note) => st().stockIn(code, qty, note),
    'items.nextCode': () => st().nextCode(),
    'items.history': code => st().itemHistory(code),

    'bills.save': p => st().saveBill(p),
    'bills.get': id => st().getBill(id),
    'bills.last': () => st().lastBill(),
    'bills.list': (from, to) => st().listBills(from, to),
    'bills.cancel': id => st().cancelBill(id),
    'reports.summary': (from, to) => st().summary(from, to),
    'reports.items': (from, to) => st().itemSales(from, to),

    'print.receipt': async (id, duplicate) => {
      const b = st().getBill(id);
      if (!b) throw new Error('Bill not found.');
      await ctx.printReceipt(b, settings(), { duplicate: !!duplicate });
      return true;
    },
    'print.preview': (id, duplicate) => {
      const b = id === 'sample' ? P.sampleBill() : st().getBill(id);
      if (!b) throw new Error('Bill not found.');
      return P.receiptHTML(b, settings(), { duplicate: !!duplicate });
    },
    'print.test': async () => { await ctx.printReceipt(P.sampleBill(), settings(), {}); return true; },
    'print.labels': async (list) => {
      // list: [{code, count}]
      const entries = (Array.isArray(list) ? list : []).map(e => ({ item: st().getItem(e.code), count: e.count }));
      const missing = entries.find(e => !e.item);
      if (missing) throw new Error('An item on the label list no longer exists. Remove it and try again.');
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
    'auth.check': pin => st().checkPin(pin),
    'auth.setPin': (oldPin, newPin) => st().setPin(oldPin, newPin),

    'link.status': () => ctx.link.status(),
    'link.owners': () => ctx.link.owners(),
    'link.connect': (staffId, pin) => ctx.link.link(staffId, pin, ctx.progress),
    'link.now': async () => { await ctx.link.tick(); return ctx.link.status(); },
    'link.unlink': () => ctx.link.unlink(),
    'sync.status': () => ctx.sync.status(),
    'sync.script': () => ctx.sync.script(),
    'sync.connect': url => ctx.sync.test(url),
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
}

module.exports = { makeHandlers, WRITES };

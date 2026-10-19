// NRRL Billing — every action the screen can ask for. Shared by the app and the test harness.
'use strict';
const P = require('./print');

const WRITES = new Set(['items.save', 'items.remove', 'items.import', 'items.stockIn', 'items.nextCode', 'bills.save', 'bills.cancel',
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
    'print.labels': async (code, count) => {
      const it = st().getItem(code);
      if (!it) throw new Error('Item not found.');
      await ctx.printLabels(it, count, settings());
      return true;
    },
    'print.labelPreview': code => {
      const it = st().getItem(code) || { code: code || 'NR10001', name: 'Sample item name', retail: 99 };
      return P.labelsHTML(it, 1, settings(), P.barcodeSVG(it.code));
    },
    'printers.list': () => ctx.listPrinters(),

    'settings.get': () => settings(),
    'settings.save': obj => st().saveSettings(obj),
    'auth.check': pin => st().checkPin(pin),
    'auth.setPin': (oldPin, newPin) => st().setPin(oldPin, newPin),

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

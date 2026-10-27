/* NRRL Billing → Google Sheet
   Paste this whole file into Extensions → Apps Script of your Google Sheet, then Deploy as a Web app.
   The app sends each bill here; this script writes it into the sheet. */
const KEY = '__KEY__';

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    if (body.key !== KEY) return out({ ok: false, error: 'Wrong key. Copy the setup script again from NRRL Billing.' });
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    setup(ss);
    let done = 0;
    for (const ev of body.events || []) {
      if (ev.type === 'bill') addBill(ss, ev.bill);
      else if (ev.type === 'cancel') cancelBill(ss, ev.bill_no);
      else if (ev.type === 'items') writeItems(ss, ev.items || [], ev.at);
      else if (ev.type === 'table') writeTable(ss, ev.name, ev.header || [], ev.rows || [], ev.at);
      done++;
    }
    return out({ ok: true, done, v: 2 });
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}
function doGet() { return out({ ok: true, app: 'NRRL Billing sheet', v: 2 }); }
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

const H = {
  Bills: ['Bill No', 'Date', 'Time', 'Customer', 'Phone', 'Payment', 'Rate list', 'Items', 'Qty', 'Subtotal', 'Discount', 'Total', 'GST incl.', 'Status'],
  'Bill items': ['Bill No', 'Date', 'Code', 'Item', 'Qty', 'Unit', 'Rate', 'Amount'],
  Daily: ['Date', 'Bills', 'Total', 'Cash', 'UPI', 'Card', 'Udhaar'],
  Items: ['Code', 'Item', 'Retail', 'Per', 'Wholesale', 'Per', 'Stock', 'Unit', 'GST %', 'HSN'],
};
function setup(ss) {
  if (ss.getSheetByName('Daily')) return;
  ss.setSpreadsheetTimeZone('Asia/Kolkata');
  for (const name of ['Daily', 'Bills', 'Bill items', 'Items']) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, H[name].length).setValues([H[name]]).setFontWeight('bold').setBackground('#ece8fb');
    sh.setFrozenRows(1);
  }
  const first = ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0) ss.deleteSheet(first);
  ss.setActiveSheet(ss.getSheetByName('Daily'));
  ss.moveActiveSheet(1);
}
function findRow(sh, value, col) {
  if (sh.getLastRow() < 2) return 0;
  const f = sh.getRange(2, col || 1, sh.getLastRow() - 1, 1).createTextFinder(String(value)).matchEntireCell(true).findNext();
  return f ? f.getRow() : 0;
}
const PAY = { cash: 'Cash', upi: 'UPI', card: 'Card', udhaar: 'Udhaar' };
function addBill(ss, b) {
  const bills = ss.getSheetByName('Bills');
  const status = b.cancelled ? 'Cancelled' : 'OK';
  const existing = findRow(bills, b.bill_no);
  if (existing) {
    // already sent earlier: only a cancellation can change it
    if (b.cancelled && bills.getRange(existing, 14).getValue() !== 'Cancelled') cancelBill(ss, b.bill_no);
    return;
  }
  const [date, time] = String(b.created_at).split(' ');
  bills.insertRowBefore(2);
  bills.getRange(2, 1, 1, 14).setValues([["'" + b.bill_no, "'" + date, "'" + (time || '').slice(0, 5), b.customer || '', b.phone || '', PAY[b.payment] || b.payment,
    b.mode === 'wholesale' ? 'Wholesale' : 'Retail', b.items_count, b.qty, b.subtotal, b.discount, b.total, b.gst, status]]);
  bills.getRange(2, 1, 1, 14).setFontWeight('normal').setBackground(null);
  const lines = (b.lines || []).map(l => ["'" + b.bill_no, "'" + date, "'" + l.code, l.name, l.qty, l.unit, l.rate, l.amount]);
  if (lines.length) {
    const li = ss.getSheetByName('Bill items');
    li.getRange(li.getLastRow() + 1, 1, lines.length, 8).setValues(lines);
  }
  if (!b.cancelled) addToDay(ss, date, b.payment, b.total, 1);
}
function cancelBill(ss, billNo) {
  const bills = ss.getSheetByName('Bills');
  const r = findRow(bills, billNo);
  if (!r) return;
  const row = bills.getRange(r, 1, 1, 14).getValues()[0];
  if (row[13] === 'Cancelled') return;
  bills.getRange(r, 14).setValue('Cancelled');
  bills.getRange(r, 1, 1, 14).setFontColor('#999999');
  const pay = Object.keys(PAY).find(k => PAY[k] === row[5]) || 'cash';
  addToDay(ss, row[1] instanceof Date ? Utilities.formatDate(row[1], 'Asia/Kolkata', 'yyyy-MM-dd') : String(row[1]).replace(/^'/, ''), pay, -Number(row[11] || 0), -1);
}
function addToDay(ss, date, payment, amount, count) {
  const d = ss.getSheetByName('Daily');
  let r = findRow(d, date);
  if (!r) {
    // newest day at the top
    d.insertRowBefore(2);
    d.getRange(2, 1, 1, 7).setValues([["'" + date, 0, 0, 0, 0, 0, 0]]).setFontWeight('normal').setBackground(null);
    r = 2;
  }
  const v = d.getRange(r, 1, 1, 7).getValues()[0];
  const col = { cash: 3, upi: 4, card: 5, udhaar: 6 }[payment] ?? 3;
  v[0] = "'" + date;
  v[1] = Number(v[1] || 0) + count;
  v[2] = Math.round((Number(v[2] || 0) + amount) * 100) / 100;
  v[col] = Math.round((Number(v[col] || 0) + amount) * 100) / 100;
  d.getRange(r, 1, 1, 7).setValues([v]);
}
function writeItems(ss, items, at) {
  const sh = ss.getSheetByName('Items');
  const rows = items.map(i => ["'" + i.code, i.name, i.retail, i.unit, i.wholesale || '', i.wholesale ? (i.wholesale_unit || i.unit) : '', i.stock == null ? '' : i.stock, i.unit, i.gst, i.hsn || '']);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 10).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, 10).setValues(rows);
  sh.getRange(1, 12).setValue('Updated ' + (at || ''));
}
// a whole tab written fresh each time: Udhaar, Payments, Returns, Purchases, Suppliers
const TABLES = ['Udhaar', 'Payments', 'Returns', 'Purchases', 'Suppliers'];
function writeTable(ss, name, header, rows, at) {
  if (TABLES.indexOf(name) < 0 || !header.length) return;
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.setFrozenRows(1);
  }
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#ece8fb');
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(sh.getLastColumn(), header.length)).clearContent();
  const clean = rows.map(r => header.map((_, i) => r[i] == null ? '' : r[i]));
  if (clean.length) sh.getRange(2, 1, clean.length, header.length).setValues(clean);
  sh.getRange(1, header.length + 2).setValue('Updated ' + (at || ''));
}

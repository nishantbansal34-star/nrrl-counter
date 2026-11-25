// NRRL Billing — prints labels sent from the phone app. A phone puts a print job on the server; this laptop
// (when it is linked, has a label printer and "Print labels sent from phones" is on) takes it and prints it.
'use strict';
const { rpc } = require('./link');
const VERSION = (() => { try { return require('./package.json').version || ''; } catch (e) { return ''; } })();

function createPrintJobs({ getStore, printLabels, notify, syncNow }) {
  const state = { busy: false, lastBeat: 0, lastError: '', printed: 0, last: null };
  let timer = null;
  const printerOf = s => s.label_printer || s.printer || '';
  const accepts = s => s.print_from_phones !== '0' && !!printerOf(s);

  async function heartbeat(st, key, force) {
    if (!force && Date.now() - state.lastBeat < 30000) return;
    const s = st.getSettings();
    await rpc('counter_dev_printer_put', { p_key: key, p_info: {
      name: (st.getSetting('link_name') || 'Laptop').replace(/^Laptop \((.*)\) #\w+$/, '$1'), printer: printerOf(s),
      sizes: st.labelSizes().map(z => ({ id: z.id, w: +z.w, h: +z.h, across: +z.across })), size_id: st.getSetting('label_size') || '',
      accepts: accepts(s), version: VERSION } });
    state.lastBeat = Date.now();
  }
  async function printJob(st, job) {
    const s0 = st.getSettings();
    const z = st.labelSizes().find(x => x.id === (job.opts && job.opts.size_id)) || st.labelSizes().find(x => x.id === s0.label_size) || st.labelSizes()[0];
    const s = { ...s0, label_w: z.w, label_h: z.h, label_across: z.across, label_gap: z.gap ?? '', label_vgap: z.vgap ?? '', label_shift: z.shift ?? '' };
    if (/^[A-I]$/.test(job.opts && job.opts.layout || '')) s.label_layout = job.opts.layout;
    if (['both', 'retail', 'wholesale'].includes(job.opts && job.opts.emph)) s.label_style = job.opts.emph;
    // what the phone chose to show, and how big
    if (job.opts && typeof job.opts.retail === 'boolean') s.label_price = job.opts.retail ? '1' : '0';
    if (job.opts && typeof job.opts.wholesale === 'boolean') s.label_wcode = job.opts.wholesale ? '1' : '0';
    if (job.opts && +job.opts.rate >= 70 && +job.opts.rate <= 300) s.label_rate_size = String(Math.round(+job.opts.rate));
    const entries = (job.items || []).map(x => ({ item: st.getItem(String(x.code)), code: x.code, count: +x.count || 0 }));
    const missing = entries.filter(e => !e.item || !e.item.active).map(e => e.code);
    if (missing.length) throw Object.assign(new Error(`Not on this laptop yet: ${missing.join(', ')}. Try again in a minute.`), { missing: true });
    return printLabels(entries.map(e => ({ item: e.item, count: e.count })), s);
  }
  async function tick(force) {
    const st = getStore();
    if (!st || state.busy) return;
    const key = st.getSetting('link_key');
    if (!key) return;
    state.busy = true;
    try {
      await heartbeat(st, key, force);
      if (!accepts(st.getSettings())) return;
      for (let n = 0; n < 5; n++) {
        const job = await rpc('counter_dev_print_take', { p_key: key });
        if (!job || !job.id) break;
        let ok = true, err = '', labels = 0;
        try {
          try { labels = await printJob(st, job); }
          catch (e) { if (!e.missing || !syncNow) throw e; await syncNow(); labels = await printJob(st, job); } // a new item may not have arrived yet
        }
        catch (e) { ok = false; err = e.message || String(e); }
        await rpc('counter_dev_print_done', { p_key: key, p_id: job.id, p_ok: ok, p_error: err, p_labels: +labels || 0 }).catch(() => {});
        st.who = job.staff_name || 'Phone';
        st.audit(ok ? 'labels.phone' : 'labels.phone.failed', job.items.map(x => x.code).join(', '), ok ? `${labels} labels sent from ${job.staff_name || 'a phone'}` : err);
        state.last = { ok, labels, by: job.staff_name, error: err, at: new Date().toISOString() };
        if (ok) state.printed += labels || 0;
        notify && notify(state.last);
      }
      state.lastError = '';
    } catch (e) { state.lastError = e.message; }
    finally { state.busy = false; }
  }
  return {
    start() { if (!timer) timer = setInterval(() => tick().catch(() => {}), 4000); setTimeout(() => tick(true).catch(() => {}), 4000); },
    soon() { state.lastBeat = 0; setTimeout(() => tick(true).catch(() => {}), 300); },
    tick,
    status() { const st = getStore(); const s = st.getSettings(); return { linked: !!st.getSetting('link_key'), printer: printerOf(s), accepts: accepts(s), lastError: state.lastError, last: state.last, printed: state.printed }; },
  };
}
module.exports = { createPrintJobs };

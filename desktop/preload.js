// Bridge between the screen and the app. The screen only gets this one function.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  call: async (method, ...args) => {
    const r = await ipcRenderer.invoke('rpc', method, args);
    if (!r || !r.ok) throw new Error((r && r.error) || 'Something went wrong.');
    return r.data;
  },
  on: (channel, cb) => {
    if (!['data-changed', 'link-progress'].includes(channel)) return;
    ipcRenderer.on(channel, (e, data) => cb(data));
  },
});

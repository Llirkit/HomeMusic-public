const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('HomeMusicSetup', {
    getConfig: () => ipcRenderer.invoke('hm:get-config'),
    connect: (url) => ipcRenderer.invoke('hm:connect', url),
  });
}

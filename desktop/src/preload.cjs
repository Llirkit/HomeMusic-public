const { contextBridge, ipcRenderer } = require('electron');

// No generic IPC or Node APIs are exposed to the remotely loaded interface.
if (process.isMainFrame) {
  const origin = process.argv.find((arg) => arg.startsWith('--homemusic-origin='))?.slice('--homemusic-origin='.length);
  if (origin && location.origin === origin) {
    contextBridge.exposeInMainWorld('HomeMusicDesktop', {
      updatePlayer: (state) => ipcRenderer.send('hm:player-state', state),
      onCommand: (callback) => {
        const listener = (_event, command) => {
          if (['toggle', 'previous', 'next'].includes(command)) callback(command);
        };
        ipcRenderer.on('hm:player-command', listener);
        return () => ipcRenderer.removeListener('hm:player-command', listener);
      },
    });
  }
}

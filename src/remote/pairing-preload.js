const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('homeTubePairing', {
    close() {
        return ipcRenderer.invoke('remote-close-pairing-view')
    },
    onState(callback) {
        if (typeof callback !== 'function') return;
        ipcRenderer.on('remote-pairing-state', (_event, state) => callback(state))
    }
})

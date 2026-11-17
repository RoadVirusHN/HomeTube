const { createRemoteServer } = require('./server')
const QRCode = require('qrcode')
const path = require('path')

let service = null
let pairingWindow = null
let latestPairingState = null
let cachedRemotePageQr = { url: null, dataUrl: null }
let uiLanguage = 'en'

function focusPairingWindow() {
    if (!pairingWindow || pairingWindow.isDestroyed()) return false
    if (pairingWindow.isMinimized()) pairingWindow.restore()
    pairingWindow.show()
    pairingWindow.focus()
    return true
}

function publicState(state) {
    return {
        active: !!state?.active,
        host: state?.host || null,
        port: state?.port || null,
        pairing: state?.pairing ? { expiresAt: state.pairing.expiresAt } : null,
        devices: state?.devices || []
    }
}

async function settingsState(state) {
    const safeState = publicState(state)
    if (!safeState.active) return { ...safeState, pageUrl: null, pageQrDataUrl: null }

    const pageUrl = `http://${safeState.host}:${safeState.port}/`
    if (cachedRemotePageQr.url !== pageUrl) {
        cachedRemotePageQr = {
            url: pageUrl,
            dataUrl: await QRCode.toDataURL(pageUrl, { errorCorrectionLevel: 'M', margin: 2, width: 240 })
        }
    }
    return { ...safeState, pageUrl, pageQrDataUrl: cachedRemotePageQr.dataUrl }
}

function publishPairingWindow(state) {
    latestPairingState = { ...state, uiLanguage }
    if (pairingWindow && !pairingWindow.isDestroyed() && !pairingWindow.webContents.isLoading()) {
        pairingWindow.webContents.send('remote-pairing-state', latestPairingState)
    }
}

function closePairingWindow() {
    if (!pairingWindow || pairingWindow.isDestroyed()) return false
    const window = pairingWindow
    pairingWindow = null
    window.close()
    return true
}

function openPairingWindow(electron, parent, state) {
    publishPairingWindow(state)
    if (!parent || parent.isDestroyed()) return;
    if (pairingWindow && !pairingWindow.isDestroyed()) {
        pairingWindow.show()
        pairingWindow.focus()
        return;
    }
    closePairingWindow()

    pairingWindow = new electron.BrowserWindow({
        width: 460,
        height: 720,
        minWidth: 380,
        minHeight: 600,
        parent,
        title: uiLanguage === 'ko' ? 'HomeTube 휴대폰 연결' : 'HomeTube Phone Pairing',
        backgroundColor: '#111111',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            preload: path.join(__dirname, 'pairing-preload.js')
        }
    })
    const window = pairingWindow
    window.once('ready-to-show', () => {
        if (pairingWindow === window && !window.isDestroyed()) window.show()
    })
    window.on('closed', () => {
        if (pairingWindow === window) pairingWindow = null
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.loadFile(path.join(__dirname, 'web', 'desktop.html')).then(() => {
        if (pairingWindow === window && !window.isDestroyed()) window.webContents.send('remote-pairing-state', latestPairingState)
    }).catch((error) => console.error('[remote] Failed to open pairing window', error.message || error))
}

function setup({ electron, userData, getWindow, configManager }) {
    if (service) return;
    uiLanguage = /^ko(?:[-_]|$)/i.test(electron.app.getLocale?.() || '') ? 'ko' : 'en'

    function publishConfig(enabled) {
        configManager.update({ remote_enabled: enabled })
        const win = getWindow()
        if (win && !win.isDestroyed()) win.webContents.send('config-update', configManager.get())
    }

    function isMainWindow(event) {
        const win = getWindow()
        return !!win && !win.isDestroyed() && event.sender === win.webContents
    }

    service = createRemoteServer({
        userData,
        onCommand: (message, deviceId) => {
            const win = getWindow()
            if (!win || win.isDestroyed()) return
            win.webContents.send('remote-input', { ...message, deviceId })
        },
        onPairingRequested: (state) => openPairingWindow(electron, getWindow(), state),
        onPairingCloseRequested: closePairingWindow,
        onPairingFocusRequested: focusPairingWindow,
        onChange: (state) => {
            publishPairingWindow(state)
            const win = getWindow()
            if (win && !win.isDestroyed()) {
                void settingsState(state).then((next) => {
                    if (!win.isDestroyed()) win.webContents.send('remote-state-change', next)
                }).catch((error) => console.error('[remote] Failed to create remote page QR', error.message || error))
            }
        }
    })

    electron.ipcMain.handle('remote-get-state', async (event) => isMainWindow(event) ? settingsState(service.snapshot()) : null)
    electron.ipcMain.handle('remote-start-pairing', async (event) => {
        if (!isMainWindow(event)) return { error: 'UNAUTHORIZED' };
        try {
            const state = await service.startPairing()
            publishConfig(true)
            openPairingWindow(electron, getWindow(), state)
            return await settingsState(state)
        } catch (error) {
            return { error: error.message || 'REMOTE_START_FAILED' }
        }
    })
    electron.ipcMain.handle('remote-stop', async (event) => {
        if (!isMainWindow(event)) return false;
        await service.stop()
        publishConfig(false)
        return true
    })
    electron.ipcMain.handle('remote-revoke-device', (event, deviceId) => {
        if (!isMainWindow(event) || typeof deviceId !== 'string') return false;
        return service.revoke(deviceId)
    })
    electron.ipcMain.handle('remote-close-pairing-view', (event) => {
        if (!pairingWindow || event.sender !== pairingWindow.webContents) return false
        return closePairingWindow()
    })
    electron.ipcMain.handle('remote-focus-pairing-window', (event) => {
        if (!isMainWindow(event)) return false
        return focusPairingWindow()
    })

    electron.app.on('before-quit', () => { void service?.close() })

    if (configManager.get().remote_enabled) {
        service.start().catch((error) => {
            console.error('[remote] Failed to start local server', error.message || error)
            publishConfig(false)
        })
    }
}

module.exports = { setup, publicState }

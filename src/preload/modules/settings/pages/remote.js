const { ipcRenderer } = require('electron')

let state = { active: false, pairing: null, devices: [] }
let renderPage = null
let listening = false
let startFailed = false

function update(next) {
    if (next && typeof next === 'object' && !next.error) {
        state = next
        startFailed = false
    } else if (next?.error) {
        startFailed = true
    }
    renderPage?.()
}

async function refresh() {
    update(await ipcRenderer.invoke('remote-get-state'))
}

module.exports = {
    id: 'remote',
    title: (locale) => locale.remote.title,
    description: (locale) => locale.remote.description,
    async rows(_config, locale) {
        const text = locale.remote
        const rows = [
            { type: 'info', title: text.status, value: state.active ? text.running : text.stopped },
            { type: 'info', title: text.connected, value: String((state.devices || []).filter((device) => device.connected).length) },
            { type: 'text', text: text.notice }
        ]
        if (startFailed) rows.push({ type: 'notice', tone: 'error', title: text.startFailed })

        if (!state.active) {
            rows.push({ type: 'button', title: text.start, run: async () => update(await ipcRenderer.invoke('remote-start-pairing')) })
        } else {
            if (state.pageQrDataUrl) {
                rows.push({
                    type: 'image',
                    title: text.pageQrTitle,
                    description: text.pageQrDescription,
                    src: state.pageQrDataUrl,
                    alt: text.pageQrTitle
                })
            }
            if (state.pairing) {
                rows.push({ type: 'info', title: text.pairing, value: text.pairingWindowOpen })
                rows.push({ type: 'button', title: text.focusPairing, run: () => ipcRenderer.invoke('remote-focus-pairing-window') })
                rows.push({ type: 'button', title: text.refreshQr, run: async () => update(await ipcRenderer.invoke('remote-start-pairing')) })
            } else {
                rows.push({ type: 'button', title: text.pair, run: async () => update(await ipcRenderer.invoke('remote-start-pairing')) })
            }

            for (const device of state.devices || []) {
                rows.push({
                    type: 'device',
                    id: `device-${device.id}`,
                    title: device.name,
                    description: device.connected ? text.deviceConnected : text.deviceDisconnected,
                    actionLabel: text.revokeButton || '해제하기',
                    run: async () => {
                        await ipcRenderer.invoke('remote-revoke-device', device.id)
                        await refresh()
                    }
                })
            }
            rows.push({ type: 'button', title: text.stop, run: async () => {
                await ipcRenderer.invoke('remote-stop')
                await refresh()
            } })
        }

        return rows
    },
    async onOpen({ refresh: redraw }) {
        renderPage = redraw
        if (!listening) {
            ipcRenderer.on('remote-state-change', (_event, next) => update(next))
            listening = true
        }
        await refresh()
    }
}

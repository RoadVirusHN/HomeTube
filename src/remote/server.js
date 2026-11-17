const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { WebSocketServer, WebSocket } = require('ws')
const QRCode = require('qrcode')
const { PROTOCOL, VERSION, parseClientMessage } = require('./protocol')
const { createDeviceStore } = require('./device-store')

const PAIRING_TTL_MS = 2 * 60 * 1000
const MAX_INVALID_MESSAGES = 5
const MAX_PAIRING_ATTEMPTS = 5
const RATE_WINDOW_MS = 60 * 1000
const MAX_CONNECTIONS = 8
const MAX_DEVICES = 8
const MAX_COMMANDS_PER_MINUTE = 120
const STATIC_FILES = {
    '/': [ 'index.html', 'text/html; charset=utf-8' ],
    '/remote.js': [ 'remote.js', 'text/javascript; charset=utf-8' ],
    '/style.css': [ 'style.css', 'text/css; charset=utf-8' ]
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex')
}

function equalHash(left, right) {
    if (!/^[a-f0-9]{64}$/.test(left || '') || !/^[a-f0-9]{64}$/.test(right || '')) return false;
    return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function randomToken() {
    return crypto.randomBytes(32).toString('base64url')
}

function randomCode() {
    return crypto.randomInt(0, 1000000).toString().padStart(6, '0')
}

function localAddresses() {
    const interfaces = os.networkInterfaces()
    const entries = []
    for (const [ name, addresses ] of Object.entries(interfaces)) {
        for (const address of addresses || []) {
            if (address.family === 'IPv4' && !address.internal) entries.push({ name, address: address.address })
        }
    }
    const rank = (name) => /wi-?fi|wlan|wireless/i.test(name) ? 0 : /ethernet|^eth|^en/i.test(name) ? 1 : 2
    return entries.sort((a, b) => rank(a.name) - rank(b.name))
}

function safeEqualString(left, right) {
    const a = Buffer.from(left)
    const b = Buffer.from(right)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function isLocalAddress(address) {
    if (typeof address !== 'string') return false;
    const normalized = address.toLowerCase().replace(/^::ffff:/, '')
    if (normalized === '::1') return true;
    if (normalized.includes(':')) return /^(fc|fd|fe[89ab])/.test(normalized);
    const parts = normalized.split('.').map(Number)
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    return parts[0] === 10
        || parts[0] === 127
        || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        || (parts[0] === 192 && parts[1] === 168)
        || (parts[0] === 169 && parts[1] === 254);
}

function createRemoteServer({ userData, host = '0.0.0.0', advertisedHost, port = 43117, onChange = () => {}, onCommand = () => {}, onPairingRequested = () => {}, onPairingCloseRequested = () => {}, onPairingFocusRequested = () => {}, now = () => Date.now() }) {
    const store = createDeviceStore(userData)
    const webRoot = path.join(__dirname, 'web')
    const connected = new Map()
    const attempts = new Map()
    const commandAttempts = new Map()
    let server = null
    let sockets = null
    let starting = null
    let startingPairing = null
    let boundPort = null
    let pairing = null
    let pairingTimer = null
    let pairingCount = 0
    let chosenHost = advertisedHost || localAddresses()[0]?.address || '127.0.0.1'
    const allowedHosts = new Set([ 'localhost', '127.0.0.1', '::1', chosenHost, ...localAddresses().map((item) => item.address) ])

    function snapshot(qrDataUrl = pairing?.qrDataUrl || null) {
        return {
            active: !!server,
            host: server ? chosenHost : null,
            port: server ? boundPort : null,
            pairing: pairing && pairing.expiresAt > now() ? {
                code: pairing.code,
                expiresAt: pairing.expiresAt,
                qrDataUrl,
                url: pairing.url
            } : null,
            devices: store.list().map((device) => ({ ...device, connected: (connected.get(device.id)?.size || 0) > 0 }))
        }
    }

    function changed() {
        onChange(snapshot())
    }

    function send(socket, message) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ protocol: PROTOCOL, version: VERSION, ...message }))
    }

    function authenticatedSockets(deviceId) {
        return connected.get(deviceId) || new Set()
    }

    function register(socket, deviceId) {
        let deviceSockets = connected.get(deviceId)
        if (!deviceSockets) connected.set(deviceId, deviceSockets = new Set())
        deviceSockets.add(socket)
        socket.deviceId = deviceId
        changed()
        socket.once('close', () => {
            deviceSockets.delete(socket)
            if (deviceSockets.size === 0) connected.delete(deviceId)
            changed()
        })
    }

    function allowPairAttempt(ip) {
        const currentTime = now()
        for (const [ address, times ] of attempts) {
            const recent = times.filter((time) => currentTime - time < RATE_WINDOW_MS)
            if (recent.length) attempts.set(address, recent)
            else attempts.delete(address)
        }
        const entries = (attempts.get(ip) || []).filter((time) => currentTime - time < RATE_WINDOW_MS)
        if (entries.length >= MAX_PAIRING_ATTEMPTS) return false;
        if (!attempts.has(ip) && attempts.size >= 256) return false;
        entries.push(currentTime)
        attempts.set(ip, entries)
        return true
    }

    function allowCommand(deviceId) {
        const currentTime = now()
        const timestamps = (commandAttempts.get(deviceId) || []).filter((time) => currentTime - time < RATE_WINDOW_MS)
        if (timestamps.length >= MAX_COMMANDS_PER_MINUTE) return false;
        timestamps.push(currentTime)
        commandAttempts.set(deviceId, timestamps)
        return true
    }

    async function handleMessage(socket, ip, raw) {
        const message = parseClientMessage(raw)
        if (!message) {
            socket.invalidMessages = (socket.invalidMessages || 0) + 1
            send(socket, { type: 'error', code: 'INVALID_MESSAGE' })
            if (socket.invalidMessages >= MAX_INVALID_MESSAGES) socket.close(1008, 'Invalid messages')
            return;
        }
        if (message.type === 'pair') {
            if (!allowPairAttempt(ip)) return send(socket, { type: 'error', code: 'RATE_LIMITED' })
            if (!pairing || pairing.expiresAt <= now()) {
                pairing = null
                return send(socket, { type: 'error', code: 'PAIRING_EXPIRED' })
            }
            if (!safeEqualString(message.code, pairing.code) || !equalHash(sha256(message.token), pairing.tokenHash)) {
                return send(socket, { type: 'error', code: 'PAIRING_INVALID' })
            }
            if (pairingCount >= 5) return send(socket, { type: 'error', code: 'PAIRING_LIMIT' })
            if (store.list().length >= MAX_DEVICES) return send(socket, { type: 'error', code: 'DEVICE_LIMIT' })

            pairingCount++
            const pairingExpiresAt = pairing.expiresAt
            pairing = null
            clearTimeout(pairingTimer)
            const sessionToken = randomToken()
            const timestamp = new Date(now()).toISOString()
            const device = {
                id: crypto.randomUUID(),
                name: message.deviceName.trim(),
                platform: message.platform,
                tokenHash: sha256(sessionToken),
                createdAt: timestamp,
                lastSeenAt: timestamp
            }
            store.add(device)
            register(socket, device.id)
            send(socket, { type: 'paired', deviceId: device.id, sessionToken, deviceName: device.name })
            changed()
            if (pairingCount < 5 && pairingExpiresAt > Date.now()) await issuePairing(pairingExpiresAt)
            return;
        }

        if (message.type === 'resume') {
            const device = store.get(message.deviceId)
            if (!device || !equalHash(sha256(message.sessionToken), device.tokenHash)) {
                return send(socket, { type: 'error', code: 'DEVICE_NOT_TRUSTED' })
            }
            store.touch(device.id, new Date(now()).toISOString())
            register(socket, device.id)
            send(socket, { type: 'connected', deviceId: device.id, deviceName: device.name })
            changed()
            return;
        }

        if (message.type === 'ping' && socket.deviceId) send(socket, { type: 'pong' })
        else if (message.type === 'request-pairing' && socket.deviceId) {
            try {
                const state = await startPairing()
                onPairingRequested(state)
                send(socket, { type: 'pairing-requested' })
            } catch {
                send(socket, { type: 'error', code: 'PAIRING_UNAVAILABLE' })
            }
        }
        else if (message.type === 'close-pairing-view' && socket.deviceId) {
            onPairingCloseRequested()
            send(socket, { type: 'pairing-view-closed' })
        }
        else if (message.type === 'focus-pairing-window' && socket.deviceId) {
            const shown = onPairingFocusRequested()
            send(socket, { type: 'pairing-window-focused', shown: !!shown })
        }
        else if (message.type === 'unpair' && socket.deviceId) {
            const deviceId = socket.deviceId
            send(socket, { type: 'unpaired' })
            revoke(deviceId)
        }
        else if (message.type === 'command' && socket.deviceId) {
            if (!allowCommand(socket.deviceId)) return send(socket, { type: 'error', code: 'RATE_LIMITED' })
            onCommand(message, socket.deviceId)
        }
        else if (!socket.deviceId) send(socket, { type: 'error', code: 'AUTH_REQUIRED' })
    }

    function validHost(hostHeader) {
        if (typeof hostHeader !== 'string') return false;
        const match = hostHeader.match(/^(.+):(\d+)$/)
        if (!match || Number(match[2]) !== boundPort) return false;
        return allowedHosts.has(match[1].replace(/^\[|\]$/g, ''))
    }

    function createHttpServer() {
        return http.createServer((req, res) => {
            if (!isLocalAddress(req.socket.remoteAddress)) {
                res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Local network only')
                return;
            }
            if (!validHost(req.headers.host)) {
                res.writeHead(421, { 'content-type': 'text/plain; charset=utf-8' }).end('Invalid host')
                return;
            }
            const route = STATIC_FILES[req.url]
            if (!route || req.method !== 'GET') {
                res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found')
                return;
            }
            try {
                const body = fs.readFileSync(path.join(webRoot, route[0]))
                res.writeHead(200, {
                    'content-type': route[1],
                    'content-length': body.length,
                    'cache-control': 'no-store',
                    'x-content-type-options': 'nosniff',
                    'content-security-policy': "default-src 'self'; connect-src 'self' ws:; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
                    'referrer-policy': 'no-referrer',
                    'x-frame-options': 'DENY'
                }).end(body)
            } catch {
                res.writeHead(500).end()
            }
        })
    }

    async function startServer() {
        const wsServer = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false })
        wsServer.on('connection', (socket, req) => {
            if (wsServer.clients.size > MAX_CONNECTIONS) {
                socket.close(1013, 'Connection limit')
                return;
            }
            socket.invalidMessages = 0
            const timeout = setTimeout(() => { if (!socket.deviceId) socket.close(1008, 'Authentication timeout') }, 15000)
            timeout.unref?.()
            socket.on('error', () => {})
            socket.on('message', (raw) => {
                void handleMessage(socket, req.socket.remoteAddress || 'unknown', raw.toString()).catch(() => {
                    send(socket, { type: 'error', code: 'REQUEST_FAILED' })
                })
            })
            socket.once('close', () => clearTimeout(timeout))
        })

        const candidates = port === 0 ? [ 0 ] : Array.from({ length: 11 }, (_value, index) => port + index)
        let httpServer = null
        let lastError = null
        for (const candidate of candidates) {
            const candidateServer = createHttpServer()
            candidateServer.on('upgrade', (req, socket, head) => {
                let origin;
                try { origin = new URL(req.headers.origin) } catch { socket.destroy(); return; }
                const expectedOrigin = `http://${req.headers.host}`
                if (!isLocalAddress(req.socket.remoteAddress) || req.url !== '/remote' || !validHost(req.headers.host) || origin.origin !== expectedOrigin) {
                    socket.destroy()
                    return;
                }
                wsServer.handleUpgrade(req, socket, head, (webSocket) => wsServer.emit('connection', webSocket, req))
            })
            try {
                await new Promise((resolve, reject) => {
                    const failed = (error) => { candidateServer.off('listening', listening); reject(error) }
                    const listening = () => { candidateServer.off('error', failed); resolve() }
                    candidateServer.once('error', failed)
                    candidateServer.once('listening', listening)
                    candidateServer.listen(candidate, host)
                })
                httpServer = candidateServer
                break
            } catch (error) {
                lastError = error
            }
        }
        if (!httpServer) {
            await new Promise((resolve) => wsServer.close(resolve))
            throw lastError || new Error('No available local remote port')
        }
        boundPort = httpServer.address().port
        server = httpServer
        sockets = wsServer
        changed()
    }

    async function start() {
        if (server) return;
        if (starting) return starting;
        starting = startServer()
        try {
            await starting
        } finally {
            starting = null
        }
    }

    async function issuePairing(expiresAt) {
        clearTimeout(pairingTimer)
        const token = randomToken()
        pairing = { tokenHash: sha256(token), code: randomCode(), expiresAt }
        const payload = Buffer.from(JSON.stringify({ protocol: PROTOCOL, version: VERSION, host: chosenHost, port: boundPort, token, code: pairing.code, expiresAt: pairing.expiresAt })).toString('base64url')
        const url = `http://${chosenHost}:${boundPort}/#${payload}`
        const qrDataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 280 })
        pairing.qrDataUrl = qrDataUrl
        pairing.url = url
        pairingTimer = setTimeout(() => {
            if (pairing && pairing.expiresAt <= now()) {
                pairing = null
                changed()
            }
        }, Math.max(0, expiresAt - now() + 25))
        pairingTimer.unref?.()
        onChange(snapshot(qrDataUrl))
        return { ...snapshot(qrDataUrl), url }
    }

    async function startPairing() {
        await start()
        if (startingPairing) return startingPairing;
        startingPairing = (async () => {
            pairingCount = 0
            return issuePairing(now() + PAIRING_TTL_MS)
        })()
        try {
            return await startingPairing
        } finally {
            startingPairing = null
        }
    }

    async function stop() {
        if (starting) {
            try { await starting } catch {}
        }
        clearTimeout(pairingTimer)
        pairing = null
        if (sockets) {
            for (const socket of sockets.clients) socket.terminate()
            await new Promise((resolve) => sockets.close(resolve))
            sockets = null
        }
        if (server) {
            await new Promise((resolve) => server.close(resolve))
            server = null
            boundPort = null
        }
        connected.clear()
        changed()
    }

    function revoke(deviceId) {
        commandAttempts.delete(deviceId)
        for (const socket of authenticatedSockets(deviceId)) {
            socket.deviceId = null
            socket.close(1008, 'Device revoked')
        }
        const removed = store.remove(deviceId)
        changed()
        return removed
    }

    async function close() {
        await stop()
    }

    return { start, startPairing, stop, revoke, snapshot, close }
}

module.exports = { createRemoteServer, PAIRING_TTL_MS, MAX_INVALID_MESSAGES, isLocalAddress }

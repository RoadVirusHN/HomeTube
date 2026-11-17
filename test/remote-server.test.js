const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const WebSocket = require('ws')
const { createRemoteServer, isLocalAddress } = require('../src/remote/server')

function connect(port, origin = `http://127.0.0.1:${port}`) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/remote`, { origin })
        socket.once('open', () => resolve(socket))
        socket.once('error', reject)
    })
}

function receive(socket, predicate = () => true) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for remote message')), 2000)
        const onMessage = (raw) => {
            const message = JSON.parse(raw.toString())
            if (!predicate(message)) return;
            clearTimeout(timer)
            socket.off('message', onMessage)
            resolve(message)
        }
        socket.on('message', onMessage)
    })
}

function pairData(url) {
    return JSON.parse(Buffer.from(new URL(url).hash.slice(1), 'base64url').toString('utf8'))
}

function requestWithHost(port, hostHeader) {
    return new Promise((resolve, reject) => {
        const request = http.get({ hostname: '127.0.0.1', port, path: '/', headers: { host: hostHeader } }, resolve)
        request.once('error', reject)
    })
}

async function waitForPairing(service) {
    for (let i = 0; i < 100; i++) {
        const pairing = service.snapshot().pairing
        if (pairing?.url) return pairing
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('Timed out waiting for the next one-time pairing code')
}

function makeService(t) {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vacuumtube-remote-'))
    const service = createRemoteServer({ userData, host: '127.0.0.1', advertisedHost: '127.0.0.1', port: 0 })
    t.after(async () => {
        await service.close()
        fs.rmSync(userData, { recursive: true, force: true })
    })
    return { userData, service }
}

test('serves the Korean pairing page with restrictive headers', async (t) => {
    const { service } = makeService(t)
    const [ pairing, duplicateStart ] = await Promise.all([ service.startPairing(), service.startPairing() ])
    assert.equal(duplicateStart.port, pairing.port)
    assert.equal(duplicateStart.pairing.code, pairing.pairing.code)
    const response = await fetch(`http://127.0.0.1:${pairing.port}/`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/)
    assert.match(await response.text(), /<html lang="ko">/)
    assert.match(pairing.pairing.qrDataUrl, /^data:image\/png;base64,/)
    const invalidHost = await requestWithHost(pairing.port, `untrusted.example:${pairing.port}`)
    assert.equal(invalidHost.statusCode, 421)
    invalidHost.resume()
})

test('pairs two devices, resumes a saved session and revokes device access', async (t) => {
    const { userData, service } = makeService(t)
    const pairing = await service.startPairing()
    const payload = pairData(pairing.pairing.url)
    const first = await connect(pairing.port)
    t.after(() => first.terminate())
    const firstPaired = receive(first, (message) => message.type === 'paired')
    first.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'pair', token: payload.token, code: payload.code, deviceName: '첫 번째 휴대폰', platform: 'Android' }))
    const firstDevice = await firstPaired
    const nextPairing = await waitForPairing(service)
    assert.ok(nextPairing)
    assert.notEqual(nextPairing.code, payload.code)

    const second = await connect(pairing.port)
    t.after(() => second.terminate())
    const oldCodeRejected = receive(second, (message) => message.code === 'PAIRING_INVALID')
    second.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'pair', token: payload.token, code: payload.code, deviceName: '다른 휴대폰', platform: 'Android' }))
    await oldCodeRejected
    const secondPaired = receive(second, (message) => message.type === 'paired')
    const nextPayload = pairData(nextPairing.url)
    second.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'pair', token: nextPayload.token, code: nextPayload.code, deviceName: '두 번째 휴대폰', platform: 'iPhone' }))
    const secondDevice = await secondPaired
    assert.notEqual(firstDevice.deviceId, secondDevice.deviceId)
    assert.equal(service.snapshot().devices.filter((device) => device.connected).length, 2)

    const firstClosed = new Promise((resolve) => first.once('close', resolve))
    first.terminate()
    await firstClosed
    const resumed = await connect(pairing.port)
    t.after(() => resumed.terminate())
    const reconnected = receive(resumed, (message) => message.type === 'connected')
    resumed.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'resume', deviceId: firstDevice.deviceId, sessionToken: firstDevice.sessionToken }))
    assert.equal((await reconnected).deviceId, firstDevice.deviceId)

    const duplicateSession = await connect(pairing.port)
    t.after(() => duplicateSession.terminate())
    const duplicateConnected = receive(duplicateSession, (message) => message.type === 'connected')
    duplicateSession.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'resume', deviceId: firstDevice.deviceId, sessionToken: firstDevice.sessionToken }))
    await duplicateConnected
    assert.equal(service.snapshot().devices.find((device) => device.id === firstDevice.deviceId).connected, true)

    const revokedClose = new Promise((resolve) => resumed.once('close', resolve))
    const duplicateRevokedClose = new Promise((resolve) => duplicateSession.once('close', resolve))
    assert.equal(service.revoke(firstDevice.deviceId), true)
    await revokedClose
    await duplicateRevokedClose
    assert.equal(service.snapshot().devices.some((device) => device.id === firstDevice.deviceId), false)
    assert.equal(service.revoke(firstDevice.deviceId), false)

    const stored = JSON.parse(fs.readFileSync(path.join(userData, 'remote-devices.json'), 'utf8'))
    assert.equal(stored.length, 1)
    assert.match(stored[0].tokenHash, /^[a-f0-9]{64}$/)
    assert.equal(JSON.stringify(stored).includes(firstDevice.sessionToken), false)
})

test('rejects WebSocket connections from a foreign Origin', async (t) => {
    const { service } = makeService(t)
    const pairing = await service.startPairing()
    await assert.rejects(connect(pairing.port, 'http://untrusted.example'))
})

test('accepts private and loopback addresses while rejecting public and malformed addresses', () => {
    for (const address of [ '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.2', '169.254.2.3', '::1', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:192.168.1.2' ]) {
        assert.equal(isLocalAddress(address), true, address)
    }
    for (const address of [ '8.8.8.8', '172.32.0.1', '192.167.1.1', 'not-an-ip', '', null ]) {
        assert.equal(isLocalAddress(address), false, String(address))
    }
})

test('counts malformed messages cumulatively even when valid unauthenticated messages are sent between them', async (t) => {
    const { service } = makeService(t)
    const pairing = await service.startPairing()
    const socket = await connect(pairing.port)
    const closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)))
    const bad = JSON.stringify({ type: 'COMMAND', command: { type: 'PLAYER_PLAY' } })
    socket.send(bad)
    socket.send(bad)
    const authRequired = receive(socket, (message) => message.code === 'AUTH_REQUIRED')
    socket.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'ping' }))
    await authRequired
    for (let i = 0; i < 3; i++) socket.send(bad)
    assert.equal(await closed, 1008)
})

test('limits pairing attempts by client address', async (t) => {
    const { service } = makeService(t)
    const pairing = await service.startPairing()
    const payload = pairData(pairing.pairing.url)
    const socket = await connect(pairing.port)
    t.after(() => socket.terminate())
    for (let attempt = 0; attempt < 5; attempt++) {
        const rejected = receive(socket, (message) => message.code === 'PAIRING_INVALID')
        socket.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'pair', token: `${payload.token}bad`, code: payload.code, deviceName: '잘못된 시도', platform: 'test' }))
        await rejected
    }
    const limited = receive(socket, (message) => message.code === 'RATE_LIMITED')
    socket.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'pair', token: payload.token, code: payload.code, deviceName: '제한 확인', platform: 'test' }))
    await limited
    assert.equal(service.snapshot().devices.length, 0)
})

test('rejects an expired pairing payload', async (t) => {
    let currentTime = Date.now()
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vacuumtube-remote-'))
    const service = createRemoteServer({ userData, host: '127.0.0.1', advertisedHost: '127.0.0.1', port: 0, now: () => currentTime })
    t.after(async () => { await service.close(); fs.rmSync(userData, { recursive: true, force: true }) })
    const pairing = await service.startPairing()
    const payload = pairData(pairing.pairing.url)
    currentTime += 2 * 60 * 1000 + 1
    const socket = await connect(pairing.port)
    t.after(() => socket.terminate())
    const expired = receive(socket, (message) => message.code === 'PAIRING_EXPIRED')
    socket.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'pair', token: payload.token, code: payload.code, deviceName: '만료 코드', platform: 'test' }))
    await expired
    assert.equal(service.snapshot().devices.length, 0)
})

test('caps registered devices at eight while retaining the pairing for recovery', async (t) => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vacuumtube-remote-'))
    let currentTime = Date.now()
    const service = createRemoteServer({ userData, host: '127.0.0.1', advertisedHost: '127.0.0.1', port: 0, now: () => currentTime })
    t.after(async () => { await service.close(); fs.rmSync(userData, { recursive: true, force: true }) })
    let port
    for (let index = 0; index < 8; index++) {
        currentTime += 60 * 1000 + 1
        const pairing = await service.startPairing()
        port = pairing.port
        const payload = pairData(pairing.pairing.url)
        const socket = await connect(port)
        const paired = receive(socket, (message) => message.type === 'paired')
        socket.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'pair', token: payload.token, code: payload.code, deviceName: `기기 ${index + 1}`, platform: 'test' }))
        await paired.catch((error) => { throw new Error(`pair ${index + 1}: ${error.message}`) })
        const closed = new Promise((resolve) => socket.once('close', resolve))
        socket.terminate()
        await closed
    }
    const pairing = await service.startPairing()
    const payload = pairData(pairing.pairing.url)
    const socket = await connect(port)
    t.after(() => socket.terminate())
    const limited = receive(socket, (message) => message.code === 'DEVICE_LIMIT')
    socket.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'pair', token: payload.token, code: payload.code, deviceName: '아홉 번째 기기', platform: 'test' }))
    await limited.catch((error) => { throw new Error(`device limit: ${error.message}`) })
    assert.equal(service.snapshot().devices.length, 8)
    assert.equal(service.snapshot().pairing.code, payload.code)
})

test('dispatches navigation commands only from an authenticated paired device', async (t) => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vacuumtube-remote-'))
    const commands = []
    const service = createRemoteServer({
        userData,
        host: '127.0.0.1',
        advertisedHost: '127.0.0.1',
        port: 0,
    onCommand: ({ command, query }, deviceId) => commands.push({ command, query, deviceId })
    })
    t.after(async () => {
        await service.close()
        fs.rmSync(userData, { recursive: true, force: true })
    })
    const pairing = await service.startPairing()
    const payload = pairData(pairing.pairing.url)
    const socket = await connect(pairing.port)
    t.after(() => socket.terminate())
    const badResume = receive(socket, (message) => message.code === 'DEVICE_NOT_TRUSTED')
    socket.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'resume', deviceId: '00000000-0000-4000-8000-000000000000', sessionToken: 'x'.repeat(43) }))
    await badResume
    const denied = receive(socket, (message) => message.code === 'AUTH_REQUIRED')
    socket.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'command', command: 'UP' }))
    await denied
    assert.equal(commands.length, 0)

    const paired = receive(socket, (message) => message.type === 'paired')
    socket.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'pair', token: payload.token, code: payload.code, deviceName: '리모컨', platform: 'Android' }))
    const device = await paired
    socket.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'command', command: 'UP' }))
    const pong = receive(socket, (message) => message.type === 'pong')
    socket.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'ping' }))
    await pong
    assert.deepEqual(commands, [ { command: 'UP', query: undefined, deviceId: device.deviceId } ])

    assert.deepEqual(commands, [ { command: 'UP', query: undefined, deviceId: device.deviceId } ])
})

test('limits command bursts per paired device across simultaneous connections', async (t) => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vacuumtube-remote-'))
    const commands = []
    const service = createRemoteServer({ userData, host: '127.0.0.1', advertisedHost: '127.0.0.1', port: 0, onCommand: (message) => commands.push(message) })
    t.after(async () => { await service.close(); fs.rmSync(userData, { recursive: true, force: true }) })
    const pairing = await service.startPairing()
    const payload = pairData(pairing.pairing.url)
    const socket = await connect(pairing.port)
    t.after(() => socket.terminate())
    const paired = receive(socket, (message) => message.type === 'paired')
    socket.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'pair', token: payload.token, code: payload.code, deviceName: '속도 제한 확인', platform: 'test' }))
    const device = await paired
    const secondSocket = await connect(pairing.port)
    t.after(() => secondSocket.terminate())
    const resumed = receive(secondSocket, (message) => message.type === 'connected')
    secondSocket.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'resume', deviceId: device.deviceId, sessionToken: device.sessionToken }))
    await resumed
    const limited = receive(secondSocket, (message) => message.code === 'RATE_LIMITED')
    const command = JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'command', command: 'UP' })
    for (let i = 0; i < 60; i++) socket.send(command)
    const pinged = receive(socket, (message) => message.type === 'pong')
    socket.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'ping' }))
    await pinged
    for (let i = 0; i < 61; i++) secondSocket.send(command)
    await limited
    assert.equal(commands.length, 120)
})

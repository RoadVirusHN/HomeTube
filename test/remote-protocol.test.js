const assert = require('node:assert/strict')
const test = require('node:test')
const { parseClientMessage } = require('../src/remote/protocol')
const { publicState } = require('../src/remote/main')
const { togglePlayback } = require('../src/preload/util/remote-playback')

test('validates the pairing and resume messages at runtime', () => {
    const pair = { protocol: 'hometube-remote', version: 1, type: 'pair', token: 't'.repeat(43), code: '012345', deviceName: '거실 휴대폰', platform: 'Android' }
    assert.deepEqual(parseClientMessage(JSON.stringify(pair)), pair)
    assert.equal(parseClientMessage(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'resume', deviceId: '00000000-0000-4000-8000-000000000000', sessionToken: 's'.repeat(43) })).type, 'resume')
    assert.equal(parseClientMessage(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'command', command: 'UP' })).command, 'UP')
})

test('rejects extra fields, bad codes, oversized data, malformed JSON and remote commands', () => {
    const invalid = [
        '{',
        'x'.repeat(4097),
        JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'pair', token: 't'.repeat(43), code: '12345', deviceName: 'phone', platform: 'Android' }),
        JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'pair', token: 't'.repeat(43), code: '123456', deviceName: 'phone', platform: 'Android', extra: true }),
        JSON.stringify({ type: 'COMMAND', command: { type: 'PLAYER_PLAY' } }),
        JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'resume', deviceId: 'not-a-device-id', sessionToken: 's'.repeat(43) })
        ,JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'command', command: 'EXECUTE' })
        ,JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'command', command: 'UP', extra: true })
        ,JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'command', command: 'SEARCH', query: 'test' })
    ]
    for (const message of invalid) assert.equal(parseClientMessage(message), null)
})

test('toggles playback in both directions using YouTube player state', () => {
    const calls = []
    const player = { getPlayerState: () => 1, pauseVideo: () => calls.push('pause'), playVideo: () => calls.push('play') }
    assert.equal(togglePlayback(player), true)
    player.getPlayerState = () => 2
    assert.equal(togglePlayback(player), true)
    assert.deepEqual(calls, ['pause', 'play'])
})

test('keeps pairing secrets out of the YouTube settings renderer state', () => {
    const state = publicState({
        active: true,
        host: '192.168.1.20',
        port: 43117,
        pairing: { code: '012345', expiresAt: 1234, qrDataUrl: 'secret qr', url: 'secret URL' },
        devices: []
    })
    assert.deepEqual(state, {
        active: true,
        host: '192.168.1.20',
        port: 43117,
        pairing: { expiresAt: 1234 },
        devices: []
    })
    assert.equal(JSON.stringify(state).includes('secret'), false)
})

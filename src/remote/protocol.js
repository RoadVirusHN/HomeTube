const PROTOCOL = 'hometube-remote'
const VERSION = 1
const REMOTE_COMMANDS = Object.freeze([
    'UP', 'DOWN', 'LEFT', 'RIGHT', 'SELECT', 'BACK', 'HOME',
    'PLAY_PAUSE', 'SEEK_BACK', 'SEEK_FORWARD', 'VOLUME_UP', 'VOLUME_DOWN', 'MUTE'
])

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, keys) {
    return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value)
}

function validateClientMessage(value) {
    if (!isRecord(value) || typeof value.type !== 'string' || value.protocol !== PROTOCOL || value.version !== VERSION) return false;

    if (value.type === 'pair') {
        return exactKeys(value, [ 'protocol', 'version', 'type', 'token', 'code', 'deviceName', 'platform' ])
            && typeof value.token === 'string' && value.token.length >= 32 && value.token.length <= 256
            && typeof value.code === 'string' && /^\d{6}$/.test(value.code)
            && typeof value.deviceName === 'string' && value.deviceName.trim().length > 0 && value.deviceName.length <= 60
            && typeof value.platform === 'string' && value.platform.length <= 40;
    }

    if (value.type === 'resume') {
        return exactKeys(value, [ 'protocol', 'version', 'type', 'deviceId', 'sessionToken' ])
            && typeof value.deviceId === 'string' && /^[0-9a-f-]{36}$/i.test(value.deviceId)
            && typeof value.sessionToken === 'string' && value.sessionToken.length >= 32 && value.sessionToken.length <= 256;
    }

    if (value.type === 'ping') return exactKeys(value, [ 'protocol', 'version', 'type' ])
    if (value.type === 'unpair' || value.type === 'request-pairing' || value.type === 'close-pairing-view' || value.type === 'focus-pairing-window') return exactKeys(value, [ 'protocol', 'version', 'type' ])
    if (value.type === 'command') {
        return exactKeys(value, [ 'protocol', 'version', 'type', 'command' ])
            && REMOTE_COMMANDS.includes(value.command)
    }
    return false;
}

function parseClientMessage(raw) {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 4096) return null;
    try {
        const value = JSON.parse(raw)
        return validateClientMessage(value) ? value : null;
    } catch {
        return null;
    }
}

module.exports = { PROTOCOL, VERSION, REMOTE_COMMANDS, parseClientMessage }

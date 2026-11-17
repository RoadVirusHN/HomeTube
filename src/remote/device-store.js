const fs = require('fs')
const path = require('path')

function isDevice(value) {
    return value && typeof value === 'object'
        && typeof value.id === 'string'
        && typeof value.name === 'string'
        && typeof value.platform === 'string'
        && typeof value.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(value.tokenHash)
        && typeof value.createdAt === 'string'
        && typeof value.lastSeenAt === 'string';
}

function createDeviceStore(userData) {
    const file = path.join(userData, 'remote-devices.json')
    let devices = []

    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (Array.isArray(parsed)) devices = parsed.filter(isDevice)
    } catch {}

    function save() {
        fs.mkdirSync(userData, { recursive: true })
        const temporary = `${file}.tmp`
        fs.writeFileSync(temporary, JSON.stringify(devices, null, 2), { mode: 0o600 })
        fs.renameSync(temporary, file)
    }

    return {
        list() {
            return devices.map(({ tokenHash, ...device }) => ({ ...device }))
        },
        get(id) {
            return devices.find((device) => device.id === id) || null
        },
        add(device) {
            devices = [ ...devices.filter((item) => item.id !== device.id), device ]
            save()
        },
        touch(id, lastSeenAt) {
            devices = devices.map((device) => device.id === id ? { ...device, lastSeenAt } : device)
            save()
        },
        remove(id) {
            const next = devices.filter((device) => device.id !== id)
            if (next.length === devices.length) return false;
            devices = next
            save()
            return true
        }
    }
}

module.exports = { createDeviceStore }

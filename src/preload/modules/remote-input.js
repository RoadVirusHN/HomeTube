const { ipcRenderer } = require('electron')
const { togglePlayback } = require('../util/remote-playback')

const KEY_MAP = Object.freeze({
    UP: { key: 'ArrowUp', keyCode: 38 },
    DOWN: { key: 'ArrowDown', keyCode: 40 },
    LEFT: { key: 'ArrowLeft', keyCode: 37 },
    RIGHT: { key: 'ArrowRight', keyCode: 39 },
    SELECT: { key: 'Enter', keyCode: 13 },
    BACK: { key: 'Escape', keyCode: 27 },
    HOME: { key: 'Home', keyCode: 36 },
    SEEK_BACK: { key: 'j', keyCode: 74 },
    SEEK_FORWARD: { key: 'l', keyCode: 76 },
    VOLUME_UP: { key: null, keyCode: 16002 },
    VOLUME_DOWN: { key: null, keyCode: 16001 },
    MUTE: { key: 'm', keyCode: 16000 },
})

module.exports = () => {
    ipcRenderer.on('remote-input', (_event, payload) => {
        if (payload?.command === 'PLAY_PAUSE') {
            const player = document.querySelector('.html5-video-player')
            const video = player?.querySelector('video') || document.querySelector('video')
            togglePlayback(player, video)
            return;
        }
        const key = KEY_MAP[payload?.command]
        if (!key) return;

        for (const type of [ 'keydown', 'keyup' ]) {
            const event = new Event(type, { bubbles: true, cancelable: true })
            const values = { code: key.key || '', keyCode: key.keyCode, which: key.keyCode }
            if (key.key) values.key = key.key
            Object.defineProperties(event, Object.fromEntries(Object.entries(values).map(([ name, value ]) => [ name, { value } ])))
            document.dispatchEvent(event)
        }
    })
}

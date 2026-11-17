const { ipcRenderer } = require('electron')
const configManager = require('../../config')
const config = configManager.get()

function getMaxResolution() {
    let resolutions = [ '256x144', '426x240', '640x360', '854x480', '1280x720', '1920x1080', '2560x1440', '3840x2160', '7680x4320' ]
    let screenWidth = Math.max(window.screen.width, window.screen.height)
    let screenHeight = Math.min(window.screen.width, window.screen.height)

    for (let i = 0; i < resolutions.length; i++) {
        let [ width, height ] = resolutions[i].split('x').map(Number)
        if (screenWidth <= width && screenHeight <= height) return resolutions[i];
    }

    return `${window.screen.width}x${window.screen.height}`;
}

function createOnDeepLink() {
    let listeners = []
    let pending = [] //deeplinks that arrived before leanback called addListener

    function callListener(listener, deeplink) {
        try {
            listener(deeplink)
        } catch (err) {
            console.error('[h5vcc] Deeplink listener failed', err)
        }
    }

    ipcRenderer.on('deeplink', (event, deeplink) => {
        if (listeners.length === 0) {
            pending.push(deeplink)
            return;
        }

        for (let listener of listeners) {
            callListener(listener, deeplink)
        }
    })

    return {
        addListener: (listener) => {
            listeners.push(listener)
            while (pending.length > 0) {
                callListener(listener, pending.shift())
            }
        }
    };
}

module.exports = async () => {
    const initialDeepLink = await ipcRenderer.invoke('get-deeplink')
    const maxResolution = getMaxResolution()

    window.h5vcc = {
        runtime: {
            initialDeepLink,
            onDeepLink: createOnDeepLink()
        },
        system: {
            getVideoContainerSizeOverride: () => { //unlock high res
                return config.unlock_resolution ? '7680x4320' : maxResolution;
            }
        }
    }
}

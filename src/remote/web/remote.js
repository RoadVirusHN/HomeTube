(() => {
    const status = document.querySelector('#status')
    const statusDot = document.querySelector('#status-dot')
    const connectionStatus = document.querySelector('#connection-status')
    const connectionDetail = document.querySelector('#connection-detail')
    const nameInput = document.querySelector('#device-name')
    const connectButton = document.querySelector('#connect')
    const connectionDialog = document.querySelector('#connection-dialog')
    const pairingControls = document.querySelector('#pairing-controls')
    const deviceControls = document.querySelector('#device-controls')
    const addDeviceButton = document.querySelector('#add-device')
    const disconnectDeviceButton = document.querySelector('#disconnect-device')
    const closePairingViewButton = document.querySelector('#close-pairing-view')
    const focusPairingWindowButton = document.querySelector('#focus-pairing-window')
    const STORAGE_KEY = 'hometube.remote.device.v1'
    const MAX_NAME_LENGTH = 60
    let retryTimer = null
    let socket = null
    let pairing = null
    let connected = false
    const controls = document.querySelector('#controls')

    function sendCommand(command) {
        if (!connected || socket?.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'command', command }))
    }

    function show(kind, title, message) {
        status.textContent = title
        if (!connected && message) connectionDetail.textContent = message
        statusDot.className = 'dot'
        connectionStatus.className = `status-button ${kind || 'disconnected'}`
    }

    function decodePairingPayload() {
        try {
            const encoded = location.hash.slice(1).replace(/-/g, '+').replace(/_/g, '/')
            if (!encoded) return null;
            const json = decodeURIComponent(Array.from(atob(encoded), (character) => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''))
            const value = JSON.parse(json)
            if (value.protocol !== 'hometube-remote' || value.version !== 1
                || value.host !== location.hostname || value.port !== Number(location.port)
                || typeof value.token !== 'string' || !/^\d{6}$/.test(value.code)
                || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) return null;
            return value;
        } catch {
            return null;
        }
    }

    function loadDevice() {
        try {
            const value = JSON.parse(localStorage.getItem(STORAGE_KEY))
            return value && typeof value.deviceId === 'string' && typeof value.sessionToken === 'string' ? value : null;
        } catch {
            return null;
        }
    }

    function connect() {
        clearTimeout(retryTimer)
        const device = loadDevice()
        pairing = decodePairingPayload()
        if (!device && !pairing) {
            show('disconnected', '연결 안 됨', '연결 코드가 없거나 만료되었습니다. HomeTube에서 새 QR 코드를 표시해 주세요.')
            return;
        }
        if (pairing) nameInput.value = localStorage.getItem('hometube.remote.name') || nameInput.value || '내 휴대폰'
        connectButton.hidden = true
        connectButton.disabled = true
        show('connecting', '연결 중', '로컬 Wi-Fi를 통해 HomeTube에 연결하고 있습니다.')

        socket = new WebSocket(`ws://${location.hostname}:${location.port}/remote`)
        socket.addEventListener('open', () => {
            if (device) {
                socket.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'resume', deviceId: device.deviceId, sessionToken: device.sessionToken }))
                return;
            }
            const deviceName = (nameInput.value.trim() || '내 휴대폰').slice(0, MAX_NAME_LENGTH)
            localStorage.setItem('hometube.remote.name', deviceName)
            socket.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'pair', token: pairing.token, code: pairing.code, deviceName, platform: navigator.userAgent.slice(0, 40) }))
        })
        socket.addEventListener('message', (event) => {
            let message;
            try { message = JSON.parse(event.data) } catch { return; }
            if (message.protocol !== 'hometube-remote' || message.version !== 1) return;
            if (message.type === 'paired') {
                connected = true
                controls.hidden = false
                localStorage.setItem(STORAGE_KEY, JSON.stringify({ deviceId: message.deviceId, sessionToken: message.sessionToken }))
                nameInput.disabled = true
                history.replaceState(null, '', location.pathname)
                show('connected', '연결됨', '현재 이 휴대폰이 연결되어 있습니다.')
                if (connectionDialog.open) connectionDialog.close()
            } else if (message.type === 'connected') {
                connected = true
                controls.hidden = false
                nameInput.disabled = true
                show('connected', '연결됨', '현재 이 휴대폰이 연결되어 있습니다.')
                if (connectionDialog.open) connectionDialog.close()
            } else if (message.type === 'pairing-requested') {
                connectionDetail.textContent = '컴퓨터에 새 페어링 QR 코드를 표시했습니다. 다른 휴대폰으로 스캔하세요.'
            } else if (message.type === 'unpaired') {
                localStorage.removeItem(STORAGE_KEY)
                connected = false
                deviceControls.hidden = true
                pairingControls.hidden = true
                connectButton.hidden = true
                nameInput.disabled = false
                show('disconnected', '연결 안 됨', '이 휴대폰의 연결을 해제했습니다.')
                if (socket?.readyState === WebSocket.OPEN) socket.close()
            } else if (message.type === 'error') {
                const messages = {
                    PAIRING_EXPIRED: '연결 코드가 만료되었습니다. 컴퓨터에서 새 QR 코드를 표시해 주세요.',
                    PAIRING_INVALID: '연결 코드를 확인할 수 없습니다. 새 QR 코드를 스캔해 주세요.',
                    DEVICE_NOT_TRUSTED: '이 휴대폰의 등록이 해제되었습니다. 새 QR 코드를 스캔해 주세요.',
                    DEVICE_LIMIT: '등록할 수 있는 기기 수를 초과했습니다. 컴퓨터 설정에서 사용하지 않는 휴대폰을 해제해 주세요.',
                    RATE_LIMITED: '요청이 잠시 제한되었습니다. 잠시 후 다시 시도해 주세요.',
                    PAIRING_UNAVAILABLE: '새 연결 QR 코드를 만들지 못했습니다. 컴퓨터에서 다시 시도해 주세요.'
                }
                if (message.code === 'PAIRING_UNAVAILABLE' && connected) {
                    connectionDetail.textContent = messages.PAIRING_UNAVAILABLE
                    return;
                }
                if (message.code === 'RATE_LIMITED' && connected) {
                    show('connected', '연결됨', messages.RATE_LIMITED)
                    return;
                }
                if (message.code === 'DEVICE_NOT_TRUSTED') localStorage.removeItem(STORAGE_KEY)
                connectButton.hidden = false
                connectButton.disabled = false
                connectButton.textContent = loadDevice() ? '다시 연결' : '휴대폰 연결'
                show('disconnected', '연결 실패', messages[message.code] || '연결 정보를 확인한 뒤 다시 시도해 주세요.')
            }
        })
        socket.addEventListener('error', () => {
            connectButton.hidden = false
            connectButton.disabled = false
            connectButton.textContent = loadDevice() ? '다시 연결' : '휴대폰 연결'
            show('disconnected', '연결할 수 없습니다', '컴퓨터와 이 휴대폰이 같은 Wi-Fi에 연결되어 있는지 확인해 주세요.')
        })
        socket.addEventListener('close', () => {
            connected = false
            controls.hidden = false
            if (loadDevice()) {
                show('connecting', '다시 연결 중', '연결이 끊어져 자동으로 다시 연결하고 있습니다.')
                retryTimer = setTimeout(connect, 1800)
            } else {
                connectButton.hidden = false
                connectButton.disabled = false
                show('disconnected', '연결 안 됨', '필요하면 컴퓨터의 QR 코드를 다시 스캔해 주세요.')
            }
        })
    }

    controls.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-command]')
        if (button) {
            if (typeof navigator.vibrate === 'function') navigator.vibrate(18)
            sendCommand(button.dataset.command)
        }
    })

    connectionStatus.addEventListener('click', () => {
        const device = loadDevice()
        pairing = decodePairingPayload()
        pairingControls.hidden = !!device || !pairing
        deviceControls.hidden = !device || !connected
        if (device && connected) connectionDetail.textContent = '이 휴대폰 연결을 해제하거나 다른 휴대폰을 추가할 수 있습니다.'
        else if (pairing) connectionDetail.textContent = '휴대폰 이름을 확인하고 연결을 완료하세요.'
        else connectionDetail.textContent = '휴대폰을 연결하려면 컴퓨터의 HomeTube 설정에서 페어링 QR 코드를 스캔하세요.'
        connectionDialog.showModal()
    })

    connectButton.addEventListener('click', connect)
    addDeviceButton.addEventListener('click', () => {
        if (!connected || socket?.readyState !== WebSocket.OPEN) return
        socket.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'request-pairing' }))
        connectionDetail.textContent = '컴퓨터에 새 페어링 QR 코드를 요청했습니다.'
    })
    closePairingViewButton.addEventListener('click', () => {
        if (!connected || socket?.readyState !== WebSocket.OPEN) return
        socket.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'close-pairing-view' }))
        connectionDetail.textContent = '컴퓨터의 페어링 화면을 닫았습니다.'
    })
    focusPairingWindowButton.addEventListener('click', () => {
        if (!connected || socket?.readyState !== WebSocket.OPEN) return
        socket.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'focus-pairing-window' }))
        connectionDetail.textContent = '컴퓨터에서 페어링 창을 앞으로 가져옵니다.'
    })
    disconnectDeviceButton.addEventListener('click', () => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ protocol: 'hometube-remote', version: 1, type: 'unpair' }))
        else localStorage.removeItem(STORAGE_KEY)
    })

    controls.hidden = false
    if (loadDevice()) {
        nameInput.disabled = true
        show('connecting', '연결 중', '등록된 휴대폰으로 HomeTube에 연결하고 있습니다.')
        connect()
    } else if (decodePairingPayload()) {
        nameInput.value = localStorage.getItem('hometube.remote.name') || ''
        pairingControls.hidden = false
        deviceControls.hidden = true
        connectButton.hidden = false
        connectButton.textContent = '이 휴대폰 연결'
        show('disconnected', '연결 안 됨', '휴대폰 이름을 확인하고 연결 버튼을 눌러 주세요.')
        connectionDialog.showModal()
    } else {
        pairingControls.hidden = true
        deviceControls.hidden = true
        show('disconnected', '연결 안 됨', '연결 상태 버튼에서 연결 관리를 열 수 있습니다.')
    }
})()

(() => {
    const pairing = document.querySelector('#pairing')
    const stopped = document.querySelector('#stopped')
    const qr = document.querySelector('#qr')
    const code = document.querySelector('#code')
    const expires = document.querySelector('#expires')
    const address = document.querySelector('#address')
    const dot = document.querySelector('#dot')
    const count = document.querySelector('#count')
    const devices = document.querySelector('#devices')
    const closeButton = document.querySelector('#close')
    const copy = {
        en: {
            title: 'HomeTube Pairing', close: 'Close pairing window', heading: 'Connect a phone',
            intro: 'Scan this QR code with a phone connected to the same Wi-Fi network.', label: 'Pairing code',
            stopped: 'The remote server is stopped', stoppedDetail: 'Start the server and create a new pairing code in HomeTube Settings.',
            notice: 'Use a trusted private Wi-Fi network. This connection uses HTTP and local traffic is not encrypted. Allow HomeTube through Windows Firewall on private networks only. No router port is opened.',
            expires: (seconds) => `Code expires in ${seconds} seconds.`, expired: 'The pairing code expired. Create a new code in HomeTube Settings.',
            address: (url) => `Phone address: ${url}`, count: (number) => `${number} connected phone${number === 1 ? '' : 's'}`,
            connected: 'Connected', disconnected: 'Not connected', qrAlt: 'HomeTube phone pairing QR code'
        },
        ko: {
            title: 'HomeTube 휴대폰 연결', close: '페어링 화면 닫기', heading: '휴대폰 연결',
            intro: '같은 Wi-Fi에 연결된 휴대폰 카메라로 QR 코드를 스캔하세요.', label: '페어링 코드',
            stopped: '리모컨 서버가 중지되었습니다', stoppedDetail: 'HomeTube 설정에서 서버와 새 페어링 코드를 시작할 수 있습니다.',
            notice: '신뢰할 수 있는 개인 Wi-Fi에서만 사용하세요. 이 연결은 HTTP를 사용하며 로컬 트래픽이 암호화되지 않습니다. Windows 방화벽에서는 개인 네트워크만 허용하세요. 라우터 포트는 열지 않습니다.',
            expires: (seconds) => `코드는 ${seconds}초 뒤 만료됩니다.`, expired: '페어링 코드가 만료되었습니다. HomeTube 설정에서 새 코드를 만들 수 있습니다.',
            address: (url) => `휴대폰 주소: ${url}`, count: (number) => `연결된 휴대폰 ${number}대`,
            connected: '연결됨', disconnected: '연결 안 됨', qrAlt: 'HomeTube 휴대폰 페어링 QR 코드'
        }
    }
    let text = copy.en

    function applyLanguage(language) {
        text = language === 'ko' ? copy.ko : copy.en
        document.documentElement.lang = language === 'ko' ? 'ko' : 'en'
        document.querySelector('#page-title').textContent = text.title
        closeButton.textContent = text.close
        document.querySelector('#heading').textContent = text.heading
        document.querySelector('#intro').textContent = text.intro
        document.querySelector('#pairing-label').textContent = text.label
        document.querySelector('#stopped-title').textContent = text.stopped
        document.querySelector('#stopped-detail').textContent = text.stoppedDetail
        document.querySelector('#notice').textContent = text.notice
        qr.alt = text.qrAlt
    }

    function render(state) {
        if (!state || typeof state !== 'object') return;
        applyLanguage(state.uiLanguage)
        pairing.hidden = !state.active || !state.pairing
        stopped.hidden = !!state.active
        if (state.pairing?.qrDataUrl) {
            qr.src = state.pairing.qrDataUrl
            code.textContent = state.pairing.code
            const seconds = Math.max(0, Math.ceil((state.pairing.expiresAt - Date.now()) / 1000))
            expires.textContent = text.expires(seconds)
            address.textContent = text.address(`http://${state.host}:${state.port}`)
        } else {
            qr.removeAttribute('src')
            code.textContent = ''
            expires.textContent = state.active ? text.expired : ''
            address.textContent = ''
        }

        const connected = (state.devices || []).filter((device) => device.connected).length
        count.textContent = text.count(connected)
        dot.classList.toggle('connected', connected > 0)
        devices.replaceChildren(...(state.devices || []).map((device) => {
            const item = document.createElement('li')
            const name = document.createElement('strong')
            const detail = document.createElement('span')
            name.textContent = device.name
            detail.textContent = ` · ${device.connected ? text.connected : text.disconnected}`
            item.append(name, detail)
            return item
        }))
    }

    closeButton.addEventListener('click', () => window.homeTubePairing?.close())
    window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') window.homeTubePairing?.close()
    })
    window.homeTubePairing?.onState(render)
})()

function togglePlayback(player, video) {
    try {
        const state = player?.getPlayerState?.()
        if (state === 1 && typeof player.pauseVideo === 'function') {
            player.pauseVideo()
            return true
        }
        if (state !== 1 && typeof player.playVideo === 'function') {
            player.playVideo()
            return true
        }
    } catch (_) {}

    try {
        if (!video) return false
        if (video.paused) {
            const result = video.play()
            result?.catch?.(() => {})
        } else {
            video.pause()
        }
        return true
    } catch (_) {
        return false
    }
}

module.exports = { togglePlayback }

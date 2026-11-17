const configManager = require('../../../config')

module.exports = {
    id: 'language',
    title: (locale) => locale.language.title,
    description: (locale) => locale.language.description,
    rows: (config, locale) => {
        const current = config.ui_language || 'system'
        const options = [
            [ 'system', locale.language.system ],
            [ 'ko', locale.language.korean ],
            [ 'en', locale.language.english ]
        ]

        return [
            { type: 'info', title: locale.language.current, value: locale.language[current] || locale.language.system },
            ...options.map(([ value, label ]) => ({
                type: 'button',
                title: `${current === value ? '✓ ' : ''}${label}`,
                description: current === value ? locale.language.selected : '',
                run: () => configManager.set({ ui_language: value })
            })),
            { type: 'text', text: locale.language.restart }
        ]
    }
}

const fs = require('fs')
const path = require('path')
const functions = require('./functions')
const configManager = require('../config')

const localeFolder = path.join(__dirname, '../', '../', '../', 'locale')

let locale;
let translation = { language: 'en', name: 'English', missing: 0, complete: true }

//counts the strings in the base locale that the language file doesn't have
function countMissing(base, partial) {
    let missing = 0;

    for (const [ key, value ] of Object.entries(base)) {
        if (key.endsWith('_unused')) continue; //not shown anywhere, doesn't count

        const translated = partial?.[key]

        if (value && typeof value === 'object') {
            missing += countMissing(value, translated || {})
        } else if (translated === undefined) {
            missing++;
        }
    }

    return missing;
}

function languageName(code) {
    try {
        return new Intl.DisplayNames([ code ], { type: 'language' }).of(code) || code;
    } catch {
        return code;
    }
}

Promise.resolve().then(async () => {
    // Settings language follows the computer/browser locale, not the YouTube
    // account language. The app currently supports Korean and English only.
    const systemLocale = Intl.DateTimeFormat().resolvedOptions().locale || navigator.language || 'en'
    const requestedLanguage = configManager.get().ui_language
    const language = requestedLanguage === 'ko' || requestedLanguage === 'en'
        ? requestedLanguage
        : /^ko(?:[-_]|$)/i.test(systemLocale) ? 'ko' : 'en'

    const localeFiles = await fs.promises.readdir(localeFolder)

    const baseLocaleStr = await fs.promises.readFile(path.join(localeFolder, 'en.json'), 'utf-8')
    const baseLocale = JSON.parse(baseLocaleStr)

    const langFile = localeFiles.includes(`${language}.json`) ? `${language}.json` : null

    const str = await fs.promises.readFile(path.join(localeFolder, langFile || 'en.json'), 'utf-8')
    const partialLocale = JSON.parse(str)

    const missing = language === 'en' ? 0 : countMissing(baseLocale.settings, partialLocale.settings || {})

    translation = {
        language,
        name: languageName(language),
        missing,
        complete: missing === 0
    }

    locale = functions.deepMerge(baseLocale, partialLocale)
}).catch((error) => console.error('[locale] Failed to load locale', error))

async function waitUntilAvailable() {
    await functions.waitForCondition(() => !!locale)
}

function getLocale() {
    return locale;
}

function getTranslation() {
    return translation;
}

module.exports = {
    waitUntilAvailable,
    getLocale,
    getTranslation
}

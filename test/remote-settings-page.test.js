const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')

test('HomeTube Remote settings page reads strings from the settings locale object', async () => {
    const originalLoad = Module._load
    Module._load = function (request, parent, isMain) {
        if (request === 'electron') {
            return { ipcRenderer: { invoke: async () => ({ active: false, devices: [] }), on() {} } }
        }
        return originalLoad.call(this, request, parent, isMain)
    }

    let page
    try {
        const pagePath = require.resolve('../src/preload/modules/settings/pages/remote')
        delete require.cache[pagePath]
        page = require(pagePath)
    } finally {
        Module._load = originalLoad
    }

    const locale = JSON.parse(fs.readFileSync(path.join(__dirname, '../locale/en.json'), 'utf8')).settings
    assert.equal(page.title(locale), locale.remote.title)
    assert.equal(page.description(locale), locale.remote.description)
    assert.equal((await page.rows({}, locale))[0].title, locale.remote.status)
})

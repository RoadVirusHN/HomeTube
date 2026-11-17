const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const webPath = path.join(__dirname, '../src/remote/web')

test('remote page exposes connection and help dialogs and delegates search to Leanback', () => {
    const html = fs.readFileSync(path.join(webPath, 'index.html'), 'utf8')
    const css = fs.readFileSync(path.join(webPath, 'style.css'), 'utf8')
    const script = fs.readFileSync(path.join(webPath, 'remote.js'), 'utf8')

    assert.match(html, /id="connection-button"/)
    assert.match(html, /id="connection-dialog"/)
    assert.match(html, /id="help-dialog"/)
    assert.doesNotMatch(html, /search-dialog|search-form|YouTube 검색/)
    assert.match(html, /Leanback 검색 메뉴/)
    assert.match(css, /body\s*\{/)
    assert.doesNotMatch(css, /\.remote-controls\s*\{[^}]*overflow/i)
    assert.doesNotMatch(css, /\.remote-controls\s*\{[^}]*position:\s*fixed/i)
    assert.doesNotMatch(script, /SEARCH|sendSearch/)
    assert.match(script, /connectionDialog\.showModal\(\)/)
    assert.match(script, /helpDialog\.showModal\(\)/)
})

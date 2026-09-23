const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
test('памятка личного рабочего места не обещает публикацию или автоматический повтор', () => {
  const dom = new JSDOM('<main><div class="content-header"></div></main>', {runScripts: 'outside-only'});
  try {
    const w = dom.window;
    w.eval(fs.readFileSync(require.resolve('./module-guide.js'), 'utf8'));
    const container = w.document.querySelector('main');
    w.SbCabinet.renderModuleGuide(container, 'actor-workspace', {canView: () => true, escapeHTML: (s) => s});
    assert.equal(container.querySelectorAll('li').length, 4);
    assert.match(container.textContent, /личную программу/);
    assert.match(container.textContent, /публикации не запускаются/);
    assert.match(container.textContent, /повтор запроса выполняется только по кнопке/);
    assert.equal(container.querySelector('a').getAttribute('href'), '#actor-workspace');
    w.SbCabinet.renderModuleGuide(container, 'actor-workspace', {canView: () => false, escapeHTML: (s) => s});
    assert.equal(container.querySelectorAll('.module-guide').length, 1);
    assert.equal(container.querySelector('a'), null);
  } finally {dom.window.close();}
});

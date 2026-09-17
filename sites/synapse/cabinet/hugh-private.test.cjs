const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SOURCE = fs.readFileSync(path.join(__dirname, 'hugh.js'), 'utf8');
const settle = async (rounds = 4) => { for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('личный Хью не дорисовывает поздний ответ в панель, которую уже занял общий чат', async () => {
  const dom = new JSDOM('<section id="hugh-view"></section>', { runScripts: 'outside-only', url: 'https://synapse.synapsebusiness.ru/cabinet.html' });
  const w = dom.window;
  const d = w.document;
  w.AbortSignal.timeout = () => new w.AbortController().signal;
  w.AbortSignal.any = (signals) => {
    const controller = new w.AbortController();
    for (const signal of signals) {
      if (signal.aborted) { controller.abort(signal.reason); break; }
      signal.addEventListener('abort', () => controller.abort(signal.reason));
    }
    return controller.signal;
  };
  const history = deferred();
  const calls = [];
  w.fetch = (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/conversations')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ id: 'c1', visitorToken: 'visitor', reply: 'Здравствуйте' }) });
    return history.promise.then((body) => ({ ok: true, status: 200, json: async () => body }));
  };
  w.SbCabinet = {};
  w.eval(SOURCE);
  const ctx = {
    identity: { role: 'owner', userId: 7, csrfToken: 'csrf-token' },
    selectedProjectId: 'palitra-love',
    byId: (id) => d.getElementById(id),
    escapeHTML: (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  };

  const rendering = w.SbCabinet.privateHugh.render(ctx);
  await settle();
  assert.ok(calls.length >= 2);

  w.SbCabinet.privateHugh.stop();
  d.getElementById('hugh-view').innerHTML = '<p id="shared-marker">Общий чат проекта</p>';
  history.resolve({ messages: [{ role: 'assistant', text: 'Поздний ответ владельцу' }] });
  await rendering;
  await settle();

  assert.equal(d.getElementById('hugh-view').innerHTML, '<p id="shared-marker">Общий чат проекта</p>');
  assert.doesNotMatch(d.body.textContent, /Поздний ответ владельцу|Не удалось загрузить/);
  w.close();
});

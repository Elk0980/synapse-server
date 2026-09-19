const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { JSDOM } = require('jsdom');
const script = fs.readFileSync(require.resolve('./owner-private-chat.js'), 'utf8');
const css = fs.readFileSync(require.resolve('./owner-private-chat.css'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

const SECRET = 'Личная заметка владельца про клиента';
const PROJECTS = [{ id: 'alvi', name: 'ALVI' }, { id: 'avokado', name: 'Авокадо' }, { id: 'palitra-love', name: 'Палитра' }];
const view = (patch = {}) => ({
  audience: 'owner-private',
  audienceLabel: 'Личная переписка: только вы и Хью. Клиент её не видит.',
  project: { id: 'alvi', name: 'ALVI' },
  projects: PROJECTS,
  messages: [{ id: 1, author: 'owner', text: SECRET, at: '2026-09-19T10:00:00.000Z' },
    { id: 2, author: 'assistant', text: 'Ответ Хью', at: '2026-09-19T10:00:05.000Z' }],
  tasks: [{ id: 7, title: 'Согласовать план', status: 'todo', due: null }],
  clientChat: { href: '#hugh-project:alvi', label: 'Общий чат проекта: клиент, вы и Хью — видно клиенту', audience: 'client-shared' },
  handoff: { enabled: false, reason: 'Перенос пока не включён.' },
  ...patch
});

function fixture({ role = 'owner', respond, width = 1200 } = {}) {
  const dom = new JSDOM('<div id="host"></div>', { url: 'https://test.local', runScripts: 'outside-only' });
  const w = dom.window, calls = [];
  w.matchMedia = (query) => ({ matches: /max-width:\s*760px/.test(query) ? width <= 760 : false,
    addEventListener() {}, removeEventListener() {} });
  w.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET',
      body: options.body ? JSON.parse(options.body) : null, csrf: options.headers?.['X-CSRF-Token'] };
    calls.push(call);
    const value = respond ? respond(call) : undefined;
    if (value instanceof Error) return { ok: false, json: async () => ({ error: value.message }) };
    return { ok: true, json: async () => (value === undefined ? view() : value) };
  };
  w.AbortSignal.any = w.AbortSignal.any || ((list) => list[0]);
  w.SbCabinet = {};
  w.eval(script);
  const root = w.document.getElementById('host');
  const opened = [];
  const started = w.SbCabinet.ownerPrivateChat.render({
    identity: { role, csrfToken: 'csrf-token', userId: 1 }, root, project: 'alvi',
    escapeHTML: (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    openShared: () => opened.push('shared')
  });
  return { dom, w, root, calls, opened, started, close: () => { w.SbCabinet.ownerPrivateChat.stop(); w.close(); } };
}

test('владелец видит вкладки проектов, метку аудитории и личную историю', async () => {
  const f = fixture();
  try {
    assert.equal(await f.started, true);
    await tick(); await tick();
    const tabs = [...f.root.querySelectorAll('[data-opc-project]')].map((b) => b.dataset.opcProject);
    assert.deepEqual(tabs, ['alvi', 'avokado', 'palitra-love']);
    assert.equal(f.root.querySelector('[data-opc-project="alvi"]').getAttribute('aria-pressed'), 'true');
    assert.match(f.root.textContent, /Клиент её не видит/);
    assert.match(f.root.textContent, new RegExp(SECRET));
    assert.match(f.root.textContent, /Ответ Хью/);
    assert.equal(f.calls[0].url, '/content/owner-chat/alvi');
    assert.equal(f.calls[0].method, 'GET');
  } finally { f.close(); }
});

test('не владельцу блок не показывается и запросов не делает', async () => {
  const f = fixture({ role: 'editor' });
  try {
    assert.equal(await f.started, false);
    await tick();
    assert.equal(f.calls.length, 0);
    assert.equal(f.root.innerHTML, '');
  } finally { f.close(); }
});

test('переключение проекта перечитывает историю и не смешивает её с прежней', async () => {
  const f = fixture({ respond: (call) => (call.url.includes('/avokado')
    ? view({ project: { id: 'avokado', name: 'Авокадо' },
      messages: [{ id: 5, author: 'owner', text: 'Заметка по Авокадо', at: '2026-09-19T11:00:00.000Z' }],
      tasks: [] })
    : undefined) });
  try {
    await f.started; await tick(); await tick();
    f.root.querySelector('[data-opc-project="avokado"]').click();
    await tick(); await tick(); await tick();
    assert.match(f.root.textContent, /Заметка по Авокадо/);
    assert.equal(f.root.textContent.includes(SECRET), false, 'история прежнего проекта не остаётся на экране');
    assert.equal(f.root.querySelector('[data-opc-project="avokado"]').getAttribute('aria-pressed'), 'true');
    assert.ok(f.calls.some((call) => call.url === '/content/owner-chat/avokado'));
  } finally { f.close(); }
});

test('отправка идёт на личный маршрут с CSRF и не оставляет следов в браузере', async () => {
  const sent = [];
  const f = fixture({ respond: (call) => {
    if (call.method === 'POST') { sent.push(call); return view({ messages: [...view().messages,
      { id: 3, author: 'owner', text: 'Новое личное сообщение', at: '2026-09-19T12:00:00.000Z' }] }); }
    return undefined;
  } });
  try {
    await f.started; await tick(); await tick();
    f.root.querySelector('#opc-input').value = 'Новое личное сообщение';
    f.root.querySelector('[data-opc-compose]').dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));
    await tick(); await tick(); await tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, '/content/owner-chat/alvi/messages');
    assert.equal(sent[0].csrf, 'csrf-token');
    assert.equal(sent[0].body.text, 'Новое личное сообщение');
    assert.ok(sent[0].body.requestId, 'повтор защищён идентификатором запроса');
    // Личная переписка не оседает ни в хранилище браузера, ни в адресе страницы.
    assert.equal(f.w.localStorage.length, 0);
    assert.equal(f.w.sessionStorage.length, 0);
    assert.equal(f.w.location.search, '');
  } finally { f.close(); }
});

test('задачи проекта показаны отдельно и только для чтения, рядом — метка общего чата', async () => {
  const f = fixture();
  try {
    await f.started; await tick(); await tick();
    const aside = f.root.querySelector('.opc-project');
    assert.match(aside.textContent, /Согласовать план/);
    assert.match(aside.textContent, /Только для чтения/);
    assert.equal(aside.textContent.includes(SECRET), false, 'личный текст в карточки задач не попадает');
    assert.match(aside.textContent, /видно клиенту/);
    assert.equal(aside.querySelector('input,textarea'), null, 'задачи отсюда не редактируются');
    f.root.querySelector('[data-opc-shared]').click();
    assert.deepEqual(f.opened, ['shared'], 'общий чат открывается явным действием');
  } finally { f.close(); }
});

test('ошибка отправки сохраняет набранный текст и честно её показывает', async () => {
  const f = fixture({ respond: (call) => (call.method === 'POST' ? new Error('Хью сейчас недоступен') : undefined) });
  try {
    await f.started; await tick(); await tick();
    f.root.querySelector('#opc-input').value = 'Черновик';
    f.root.querySelector('[data-opc-compose]').dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));
    await tick(); await tick(); await tick();
    assert.match(f.root.textContent, /Хью сейчас недоступен/);
    assert.equal(f.root.querySelector('#opc-input').value, 'Черновик', 'набранный текст не потерян');
    assert.equal(f.root.querySelector('#opc-input').disabled, false);
  } finally { f.close(); }
});

test('на узком экране вкладки и форма не ломают вёрстку', async () => {
  const f = fixture({ width: 600 });
  try {
    await f.started; await tick(); await tick();
    assert.ok(f.root.querySelector('.opc-tabs'), 'полоса вкладок присутствует');
    assert.ok(f.root.querySelectorAll('[data-opc-project]').length >= 3);
  } finally { f.close(); }
  // Мобильные правила описаны в стилях: вкладки прокручиваются, колонка одна, кнопка во всю ширину.
  const mobile = css.slice(css.indexOf('@media (max-width: 760px)'));
  assert.match(mobile, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(mobile, /overflow-x:\s*auto/);
  assert.match(mobile, /width:\s*100%/);
  // Цели нажатия не меньше 44 пикселей, чтобы попадать пальцем.
  assert.match(css, /min-height:\s*44px/);
});

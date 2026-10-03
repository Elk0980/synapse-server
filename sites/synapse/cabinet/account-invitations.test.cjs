/* Интерфейс приглашений владельца (specs/085, T006): Palitra и три права фиксированы, получатели — только
   подтверждённые сервером, ни токена, ни пароля, ни ссылки, ни произвольного адреса; понятные состояния.
   node --test sites/synapse/cabinet/account-invitations.test.cjs (jsdom из среды проекта) */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { COMPANIES, PERMISSIONS, DEPENDENCIES, PRICE_CLIENT_PRESET } = require('../../../ops/content/auth-store');

const html = fs.readFileSync(path.join(__dirname, '../cabinet.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, 'account.js'), 'utf8');
const PILOT = { company: 'palitra-love', permissions: ['price.edit', 'price.view', 'sites.view'] };
const invitation = (over = {}) => ({ id: 7, company: 'palitra-love', permissions: PILOT.permissions, login: 'newbie', displayName: 'Новичок',
  status: 'pending', delivery: 'delivered', recipient: { id: 3, displayName: 'Синтетический', channel: 'telegram', address: '•••777', verified: true },
  createdAt: '2026-10-02T12:00:00.000Z', expiresAt: '2026-10-03T12:00:00.000Z', deliveryMessageId: '9001', ...over });

async function fixture(state, { role = 'owner' } = {}) {
  const errors = [], calls = [], views = {};
  const vc = new VirtualConsole(); vc.on('jsdomError', (error) => errors.push(error.message));
  const dom = new JSDOM(html, { url: 'https://cabinet.test/cabinet.html', runScripts: 'outside-only', virtualConsole: vc });
  const w = dom.window, d = w.document;
  w.SbCabinet = { registerView: (name, view) => { views[name] = view; } };
  w.eval(script);
  const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const options = { companies: Object.entries(COMPANIES).map(([id, c]) => ({ id, ...c })), permissions: PERMISSIONS, dependencies: DEPENDENCIES, presets: [PRICE_CLIENT_PRESET] };
  views.accounts.initialize({ identity: { role, csrfToken: 'synthetic-csrf' }, byId: (id) => d.getElementById(id), escapeHTML,
    apiJson: async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
      if (url.endsWith('/access-options')) return options;
      if (url === '/content/admin/accounts') return { accounts: [] };
      if (url === '/content/admin/invitations' && opts.method === 'POST') { state.invitations.unshift(invitation({ id: 8, delivery: 'queued' })); return { invitation: invitation({ id: 8, delivery: 'queued' }) }; }
      if (/\/revoke$/.test(url)) { state.invitations[0].status = 'revoked'; return { invitation: state.invitations[0] }; }
      if (url === '/content/admin/invitations') return JSON.parse(JSON.stringify(state));
      throw new Error(`unexpected ${url}`);
    } });
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  await settle();
  return { w, d, calls, errors, settle, card: () => d.getElementById('invitations-card'), close: () => w.close() };
}

test('канал выключен (production): понятная причина, кнопка неактивна, ни одного POST; Palitra и три права фиксированы', async () => {
  const f = await fixture({ invitations: [invitation({ delivery: 'channel_disabled', recipient: null })], pilot: PILOT, recipients: [], channel: 'disabled' });
  try {
    const text = f.card().textContent;
    assert.match(text, /Компания: Palitra\. Права: Прайс — товары и цены, Прайс — просмотр, Сайты — просмотр\. Набор фиксирован сервером/);
    assert.match(text, /Отправка приглашений выключена: канал доставки не настроен/);
    assert.match(text, /Не отправлено: канал доставки выключен/);
    assert.equal(f.card().querySelector('[data-invite-form] button[type="submit"]').disabled, true);
    f.card().querySelector('[data-invite-form]').dispatchEvent(new f.w.Event('submit', { cancelable: true }));
    await f.settle();
    assert.equal(f.calls.filter((c) => c.url.includes('invitations') && c.method === 'POST').length, 0);
    // Полей прав, компаний, адреса, пароля, ссылки нет.
    for (const name of ['permissions', 'companies', 'chatId', 'to', 'password', 'token', 'link', 'address']) {
      assert.equal(f.card().querySelector(`[name="${name}"]`), null, name);
    }
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('канал включён: только подтверждённые получатели; создание шлёт ровно логин, имя и номер получателя с CSRF; отзыв; статусы', async () => {
  const state = { invitations: [invitation(), invitation({ id: 6, login: 'old', status: 'accepted', delivery: 'delivered' }), invitation({ id: 5, login: 'gone', status: 'expired', delivery: 'uncertain' })],
    pilot: PILOT, channel: 'enabled',
    recipients: [{ id: 3, displayName: 'Синтетический', channel: 'telegram', address: '•••777', verified: true }, { id: 4, displayName: 'Отозванный', channel: 'telegram', address: '•••778', verified: false }] };
  const f = await fixture(state);
  try {
    const options = [...f.card().querySelectorAll('select[name="recipientId"] option')].map((o) => [o.value, o.textContent]);
    assert.deepEqual(options, [['3', 'Синтетический · telegram •••777']], 'неподтверждённый получатель не предлагается');
    const text = f.card().textContent;
    assert.match(text, /Ожидает принятия[\s\S]*Доставлено в личный канал \(это ещё не вход\)/);
    assert.match(text, /Принято — учётная запись создана/);
    assert.match(text, /Срок истёк[\s\S]*Исход отправки неизвестен — автоматического повтора нет/);
    assert.equal(f.card().querySelectorAll('[data-invite-revoke]').length, 1, 'отзыв только у действующего');
    const form = f.card().querySelector('[data-invite-form]');
    form.elements.login.value = 'newbie2'; form.elements.displayName.value = 'Новичок 2';
    form.dispatchEvent(new f.w.Event('submit', { cancelable: true }));
    form.dispatchEvent(new f.w.Event('submit', { cancelable: true }));
    await f.settle();
    const posts = f.calls.filter((c) => c.url === '/content/admin/invitations' && c.method === 'POST');
    assert.equal(posts.length, 1, 'одно создание на повторные нажатия');
    assert.deepEqual(posts[0].body, { login: 'newbie2', displayName: 'Новичок 2', recipientId: 3 });
    assert.equal(posts[0].headers['X-CSRF-Token'], 'synthetic-csrf');
    assert.match(f.card().textContent, /Приглашение создано: В очереди на отправку/);
    f.card().querySelector('[data-invite-revoke]').click();
    await f.settle();
    const revoke = f.calls.find((c) => /\/revoke$/.test(c.url));
    assert.deepEqual([revoke.url, revoke.method, revoke.headers['X-CSRF-Token']], ['/content/admin/invitations/8/revoke', 'POST', 'synthetic-csrf']);
    assert.doesNotMatch(f.card().innerHTML, /invite=|token|password|[A-Za-z0-9_-]{43}/, 'ни ссылки, ни секрета');
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('не-владелец не видит раздел приглашений и не запрашивает его', async () => {
  const f = await fixture({ invitations: [], pilot: PILOT, recipients: [], channel: 'disabled' }, { role: 'editor' });
  try {
    assert.equal(f.card(), null);
    assert.equal(f.calls.filter((c) => c.url.includes('invitations')).length, 0);
  } finally { f.close(); }
});

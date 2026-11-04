/* Страница принятия приглашения (specs/085): фрагмент убирается до запросов, секрет и пароль не попадают
   в хранилища, адрес и сторонние ресурсы; запросы только на свой сервер.
   node --test sites/synapse/accept-invitation.test.cjs (jsdom из среды проекта) */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const page = require('./accept-invitation.js');

const SECRET = 'A'.repeat(42) + 'b';
const html = fs.readFileSync(path.join(__dirname, 'accept-invitation.html'), 'utf8');
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

function boot(routes) {
  const dom = new JSDOM(html, { url: `https://synapse.synapsebusiness.ru/accept-invitation.html#invite=${SECRET}` });
  const win = dom.window, calls = [];
  win.fetch = async (url, options) => {
    calls.push({ url, options, hashAtCall: win.location.hash, body: JSON.parse(options.body) });
    const [status, body] = routes[url](JSON.parse(options.body));
    return { ok: status < 300, status, json: async () => body };
  };
  return { win, calls };
}
const preview = () => [200, { company: { id: 'palitra-love', title: 'Palitra' }, login: 'newbie', displayName: 'Новичок',
  permissions: ['price.edit', 'price.view', 'sites.view'], expiresAt: '2026-10-03T12:00:00.000Z' }];

test('секрет убирается из адреса до запросов; запросы только на свой сервер; хранилища пусты; пароль задаёт получатель', async () => {
  const { win, calls } = boot({ '/content/invitations/preview': preview, '/content/invitations/accept': () => [201, { ok: true, login: 'newbie' }] });
  await page.start(win);
  assert.equal(win.location.hash, '', 'фрагмент очищен');
  assert.equal(calls[0].hashAtCall, '', 'до первого запроса');
  assert.match(win.document.body.textContent, /Palitra[\s\S]*newbie[\s\S]*Изменение товаров и цен/);
  const form = win.document.querySelector('[data-invite-form]');
  form.elements.password.value = 'synthetic-pass-123'; form.elements.repeat.value = 'synthetic-pass-12X';
  form.dispatchEvent(new win.Event('submit', { cancelable: true }));
  await settle();
  assert.match(win.document.body.textContent, /Пароли не совпадают/);
  assert.equal(calls.length, 1, 'несовпадение не отправляется');
  form.elements.repeat.value = 'synthetic-pass-123';
  form.dispatchEvent(new win.Event('submit', { cancelable: true }));
  form.dispatchEvent(new win.Event('submit', { cancelable: true }));
  await settle();
  assert.equal(calls.length, 2, 'одно принятие на повторные нажатия');
  assert.deepEqual(calls[1].body, { token: SECRET, password: 'synthetic-pass-123' });
  for (const call of calls) {
    assert.ok(call.url.startsWith('/content/invitations/'), 'только свой сервер');
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.referrerPolicy, 'no-referrer');
  }
  assert.match(win.document.body.textContent, /Пароль сохранён/);
  assert.equal(win.localStorage.length + win.sessionStorage.length, 0);
  assert.equal(win.document.cookie, '');
  assert.ok(!win.document.body.innerHTML.includes(SECRET) && !win.document.body.innerHTML.includes('synthetic-pass-123'));
  assert.doesNotMatch(html, /https?:\/\/(?!synapse)/, 'без сторонних ресурсов');
  assert.match(html, /name="referrer" content="no-referrer"/);
});

test('недействительная ссылка: понятная ошибка, формы нет; без фрагмента запросов нет', async () => {
  const bad = boot({ '/content/invitations/preview': () => [410, { error: 'Приглашение отозвано' }] });
  await page.start(bad.win);
  assert.match(bad.win.document.body.textContent, /Приглашение отозвано/);
  assert.equal(bad.win.document.querySelector('[data-invite-form]'), null);
  const dom = new JSDOM(html, { url: 'https://synapse.synapsebusiness.ru/accept-invitation.html' });
  let fetched = 0; dom.window.fetch = async () => { fetched += 1; };
  await page.start(dom.window);
  assert.equal(fetched, 0);
  assert.match(dom.window.document.body.textContent, /неполная/);
});

test('страница совместима с контрактом заголовков выпуска: без встроенных скриптов/стилей/обработчиков, только свои файлы', () => {
  const contract = fs.readFileSync(path.join(__dirname, '../../specs/085-safe-invitations/release-headers.md'), 'utf8');
  for (const header of ['Cache-Control "no-store"', 'Referrer-Policy "no-referrer"', 'X-Robots-Tag "noindex, nofollow"', 'X-Content-Type-Options "nosniff"',
    "Content-Security-Policy \"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\""]) {
    assert.ok(contract.includes(header), header);
  }
  assert.match(contract, /@accept_invitation path \/accept-invitation\.html \/accept-invitation\.js \/accept-invitation\.css/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i, 'нет встроенного скрипта');
  assert.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+=/i, 'нет встроенных стилей и обработчиков');
  const refs = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(refs.sort(), ['accept-invitation.css', 'accept-invitation.js']);
  const js = fs.readFileSync(path.join(__dirname, 'accept-invitation.js'), 'utf8');
  assert.doesNotMatch(js, /style=|\son[a-z]+=|https?:\/\//, 'разметка из JS без стилей, обработчиков и внешних адресов');
  assert.ok(fs.existsSync(path.join(__dirname, 'accept-invitation.css')));
});

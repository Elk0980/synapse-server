// Несколько фото у товара в редакторе Palitra (PALITRA_POZHELANIYA §5: «несколько фото у каждого товара»).
// Обложка — прежнее поле photo; дополнительные фото — необязательный список gallery, который добавляет
// сам владелец. Старые товары без gallery сохраняются без изменений. Синтетические данные и загрузки.
// NODE_PATH=<jsdom> node --test sites/synapse/price-editor-palitra-gallery.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const root = __dirname;
const html = fs.readFileSync(path.join(root, 'price-editor-palitra.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'price-render-palitra.js'), 'utf8');
const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const tick = () => new Promise((resolve) => setImmediate(resolve));
const profile = { role: 'owner', csrfToken: 'synthetic-csrf-only' };
const LEGACY = { id: 'bukety-1', title: 'Белые гортензии', price: '4 590 руб.', note: 'Своё примечание', oldPrice: '4 990 руб.', quizEnabled: true, photo: '/assets/img/gortenzii.jpg' };
const SEED = { version: 1, blocks: { self: { title: 'Популярное', max: 8 }, two: { title: 'Подборки', max: 8 } }, showcase: { self: [], two: [] },
  categories: [{ id: 'bukety', title: 'Букеты', kind: 'programs', block: 'self', items: [LEGACY, { id: 'bukety-2', title: 'Без фото', price: '' }] }] };

async function editor(seed = SEED) {
  const errors = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM(html, { url: 'https://cabinet.test/price-editor-palitra.html', runScripts: 'outside-only', virtualConsole: vc });
  const w = dom.window; w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {}; w.CSS = { escape: (s) => s }; w.alert = () => {};
  w.URL.createObjectURL = () => 'blob:synthetic-qa'; w.URL.revokeObjectURL = () => {};
  w.Image = class { naturalWidth = 1; naturalHeight = 1; set src(v) { queueMicrotask(() => this.onload()); } };
  let saved = structuredClone(seed); let uploads = 0;
  w.fetch = async (url, opts = {}) => {
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url === '/content/whoami') return ok(profile);
    if (url.endsWith('/assets')) { uploads += 1; return ok({ url: `/api/assets/qa-${uploads}.jpg` }); }
    if (opts.method === 'PUT') { saved = { ...JSON.parse(opts.body), version: 2 }; return ok({ ok: true, version: 2 }); }
    return ok(structuredClone(saved));
  };
  w.eval(renderer); w.eval(code);
  for (let i = 0; i < 5; i++) await tick();
  const d = w.document;
  const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
  const open = (id) => { d.querySelector(`[data-edit="${id}"]`).click(); return d.querySelector(`form[data-form="${id}"]`); };
  const submit = (form) => form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  const save = async () => { d.querySelector('#ed-save').click(); await settle(); return saved; };
  const addFiles = async (id, names) => {
    const input = d.querySelector(`[data-gallery-upload="${id}"]`);
    Object.defineProperty(input, 'files', { configurable: true, value: names.map((n) => new w.File(['qa'], n, { type: 'image/jpeg' })) });
    input.dispatchEvent(new w.Event('change', { bubbles: true })); await settle();
  };
  const gallery = (form) => JSON.parse(form.querySelector('input[name="gallery"]').value);
  const act = (form, index, name) => form.querySelector(`[data-gallery-index="${index}"] [data-gallery-act="${name}"]`).click();
  return { w, d, errors, open, submit, save, addFiles, gallery, act, uploads: () => uploads, close: () => w.close() };
}

test('старый товар без дополнительных фото сохраняется без поля gallery и без изменений обложки', async () => {
  const e = await editor();
  try {
    const form = e.open('bukety-1');
    assert.deepEqual(e.gallery(form), []);
    assert.match(form.querySelector('[data-gallery-list]').textContent, /Пока только обложка/);
    e.submit(form);
    const saved = await e.save();
    const it = saved.categories[0].items[0];
    assert.equal(Object.hasOwn(it, 'gallery'), false, 'пустой список не пишется');
    assert.equal(it.photo, LEGACY.photo);
    assert.equal(it.oldPrice, LEGACY.oldPrice); assert.equal(it.quizEnabled, true);
    assert.deepEqual(saved.categories[0].items[1], { ...SEED.categories[0].items[1] }, 'другой товар не тронут');
    assert.deepEqual(e.errors, []);
  } finally { e.close(); }
});

test('владелец добавляет несколько фото, меняет порядок, делает обложкой и убирает; сохраняется ровно выбранное', async () => {
  const e = await editor();
  try {
    let form = e.open('bukety-1');
    await e.addFiles('bukety-1', ['a.jpg', 'b.jpg', 'c.jpg']);
    assert.equal(e.uploads(), 3);
    assert.deepEqual(e.gallery(form), ['/api/assets/qa-1.jpg', '/api/assets/qa-2.jpg', '/api/assets/qa-3.jpg']);
    assert.equal(form.querySelectorAll('.ed-gallery__item').length, 3);
    assert.equal(form.querySelector('[data-gallery-index="0"] [data-gallery-act="left"]').disabled, true);
    e.act(form, 0, 'right');
    assert.deepEqual(e.gallery(form), ['/api/assets/qa-2.jpg', '/api/assets/qa-1.jpg', '/api/assets/qa-3.jpg']);
    e.act(form, 2, 'cover');
    assert.equal(form.querySelector('input[name="photo"]').value, '/api/assets/qa-3.jpg', 'выбранное фото стало обложкой');
    assert.deepEqual(e.gallery(form), ['/api/assets/qa-2.jpg', '/api/assets/qa-1.jpg', LEGACY.photo], 'прежняя обложка встала на его место');
    e.act(form, 1, 'remove');
    assert.deepEqual(e.gallery(form), ['/api/assets/qa-2.jpg', LEGACY.photo]);
    e.submit(form);
    let saved = await e.save();
    let it = saved.categories[0].items[0];
    assert.equal(it.photo, '/api/assets/qa-3.jpg');
    assert.deepEqual(it.gallery, ['/api/assets/qa-2.jpg', LEGACY.photo]);

    form = e.open('bukety-1');
    assert.equal(form.querySelectorAll('.ed-gallery__item').length, 2, 'повторное открытие показывает сохранённое');
    e.act(form, 0, 'remove'); e.act(form, 0, 'remove');
    e.submit(form);
    saved = await e.save();
    it = saved.categories[0].items[0];
    assert.equal(Object.hasOwn(it, 'gallery'), false, 'все дополнительные убраны — поля нет');
    assert.equal(it.photo, '/api/assets/qa-3.jpg');
    assert.deepEqual(e.errors, []);
  } finally { e.close(); }
});

test('не больше 8 дополнительных фото; обложка не дублируется в списке', async () => {
  const e = await editor();
  try {
    const form = e.open('bukety-1');
    await e.addFiles('bukety-1', Array.from({ length: 10 }, (_, i) => `p${i}.jpg`));
    assert.equal(e.gallery(form).length, 8);
    assert.match(form.querySelector('[data-gallery-status="bukety-1"]').textContent, /Не больше 8/);
    form.querySelector('input[name="gallery"]').value = JSON.stringify([LEGACY.photo, '/api/assets/qa-1.jpg', '/api/assets/qa-1.jpg']);
    e.submit(form);
    const saved = await e.save();
    assert.deepEqual(saved.categories[0].items[0].gallery, ['/api/assets/qa-1.jpg']);
  } finally { e.close(); }
});

test('сервер content принимает gallery до 8 безопасных адресов и отклоняет остальное без новой версии', async () => {
  const { spawn } = require('node:child_process'); const { once } = require('node:events'); const crypto = require('node:crypto'); const net = require('node:net');
  const service = path.resolve(root, '../../ops/content'); const { hashPassword } = require(service + '/passwords');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palitra-gallery-')); const password = crypto.randomBytes(20).toString('hex');
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); const port = listener.address().port; await new Promise((r) => listener.close(r));
  const child = spawn(process.execPath, [service + '/server.js'], { env: { ...process.env, PORT: String(port), DATABASE_PATH: dir + '/db.sqlite', SEED_DIR: service + '/seed',
    ASSETS_DIR: dir + '/assets', API_KEY: '', AUTH_USERS: `owner:owner:${hashPassword(password)}`, SESSION_SECRET: crypto.randomBytes(32).toString('hex') }, stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + port;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 20)); }
    const login = await fetch(base + '/content/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'owner', password }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const who = await (await fetch(base + '/content/whoami', { headers: { cookie } })).json();
    const put = (doc) => fetch(base + '/content/palitra/price', { method: 'PUT', headers: { cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': who.csrfToken }, body: JSON.stringify(doc) });
    const initial = await (await fetch(base + '/public-content/palitra/price')).json();
    const withGallery = (gallery) => { const doc = structuredClone(initial); delete doc.version; delete doc.updatedAt; doc.categories.find((c) => c.items.length).items[0].gallery = gallery; return doc; };
    const good = await put(withGallery(['/api/assets/a.jpg', 'https://palitra-love.ru/assets/img/b.jpg']));
    assert.equal(good.status, 200);
    const stored = await (await fetch(base + '/public-content/palitra/price')).json();
    assert.deepEqual(stored.categories.find((c) => c.items.length).items[0].gallery, ['/api/assets/a.jpg', 'https://palitra-love.ru/assets/img/b.jpg']);
    for (const bad of ['/api/assets/a.jpg', ['http://evil.example/x.jpg'], ['//evil.example/x.jpg'], ['javascript:alert(1)'], [42], Array.from({ length: 9 }, (_, i) => `/api/assets/${i}.jpg`)]) {
      const response = await put(withGallery(bad));
      assert.equal(response.status, 422, JSON.stringify(bad));
    }
    const after = await (await fetch(base + '/public-content/palitra/price')).json();
    assert.equal(after.version, stored.version, 'отклонённые сохранения не создают версий');
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } fs.rmSync(dir, { recursive: true, force: true }); }
});

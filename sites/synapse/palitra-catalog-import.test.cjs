'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validatePacket, planImport, runImport } = require('./palitra-catalog-import');

const existing = {
  version: 2, updatedAt: '2026-09-17T00:00:00Z', custom: { keep: 'confirmed owner data' },
  showcase: { self: ['existing'], two: [] }, blocks: { self: { max: 8 } },
  categories: [
    { id: 'flowers', title: 'Букеты', kind: 'programs', block: 'self', extra: 'keep', items: [
      { id: 'existing', title: 'Заполненный букет', price: '4 500 ₽', desc: 'Не менять', photo: '/api/assets/original.jpg', extra: { keep: true } },
    ] },
    { id: 'balloons', title: 'Шары', kind: 'programs', block: 'two', items: [] },
  ],
};
const entry = (id, categoryId = 'flowers') => ({ categoryId,
  item: { id, title: `Товар ${id}`, price: '', desc: '', importSource: { kind: 'telegram', messageId: id } },
  asset: { filename: `${id}.jpg`, mimeType: 'image/jpeg', base64: Buffer.from(`photo ${id}`).toString('base64') },
});
const packet = (...items) => ({ format: 'palitra-catalog-import-v1', expectedVersion: 2, items });

function fixture(hooks = {}) {
  let document = structuredClone(existing);
  const calls = [];
  let reads = 0;
  const api = async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ url, options });
    if (method === 'GET') {
      reads += 1;
      if (hooks.read) document = await hooks.read(reads, document);
      return structuredClone(document);
    }
    if (url.endsWith('/assets')) {
      if (hooks.upload) await hooks.upload(options);
      assert.ok(options.body instanceof Blob);
      return { url: '/api/assets/' + decodeURIComponent(options.headers['X-Filename']) };
    }
    if (method === 'PUT') {
      const body = JSON.parse(options.body);
      document = { ...body, version: document.version + 1, updatedAt: '2026-09-17T01:00:00Z' };
      if (hooks.put) await hooks.put(document);
      return { ok: true, version: document.version, updatedAt: document.updatedAt };
    }
    throw new Error('Unexpected request');
  };
  return { api, calls, read: () => structuredClone(document) };
}

test('adds only missing stable IDs, preserving every current value, category order and showcase', async () => {
  const currentCopy = structuredClone(existing);
  const file = packet(entry('existing'), entry('new-flower'), entry('new-balloons', 'balloons'));
  const fileCopy = structuredClone(file);
  const f = fixture();
  const result = await runImport(file, f.api);
  assert.equal(result.added, 2);
  assert.equal(result.skipped, 1);
  const saved = f.read();
  assert.deepEqual(saved.custom, currentCopy.custom);
  assert.deepEqual(saved.showcase, currentCopy.showcase);
  assert.deepEqual(saved.blocks, currentCopy.blocks);
  assert.deepEqual(saved.categories.map((category) => category.id), ['flowers', 'balloons']);
  assert.equal(saved.categories[0].extra, 'keep');
  assert.deepEqual(saved.categories[0].items[0], currentCopy.categories[0].items[0]);
  assert.equal(saved.categories[0].items[1].photo, '/api/assets/new-flower.jpg');
  assert.equal(saved.categories[0].items[1].price, '');
  assert.deepEqual(existing, currentCopy);
  assert.deepEqual(file, fileCopy);
  assert.equal(JSON.stringify(saved).includes('base64'), false);
  assert.equal(f.calls.filter((call) => call.url.endsWith('/assets')).length, 2);
});

test('repeating an already saved packet is a no-op even though the version advanced', async () => {
  const f = fixture();
  const file = packet(entry('new'));
  await runImport(file, f.api);
  const result = await runImport(file, f.api);
  assert.equal(result.added, 0);
  assert.equal(result.skipped, 1);
  assert.equal(f.calls.filter((call) => call.options.method === 'PUT').length, 1);
  assert.equal(f.calls.filter((call) => call.url.endsWith('/assets')).length, 1);
});

test('version mismatch refuses before any photograph is uploaded or document is saved', async () => {
  const f = fixture({ read: async (_, document) => ({ ...document, version: 3 }) });
  await assert.rejects(runImport(packet(entry('new')), f.api), /Каталог изменился/);
  assert.equal(f.calls.filter((call) => call.options.method).length, 0);
});

test('concurrent changes during upload stop the write and remain untouched', async () => {
  const f = fixture({ read: async (read, document) => {
    if (read === 2) document.categories[0].items[0].title = 'Новое название от владельца';
    return document;
  } });
  await assert.rejects(runImport(packet(entry('new')), f.api), /Каталог изменился во время загрузки/);
  assert.equal(f.calls.some((call) => call.options.method === 'PUT'), false);
  assert.equal(f.read().categories[0].items[0].title, 'Новое название от владельца');
});

test('partial upload failure never saves cards and retry reuses successful uploads', async () => {
  let fail = true;
  const f = fixture({ upload: async (options) => {
    if (fail && options.headers['X-Filename'] === 'second.jpg') throw new Error('Temporary network failure');
  } });
  const file = packet(entry('first'), entry('second'), entry('third'));
  const uploaded = new Map();
  await assert.rejects(runImport(file, f.api, { uploaded }), /Temporary network failure/);
  assert.equal(f.calls.some((call) => call.options.method === 'PUT'), false);
  assert.equal(uploaded.size, 2);
  fail = false;
  const result = await runImport(file, f.api, { uploaded });
  assert.equal(result.added, 3);
  const filenames = f.calls.filter((call) => call.url.endsWith('/assets')).map((call) => call.options.headers['X-Filename']);
  assert.equal(filenames.filter((filename) => filename === 'first.jpg').length, 1);
  assert.equal(filenames.filter((filename) => filename === 'second.jpg').length, 2);
  assert.equal(filenames.filter((filename) => filename === 'third.jpg').length, 1);
});

test('a lost PUT response is safely retried by stable IDs without another version', async () => {
  const f = fixture({ put: async () => { throw new Error('Connection lost after server commit'); } });
  const file = packet(entry('new'));
  await assert.rejects(runImport(file, f.api), /Connection lost/);
  const result = await runImport(file, f.api);
  assert.equal(result.added, 0);
  assert.equal(result.skipped, 1);
  assert.equal(f.calls.filter((call) => call.options.method === 'PUT').length, 1);
});

test('invalid IDs, duplicate IDs, missing categories, blank titles and malformed photos refuse', () => {
  assert.throws(() => validatePacket(packet(entry('same'), entry('same'))), /повторяется id/);
  assert.throws(() => validatePacket(packet({ ...entry('blank'), item: { id: 'blank', title: ' ' } })), /пустое название/);
  assert.throws(() => validatePacket(packet({ ...entry('bad'), asset: { filename: 'bad.jpg', mimeType: 'image/jpeg', base64: '%%%=' } })), /повреждена/);
  assert.throws(() => planImport(existing, packet(entry('new', 'missing'))), /Не найден раздел/);
  assert.throws(() => planImport(existing, packet(entry('flowers'))), /совпадает с разделом/);
});

test('oversized metadata refuses before upload, and returned foreign asset addresses are refused', async () => {
  const f = fixture();
  const large = entry('large');
  large.item.desc = 'я'.repeat(600000);
  await assert.rejects(runImport(packet(large), f.api), /превышает 1 МБ/);
  assert.equal(f.calls.some((call) => call.options.method), false);
  await assert.rejects(runImport(packet(entry('new')), async (url) =>
    url.endsWith('/assets') ? { url: 'https://untrusted.test/image.jpg' } : structuredClone(existing)), /не подтвердил адрес/);
});

test('editor import UI previews without writes, then uses existing session/CSRF flow and verifies completion', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { JSDOM, VirtualConsole } = require('jsdom');
  const html = fs.readFileSync(path.join(__dirname, 'price-editor-palitra.html'), 'utf8');
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const errors = [];
  const console = new VirtualConsole();
  console.on('jsdomError', (error) => errors.push(error.message));
  const dom = new JSDOM(html, { url: 'https://cabinet.test/price-editor-palitra.html', runScripts: 'outside-only', virtualConsole: console });
  const w = dom.window;
  w.TextEncoder = TextEncoder;
  w.Blob = Blob;
  w.AbortController = AbortController;
  w.scrollTo = () => {};
  w.alert = () => { throw new Error('Unexpected alert'); };
  w.CSS = { escape: (value) => value };
  const f = fixture();
  const calls = [];
  w.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers?.['X-API-Key'], undefined);
    if (url === '/content/whoami') return { ok: true, status: 200, json: async () => ({ role: 'owner', csrfToken: 'synthetic-csrf-only' }) };
    if (options.method && options.method !== 'GET') assert.equal(options.headers['X-CSRF-Token'], 'synthetic-csrf-only');
    const body = await f.api(url, options);
    return { ok: true, status: 200, json: async () => body };
  };
  const wait = async (predicate) => {
    for (let count = 0; count < 80; count += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('DOM timeout: ' + w.document.querySelector('#ed-import-progress')?.textContent);
  };
  try {
    w.eval(fs.readFileSync(path.join(__dirname, 'price-render-palitra.js'), 'utf8'));
    w.eval(fs.readFileSync(path.join(__dirname, 'palitra-catalog-import.js'), 'utf8'));
    w.eval(code);
    await wait(() => !w.document.querySelector('#ed-save').disabled);
    const input = w.document.querySelector('#ed-import-file');
    const file = packet(entry('new-ui'));
    file.items[0].item.title = '<img src=x onerror="window.injected=true">';
    Object.defineProperty(input, 'files', { value: [{ name: 'catalog.json', size: 1000, text: async () => JSON.stringify(file) }] });
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
    const apply = w.document.querySelector('#ed-import-apply');
    await wait(() => !apply.disabled);
    assert.match(w.document.querySelector('#ed-import-summary').textContent, /Добавить: 1/);
    assert.equal(calls.some((call) => call.options.method), false, 'preview must be read-only');
    apply.click();
    await wait(() => /Готово\. Добавлено 1/.test(w.document.querySelector('#ed-import-progress').textContent));
    assert.equal(w.injected, undefined);
    assert.equal(w.document.querySelectorAll('[onerror]').length, 0);
    assert.deepEqual(f.read().categories[0].items[0], existing.categories[0].items[0]);
    assert.equal(w.document.querySelector('.price-layout').inert, false);
    assert.equal(w.document.querySelector('#ed-import-close').disabled, false);
    assert.equal(apply.disabled, true);
    assert.deepEqual(errors, []);
  } finally { w.close(); }
});

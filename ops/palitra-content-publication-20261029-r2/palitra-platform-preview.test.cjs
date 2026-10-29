'use strict';
// spec 049: предпросмотр публикации. jsdom + node:test, без сети.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, 'payload/sites/synapse/cabinet/palitra-orders/palitra-platform-preview.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, 'payload/sites/synapse/cabinet/palitra-orders/palitra-platform-preview.css'), 'utf8');
const ORIGIN = 'https://palitra.synapsebusiness.ru';
const IMG = (n = 1, w = 1080, h = 1350) => ({url: `blob:${ORIGIN}/img-${n}`, type: 'image/jpeg', name: `photo-${n}.jpg`, width: w, height: h});
const VID = (n = 1, w = 1080, h = 1920) => ({url: `blob:${ORIGIN}/vid-${n}`, type: 'video/mp4', name: `clip-${n}.mp4`, width: w, height: h});

function env() {
  const dom = new JSDOM('<!doctype html><body><form><input id="caption"></form><div id="host"></div></body>', {url: ORIGIN + '/cabinet.html', runScripts: 'outside-only'});
  const w = dom.window;
  const net = [];
  w.fetch = (...a) => { net.push(['fetch', a[0]]); return Promise.reject(new Error('network')); };
  w.XMLHttpRequest = function () { net.push(['xhr']); throw new Error('network'); };
  w.navigator.sendBeacon = (...a) => { net.push(['beacon', a[0]]); return false; };
  const revoked = [];
  w.URL.revokeObjectURL = u => revoked.push(u);
  const before = new Set(Object.keys(w));
  w.eval(SRC);
  const added = Object.keys(w).filter(k => !before.has(k));
  const api = w.PalitraPlatformPreview;
  const host = w.document.getElementById('host');
  const make = (opts) => {
    const p = api.create({document: w.document, window: w, ...opts});
    host.appendChild(p.element);
    return p;
  };
  const q = (p, sel) => p.element.querySelector(sel);
  const qa = (p, sel) => [...p.element.querySelectorAll(sel)];
  return {dom, w, api, host, net, revoked, added, make, q, qa, close: () => w.close()};
}

test('UMD: CommonJS отдаёт create, в браузере появляется ровно один глобальный объект', () => {
  const cjs = require('./payload/sites/synapse/cabinet/palitra-orders/palitra-platform-preview.js');
  assert.equal(typeof cjs.create, 'function');
  const e = env();
  try {
    assert.deepEqual(e.added, ['PalitraPlatformPreview']);
    assert.deepEqual(Object.keys(e.api), ['create']);
  } finally { e.close(); }
});

test('карточка Telegram / ВКонтакте / MAX: площадка, автор, файл, подпись; без зон 9:16', () => {
  const e = env();
  try {
    for (const [platform, name] of [['telegram', 'Telegram'], ['vk', 'ВКонтакте'], ['max', 'MAX']]) {
      const p = e.make({platform, format: 'post', text: 'Набор красок', publisherLabel: 'Палитра', media: [IMG(1, 1600, 900)]});
      assert.ok(p.element.classList.contains('palitra-preview--card'));
      assert.equal(e.q(p, '.palitra-preview__platform').textContent, name);
      assert.equal(e.q(p, '.palitra-preview__publisher').textContent, 'Палитра');
      assert.equal(e.q(p, '.palitra-preview__caption').textContent, 'Набор красок');
      assert.equal(e.q(p, 'img').getAttribute('src'), `blob:${ORIGIN}/img-1`);
      assert.equal(e.q(p, '.palitra-preview__meta').textContent, `${name} · Пост · пропорции файла 16:9`);
      assert.equal(e.q(p, '.palitra-preview__zone'), null);
      assert.equal(e.q(p, '.palitra-preview__controls'), null, 'в карточке нет переключателя обрезки: файл всегда целиком');
      assert.equal(e.q(p, '.palitra-preview__avatar').getAttribute('aria-hidden'), 'true');
      assert.equal(p.element.getAttribute('aria-label'), `Предпросмотр: ${name}, Пост`);
      p.dispose();
    }
  } finally { e.close(); }
});

test('вертикальные форматы: кадр 9:16, зоны сверху / справа / снизу; у историй нет правой колонки', () => {
  const e = env();
  try {
    const cases = [['tiktok', 'reel', true], ['youtube_shorts', 'reel', true], ['instagram', 'reel', true], ['vk', 'reel', true],
      ['instagram', 'story', false], ['vk', 'story', false], ['telegram', 'story', false], ['max', 'story', false], ['tiktok', 'carousel', true]];
    for (const [platform, format, right] of cases) {
      const p = e.make({platform, format, text: 'Подпись', media: [VID()]});
      assert.ok(p.element.classList.contains('palitra-preview--vertical'), platform + '/' + format);
      assert.match(e.q(p, '.palitra-preview__meta-ratio').textContent, /кадр 9:16/);
      assert.ok(e.q(p, '.palitra-preview__zone--top'));
      assert.ok(e.q(p, '.palitra-preview__zone--bottom'));
      assert.equal(!!e.q(p, '.palitra-preview__zone--right'), right, platform + '/' + format);
      for (const z of e.qa(p, '.palitra-preview__zone')) assert.equal(z.getAttribute('aria-hidden'), 'true');
      assert.equal(e.q(p, '.palitra-preview__overlay--bottom .palitra-preview__caption').textContent, 'Подпись');
      if (right) assert.notEqual(e.q(p, '.palitra-preview__overlay--bottom').style.right, '', 'подпись не заезжает под правую колонку');
      p.dispose();
    }
    const ig = e.make({platform: 'instagram', format: 'post', media: [IMG()]});
    assert.ok(ig.element.classList.contains('palitra-preview--card'), 'лента Instagram — карточка');
  } finally { e.close(); }
});

test('YouTube Shorts показывает название; остальные — только в aria-label', () => {
  const e = env();
  try {
    const s = e.make({platform: 'youtube_shorts', format: 'reel', title: 'Как смешать охру', media: [VID()]});
    assert.equal(e.q(s, '.palitra-preview__title').textContent, 'Как смешать охру');
    assert.equal(s.element.getAttribute('aria-label'), 'Предпросмотр: YouTube Shorts, Ролик, «Как смешать охру»');
    const t = e.make({platform: 'tiktok', format: 'reel', title: 'Как смешать охру', media: [VID()]});
    assert.equal(e.q(t, '.palitra-preview__title'), null);
  } finally { e.close(); }
});

test('пометка «Зоны интерфейса — ориентир» ровно одна и не дублируется при обновлениях', () => {
  const e = env();
  try {
    const p = e.make({platform: 'tiktok', format: 'reel', media: []});
    const count = () => (p.element.textContent.match(/Зоны интерфейса — ориентир/g) || []).length;
    assert.equal(count(), 1);
    p.update({text: 'a'}); p.update({media: [VID()]}); p.update({platform: 'telegram', format: 'post'}); p.update({platform: 'instagram', format: 'story'});
    assert.equal(count(), 1);
  } finally { e.close(); }
});

test('без файлов — честная заглушка; без автора — «Ваш аккаунт»; пустой текст в карточке помечен', () => {
  const e = env();
  try {
    const p = e.make({platform: 'vk', format: 'post'});
    assert.equal(e.q(p, '.palitra-preview__placeholder').textContent, 'Добавьте фото или видео');
    assert.equal(e.q(p, '.palitra-preview__publisher').textContent, 'Ваш аккаунт');
    assert.equal(e.q(p, '.palitra-preview__caption').textContent, 'Без текста');
    assert.equal(e.q(p, 'img, video'), null);
    assert.match(e.q(p, '.palitra-preview__meta-ratio').textContent, /появятся с файлом/);
    const v = e.make({platform: 'tiktok', format: 'reel', media: []});
    assert.equal(e.q(v, '.palitra-preview__placeholder').textContent, 'Добавьте фото или видео');
    assert.equal(e.q(v, '.palitra-preview__fit-note').hidden, true);
  } finally { e.close(); }
});

test('видео: штатные controls, без автозапуска, preload=metadata, playsinline', () => {
  const e = env();
  try {
    const p = e.make({platform: 'telegram', format: 'post', media: [VID(1, 1920, 1080)]});
    const v = e.q(p, 'video');
    assert.equal(v.controls, true);
    assert.equal(v.autoplay, false);
    assert.equal(v.hasAttribute('autoplay'), false);
    assert.equal(v.getAttribute('preload'), 'metadata');
    assert.equal(v.hasAttribute('playsinline'), true);
    assert.equal(v.getAttribute('src'), `blob:${ORIGIN}/vid-1`);
    assert.equal(v.getAttribute('aria-label'), 'Видео: clip-1.mp4');
  } finally { e.close(); }
});

test('карусель: счётчик, кнопки на краях отключены, стрелки клавиатуры, скрытые кадры', () => {
  const e = env();
  try {
    const p = e.make({platform: 'instagram', format: 'carousel', media: [IMG(1), IMG(2), VID(3)]});
    const prev = e.q(p, 'button[aria-label="Предыдущий кадр"]'), next = e.q(p, 'button[aria-label="Следующий кадр"]');
    const counter = e.q(p, '.palitra-preview__counter'), stage = e.q(p, '.palitra-preview__stage');
    const visible = () => e.qa(p, '.palitra-preview__slide').map(s => !s.hidden);
    assert.equal(counter.textContent, '1 / 3');
    assert.equal(counter.getAttribute('aria-live'), 'polite');
    assert.equal(prev.disabled, true); assert.equal(next.disabled, false);
    assert.deepEqual(visible(), [true, false, false]);
    next.click();
    assert.equal(counter.textContent, '2 / 3');
    assert.equal(prev.disabled, false);
    assert.equal(stage.getAttribute('tabindex'), '0');
    assert.equal(stage.getAttribute('aria-roledescription'), 'карусель');
    const key = k => { const ev = new e.w.KeyboardEvent('keydown', {key: k, bubbles: true, cancelable: true}); stage.dispatchEvent(ev); return ev.defaultPrevented; };
    assert.equal(key('ArrowRight'), true);
    assert.equal(counter.textContent, '3 / 3');
    assert.equal(next.disabled, true);
    assert.deepEqual(visible(), [false, false, true]);
    key('ArrowRight');
    assert.equal(counter.textContent, '3 / 3', 'за последний кадр не уходим');
    key('ArrowLeft');
    assert.equal(counter.textContent, '2 / 3');
    assert.equal(key('Tab'), false, 'прочие клавиши не перехватываются');
    // удаление файлов зажимает номер кадра
    next.click();
    p.update({media: [IMG(1)]});
    assert.equal(counter.textContent, '1 / 1');
    assert.equal(e.q(p, '.palitra-preview__pager').hidden, true, 'одному файлу листание не нужно');
  } finally { e.close(); }
});

test('не карусель с несколькими файлами: показан первый и это сказано', () => {
  const e = env();
  try {
    const p = e.make({platform: 'telegram', format: 'post', media: [IMG(1), IMG(2), IMG(3)]});
    assert.equal(e.qa(p, 'img').length, 1);
    assert.equal(e.q(p, '.palitra-preview__extra').textContent, 'Показан первый файл из 3.');
    assert.equal(e.q(p, '.palitra-preview__pager'), null);
  } finally { e.close(); }
});

test('update: подпись меняется в том же узле, медиа не пересоздаются, фокус формы не теряется', () => {
  const e = env();
  try {
    const p = e.make({platform: 'tiktok', format: 'reel', text: 'А', media: [VID()]});
    const input = e.w.document.getElementById('caption');
    input.focus(); input.value = 'АБ';
    const rootNode = p.element, video = e.q(p, 'video'), caption = e.q(p, '.palitra-preview__caption');
    p.update({text: 'АБ'});
    p.update({text: 'АБВ', publisherLabel: 'Палитра', title: 'x'});
    assert.equal(e.w.document.activeElement, input);
    assert.equal(input.value, 'АБ');
    assert.equal(p.element, rootNode);
    assert.equal(e.q(p, 'video'), video, 'набор текста не перезапускает видео');
    assert.equal(e.q(p, '.palitra-preview__caption'), caption);
    assert.equal(caption.textContent, 'АБВ');
    // те же файлы новым массивом — те же узлы
    p.update({media: [VID()]});
    assert.equal(e.q(p, 'video'), video);
    // выбор другого файла меняет медиа в том же предпросмотре
    p.update({media: [IMG(7, 1080, 1920)]});
    assert.equal(e.q(p, 'video'), null);
    assert.equal(e.q(p, 'img').getAttribute('src'), `blob:${ORIGIN}/img-7`);
    assert.equal(e.q(p, '.palitra-preview__fit-note').textContent, 'Файл 9:16 совпадает с кадром.');
    // смена площадки — тот же корневой элемент, фокус формы на месте
    p.update({platform: 'vk', format: 'post'});
    assert.equal(p.element, rootNode);
    assert.ok(rootNode.classList.contains('palitra-preview--card'));
    assert.equal(e.w.document.activeElement, input);
    assert.equal(e.q(p, '.palitra-preview__caption').textContent, 'АБВ', 'частичный update сохраняет прежние поля');
  } finally { e.close(); }
});

test('адреса: запрещённые никогда не попадают в src и показывают понятный текст', () => {
  const e = env();
  try {
    const bad = [
      {url: 'javascript:alert(1)', type: 'image/png'},
      {url: 'JaVaScRiPt:alert(1)', type: 'image/png'},
      {url: 'data:text/html,<script>alert(1)</script>', type: 'image/png'},
      {url: 'data:image/png;base64,iVBORw0KGgo=', type: 'image/png'},
      {url: 'http://palitra.synapsebusiness.ru/a.jpg', type: 'image/jpeg'},
      {url: 'https://evil.example/a.jpg', type: 'image/jpeg'},
      {url: '//evil.example/a.jpg', type: 'image/jpeg'},
      {url: 'https://user:pw@palitra.synapsebusiness.ru/a.jpg', type: 'image/jpeg'},
      {url: 'blob:https://evil.example/uuid', type: 'image/jpeg'},
      {url: ' javascript:alert(1)', type: 'image/png'},
      {url: 'vbscript:x', type: 'image/png'},
      {url: `blob:${ORIGIN}/svg`, type: 'image/svg+xml'},
      {url: `blob:${ORIGIN}/gif`, type: 'image/gif'},
      {url: `blob:${ORIGIN}/noext`, name: 'file.svg'},
      {url: 'https://palitra.synapsebusiness.ru/a.mov'}
    ];
    const p = e.make({platform: 'vk', format: 'carousel', media: bad});
    assert.equal(e.qa(p, 'img, video, iframe, object, embed, script').length, 0);
    assert.equal(e.qa(p, '.palitra-preview__fallback').length, bad.length);
    assert.match(e.q(p, '.palitra-preview__fallback').textContent, /^Файл не может быть показан: /);
    assert.ok(!p.element.outerHTML.includes('javascript:') && !p.element.outerHTML.includes('data:'));
    const ok = [
      {url: `blob:${ORIGIN}/a`, type: 'image'},
      {url: '/media/b.webp'},
      {url: 'https://palitra.synapsebusiness.ru/c.png'},
      {url: 'https://cdn.synapsebusiness.ru/d.webm'}
    ];
    const g = e.make({platform: 'vk', format: 'carousel', media: ok, allowedHosts: ['cdn.synapsebusiness.ru']});
    assert.deepEqual(e.qa(g, 'img, video').map(n => [n.tagName, n.getAttribute('src')]), [
      ['IMG', `blob:${ORIGIN}/a`], ['IMG', ORIGIN + '/media/b.webp'], ['IMG', ORIGIN + '/c.png'], ['VIDEO', 'https://cdn.synapsebusiness.ru/d.webm']]);
    const n = e.make({platform: 'vk', format: 'post', media: [{url: 'https://cdn.synapsebusiness.ru/d.webm'}]});
    assert.equal(e.q(n, 'video'), null, 'без allowedHosts чужой поддомен запрещён');
  } finally { e.close(); }
});

test('текст только через textContent: HTML в подписи, авторе, названии и имени файла не исполняется', () => {
  const e = env();
  try {
    const evil = '<img src=x onerror=alert(1)><b>жирный</b>';
    const p = e.make({platform: 'youtube_shorts', format: 'reel', text: evil, publisherLabel: evil, title: evil,
      media: [{url: 'javascript:1', type: 'image/png', name: evil}]});
    assert.equal(e.qa(p, 'b, img').length, 0);
    assert.equal(e.q(p, '.palitra-preview__caption').textContent, evil);
    assert.equal(e.q(p, '.palitra-preview__publisher').textContent, evil);
    assert.equal(e.q(p, '.palitra-preview__title').textContent, evil);
    assert.ok(e.q(p, '.palitra-preview__fallback').textContent.includes(evil));
    for (const bad of [/innerHTML/, /outerHTML\s*=/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function/]) assert.doesNotMatch(SRC, bad);
  } finally { e.close(); }
});

test('«Вписать / Заполнить»: по умолчанию вписать; заполнение явно подписано как обрезка', () => {
  const e = env();
  try {
    const p = e.make({platform: 'tiktok', format: 'reel', media: [IMG(1, 1600, 900)]});
    const [contain, cover] = [...e.q(p, '.palitra-preview__fit').querySelectorAll('button')];
    assert.equal(contain.textContent, 'Вписать'); assert.equal(cover.textContent, 'Заполнить');
    assert.equal(contain.getAttribute('aria-pressed'), 'true');
    assert.equal(p.element.classList.contains('palitra-preview--fit-cover'), false);
    assert.equal(e.q(p, '.palitra-preview__fit-note').textContent, 'Файл 16:9 вписан в кадр 9:16 целиком: по краям будут поля.');
    cover.click();
    assert.equal(cover.getAttribute('aria-pressed'), 'true');
    assert.equal(contain.getAttribute('aria-pressed'), 'false');
    assert.ok(p.element.classList.contains('palitra-preview--fit-cover'));
    assert.equal(e.q(p, '.palitra-preview__fit-note').textContent, 'Файл 16:9 заполняет кадр 9:16: края файла обрезаны.');
    p.update({text: 'x'});
    assert.ok(p.element.classList.contains('palitra-preview--fit-cover'), 'выбор не сбрасывается при наборе');
    contain.click();
    assert.equal(p.element.classList.contains('palitra-preview--fit-cover'), false);
  } finally { e.close(); }
});

test('«Подсветить зоны»: aria-pressed и класс кадра', () => {
  const e = env();
  try {
    const p = e.make({platform: 'instagram', format: 'reel', media: [VID()]});
    const btn = e.q(p, '.palitra-preview__controls > button');
    assert.equal(btn.textContent, 'Подсветить зоны');
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
    assert.ok(e.q(p, '.palitra-preview__frame').classList.contains('palitra-preview__frame--zones'));
    btn.click();
    assert.equal(btn.getAttribute('aria-pressed'), 'false');
    assert.equal(e.q(p, '.palitra-preview__frame').classList.contains('palitra-preview__frame--zones'), false);
    const off = e.make({platform: 'instagram', format: 'reel', showZones: false});
    assert.equal(e.q(off, '.palitra-preview__controls > button').getAttribute('aria-pressed'), 'false');
  } finally { e.close(); }
});

test('доступность: только настоящие кнопки с подписью, никаких поддельных «лайк/отправить»', () => {
  const e = env();
  try {
    for (const [platform, format] of [['tiktok', 'carousel'], ['vk', 'carousel'], ['instagram', 'story'], ['telegram', 'post']]) {
      const p = e.make({platform, format, media: [IMG(1), IMG(2)]});
      for (const b of e.qa(p, 'button')) {
        assert.equal(b.getAttribute('type'), 'button');
        assert.ok((b.getAttribute('aria-label') || b.textContent).trim().length > 2);
        assert.doesNotMatch(b.textContent + (b.getAttribute('aria-label') || ''), /нрав|лайк|отправ|подпис|коммент|репост|поделит/i);
      }
      assert.equal(e.qa(p, 'a, [onclick], [role="button"]').length, 0);
      assert.doesNotMatch(p.element.textContent, /подключ|не подключ|токен|ошибка подключения/i);
    }
  } finally { e.close(); }
});

test('ошибка загрузки картинки — понятный текст вместо пустого места', () => {
  const e = env();
  try {
    const p = e.make({platform: 'telegram', format: 'post', media: [IMG(1)]});
    e.q(p, 'img').dispatchEvent(new e.w.Event('error'));
    assert.equal(e.q(p, 'img'), null);
    assert.equal(e.q(p, '.palitra-preview__fallback').textContent, 'Файл не удалось открыть (photo-1.jpg)');
  } finally { e.close(); }
});

test('нет сети: ни fetch, ни XHR, ни sendBeacon; в коде нет сетевых API', () => {
  const e = env();
  try {
    const p = e.make({platform: 'instagram', format: 'carousel', media: [IMG(1), VID(2)], text: 'x'});
    p.update({text: 'y', media: [IMG(3)]}); p.update({platform: 'tiktok', format: 'reel'}); p.dispose();
    assert.deepEqual(e.net, []);
    for (const bad of [/fetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/, /import\s*\(/, /createObjectURL/]) assert.doesNotMatch(SRC, bad);
  } finally { e.close(); }
});

test('dispose: DOM и обработчики убраны, revokeObjectURL не вызывается, update после — без эффекта', () => {
  const e = env();
  try {
    const proto = e.w.EventTarget.prototype, addOrig = proto.addEventListener, remOrig = proto.removeEventListener;
    let live = 0;
    const ours = node => typeof node.className === 'string' && node.className.includes('palitra-preview');
    proto.addEventListener = function (...a) { if (ours(this)) live++; return addOrig.apply(this, a); };
    proto.removeEventListener = function (...a) { if (ours(this)) live--; return remOrig.apply(this, a); };
    const p = e.make({platform: 'tiktok', format: 'carousel', media: [IMG(1), VID(2)]});
    p.update({platform: 'vk', format: 'carousel'});
    p.update({platform: 'instagram', format: 'reel', media: [VID(3)]});
    const video = e.q(p, 'video');
    assert.ok(live > 0);
    p.dispose();
    proto.addEventListener = addOrig; proto.removeEventListener = remOrig;
    assert.equal(live, 0, 'каждый добавленный обработчик снят');
    assert.equal(p.element.parentNode, null);
    assert.equal(p.element.childNodes.length, 0);
    assert.equal(e.host.childNodes.length, 0);
    assert.equal(video.hasAttribute('src'), false, 'видео отпущено');
    assert.deepEqual(e.revoked, [], 'URL.revokeObjectURL — забота владельца формы');
    p.update({text: 'после'}); p.dispose();
    assert.equal(p.element.childNodes.length, 0);
  } finally { e.close(); }
});

test('неизвестная площадка или формат — TypeError, состояние не меняется', () => {
  const e = env();
  try {
    assert.throws(() => e.api.create({document: e.w.document, window: e.w, platform: 'facebook', format: 'post'}), {name: 'TypeError'});
    assert.throws(() => e.api.create({document: e.w.document, window: e.w, platform: 'vk', format: 'video'}), {name: 'TypeError'});
    assert.throws(() => e.api.create({document: e.w.document, window: e.w, platform: 'vk', format: 'POST'}), {name: 'TypeError'});
    assert.throws(() => e.api.create({platform: 'vk', format: 'post'}), {name: 'TypeError'});
    const p = e.make({platform: 'vk', format: 'post', text: 'до'});
    assert.throws(() => p.update({platform: 'toString', text: 'после'}), {name: 'TypeError'});
    assert.equal(e.q(p, '.palitra-preview__caption').textContent, 'до');
    assert.equal(e.q(p, '.palitra-preview__platform').textContent, 'ВКонтакте');
  } finally { e.close(); }
});

test('CSS: всё внутри .palitra-preview, есть reduced-motion и focus-visible, без внешних ресурсов', () => {
  const body = CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '');
  const selectors = [];
  const re = /([^{}@]+)\{/g;
  let m;
  while ((m = re.exec(body))) {
    const sel = m[1].trim();
    if (!sel || /^(from|to|\d+%)$/.test(sel)) continue;
    selectors.push(...sel.split(',').map(s => s.trim()).filter(Boolean));
  }
  assert.ok(selectors.length > 30);
  for (const s of selectors) assert.match(s, /^\.palitra-preview(?![\w-]*-x)/, 'вне области: ' + s);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(body, /:focus-visible/);
  assert.doesNotMatch(body, /url\(|@import|@font-face/);
});

test('HTTPS другого порта собственного хоста не считается тем же origin',()=>{const dom=new JSDOM('<!doctype html><body></body>',{url:ORIGIN+'/cabinet.html'});try{const api=require('./payload/sites/synapse/cabinet/palitra-orders/palitra-platform-preview.js');const p=api.create({document:dom.window.document,window:dom.window,platform:'tiktok',format:'post',media:[{url:ORIGIN+':444/photo.jpg',type:'image/jpeg'}]});dom.window.document.body.append(p.element);assert.equal(p.element.querySelector('img'),null);p.dispose();}finally{dom.window.close();}});

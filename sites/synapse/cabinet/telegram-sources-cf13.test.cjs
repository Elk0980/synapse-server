'use strict';
// CF13: «Исходники» — загрузка без Telegram, очередь, сведения, прикрепление, «Где использован».
// Синтетический сервер в памяти по контракту CONTENT_FACTORY_CF13_SOURCES_UI_HANDOFF_20261001 (specs 059–061). Реальных API нет.
const test = require('node:test'), assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {mount} = require('./telegram-sources');
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
const CODE = 'palitra-love';
const VOCAB = {platforms: [{id: 'instagram', label: 'Instagram / Reels'}, {id: 'telegram', label: 'Telegram'}, {id: 'vk', label: 'ВКонтакте'}],
  formats: [{id: 'post', label: 'Пост'}, {id: 'story', label: 'Сторис'}, {id: 'reel', label: 'Reels / Shorts / клип'}, {id: 'carousel', label: 'Карусель'}]};
const LIMITS = {maxFileBytes: 1000, storageLimitBytes: 100000, mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm', 'application/pdf'],
  extensions: ['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov', '.webm', '.pdf'], maxFiles: 1};
const META = {platforms: [], formats: [], occasion: '', eventDate: '', usageRestrictions: '', materialState: 'source'};
const item = (id, extra = {}) => ({id, companyCode: CODE, name: `file-${id}.jpg`, mime: 'image/jpeg', caption: '', status: 'stored', size: 500, importMethod: 'upload',
  revision: 1, metadata: {...META}, sha256: 'a'.repeat(64), fileUrl: `/content/telegram-sources/${CODE}/${id}/file`, telegramUrl: null, ...extra});

function page({items = [], uploadAllowed = true, send, uploadFile, request, openPost} = {}) {
  const dom = new JSDOM('<div id="root"></div>', {url: 'https://cabinet.test/'}), w = dom.window, d = w.document, element = d.querySelector('#root');
  const calls = [], opened = [];
  const list = () => ({enabled: false, items: items.map((x) => ({...x})), nextBefore: null, uploadAllowed, limits: LIMITS, metadataVocabulary: VOCAB});
  const api = mount({element, companyCode: CODE,
    request: request ? (url) => { calls.push(['GET', url]); return request(url, list); } : async (url) => { calls.push(['GET', url]); return list(); },
    send: send === null ? undefined : async (url, method, body) => { calls.push([method, url, JSON.parse(JSON.stringify(body))]); return send(url, method, body); },
    uploadFile: uploadFile === null ? undefined : (url, body, opts) => { calls.push(['UPLOAD', url, body]); return uploadFile(url, body, opts); },
    openPost: openPost ?? ((id) => opened.push(id))});
  const q = (s, root = element) => root.querySelector(s), qa = (s, root = element) => [...root.querySelectorAll(s)];
  const btn = (text, root = element) => qa('button', root).find((b) => b.textContent === text);
  const files = (list) => { const input = q('input[type=file][multiple]'); Object.defineProperty(input, 'files', {configurable: true, value: list}); input.dispatchEvent(new w.Event('change')); };
  const file = (name, size = 10, type = '') => new w.File(['x'.repeat(size)], name, {type});
  const row = (id) => q(`[data-source-id="${id}"]`);
  return {w, d, element, api, calls, opened, q, qa, btn, files, file, row, close: () => { api.destroy(); w.close(); },
    writes: () => calls.filter((c) => c[0] !== 'GET'), queue: () => qa('.src-q').map((n) => [n.querySelector('strong').textContent, n.dataset.queueState])};
}

test('рабочий экран: ограничения из DTO, минимум — файл и подпись, сведения раскрываются, «Пока не выбрано», подсказки с примером; Telegram — в раскрываемом блоке', async () => {
  const f = page({items: [item(5, {importMethod: undefined, name: 'tg.png'})]}); try {
    await settle();
    assert.equal(f.q('.src-work').hidden, false);
    assert.match(f.q('.src-limits').textContent, /Форматы: JPG, PNG, WEBP, MP4, MOV, WEBM, PDF\. Один файл — до 1 КиБ\./);
    assert.equal(f.q('input[type=file][multiple]').accept, LIMITS.extensions.join(','));
    assert.ok(f.btn('Загрузить материалы'));
    assert.equal(f.q('.src-extra').open, false, 'дополнительные сведения свёрнуты');
    assert.equal(f.q('[name="src-up-materialState"]:checked').value, 'source', 'по умолчанию — исходник');
    assert.deepEqual(f.qa('[name="src-up-platforms"]').map((n) => n.parentElement.textContent), ['Instagram / Reels', 'Telegram', 'ВКонтакте']);
    assert.match(f.q('.src-extra').textContent, /Ничего не отмечено — «Пока не выбрано»/);
    assert.doesNotMatch(f.q('.src-extra').textContent, /Все подходящие/);
    const labels = f.qa('.src-work .cf-hint').map((b) => b.getAttribute('aria-label'));
    for (const name of ['Файлы', 'Подпись', 'Что это за файл', 'Площадки', 'Форматы', 'Повод или товар', 'Дата события', 'Ограничения использования']) assert.ok(labels.includes(`Подсказка: ${name}`), name);
    const hint = f.qa('.src-work .cf-hint').find((b) => b.getAttribute('aria-label') === 'Подсказка: Площадки'), note = f.d.getElementById(hint.getAttribute('aria-controls'));
    assert.equal(note.hidden, true); hint.click(); assert.equal(note.hidden, false); assert.equal(hint.getAttribute('aria-expanded'), 'true');
    assert.match(note.textContent, /Например: Telegram и ВКонтакте\./);
    assert.match(f.q('.src-telegram > summary').textContent, /Telegram и ручной импорт/);
    assert.match(f.row(5).textContent, /Telegram/); assert.match(f.row(5).textContent, /Площадки: пока не выбрано · Форматы: пока не выбрано/);
    assert.deepEqual(f.writes(), [], 'вход ничего не пишет');
  } finally { f.close(); }
});

test('очередь: по одному файлу, прогресс только при известном объёме, локальная проверка, временная и постоянная ошибки; «Повторить неудавшиеся» — только неудавшиеся; сведения не теряются', async () => {
  let active = 0, peak = 0, attempt = 0;
  const responses = {'a.jpg': [{status: 201, body: {item: item(11, {name: 'a.jpg'}), duplicate: false}}],
    'b.mp4': [{status: 0}, {status: 200, body: {item: item(12, {name: 'b.mp4', mime: 'video/mp4'}), duplicate: true}}],
    'c.pdf': [{status: 415, body: {error: 'Формат или содержимое файла не поддерживается'}}],
    'e.webm': [{status: 429, body: {error: 'Другая загрузка ещё выполняется. Повторите позже'}}, {status: 201, body: {item: item(13, {name: 'e.webm', mime: 'video/webm'}), duplicate: false}}]};
  const seen = [];
  const f = page({uploadFile: async (url, body, {onProgress}) => {
    active++; peak = Math.max(peak, active); attempt++;
    const name = body.get('file').name; seen.push(name);
    onProgress(5, name === 'a.jpg' ? 10 : 0);
    await new Promise((r) => setImmediate(r));
    active--;
    const next = responses[name].shift();
    if (!next.status) throw Object.assign(new Error('Нет связи с сервером'), {status: 0});
    return next;
  }}); try {
    await settle();
    f.q('#src-caption-palitra-love').value = 'Фотозона к выпускному (SAMPLE)';
    f.q('[name="src-up-materialState"][value="ready"]').checked = true;
    f.q('[name="src-up-platforms"][value="telegram"]').checked = true;
    f.q('.src-extra [name="occasion"]').value = 'Выпускной';
    f.files([f.file('a.jpg'), f.file('b.mp4'), f.file('c.pdf'), f.file('d.exe'), f.file('big.png', 2000), f.file('e.webm')]);
    assert.deepEqual(f.queue().map((x) => x[1]), ['waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting']);
    f.btn('Начать загрузку').click();
    await settle(); await settle();
    assert.equal(peak, 1, 'строго по одному запросу');
    assert.deepEqual(seen, ['a.jpg', 'b.mp4', 'c.pdf', 'e.webm'], 'неподходящие по DTO файлы не отправлены');
    const states = Object.fromEntries(f.queue());
    assert.deepEqual(states, {'a.jpg': 'done', 'b.mp4': 'error', 'c.pdf': 'error', 'd.exe': 'error', 'big.png': 'error', 'e.webm': 'error'});
    const text = f.q('.src-queue').textContent;
    assert.match(text, /Ответ не получен \(Нет связи с сервером\)\. Файл мог сохраниться — повтор не создаст дубль\./);
    assert.match(text, /Формат или содержимое файла не поддерживается Файл не сохранён\./);
    assert.match(text, /Формат не поддерживается библиотекой\. Файл не отправлен\./);
    assert.match(text, /Файл больше 1 КиБ\. Файл не отправлен\./);
    assert.match(text, /Сервер занят другой загрузкой/);
    // Отправленные сведения: подпись и metadata JSON, файл последним.
    const first = f.calls.find((c) => c[0] === 'UPLOAD');
    assert.equal(first[1], `/content/telegram-sources/${CODE}/upload`);
    assert.equal(first[2].get('caption'), 'Фотозона к выпускному (SAMPLE)');
    assert.deepEqual(JSON.parse(first[2].get('metadata')), {platforms: ['telegram'], formats: [], occasion: 'Выпускной', eventDate: '', usageRestrictions: '', materialState: 'ready'});
    assert.deepEqual([...first[2].keys()], ['caption', 'metadata', 'file']);
    assert.ok(f.row(11), 'сохранённый файл сразу в библиотеке');
    // Повтор: только временные ошибки (b, e); a не грузится заново, c/d/big — постоянные.
    assert.equal(f.q('#src-caption-palitra-love').value, 'Фотозона к выпускному (SAMPLE)', 'ввод не потерян');
    f.btn('Повторить неудавшиеся').click(); await settle(); await settle();
    assert.deepEqual(seen.slice(4), ['b.mp4', 'e.webm']);
    // CF17: после неизвестного исхода «уже есть» не доказывает, что сохранились сведения этой попытки.
    assert.equal(Object.fromEntries(f.queue())['b.mp4'], 'duplicate');
    assert.match(f.q('.src-queue').textContent, /Файл есть в библиотеке \(№12\)\. Сервер не подтверждает, какая попытка его сохранила — сохранённые подпись и сведения отличаются от отправленных, сверьте их в «Изменить сведения»\./);
    assert.doesNotMatch(f.q('.src-queue').textContent, /подтверждено повтором/);
    assert.equal(Object.fromEntries(f.queue())['e.webm'], 'done');
    assert.equal(f.btn('Повторить неудавшиеся').hidden, true);
    assert.equal(attempt, 6);
  } finally { f.close(); }
});

test('байтовый прогресс: проценты только при известном объёме', async () => {
  let release, progress;
  const f = page({uploadFile: (url, body, {onProgress}) => { progress = onProgress; return new Promise((r) => { release = r; }); }}); try {
    await settle(); f.files([f.file('a.jpg')]); f.btn('Начать загрузку').click(); await settle();
    progress(0, 0); assert.match(f.q('.src-q').textContent, /загружается$/);
    progress(3, 10); assert.match(f.q('.src-q').textContent, /загружается 30%$/);
    assert.equal(f.btn('Начать загрузку').disabled, true);
    release({status: 201, body: {item: item(21, {name: 'a.jpg'}), duplicate: false}}); await settle();
    assert.equal(f.queue()[0][1], 'done');
  } finally { f.close(); }
});

test('повтор того же файла: «Уже есть», прежние сведения не изображаются новыми', async () => {
  const old = item(31, {name: 'a.jpg', caption: 'Старая подпись', metadata: {...META, occasion: 'Старый повод'}});
  const f = page({items: [old], uploadFile: async () => ({status: 200, body: {item: old, duplicate: true}})}); try {
    await settle();
    f.q('#src-caption-palitra-love').value = 'Новая подпись'; f.q('.src-extra [name="occasion"]').value = 'Новый повод';
    f.files([f.file('a.jpg')]); f.btn('Начать загрузку').click(); await settle();
    assert.equal(f.queue()[0][1], 'duplicate');
    assert.match(f.q('.src-queue').textContent, /Уже есть в библиотеке \(№31\): сохранены прежние подпись и сведения, новые не применены\./);
    assert.match(f.row(31).textContent, /Старая подпись/); assert.match(f.row(31).textContent, /Повод: Старый повод/);
    assert.doesNotMatch(f.element.textContent.replace(f.q('.src-work').textContent, ''), /Новая подпись|Новый повод/);
    assert.equal(f.qa('[data-source-id="31"]').length, 1, 'дубль не задваивает запись');
  } finally { f.close(); }
});

test('изменить сведения: PATCH с ревизией; 409 не затирает ввод, «Обновить» берёт свежую версию; повтор — только по нажатию', async () => {
  let version = 1, fresh = item(41, {caption: 'Было'});
  const f = page({items: [fresh],
    request: async (url, list) => (url.includes('?before=42') ? {...list(), items: [{...fresh, revision: version, caption: 'Изменено в другом окне'}]} : list()),
    send: async (url, method, body) => {
      if (body.revision !== version) throw Object.assign(new Error('Исходник уже изменён. Обновите страницу'), {status: 409});
      version++; return {item: item(41, {revision: version, caption: body.caption, metadata: {...META, ...body.metadata}})};
    }}); try {
    await settle();
    version = 2; // другое окно уже сохранило
    f.btn('Изменить сведения', f.row(41)).click();
    const panel = f.q('.src-panel', f.row(41));
    assert.equal(panel.hidden, false); assert.match(panel.textContent, /Версия сведений 1/);
    panel.querySelector('textarea').value = 'Моя подпись';
    panel.querySelector('[name="src-edit-41-materialState"][value="ready"]').checked = true;
    panel.querySelector('[name="src-edit-41-formats"][value="reel"]').checked = true;
    f.btn('Сохранить сведения', panel).click(); await settle();
    const first = f.writes()[0];
    assert.deepEqual([first[0], first[1]], ['PATCH', `/content/telegram-sources/${CODE}/41/metadata`]);
    assert.deepEqual(first[2], {revision: 1, metadata: {platforms: [], formats: ['reel'], occasion: '', eventDate: '', usageRestrictions: '', materialState: 'ready'}, caption: 'Моя подпись'});
    assert.match(panel.textContent, /уже изменили в другом окне\. Ваш ввод остался в форме/);
    assert.equal(panel.querySelector('textarea').value, 'Моя подпись');
    f.btn('Обновить', panel).click(); await settle();
    assert.ok(f.calls.some((c) => c[0] === 'GET' && c[1] === `/content/telegram-sources/${CODE}?before=42`));
    assert.match(panel.textContent, /Загружена версия 2: исходник; .*подпись: Изменено в другом окне/);
    assert.equal(panel.querySelector('textarea').value, 'Моя подпись', 'ввод не затёрт обновлением');
    assert.equal(f.writes().length, 1, 'обновление само ничего не сохраняет');
    f.btn('Сохранить сведения', panel).click(); await settle();
    assert.equal(f.writes()[1][2].revision, 2);
    assert.match(f.row(41).textContent, /Сведения сохранены \(версия 3\)/);
    assert.match(f.row(41).textContent, /Готовый материал/); assert.match(f.row(41).textContent, /Форматы: Reels \/ Shorts \/ клип/);
    assert.ok(f.btn('Прикрепить к публикации', f.row(41)), 'готовый JPEG можно прикрепить');
  } finally { f.close(); }
});

test('готовность: прикрепление только у сохранённого готового JPEG/PNG/WebP/MP4/WebM; MOV/PDF и исходник — с причиной; без права правки — только «Где использован»', async () => {
  const ready = {...META, materialState: 'ready'};
  const rows = [item(51, {metadata: ready}), item(52, {name: 'x.mov', mime: 'video/quicktime', metadata: ready}), item(53, {name: 'x.pdf', mime: 'application/pdf', metadata: ready}),
    item(54), item(55, {status: 'manual_import', metadata: ready, fileUrl: null})];
  const f = page({items: rows}); try {
    await settle();
    assert.ok(f.btn('Прикрепить к публикации', f.row(51)));
    for (const id of [52, 53]) { assert.equal(f.btn('Прикрепить к публикации', f.row(id)), undefined); assert.match(f.row(id).textContent, /подходит как исходник; для публикации нужен JPEG, PNG, WebP, MP4 или WebM/); }
    assert.equal(f.btn('Прикрепить к публикации', f.row(54)), undefined); assert.match(f.row(54).textContent, /Это исходник\. Чтобы прикрепить файл к публикации, отметьте его как готовый материал/);
    assert.equal(f.btn('Прикрепить к публикации', f.row(55)), undefined); assert.equal(f.btn('Где использован', f.row(55)), undefined);
  } finally { f.close(); }
  const g = page({items: rows, uploadAllowed: false, send: null, uploadFile: null}); try {
    await settle();
    assert.equal(g.q('.src-work').hidden, true);
    assert.match(g.element.textContent, /Загрузка и изменение сведений доступны с правом «Автопостинг: правка»/);
    assert.equal(g.qa('[data-src-action="edit"], [data-src-action="attach"]').length, 0);
    assert.ok(g.btn('Где использован', g.row(51)));
  } finally { g.close(); }
});

test('прикрепление к новому черновику: пояснение, неизвестный исход — тот же ключ и тело, квитанция названа квитанцией, «Открыть карточку» — свежая карточка', async () => {
  let attempts = 0;
  const f = page({items: [item(61, {caption: 'Фотозона\nвторая строка', metadata: {...META, materialState: 'ready'}})],
    send: async () => {
      if (++attempts === 1) throw Object.assign(new Error('Ответ CRM не получен. Повторите тот же запрос.'), {status: 502});
      return {companyCode: CODE, duplicate: true, post: {id: 77, companyCode: CODE, title: 'Фотозона', status: 'draft'}, link: {id: 1, sourceId: 61, sourceRevision: 1, postId: 77}};
    }}); try {
    await settle();
    f.btn('Прикрепить к публикации', f.row(61)).click();
    const panel = f.q('.src-panel', f.row(61));
    assert.match(panel.textContent, /Копия готового файла уйдёт в публикацию, сам исходник останется в библиотеке\. Новый черновик создаётся без даты и согласования/);
    assert.equal(panel.querySelector('#src-att-61-title').value, 'Фотозона', 'название по первой строке подписи');
    panel.querySelector('#src-att-61-format').value = 'reel'; panel.querySelector('#src-att-61-role').value = 'sale';
    f.btn('Прикрепить', panel).click(); await settle();
    const first = f.writes()[0];
    assert.deepEqual([first[0], first[1]], ['POST', `/content/telegram-sources/${CODE}/61/attach`]);
    assert.deepEqual(Object.keys(first[2]).sort(), ['clientRequestId', 'newPost', 'sourceRevision']);
    assert.deepEqual(first[2].newPost, {title: 'Фотозона', format: 'reel', ovpRole: 'sale'});
    assert.match(first[2].clientRequestId, /^[A-Za-z0-9_-]{8,100}$/);
    assert.match(panel.textContent, /Результат неизвестен: прикрепление могло выполниться\. «Отправить ещё раз» повторит тот же запрос — дубля не будет\./);
    assert.equal(f.btn('Прикрепить', panel).hidden, true, 'новый ключ по таймауту не создаётся');
    f.btn('Прикрепить', panel).click(); await settle();
    assert.equal(f.writes().length, 1);
    f.btn('Отправить ещё раз', panel).click(); await settle();
    assert.deepEqual(f.writes()[1][2], first[2], 'тот же ключ и то же тело');
    assert.match(panel.textContent, /Этот запрос уже был выполнен раньше\. Файл прикреплён к новому черновику №77\. Это квитанция на момент прикрепления/);
    f.btn('Открыть карточку', panel).click();
    assert.deepEqual(f.opened, [77]);
  } finally { f.close(); }
});

test('прикрепление к существующей карточке: только карточки своей компании; 409 — «Обновить» без потери выбора, затем новый явный запрос с новым ключом', async () => {
  let sourceRevision = 1, cardRevision = 3;
  const posts = () => ({companyCode: CODE, posts: [{id: 5, companyCode: CODE, title: 'Отзыв клиента', revision: cardRevision}, {id: 6, companyCode: CODE, title: 'Выписка', revision: 1},
    {id: 9, companyCode: 'alvi', title: 'Чужая', revision: 1}, {id: 8, companyCode: CODE, title: 'Удалённая', revision: 2, archive: {archivedAt: '2026-10-01T00:00:00Z'}}]});
  const f = page({items: [item(71, {metadata: {...META, materialState: 'ready'}})],
    request: async (url, list) => (url.startsWith('/content/crm/') ? posts() : url.includes('?before=72') ? {...list(), items: [item(71, {revision: sourceRevision, metadata: {...META, materialState: 'ready'}})]} : list()),
    send: async (url, method, body) => {
      if (body.revision !== cardRevision || body.sourceRevision !== sourceRevision) throw Object.assign(new Error('Публикация уже изменена'), {status: 409});
      return {companyCode: CODE, duplicate: false, post: {id: body.postId, companyCode: CODE}, link: {id: 2, sourceId: 71, postId: body.postId}};
    }}); try {
    await settle();
    f.btn('Прикрепить к публикации', f.row(71)).click();
    const panel = f.q('.src-panel', f.row(71));
    const radio = panel.querySelector('[name="src-att-71-target"][value="existing"]'); radio.checked = true; radio.dispatchEvent(new f.w.Event('change', {bubbles: true})); await settle();
    assert.ok(f.calls.some((c) => c[0] === 'GET' && c[1] === `/content/crm/autoposting/posts?companyCode=${CODE}`));
    assert.deepEqual([...panel.querySelectorAll('#src-att-71-post option')].map((o) => o.textContent), ['№5 · Отзыв клиента', '№6 · Выписка'], 'чужая и удалённая не предлагаются');
    panel.querySelector('#src-att-71-post').value = '6';
    cardRevision = 3; // №6 имеет revision 1 в списке, сервер ждёт 3 → 409
    f.btn('Прикрепить', panel).click(); await settle();
    const first = f.writes()[0][2];
    assert.deepEqual([first.postId, first.revision, first.sourceRevision], [6, 1, 1]);
    assert.match(panel.textContent, /Публикация уже изменена Нажмите «Обновить»: выбор сохранится/);
    sourceRevision = 2; cardRevision = 1;
    f.btn('Обновить', panel).click(); await settle();
    assert.equal(panel.querySelector('#src-att-71-post').value, '6', 'выбор сохранён');
    assert.match(panel.textContent, /Загружена версия исходника 2 и свежий список карточек/);
    assert.equal(f.writes().length, 1, 'обновление само не прикрепляет');
    f.btn('Прикрепить', panel).click(); await settle();
    const second = f.writes()[1][2];
    assert.deepEqual([second.postId, second.revision, second.sourceRevision], [6, 1, 2]);
    assert.notEqual(second.clientRequestId, first.clientRequestId, 'после решения пользователя — новый ключ');
    assert.match(panel.textContent, /Файл прикреплён к карточке №6/);
  } finally { f.close(); }
});

test('«Где использован»: по запросу; текущие, прежние и удалённые связи; переход по id своей компании; ответ чужой компании не рисуется', async () => {
  const usage = {companyCode: CODE, sourceId: 81, usages: [
    {id: 3, sourceId: 81, postId: 12, attachedAt: '2026-10-01T05:00:00Z', current: true, post: {id: 12, title: 'Отзыв клиента', status: 'draft', archivedAt: null}},
    {id: 2, sourceId: 81, postId: 13, attachedAt: '2026-09-30T05:00:00Z', current: false, post: {id: 13, title: 'Выписка', status: 'draft', archivedAt: null}},
    {id: 1, sourceId: 81, postId: 14, attachedAt: '2026-09-29T05:00:00Z', current: true, post: {id: 14, title: 'Удалённая', status: 'draft', archivedAt: '2026-10-01T07:00:00Z'}}]};
  let foreign = false;
  const f = page({items: [item(81)], request: async (url, list) => (url.endsWith('/81/usage') ? (foreign ? {...usage, companyCode: 'alvi'} : usage) : list())}); try {
    await settle();
    assert.ok(!f.calls.some((c) => c[1].endsWith('/usage')), 'не загружается без запроса');
    f.btn('Где использован', f.row(81)).click(); await settle();
    const panel = f.q('.src-panel', f.row(81)), text = panel.textContent;
    assert.match(text, /№12 · Отзыв клиента — файл в карточке сейчас/);
    assert.match(text, /№13 · Выписка — использовался раньше: в карточке файл заменён/);
    assert.match(text, /№14 · Удалённая — удалена из плана/);
    assert.match(text, /Замена файла в одной карточке не меняет остальные карточки/);
    f.btn('Открыть карточку', panel).click(); f.btn('Показать в удалённых', panel).click();
    assert.deepEqual(f.opened, [12, 14]);
    f.btn('Где использован', f.row(81)).click(); assert.equal(panel.hidden, true, 'повторное нажатие сворачивает');
    foreign = true; f.btn('Где использован', f.row(81)).click(); await settle();
    assert.doesNotMatch(panel.textContent, /Отзыв клиента/); assert.match(panel.textContent, /Не удалось загрузить: ответ другой компании/);
    assert.deepEqual(f.writes(), [], 'чтение ничего не пишет');
  } finally { f.close(); }
});

test('смена компании во время загрузки и чтения: поздние ответы не рисуются, очередь остановлена', async () => {
  let release, usageRelease;
  const f = page({items: [item(91)], uploadFile: () => new Promise((r) => { release = r; }),
    request: async (url, list) => (url.endsWith('/usage') ? new Promise((r) => { usageRelease = r; }) : list())}); try {
    await settle();
    f.files([f.file('a.jpg'), f.file('b.jpg')]); f.btn('Начать загрузку').click(); await settle();
    f.btn('Где использован', f.row(91)).click(); await settle();
    f.api.destroy(); f.element.textContent = 'Другая компания';
    release({status: 201, body: {item: item(92, {name: 'a.jpg'}), duplicate: false}});
    usageRelease({companyCode: CODE, sourceId: 91, usages: []}); await settle();
    assert.equal(f.element.textContent, 'Другая компания');
    assert.equal(f.calls.filter((c) => c[0] === 'UPLOAD').length, 1, 'второй файл после ухода не отправлен');
  } finally { f.w.close(); }
});

// ---------- CF17: замечания root к CF13 ----------
test('CF17: повтор после потерянного ответа шлёт первоначальные подпись и сведения, даже если форму изменили; новые файлы — с текущими; честный текст дубля', async () => {
  const sent = [];
  let lost = true;
  const f = page({uploadFile: async (url, body) => {
    const name = body.get('file').name, record = {name, caption: body.get('caption'), metadata: JSON.parse(body.get('metadata'))};
    sent.push(record);
    if (name === 'a.jpg' && lost) { lost = false; throw Object.assign(new Error('Нет связи с сервером'), {status: 0}); }
    if (name === 'a.jpg') return {status: 200, body: {item: item(101, {name, caption: 'Первая подпись', metadata: {...META, occasion: 'Выпускной', materialState: 'ready'}}), duplicate: true}};
    return {status: 201, body: {item: item(102, {name, caption: record.caption, metadata: {...META, ...record.metadata}}), duplicate: false}};
  }}); try {
    await settle();
    f.q('#src-caption-palitra-love').value = 'Первая подпись';
    f.q('.src-extra [name="occasion"]').value = 'Выпускной';
    f.q('[name="src-up-materialState"][value="ready"]').checked = true;
    f.files([f.file('a.jpg')]); f.btn('Начать загрузку').click(); await settle();
    assert.equal(f.queue()[0][1], 'error');
    assert.match(f.q('.src-queue').textContent, /Повтор отправит те же подпись и сведения, что и первая попытка\./);
    // Пользователь меняет форму и добавляет новый файл.
    f.q('#src-caption-palitra-love').value = 'Вторая подпись';
    f.q('.src-extra [name="occasion"]').value = 'Выписка';
    f.q('[name="src-up-materialState"][value="source"]').checked = true;
    f.files([f.file('c.jpg')]);
    f.btn('Повторить неудавшиеся').click(); await settle(); await settle();
    assert.deepEqual(sent.map((r) => [r.name, r.caption, r.metadata.occasion, r.metadata.materialState]),
      [['a.jpg', 'Первая подпись', 'Выпускной', 'ready'], ['a.jpg', 'Первая подпись', 'Выпускной', 'ready'], ['c.jpg', 'Вторая подпись', 'Выписка', 'source']]);
    assert.deepEqual(sent[1], sent[0], 'повтор — те же подпись и metadata');
    assert.equal(f.q('#src-caption-palitra-love').value, 'Вторая подпись', 'введённое в форму не потеряно');
    assert.deepEqual(Object.fromEntries(f.queue()), {'a.jpg': 'duplicate', 'c.jpg': 'done'});
    const text = f.q('.src-queue').textContent;
    assert.match(text, /Файл есть в библиотеке \(№101\)\. Сервер не подтверждает, какая попытка его сохранила; сохранённые подпись и сведения совпадают с отправленными\./);
    assert.doesNotMatch(text, /новые применены|подтверждено повтором/);
  } finally { f.close(); }
});

test('CF17: выключенный автоприём Telegram не выдаётся за выключенную загрузку', async () => {
  const f = page({items: [item(111)]}); try {
    await settle();
    const status = f.q('[role="status"]').textContent;
    assert.equal(status, 'Автоприём из Telegram выключен. Загрузка файлов на этой странице работает и без Telegram.');
    assert.doesNotMatch(f.element.textContent, /Приём новых исходников выключен/);
    assert.equal(f.q('.src-work').hidden, false);
  } finally { f.close(); }
  const g = page({items: [], uploadAllowed: false, send: null, uploadFile: null}); try {
    await settle();
    assert.equal(g.q('[role="status"]').textContent, 'Автоприём из Telegram выключен. Сохранённых исходников пока нет.', 'без права загрузки не обещаем загрузку');
  } finally { g.close(); }
});

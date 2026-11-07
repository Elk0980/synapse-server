const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const {validateEdl} = require(path.join(__dirname, '../../../ops/crm/reel-materials.js'));
const script = fs.readFileSync(require.resolve('./reel-editor.js'), 'utf8');
const shootingScript = fs.readFileSync(require.resolve('./shooting-script.js'), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const plain = (value) => JSON.parse(JSON.stringify(value));
const reel = {id: 4, title: 'Рилс', currentVersion: {version: 2, mediaUrl: 'https://cabinet.test/v2.mp4', durationMs: 40000},
  versions: [{version: 1, mediaUrl: 'https://cabinet.test/v1.mp4', durationMs: 42000}, {version: 2, mediaUrl: 'https://cabinet.test/v2.mp4', durationMs: 40000}]};
/* Сценарий по секундам — обезличенный пример формата, не данные клиента. */
const idea = {ideaId: 'idea-7', topic: 'Тема', script: [
  '0–10 с | Ведущая | Первая реплика | Крупный план | — | Титр один',
  '10–20 с | Ведущая | Вторая реплика | Общий план | — |',
  '20–40 с | — | — | Вставка: студия | Склейка | Титр три'].join('\n')};
const uploads = [
  {id: 11, ideaId: 'idea-7', frame: 1, kind: 'take', status: 'stored', name: 'a.mov', fileUrl: '/content/shooting/files/11?companyCode=avokado'},
  {id: 12, ideaId: 'idea-7', frame: 3, kind: 'take', status: 'stored', name: 'b.mov', fileUrl: '/content/shooting/files/12?companyCode=avokado'},
  {id: 14, ideaId: 'idea-7', frame: 3, kind: 'take', status: 'stored', name: 'c.mov', fileUrl: '/content/shooting/files/14?companyCode=avokado'},
  {id: 15, ideaId: 'idea-7', frame: 2, kind: 'take', status: 'uploading', name: 'd.mov', fileUrl: null},
  {id: 16, ideaId: 'idea-7', frame: 2, kind: 'draft', status: 'stored', name: 'cut.mp4', fileUrl: '/content/shooting/files/16?companyCode=avokado'}];

function fixture({withIdea = true, number = 2, uploadsOf = () => uploads, post} = {}) {
  const dom = new JSDOM('<main id="host"><button data-edit>Редактировать</button></main>', {url: 'https://cabinet.test/#content/materials', runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window, host = w.document.getElementById('host'), posts = [], gets = [], chat = [], changes = [];
  w.HTMLMediaElement.prototype.pause = () => {};
  w.HTMLMediaElement.prototype.play = () => Promise.resolve();
  w.addEventListener('synapse:hugh-chat', (event) => chat.push(plain(event.detail)));
  w.eval(shootingScript);
  w.eval(script);
  const ctx = {companyCode: 'avokado', signal: new w.AbortController().signal, can: () => true, csrfToken: 't',
    api: {get: async (url) => {gets.push(url);return {companyCode: 'avokado', uploads: uploadsOf()};},
      post: post || (async (url, body) => {posts.push({url, body: plain(body)});return {edit: {id: 30 + posts.length, taskId: 90 + posts.length},
        reel: {...reel, versions: reel.versions, edits: [{id: 31}]}};})}};
  const editor = w.SbCabinet.reelEditor.open(host, {ctx, reel, version: 2, number, idea: withIdea ? idea : null, onChange: (next) => changes.push(next)});
  const $ = (s) => editor.root.querySelector(s);
  const change = (node, value) => {node.value = value;node.dispatchEvent(new w.Event('change', {bubbles: true}));};
  return {w, host, editor, $, change, posts, gets, chat, changes, api: w.SbCabinet.reelEditor};
}

test('Время и сцены: m:ss, разбор полей, клипы по «Сценарию по секундам»', () => {
  const {api} = fixture();
  assert.equal(api.clock(12000), '0:12'); assert.equal(api.clock(72500), '1:12,5');
  assert.equal(api.parseClock('0:12'), 12000); assert.equal(api.parseClock('12,5'), 12500); assert.equal(api.parseClock('1:02.3'), 62300);
  assert.equal(api.parseClock(''), null); assert.equal(api.parseClock('абв'), null);
  const scenes = api.parseScenes(idea);
  assert.deepEqual(plain(scenes.map((s) => [s.n, s.fromMs, s.toMs, s.title])), [[1, 0, 10000, 'Титр один'], [2, 10000, 20000, ''], [3, 20000, 40000, 'Титр три']]);
  const even = api.layoutScenes(scenes.map((s) => ({...s, fromMs: null, toMs: null})), 30000);
  assert.deepEqual(plain(even.map((s) => [s.fromMs, s.toMs])), [[0, 10000], [10000, 20000], [20000, 30000]], 'без времени — поровну');
  assert.equal(api.parseScenes(null).length, 0);
});

test('Окно по макету: «Редактировать · №N · vK», дорожки Видео/Титры/Звук, подпись о v(K+1), версии', () => {
  const f = fixture();
  assert.equal(f.$('[data-title]').textContent, 'Редактировать · №2 · v2');
  assert.equal(f.$('video').getAttribute('src'), 'https://cabinet.test/v2.mp4');
  assert.equal(f.$('[data-ruler]').textContent, '0:000:200:40');
  assert.deepEqual([...f.$('[data-lane=video]').children].map((c) => c.textContent), ['1', '2', '3']);
  assert.equal(f.$('[data-lane=video] .re-clip').style.width, '25%');
  assert.equal(f.$('[data-lane=titles]').querySelectorAll('.re-clip').length, 2, 'титры — только у сцен с титром');
  assert.match(f.$('[data-lane=audio]').textContent, /звук ролика/);
  assert.match(f.$('[data-note]').textContent, /появится здесь как v3; этап станет «Монтаж на согласовании»/);
  assert.deepEqual([...f.$('[data-versions]').querySelectorAll('button')].map((b) => [b.textContent, b.classList.contains('is-on')]), [['v1', false], ['v2', true]]);
  f.$('[data-version="1"]').click();
  assert.equal(f.$('[data-title]').textContent, 'Редактировать · №2 · v1');
  assert.equal(f.$('video').getAttribute('src'), 'https://cabinet.test/v1.mp4');
  assert.equal(f.editor.version, 1);
  f.$('[data-close]').click();
  assert.equal(f.host.querySelector('.re-editor'), null);
  assert.equal(f.w.document.activeElement, f.host.querySelector('[data-edit]'));
});

test('Отметка «от … до …» полями и «Отправить Хью» — существующий маршрут правки kind=request, запись в чат', async () => {
  const f = fixture();
  f.change(f.$('[data-mark=from]'), '0:12'); f.change(f.$('[data-mark=to]'), '0:18');
  assert.equal(f.$('[data-sel]').hidden, false);
  assert.equal(f.$('[data-sel]').style.getPropertyValue('--a'), '0.3');
  f.$('[data-send]').click(); await tick();
  assert.equal(f.posts.length, 0, 'пустой запрос без дубля не уходит');
  assert.match(f.$('[data-status]').textContent, /Напишите, что изменить/);
  f.$('[data-ask]').value = 'убери паузу';
  f.$('[data-send]').click(); await tick();
  assert.equal(f.posts[0].url, 'crm/autoposting/reels/4/edits');
  assert.deepEqual({...f.posts[0].body, clientRequestId: 'x'}, {clientRequestId: 'x', baseVersion: 2, kind: 'request', startMs: 12000, endMs: 18000, comment: 'убери паузу'});
  assert.match(f.$('[data-status]').textContent, /задача №91.*как v3/);
  assert.equal(f.$('[data-ask]').value, ''); assert.equal(f.$('[data-sel]').hidden, true);
  assert.equal(f.chat[0].taskId, 91); assert.match(f.chat[0].text, /Хью, измени №2 v2, 0:12–0:18: убери паузу/);
  assert.equal(f.changes.length, 1);
});

test('Неверный отрезок не отправляется; «Отменить отметку» очищает поля и дубль', async () => {
  const f = fixture();
  f.change(f.$('[data-mark=from]'), '0:20'); f.change(f.$('[data-mark=to]'), '0:10');
  f.$('[data-ask]').value = 'текст'; f.$('[data-send]').click(); await tick();
  assert.equal(f.posts.length, 0); assert.match(f.$('[data-status]').textContent, /«от» меньше «до»/);
  f.change(f.$('[data-mark=to]'), '0:55'); f.$('[data-send]').click(); await tick();
  assert.equal(f.posts.length, 0, 'за пределами ролика');
  f.$('[data-clear]').click();
  assert.equal(f.$('[data-mark=from]').value, ''); assert.equal(f.$('[data-sel]').hidden, true);
});

test('Перетаскивание по дорожке выделяет отрезок, нажатие ставит курсор', () => {
  const f = fixture();
  const tl = f.$('[data-tl]'), laneEl = f.$('[data-lane=video]');
  laneEl.getBoundingClientRect = () => ({left: 100, width: 400, top: 0, height: 26, right: 500, bottom: 26});
  const fire = (type, x) => {const e = new f.w.MouseEvent(type, {bubbles: true, clientX: x, button: 0});tl.dispatchEvent(e);};
  fire('pointerdown', 200); fire('pointermove', 260); fire('pointerup', 260);
  assert.deepEqual(plain(f.editor.mark), {from: 10000, to: 16000});
  assert.equal(f.$('[data-mark=from]').value, '0:10'); assert.equal(f.$('[data-mark=to]').value, '0:16');
  fire('pointerdown', 300); fire('pointerup', 300);
  assert.equal(f.$('video').currentTime, 20, 'нажатие без сдвига — курсор');
  assert.deepEqual(plain(f.editor.mark), {from: 10000, to: 16000}, 'отметка сохраняется');
});

test('«Исходники ▾»: дорожки по сценам из реальных загрузок, Титры/Звук скрыты, дубль идёт в запрос Хью', async () => {
  const f = fixture();
  assert.equal(f.$('[data-src]').hidden, true);
  f.$('[data-sources]').click(); await tick(); await tick();
  assert.ok(f.editor.root.classList.contains('is-sources'));
  assert.equal(f.$('[data-sources]').textContent, 'Исходники ▴');
  assert.deepEqual(f.gets, ['shooting/reels/idea-7']);
  const rows = [...f.$('[data-src]').querySelectorAll('.re-track--take')];
  assert.deepEqual(rows.map((r) => r.querySelector('.re-track__name').textContent), ['Сц.1', 'Сц.2', 'Сц.3']);
  assert.deepEqual(rows.map((r) => [...r.querySelectorAll('[data-take-id]')].map((b) => b.textContent)), [['д1'], [], ['д1', 'д2']], 'только сохранённые дубли (kind=take)');
  assert.equal(f.$('[data-src]').querySelectorAll('input[type=file]').length, 3, '«＋» у каждой сцены');
  assert.equal(f.$('[data-ask]').isConnected && f.$('[data-send]').isConnected, true);
  f.$('[data-take-id="14"]').click();
  assert.ok(f.$('[data-take-id="14"]').classList.contains('is-on'));
  assert.match(f.$('[data-status]').textContent, /Отметьте на дорожке отрезок/);
  f.change(f.$('[data-mark=from]'), '0:12'); f.change(f.$('[data-mark=to]'), '0:18');
  assert.match(f.$('[data-take]').textContent, /Заменить 0:12–0:18 на сцену 3 дубль 2/);
  f.$('[data-send]').click(); await tick();
  assert.equal(f.posts[0].body.comment, 'Заменить 0:12–0:18 на сцену 3 дубль 2 (исходник «c.mov», загрузка №14).');
  assert.equal(f.posts[0].body.startMs, 12000);
  assert.equal(f.$('[data-take]').hidden, true, 'после отправки дубль снят');
  f.$('[data-sources]').click();
  assert.ok(!f.editor.root.classList.contains('is-sources')); assert.equal(f.$('[data-src]').hidden, true);
});

test('«＋» загружает дубль существующей загрузкой съёмки и обновляет список', async () => {
  let list = uploads.slice(0, 1);
  const f = fixture({uploadsOf: () => list});
  const calls = [];
  f.w.SbShooting.upload = {upload: async (opts) => {calls.push({ideaId: opts.ideaId, frame: opts.frame, companyCode: opts.companyCode, headers: opts.headers});
    list = [...list, {id: 20, frame: 2, kind: 'take', status: 'stored', name: 'n.mov', fileUrl: '/content/shooting/files/20?companyCode=avokado'}];return {status: 'stored'};}};
  f.$('[data-sources]').click(); await tick(); await tick();
  const input = f.$('[data-add="2"]');
  const file = new f.w.File(['x'], 'n.mov', {type: 'video/quicktime'});
  Object.defineProperty(input, 'files', {value: [file], configurable: true});
  input.dispatchEvent(new f.w.Event('change', {bubbles: true}));
  await tick(); await tick(); await tick();
  assert.deepEqual(plain(calls), [{ideaId: 'idea-7', frame: 2, companyCode: 'avokado', headers: {'X-CSRF-Token': 't'}}]);
  assert.equal(f.gets.length, 2);
  assert.deepEqual([...f.$('[data-src]').querySelectorAll('[data-take-id]')].map((b) => b.dataset.takeId), ['11', '20']);
  assert.match(f.$('[data-status]').textContent, /«n\.mov» загружен/);
});

test('Ролик без рилса плана: заголовок по названию, одна дорожка «ролик», исходников нет — честная пометка', async () => {
  const f = fixture({withIdea: false, number: null});
  assert.equal(f.$('[data-title]').textContent, 'Редактировать · Рилс · v2');
  assert.equal(f.$('[data-lane=video]').textContent, 'ролик');
  assert.match(f.$('[data-lane=titles]').textContent, /титров в сценарии нет/);
  f.$('[data-sources]').click(); await tick();
  assert.equal(f.gets.length, 0);
  assert.match(f.$('[data-src]').textContent, /исходников съёмки нет/);
});

test('Ошибка сервера: текст остаётся в поле', async () => {
  const f = fixture({post: async () => {throw Object.assign(new Error('Версия ролика не найдена'), {status: 400});}});
  f.change(f.$('[data-mark=from]'), '1'); f.change(f.$('[data-mark=to]'), '2');
  f.$('[data-ask]').value = 'правка'; f.$('[data-send]').click(); await tick();
  assert.match(f.$('[data-status]').textContent, /Не отправлено: Версия ролика не найдена/);
  assert.equal(f.$('[data-ask]').value, 'правка'); assert.equal(f.$('[data-send]').disabled, false);
});

test('Операции EDL сохранены и совместимы с серверной проверкой', () => {
  const {api: {ops}} = fixture();
  const two = ops.split(ops.initial(10000).video, 4000);
  assert.deepEqual(plain(two), [{inMs: 0, outMs: 4000}, {inMs: 4000, outMs: 10000}]);
  assert.deepEqual(plain(ops.move(two, 1, -1)), [{inMs: 4000, outMs: 10000}, {inMs: 0, outMs: 4000}]);
  assert.equal(validateEdl({...ops.initial(10000), video: two}, 10000).outputMs, 10000);
});

test('«Ручные правки ▾»: свёрнуто по умолчанию, внутри прежние кнопки и полоса клипов EDL', () => {
  const f = fixture();
  assert.equal(f.$('[data-manual]').textContent, 'Ручные правки ▾');
  assert.equal(f.$('[data-manual]').getAttribute('aria-expanded'), 'false');
  assert.equal(f.$('[data-man]').hidden, true);
  f.$('[data-manual]').click();
  assert.equal(f.$('[data-man]').hidden, false); assert.equal(f.$('[data-manual]').textContent, 'Ручные правки ▴');
  for (const name of ['split', 'remove', 'left', 'right', 'reset', 'submit']) assert.ok(f.$(`[data-op="${name}"]`), name);
  assert.equal(f.$('[data-op=split]').textContent, 'Разделить здесь'); assert.equal(f.$('[data-op=remove]').textContent, 'Удалить кусок');
  assert.deepEqual([...f.$('[data-speed]').options].map((o) => o.textContent), ['1×', '1,25×', '1,5×']);
  assert.equal(f.$('[data-edl]').querySelectorAll('[data-track=video]').length, 1);
  assert.equal(f.$('[data-edl]').querySelectorAll('[data-track=audio]').length, 1);
  assert.equal(f.$('[data-total]').textContent, 'Итог: 40,0 с');
  assert.ok(f.$('[data-tl]') && f.$('[data-sources]') && f.$('[data-send]'), 'дорожки сцен, «Исходники», «Отправить Хью» на месте');
  assert.equal(f.$('[data-lane=video]').querySelectorAll('.re-clip').length, 3, 'дорожки сцен не изменились');
});

test('Разделить / Удалить / ← → / перетаскивание меняют EDL; громкость, «Без звука», скорость; черновик в localStorage', () => {
  const f = fixture();
  f.$('[data-manual]').click();
  f.$('video').currentTime = 4;
  f.$('[data-op=split]').click();
  assert.deepEqual(plain(f.editor.edl.video), [{inMs: 0, outMs: 4000}, {inMs: 4000, outMs: 40000}]);
  assert.equal(f.$('[data-edl]').querySelectorAll('[data-track=video]').length, 2);
  f.$('[data-track=video][data-index="1"]').click();
  assert.deepEqual(plain(f.editor.selected), {track: 'video', index: 1});
  assert.ok(f.$('[data-track=video][data-index="1"]').classList.contains('is-on'));
  f.$('[data-op=left]').click();
  assert.deepEqual(plain(f.editor.edl.video), [{inMs: 4000, outMs: 40000}, {inMs: 0, outMs: 4000}]);
  assert.equal(f.editor.selected.index, 0);
  f.$('[data-op=right]').click();
  assert.deepEqual(plain(f.editor.edl.video), [{inMs: 0, outMs: 4000}, {inMs: 4000, outMs: 40000}]);
  const drag = (type, node) => node.dispatchEvent(new f.w.Event(type, {bubbles: true, cancelable: true}));
  drag('dragstart', f.$('[data-track=video][data-index="1"]')); drag('dragover', f.$('[data-track=video][data-index="0"]')); drag('drop', f.$('[data-track=video][data-index="0"]'));
  assert.deepEqual(plain(f.editor.edl.video), [{inMs: 4000, outMs: 40000}, {inMs: 0, outMs: 4000}], 'перетаскивание переставляет клип');
  f.$('[data-track=video][data-index="1"]').click(); f.$('[data-op=remove]').click();
  assert.deepEqual(plain(f.editor.edl.video), [{inMs: 4000, outMs: 40000}]);
  assert.equal(f.$('[data-total]').textContent, 'Итог: 36,0 с');
  f.$('[data-op=remove]').click();
  assert.equal(f.editor.edl.video.length, 1, 'последний клип видео не удаляется');
  assert.match(f.$('[data-status]').textContent, /хотя бы один клип/);
  assert.equal(f.$('[data-field=gain]'), null, 'громкость — только для клипа звука');
  f.$('[data-track=audio][data-index="0"]').click();
  f.change(f.$('[data-field=gain]'), '150');
  assert.equal(f.editor.edl.audio[0].gain, 1.5);
  const mute = f.$('[data-field=muted]'); mute.checked = true; mute.dispatchEvent(new f.w.Event('change', {bubbles: true}));
  assert.equal(f.editor.edl.audio[0].muted, true);
  assert.match(f.$('[data-track=audio]').textContent, /без звука/);
  f.change(f.$('[data-speed]'), '1.5');
  assert.equal(f.editor.edl.speed, 1.5);
  assert.equal(f.$('[data-total]').textContent, 'Итог: 24,0 с (скорость 1,5×)');
  const saved = JSON.parse(f.w.localStorage.getItem('sb-reel-edl:avokado:4:v2'));
  assert.deepEqual(saved, plain(f.editor.edl));
  assert.equal(validateEdl(saved, 40000).outputMs, 24000, 'черновик проходит серверную проверку');
  f.$('[data-op=reset]').click();
  assert.deepEqual(plain(f.editor.edl), plain(f.api.ops.initial(40000)));
  assert.equal(f.w.localStorage.getItem('sb-reel-edl:avokado:4:v2'), null);
});

test('«Отправить в монтаж»: kind=edl, baseVersion, clientRequestId, комментарий; без правок не уходит', async () => {
  const f = fixture();
  f.$('[data-manual]').click();
  f.$('[data-op=submit]').click(); await tick();
  assert.equal(f.posts.length, 0); assert.match(f.$('[data-status]').textContent, /Ручных правок пока нет/);
  f.$('video').currentTime = 10; f.$('[data-op=split]').click();
  f.$('[data-comment]').value = 'склейка по паузе';
  f.$('[data-op=submit]').click(); await tick();
  assert.equal(f.posts.length, 1);
  const {url, body} = f.posts[0];
  assert.equal(url, 'crm/autoposting/reels/4/edits');
  assert.equal(body.kind, 'edl'); assert.equal(body.baseVersion, 2); assert.equal(body.comment, 'склейка по паузе');
  assert.ok(typeof body.clientRequestId === 'string' && body.clientRequestId.length > 0);
  assert.deepEqual(body.edl.video, [{inMs: 0, outMs: 10000}, {inMs: 10000, outMs: 40000}]);
  assert.equal(validateEdl(body.edl, 40000).outputMs, 40000);
  assert.match(f.$('[data-status]').textContent, /отправлен в монтаж: задача №91/);
  assert.equal(f.w.localStorage.getItem('sb-reel-edl:avokado:4:v2'), null, 'черновик очищен после отправки');
  assert.equal(f.editor.edl.video.length, 1); assert.equal(f.$('[data-comment]').value, '');
  assert.match(f.chat[0].text, /Правки монтажа к №2 v2 отправлены \(задача №91\): склейка по паузе/);
});

test('Ручные правки: ошибка сервера сохраняет черновик; недоступный localStorage не ломает окно', async () => {
  const f = fixture({post: async () => {throw new Error('Клип короче 0,1 с');}});
  f.$('[data-manual]').click(); f.$('video').currentTime = 5; f.$('[data-op=split]').click();
  f.$('[data-op=submit]').click(); await tick();
  assert.match(f.$('[data-status]').textContent, /Не отправлено: Клип короче 0,1 с\. Правки сохранены в этом браузере/);
  assert.equal(JSON.parse(f.w.localStorage.getItem('sb-reel-edl:avokado:4:v2')).video.length, 2);
  const ctx2 = () => ({companyCode: 'avokado', signal: new f.w.AbortController().signal, api: {get: async () => ({}), post: async () => ({})}});
  const reopened = f.w.SbCabinet.reelEditor.open(f.host, {ctx: ctx2(), reel, version: 2});
  assert.equal(reopened.edl.video.length, 2, 'черновик подхватывается при новом открытии');
  Object.defineProperty(f.w, 'localStorage', {get() {throw new Error('blocked');}, configurable: true});
  const blocked = f.w.SbCabinet.reelEditor.open(f.host, {ctx: ctx2(), reel, version: 2});
  assert.equal(blocked.edl.video.length, 1);
  blocked.root.querySelector('[data-manual]').click(); blocked.root.querySelector('video').currentTime = 5;
  blocked.root.querySelector('[data-op=split]').click();
  assert.equal(blocked.edl.video.length, 2, 'правки работают и без хранилища');
});

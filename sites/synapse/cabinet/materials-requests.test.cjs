'use strict';
/* specs/231-lena-materials-requests: окно ролика в «Монтаже» — решение и своя подпись, просьбы агенту со статусами,
   «живой монтаж» с предпросмотром, история. Данные синтетические. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const script = fs.readFileSync(require.resolve('./materials.js'), 'utf8');
const kitSource = fs.readFileSync(path.join(__dirname, 'cf-kit.js'), 'utf8');
/* Объекты из окна jsdom принадлежат другому миру JS: сравниваем по значению. */
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };
const asset = (n) => `https://cabinet.test/content/publishing-assets/alpha/${n.repeat(32)}.mp4`;
const segments = () => [{startMs: 0, endMs: 3000, label: 'Вход'}, {startMs: 3000, endMs: 6000}, {startMs: 6000, endMs: 10000, label: 'Финал'}];
const summary = (over = {}) => ({id: 4, key: 'reel:4', source: 'materials', companyCode: 'alpha', title: 'Ролик про мастера', releaseDate: '2026-11-20', platforms: ['instagram', 'vk'],
  postId: null, currentVersion: {version: 2, mediaUrl: asset('b'), durationMs: 10000, segments: segments()}, versionCount: 2, openEdits: 0,
  caption: '', decision: 'take', decisionLabel: 'берём', decisionComment: '', openRequests: 2, ...over});
const requests = () => [
  {id: 1, reelId: 4, kind: 'redo', status: 'ready', text: 'Короче начало', version: 1, startMs: 1000, endMs: 2500, date: '', reply: 'Готова новая версия v2. Посмотрите и скажите, подходит ли.',
    authorName: 'Редактор', createdAt: '2026-11-20T03:00:00Z', events: []},
  {id: 2, reelId: 4, kind: 'publish', status: 'waiting_owner', text: '', version: 2, startMs: null, endMs: null, date: '', reply: 'Черновик публикации №7 создан, на площадки ничего не отправлено. Публикацию должен согласовать владелец.',
    authorName: 'Редактор', createdAt: '2026-11-20T04:00:00Z', events: []},
  {id: 3, reelId: 4, kind: 'reschedule', status: 'accepted', text: '', version: null, startMs: null, endMs: null, date: '2026-11-27', reply: '', authorName: 'Редактор', createdAt: '2026-11-20T05:00:00Z', events: []}];
const full = (over = {}) => ({...summary(), versions: [{version: 1, mediaUrl: asset('a'), durationMs: 9000}, {version: 2, mediaUrl: asset('b'), durationMs: 10000, segments: segments()}],
  edits: [], log: [], requests: requests(), openRequests: 2,
  history: [{id: 2, field: 'decision', fieldLabel: 'Решение', before: '', after: 'take', beforeLabel: 'без решения', afterLabel: 'берём', comment: 'Хороший дубль', authorName: 'Редактор', at: '2026-11-20T02:00:00Z'},
    {id: 1, field: 'caption', fieldLabel: 'Подпись', before: '', after: 'Первая подпись', comment: '', authorName: 'Редактор', at: '2026-11-20T01:00:00Z'}], ...over});

function fixture({permissions = ['autoposting.view', 'autoposting.edit'], reel = full, list = () => [summary()], respond} = {}) {
  const dom = new JSDOM('<main id="view"></main>', {url: 'https://cabinet.test/#content/materials', runScripts: 'outside-only'});
  const w = dom.window, el = w.document.getElementById('view'), calls = [];
  w.eval(kitSource);
  w.SynapseModulesQueue = [];
  w.eval(script);
  const [, definition] = w.SynapseModulesQueue[0];
  const answer = async (method, route, body) => {
    calls.push({method, path: route, body});
    const custom = respond && await respond({method, path: route, body});
    if (custom !== undefined) return custom;
    if (route === 'crm/autoposting/reels' && method === 'GET') return {companyCode: 'alpha', reels: list()};
    if (route === 'crm/autoposting/reels/4' && method === 'GET') return reel();
    if (route === 'crm/autoposting/reels/4' && method === 'PATCH') return reel({caption: body.caption, decision: body.decision, decisionComment: body.decisionComment});
    throw Object.assign(new Error('unexpected ' + route), {status: 500});
  };
  const ctx = {moduleId: 'content-materials', companyCode: 'alpha', can: (p) => permissions.includes(p), signal: new w.AbortController().signal, route: {path: ''},
    settings: {content: {get: async () => ({settings: {}})}},
    api: {get: (route) => answer('GET', route), post: (route, body) => answer('POST', route, body), patch: (route, body) => answer('PATCH', route, body)}, navigate: () => {}};
  const open = async () => {await definition.mount(el, ctx);await settle(2);el.querySelector('[data-open="reel:4"]').click();await settle();};
  const click = async (selector) => {el.querySelector(selector).click();await settle();};
  const submit = async (selector) => {el.querySelector(selector).dispatchEvent(new w.Event('submit', {bubbles: true, cancelable: true}));await settle();};
  return {w, el, calls, open, click, submit, live: w.SbCabinet.materialsLive};
}
const sent = (f, method, suffix) => f.calls.filter((call) => call.method === method && call.path.endsWith(suffix));

test('живой монтаж, расчёт предпросмотра: убранный отрезок пропускается, дальше всё убрано — стоп, без звука — глушим', () => {
  const {live} = fixture(), list = segments();
  const toggles = [{enabled: true, sound: true}, {enabled: false, sound: true}, {enabled: true, sound: false}];
  same(live.at(list, toggles, 1000), {index: 0, seekMs: null, stop: false, mute: false});
  same(live.at(list, toggles, 3500), {index: 1, seekMs: 6000, stop: false, mute: false});
  same(live.at(list, toggles, 7000), {index: 2, seekMs: null, stop: false, mute: true});
  assert.equal(live.at(list, [toggles[0], toggles[1], {enabled: false, sound: true}], 4000).stop, true);
  assert.equal(live.at(list, toggles, 99000).index, -1);
  assert.equal(live.changed(live.initial(list)), false);assert.equal(live.changed(toggles), true);
  same(live.body(list, toggles)[1], {startMs: 3000, endMs: 6000, enabled: false, sound: true}, 'границы и порядок — как у версии, без подписей');
  assert.equal(live.parseMmss('1:05'), 65000);assert.equal(live.parseMmss('12'), 12000);assert.equal(live.parseMmss('0:07,5'), 7500);assert.equal(live.parseMmss('скоро'), null);
  assert.equal(live.mmss(65400), '1:05');
});

test('старый сервер (без списка просьб): новые блоки не показываются, окно работает как раньше', async () => {
  const f = fixture({reel: () => {const {requests: _r, history: _h, ...rest} = full();return rest;}});
  await f.open();
  assert.ok(f.el.querySelector('[data-player]'));
  for (const selector of ['[data-review-box]', '[data-ask-box]', '[data-live-box]', '[data-history]']) assert.equal(f.el.querySelector(selector), null, selector);
});

test('решение и своя подпись: видны в ленте и в окне, сохраняются одной кнопкой; история свёрнута', async () => {
  const f = fixture();
  await f.open();
  assert.equal(f.el.querySelector('.mt-card [data-decision="take"]').textContent, 'Берём');
  assert.equal(f.el.querySelector('.mt-card [data-open-requests]').textContent, 'Просьб: 2');
  const form = f.el.querySelector('[data-review]');
  assert.equal(form.querySelector('input[name="mt-decision"]:checked').value, 'take');
  same([...form.querySelectorAll('.mt-decision__item span')].map((n) => n.textContent), ['Берём', 'Не берём', 'Переделать', 'Пока не решили']);
  form.querySelector('input[value="redo"]').checked = true;form.elements.decisionComment.value = ' Затянуто начало ';form.elements.caption.value = 'Новая подпись';
  await f.submit('[data-review]');
  same(sent(f, 'PATCH', '/reels/4')[0].body, {caption: 'Новая подпись', decision: 'redo', decisionComment: 'Затянуто начало'});
  assert.equal(f.el.querySelector('[data-review-status]').textContent, 'Сохранено.');
  assert.equal(f.el.querySelector('[data-review] textarea').value, 'Новая подпись');
  f.el.querySelector('[data-review] input[value=""]').checked = true;f.el.querySelector('[data-review]').elements.decisionComment.value = 'лишний комментарий';
  await f.submit('[data-review]');
  assert.equal(sent(f, 'PATCH', '/reels/4')[1].body.decisionComment, '', 'без решения комментарий не отправляется');
  const history = f.el.querySelector('[data-history]');
  assert.equal(history.open, false);assert.match(history.querySelector('summary').textContent, /История изменений \(2\)/);
  assert.match(history.textContent, /Редактор/);assert.match(history.textContent, /Решение: берём — Хороший дубль/);assert.match(history.textContent, /Подпись: пусто → «Первая подпись»/);
});

test('просьбы агенту: шесть кнопок, «Переделать» требует текст и берёт время из плеера, статусы и ответы — простыми словами', async () => {
  const f = fixture({respond: ({method, path: route, body}) => method === 'POST' && route.endsWith('/requests')
    ? {reel: full({requests: [...requests(), {id: 9, reelId: 4, kind: body.kind, status: 'accepted', text: body.text || '', version: body.version ?? null, startMs: body.startMs ?? null, endMs: body.endMs ?? null,
      date: body.date || '', reply: '', authorName: 'Редактор', createdAt: '2026-11-20T06:00:00Z', events: []}]}), request: {id: 9}, duplicate: false}
    : method === 'POST' && route.endsWith('/requests/3/cancel') ? full({requests: requests().map((r) => r.id === 3 ? {...r, status: 'rejected', reply: 'Отменено автором.'} : r)}) : undefined});
  await f.open();
  same([...f.el.querySelectorAll('[data-ask]')].map((n) => n.textContent), ['Переделать', 'Опубликовать', 'Перенести дату', 'Заменить текст', 'Убрать из плана', 'Написать агенту']);
  const statuses = () => [...f.el.querySelectorAll('.mt-request')].map((n) => [n.querySelector('strong').textContent, n.querySelector('.mt-request__status').textContent]);
  same(statuses(), [['Перенести дату', 'принято'], ['Опубликовать', 'ждёт решения владельца'], ['Переделать', 'готово, посмотрите']], 'новые сверху');
  assert.match(f.el.querySelector('[data-request="2"] [data-request-reply]').textContent, /Ответ: Черновик публикации №7 создан/);
  assert.match(f.el.querySelector('[data-request="1"] .mt-request__meta').textContent, /отрезок 0:01–0:03/);
  assert.match(f.el.querySelector('[data-request="3"] .mt-request__meta').textContent, /на 27\.11\.2026/);
  assert.doesNotMatch(f.el.querySelector('[data-ask-box]').textContent, /EDL|PR\b|маршрут|waiting_owner|in_progress|accepted/i, 'без технических слов');
  await f.click('[data-ask="redo"]');
  const form = f.el.querySelector('[data-ask-form]');
  assert.equal(form.hidden, false);assert.match(form.querySelector('.mt-ask__title').textContent, /Переделать · версия v2/);
  await f.submit('[data-ask-form]');
  assert.equal(sent(f, 'POST', '/requests').length, 0);assert.equal(f.el.querySelector('[data-ask-status]').textContent, 'Напишите, что нужно сделать.');
  form.elements.text.value = 'Уберите паузу';
  Object.defineProperty(f.el.querySelector('[data-player]'), 'currentTime', {value: 4.2, configurable: true});
  await f.click('[data-ask-now="from"]');
  assert.equal(form.elements.from.value, '0:04');
  await f.submit('[data-ask-form]');
  assert.equal(sent(f, 'POST', '/requests').length, 0, 'начало без конца не уходит');assert.match(f.el.querySelector('[data-ask-status]').textContent, /укажите начало и конец/);
  form.elements.to.value = '0:09';
  await f.submit('[data-ask-form]');
  const body = sent(f, 'POST', '/requests')[0].body;
  same({...body, clientRequestId: ''}, {clientRequestId: '', kind: 'redo', text: 'Уберите паузу', version: 2, startMs: 4000, endMs: 9000});
  assert.match(body.clientRequestId, /^mt-[a-z0-9]+-[a-z0-9]+$/);
  assert.match(f.el.querySelector('[data-ask-status]').textContent, /Просьба отправлена/);assert.equal(statuses()[0][0], 'Переделать');assert.equal(f.el.querySelectorAll('.mt-request').length, 4);
  await f.click('[data-ask="reschedule"]');
  await f.submit('[data-ask-form]');
  assert.equal(f.el.querySelector('[data-ask-status]').textContent, 'Выберите новую дату.');
  f.el.querySelector('[data-ask-form]').elements.date.value = '2026-11-28';
  await f.submit('[data-ask-form]');
  same({...sent(f, 'POST', '/requests')[1].body, clientRequestId: ''}, {clientRequestId: '', kind: 'reschedule', date: '2026-11-28'});
  await f.click('[data-ask="publish"]');
  assert.equal(f.el.querySelector('[data-ask-form] textarea'), null);
  await f.submit('[data-ask-form]');
  same({...sent(f, 'POST', '/requests')[2].body, clientRequestId: ''}, {clientRequestId: '', kind: 'publish', version: 2, platformIds: ['instagram', 'vk']});
  await f.click('[data-ask="message"]');await f.click('[data-ask-cancel]');
  assert.equal(f.el.querySelector('[data-ask-form]').hidden, true);
});

test('просьбы: отмена своей просьбы, обновление списка, ошибка сервера показывается словами сервера', async () => {
  let fail = true;
  const f = fixture({respond: ({method, path: route}) => {
    if (method === 'POST' && route.endsWith('/requests/3/cancel')) return full({requests: requests().map((r) => r.id === 3 ? {...r, status: 'rejected', reply: 'Отменено автором.'} : r)});
    if (method === 'POST' && route.endsWith('/requests') && fail) throw Object.assign(new Error('Просьба опубликовать эту версию уже есть. Посмотрите её статус.'), {status: 409});
    return undefined;
  }});
  await f.open();
  same([...f.el.querySelectorAll('[data-request-cancel]')].map((n) => n.dataset.requestCancel), ['3'], 'отменить можно только принятую');
  await f.click('[data-ask="publish"]');await f.submit('[data-ask-form]');
  assert.match(f.el.querySelector('[data-ask-status]').textContent, /Не удалось отправить: Просьба опубликовать эту версию уже есть/);
  assert.equal(f.el.querySelector('[data-ask-form]').hidden, false, 'форма остаётся — можно повторить');
  await f.click('[data-request-cancel="3"]');
  assert.equal(f.el.querySelector('[data-request="3"] .mt-request__status').textContent, 'отклонено');assert.equal(f.el.querySelector('[data-request-cancel]'), null);
  const before = f.calls.filter((c) => c.method === 'GET' && c.path === 'crm/autoposting/reels/4').length;
  await f.click('[data-requests-refresh]');
  assert.equal(f.calls.filter((c) => c.method === 'GET' && c.path === 'crm/autoposting/reels/4').length, before + 1);
  assert.equal(f.el.querySelector('[data-ask-status]').textContent, 'Обновлено.');
});

test('живой монтаж: переключатели отрезков, сохранение правки без перестановки, плеер не перерисовывается', async () => {
  const f = fixture({respond: ({method, path: route}) => method === 'POST' && route.endsWith('/live-edit')
    ? {reel: full({edits: [{id: 5, kind: 'edl', baseVersion: 2, status: 'pending', comment: 'Живой монтаж'}], openEdits: 1}), edit: {id: 5}, duplicate: false} : undefined});
  await f.open();
  const rows = () => [...f.el.querySelectorAll('[data-live-row]')];
  assert.match(f.el.querySelector('[data-live-box] h3').textContent, /Живой монтаж · версия v2/);
  same(rows().map((n) => n.querySelector('.mt-live__name').textContent.replace(/\s+/g, ' ').trim()), ['1 Вход 0:00–0:03', '2 0:03–0:06', '3 Финал 0:06–0:10']);
  assert.equal(f.el.querySelector('[data-live-save]').disabled, true);
  const player = f.el.querySelector('[data-player]');
  await f.click('[data-live-toggle="enabled:1"]');await f.click('[data-live-toggle="sound:2"]');
  assert.equal(f.el.querySelector('[data-player]'), player, 'плеер тот же — позиция просмотра сохраняется');
  assert.equal(rows()[1].classList.contains('is-off'), true);assert.equal(f.el.querySelector('[data-live-toggle="enabled:1"]').textContent, 'Убран');
  assert.equal(f.el.querySelector('[data-live-toggle="sound:1"]').disabled, true);assert.equal(f.el.querySelector('[data-live-toggle="sound:2"]').textContent, 'Без звука');
  assert.equal(f.el.querySelector('[data-live-save]').disabled, false);
  /* Предпросмотр на том же плеере: убранный отрезок пропускается, на отрезке без звука звук выключается и потом возвращается. */
  let time = 3.5, muted = false, paused = false;
  Object.defineProperty(player, 'currentTime', {get: () => time, set: (value) => {time = value;}, configurable: true});
  Object.defineProperty(player, 'muted', {get: () => muted, set: (value) => {muted = value;}, configurable: true});
  Object.defineProperty(player, 'paused', {get: () => paused, configurable: true});player.pause = () => {paused = true;};
  const tickPlayer = () => player.dispatchEvent(new f.w.Event('timeupdate'));
  tickPlayer();assert.equal(time, 6, 'переход к началу следующего отрезка «в ролике»');
  tickPlayer();assert.equal(muted, true);
  time = 1;tickPlayer();assert.equal(muted, false, 'на отрезке со звуком звук возвращается');
  await f.click('[data-live-toggle="enabled:2"]');
  time = 4;tickPlayer();assert.equal(paused, true, 'дальше всё убрано — остановка');
  await f.click('[data-live-toggle="enabled:0"]');await f.click('[data-live-save]');
  assert.equal(sent(f, 'POST', '/live-edit').length, 0);assert.equal(f.el.querySelector('[data-live-status]').textContent, 'Оставьте в ролике хотя бы один отрезок.');
  await f.click('[data-live-reset]');
  assert.equal(f.el.querySelector('[data-live-save]').disabled, true);assert.equal(rows().every((n) => !n.classList.contains('is-off')), true);
  await f.click('[data-live-toggle="enabled:1"]');await f.click('[data-live-save]');
  const body = sent(f, 'POST', '/live-edit')[0].body;
  assert.equal(body.baseVersion, 2);
  same(body.segments, [{startMs: 0, endMs: 3000, enabled: true, sound: true}, {startMs: 3000, endMs: 6000, enabled: false, sound: true}, {startMs: 6000, endMs: 10000, enabled: true, sound: true}]);
  assert.match(f.el.querySelector('[data-live-status]').textContent, /Правка сохранена/);assert.equal(f.el.querySelector('[data-live-save]').disabled, true, 'после сохранения переключатели сброшены');
});

test('живой монтаж: у версии без разметки экран честно говорит об этом и границ не придумывает', async () => {
  const f = fixture({reel: () => full({currentVersion: {version: 2, mediaUrl: asset('b'), durationMs: 10000}, versions: [{version: 2, mediaUrl: asset('b'), durationMs: 10000}]})});
  await f.open();
  assert.equal(f.el.querySelector('[data-live-empty]').textContent, 'Отрезки появятся после разметки ролика.');
  assert.equal(f.el.querySelector('[data-live-row]'), null);assert.equal(f.el.querySelector('[data-live-save]'), null);
});

test('только просмотр: решение, подпись, просьбы и отрезки видны, кнопок изменения нет', async () => {
  const f = fixture({permissions: ['autoposting.view'], reel: () => full({caption: 'Подпись ролика', decisionComment: 'Хороший дубль'})});
  await f.open();
  assert.equal(f.el.querySelector('[data-decision-view]').textContent, 'Берём — Хороший дубль');
  assert.equal(f.el.querySelector('[data-own-caption-view]').textContent, 'Подпись ролика');
  assert.equal(f.el.querySelectorAll('.mt-request').length, 3);assert.equal(f.el.querySelectorAll('[data-live-row]').length, 3);
  for (const selector of ['[data-review]', '[data-ask]', '[data-ask-form]', '[data-request-cancel]', '[data-live-toggle]', '[data-live-save]']) assert.equal(f.el.querySelector(selector), null, selector);
});

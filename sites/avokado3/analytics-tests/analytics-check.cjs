/* Детерминированные проверки аналитики Авокадо. Без сети, без jsdom, без записи файлов.
   Запуск:  node avokado-output/checks/analytics-check.cjs
   Печатает ОДНУ строку вердикта; при провале — список непрошедших проверок. */
'use strict';
const path = require('path');
const site = path.join(__dirname, '..');
const attribution = require(path.join(site, 'attribution.js'));
const callback = require(path.join(site, 'callback.js'));

const failures = [];
let total = 0;
function check(name, condition) {
  total += 1;
  if (!condition) failures.push(name);
}
function eq(name, actual, expected) {
  check(name + ' (получено ' + JSON.stringify(actual) + ', ожидалось ' + JSON.stringify(expected) + ')',
    JSON.stringify(actual) === JSON.stringify(expected));
}

const base = 'https://avokado38.ru/index.html';
const anchor = (href) => ({_href: href, getAttribute(name) { return name === 'href' ? this._href : null; }});
const goal = (href) => { const r = attribution.classify(href, base); return r && r.event; };

/* 1. Личный диалог против сообщества. */
eq('vk.com/lasermkt — сообщество, не мессенджер', goal('https://vk.com/lasermkt'), 'social_click');
eq('vk.me — личный диалог', goal('https://vk.me/lasermkt'), 'messenger_click');
eq('vk.com/im — личный диалог', goal('https://vk.com/im?sel=1'), 'messenger_click');
eq('vk.com/write12 — личный диалог', goal('https://vk.com/write12'), 'messenger_click');
eq('t.me/+номер — личный диалог', goal('https://t.me/+79501001059'), 'messenger_click');
eq('t.me/имя — не доказан диалог', goal('https://t.me/avokado38'), 'social_click');
eq('t.me/joinchat — приглашение в группу, не личное сообщение', goal('https://t.me/joinchat/AbCdEf'), 'social_click');
eq('t.me/+код с буквами — приглашение в группу', goal('https://t.me/+AbCdEf12345XyZ'), 'social_click');
eq('t.me/+16 цифр — не номер по E.164', goal('https://t.me/+1234567890123456'), 'social_click');
eq('wa.me/номер — личный диалог', goal('https://wa.me/79501001059'), 'messenger_click');
eq('wa.me без номера — не диалог', goal('https://wa.me/'), 'social_click');
eq('max.ru/u/... — личный диалог', goal('https://max.ru/u/f9LHodD0cOJPwmtne6DjlsTtJCf0'), 'messenger_click');
eq('max.ru без /u — не диалог', goal('https://max.ru/avokado'), 'social_click');
eq('instagram — соцсеть', goal('https://instagram.com/avokado38'), 'social_click');
eq('tg: — мессенджер', goal('tg://resolve?domain=x'), 'messenger_click');
eq('tel: — звонок', goal('tel:+79331901059'), 'phone_click');

/* 2. booking_click только фактический Yclients. */
eq('yclients — запись', goal('https://n396010.yclients.com/company/375899/personal/menu'), 'booking_click');
eq('поддомен yclients — запись', goal('https://b1.yclients.com/x'), 'booking_click');
eq('чужой хост со словом yclients в пути — НЕ запись',
  goal('https://example.com/yclients.com/company/1'), null);
eq('похожий домен yclients-booking.ru — НЕ запись', goal('https://yclients-booking.ru/a'), null);
eq('внешний сайт — ничего', goal('https://avito.ru/x'), null);

/* 3. fallback #contacts — намерение contact_choice; этап contact_view клик не даёт. */
eq('ссылка на #contacts — contact_choice', goal('#contacts'), 'contact_choice');
eq('ссылка на contacts.html — contact_choice', goal('contacts.html'), 'contact_choice');
check('клик никогда не даёт contact_view', ['#contacts', 'contacts.html', 'index.html#contacts']
  .every(href => goal(href) !== 'contact_view'));
eq('ссылка на прайс — price_click', goal('price.html'), 'price_click');
eq('«← Вернуться на сайт» со страницы прайса — не price_click',
  (attribution.classify('index.html#price', 'https://avokado38.ru/price.html?embedded=1') || {}).event, undefined);
eq('#раздел внутри прайса — не цель', attribution.classify('#laser', 'https://avokado38.ru/price.html'), null);

/* 4. Динамическая подмена ссылки (company-links.js из CRM): цель определяется
      по действующему href в момент клика, а не по исходной разметке. */
const live = anchor('https://vk.com/lasermkt');
eq('до подмены — сообщество', goal(live.getAttribute('href')), 'social_click');
live._href = 'https://wa.me/79501001059';
eq('после подмены — мессенджер', goal(live.getAttribute('href')), 'messenger_click');
live._href = 'https://n396010.yclients.com/company/375899';
eq('после второй подмены — запись', goal(live.getAttribute('href')), 'booking_click');

/* 5. Только разрешённые цели, ровно 15. */
eq('всего целей', attribution.allowedGoals.length, 15);
eq('этапов', attribution.stageGoals.slice(), ['service_view', 'price_view', 'contact_view', 'callback_open']);
check('все цели уникальны', new Set(attribution.allowedGoals).size === attribution.allowedGoals.length);
check('этапы и действия не пересекаются',
  attribution.stageGoals.every(g => !attribution.actionGoals.includes(g)));

/* 6. Вебвизор в коде выключен, пока не исправлена политика. */
eq('webvisor выключен', attribution.webvisor, false);

/* 7. Приёмник целей: этап один раз, действие каждый раз, параметры не передаются. */
function fakeWin(options) {
  const calls = [];
  const posted = [];
  const win = {
    navigator: {doNotTrack: (options && options.dnt) ? '1' : '0'},
    location: {origin: 'https://avokado38.ru', href: base},
    dataLayer: [],
    ym: function () { calls.push(Array.prototype.slice.call(arguments)); },
    parent: {postMessage: (data, origin) => posted.push({data, origin})},
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {}
  };
  return {win, calls, posted};
}
const page = fakeWin();
const tracker = attribution.createTracker(page.win, {embedded: false});
check('этап засчитан один раз', tracker.track('service_view') === true && tracker.track('service_view') === false);
check('действие засчитывается каждый раз',
  tracker.track('phone_click', {channel: 'phone'}) === true && tracker.track('phone_click', {channel: 'phone'}) === true);
check('цель вне allowlist отклонена', tracker.track('lead_created') === false);
eq('reachGoal вызван без параметров', page.calls,
  [[112772817, 'reachGoal', 'service_view'], [112772817, 'reachGoal', 'phone_click'], [112772817, 'reachGoal', 'phone_click']]);
check('ни один вызов ym не содержит 4-го аргумента', page.calls.every(c => c.length === 3));
check('в dataLayer нет полей формы',
  page.win.dataLayer.every(e => Object.keys(e).every(k => ['event', 'channel', 'entry_point'].includes(k))));

/* 8. Do Not Track — ничего не отправляется. */
const dnt = fakeWin({dnt: true});
const dntTracker = attribution.createTracker(dnt.win, {embedded: false});
check('при DNT цель не отправляется', dntTracker.track('phone_click') === false && dnt.calls.length === 0);

/* 9. Встроенный прайс: счётчик не вызывается; из этапов — только price_view,
      и он вместе с кликами уходит в родительское окно на собственный origin. */
const frame = fakeWin();
const frameTracker = attribution.createTracker(frame.win, {embedded: true});
check('service_view из iframe не засчитан', frameTracker.track('service_view') === false);
check('contact_view из iframe не засчитан', frameTracker.track('contact_view') === false);
check('callback_open из iframe не засчитан', frameTracker.track('callback_open') === false);
check('price_view из iframe принят один раз',
  frameTracker.track('price_view') === true && frameTracker.track('price_view') === false);
check('действие из iframe принято', frameTracker.track('booking_click', {channel: 'yclients'}) === true);
eq('в iframe ym не вызывался', frame.calls.length, 0);
eq('в parent отправлены price_view и клик', frame.posted.map(p => [p.data.source, p.data.goal, p.origin]),
  [['avokado-analytics', 'price_view', 'https://avokado38.ru'], ['avokado-analytics', 'booking_click', 'https://avokado38.ru']]);
check('iframe определяется по ?embedded=1', attribution.isEmbedded(
  {parent: {}, location: {search: '?embedded=1'}}, {documentElement: {classList: {contains: () => false}}}) === true);
check('верхнее окно не считается iframe', attribution.isEmbedded(
  (() => { const w = {location: {search: ''}}; w.parent = w; return w; })(),
  {documentElement: {classList: {contains: () => false}}}) === false);

/* 10. Мост из iframe: origin + source (iframe диалога прайса) + allowlist. */
const host = {location: {origin: 'https://avokado38.ru'}};
const priceFrame = {parent: host};
const otherFrame = {parent: host};
const openFrames = [{view: priceFrame, open: true}];
const closedFrames = [{view: priceFrame, open: false}];
const message = (over) => Object.assign({origin: 'https://avokado38.ru', source: priceFrame,
  data: {source: 'avokado-analytics', goal: 'booking_click'}}, over);
const bridgeGoal = (goalName) => ({source: 'avokado-analytics', goal: goalName});
eq('клик из iframe прайса принят', attribution.acceptBridgeMessage(host, message(), openFrames),
  {goal: 'booking_click', channel: ''});
eq('price_view при открытом диалоге принят',
  attribution.acceptBridgeMessage(host, message({data: bridgeGoal('price_view')}), openFrames),
  {goal: 'price_view', channel: ''});
check('price_view при закрытом диалоге отклонён',
  attribution.acceptBridgeMessage(host, message({data: bridgeGoal('price_view')}), closedFrames) === null);
check('чужой origin отклонён',
  attribution.acceptBridgeMessage(host, message({origin: 'https://evil.example'}), openFrames) === null);
check('другой дочерний кадр того же origin отклонён',
  attribution.acceptBridgeMessage(host, message({source: otherFrame}), openFrames) === null);
check('сообщение без source отклонено',
  attribution.acceptBridgeMessage(host, message({source: null}), openFrames) === null);
check('без списка кадров ничего не принимается', attribution.acceptBridgeMessage(host, message()) === null);
['service_view', 'contact_view', 'callback_open'].forEach(stageName => check(stageName + ' через мост отклонён',
  attribution.acceptBridgeMessage(host, message({data: bridgeGoal(stageName)}), openFrames) === null));
check('неизвестная цель через мост отклонена',
  attribution.acceptBridgeMessage(host, message({data: bridgeGoal('lead')}), openFrames) === null);
check('чужой формат сообщения отклонён',
  attribution.acceptBridgeMessage(host, message({data: {goal: 'booking_click'}}), openFrames) === null);

/* 11. Видимость сцены: скрытое и перекрытое не засчитывается. */
function scene(over) {
  const el = Object.assign({
    hidden: false,
    closest: () => null,
    getBoundingClientRect: () => ({top: 0, bottom: 600, width: 1000, height: 600})
  }, over);
  return el;
}
function room(over) {
  const doc = Object.assign({visibilityState: 'visible',
    documentElement: {classList: {contains: () => false}, clientHeight: 800}}, over);
  return {win: {innerHeight: 800, getComputedStyle: () => ({display: 'block', visibility: 'visible', opacity: '1'})}, doc};
}
let r = room();
check('видимая сцена засчитана', attribution.visibleEnough(r.win, r.doc, scene()) === true);
check('hidden не засчитан', attribution.visibleEnough(r.win, r.doc, scene({hidden: true})) === false);
check('за пределами окна не засчитано', attribution.visibleEnough(r.win, r.doc, scene({
  getBoundingClientRect: () => ({top: 2000, bottom: 2600, width: 1000, height: 600})})) === false);
check('нулевой размер не засчитан', attribution.visibleEnough(r.win, r.doc, scene({
  getBoundingClientRect: () => ({top: 0, bottom: 0, width: 0, height: 0})})) === false);
r = room({visibilityState: 'hidden'});
check('неактивная вкладка не засчитана', attribution.visibleEnough(r.win, r.doc, scene()) === false);
// Модальные окна и лоадер: фейковый документ с dialog[open], классами html и #page-loader.
function covered(options) {
  const o = options || {};
  const flags = new Set(o.flags || []);
  const dialogs = o.dialogs || [];
  const byId = {'page-loader': o.loader || null};
  return {
    visibilityState: 'visible',
    documentElement: {classList: {contains: name => flags.has(name)}, clientHeight: 800},
    querySelectorAll: selector => selector === 'dialog[open]' ? dialogs : [],
    querySelector: selector => (o.owners || {})[selector] || null,
    getElementById: id => byId[id] || null
  };
}
const plainWin = {innerHeight: 800, getComputedStyle: () => ({display: 'block', visibility: 'visible', opacity: '1'})};
const outside = scene();
const inside = scene();
const promo = {contains: el => el === inside};
const priceDialog = {contains: el => el === inside};
check('сцена под открытым dialog[open] (promo.showModal) не засчитана',
  attribution.visibleEnough(plainWin, covered({dialogs: [promo]}), outside) === false);
check('сцена внутри самой открытой модалки засчитана',
  attribution.visibleEnough(plainWin, covered({dialogs: [promo]}), inside) === true);
check('html.promo-open без найденного #promo закрывает всё',
  attribution.visibleEnough(plainWin, covered({flags: ['promo-open']}), inside) === false);
check('html.promo-open + #promo: снаружи не засчитано',
  attribution.visibleEnough(plainWin, covered({flags: ['promo-open'], owners: {'#promo': promo}}), outside) === false);
check('сцена под модальным прайсом не засчитана',
  attribution.visibleEnough(plainWin, covered({flags: ['av-price-open'], owners: {'.av-price-dialog': priceDialog}}), outside) === false);
check('сам диалог прайса засчитан',
  attribution.visibleEnough(plainWin, covered({flags: ['av-price-open'], owners: {'.av-price-dialog': priceDialog}}), inside) === true);
check('два открытых окна: сцена только в одном из них не засчитана',
  attribution.visibleEnough(plainWin, covered({dialogs: [promo, {contains: () => false}]}), inside) === false);
const loaderEl = (classes, display) => ({hidden: false, classList: {contains: name => classes.includes(name)}, _display: display || 'flex'});
const loaderWin = (loader, opacity) => ({innerHeight: 800, getComputedStyle: el => el === loader
  ? {display: loader._display, visibility: 'visible', opacity: opacity}
  : {display: 'block', visibility: 'visible', opacity: '1'}});
let ld = loaderEl(['is-visible']);
check('показанный лоадер закрывает сцену', attribution.visibleEnough(loaderWin(ld, '1'), covered({loader: ld}), outside) === false);
ld = loaderEl(['is-visible', 'is-complete']);
check('лоадер в фазе исчезновения не закрывает', attribution.visibleEnough(loaderWin(ld, '0'), covered({loader: ld}), outside) === true);
ld = loaderEl([], 'none');
check('скрытый display:none лоадер не закрывает', attribution.visibleEnough(loaderWin(ld, '0'), covered({loader: ld}), outside) === true);
ld = loaderEl([]);
check('прозрачный лоадер без классов не закрывает', attribution.visibleEnough(loaderWin(ld, '0'), covered({loader: ld}), outside) === true);
r = room();
check('opacity:0 не засчитан', attribution.visibleEnough(
  {innerHeight: 800, getComputedStyle: () => ({display: 'block', visibility: 'visible', opacity: '0'})},
  r.doc, scene()) === false);
check('пустая opacity не считается нулевой', attribution.visibleEnough(
  {innerHeight: 800, getComputedStyle: () => ({display: 'block', visibility: 'visible', opacity: ''})},
  r.doc, scene()) === true);
check('display:none не засчитан', attribution.visibleEnough(
  {innerHeight: 800, getComputedStyle: () => ({display: 'none', visibility: 'visible', opacity: '1'})},
  r.doc, scene()) === false);

/* 12. Этап регистрируется один раз, даже если проверка видимости прошла дважды. */
const stagePage = fakeWin();
const stageTracker = attribution.createTracker(stagePage.win, {embedded: false});
const watcherRoom = room();
const watcher = attribution.createStageWatcher(
  Object.assign({}, watcherRoom.win, {setTimeout: fn => { fn(); return 1; }, clearTimeout: () => {}}),
  watcherRoom.doc, stageTracker);
const target = scene();
watcher.register('service_view', () => target);
watcher.check(); watcher.check(); watcher.check();
eq('три прохода видимости — одна цель', stagePage.calls.length, 1);
eq('и это именно service_view', stagePage.calls[0][2], 'service_view');

/* 13. Исход отправки заявки. Заявка — только подтверждённый 201. */
function fakeSendWin(response, throwOn) {
  return {
    AbortController: function () { this.abort = () => {}; this.signal = null; },
    setTimeout: () => 1, clearTimeout: () => {},
    fetch: async () => { if (throwOn) throw new Error('network'); return response; }
  };
}
const body = {companyCode: 'avokado'};
async function outcome(response, throwOn) {
  try {
    const result = await callback.send(fakeSendWin(response, throwOn), body);
    return callback.outcomeGoal(result);
  } catch (error) {
    return callback.outcomeGoal(null, error);
  }
}
const cases = [
  ['201 + id>0 + не дубль = заявка', {status: 201, ok: true, json: async () => ({id: 42})}, false, 'callback_submit'],
  ['200 + deduplicated = дубль, не заявка', {status: 200, ok: true, json: async () => ({id: 42, deduplicated: true})}, false, 'callback_duplicate'],
  ['201 + deduplicated = не заявка, ошибка', {status: 201, ok: true, json: async () => ({id: 42, deduplicated: true})}, false, 'callback_error'],
  ['201 + id=0 = не заявка', {status: 201, ok: true, json: async () => ({id: 0})}, false, 'callback_error'],
  ['201 + нецелый id = не заявка', {status: 201, ok: true, json: async () => ({id: 1.5})}, false, 'callback_error'],
  ['201 без id = не заявка', {status: 201, ok: true, json: async () => ({})}, false, 'callback_error'],
  ['200 без признака дубля = не заявка', {status: 200, ok: true, json: async () => ({id: 42})}, false, 'callback_error'],
  ['429 = ошибка', {status: 429, ok: false, json: async () => ({})}, false, 'callback_error'],
  ['500 = ошибка', {status: 500, ok: false, json: async () => ({})}, false, 'callback_error'],
  ['обрыв сети = ошибка', null, true, 'callback_error']
];
(async () => {
  for (const [name, response, throwOn, expected] of cases) {
    eq(name, await outcome(response, throwOn), expected);
  }
    eq('outcomeGoal без результата — ошибка', callback.outcomeGoal(null), 'callback_error');
  eq('outcomeGoal с id=0 — ошибка', callback.outcomeGoal({id: 0, repeated: false}), 'callback_error');
  eq('outcomeGoal без признака repeated — ошибка', callback.outcomeGoal({id: 5}), 'callback_error');
  eq('outcomeGoal подтверждённый — заявка', callback.outcomeGoal({id: 5, repeated: false}), 'callback_submit');
  eq('outcomeGoal дубль — дубль', callback.outcomeGoal({id: 5, repeated: true}), 'callback_duplicate');
  /* 14. Отчёт в аналитику идёт только через хук и без данных формы. */
  const seen = [];
  callback.report({AvokadoAnalytics: {track: (...args) => seen.push(args)}}, 'callback_submit');
  eq('в аналитику уходит только имя цели', seen, [['callback_submit']]);
  check('без attribution.js отчёт не падает', (() => {
    try { callback.report({}, 'callback_submit'); callback.report(null, 'callback_submit'); return true; }
    catch (_) { return false; }
  })());
  check('глобальный fetch не перехватывается',
    !/window\.fetch\s*=|win\.fetch\s*=|globalThis\.fetch\s*=/.test(
      require('fs').readFileSync(path.join(site, 'callback.js'), 'utf8') +
      require('fs').readFileSync(path.join(site, 'attribution.js'), 'utf8')));

  if (failures.length) {
    console.log('ПРОВАЛ: ' + failures.length + ' из ' + total + ' проверок');
    failures.forEach(name => console.log('  — ' + name));
    process.exit(1);
  }
  console.log('OK: ' + total + '/' + total + ' проверок аналитики Авокадо пройдено');
})();

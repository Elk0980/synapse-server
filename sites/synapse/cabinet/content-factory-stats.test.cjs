'use strict';
// CF1: вкладка «Статистика» контент-завода на существующих данных. Синтетические ответы.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const settle = async () => { for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 0)); };

const CALENDAR = {timezone: 'Asia/Irkutsk', posts: [
  {id: 1, effectiveDate: '2026-10-03', calendarReadiness: {platforms: [{platform: 'telegram', state: 'published'}, {platform: 'vk', state: 'ready'}]}},
  {id: 2, effectiveDate: '2026-10-05', calendarReadiness: {platforms: [{platform: 'vk', state: 'published'}]}},
  {id: 3, effectiveDate: '2026-10-07', calendarReadiness: {platforms: [{platform: 'telegram', state: 'pending'}]}}],
undatedPosts: [{id: 4, effectiveDate: null, calendarReadiness: {platforms: [{platform: 'telegram', state: 'published'}]}}]};
const SOCIAL = {companyCode: 'one', from: '2026-10-01', to: '2026-10-31', timezone: 'Asia/Irkutsk',
  socialAggregate: {views: 1200, reach: null},
  platforms: {telegram: {label: 'Telegram', totals: {views: 700, link_clicks: 12}, lastCollectedAt: '2026-10-20T03:00:00Z'},
    vk: {label: 'ВКонтакте', totals: {views: 500}, lastCollectedAt: '2026-10-19T03:00:00Z'}},
  crm: {posts: [{platform: 'telegram', url: 'https://t.me/x/1', publishedAt: '2026-10-03T05:00:00Z', leads: 2, attribution: 'exact'},
    {platform: 'vk', url: 'https://vk.com/wall-1_2', publishedAt: '2026-10-05T05:00:00Z', leads: 0, attribution: 'none_in_period'},
    {platform: 'vk', url: 'https://vk.com/wall-1_3', publishedAt: '2026-10-06T05:00:00Z', leads: 3, attribution: 'unknown'}],
  bySource: [{source: 'site', leads: 40}]}};

function page({role = 'owner', permissions = ['autoposting.view'], calendar = async () => CALENDAR, social = async () => SOCIAL, project = 'one'} = {}) {
  const errors = [], calls = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM('<main><section id="view"></section></main>', {url: 'https://cabinet.test/cabinet.html#content-factory/stats', runScripts: 'outside-only', virtualConsole: vc, pretendToBeVisual: true});
  const w = dom.window, d = w.document, views = {};
  w.SbCabinet = {registerView(name, def) { views[name] = def; }};
  w.eval(fs.readFileSync(path.join(__dirname, 'content-factory.js'), 'utf8'));
  const crmQuery = async (p, params = {}, options = {}) => {
    calls.push({path: p, params, method: options.method || 'GET'});
    if (p === '/media-mentor/inputs') return {companyCode: params.companyCode, timezone: 'Asia/Irkutsk', profile: {revision: 0, fields: {}}};
    if (p === '/autoposting/calendar') return {companyCode: params.companyCode, ...(await calendar(params))};
    if (p === '/social-stats') return {...(await social(params)), companyCode: params.companyCode};
    throw Object.assign(new Error('Неожиданный адрес ' + p), {status: 404});
  };
  const ctx = {identity: {role, permissions}, selectedProjectId: project, crmQuery, navigate() {}};
  const node = d.getElementById('view');
  return {w, d, node, calls, errors, views, ctx, close: () => w.close(),
    render: async (next = ctx) => { views['content-factory-stats'].render(node, next); await settle(); },
    metric: (id) => node.querySelector(`[data-cf-metric="${id}"] [data-cf-value]`).textContent.trim(),
    async month(value) { const input = node.querySelector('#cf-stats-month'); input.value = value; input.dispatchEvent(new w.Event('change', {bubbles: true})); await settle(); }};
}

test('данные есть: числа из существующих источников, источник и время обновления видны', async () => {
  const f = page({permissions: ['autoposting.view', 'analytics.view'], role: 'client'}); try {
    await f.render(); await f.month('2026-10');
    assert.equal(f.metric('published'), '2', 'пары карточка×площадка со статусом «опубликовано» в месяце; без даты не считаются');
    assert.equal(f.metric('views'), '1 200');
    assert.equal(f.metric('clicks'), '12');
    assert.equal(f.metric('leads'), '2', 'только заявки, точно связанные с публикациями');
    assert.doesNotMatch(f.node.textContent, /\b40\b/, 'заявки проекта целиком не выдаются за результат контента');
    assert.match(f.node.querySelector('#cf-stats-source').textContent, /обновлено/);
    const social = f.calls.filter((c) => c.path === '/social-stats').at(-1);
    assert.deepEqual([social.params.from, social.params.to], ['2026-10-01', '2026-10-31']);
    const calendar = f.calls.filter((c) => c.path === '/autoposting/calendar').at(-1);
    assert.deepEqual([calendar.params.from, calendar.params.to], ['2026-10-01', '2026-10-31']);
    assert.ok(f.calls.every((c) => c.method === 'GET'));
    assert.match(f.node.textContent, /Просмотры не равны уникальному охвату/);
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('нет данных — слова, не нули', async () => {
  const f = page({social: async () => ({socialAggregate: {views: null}, platforms: {telegram: {totals: {}}}, crm: {posts: []}}),
    calendar: async () => ({posts: [], undatedPosts: []})}); try {
    await f.render(); await f.month('2026-10');
    assert.equal(f.metric('views'), 'Нет данных');
    assert.equal(f.metric('clicks'), 'Нет данных');
    assert.equal(f.metric('leads'), 'Нет известных публикаций');
    assert.equal(f.metric('published'), 'Нет опубликованных');
    for (const id of ['views', 'clicks', 'leads', 'published']) assert.notEqual(f.metric(id), '0');
  } finally { f.close(); }
});

test('нет права аналитики: просмотры/переходы/заявки не запрашиваются и объяснены', async () => {
  const f = page({role: 'client', permissions: ['autoposting.view']}); try {
    await f.render();
    assert.equal(f.calls.filter((c) => c.path === '/social-stats').length, 0);
    for (const id of ['views', 'clicks', 'leads']) assert.match(f.metric(id), /Нужно право «Аналитика: просмотр»/);
    assert.notEqual(f.metric('published'), 'Нужно право «Аналитика: просмотр»');
  } finally { f.close(); }
});

test('сбой источника — «Не загрузилось», не ноль; ответ прежнего месяца отбрасывается', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = page({social: async (params) => { if (params.from === '2026-09-01') { await gate; return SOCIAL; } throw Object.assign(new Error('Таймаут'), {status: 504}); }}); try {
    await f.render(); await f.month('2026-09');
    await f.month('2026-10');
    release(); await settle();
    assert.equal(f.metric('views'), 'Не загрузилось');
    assert.notEqual(f.metric('views'), '1 200', 'ответ сентября не показан в октябре');
  } finally { f.close(); }
});

test('история этапов внедрения доступна ссылкой, без отдельной вкладки', async () => {
  const f = page(); try {
    await f.render();
    assert.ok(f.node.querySelector('a[href="#content-factory/progress"]'));
  } finally { f.close(); }
});

/* ---------- CF1-R1: подписи совпадают с реальными контрактами календаря и social-stats ---------- */
test('R1: подписи периода и реестра — по фактической семантике источников', async () => {
  const august = {platform: 'telegram', url: 'https://t.me/x/0', publishedAt: '2026-08-20T05:00:00Z', leads: 1, attribution: 'exact'};
  const f = page({permissions: ['autoposting.view', 'analytics.view'], role: 'client',
    social: async () => ({...SOCIAL, crm: {...SOCIAL.crm, posts: [...SOCIAL.crm.posts, august]}})}); try {
    await f.render(); await f.month('2026-10');
    // R2: полная методика — в раскрываемом «Как считаем», а не в карточках.
    const note = (id) => f.node.querySelector(`#cf-stats-method [data-cf-method="${id}"]`).textContent;
    assert.match(note('published'), /дата карточки \(расписание или план\)/);
    assert.match(note('published'), /не фактическое время выхода/);
    assert.match(note('published'), /Asia\/Irkutsk/, 'пояс календаря из ответа');
    assert.match(note('views'), /по дням каждого аккаунта в его поясе/);
    assert.match(note('leads'), /созданные с 1 по последнее число месяца по UTC/);
    assert.match(note('leads'), /публикация могла выйти раньше/);
    const source = f.node.querySelector('#cf-stats-source').textContent;
    assert.doesNotMatch(source, /сутки в поясе проекта/, 'единого «пояса проекта» у источников нет');
    const caption = f.node.querySelector('[data-cf-posts] caption').textContent;
    assert.doesNotMatch(caption, /Публикации месяца/, 'реестр не фильтруется по месяцу');
    assert.match(note('posts'), /до 200 последних/);
    assert.match(caption, /не только за этот месяц/);
    const heads = [...f.node.querySelectorAll('[data-cf-posts] th')].map((n) => n.textContent);
    assert.ok(heads.includes('Дата выхода (UTC)'));
    assert.ok([...f.node.querySelectorAll('[data-cf-posts] td')].some((n) => n.textContent === '2026-08-20'), 'августовская публикация видна как есть, без выдачи за октябрьскую');
    assert.equal(f.metric('leads'), '3', 'заявки периода по связи с любой известной публикацией, в т.ч. августовской');
    assert.doesNotMatch(caption, /показаны 50/, 'четыре строки показаны все');
  } finally { f.close(); }
});

test('R1: публикации есть, но ни одна не связывается — не ноль, а «Связь не определяется»', async () => {
  const f = page({permissions: ['autoposting.view', 'analytics.view'], role: 'client',
    social: async () => ({...SOCIAL, crm: {posts: [{platform: 'vk', url: '', publishedAt: null, leads: 0, attribution: 'unknown'}]}})}); try {
    await f.render(); await f.month('2026-10');
    assert.equal(f.metric('leads'), 'Связь не определяется');
  } finally { f.close(); }
});

test('R1: в таблице больше 50 публикаций — подпись честно говорит, сколько показано', async () => {
  const many = Array.from({length: 120}, (_, i) => ({platform: 'telegram', url: `https://t.me/x/${i}`, publishedAt: '2026-10-03T05:00:00Z', leads: 0, attribution: 'none_in_period'}));
  const f = page({permissions: ['autoposting.view', 'analytics.view'], role: 'client', social: async () => ({...SOCIAL, crm: {posts: many}})}); try {
    await f.render(); await f.month('2026-10');
    assert.match(f.node.querySelector('[data-cf-posts] caption').textContent, /показаны 50 из 120/);
    assert.equal(f.node.querySelectorAll('[data-cf-posts] tbody tr').length, 50);
    assert.equal(f.metric('leads'), '0', 'публикации связываемы, заявок в периоде нет — это измеренный ноль');
  } finally { f.close(); }
});

/* ---------- CF1-R2: компактное представление статистики ---------- */
const SHORT = {published: 'по дате карточки, не по факту выхода', views: 'не уникальный охват', clicks: 'где площадка их отдаёт', leads: 'связанные с публикациями'};
function assertCompact(f) {
  for (const id of ['published', 'views', 'clicks', 'leads']) {
    const card = f.node.querySelector(`[data-cf-metric="${id}"]`);
    const notes = [...card.querySelectorAll('.cf-note')];
    assert.equal(notes.length, 1, `${id}: одно короткое уточнение`);
    assert.equal(notes[0].textContent.trim(), SHORT[id]);
    assert.ok(notes[0].textContent.length <= 40, `${id}: уточнение не длиннее 40 символов`);
    assert.doesNotMatch(card.textContent, /UTC|поясу|Сквозной|Пары|Сумма дневных/, `${id}: методики в карточке нет`);
  }
  const method = f.node.querySelector('details#cf-stats-method');
  assert.ok(method, '«Как считаем» есть');
  assert.equal(method.open, false, '«Как считаем» закрыто по умолчанию');
  const summary = method.querySelector('summary');
  assert.equal(summary.textContent.trim(), 'Как считаем');
  assert.ok(method.compareDocumentPosition(f.node.querySelector('.cf-metrics')) & f.w.Node.DOCUMENT_POSITION_PRECEDING, 'методика ниже показателей');
  return method;
}

test('R2: с числами — карточка = показатель, значение и короткое уточнение; методика закрыта и раскрывается', async () => {
  const f = page({permissions: ['autoposting.view', 'analytics.view'], role: 'client'}); try {
    await f.render(); await f.month('2026-10');
    assert.deepEqual(['published', 'views', 'clicks', 'leads'].map(f.metric), ['2', '1 200', '12', '2']);
    const method = assertCompact(f);
    const intro = f.node.querySelector('.content-header').textContent;
    assert.doesNotMatch(intro, /Отсутствие данных показывается словами/, 'вводное пояснение не дублирует методику');
    assert.match(f.node.querySelector('#cf-stats-source').textContent, /^Статистика соцсетей: обновлено /);
    assert.ok(f.node.querySelector('#cf-stats-source').textContent.length <= 80, 'строка свежести короткая');
    method.querySelector('summary').click();
    assert.equal(method.open, true, 'раскрывается нажатием (и клавишей — это нативный summary)');
    for (const id of ['published', 'views', 'clicks', 'leads', 'posts', 'sources']) assert.ok(method.querySelector(`[data-cf-method="${id}"]`), `методика: ${id}`);
    assert.match(method.querySelector('[data-cf-method="published"]').textContent, /Asia\/Irkutsk/);
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('R2: без данных — отсутствие и неподтверждённость видны сразу словами, методика по-прежнему закрыта', async () => {
  const f = page({permissions: ['autoposting.view', 'analytics.view'], role: 'client',
    social: async () => ({socialAggregate: {views: null}, platforms: {telegram: {totals: {}}}, crm: {posts: [{platform: 'vk', url: '', publishedAt: null, leads: 0, attribution: 'unknown'}]}}),
    calendar: async () => ({timezone: 'Asia/Irkutsk', posts: [], undatedPosts: []})}); try {
    await f.render(); await f.month('2026-10');
    assert.deepEqual(['published', 'views', 'clicks', 'leads'].map(f.metric), ['Нет опубликованных', 'Нет данных', 'Нет данных', 'Связь не определяется']);
    assertCompact(f);
    assert.match(f.node.querySelector('#cf-stats-source').textContent, /сбор не подключён или данных нет/);
    for (const id of ['views', 'clicks', 'leads', 'published']) {
      const value = f.node.querySelector(`[data-cf-metric="${id}"] [data-cf-value]`);
      assert.ok(!value.closest('details'), `${id}: значение не спрятано в раскрываемом блоке`);
    }
  } finally { f.close(); }
});

test('R2: без права аналитики и при сбое — объяснение в значении, без дублирующей строки источника', async () => {
  const f = page({role: 'client', permissions: ['autoposting.view']}); try {
    await f.render();
    assert.equal(f.node.querySelector('#cf-stats-source').textContent, '', 'значения уже говорят «Нужно право…»; строка не повторяет');
    assertCompact(f);
  } finally { f.close(); }
  const g = page({permissions: ['autoposting.view', 'analytics.view'], role: 'client', social: async () => { throw Object.assign(new Error('Таймаут'), {status: 504}); }}); try {
    await g.render(); await g.month('2026-10');
    assert.equal(g.metric('views'), 'Не загрузилось');
    assert.equal(g.node.querySelector('#cf-stats-source').textContent, '');
  } finally { g.close(); }
});

// ---------- CF6: дневной график и открытие материала по доказанному autopostingId ----------
const cell = (value, extra = {}) => ({value, kind: 'organic', completeness: 'complete', provider: 'telegram_api', ...extra});
const DAILY = {companyCode: 'one', from: '2026-09-01', to: '2026-09-30', timezone: 'Asia/Irkutsk', socialAggregate: {views: 999},
  platforms: {
    telegram: {label: 'Telegram', configured: true, activeInterval: 'Europe/Moscow', dataStatus: 'partial', totals: {views: 999, link_clicks: 77}, latest: {views: {value: 5000, date: '2026-09-30'}},
      otherIntervals: [{timezone: 'Asia/Bangkok', scope: 'profile', totals: {views: 3}, days: 1}],
      days: {'2026-09-01': {views: cell(10), link_clicks: cell(2)}, '2026-09-02': {views: cell(0)}, '2026-09-04': {views: cell(null)},
        '2026-09-05': {views: cell(7, {completeness: 'partial'})}, '2026-09-06': {views: cell(5, {kind: 'weird'})}, '2026-09-07': {views: cell(3, {completeness: 'unknown', kind: 'paid'})}}},
    vk: {label: 'ВКонтакте', configured: false, days: {}, totals: {}, dataStatus: 'no_data'},
    youtube: {label: 'YouTube', configured: true, activeInterval: 'Europe/Moscow', days: {}, totals: {}, dataStatus: 'lifetime_only', latest: {views: {value: 900}}}},
  crm: {posts: [{platform: 'telegram', url: 'https://t.me/x/1', publishedAt: '2026-09-03T05:00:00Z', leads: 1, attribution: 'exact', autopostingId: 42},
    {platform: 'telegram', url: 'https://t.me/x/2', publishedAt: '2026-09-04T05:00:00Z', leads: 0, attribution: 'exact', autopostingId: null},
    {platform: 'telegram', url: 'https://t.me/x/3', publishedAt: '2026-09-05T05:00:00Z', leads: 0, attribution: 'exact', autopostingId: '42'},
    {platform: 'telegram', url: 'https://t.me/x/4', publishedAt: '2026-09-06T05:00:00Z', leads: 0, attribution: 'exact', autopostingId: 0},
    {platform: 'telegram', url: 'https://t.me/x/5', publishedAt: '2026-09-07T05:00:00Z', leads: 0, attribution: 'exact', autopostingId: 2 ** 53, platformPostId: '9', id: 7, contentId: 'c-1'}]}};
const daily = (f) => ({note: f.node.querySelector('[data-cf-daily-note]').textContent, bars: [...f.node.querySelectorAll('[data-cf-day]')],
  state: (date) => f.node.querySelector(`[data-cf-day="${date}"]`)?.dataset.state, row: (date) => f.node.querySelector(`[data-cf-day-row="${date}"]`)?.textContent});
const pick = async (f, id, value) => { const node = f.node.querySelector(id); node.value = value; node.dispatchEvent(new f.w.Event('change', {bubbles: true})); await settle(); };

test('CF6: дневной ряд — только days активного пояса; 0 виден, пропуск/null/чужая разметка — разрыв, неполные помечены; totals/latest не подставляются', async () => {
  const f = page({social: async () => DAILY}); try {
    await f.render(); await f.month('2026-09');
    const d = daily(f);
    assert.equal(d.bars.length, 30, 'каждый день месяца — своё место');
    assert.deepEqual(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08'].map(d.state), ['complete', 'complete', 'gap', 'gap', 'partial', 'gap', 'unknown', 'gap']);
    assert.equal(f.node.querySelector('[data-cf-day="2026-09-02"]').dataset.value, '0', 'подтверждённый 0 — точка, не разрыв');
    assert.ok(f.node.querySelector('[data-cf-day="2026-09-02"]').classList.contains('cf-day-zero'));
    assert.equal(f.node.querySelector('.cf-axis-max').textContent, '10', 'максимум — по дневному ряду, не 999 и не 5000');
    assert.doesNotMatch(f.node.querySelector('[data-cf-daily]').textContent, /999|5 ?000/);
    const summary = f.node.querySelector('[data-cf-daily-summary]').textContent;
    assert.match(summary, /^Просмотры, Telegram, по дням с 01\.09 по 30\.09: дней со значением 4 из 30, без данных 26, неполных 2; максимум 10 \(01\.09\)\.$/);
    assert.equal(f.node.querySelector('.cf-chart').getAttribute('role'), 'img'); assert.equal(f.node.querySelector('.cf-chart').getAttribute('aria-label'), summary);
    assert.match(d.row('2026-09-02'), /^02\.090telegram_api$/); assert.match(d.row('2026-09-03'), /нет данных/); assert.match(d.row('2026-09-04'), /нет значения/);
    assert.match(d.row('2026-09-05'), /7 · частично/); assert.match(d.row('2026-09-06'), /разметка не распознана/); assert.match(d.row('2026-09-07'), /3 · полнота неизвестна · реклама/);
    assert.match(d.note, /Сутки — по поясу аккаунта Europe\/Moscow\. Наблюдения в другой системе суток в график не входят\./);
    assert.match(f.node.querySelector('.cf-legend').textContent, /неполные данные.*нет данных.*подтверждённый 0/);
    const fetched = f.calls.filter((c) => c.path === '/social-stats').length;
    await pick(f, '#cf-daily-metric', 'link_clicks');
    assert.equal(daily(f).bars.filter((bar) => bar.dataset.state !== 'gap').length, 1); assert.match(f.node.querySelector('[data-cf-daily-summary]').textContent, /^Переходы по ссылке, Telegram/);
    assert.equal(f.calls.filter((c) => c.path === '/social-stats').length, fetched, 'переключение графика не делает новых запросов');
    await pick(f, '#cf-daily-platform', 'vk');
    assert.equal(daily(f).bars.length, 0, 'без подключения ложного графика нет'); assert.equal(daily(f).note, 'ВКонтакте не подключена — графика нет.');
    await pick(f, '#cf-daily-platform', 'youtube');
    assert.equal(daily(f).bars.length, 0); assert.match(daily(f).note, /^Есть только накопительные значения, дневных за месяц нет — график не строится\./);
    for (const id of ['dailyPlatform', 'dailyMetric']) { const hint = f.node.querySelector(`[aria-controls="cf-hint-${id}"]`); assert.ok(hint); hint.click(); assert.match(f.d.getElementById(`cf-hint-${id}`).textContent, /Например/); assert.equal(f.d.getElementById(`cf-hint-${id}`).hidden, false); }
    assert.equal(f.node.querySelector('#cf-daily-platform').labels[0].textContent, 'Площадка');
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});
test('CF6: график без права аналитики, при сбое и при смене компании — нет ложного графика; поздний ответ прежней компании не рисуется', async () => {
  const noRight = page({role: 'client', permissions: ['autoposting.view']}); try {
    await noRight.render(); await noRight.month('2026-09');
    assert.equal(daily(noRight).bars.length, 0); assert.match(daily(noRight).note, /по праву «Аналитика: просмотр»/);
  } finally { noRight.close(); }
  const failing = page({social: async () => { throw Object.assign(new Error('boom'), {status: 500}); }}); try {
    await failing.render(); await failing.month('2026-09');
    assert.equal(daily(failing).bars.length, 0); assert.match(daily(failing).note, /не загрузилась — графика нет/);
  } finally { failing.close(); }
  let release; const late = new Promise((resolve) => { release = resolve; });
  const f = page({social: async (params) => (params.companyCode === 'one' ? (await late, DAILY) : {...DAILY, platforms: {telegram: {...DAILY.platforms.telegram, label: 'Telegram Два', days: {'2026-09-03': {views: cell(4)}}}}})}); try {
    void f.views['content-factory-stats'].render(f.node, f.ctx); await settle();
    await f.render({...f.ctx, selectedProjectId: 'two'}); await f.month('2026-09');
    release(); await settle();
    assert.match(f.node.querySelector('[data-cf-daily-summary]').textContent, /Telegram Два/); assert.equal(daily(f).state('2026-09-03'), 'complete'); assert.equal(daily(f).state('2026-09-01'), 'gap');
  } finally { f.close(); }
});
test('CF6: «Открыть материал» — только при доказанном autopostingId; внешняя ссылка отдельно; переход на Контент-план и событие с GET; смена компании не открывает', async () => {
  const f = page({social: async () => DAILY}); try {
    const navigated = [], events = []; f.ctx.navigate = (route) => navigated.push(route);
    f.w.addEventListener('sb:content-factory-open-draft', (event) => events.push(JSON.parse(JSON.stringify(event.detail))));
    await f.render(); await f.month('2026-09');
    const buttons = [...f.node.querySelectorAll('[data-cf-open-post]')];
    assert.deepEqual(buttons.map((b) => b.dataset.cfOpenPost), ['42'], 'только положительное целое; "42", 0, 2^53 и null кнопки не дают; id/platformPostId/contentId не используются');
    assert.equal(f.node.querySelectorAll('[data-cf-posts] a[href^="https://t.me/x/"]').length, 5, 'внешние ссылки на месте');
    assert.equal([...f.node.querySelectorAll('[data-cf-posts] tbody tr')].filter((tr) => /Карточка не связана/.test(tr.textContent)).length, 4);
    buttons[0].click(); await settle();
    assert.deepEqual(navigated, ['content-factory/plan']); assert.deepEqual(events, [{companyCode: 'one', postId: 42, source: 'stats'}]);
    assert.deepEqual(JSON.parse(JSON.stringify(f.w.SbCabinet.pendingMaterialOpen)), {companyCode: 'one', postId: 42, source: 'stats'});
    assert.match(f.node.querySelector('[data-cf-open-status]').textContent, /Открываем материал №42 в Контент-плане/);
    assert.ok(f.calls.every((c) => c.method === 'GET'));
    // Компания сменилась, а таблица ещё прежняя: кнопка ничего не открывает.
    f.ctx.selectedProjectId = 'two'; f.w.SbCabinet.pendingMaterialOpen = null;
    f.node.querySelector('[data-cf-open-post]').click(); await settle();
    assert.deepEqual(navigated, ['content-factory/plan'], 'нового перехода нет'); assert.equal(events.length, 1); assert.equal(f.w.SbCabinet.pendingMaterialOpen, null);
    assert.match(f.node.querySelector('[data-cf-open-status]').textContent, /выбрана другая компания/);
  } finally { f.close(); }
});

// ---------- CF19: общие фильтры статистики ----------
const CAL19 = {timezone: 'Asia/Irkutsk', posts: [
  {id: 1, effectiveDate: '2026-10-03', meta: {format: 'story', role: 'sale'}, calendarReadiness: {platforms: [{platform: 'telegram', state: 'published'}, {platform: 'vk', state: 'ready'}]}},
  {id: 2, effectiveDate: '2026-10-05', meta: {format: 'post', role: 'reach'}, calendarReadiness: {platforms: [{platform: 'vk', state: 'published'}]}},
  {id: 3, effectiveDate: '2026-10-07', meta: {format: '', role: ''}, calendarReadiness: {platforms: [{platform: 'telegram', state: 'published'}]}}], undatedPosts: []};
const SOC19 = {...SOCIAL, crm: {posts: [
  {platform: 'telegram', url: 'https://t.me/x/1', publishedAt: '2026-10-03T05:00:00Z', leads: 2, attribution: 'exact', format: 'story', ovpRole: 'sale'},
  {platform: 'vk', url: 'https://vk.com/wall-1_2', publishedAt: '2026-10-05T05:00:00Z', leads: 0, attribution: 'none_in_period', format: 'post', ovpRole: 'reach'},
  {platform: 'vk', url: 'https://vk.com/wall-1_3', publishedAt: '2026-10-06T05:00:00Z', leads: 3, attribution: 'unknown', format: null, ovpRole: null},
  {platform: 'telegram', url: 'https://t.me/x/4', publishedAt: '2026-10-08T05:00:00Z', leads: 5, attribution: 'exact', format: 'video', ovpRole: 'loyalty'}], bySource: []}};
const pickFilter = async (f, id, value) => { const node = f.node.querySelector(`#cf-${id}`); node.value = value; node.dispatchEvent(new f.w.Event('change', {bubbles: true})); await settle(); };
const filteredRows = (f) => [...f.node.querySelectorAll('[data-cf-posts] tbody tr')].map((tr) => tr.textContent.replace(/\s+/g, ' ').trim());

test('CF19: фильтры — свёрнуты, площадка/формат/ОВП, число активных и сброс; сводка и таблица по фильтрам без новых запросов; неизвестное не выводится', async () => {
  const f = page({permissions: ['autoposting.view', 'analytics.view'], calendar: async () => CAL19, social: async () => SOC19}); try {
    await f.render(); await f.month('2026-10'); // CF29-R2: месяц данных фикстуры, а не текущий
    const box = f.node.querySelector('[data-cf-filters]');
    assert.equal(box.open, false, 'фильтры свёрнуты');
    assert.equal(box.querySelector('summary').textContent, 'Фильтры');
    assert.deepEqual([...f.node.querySelectorAll('#cf-filterPlatform option')].map((o) => o.textContent), ['Все площадки', 'Telegram', 'ВКонтакте']);
    assert.ok(['filterPlatform', 'filterFormat', 'filterRole'].every((id) => f.node.querySelector(`[aria-controls="cf-hint-${id}"]`)), 'у фильтров есть «?»');
    assert.deepEqual([f.metric('published'), f.metric('views'), f.metric('clicks'), f.metric('leads')], ['3', '1 200', '12', '7']);
    const calls = f.calls.length;
    // Формат «Сторис»: календарь и публикации только с явным форматом; просмотры/переходы — без разбивки.
    await pickFilter(f, 'filterFormat', 'story');
    assert.equal(box.querySelector('summary').textContent, 'Фильтры · активно 1');
    assert.deepEqual([f.metric('published'), f.metric('views'), f.metric('clicks'), f.metric('leads')], ['1', 'Нет разбивки по формату/ОВП', 'Нет разбивки по формату/ОВП', '2']);
    assert.match(f.node.querySelector('[data-cf-daily-note]').textContent, /Нет разбивки по формату\/ОВП/);
    assert.equal(f.node.querySelector('[data-cf-daily-chart]').innerHTML, '', 'ряд аккаунта не приписан формату');
    assert.deepEqual(filteredRows(f).length, 1); assert.match(filteredRows(f)[0], /Сторис · Продажи/);
    const note = f.node.querySelector('[data-cf-filter-note]').textContent;
    assert.match(note, /Карточек месяца без указанного формата: 1/); assert.match(note, /Публикаций без известного формата: 2/, 'null и недопустимое значение — неизвестно');
    // + площадка ВКонтакте: совпадений нет — понятное пустое состояние.
    await pickFilter(f, 'filterPlatform', 'vk');
    assert.equal(box.querySelector('summary').textContent, 'Фильтры · активно 2');
    assert.deepEqual([f.metric('published'), f.metric('leads')], ['Нет совпадений', 'Нет совпадений']);
    assert.match(f.node.querySelector('[data-cf-posts-empty]').textContent, /Нет публикаций по выбранным фильтрам\. Без известного формата: 1\./);
    // Только площадка: её собственные итоги, график по ней, выбор площадки графика закрыт.
    await pickFilter(f, 'filterFormat', '');
    assert.deepEqual([f.metric('published'), f.metric('views'), f.metric('clicks'), f.metric('leads')], ['1', '500', 'Нет данных', '0']);
    assert.equal(filteredRows(f).length, 2); assert.match(filteredRows(f)[1], /формат неизвестен · ОВП неизвестна Связь не подтверждена/);
    assert.match(filteredRows(f)[0], /Пост · Охват 0 \(связь есть, заявок за месяц нет\)/, 'доказанная связь без заявок — ноль, а не «не подтверждена»');
    assert.equal(f.node.querySelector('#cf-daily-platform').disabled, true);
    assert.match(f.node.querySelector('[data-cf-filter-note]').textContent, /без подтверждённой связи с заявками показаны, но их заявки не суммируются/);
    // ОВП «Влюбление» — без совпадений; сброс из пустого состояния возвращает исходную сводку.
    await pickFilter(f, 'filterRole', 'affection');
    assert.equal(f.metric('leads'), 'Нет совпадений');
    f.node.querySelector('[data-cf-posts-empty] [data-cf-filter-reset]').click(); await settle();
    assert.deepEqual([f.metric('published'), f.metric('views'), f.metric('clicks'), f.metric('leads')], ['3', '1 200', '12', '7']);
    assert.equal(box.querySelector('summary').textContent, 'Фильтры');
    assert.ok([...f.node.querySelectorAll('[data-cf-filter]')].every((n) => n.value === ''));
    assert.equal(f.calls.length, calls, 'фильтры не делают новых запросов');
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('CF19: поля format/ovpRole ещё не приходят — всё неизвестно, заявки не приписываются; смена месяца сохраняет фильтры, поздний ответ применяет текущие, смена проекта сбрасывает', async () => {
  let release;
  const f = page({permissions: ['autoposting.view', 'analytics.view'], calendar: async () => CAL19,
    social: async (params) => { if (params.from === '2026-11-01') await new Promise((r) => { release = r; }); return SOCIAL; }}); try {
    await f.render(); await f.month('2026-10'); // CF29-R3: исходный месяц фикстуры, чтобы переход на 2026-11 был сменой месяца в любую дату
    await pickFilter(f, 'filterRole', 'sale');
    assert.equal(f.metric('leads'), 'Нет совпадений');
    assert.match(f.node.querySelector('[data-cf-filter-note]').textContent, /Публикаций без известной цели ОВП: 3/);
    // Смена месяца: пока ответ не пришёл, фильтр меняют ещё раз — применяется текущий.
    const input = f.node.querySelector('#cf-stats-month'); input.value = '2026-11'; input.dispatchEvent(new f.w.Event('change', {bubbles: true})); await settle();
    await pickFilter(f, 'filterFormat', 'post');
    release(); await settle();
    assert.equal(f.node.querySelector('#cf-filterRole').value, 'sale'); assert.equal(f.node.querySelector('#cf-filterFormat').value, 'post');
    assert.equal(f.node.querySelector('[data-cf-filters] summary').textContent, 'Фильтры · активно 2');
    assert.equal(f.metric('views'), 'Нет разбивки по формату/ОВП');
    await f.render({...f.ctx, selectedProjectId: 'two'});
    assert.ok([...f.node.querySelectorAll('[data-cf-filter]')].every((n) => n.value === ''), 'новый проект — без фильтров');
    assert.equal(f.node.querySelector('[data-cf-filters] summary').textContent, 'Фильтры');
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

// ---------- CF19-R1: календарная youtube_shorts и статистика youtube — одна площадка фильтра ----------
test('CF19-R1: youtube_shorts календаря и youtube статистики — один пункт YouTube; «Опубликовано», итоги и заявки сходятся; DTO не меняются', async () => {
  const calendar = {timezone: 'UTC', posts: [
    {id: 1, effectiveDate: '2026-10-03', meta: {format: 'reel', role: 'reach'}, calendarReadiness: {platforms: [{platform: 'youtube_shorts', state: 'published'}, {platform: 'telegram', state: 'published'}]}},
    {id: 2, effectiveDate: '2026-10-04', meta: {format: 'post', role: 'sale'}, calendarReadiness: {platforms: [{platform: 'rutube', state: 'published'}]}}], undatedPosts: []};
  const social = {platforms: {youtube: {label: 'YouTube', totals: {views: 12}}, telegram: {label: 'Telegram', totals: {views: 700, link_clicks: 3}}},
    crm: {posts: [{platform: 'youtube', url: 'https://youtube.com/shorts/demo123', leads: 1, attribution: 'exact', format: 'reel', ovpRole: 'reach'},
      {platform: 'telegram', url: 'https://t.me/x/9', leads: 4, attribution: 'exact', format: 'post', ovpRole: 'sale'}]}};
  const calCopy = JSON.parse(JSON.stringify(calendar)), socCopy = JSON.parse(JSON.stringify(social));
  const f = page({permissions: ['autoposting.view', 'analytics.view'], calendar: async () => calendar, social: async () => social}); try {
    await f.render(); await f.month('2026-10');
    const options = [...f.node.querySelectorAll('#cf-filterPlatform option')].map((o) => [o.value, o.textContent]);
    assert.deepEqual(options, [['', 'Все площадки'], ['youtube', 'YouTube'], ['telegram', 'Telegram'], ['rutube', 'rutube']], 'один пункт YouTube; прочие площадки — отдельно и без угаданных псевдонимов');
    assert.equal(f.metric('published'), '3');
    await pickFilter(f, 'filterPlatform', 'youtube');
    assert.deepEqual([f.metric('published'), f.metric('views'), f.metric('leads')], ['1', '12', '1'], 'выход youtube_shorts, итоги и заявки аккаунта youtube');
    assert.equal(f.node.querySelector('#cf-daily-platform').value, 'youtube', 'дневной ряд — аккаунта youtube');
    assert.equal(filteredRows(f).length, 1);
    await pickFilter(f, 'filterFormat', 'reel');
    assert.deepEqual([f.metric('published'), f.metric('leads')], ['1', '1'], 'вместе с форматом');
    await pickFilter(f, 'filterFormat', '');
    await pickFilter(f, 'filterPlatform', 'telegram');
    assert.deepEqual([f.metric('published'), f.metric('views'), f.metric('leads')], ['1', '700', '4'], 'Telegram не смешан с YouTube');
    await pickFilter(f, 'filterPlatform', 'rutube');
    assert.deepEqual([f.metric('published'), f.metric('views')], ['1', 'Нет данных'], 'незнакомая площадка — сама по себе, статистики нет');
    assert.deepEqual(calendar, calCopy, 'календарь не изменён');
    assert.deepEqual(social, socCopy, 'ответ статистики не изменён');
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

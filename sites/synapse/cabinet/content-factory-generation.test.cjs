'use strict';
// CF2 (клиент): составление плана сервером — состояния, вопросы, предложения, черновики. Синтетический сервер в памяти
// по контракту, сверенному с Codex 01.10.2026. Реальных API, моделей и публикаций нет.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const fail = (status, message, code) => Object.assign(new Error(message), {status, ...(code ? {code} : {})});

const proposal = (n, extra = {}) => ({ideaId: `idea-${n}`, date: `2026-10-${String(1 + (n % 5)).padStart(2, '0')}`, platform: n % 2 ? 'telegram' : 'vk',
  format: 'post', role: 'reach', topic: `Тема ${n}`, hook: `Хук ${n}`, text: `Черновик ${n}`, mentorNote: '', assetId: '', basis: ['priority:Фотозона'], warnings: [], ...extra});
const job = (extra = {}) => ({id: 'job-1', companyCode: 'one', month: '2026-10', status: 'queued', attempts: 0, maxAttempts: 3, createdAt: '2026-10-01T05:00:00Z',
  updatedAt: '2026-10-01T05:00:00Z', startedAt: null, finishedAt: null, inputs: {briefRevision: 3, profileRevision: 1, monthRevision: 2}, executor: null,
  coverage: {requested: 58, proposed: 0}, questions: [], proposals: [], errorCode: null, errorMessage: null, retryable: false, ...extra});

function server({jobs = [], post, drafts, list} = {}) {
  const calls = [], state = {jobs: [...jobs]};
  async function crmQuery(p, params = {}, options = {}) {
    const method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : undefined, code = params.companyCode;
    calls.push({path: p, method, code, params, body});
    if (p === '/media-mentor') return {companyCode: code, brief: {revision: 3, fields: {product: 'Шары под ключ', audience: 'Родители', pains: ['Нет времени']}},
      vocabulary: {formats: [{id: 'post', label: 'Пост'}], roles: [{id: 'reach', label: 'Охватный'}]}};
    if (p === '/media-mentor/inputs') return {companyCode: code, timezone: 'Asia/Irkutsk', profile: {revision: 1, fields: {genders: ['women'], ageFrom: null, ageTo: null}},
      vocabulary: {platforms: [{id: 'telegram', label: 'Telegram'}, {id: 'vk', label: 'ВКонтакте'}]}};
    const month = /^\/media-mentor\/inputs\/months\/(\d{4}-\d{2})$/.exec(p)?.[1];
    if (month) return {companyCode: code, month, revision: 2, publicationCount: 58, inputs: {}};
    if (p === '/media-mentor/generation' && method === 'GET') {
      if (list) return list(params, state);
      return {companyCode: code, jobs: state.jobs.filter((item) => item.month === params.month)};
    }
    if (p === '/media-mentor/generation' && method === 'POST') {
      if (post) return post(body, state, code);
      const created = job({id: `job-${state.jobs.length + 1}`, createdAt: `2026-10-01T06:0${state.jobs.length}:00Z`});
      state.jobs.unshift(created);
      return {companyCode: code, job: created};
    }
    const draftsMatch = /^\/media-mentor\/generation\/([^/]+)\/drafts$/.exec(p);
    if (draftsMatch && method === 'POST') {
      if (drafts) return drafts(body, draftsMatch[1], code);
      return {companyCode: code, jobId: decodeURIComponent(draftsMatch[1]), drafts: body.proposalIds.map((id, i) => ({proposalId: id, postId: 100 + i})), createdCount: body.proposalIds.length};
    }
    throw fail(404, 'Неожиданный адрес ' + p);
  }
  return {calls, state, crmQuery};
}

function page({srv = server(), role = 'owner', permissions = [], project = 'one'} = {}) {
  const errors = [], timers = [], events = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM(`<div id="content-factory-plan-bar"><button data-factory-action="compose">Составить план</button>
    <span data-factory-bar-status></span><section id="content-factory-compose" hidden></section></div>`,
  {url: 'https://cabinet.test/cabinet.html#content-factory/plan', runScripts: 'outside-only', virtualConsole: vc, pretendToBeVisual: true});
  const w = dom.window, d = w.document;
  w.SbCabinet = {registerView() {}};
  w.eval(fs.readFileSync(path.join(__dirname, 'content-factory.js'), 'utf8'));
  // Опрос управляется тестом: таймеры записываются, а не срабатывают сами.
  w.setTimeout = (fn, ms) => { timers.push({fn, ms}); return timers.length; };
  w.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; };
  for (const name of ['sb:content-factory-drafts', 'sb:content-factory-open-draft']) w.addEventListener(name, (event) => events.push([name, JSON.parse(JSON.stringify(event.detail))]));
  const ctx = {identity: {role, permissions, csrfToken: 'qa'}, selectedProjectId: project, crmQuery: srv.crmQuery,
    csrfOptions: (method, body) => ({method, headers: {'X-CSRF-Token': 'qa'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}), navigate() {}};
  const bar = d.getElementById('content-factory-plan-bar'), panel = d.getElementById('content-factory-compose');
  w.SbCabinet.contentFactory.bindPlanBar(bar, ctx);
  const f = {w, d, srv, ctx, bar, panel, errors, timers, events, close: () => w.close(),
    q: (s) => panel.querySelector(s), qa: (s) => [...panel.querySelectorAll(s)],
    posts: () => srv.calls.filter((c) => c.method === 'POST'),
    pending: () => timers.filter((t) => !t.cleared && !t.done),
    async open() { bar.querySelector('[data-factory-action="compose"]').click(); await settle(); await f.month('2026-10'); },
    async month(value) { const input = panel.querySelector('#cf-gen-month'); input.value = value; input.dispatchEvent(new w.Event('change', {bubbles: true})); await settle(); },
    async tick() { const timer = f.pending().at(-1); assert.ok(timer, 'есть запланированный опрос'); timer.done = true; timer.fn(); await settle(); return timer.ms; },
    async click(selector) { panel.querySelector(selector).click(); await settle(); },
    status: () => f.q('[data-cf-gen-status]')?.dataset.cfGenStatus, text: () => panel.textContent};
  return f;
}

test('открытие сводки только читает; запуск — явной кнопкой, один POST с ключом и месяцем; кнопка заблокирована на время запроса', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const srv = server();
  const slow = {...srv, crmQuery: async (p, params, options = {}) => { if (options.method === 'POST') await gate; return srv.crmQuery(p, params, options); }};
  const f = page({srv: slow}); try {
    await f.open();
    assert.equal(f.panel.hidden, false);
    assert.deepEqual(f.posts(), [], 'открытие ничего не запускает');
    assert.ok(srv.calls.some((c) => c.path === '/media-mentor/generation' && c.method === 'GET' && c.params.month === '2026-10'));
    assert.match(f.text(), /План на октябрь 2026 ещё не составлялся/);
    const start = f.q('[data-cf-gen="start"]');
    assert.match(start.textContent, /Составить план на октябрь 2026/);
    start.click(); start.click(); await settle();
    assert.equal(start.disabled, true, 'заблокирована до ответа');
    start.disabled = false; start.click(); await settle(); // даже если кнопку разблокировали извне, второй запрос не уходит
    release(); await settle();
    const posts = f.posts();
    assert.equal(posts.length, 1, 'двойное нажатие — один запрос');
    assert.equal(posts[0].path, '/media-mentor/generation');
    assert.deepEqual(Object.keys(posts[0].body).sort(), ['clientRequestId', 'month']);
    assert.equal(posts[0].body.month, '2026-10');
    assert.ok(posts[0].body.clientRequestId.length >= 8);
    assert.equal(f.status(), 'queued');
    assert.match(f.text(), /В очереди на сервере/);
    assert.equal(f.q('[data-cf-gen="start"]').disabled, true, 'активная задача — второй запуск недоступен');
    assert.match(f.text(), /Ничего не согласуется, не планируется и не публикуется автоматически/);
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('опрос: 3 с, затем реже до 15 с; на конечном статусе останавливается; время и модель не обещаются до ответа', async () => {
  const srv = server();
  const f = page({srv}); try {
    await f.open();
    await f.click('[data-cf-gen="start"]');
    assert.doesNotMatch(f.text(), /Модель:|минут|секунд/, 'до ответа сервера ни модели, ни сроков');
    const delays = [];
    srv.state.jobs[0] = {...srv.state.jobs[0], status: 'running', attempts: 1, executor: {kind: 'api', model: 'synthetic-model'}, startedAt: '2026-10-01T06:01:00Z'};
    delays.push(await f.tick());
    assert.equal(f.status(), 'running');
    assert.match(f.text(), /Попытка 1 из 3/);
    assert.match(f.text(), /Модель: synthetic-model/);
    delays.push(await f.tick());
    delays.push(await f.tick());
    for (let i = 0; i < 4; i++) delays.push(await f.tick());
    assert.deepEqual(delays, [3000, 6000, 9000, 12000, 15000, 15000, 15000]);
    srv.state.jobs[0] = {...srv.state.jobs[0], status: 'succeeded', proposals: [proposal(1)], coverage: {requested: 58, proposed: 1}};
    await f.tick();
    assert.equal(f.status(), 'succeeded');
    assert.equal(f.pending().length, 0, 'конечный статус — опрос остановлен');
    assert.match(f.text(), /Предложено 1 из 58/);
  } finally { f.close(); }
});

test('failed: причина от сервера, без автоматического повтора; «Составить план» вручную — новый ключ', async () => {
  const srv = server({jobs: [job({status: 'failed', attempts: 3, errorCode: 'PROVIDER_UNAVAILABLE', errorMessage: 'Модель временно недоступна.', retryable: true})]});
  const f = page({srv}); try {
    await f.open();
    assert.equal(f.status(), 'failed');
    assert.match(f.text(), /Модель временно недоступна/);
    assert.match(f.text(), /Автоматически повтор не запускается/);
    assert.equal(f.pending().length, 0);
    assert.deepEqual(f.posts(), [], 'никакого автоматического POST');
    await f.click('[data-cf-gen="start"]');
    await f.click('[data-cf-gen="start"]').catch(() => {});
    assert.equal(f.posts().length, 1);
  } finally { f.close(); }
  const g = page({srv: server({jobs: [job({status: 'failed', errorCode: 'BUDGET_EXCEEDED', errorMessage: 'Бюджет исчерпан.', retryable: false})]})}); try {
    await g.open();
    assert.match(g.text(), /Повтор этой задачи сервер не предлагает/);
    assert.doesNotMatch(g.text(), /PROVIDER|BUDGET_EXCEEDED/, 'код не показывается вместо понятной причины');
  } finally { g.close(); }
});

test('ответ на запуск потерян: «Отправить ещё раз» шлёт тот же ключ; новое нажатие — новый ключ', async () => {
  let attempt = 0;
  const srv = server({post: (body, state, code) => {
    attempt += 1;
    if (attempt === 1) throw fail(504, 'Таймаут');
    const created = job(); state.jobs = [created]; return {companyCode: code, job: created};
  }});
  const f = page({srv}); try {
    await f.open();
    await f.click('[data-cf-gen="start"]');
    const resend = f.q('[data-cf-gen="resend"]');
    assert.equal(resend.hidden, false);
    assert.match(f.q('[data-cf-gen-state]').textContent, /Задача могла быть принята/);
    await f.click('[data-cf-gen="resend"]');
    const [first, second] = f.posts();
    assert.equal(second.body.clientRequestId, first.body.clientRequestId, 'повтор того же нажатия — тот же ключ');
    assert.equal(f.status(), 'queued');
    assert.equal(f.q('[data-cf-gen="resend"]').hidden, true);
  } finally { f.close(); }
});

test('409: GENERATION_ACTIVE и REQUEST_CONFLICT объясняются; состояние перечитывается', async () => {
  for (const [code, pattern] of [['GENERATION_ACTIVE', /уже идёт составление/], ['REQUEST_CONFLICT', /Вводные изменились после первой отправки/]]) {
    const srv = server({post: () => { throw fail(409, 'Конфликт', code); }});
    const f = page({srv}); try {
      await f.open();
      const before = srv.calls.filter((c) => c.path === '/media-mentor/generation' && c.method === 'GET').length;
      await f.click('[data-cf-gen="start"]');
      assert.match(f.q('[data-cf-gen-state]').textContent, pattern);
      assert.ok(srv.calls.filter((c) => c.path === '/media-mentor/generation' && c.method === 'GET').length > before, 'список перечитан');
      assert.equal(f.q('[data-cf-gen="resend"]').hidden, true);
    } finally { f.close(); }
  }
});

test('маршрут не подключён: честно «не подключено», запуск недоступен, ничего не выдумывается', async () => {
  const srv = server({list: () => { throw fail(404, 'Not found'); }});
  const f = page({srv}); try {
    await f.open();
    assert.match(f.text(), /Составление плана на сервере пока не подключено. Ничего не запущено и не создано/);
    assert.equal(f.q('[data-cf-gen="start"]').disabled, true);
    assert.equal(f.qa('[data-cf-proposal]').length, 0);
  } finally { f.close(); }
  const g = page({srv: server({post: () => { throw fail(501, 'Not implemented'); }})}); try {
    await g.open();
    await g.click('[data-cf-gen="start"]');
    assert.match(g.q('[data-cf-gen-state]').textContent, /пока не подключено. Ничего не запущено/);
    assert.equal(g.qa('[data-cf-proposal]').length, 0);
  } finally { g.close(); }
});

test('needs_input: вопросы с указанием поля, ссылка в настройки, новый запуск разрешён', async () => {
  const srv = server({jobs: [job({status: 'needs_input', questions: [
    {id: 'q1', target: 'brief.audience', text: 'Кто принимает решение о покупке?', required: true},
    {id: 'q2', target: 'month.platforms', text: 'На каких площадках выходить в октябре?', required: false}]})]});
  const f = page({srv}); try {
    await f.open();
    assert.equal(f.status(), 'needs_input');
    assert.match(f.text(), /Кто принимает решение о покупке\? \(обязательно\)/);
    assert.match(f.text(), /«О бизнесе и покупателях»/);
    assert.match(f.text(), /«Пожелания на месяц»/);
    assert.ok(f.q('[data-cf-gen-job] a[href="#content-factory/settings"]'));
    assert.equal(f.q('[data-cf-gen="start"]').disabled, false, 'needs_input конечный — новый запуск после правки');
    assert.equal(f.pending().length, 0);
  } finally { f.close(); }
});

test('CF3: вопрос о часовом поясе ведёт к существующей настройке компании («Актуальность»), не в «Настройки модуля»', async () => {
  for (const target of ['profile.timezone', 'timezone', 'company.timezone']) {
    const srv = server({jobs: [job({status: 'needs_input', questions: [{id: 'timezone', target, text: 'Укажите часовой пояс в настройках компании.', required: true}]})]});
    const f = page({srv}); try {
      await f.open();
      const link = f.q(`[data-cf-question-target="${target}"]`);
      assert.ok(link, target);
      assert.equal(link.getAttribute('href'), '#company-information');
      assert.match(link.textContent, /Актуальность → «Часовой пояс»/);
      assert.doesNotMatch(f.q('[data-cf-gen-job]').textContent, /О бизнесе и покупателях/);
      assert.equal(f.q('[data-cf-gen-job] a[href="#content-factory/settings"]'), null, 'единственный вопрос — о компании, ссылка в модуль не нужна');
      assert.equal(f.pending().length, 0);
    } finally { f.close(); }
  }
  // Смешанные вопросы: у каждого своя ссылка.
  const srv = server({jobs: [job({status: 'needs_input', questions: [
    {id: 'timezone', target: 'profile.timezone', text: 'Укажите часовой пояс.', required: true},
    {id: 'product', target: 'brief.product', text: 'Какой продукт?', required: true}]})]});
  const f = page({srv}); try {
    await f.open();
    assert.equal(f.q('[data-cf-question-target="profile.timezone"]').getAttribute('href'), '#company-information');
    assert.equal(f.q('[data-cf-question-target="brief.product"]').getAttribute('href'), '#content-factory/settings');
  } finally { f.close(); }
});
test('CF3-R1: цель ОВП в предложениях подписана так же, как на доске («ОВП: Охват»), а не служебным словарём', async () => {
  const f = page({srv: server({jobs: [job({status: 'succeeded', proposals: [proposal(1), proposal(2, {role: 'sale'}), proposal(3, {role: 'unknown_role'})], coverage: {requested: 3, proposed: 3}})]})}); try {
    await f.open();
    for (const node of f.qa('[data-cf-gen-day]')) node.open = true;
    const lines = f.qa('[data-cf-proposal] .cf-note').map((node) => node.textContent).filter((text) => /ОВП:/.test(text));
    assert.ok(lines.some((text) => /ОВП: Охват$/.test(text)), lines.join(' | '));
    assert.ok(lines.some((text) => /ОВП: Продажи$/.test(text)));
    assert.ok(lines.some((text) => /ОВП: unknown_role$/.test(text)), 'неизвестная цель показана как есть, без выдумки');
    assert.ok(!lines.some((text) => /Охватный/.test(text)));
  } finally { f.close(); }
});
test('исполнитель: test — помечен как QA; null — ничего не обещается; неизвестный статус показан как есть', async () => {
  const f = page({srv: server({jobs: [job({status: 'succeeded', executor: {kind: 'test', model: null}, proposals: [proposal(1)], coverage: {requested: null, proposed: 1}})]})}); try {
    await f.open();
    assert.match(f.text(), /Тестовый исполнитель \(QA\): это проверка цепочки, не результат модели/);
    assert.match(f.text(), /Предложено 1\./);
  } finally { f.close(); }
  const g = page({srv: server({jobs: [job({status: 'paused'})]})}); try {
    await g.open();
    assert.match(g.text(), /Состояние задачи неизвестно: paused/);
  } finally { g.close(); }
});

test('предложения: дни свёрнуты, фильтр площадок, больше 93 строк без обрезки; правка внутри задачи невозможна', async () => {
  const many = Array.from({length: 120}, (_, i) => proposal(i + 1));
  const f = page({srv: server({jobs: [job({status: 'succeeded', proposals: many, coverage: {requested: 120, proposed: 120}})]})}); try {
    await f.open();
    const days = f.qa('[data-cf-gen-day]');
    assert.equal(days.length, 5);
    assert.ok(days.every((node) => !node.open), 'дни свёрнуты по умолчанию');
    assert.equal(f.qa('[data-cf-proposal]').length, 120, 'все 120 строк, без фиксированного предела 93');
    assert.match(f.text(), /Показано 120 из 120/);
    days[0].open = true;
    f.q('[data-cf-gen-platform="vk"]').click(); await settle();
    assert.equal(f.qa('[data-cf-proposal]').length, 60);
    assert.match(f.text(), /Показано 60 из 120/);
    assert.equal(f.q('[data-cf-gen-day]').open, true, 'раскрытый день остаётся раскрытым после фильтра');
    assert.equal(f.qa('[data-cf-proposal] textarea, [data-cf-proposal] input[type="text"], [data-cf-proposal] [contenteditable]').length, 0, 'несохраняемых правок нет');
  } finally { f.close(); }
});

test('черновики: выбор видимых, POST с ideaId, отметка №, событие для «Материалов»; повтор не задваивает выбор', async () => {
  const srv = server({jobs: [job({status: 'succeeded', proposals: [proposal(1), proposal(2), proposal(3)], coverage: {requested: 3, proposed: 3}})]});
  const f = page({srv}); try {
    await f.open();
    f.q('[data-cf-gen-platform="vk"]').click(); await settle();
    await f.click('[data-cf-gen="select-visible"]');
    assert.match(f.q('[data-cf-gen="drafts"]').textContent, /Создать черновики \(2\)/);
    await f.click('[data-cf-gen="drafts"]');
    const post = f.posts().at(-1);
    assert.equal(post.path, '/media-mentor/generation/job-1/drafts');
    assert.deepEqual(post.body, {proposalIds: ['idea-1', 'idea-3']});
    assert.match(f.text(), /Создано черновиков: 2\. Это действие ничего не согласует и не ставит в расписание/);
    f.q('[data-cf-gen-platform="vk"]').click(); await settle();
    for (const node of f.qa('[data-cf-gen-day]')) node.open = true;
    assert.match(f.q('[data-cf-proposal="idea-1"]').textContent, /Черновик №100 создан/);
    assert.equal(f.q('[data-cf-gen-select="idea-1"]'), null, 'уже созданный не выбирается повторно');
    assert.deepEqual(f.events, [['sb:content-factory-drafts', {companyCode: 'one'}]]);
    f.q('[data-cf-gen-open="101"]').click(); await settle();
    assert.deepEqual(f.events.at(-1), ['sb:content-factory-open-draft', {companyCode: 'one', postId: 101}]);
    await f.click('[data-cf-gen="select-visible"]');
    await f.click('[data-cf-gen="drafts"]');
    assert.deepEqual(f.posts().at(-1).body, {proposalIds: ['idea-2']});
    assert.ok(f.posts().every((c) => !/approve|schedule|plan/.test(c.path)), 'ни согласования, ни расписания, ни замены плана');
  } finally { f.close(); }
});

test('черновики: маршрут не подключён или сбой — честно, ничего не отмечено созданным; ответ чужой задачи отбрасывается', async () => {
  for (const [drafts, pattern] of [[() => { throw fail(404, 'Not found'); }, /Перенос в черновики на сервере пока не подключён. Черновики не созданы/],
    [() => { throw fail(500, 'Ошибка сервера'); }, /Ответ сервера не получен \(Ошибка сервера\)\. Черновики могли быть созданы/],
    [() => { throw fail(422, 'Предложение не найдено'); }, /Сервер отклонил запрос: Предложение не найдено\. Черновики по этому запросу не созданы/],
    [(body, id, code) => ({companyCode: code, jobId: 'job-other', drafts: [{proposalId: 'idea-1', postId: 7}], createdCount: 1}), /не подходит к этой задаче/]]) {
    const f = page({srv: server({jobs: [job({status: 'succeeded', proposals: [proposal(1)]})], drafts})}); try {
      await f.open();
      await f.click('[data-cf-gen="select-visible"]');
      await f.click('[data-cf-gen="drafts"]');
      assert.match(f.text(), pattern);
      assert.doesNotMatch(f.text(), /Черновик №/);
      assert.deepEqual(f.events, []);
      assert.match(f.q('[data-cf-gen="drafts"]').textContent, /\(1\)/, 'выбор сохранён для повтора');
    } finally { f.close(); }
  }
});

test('вводные изменились после составления — предупреждение', async () => {
  const f = page({srv: server({jobs: [job({status: 'succeeded', inputs: {briefRevision: 2, profileRevision: 1, monthRevision: 2}, proposals: [proposal(1)]})]})}); try {
    await f.open();
    assert.match(f.text(), /Вводные изменились после составления/);
  } finally { f.close(); }
});

test('выбирается последняя задача месяца; ответ другой компании не показывается', async () => {
  const f = page({srv: server({jobs: [job({id: 'old', status: 'failed', createdAt: '2026-10-01T04:00:00Z', errorMessage: 'Старая ошибка'}),
    job({id: 'new', status: 'needs_input', createdAt: '2026-10-01T05:30:00Z', questions: [{id: 'q', target: 'brief.product', text: 'Уточните продукт', required: true}]})]})}); try {
    await f.open();
    assert.equal(f.status(), 'needs_input');
    assert.doesNotMatch(f.text(), /Старая ошибка/);
  } finally { f.close(); }
  const g = page({srv: server({list: (params) => ({companyCode: 'two', jobs: [job({status: 'succeeded', proposals: [proposal(1)]})]})})}); try {
    await g.open();
    assert.equal(g.qa('[data-cf-proposal]').length, 0);
    assert.match(g.text(), /Не удалось получить состояние/);
  } finally { g.close(); }
});

test('смена компании закрывает сводку, останавливает опрос; поздний ответ прежней компании не рисуется', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const srv = server({jobs: [job({status: 'running', attempts: 1})]});
  let slow = false;
  const f = page({srv: {...srv, crmQuery: async (p, params, options) => { if (slow && p === '/media-mentor/generation') await gate; return srv.crmQuery(p, params, options); }}}); try {
    await f.open();
    assert.equal(f.status(), 'running');
    slow = true;
    const tick = f.tick();
    f.w.SbCabinet.contentFactory.bindPlanBar(f.bar, {...f.ctx, selectedProjectId: 'two'});
    assert.equal(f.panel.hidden, true);
    srv.state.jobs[0] = {...srv.state.jobs[0], status: 'succeeded', proposals: [proposal(1)]};
    release(); await tick; await settle();
    assert.equal(f.panel.innerHTML, '', 'ответ прежней компании не нарисован');
    assert.equal(f.pending().length, 0, 'опрос остановлен');
  } finally { f.close(); }
});

test('только просмотр: состояние и предложения видны, запуска и выбора нет', async () => {
  const f = page({role: 'client', permissions: ['autoposting.view'], srv: server({jobs: [job({status: 'succeeded', proposals: [proposal(1)]})]})}); try {
    await f.open();
    assert.equal(f.q('[data-cf-gen="start"]'), null);
    assert.match(f.text(), /Запуск доступен с правом «Автопостинг: правка»/);
    assert.equal(f.qa('[data-cf-gen-select]').length, 0);
    assert.equal(f.q('[data-cf-gen="drafts"]'), null);
    assert.equal(f.qa('[data-cf-proposal]').length, 1);
  } finally { f.close(); }
});

/* ---------- CF2-UI-R1 ---------- */
test('R1: сервер сохранил черновики, ответ потерялся — результат неизвестен, повтор возвращает те же postId', async () => {
  const stored = new Map();
  let lose = true;
  const srv = server({jobs: [job({status: 'succeeded', proposals: [proposal(1), proposal(2)]})], drafts: (body, id, code) => {
    let created = 0;
    for (const proposalId of body.proposalIds) if (!stored.has(proposalId)) { stored.set(proposalId, 500 + stored.size); created += 1; }
    if (lose) { lose = false; throw fail(504, 'Таймаут ответа'); } // запись сделана, ответ до клиента не дошёл
    return {companyCode: code, jobId: id, drafts: body.proposalIds.map((proposalId) => ({proposalId, postId: stored.get(proposalId)})), createdCount: created};
  }});
  const f = page({srv}); try {
    await f.open();
    await f.click('[data-cf-gen="select-visible"]');
    await f.click('[data-cf-gen="drafts"]');
    const text = f.q('[data-cf-gen-draft-state]').textContent;
    assert.match(text, /Ответ сервера не получен \(Таймаут ответа\)\. Черновики могли быть созданы/);
    assert.doesNotMatch(text, /не созданы/, 'отсутствие записи не утверждается');
    assert.doesNotMatch(f.text(), /Черновик №/, 'неподтверждённые черновики не отмечены');
    assert.equal(stored.size, 2, 'на сервере записи уже есть');
    assert.match(f.q('[data-cf-gen="drafts"]').textContent, /\(2\)/, 'выбор сохранён для повтора');
    await f.click('[data-cf-gen="drafts"]');
    const posts = f.posts().filter((c) => c.path.endsWith('/drafts'));
    assert.deepEqual(posts.map((c) => c.body), [{proposalIds: ['idea-1', 'idea-2']}, {proposalIds: ['idea-1', 'idea-2']}]);
    assert.match(f.q('[data-cf-gen-draft-state]').textContent, /Создано черновиков: 0\. Уже были созданы раньше: 2/);
    assert.doesNotMatch(f.q('[data-cf-gen-draft-state]').textContent, /не согласовано|не запланировано/, 'про уже существующие черновики их состояние не утверждается');
    for (const node of f.qa('[data-cf-gen-day]')) node.open = true;
    assert.match(f.q('[data-cf-proposal="idea-1"]').textContent, /Черновик №500 создан/);
    assert.match(f.q('[data-cf-proposal="idea-2"]').textContent, /Черновик №501 создан/);
    assert.equal(stored.size, 2, 'дублей нет');
  } finally { f.close(); }
});

test('R1: основание — понятные подписи, служебные префиксы и неизвестные метки не показываются', async () => {
  const f = page({srv: server({jobs: [job({status: 'succeeded', proposals: [
    proposal(1, {basis: ['priority:Фотозона', 'event:Осенняя акция', 'occasion:Выписка', 'internal:x-17', 'priority:', 'без префикса', 42]}),
    proposal(2, {basis: ['internal:only', 'rule:7']})]})]})}); try {
    await f.open();
    for (const node of f.qa('[data-cf-gen-day]')) node.open = true;
    const first = f.q('[data-cf-proposal="idea-1"]').textContent, second = f.q('[data-cf-proposal="idea-2"]').textContent;
    assert.match(first, /Основание: Приоритет месяца — Фотозона; Событие — Осенняя акция; Повод покупки — Выписка/);
    const line = [...f.q('[data-cf-proposal="idea-1"]').querySelectorAll('p')].find((node) => node.textContent.startsWith('Основание:'));
    assert.equal(line.textContent, 'Основание: Приоритет месяца — Фотозона; Событие — Осенняя акция; Повод покупки — Выписка', 'пустая метка не даёт «Приоритет месяца — »');
    assert.doesNotMatch(f.text(), /priority:|event:|occasion:|internal|x-17|rule:|без префикса/);
    assert.doesNotMatch(second, /Основание/, 'только неизвестные метки — строки нет');
  } finally { f.close(); }
});

test('CF5: повтор переноса возвращает удалённый черновик — он отмечен удалённым, «Показать» ведёт к удалённым, новая карточка не создаётся', async () => {
  const srv = server({jobs: [job({status: 'succeeded', proposals: [proposal(1), proposal(2)]})], drafts: (body, id, code) => ({companyCode: code, jobId: id,
    drafts: body.proposalIds.map((proposalId) => proposalId === 'idea-1' ? {proposalId, postId: 500, archivedAt: '2026-10-01T03:00:00Z'} : {proposalId, postId: 501, archivedAt: null}), createdCount: 0})});
  const f = page({srv}); try {
    await f.open();
    await f.click('[data-cf-gen="select-visible"]');
    await f.click('[data-cf-gen="drafts"]');
    const state = f.q('[data-cf-gen-draft-state]').textContent;
    assert.match(state, /Создано черновиков: 0\. Уже были созданы раньше: 2\. Из них удалены из плана: 1 — вернуть можно в «Удалённых материалах» на доске\./);
    for (const node of f.qa('[data-cf-gen-day]')) node.open = true;
    assert.match(f.q('[data-cf-proposal="idea-1"]').textContent, /Черновик №500 удалён из плана\. Вернуть можно в «Удалённых материалах» на доске/);
    assert.doesNotMatch(f.q('[data-cf-proposal="idea-1"]').textContent, /создан/, 'удалённый не показывается как действующий');
    assert.match(f.q('[data-cf-proposal="idea-2"]').textContent, /Черновик №501 создан/);
    f.q('[data-cf-gen-open="500"]').click(); await settle();
    assert.deepEqual(f.events.at(-1), ['sb:content-factory-open-draft', {companyCode: 'one', postId: 500}]);
    assert.ok(f.posts().every((c) => !/restore|archive|approve|schedule/.test(c.path)), 'перенос ничего не восстанавливает и не согласует');
  } finally { f.close(); }
});

// CF19: прежние успешные планы месяца доступны после нового отказа; выбор и черновики живут в своей задаче.
const ready = (extra = {}) => job({id: 'job-1', status: 'succeeded', createdAt: '2026-10-01T05:00:00Z', proposals: [proposal(1), proposal(2), proposal(3)], coverage: {requested: 3, proposed: 3}, ...extra});

test('CF19: после нового отказа прежний готовый план доступен в истории; очередь и запуск — по последней задаче', async () => {
  const srv = server({jobs: [job({id: 'job-2', status: 'failed', createdAt: '2026-10-01T06:00:00Z', attempts: 3, errorMessage: 'Модель временно недоступна.', retryable: true}), ready()]});
  const f = page({srv}); try {
    await f.open();
    assert.equal(f.status(), 'failed', 'состояние сверху — последней задачи');
    assert.match(f.text(), /Модель временно недоступна/);
    const history = f.q('[data-cf-gen-history]');
    assert.ok(history && !history.open, 'история свёрнута');
    assert.match(history.querySelector('summary').textContent, /Предыдущие попытки и планы месяца \(1, готовых 1\)/);
    assert.match(f.q('[data-cf-gen-history-job="job-1"]').textContent, /Готово\. · предложений 3/);
    assert.equal(f.q('[data-cf-gen-viewed]'), null, 'прежний план не открывается сам');
    await f.click('[data-cf-gen-view="job-1"]');
    assert.equal(f.status(), 'failed', 'последняя задача и её причина остаются сверху');
    assert.match(f.text(), /Модель временно недоступна/);
    const viewed = f.q('[data-cf-gen-viewed="job-1"]');
    assert.ok(viewed, 'показан прежний план');
    assert.match(viewed.textContent, /Прежний план от .* — предыдущий результат этого месяца, не последняя задача/);
    assert.equal(viewed.querySelectorAll('[data-cf-proposal]').length, 3);
    assert.ok(f.q('[data-cf-gen-history]').open);
    assert.match(f.q('[data-cf-gen-history-job="job-1"]').textContent, /показан выше/);
    assert.equal(f.q('[data-cf-gen="start"]').disabled, false, 'запуск разрешён: последняя задача не активна');
    await f.click('[data-cf-gen="start"]');
    assert.equal(f.posts().length, 1);
    assert.equal(f.posts()[0].path, '/media-mentor/generation', 'запускается новая задача, а не повтор прежней');
    assert.equal(f.status(), 'queued');
    assert.equal(f.q('[data-cf-gen="start"]').disabled, true, 'новая активная задача блокирует второй запуск, даже пока открыт прежний план');
    assert.ok(f.q('[data-cf-gen-viewed="job-1"]'), 'прежний план остаётся открытым');
    assert.equal(f.pending().length, 1, 'опрос идёт по новой последней задаче');
    assert.match(f.q('[data-cf-gen-history]').querySelector('summary').textContent, /\(2, готовых 1\)/);
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('CF19: после needs_input прежний план доступен; черновики из него — POST в его jobId; возврат к последней', async () => {
  const srv = server({jobs: [ready(), job({id: 'job-2', status: 'needs_input', createdAt: '2026-10-01T06:00:00Z', questions: [{target: 'month.formats', text: 'Какие форматы?', required: true}]})]});
  const f = page({srv}); try {
    await f.open();
    assert.equal(f.status(), 'needs_input');
    await f.click('[data-cf-gen-view="job-1"]');
    assert.match(f.text(), /Какие форматы\?/, 'вопросы последней задачи видны');
    await f.click('[data-cf-gen="select-visible"]');
    assert.match(f.q('[data-cf-gen="drafts"]').textContent, /\(3\)/);
    await f.click('[data-cf-gen="drafts"]');
    const post = f.posts().at(-1);
    assert.equal(post.path, '/media-mentor/generation/job-1/drafts', 'импорт относится к показанной задаче');
    assert.deepEqual(post.body, {proposalIds: ['idea-1', 'idea-2', 'idea-3']});
    assert.match(f.q('[data-cf-gen-viewed]').textContent, /Создано черновиков: 3/);
    await f.click('[data-cf-gen="view-latest"]');
    assert.equal(f.q('[data-cf-gen-viewed]'), null);
    assert.equal(f.status(), 'needs_input');
    assert.doesNotMatch(f.text(), /Создано черновиков/, 'сообщение переноса принадлежит прежней задаче');
    await f.click('[data-cf-gen-view="job-1"]');
    for (const node of f.qa('[data-cf-gen-day]')) node.open = true;
    assert.match(f.q('[data-cf-proposal="idea-1"]').textContent, /Черновик №100 создан/, 'квитанции этой задачи сохранились');
    assert.match(f.text(), /Создано черновиков: 3/);
  } finally { f.close(); }
});

test('CF19: выбор, скрытые площадки и квитанции не смешиваются между задачами с одинаковыми ideaId', async () => {
  const srv = server({jobs: [job({id: 'job-2', status: 'succeeded', createdAt: '2026-10-01T06:00:00Z', proposals: [proposal(1), proposal(2)], coverage: {requested: 2, proposed: 2}}), ready()]});
  const f = page({srv}); try {
    await f.open();
    assert.equal(f.status(), 'succeeded');
    f.q('[data-cf-gen-platform="vk"]').click(); await settle();
    await f.click('[data-cf-gen="select-visible"]');
    await f.click('[data-cf-gen="drafts"]');
    assert.equal(f.posts().at(-1).path, '/media-mentor/generation/job-2/drafts');
    assert.deepEqual(f.posts().at(-1).body, {proposalIds: ['idea-1']});
    await f.click('[data-cf-gen-view="job-1"]');
    assert.match(f.text(), /Предложения последней задачи скрыты, пока открыт прежний план/);
    const viewed = f.q('[data-cf-gen-viewed="job-1"]');
    for (const node of viewed.querySelectorAll('[data-cf-gen-day]')) node.open = true;
    assert.equal(viewed.querySelectorAll('[data-cf-proposal]').length, 3, 'площадка, скрытая в другой задаче, здесь видна');
    assert.ok(viewed.querySelector('[data-cf-gen-select="idea-1"]'), 'idea-1 этой задачи не отмечена созданной');
    assert.doesNotMatch(viewed.textContent, /Черновик №|Создано черновиков/);
    assert.match(f.q('[data-cf-gen="drafts"]').textContent, /\(0\)/, 'выбор другой задачи не перенесён');
    // Отметка с узла другой задачи (подменённый data-cf-job) не попадает в показанную.
    const box = viewed.querySelector('[data-cf-gen-select="idea-2"]');
    box.closest('[data-cf-job]').dataset.cfJob = 'job-2';
    box.checked = true; box.dispatchEvent(new f.w.Event('change', {bubbles: true})); await settle();
    assert.match(f.q('[data-cf-gen="drafts"]').textContent, /\(0\)/);
    f.q('[data-cf-gen-viewed] [data-cf-gen-select="idea-3"]').click(); await settle();
    await f.click('[data-cf-gen="drafts"]');
    assert.equal(f.posts().at(-1).path, '/media-mentor/generation/job-1/drafts');
    assert.deepEqual(f.posts().at(-1).body, {proposalIds: ['idea-3']});
    await f.click('[data-cf-gen="view-latest"]');
    for (const node of f.qa('[data-cf-gen-day]')) node.open = true;
    assert.match(f.q('[data-cf-proposal="idea-1"]').textContent, /Черновик №100 создан/);
    assert.equal(f.q('[data-cf-gen-platform="vk"]').checked, false, 'скрытая площадка последней задачи сохранилась');
    assert.equal(f.q('[data-cf-proposal="idea-3"]'), null);
  } finally { f.close(); }
});

test('CF19: смена месяца и проекта сбрасывает прежний план и выбор; исчезнувшая задача — честное сообщение', async () => {
  const srv = server({jobs: [job({id: 'job-2', status: 'failed', createdAt: '2026-10-01T06:00:00Z', errorMessage: 'Сбой.'}), ready(),
    job({id: 'job-9', month: '2026-11', status: 'failed', createdAt: '2026-11-01T06:00:00Z', errorMessage: 'Ноябрь.'})]});
  const f = page({srv}); try {
    await f.open();
    await f.click('[data-cf-gen-view="job-1"]');
    await f.click('[data-cf-gen-select="idea-1"]');
    assert.match(f.q('[data-cf-gen="drafts"]').textContent, /\(1\)/);
    await f.month('2026-11');
    assert.equal(f.q('[data-cf-gen-viewed]'), null, 'другой месяц — прежний план закрыт');
    assert.equal(f.q('[data-cf-gen-history]'), null, 'история другого месяца пуста');
    assert.match(f.text(), /Ноябрь\./);
    await f.month('2026-10');
    assert.equal(f.q('[data-cf-gen-viewed]'), null, 'возврат к месяцу не открывает план сам');
    await f.click('[data-cf-gen-view="job-1"]');
    assert.match(f.q('[data-cf-gen="drafts"]').textContent, /\(0\)/, 'выбор до смены месяца не восстановлен');
    // Повторное чтение того же месяца: задача исчезла из списка — показывается последняя и сообщение.
    srv.state.jobs = srv.state.jobs.filter((item) => item.id !== 'job-1');
    await f.month('2026-10');
    assert.equal(f.q('[data-cf-gen-viewed]'), null);
    assert.equal(f.status(), 'failed');
    assert.match(f.text(), /Выбранный прежний план больше не в списке задач месяца — показана последняя задача/);
    // Смена проекта: всё прежнее закрыто, в другой компании ничего не открыто.
    srv.state.jobs.push(ready());
    await f.month('2026-10');
    await f.click('[data-cf-gen-view="job-1"]');
    assert.ok(f.q('[data-cf-gen-viewed="job-1"]'));
    f.w.SbCabinet.contentFactory.bindPlanBar(f.bar, {...f.ctx, selectedProjectId: 'two'});
    assert.equal(f.panel.hidden, true);
    f.ctx.selectedProjectId = 'two';
    await f.open();
    assert.equal(f.q('[data-cf-gen-viewed]'), null, 'прежний план компании one в two не показан');
    assert.ok(srv.calls.filter((c) => c.path === '/media-mentor/generation' && c.method === 'GET').at(-1).code === 'two');
    assert.deepEqual(f.posts(), [], 'ничего не отправлено');
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('CF19: пока переносится прежний план, «Создать черновики» заблокирована; второй POST не уходит', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const srv = server({jobs: [job({id: 'job-2', status: 'failed', createdAt: '2026-10-01T06:00:00Z'}), ready()],
    drafts: async (body, id, code) => { await gate; return {companyCode: code, jobId: id, drafts: body.proposalIds.map((p, i) => ({proposalId: p, postId: 200 + i})), createdCount: body.proposalIds.length}; }});
  const f = page({srv}); try {
    await f.open();
    await f.click('[data-cf-gen-view="job-1"]');
    await f.click('[data-cf-gen="select-visible"]');
    await f.click('[data-cf-gen="drafts"]');
    assert.equal(f.q('[data-cf-gen="drafts"]').disabled, true, 'занято до ответа');
    f.q('[data-cf-gen="drafts"]').disabled = false; await f.click('[data-cf-gen="drafts"]');
    release(); await settle();
    assert.equal(f.posts().filter((c) => /\/drafts$/.test(c.path)).length, 1);
    assert.match(f.q('[data-cf-gen-viewed]').textContent, /Создано черновиков: 3/);
  } finally { f.close(); }
});

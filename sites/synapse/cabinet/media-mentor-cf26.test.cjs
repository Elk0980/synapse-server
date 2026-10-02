'use strict';
// CF26 (клиент): адрес фокуса предложений плана, перенос ОДНОЙ текущей согласованной версии и точная расписка.
// Синтетический сервер в памяти по CONTRACT.md снимка CONTENT_FACTORY_CF26_BACKEND_REVIEW_20261001. Реальных API, публикаций и сообщений нет.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const {JSDOM} = require('jsdom');
const script = fs.readFileSync(require.resolve('./media-mentor.js'), 'utf8');
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve)); };
const httpError = (status, message, code) => Object.assign(new Error(message), {status, ...(code ? {code} : {})});

const VOCABULARY = {
  platforms: [{id: 'telegram', label: 'Telegram'}, {id: 'vk', label: 'ВКонтакте'}, {id: 'instagram', label: 'Instagram / Reels'}],
  formats: [{id: 'post', label: 'Пост'}, {id: 'reel', label: 'Reels / Shorts / клип'}],
  roles: [{id: 'reach', label: 'Охватный'}, {id: 'sale', label: 'На продажу'}],
  shootingComfort: [{id: 'unknown', label: 'Не выяснено'}, {id: 'hands_only', label: 'Руки и процесс без лица'}],
  assetKinds: [{id: 'photo', label: 'Фото'}, {id: 'video', label: 'Видео'}],
  minDays: 7, maxDays: 14, variantScopes: ['plan', 'idea', 'variants'],
  captionLimits: {telegram: 1024, vk: 16000, instagram: 2200},
};
const FIELDS = {
  goal: 'Записи на массаж', product: 'Массаж 60 минут', audience: 'Офисные сотрудники',
  pains: ['Болит спина'], confirmedFacts: [{id: 'f1', statement: 'Приём 10:00–21:00', source: 'Карточка ЛК'}],
  assets: [{id: 'a1', title: 'Съёмка кабинета', kind: 'photo', note: ''}],
  shootingComfort: {level: 'hands_only', notes: ''}, platforms: ['telegram', 'vk'],
};
const variantsOf = (index) => ({
  telegram: {text: `ТГ текст ${index + 1}`, hook: '', format: '', assetId: '', mentorNote: '',
    plannedDate: '', plannedTime: '', timezone: '', excluded: false, contentRevision: 1},
  vk: {text: `ВК текст ${index + 1}`, hook: '', format: '', assetId: '', mentorNote: '',
    plannedDate: '', plannedTime: '', timezone: '', excluded: false, contentRevision: 1},
});
const planDays = (count = 7, withVariants = true) => Array.from({length: count}, (item, index) => ({
  ideaId: `idea-${index + 1}`, date: `2026-10-${String(index + 1).padStart(2, '0')}`,
  platform: 'telegram', format: 'post', role: 'reach', topic: `Тема дня ${index + 1}`,
  hook: '', assetId: 'a1', mentorNote: '',
  ...(withVariants ? {variants: variantsOf(index)}
    : {variants: {telegram: {text: '', hook: '', format: '', assetId: '', mentorNote: '',
      plannedDate: '', plannedTime: '', timezone: '', excluded: false, contentRevision: 1}}})}));
const statesFor = (days, patch = {}) => days.flatMap((day) => Object.keys(day.variants)
  .map((platform) => ({ideaId: day.ideaId, platform, contentRevision: 1,
    status: patch[`${day.ideaId}|${platform}`] || 'pending', decision: null, reason: '', actorName: null})));

function payload(overrides = {}, days = planDays()) {
  return {companyCode: 'alvi', notice: 'Согласование версии плана — решение по тексту.',
    brief: {revision: 2, updatedAt: '2026-09-18T00:00:00.000Z', fields: FIELDS, history: []},
    plan: {revision: 1, briefRevision: 2, updatedAt: '2026-09-18T00:00:00.000Z', days,
      startDate: days[0].date, endDate: days[days.length - 1].date, windowDays: days.length, history: []},
    approval: {planRevision: 1, briefRevision: null, decision: null, decidedAt: null, actorId: null,
      actorName: null, comment: '', status: 'pending', requiresReapproval: true, reason: 'Ещё не согласована'},
    variants: statesFor(days), feedback: [], approvals: [], vocabulary: VOCABULARY,
    transfer: {planRevision: 1, briefRevision: 2, approvalStatus: 'pending', canTransfer: false,
      blockedReason: 'Переносить можно только согласованную версию плана', current: null,
      notice: 'Перенос создаёт только черновики автопостинга.', target: 'autoposting-drafts',
      createsPublications: false, schedules: false, choosesChannels: false, leavesUnfilled: [],
      previousTransfers: 0, repeatProtection: '', newVersionNotice: '', awaitingMaterial: 0,
      materialUploadPath: '/content/publishing-assets', materialNotice: '', history: []},
    capabilities: {publishing: false, modelSuggestions: false, httpApi: true, cabinetUi: true,
      planApprovalAuthorizesPublishing: false},
    ...overrides};
}


/* Сервер: план с идеями, решения по версиям, перенос по выбору с защитой от повтора по версии содержимого. */
function server({approved = ['idea-3|vk'], code = 'alvi'} = {}) {
  const days = planDays();
  const srv = {code, days, approved: new Set(approved), transfers: [], posts: new Map(), archived: new Set(), hooks: {},
    planRevision: 1, briefRevision: 2, nextPost: 80};
  srv.payload = () => {
    const states = statesFor(days).map((state) => ({...state,
      contentRevision: days.find((d) => d.ideaId === state.ideaId).variants[state.platform].contentRevision,
      status: srv.approved.has(`${state.ideaId}|${state.platform}`) ? 'approved' : state.status}));
    return payload({companyCode: srv.code, variants: states,
      plan: {revision: srv.planRevision, briefRevision: srv.briefRevision, updatedAt: '2026-09-18T00:00:00.000Z', days: JSON.parse(JSON.stringify(days)),
        startDate: days[0].date, endDate: days[days.length - 1].date, windowDays: days.length, history: []},
      variantTransfer: {planRevision: srv.planRevision, briefRevision: srv.briefRevision, approvedCount: srv.approved.size, awaitingTransfer: 0,
        canTransfer: false, blockedReason: '', notice: '', createsPublications: false, schedules: false, choosesChannels: false,
        items: srv.transfers.map((item) => ({...item, cardStatus: srv.posts.get(item.postId).status, postRevision: srv.posts.get(item.postId).revision,
          mediaUrls: [], mediaCount: 0, hasMedia: false}))}}, days);
  };
  srv.transfer = (body) => {
    if (body.planRevision !== srv.planRevision) throw httpError(409, 'Версия плана уже изменилась. Обновите страницу.', 'STALE_PLAN');
    const sel = body.selection, idea = days.find((d) => d.ideaId === sel.ideaId);
    if (!idea) throw httpError(404, 'Идея плана не найдена', 'IDEA_NOT_FOUND');
    const variant = idea.variants[sel.platform];
    if (variant.contentRevision !== sel.contentRevision) throw httpError(409, 'Версия площадки уже изменилась. Обновите план.', 'STALE_VARIANT');
    if (variant.excluded || !variant.text) throw httpError(409, 'Пустая или исключённая версия не переносится', 'VARIANT_NOT_APPROVABLE');
    if (!srv.approved.has(`${sel.ideaId}|${sel.platform}`)) throw httpError(409, 'Эта версия площадки ещё не согласована', 'VARIANT_NOT_APPROVED');
    const seen = srv.transfers.find((t) => t.ideaId === sel.ideaId && t.platform === sel.platform && t.contentRevision === sel.contentRevision);
    if (seen) {
      const post = srv.posts.get(seen.postId);
      return {companyCode: srv.code, created: [], createdCount: 0, alreadyTransferred: 1, posts: [],
        skipped: [{...sel, postId: seen.postId, cardStatus: post.status, archivedAt: post.archive?.archivedAt || null}]};
    }
    const postId = ++srv.nextPost;
    srv.posts.set(postId, {id: postId, companyCode: srv.code, status: 'draft', revision: 1, title: idea.topic, text: variant.text,
      platformIds: [], mediaUrls: [], scheduledAt: null,
      planLink: {ideaId: sel.ideaId, platform: sel.platform, contentRevision: sel.contentRevision, planRevision: srv.planRevision, briefRevision: srv.briefRevision}});
    srv.transfers.push({ideaId: sel.ideaId, platform: sel.platform, contentRevision: sel.contentRevision, planRevision: srv.planRevision,
      briefRevision: srv.briefRevision, planDate: idea.date, postId});
    return {companyCode: srv.code, created: [{...sel, postId}], createdCount: 1, alreadyTransferred: 0, skipped: [], posts: [{id: postId}]};
  };
  return srv;
}

// Часы окна теста фиксированы: порядок «Ближайшие сначала» считает «сегодня» по местной дате, а фикстуры плана — с 1 октября 2026.
// Без этого при местной дате позже 1 октября первый материал уходит в «прошедшие» и тест зависит от календаря (CF26-R2).
const FIXED_NOW = '2026-09-30T12:00:00Z';
const freezeClock = (w) => { const Native = w.Date;
  w.Date = class extends Native { constructor(...args) { super(...(args.length ? args : [FIXED_NOW])); } static now() { return Native.parse(FIXED_NOW); } }; };

function fixture({srv = server(), role = 'owner', permissions = ['autoposting.view', 'autoposting.edit'], hash = '', companies} = {}) {
  const dom = new JSDOM('<section id="view" data-view="media-mentor"></section>', {url: `https://test.local/cabinet.html${hash}`, runScripts: 'outside-only'});
  const w = dom.window, node = w.document.getElementById('view'), calls = [], views = {}, chosen = [];
  w.SbCabinet = {registerView(name, definition) { views[name] = definition; }};
  freezeClock(w);
  w.eval(script);
  const ctx = {
    identity: {role, permissions, csrfToken: 'csrf-token', companies: companies || [{id: 'alvi', name: 'АЛВИ'}, {id: 'beta', name: 'Бета'}]},
    selectedProjectId: srv.code,
    chooseProject(id) { chosen.push(id); ctx.selectedProjectId = id; srv.code = id; w.history.replaceState(null, '', '#content-factory/plan/proposals'); views['media-mentor'].onProjectChange(ctx); },
    csrfOptions: (method, body) => ({method, headers: {'X-CSRF-Token': 'csrf-token'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}),
    crmQuery: async (path, params, opts = {}) => {
      const call = {path, params, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null};
      calls.push(call);
      if (srv.hooks.any) { const out = await srv.hooks.any(call); if (out !== undefined) return out; }
      if (path === '/media-mentor' && call.method === 'GET') return srv.payload();
      if (path === '/media-mentor/plan/variants/transfer') {
        assert.equal(call.method, 'POST'); assert.equal(opts.headers['X-CSRF-Token'], 'csrf-token');
        if (srv.hooks.transfer) return srv.hooks.transfer(call);
        return srv.transfer(call.body);
      }
      const one = path.match(/^\/autoposting\/posts\/(\d+)$/);
      if (one && call.method === 'GET') {
        if (srv.hooks.post) { const out = await srv.hooks.post(call); if (out !== undefined) return out; }
        const post = srv.posts.get(Number(one[1]));
        if (!post || post.companyCode !== params.companyCode) throw httpError(404, 'Не найдено', 'NOT_FOUND');
        return JSON.parse(JSON.stringify(post));
      }
      throw new Error(`Неожиданный запрос ${call.method} ${path}`);
    },
  };
  const f = {dom, w, node, calls, ctx, srv, chosen, view: views['media-mentor'],
    writes: () => calls.filter((call) => call.method !== 'GET'),
    panel: (idea, platform) => node.querySelector(`[data-variants="${idea}"] [data-variant="${platform}"]`),
    async render() { f.view.render(node, ctx); await settle(); },
    close: () => w.close()};
  return f;
}
const typeText = (f, panel, text) => { const area = panel.querySelector('[data-variant-field="text"]'); area.value = text;
  area.dispatchEvent(new f.w.Event('input', {bubbles: true})); };

// ---------- FR-070: адрес фокуса ----------
test('CF26 фокус: штатный адрес только читает план, выделяет идею и открывает вкладку версии площадки', async () => {
  const f = fixture({hash: '#content-factory/plan/proposals?company=alvi&idea=idea-3&platform=vk'});
  try {
    await f.render();
    assert.deepEqual(f.calls.map((call) => `${call.method} ${call.path}`), ['GET /media-mentor'], 'только чтение плана');
    const row = f.node.querySelector('.mentor-focus');
    assert.equal(row.dataset.ideaId, 'idea-3', 'выделена ровно идея из ссылки');
    assert.equal(f.node.querySelectorAll('.mentor-focus').length, 1);
    assert.equal(row.querySelector('.mentor-day-details').open, true);
    assert.equal(f.panel('idea-3', 'vk').hidden, false, 'открыта вкладка площадки из ссылки');
    assert.equal(f.panel('idea-3', 'telegram').hidden, true);
    assert.equal(f.node.querySelector('[data-variants="idea-3"] [data-variant-tab="vk"]').getAttribute('aria-pressed'), 'true');
    const note = f.node.querySelector('[data-plan-focus]');
    assert.match(note.textContent, /Показана идея «Тема дня 3» · версия ВКонтакте\. Ничего не сохраняется и не переносится само/);
    assert.equal(f.writes().length, 0);
  } finally { f.close(); }
});

test('CF26 фокус: отсутствующая идея, площадка без версии и повреждённая ссылка — сообщение без догадок и без записей', async () => {
  for (const [hash, expected] of [
    ['?company=alvi&idea=idea-404&platform=vk', /Идея idea-404 не найдена в текущем плане компании.*Ничего не выбрано вместо неё/],
    ['?company=alvi&idea=idea-2&platform=instagram', /Идея «Тема дня 2» найдена, но версии для площадки Instagram \/ Reels в ней нет/],
    ['?company=alvi&idea=idea-2', /Ссылка на версию идеи неполная или повреждена/],
    ['?company=alvi&idea=idea-2&platform=vk&post=5', /неполная или повреждена/],
    ['?company=alvi&idea=idea-2&idea=idea-3&platform=vk', /неполная или повреждена/],
    ['?company=alvi&idea=%3Cimg%3E&platform=vk', /неполная или повреждена/]]) {
    const f = fixture({hash: `#content-factory/plan/proposals${hash}`});
    try {
      await f.render();
      assert.match(f.node.querySelector('[data-plan-focus]').textContent, expected, hash);
      assert.equal(f.writes().length, 0, hash);
      if (!/idea-2&platform=instagram/.test(hash)) assert.equal(f.node.querySelector('.mentor-focus'), null, `${hash}: ничего не выделено`);
      assert.equal(f.node.querySelector('[data-plan-focus] img'), null);
    } finally { f.close(); }
  }
});

test('CF26 фокус: открытый план с несохранёнными правками не перерисовывается — правки на месте, выделение в текущей форме', async () => {
  const f = fixture();
  try {
    await f.render();
    const area = f.panel('idea-5', 'telegram').querySelector('[data-variant-field="text"]');
    typeText(f, f.panel('idea-5', 'telegram'), 'Несохранённый новый текст');
    f.w.location.hash = '#content-factory/plan/proposals?company=alvi&idea=idea-3&platform=vk';
    f.view.render(f.node, f.ctx); await settle();
    assert.equal(f.calls.filter((call) => call.path === '/media-mentor').length, 1, 'план не перечитан');
    assert.ok(area.isConnected, 'та же форма');
    assert.equal(area.value, 'Несохранённый новый текст');
    assert.equal(f.node.querySelector('.mentor-focus').dataset.ideaId, 'idea-3');
    assert.match(f.node.querySelector('[data-plan-focus]').textContent, /План не перечитан: в форме есть несохранённые правки, они на месте/);
    assert.equal(f.writes().length, 0);
    // Без правок — обычное свежее чтение.
    const g = fixture({hash: '#content-factory/plan/proposals?company=alvi&idea=idea-2&platform=telegram'});
    try { await g.render(); g.view.render(g.node, g.ctx); await settle();
      assert.equal(g.calls.filter((call) => call.path === '/media-mentor').length, 2, 'без правок план перечитывается'); } finally { g.close(); }
  } finally { f.close(); }
});

test('CF26 фокус: ссылка другой компании — доступная переключается выбором проекта, недоступная и при правках — нет', async () => {
  const f = fixture({hash: '#content-factory/plan/proposals?company=beta&idea=idea-4&platform=vk'});
  try {
    await f.render();
    assert.deepEqual(f.chosen, ['beta'], 'существующий выбор проекта');
    assert.deepEqual(f.calls.map((call) => call.params.companyCode), ['beta'], 'план читается уже новой компании, прежний запрос не делался');
    assert.equal(f.node.querySelector('.mentor-focus').dataset.ideaId, 'idea-4');
    assert.equal(f.writes().length, 0);
  } finally { f.close(); }
  const denied = fixture({hash: '#content-factory/plan/proposals?company=gamma&idea=idea-4&platform=vk'});
  try {
    await denied.render();
    assert.deepEqual(denied.chosen, []);
    assert.match(denied.node.querySelector('[data-plan-focus]').textContent, /другую компанию \(gamma\), она вам недоступна\. Компания не переключена/);
    assert.equal(denied.node.querySelector('.mentor-focus'), null);
  } finally { denied.close(); }
  const dirty = fixture();
  try {
    await dirty.render();
    typeText(dirty, dirty.panel('idea-1', 'vk'), 'Правка');
    dirty.w.location.hash = '#content-factory/plan/proposals?company=beta&idea=idea-4&platform=vk';
    dirty.view.render(dirty.node, dirty.ctx); await settle();
    assert.deepEqual(dirty.chosen, [], 'с несохранёнными правками компания не переключается');
    assert.equal(dirty.panel('idea-1', 'vk').querySelector('[data-variant-field="text"]').value, 'Правка');
    assert.match(dirty.node.querySelector('[data-plan-focus]').textContent, /Сначала сохраните план текущей компании/);
  } finally { dirty.close(); }
});

test('CF26 смена компании: onProjectChange(ctx) рисует свой раздел, поздний ответ прежней компании не рисуется', async () => {
  const f = fixture();
  try {
    let release; const gate = new Promise((resolve) => { release = resolve; });
    f.srv.hooks.any = async (call) => { if (call.params.companyCode === 'alvi') { await gate; return f.srv.payload(); } return undefined; };
    f.view.render(f.node, f.ctx); await settle();
    f.ctx.selectedProjectId = 'beta'; f.srv.code = 'beta'; f.srv.hooks.any = null;
    f.view.onProjectChange(f.ctx); await settle();
    release(); await settle();
    assert.equal(f.node.querySelector('[data-variants="idea-1"]') !== null, true);
    assert.deepEqual(f.calls.map((call) => call.params.companyCode), ['alvi', 'beta']);
    assert.doesNotThrow(() => f.view.onProjectChange(f.ctx), 'вызов без узла раздела не падает');
  } finally { f.close(); }
});

// ---------- FR-071: перенос одной версии ----------
test('CF26 перенос: кнопка только у сохранённой согласованной непустой версии без текущего переноса и только с правом правки', async () => {
  const srv = server({approved: ['idea-3|vk', 'idea-4|vk', 'idea-5|vk']});
  srv.days[3].variants.vk.excluded = true; srv.days[4].variants.vk.text = '';
  const f = fixture({srv});
  try {
    await f.render();
    const buttons = [...f.node.querySelectorAll('[data-variant-transfer]')];
    assert.deepEqual(buttons.map((b) => `${b.dataset.variantIdeaId}|${b.dataset.variantPlatform}|${b.dataset.variantContentRevision}`), ['idea-3|vk|1']);
    assert.equal(buttons[0].textContent, 'Перенести эту версию в черновик');
    assert.equal(f.panel('idea-3', 'telegram').querySelector('[data-variant-transfer]'), null, 'соседней несогласованной кнопки нет');
    assert.ok(f.node.querySelector('[data-variants-transfer]'), 'прежний перенос всего плана на месте');
  } finally { f.close(); }
  const viewer = fixture({srv: server(), role: 'viewer', permissions: ['autoposting.view']});
  try { await viewer.render(); assert.equal(viewer.node.querySelector('[data-variant-transfer]'), null); } finally { viewer.close(); }
});

test('CF26 перенос: ровно выбранная версия, 201 → свежий GET карточки той же компании → свежий план; сосед не переносится', async () => {
  const f = fixture();
  try {
    await f.render();
    f.panel('idea-3', 'vk').querySelector('[data-variant-transfer]').click(); await settle();
    const post = f.writes();
    assert.equal(post.length, 1);
    assert.deepEqual(post[0].body, {planRevision: 1, briefRevision: 2, selection: {ideaId: 'idea-3', platform: 'vk', contentRevision: 1}});
    assert.equal(post[0].params.companyCode, 'alvi');
    assert.deepEqual(f.calls.slice(1).map((call) => `${call.method} ${call.path} ${call.params.companyCode}`),
      ['POST /media-mentor/plan/variants/transfer alvi', 'GET /autoposting/posts/81 alvi', 'GET /media-mentor alvi']);
    assert.deepEqual(f.srv.transfers.map((t) => `${t.ideaId}|${t.platform}`), ['idea-3|vk'], 'сосед не перенесён');
    const panel = f.panel('idea-3', 'vk');
    assert.match(panel.querySelector('[data-variant-transfer-line]').textContent, /^Перенесено: черновик №81 · сейчас: черновик\. Финальный материал одобряется отдельно в «Автопостинге»\.$/);
    assert.equal(panel.querySelector('[data-variant-transfer]'), null, 'повторной кнопки у перенесённой текущей версии нет');
    const card = panel.querySelector('[data-variant-card]');
    assert.equal(card.dataset.variantCard, '81');
    assert.match(card.textContent, /Текущая версия \(содержимое v1\) перенесена в черновик №81/);
    assert.equal(card.querySelector('[data-variant-card-open]').getAttribute('href'), '#content-factory/plan?company=alvi&post=81&revision=1');
    assert.equal(f.panel('idea-3', 'telegram').querySelector('[data-variant-card]').dataset.variantCard, '');
  } finally { f.close(); }
});

test('CF26 фокус: после сохранения, решения и переноса идея из ссылки остаётся открытой, вкладка — та же площадка', async () => {
  const f = fixture({hash: '#content-factory/plan/proposals?company=alvi&idea=idea-3&platform=vk'});
  try {
    await f.render();
    f.panel('idea-3', 'vk').querySelector('[data-variant-transfer]').click(); await settle();
    assert.equal(f.calls.at(-1).path, '/media-mentor', 'план перечитан');
    assert.equal(f.node.querySelector('.mentor-focus').dataset.ideaId, 'idea-3');
    assert.equal(f.panel('idea-3', 'vk').hidden, false);
    assert.equal(f.node.querySelector('.mentor-focus .mentor-day-details').open, true);
  } finally { f.close(); }
});

test('CF26 перенос: несохранённые правки — «сначала сохраните», запроса нет', async () => {
  const f = fixture();
  try {
    await f.render();
    typeText(f, f.panel('idea-3', 'vk'), 'Новый текст без сохранения');
    f.panel('idea-3', 'vk').querySelector('[data-variant-transfer]').click(); await settle();
    assert.equal(f.writes().length, 0);
    assert.match(f.panel('idea-3', 'vk').querySelector('[data-variant-transfer-line]').textContent, /^Сначала сохраните план/);
  } finally { f.close(); }
});

test('CF26 перенос: потерянный ответ — повтор ТЕМ ЖЕ телом; повтор 200 и удалённая карточка — свежий GET, без восстановления', async () => {
  const f = fixture();
  try {
    await f.render();
    let first = true;
    f.srv.hooks.transfer = (call) => { const out = f.srv.transfer(call.body); if (first) { first = false; throw new Error('Failed to fetch'); } return out; };
    f.panel('idea-3', 'vk').querySelector('[data-variant-transfer]').click(); await settle();
    const button = f.panel('idea-3', 'vk').querySelector('[data-variant-transfer]');
    assert.equal(button.textContent, 'Повторить тот же перенос');
    assert.match(f.panel('idea-3', 'vk').querySelector('[data-variant-transfer-line]').textContent, /Ответ не получен \(Failed to fetch\)\. Перенос мог выполниться/);
    // Пока ответа не было, карточку удалили из плана в другом окне; правка формы не меняет тело повтора.
    f.srv.posts.get(81).archive = {archivedAt: '2026-10-01T10:00:00Z'};
    typeText(f, f.panel('idea-3', 'vk'), 'Правка после потери ответа');
    button.click(); await settle();
    const writes = f.writes();
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1].body, writes[0].body, 'то же тело, другой версии нет');
    assert.equal(f.srv.transfers.length, 1, 'второго черновика нет');
    assert.ok(f.calls.some((call) => call.method === 'GET' && call.path === '/autoposting/posts/81'), 'свежий GET после повтора');
    const line = f.panel('idea-3', 'vk').querySelector('[data-variant-transfer-line]').textContent;
    assert.match(line, /Эта версия уже была перенесена раньше: черновик №81 · сейчас: черновик · удалён из плана \(в «Удалённых материалах»\); повторный перенос его не восстанавливает/);
    assert.match(line, /План не перечитан: в форме есть несохранённые правки/, 'правка формы не стёрта перечитыванием');
    assert.equal(f.panel('idea-3', 'vk').querySelector('[data-variant-field="text"]').value, 'Правка после потери ответа');
    assert.equal(f.srv.posts.get(81).archive.archivedAt, '2026-10-01T10:00:00Z');
  } finally { f.close(); }
});

test('CF26 перенос: 400/403/404/409 — код, текст и следующий шаг, без автоповтора; код приходит из details.code', async () => {
  for (const [status, code, expected] of [
    [409, 'STALE_VARIANT', /Текст этой версии уже изменился\. Обновите раздел.*Код: STALE_VARIANT\. Ничего не перенесено; повтор автоматически не отправлялся/],
    [409, 'STALE_PLAN', /План уже сохранён в другой версии.*Код: STALE_PLAN/],
    [409, 'BRIEF_CHANGED', /Бриф изменился.*Код: BRIEF_CHANGED/],
    [409, 'PROFILE_CHANGED', /Данные компании изменились.*Код: PROFILE_CHANGED/],
    [409, 'VARIANT_NOT_APPROVED', /ещё не согласована.*Код: VARIANT_NOT_APPROVED/],
    [409, 'VARIANT_NOT_APPROVABLE', /Пустая или исключённая версия не переносится.*Код: VARIANT_NOT_APPROVABLE/],
    [404, 'IDEA_NOT_FOUND', /Идеи больше нет в текущем плане.*Код: IDEA_NOT_FOUND/],
    [403, 'FORBIDDEN', /^Недостаточно прав для переноса\. Код: FORBIDDEN/],
    [400, undefined, /^Сервер не принял перенос\. Ответ сервера: Укажите идею, площадку и текущую версию содержимого\. Ничего не перенесено/]]) {
    const f = fixture();
    try {
      await f.render();
      f.srv.hooks.transfer = () => { throw httpError(status, code === 'FORBIDDEN' ? 'Недостаточно прав' : 'Укажите идею, площадку и текущую версию содержимого.', code); };
      f.panel('idea-3', 'vk').querySelector('[data-variant-transfer]').click(); await settle();
      assert.equal(f.writes().length, 1, `${code}: без автоповтора`);
      assert.match(f.panel('idea-3', 'vk').querySelector('[data-variant-transfer-line]').textContent, expected);
      const button = f.panel('idea-3', 'vk').querySelector('[data-variant-transfer]');
      assert.equal(button.textContent, 'Перенести эту версию в черновик', 'не «повтор того же»');
      assert.equal(button.disabled, false);
      assert.equal(f.calls.filter((call) => call.path.startsWith('/autoposting/')).length, 0, 'расписки нет — карточку не читаем');
    } finally { f.close(); }
  }
});

test('CF26 перенос: ответ после смены компании не рисуется; неизвестный исход разрешается свежим планом той компании', async () => {
  const f = fixture();
  try {
    await f.render();
    let release; const gate = new Promise((resolve) => { release = resolve; });
    f.srv.hooks.transfer = async (call) => { await gate; return f.srv.transfer(call.body); };
    f.panel('idea-3', 'vk').querySelector('[data-variant-transfer]').click(); await settle();
    f.ctx.selectedProjectId = 'beta';
    release(); await settle();
    assert.equal(f.calls.filter((call) => call.path.startsWith('/autoposting/')).length, 0, 'чужой компании карточку не читаем');
    f.ctx.selectedProjectId = 'alvi'; f.srv.hooks.transfer = null;
    await f.render();
    const button = f.panel('idea-3', 'vk').querySelector('[data-variant-transfer]');
    assert.equal(button, null, 'перенос выполнен до смены — свежий план показывает расписку, а не новую кнопку');
    assert.match(f.panel('idea-3', 'vk').querySelector('[data-variant-transfer-line]').textContent, /^Перенос подтверждён свежим чтением плана: черновик №81\.$/);
    assert.equal(f.panel('idea-3', 'vk').querySelector('[data-variant-card]').dataset.variantCard, '81');
  } finally { f.close(); }
});

test('CF26 перенос: сбой свежего чтения карточки — номер черновика без повторного переноса', async () => {
  const f = fixture();
  try {
    await f.render();
    f.srv.hooks.post = () => { throw new Error('Failed to fetch'); };
    f.panel('idea-3', 'vk').querySelector('[data-variant-transfer]').click(); await settle();
    assert.equal(f.writes().length, 1);
    assert.match(f.panel('idea-3', 'vk').querySelector('[data-variant-transfer-line]').textContent,
      /^Перенесено: черновик №81\. Загрузить его текущую карточку не удалось — повторно переносить не нужно/);
  } finally { f.close(); }
});

// ---------- FR-072: точная расписка ----------
test('CF26 расписка: только текущая contentRevision; прежние переносы — свёрнуто и не называются текущими', async () => {
  const srv = server({approved: ['idea-3|vk']});
  srv.posts.set(70, {id: 70, companyCode: 'alvi', status: 'draft', revision: 3});
  srv.posts.set(71, {id: 71, companyCode: 'alvi', status: 'published', revision: 2});
  srv.transfers.push({ideaId: 'idea-3', platform: 'vk', contentRevision: 1, planRevision: 1, briefRevision: 2, planDate: '2026-10-03', postId: 70},
    {ideaId: 'idea-3', platform: 'vk', contentRevision: 2, planRevision: 1, briefRevision: 2, planDate: '2026-10-03', postId: 71});
  srv.days[2].variants.vk.contentRevision = 3;
  const f = fixture({srv});
  try {
    await f.render();
    const panel = f.panel('idea-3', 'vk');
    const card = panel.querySelector('[data-variant-card]');
    assert.equal(card.dataset.variantCard, '', 'старый перенос не выдаётся за перенос текущей версии');
    assert.match(card.textContent, /^Текущая версия \(содержимое v3\) в черновики ещё не переносилась\.$/);
    const history = panel.querySelector('[data-variant-history]');
    assert.equal(history.open, false, 'история свёрнута');
    assert.match(history.querySelector('summary').textContent, /Прежние переносы этой площадки \(2\)/);
    assert.deepEqual([...history.querySelectorAll('[data-variant-history-item]')].map((li) => li.textContent),
      ['Черновик №70 · содержимое v1 · черновик. Прежний текст, не текущая версия.', 'Черновик №71 · содержимое v2 · опубликован. Прежний текст, не текущая версия.']);
    assert.equal(panel.querySelector('[data-variant-transfer]').dataset.variantContentRevision, '3', 'перенос предлагается для текущей версии');
    assert.equal(f.panel('idea-3', 'telegram').querySelector('[data-variant-history]'), null, 'соседней площадке чужая история не приписывается');
  } finally { f.close(); }
  srv.days[2].variants.vk.contentRevision = 2;
  const g = fixture({srv});
  try {
    await g.render();
    const panel = g.panel('idea-3', 'vk');
    assert.equal(panel.querySelector('[data-variant-card]').dataset.variantCard, '71');
    assert.match(panel.querySelector('[data-variant-card]').textContent, /Текущая версия \(содержимое v2\) перенесена в черновик №71 · опубликован/);
    assert.match(panel.querySelector('[data-variant-history] summary').textContent, /\(1\)/);
    assert.equal(panel.querySelector('[data-variant-transfer]'), null);
  } finally { g.close(); }
});

// ---------- CF26-R2: поздние ответы старой отрисовки и фокус после штатного переключения компании ----------
const gated = () => { let release; const gate = new Promise((resolve) => { release = resolve; }); return {gate, release}; };
const planReads = (f) => f.calls.filter((call) => call.method === 'GET' && call.path === '/media-mentor').length;

test('CF26-R2 поздний перенос после перерисовки по фокусу: новая форма и несохранённая правка на месте, план не перечитан, повтора нет', async () => {
  const f = fixture();
  try {
    await f.render();
    const {gate, release} = gated();
    f.srv.hooks.transfer = async (call) => { await gate; return f.srv.transfer(call.body); };
    f.panel('idea-3', 'vk').querySelector('[data-variant-transfer]').click(); await settle();
    f.w.location.hash = '#content-factory/plan/proposals?company=alvi&idea=idea-3&platform=vk';
    await f.render();
    typeText(f, f.panel('idea-4', 'telegram'), 'Новая несохранённая правка');
    const area = f.panel('idea-4', 'telegram').querySelector('[data-variant-field="text"]');
    const reads = planReads(f);
    release(); await settle();
    assert.equal(area.isConnected, true, 'поздний ответ не заменил текущую форму');
    assert.equal(area.value, 'Новая несохранённая правка');
    assert.equal(planReads(f), reads, 'план не перечитан');
    assert.equal(f.writes().length, 1, 'перенос не повторён');
    assert.equal(f.node.querySelector('.mentor-focus').dataset.ideaId, 'idea-3', 'фокус текущей отрисовки не тронут');
    const line = f.panel('idea-3', 'vk').querySelector('[data-variant-transfer-line]').textContent;
    assert.match(line, /^Перенесено: черновик №81 · сейчас: черновик\..*Ответ пришёл после того, как раздел открыли заново: план не перечитан, правки формы на месте\.$/);
    assert.equal(f.panel('idea-3', 'vk').querySelector('[data-variant-transfer]').disabled, true, 'второй перенос этой версии не предлагается');
  } finally { f.close(); }
});

test('CF26-R2 позднее свежее чтение карточки после перерисовки: форма и правка на месте, план не перечитан', async () => {
  const f = fixture();
  try {
    await f.render();
    const {gate, release} = gated();
    f.srv.hooks.post = async () => { await gate; return undefined; };
    f.panel('idea-3', 'vk').querySelector('[data-variant-transfer]').click(); await settle();
    assert.equal(f.srv.transfers.length, 1, 'перенос выполнен, ждём свежего чтения');
    f.w.location.hash = '#content-factory/plan/proposals?company=alvi&idea=idea-5&platform=telegram';
    await f.render();
    typeText(f, f.panel('idea-5', 'telegram'), 'Правка во время чтения карточки');
    const area = f.panel('idea-5', 'telegram').querySelector('[data-variant-field="text"]');
    const reads = planReads(f);
    release(); await settle();
    assert.equal(area.isConnected, true);
    assert.equal(area.value, 'Правка во время чтения карточки');
    assert.equal(planReads(f), reads, 'позднее свежее чтение не перечитывает план');
    assert.equal(f.writes().length, 1);
    assert.equal(f.node.querySelector('.mentor-focus').dataset.ideaId, 'idea-5');
  } finally { f.close(); }
});

test('CF26-R2 A→B→A: поздний перенос прежней отрисовки той же компании не трогает новую форму; расписка сохранена у версии', async () => {
  const f = fixture();
  try {
    await f.render();
    const {gate, release} = gated();
    f.srv.hooks.transfer = async (call) => { await gate; f.srv.code = 'alvi'; const out = f.srv.transfer(call.body); f.srv.code = f.ctx.selectedProjectId; return out; };
    f.panel('idea-3', 'vk').querySelector('[data-variant-transfer]').click(); await settle();
    f.ctx.chooseProject('beta'); await settle();
    f.ctx.chooseProject('alvi'); await settle();
    assert.equal(f.ctx.selectedProjectId, 'alvi');
    typeText(f, f.panel('idea-2', 'vk'), 'Правка после возврата в компанию');
    const area = f.panel('idea-2', 'vk').querySelector('[data-variant-field="text"]');
    const reads = planReads(f);
    release(); await settle();
    assert.equal(area.isConnected, true, 'та же компания, но другая отрисовка — форма не заменена');
    assert.equal(area.value, 'Правка после возврата в компанию');
    assert.equal(planReads(f), reads);
    assert.equal(f.writes().length, 1, 'перенос не повторён');
    assert.match(f.panel('idea-3', 'vk').querySelector('[data-variant-transfer-line]').textContent, /^Перенесено: черновик №81/);
  } finally { f.close(); }
});

test('CF26-R2 поздний ответ сохранения плана после A→B→A не перечитывает план и не стирает новую правку', async () => {
  const f = fixture();
  try {
    await f.render();
    const {gate, release} = gated();
    f.srv.hooks.any = async (call) => { if (call.method === 'PUT' && call.path === '/media-mentor/plan') { await gate; return {ok: true}; } return undefined; };
    typeText(f, f.panel('idea-1', 'telegram'), 'Сохраняемый текст');
    f.node.querySelector('#mentor-plan-form').dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true})); await settle();
    // Пока форма занята сохранением, правки в ней невозможны; раздел перерисовывается сменой компании A→B→A.
    f.ctx.chooseProject('beta'); await settle();
    f.ctx.chooseProject('alvi'); await settle();
    typeText(f, f.panel('idea-2', 'telegram'), 'Новая правка после перерисовки');
    const area = f.panel('idea-2', 'telegram').querySelector('[data-variant-field="text"]');
    const reads = planReads(f);
    release(); await settle();
    assert.equal(area.isConnected, true);
    assert.equal(area.value, 'Новая правка после перерисовки');
    assert.equal(planReads(f), reads);
  } finally { f.close(); }
});

test('CF26-R2 фокус другой компании сохраняется после переноса и сохранения, сбрасывается при открытии без фокуса и при смене компании', async () => {
  const f = fixture({hash: '#content-factory/plan/proposals?company=beta&idea=idea-3&platform=vk'});
  try {
    await f.render();
    assert.equal(f.ctx.selectedProjectId, 'beta');
    assert.equal(f.w.location.hash, '#content-factory/plan/proposals', 'оболочка очистила параметры адреса');
    assert.equal(f.node.querySelector('.mentor-focus').dataset.ideaId, 'idea-3');
    f.panel('idea-3', 'vk').querySelector('[data-variant-transfer]').click(); await settle();
    assert.equal(f.calls.at(-1).path, '/media-mentor', 'план перечитан');
    assert.equal(f.node.querySelector('.mentor-focus')?.dataset.ideaId, 'idea-3', 'фокус после переноса');
    assert.equal(f.panel('idea-3', 'vk').hidden, false);
    f.srv.hooks.any = async (call) => (call.method === 'PUT' && call.path === '/media-mentor/plan' ? {ok: true} : undefined);
    f.node.querySelector('#mentor-plan-form').dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true})); await settle();
    assert.equal(f.node.querySelector('.mentor-focus')?.dataset.ideaId, 'idea-3', 'фокус после сохранения');
    f.srv.hooks.any = null;
    // Открытие раздела без фокуса сбрасывает хранимый фокус.
    await f.render();
    assert.equal(f.node.querySelector('.mentor-focus'), null);
    assert.equal(f.node.querySelector('[data-plan-focus]'), null);
  } finally { f.close(); }
  const g = fixture({hash: '#content-factory/plan/proposals?company=beta&idea=idea-3&platform=vk'});
  try {
    await g.render();
    g.ctx.chooseProject('alvi'); await settle();
    assert.equal(g.node.querySelector('.mentor-focus'), null, 'в другую компанию фокус не переносится');
    g.ctx.chooseProject('beta'); await settle();
    assert.equal(g.node.querySelector('.mentor-focus'), null, 'после смены компании фокус сброшен');
    assert.equal(g.writes().length, 0);
  } finally { g.close(); }
});

// ---------- CF26-R3: поздний ответ самого плана и расписка другой версии ----------
const holdPlanGet = (f) => { const {gate, release} = gated(); let reading = false;
  f.srv.hooks.any = async (call) => { if (call.path === '/media-mentor' && call.method === 'GET') { reading = true; await gate; f.srv.hooks.any = null; return f.srv.payload(); } return undefined; };
  return {release, reading: () => reading}; };

test('CF26-R3 поздний план после переноса: правка и новый фокус, появившиеся во время чтения плана, остаются', async () => {
  const f = fixture();
  try {
    await f.render();
    const hold = holdPlanGet(f);
    f.panel('idea-3', 'vk').querySelector('[data-variant-transfer]').click(); await settle();
    assert.equal(hold.reading(), true, 'перенос выполнен, план перечитывается');
    typeText(f, f.panel('idea-4', 'telegram'), 'Правка во время чтения плана');
    f.w.location.hash = '#content-factory/plan/proposals?company=alvi&idea=idea-4&platform=telegram';
    f.view.render(f.node, f.ctx); await settle();
    const area = f.panel('idea-4', 'telegram').querySelector('[data-variant-field="text"]');
    hold.release(); await settle();
    assert.equal(area.isConnected, true, 'ответ плана не заменил форму');
    assert.equal(area.value, 'Правка во время чтения плана');
    assert.equal(f.node.querySelector('.mentor-focus').dataset.ideaId, 'idea-4', 'текущий фокус, а не захваченный при переносе');
    assert.match(f.panel('idea-3', 'vk').querySelector('[data-variant-transfer-line]').textContent,
      /^Перенесено: черновик №81 · сейчас: черновик\..*План не перечитан: после начала действия в форме появились правки/);
    assert.equal(f.writes().length, 1);
  } finally { f.close(); }
});

test('CF26-R3 поздний план после сохранения: правка брифа и новый фокус во время чтения остаются, поля освобождены, причина названа', async () => {
  const f = fixture();
  try {
    await f.render();
    const {gate, release} = gated();
    f.srv.hooks.any = async (call) => {
      if (call.method === 'PUT') return {ok: true};
      if (call.path === '/media-mentor' && call.method === 'GET') { await gate; return f.srv.payload(); }
      return undefined;
    };
    typeText(f, f.panel('idea-1', 'telegram'), 'Сохраняемый текст');
    f.node.querySelector('#mentor-plan-form').dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true})); await settle();
    // Сохранение принято, план перечитывается. Форма плана занята; бриф — нет.
    const goal = f.node.querySelector('#mentor-brief-form [name="goal"]');
    goal.value = 'Цель, набранная во время чтения плана';
    f.w.location.hash = '#content-factory/plan/proposals?company=alvi&idea=idea-5&platform=vk';
    f.view.render(f.node, f.ctx); await settle();
    release(); await settle();
    assert.equal(goal.isConnected, true, 'ответ плана не заменил раздел');
    assert.equal(goal.value, 'Цель, набранная во время чтения плана');
    assert.equal(f.node.querySelector('.mentor-focus').dataset.ideaId, 'idea-5');
    assert.match(f.node.querySelector('#mentor-plan-state').textContent, /^Запрос выполнен\. План не перечитан/);
    assert.equal(f.node.querySelector('#mentor-plan-form [type="submit"]').disabled, false, 'занятые поля освобождены');
  } finally { f.close(); }
});

test('CF26-R3 поздний план после сохранения без новых правок: перечитывание применяется, фокус — текущий на момент ответа', async () => {
  const f = fixture({hash: '#content-factory/plan/proposals?company=alvi&idea=idea-2&platform=telegram'});
  try {
    await f.render();
    const {gate, release} = gated();
    f.srv.hooks.any = async (call) => {
      if (call.method === 'PUT') return {ok: true};
      if (call.path === '/media-mentor' && call.method === 'GET') { await gate; return f.srv.payload(); }
      return undefined;
    };
    typeText(f, f.panel('idea-2', 'telegram'), 'Сохраняемый текст');
    f.node.querySelector('#mentor-plan-form').dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true})); await settle();
    // Переход по фокусу при занятой (несохранённой с точки зрения прежнего снимка) форме — без перерисовки и без правок полей.
    f.w.location.hash = '#content-factory/plan/proposals?company=alvi&idea=idea-6&platform=vk';
    f.view.render(f.node, f.ctx); await settle();
    release(); await settle();
    assert.equal(f.node.querySelector('#mentor-plan-state').textContent, '', 'план перечитан, нового сообщения нет');
    assert.equal(f.node.querySelector('.mentor-focus').dataset.ideaId, 'idea-6', 'фокус — текущий, не захваченный при сохранении');
    assert.equal(f.panel('idea-6', 'vk').hidden, false);
  } finally { f.close(); }
});

test('CF26-R3 сбой позднего перечитывания: открытая форма не заменяется ошибкой, поля освобождены, причина названа', async () => {
  const f = fixture();
  try {
    await f.render();
    let fail = false;
    f.srv.hooks.any = async (call) => {
      if (call.method === 'PUT') { fail = true; return {ok: true}; }
      if (fail && call.path === '/media-mentor') throw new Error('Failed to fetch');
      return undefined;
    };
    typeText(f, f.panel('idea-2', 'vk'), 'Текст, который отправлен');
    const area = f.panel('idea-2', 'vk').querySelector('[data-variant-field="text"]');
    f.node.querySelector('#mentor-plan-form').dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true})); await settle();
    assert.equal(area.isConnected, true);
    assert.equal(area.value, 'Текст, который отправлен');
    assert.equal(f.node.querySelector('.crm-error'), null, 'форма не заменена сообщением об ошибке');
    assert.match(f.node.querySelector('#mentor-plan-state').textContent, /^Запрос выполнен\. Свежий план загрузить не удалось/);
    assert.equal(area.disabled, false, 'поля освобождены');
  } finally { f.close(); }
  const g = fixture();
  try {
    await g.render();
    let fail = false;
    g.srv.hooks.any = async (call) => {
      if (call.method === 'POST') { fail = true; return undefined; }
      if (fail && call.path === '/media-mentor') throw new Error('Failed to fetch');
      return undefined;
    };
    const area = g.panel('idea-1', 'vk').querySelector('[data-variant-field="text"]');
    g.panel('idea-3', 'vk').querySelector('[data-variant-transfer]').click(); await settle();
    assert.equal(area.isConnected, true);
    assert.equal(g.node.querySelector('.crm-error'), null);
    assert.match(g.panel('idea-3', 'vk').querySelector('[data-variant-transfer-line]').textContent, /^Перенесено: черновик №81.*Свежий план загрузить не удалось/);
    assert.equal(g.writes().length, 1);
  } finally { g.close(); }
});

test('CF26-R3 неизменная форма после переноса перечитывается как раньше, фокус — текущий', async () => {
  const f = fixture({hash: '#content-factory/plan/proposals?company=alvi&idea=idea-3&platform=vk'});
  try {
    await f.render();
    const area = f.panel('idea-3', 'vk').querySelector('[data-variant-field="text"]');
    f.panel('idea-3', 'vk').querySelector('[data-variant-transfer]').click(); await settle();
    assert.equal(area.isConnected, false, 'план перечитан и перерисован');
    assert.equal(f.panel('idea-3', 'vk').querySelector('[data-variant-card]').dataset.variantCard, '81');
    assert.equal(f.node.querySelector('.mentor-focus').dataset.ideaId, 'idea-3');
  } finally { f.close(); }
});

test('CF26-R3 поздняя расписка v1 не попадает в панель сохранённой согласованной v2; v2 остаётся доступной для переноса', async () => {
  const f = fixture();
  try {
    await f.render();
    const {gate, release} = gated();
    f.srv.hooks.post = async () => { await gate; return undefined; };
    f.panel('idea-3', 'vk').querySelector('[data-variant-transfer]').click(); await settle();
    f.srv.days[2].variants.vk.contentRevision = 2; f.srv.planRevision = 2;
    f.w.location.hash = '#content-factory/plan/proposals?company=alvi&idea=idea-3&platform=vk';
    await f.render();
    const panel = f.panel('idea-3', 'vk');
    assert.equal(panel.dataset.variantRevision, '2');
    const button = panel.querySelector('[data-variant-transfer]');
    assert.equal(button.dataset.variantContentRevision, '2');
    release(); await settle();
    assert.doesNotMatch(panel.querySelector('[data-variant-transfer-line]').textContent, /черновик №81/, 'расписка v1 не выдаётся за перенос v2');
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, 'Перенести эту версию в черновик');
    // Расписка v1 сохранена у своей версии: её видно в «Прежних переносах», а v2 переносится отдельно.
    assert.match(panel.querySelector('[data-variant-history]').textContent, /Черновик №81 · содержимое v1/);
    button.click(); await settle();
    assert.deepEqual(f.srv.transfers.map((t) => `${t.contentRevision}|${t.postId}`), ['1|81', '2|82']);
  } finally { f.close(); }
});

// ---------- CF26-R4: загрузка материала к перенесённому черновику ----------
/* Сервер с настоящими материалами карточек: variantTransfer.items и (по желанию) прежняя расписка по дням
   несут mediaUrls и ревизию карточки; PATCH карточки проверяет ревизию (409) и дописывает только присланное. */
const EXISTING = '/content/publishing-assets/existing.png';
function mediaServer({legacy = false, media = [EXISTING]} = {}) {
  const srv = server();
  srv.transfer({planRevision: 1, briefRevision: 2, selection: {ideaId: 'idea-3', platform: 'vk', contentRevision: 1}});
  Object.assign(srv.posts.get(81), {mediaUrls: [...media], revision: 2});
  if (legacy) srv.posts.set(90, {id: 90, companyCode: 'alvi', status: 'draft', revision: 3, mediaUrls: ['/content/publishing-assets/legacy.jpg']});
  const base = srv.payload;
  srv.payload = () => {
    const data = base();
    data.variantTransfer.items = data.variantTransfer.items.map((item) => {
      const post = srv.posts.get(item.postId);
      return {...item, mediaUrls: [...post.mediaUrls], mediaCount: post.mediaUrls.length, hasMedia: post.mediaUrls.length > 0};
    });
    if (legacy) {
      const post = srv.posts.get(90);
      data.transfer.current = {transferredAt: '2026-09-20T10:00:00.000Z', postIds: [90], actorName: 'Влад', planRevision: 1, briefRevision: 2,
        items: [{postId: 90, planDate: '2026-10-01', planPlatform: 'telegram', topic: 'Тема дня 1', format: 'post', role: 'reach', hook: '', mentorNote: '',
          asset: null, postRevision: post.revision, mediaUrls: [...post.mediaUrls], mediaCount: post.mediaUrls.length, hasMedia: true}]};
    }
    return data;
  };
  srv.patches = [];
  srv.patch = (id, body) => {
    const post = srv.posts.get(id);
    if (body.revision !== post.revision) throw httpError(409, 'Карточку уже изменили', 'REVISION_CONFLICT');
    Object.assign(post, {mediaUrls: [...body.mediaUrls], revision: post.revision + 1});
    return JSON.parse(JSON.stringify(post));
  };
  return srv;
}
function uploadFixture(options = {}) {
  const srv = options.srv || mediaServer(options), f = fixture({srv});
  f.uploads = [];
  f.ctx.apiJson = async (path, opts) => { f.uploads.push({path, method: opts.method}); if (f.uploadHook) await f.uploadHook(); return {url: `/content/publishing-assets/new-${f.uploads.length}.png`}; };
  srv.hooks.any = async (call) => {
    const one = call.path.match(/^\/autoposting\/posts\/(\d+)$/);
    if (one && call.method === 'PATCH') { srv.patches.push({id: Number(one[1]), body: call.body, company: call.params.companyCode});
      if (f.patchHook) { const out = await f.patchHook(call); if (out !== undefined) return out; }
      return srv.patch(Number(one[1]), call.body); }
    if (call.path === '/media-mentor' && call.method === 'GET' && f.planHook) return f.planHook(call);
    return undefined;
  };
  f.pick = (postId, name = 'new.png') => { const input = f.node.querySelector(`[data-material-file="${postId}"]`);
    Object.defineProperty(input, 'files', {value: [new f.w.File(['synthetic'], name, {type: 'image/png'})], configurable: true}); };
  f.add = (postId) => f.node.querySelector(`[data-material-add="${postId}"]`);
  f.status = (postId) => f.node.querySelector(`[data-material-state="${postId}"]`).textContent;
  return f;
}
const material = (f, postId) => f.node.querySelector(`[data-material-add="${postId}"]`).closest('li').querySelector('.mentor-material').textContent.replace(/\s+/g, ' ').trim();

test('CF26-R4 загрузка: файл дописывается к материалам версии площадки — её ревизия и копия материалов на момент нажатия', async () => {
  const f = uploadFixture();
  try {
    await f.render();
    assert.match(material(f, 81), /файлов 1/);
    f.pick(81); f.add(81).click(); await settle();
    assert.deepEqual(f.uploads, [{path: '/content/publishing-assets?companyCode=alvi', method: 'POST'}]);
    assert.deepEqual(f.srv.patches, [{id: 81, company: 'alvi', body: {revision: 2, mediaUrls: [EXISTING, '/content/publishing-assets/new-1.png']}}]);
    assert.deepEqual(f.srv.posts.get(81).mediaUrls, [EXISTING, '/content/publishing-assets/new-1.png'], 'прежний файл не потерян');
    assert.match(material(f, 81), /файлов 2/, 'неизменная форма: план перечитан');
    assert.equal(f.add(81).disabled, false, 'новая кнопка с новой ревизией доступна');
    assert.equal(f.add(81).dataset.postRevision, '3');
  } finally { f.close(); }
});

test('CF26-R4 загрузка: прежняя расписка по дням и версии площадок — каждая кнопка берёт материалы своей записи', async () => {
  const f = uploadFixture({legacy: true});
  try {
    await f.render();
    assert.ok(f.add(90).closest('[data-legacy-drafts]')); assert.ok(f.add(81).closest('[data-variant-drafts]'));
    f.pick(90); f.add(90).click(); await settle();
    f.pick(81); f.add(81).click(); await settle();
    assert.deepEqual(f.srv.patches.map((p) => [p.id, p.body.revision, p.body.mediaUrls]), [
      [90, 3, ['/content/publishing-assets/legacy.jpg', '/content/publishing-assets/new-1.png']],
      [81, 2, [EXISTING, '/content/publishing-assets/new-2.png']]]);
  } finally { f.close(); }
});

test('CF26-R4 загрузка: состав материалов неизвестен или ревизия не совпадает — без загрузки и без пустого списка', async () => {
  const f = uploadFixture();
  try {
    const full = f.srv.payload;
    f.srv.payload = () => { const data = full(); data.variantTransfer.items.forEach((item) => { delete item.mediaUrls; }); return data; };
    await f.render();
    f.pick(81); f.add(81).click(); await settle();
    assert.equal(f.uploads.length, 0, 'файл не загружен'); assert.equal(f.srv.patches.length, 0, 'материалы карточки не переписаны');
    assert.match(f.status(81), /Состав материалов этой карточки неизвестен — файл не загружен и не приложен/);
    assert.deepEqual(f.srv.posts.get(81).mediaUrls, [EXISTING]);
  } finally { f.close(); }
  const g = uploadFixture();
  try {
    await g.render();
    g.add(81).dataset.postRevision = '7';
    g.pick(81); g.add(81).click(); await settle();
    assert.equal(g.uploads.length + g.srv.patches.length, 0);
    assert.match(g.status(81), /Состав материалов этой карточки неизвестен/);
  } finally { g.close(); }
});

test('CF26-R4 загрузка: 409 и неизвестный исход приложения — без автоповтора и без чужой записи, план не перечитан', async () => {
  const f = uploadFixture();
  try {
    await f.render();
    f.srv.posts.get(81).revision = 5; // карточку изменили в другом окне
    const reads = planReads(f);
    f.pick(81); f.add(81).click(); await settle();
    assert.equal(f.uploads.length, 1); assert.equal(f.srv.patches.length, 1, 'повтора нет');
    assert.match(f.status(81), /^Карточку уже изменили в другом окне — файл загружен, но не приложен/);
    assert.equal(f.add(81).disabled, true, 'устаревшая ревизия не отправляется ещё раз');
    assert.deepEqual(f.srv.posts.get(81).mediaUrls, [EXISTING]);
    assert.equal(planReads(f), reads);
    assert.deepEqual(f.writes().map((w) => `${w.method} ${w.path}`), ['PATCH /autoposting/posts/81'], 'других черновиков и публикаций нет');
  } finally { f.close(); }
  const g = uploadFixture();
  try {
    await g.render();
    g.patchHook = async () => { throw new Error('Failed to fetch'); };
    g.pick(81); g.add(81).click(); await settle();
    assert.match(g.status(81), /^Не удалось подтвердить, приложен ли файл \(Failed to fetch\)\. Повторно не прикладываем/);
    assert.equal(g.add(81).disabled, true); assert.equal(g.srv.patches.length, 1); assert.equal(g.uploads.length, 1);
  } finally { g.close(); }
});

test('CF26-R4 поздний план после загрузки: правка и новый фокус остаются, сказано, что файл приложен и план не перечитан', async () => {
  const f = uploadFixture();
  try {
    await f.render();
    const hold = gated();
    f.planHook = async () => { await hold.gate; f.planHook = null; return f.srv.payload(); };
    f.pick(81); f.add(81).click(); await settle();
    assert.equal(f.srv.patches.length, 1);
    typeText(f, f.panel('idea-4', 'telegram'), 'Правка во время загрузки');
    f.w.location.hash = '#content-factory/plan/proposals?company=alvi&idea=idea-4&platform=telegram';
    f.view.render(f.node, f.ctx); await settle();
    const area = f.panel('idea-4', 'telegram').querySelector('[data-variant-field="text"]');
    hold.release(); await settle();
    assert.equal(area.isConnected, true); assert.equal(area.value, 'Правка во время загрузки');
    assert.equal(f.node.querySelector('.mentor-focus').dataset.ideaId, 'idea-4');
    assert.match(f.status(81), /^Материал приложен к карточке №81\. План не перечитан: после начала действия в форме появились правки/);
    assert.equal(f.uploads.length, 1); assert.equal(f.srv.patches.length, 1);
  } finally { f.close(); }
});

test('CF26-R4 сбой перечитывания после загрузки: открытая форма не заменяется ошибкой, причина названа', async () => {
  const f = uploadFixture();
  try {
    await f.render();
    const area = f.panel('idea-1', 'vk').querySelector('[data-variant-field="text"]');
    f.planHook = async () => { throw new Error('Failed to fetch'); };
    f.pick(81); f.add(81).click(); await settle();
    assert.equal(area.isConnected, true); assert.equal(f.node.querySelector('.crm-error'), null);
    assert.match(f.status(81), /^Материал приложен к карточке №81\. Свежий план загрузить не удалось/);
    assert.deepEqual(f.srv.posts.get(81).mediaUrls, [EXISTING, '/content/publishing-assets/new-1.png']);
  } finally { f.close(); }
});

test('CF26-R4 неизменная форма после загрузки перечитывается как раньше, фокус — текущий', async () => {
  const f = uploadFixture();
  f.w.location.hash = '#content-factory/plan/proposals?company=alvi&idea=idea-3&platform=vk';
  try {
    await f.render();
    const area = f.panel('idea-3', 'vk').querySelector('[data-variant-field="text"]');
    f.pick(81); f.add(81).click(); await settle();
    assert.equal(area.isConnected, false, 'план перечитан и перерисован');
    assert.equal(f.node.querySelector('.mentor-focus').dataset.ideaId, 'idea-3');
    assert.equal(f.status(81), '');
  } finally { f.close(); }
});

test('CF26-R5 A→B→A и смена компании во время загрузки файла: прежний обработчик не прикладывает файл и не трогает новую форму', async () => {
  const f = uploadFixture();
  try {
    await f.render();
    const hold = gated();
    f.uploadHook = () => hold.gate;
    f.pick(81); f.add(81).click(); await settle();
    f.ctx.chooseProject('beta'); await settle();
    f.ctx.chooseProject('alvi'); await settle();
    typeText(f, f.panel('idea-2', 'vk'), 'Правка после возврата');
    const area = f.panel('idea-2', 'vk').querySelector('[data-variant-field="text"]');
    const reads = planReads(f);
    hold.release(); await settle();
    assert.equal(area.isConnected, true); assert.equal(area.value, 'Правка после возврата');
    assert.equal(planReads(f), reads, 'план не перечитан старым обработчиком');
    assert.equal(f.status(81), '', 'строка новой отрисовки не тронута');
    assert.equal(f.add(81).disabled, false);
    // R5 (FR-081): равенство компании после A→B→A не делает прежнюю отрисовку текущей — PATCH не отправляется.
    assert.equal(f.srv.patches.length, 0, 'после A→B→A прежний обработчик не прикладывает файл');
    assert.deepEqual(f.srv.posts.get(81).mediaUrls, [EXISTING]);
  } finally { f.close(); }
  const g = uploadFixture();
  try {
    await g.render();
    const hold = gated();
    g.uploadHook = () => hold.gate;
    g.pick(81); g.add(81).click(); await settle();
    g.ctx.chooseProject('beta'); await settle();
    hold.release(); await settle();
    assert.equal(g.srv.patches.length, 0, 'после смены компании файл к карточке прежней компании не прикладывается');
    assert.equal(g.node.querySelector('[data-material-state="81"]')?.textContent || '', '');
  } finally { g.close(); }
});

test('CF26-R5 поздний ответ файла после повторного открытия раздела: PATCH не отправляется, новая форма и правка на месте', async () => {
  const f = uploadFixture();
  try {
    await f.render();
    const hold = gated();
    f.uploadHook = () => hold.gate;
    f.pick(81); f.add(81).click(); await settle();
    await f.render(); // неизменная форма — раздел открыт заново
    typeText(f, f.panel('idea-4', 'telegram'), 'Правка после повторного открытия');
    const area = f.panel('idea-4', 'telegram').querySelector('[data-variant-field="text"]');
    const reads = planReads(f);
    hold.release(); await settle();
    assert.equal(f.uploads.length, 1, 'файл загружен один раз');
    assert.equal(f.srv.patches.length, 0, 'прежний обработчик не прикладывает файл');
    assert.equal(area.isConnected, true); assert.equal(area.value, 'Правка после повторного открытия');
    assert.equal(planReads(f), reads, 'план не перечитан');
    assert.equal(f.status(81), '', 'новая отрисовка не называет файл приложенным');
    assert.equal(f.add(81).disabled, false);
  } finally { f.close(); }
});

test('CF26-R5 уже отправленный PATCH после повторного открытия: не повторяется и не перерисовывает новую форму', async () => {
  const f = uploadFixture();
  try {
    await f.render();
    const hold = gated();
    f.patchHook = async () => { await hold.gate; return undefined; };
    f.pick(81); f.add(81).click(); await settle();
    assert.equal(f.srv.patches.length, 1, 'PATCH отправлен до повторного открытия');
    await f.render();
    typeText(f, f.panel('idea-4', 'telegram'), 'Правка во время PATCH');
    const area = f.panel('idea-4', 'telegram').querySelector('[data-variant-field="text"]');
    const reads = planReads(f);
    hold.release(); await settle();
    assert.equal(f.srv.patches.length, 1, 'не повторён');
    assert.deepEqual(f.srv.posts.get(81).mediaUrls, [EXISTING, '/content/publishing-assets/new-1.png'], 'приложен ровно один раз');
    assert.equal(area.isConnected, true); assert.equal(area.value, 'Правка во время PATCH');
    assert.equal(planReads(f), reads, 'прежний обработчик не перечитывает план');
  } finally { f.close(); }
});

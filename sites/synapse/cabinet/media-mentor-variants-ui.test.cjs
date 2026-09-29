const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const {JSDOM} = require('jsdom');
const script = fs.readFileSync(require.resolve('./media-mentor.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

/* Версии площадок в кабинете: компактные вкладки, независимые тексты, адресные решения.
   Проверяется, что закрытая вкладка не теряет текст, что старый план читается без потерь
   и что плановое время названо ориентиром плана, а не очередью публикации. */

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

function fixture({role = 'owner', permissions = ['autoposting.view', 'autoposting.edit'], query} = {}) {
  const dom = new JSDOM('<section id="view"></section>', {url: 'https://test.local', runScripts: 'outside-only'});
  const w = dom.window, node = w.document.getElementById('view'), calls = [];
  const views = {};
  w.SbCabinet = {registerView(name, definition) { views[name] = definition; }};
  w.eval(script);
  const ctx = {
    identity: {role, permissions, csrfToken: 'csrf-token', companies: [{id: 'alvi', name: 'АЛВИ'}]},
    selectedProjectId: 'alvi',
    csrfOptions: (method, body) => ({method, headers: {'X-CSRF-Token': 'csrf-token'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})}),
    crmQuery: async (path, params, opts = {}) => {
      const call = {path, params, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null};
      calls.push(call);
      return query ? query(call) : payload();
    },
  };
  return {dom, w, node, calls, ctx, view: views['media-mentor'], close: () => w.close()};
}
const submit = (w, form) => form.dispatchEvent(new w.Event('submit', {bubbles: true, cancelable: true}));

test('версии площадок показываются вкладками: открыт один текст, а не семь карточек на день', async () => {
  const f = fixture();
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const block = f.node.querySelector('[data-variants="idea-1"]');
    assert.ok(block, 'у идеи есть блок версий');
    assert.equal(block.querySelectorAll('[data-variant-tab]').length, 2, 'по вкладке на площадку');
    const panels = [...block.querySelectorAll('[data-variant]')];
    assert.equal(panels.length, 2);
    assert.equal(panels.filter((panel) => !panel.hidden).length, 1, 'открыт ровно один текст');
    // На весь план: 14 версий, но развёрнутых панелей всего 7 — по одной на идею.
    assert.equal(f.node.querySelectorAll('[data-variant]').length, 14);
    assert.equal([...f.node.querySelectorAll('[data-variant]')].filter((panel) => !panel.hidden).length, 7);
  } finally { f.close(); }
});

test('переключение вкладки не теряет текст закрытой версии при сохранении', async () => {
  const f = fixture();
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const block = f.node.querySelector('[data-variants="idea-1"]');
    const tgText = block.querySelector('[data-variant="telegram"] [data-variant-field="text"]');
    tgText.value = 'ТГ переписали';
    block.querySelector('[data-variant-tab="vk"]').click();
    assert.equal(block.querySelector('[data-variant="telegram"]').hidden, true, 'телеграм закрылся');
    const vkText = block.querySelector('[data-variant="vk"] [data-variant-field="text"]');
    assert.equal(vkText.hidden, false);
    vkText.value = 'ВК переписали';
    const form = f.node.querySelector('#mentor-plan-form');
    submit(f.w, form); await tick(); await tick();
    const call = f.calls.find((item) => item.method === 'PUT' && item.path.endsWith('/plan'));
    assert.ok(call, 'план отправлен');
    const idea = call.body.days.find((day) => day.ideaId === 'idea-1');
    assert.equal(idea.variants.telegram.text, 'ТГ переписали', 'закрытая вкладка сохранила свой текст');
    assert.equal(idea.variants.vk.text, 'ВК переписали');
    assert.equal(call.body.days.length, 7);
  } finally { f.close(); }
});

test('старый план без версий показывается одной версией и сохраняется без потерь', async () => {
  const days = planDays(7, false);
  const f = fixture({query: (call) => payload({}, days)});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const block = f.node.querySelector('[data-variants="idea-1"]');
    assert.equal(block.querySelectorAll('[data-variant]').length, 1, 'ровно одна версия, как и было');
    assert.ok(block.querySelector('[data-variant="telegram"]'));
    submit(f.w, f.node.querySelector('#mentor-plan-form')); await tick(); await tick();
    const call = f.calls.find((item) => item.method === 'PUT' && item.path.endsWith('/plan'));
    const idea = call.body.days.find((day) => day.ideaId === 'idea-1');
    assert.deepEqual(Object.keys(idea.variants), ['telegram'], 'лишние площадки сами не появились');
    assert.equal(idea.topic, 'Тема дня 1');
  } finally { f.close(); }
});

test('решение адресное: версия и вся идея отправляются разными областями', async () => {
  const f = fixture();
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const block = f.node.querySelector('[data-variants="idea-1"]');
    const panel = block.querySelector('[data-variant="telegram"]');
    panel.querySelector('[data-variant-decide="approved"]').click(); await tick(); await tick();
    let call = f.calls.find((item) => item.path.endsWith('/plan/variants/decision'));
    assert.deepEqual([call.body.scope, call.body.ideaId, call.body.platforms, call.body.decision],
      ['variants', 'idea-1', ['telegram'], 'approved']);
    f.calls.length = 0;
    // После решения раздел перерисовывается: кнопки берутся из свежей разметки.
    f.node.querySelector('[data-variants="idea-1"] .mentor-variant-tabs [data-variant-decide="approved"]')
      .click(); await tick(); await tick();
    call = f.calls.find((item) => item.path.endsWith('/plan/variants/decision'));
    assert.equal(call.body.scope, 'idea');
    assert.equal(call.body.platforms, undefined, 'решение по идее площадками не подменяется');
  } finally { f.close(); }
});

test('возврат версии без причины не отправляется и объясняет почему', async () => {
  const f = fixture();
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const panel = f.node.querySelector('[data-variants="idea-1"] [data-variant="telegram"]');
    panel.querySelector('[data-variant-decide="rejected"]').click(); await tick();
    assert.equal(f.calls.filter((item) => item.path.endsWith('/plan/variants/decision')).length, 0);
    assert.match(panel.querySelector('[data-variant-state-line]').textContent, /Укажите, что исправить/);
    panel.querySelector('[data-variant-comment]').value = 'Слишком длинно';
    panel.querySelector('[data-variant-decide="rejected"]').click(); await tick(); await tick();
    const call = f.calls.find((item) => item.path.endsWith('/plan/variants/decision'));
    assert.deepEqual([call.body.decision, call.body.comment], ['rejected', 'Слишком длинно']);
  } finally { f.close(); }
});

test('отзыв согласования отправляется отдельным решением', async () => {
  const days = planDays();
  const f = fixture({query: () => payload({variants: statesFor(days, {'idea-1|telegram': 'approved'})}, days)});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const panel = f.node.querySelector('[data-variants="idea-1"] [data-variant="telegram"]');
    assert.match(f.node.querySelector('[data-variants="idea-1"] [data-variant-tab="telegram"]').textContent, /согласовано/);
    panel.querySelector('[data-variant-decide="withdrawn"]').click(); await tick(); await tick();
    const call = f.calls.find((item) => item.path.endsWith('/plan/variants/decision'));
    assert.deepEqual([call.body.scope, call.body.decision, call.body.platforms],
      ['variants', 'withdrawn', ['telegram']]);
  } finally { f.close(); }
});

test('плановое время версии названо ориентиром плана, а не очередью публикации', async () => {
  const f = fixture();
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const panel = f.node.querySelector('[data-variants="idea-1"] [data-variant="telegram"]');
    assert.ok(panel.querySelector('[data-variant-field="plannedDate"]'));
    assert.ok(panel.querySelector('[data-variant-field="plannedTime"]'));
    assert.ok(panel.querySelector('[data-variant-field="timezone"]'));
    assert.match(panel.textContent, /не очередь\s+публикации|а не очередь публикации/);
    assert.match(panel.textContent, /Автопостинг/);
  } finally { f.close(); }
});

test('порядок материалов меняется кнопками и уходит на сервер в новом порядке', async () => {
  const f = fixture();
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const rows = [...f.node.querySelectorAll('[data-plan-feed] [data-row]')];
    const second = rows[1];
    second.querySelector('[data-move="up"]').click();
    submit(f.w, f.node.querySelector('#mentor-plan-form')); await tick(); await tick();
    const call = f.calls.find((item) => item.method === 'PUT' && item.path.endsWith('/plan'));
    assert.equal(call.body.days[0].ideaId, 'idea-2', 'вторая идея поднялась выше первой');
    assert.equal(call.body.days[1].ideaId, 'idea-1');
    assert.equal(call.body.days.length, 7, 'ни одна идея не потерялась');
  } finally { f.close(); }
});

test('площадка добавляется пустой версией, а не копией чужого текста', async () => {
  const f = fixture();
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const block = f.node.querySelector('[data-variants="idea-1"]');
    // В брифе две площадки, обе уже есть — добавлять нечего.
    assert.equal(block.querySelector('[data-variant-add]'), null);
  } finally { f.close(); }
});

test('идентификатор идеи переживает сохранение и уходит на сервер', async () => {
  const f = fixture();
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    submit(f.w, f.node.querySelector('#mentor-plan-form')); await tick(); await tick();
    const call = f.calls.find((item) => item.method === 'PUT' && item.path.endsWith('/plan'));
    assert.deepEqual(call.body.days.map((day) => day.ideaId),
      ['idea-1', 'idea-2', 'idea-3', 'idea-4', 'idea-5', 'idea-6', 'idea-7']);
  } finally { f.close(); }
});

/* ---------- Блокеры независимой приёмки, раунд 1 (интерфейс) ---------- */

test('несохранённая правка не даёт согласовать и не теряется молча', async () => {
  const f = fixture();
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const panel = f.node.querySelector('[data-variants="idea-1"] [data-variant="telegram"]');
    panel.querySelector('[data-variant-field="text"]').value = 'ТГ: новый текст';
    panel.querySelector('[data-variant-decide="approved"]').click(); await tick(); await tick();
    assert.equal(f.calls.filter((item) => item.path.endsWith('/plan/variants/decision')).length, 0,
      'решение по невидимому серверу тексту не отправляется');
    assert.match(panel.querySelector('[data-variant-state-line]').textContent, /Сначала сохраните план/);
    assert.equal(panel.querySelector('[data-variant-field="text"]').value, 'ТГ: новый текст',
      'введённый текст остался в форме');
    // То же для идеи, всего плана и переноса.
    const block = f.node.querySelector('[data-variants="idea-1"]');
    block.querySelector('.mentor-variant-tabs [data-variant-decide="approved"]').click(); await tick();
    const planActions = f.node.querySelector('[data-plan-variants]');
    planActions.querySelector('[data-variant-decide="approved"]').click(); await tick();
    f.node.querySelector('[data-variants-transfer]')?.click(); await tick();
    assert.equal(f.calls.filter((item) => /variants\/(decision|transfer)/.test(item.path)).length, 0);
    assert.match(planActions.querySelector('[data-variant-state-line]').textContent, /Сначала сохраните план/);
    // После сохранения решение проходит.
    submit(f.w, f.node.querySelector('#mentor-plan-form')); await tick(); await tick();
    f.calls.length = 0;
    f.node.querySelector('[data-variants="idea-1"] [data-variant="telegram"] [data-variant-decide="approved"]')
      .click(); await tick(); await tick();
    assert.ok(f.calls.find((item) => item.path.endsWith('/plan/variants/decision')));
  } finally { f.close(); }
});

test('добавленная площадка получает свою вкладку, свой лимит и работает без сохранения', async () => {
  const days = planDays(7, false);
  const f = fixture({query: () => payload({}, days)});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const block = f.node.querySelector('[data-variants="idea-1"]');
    const adder = block.querySelector('[data-variant-add]');
    assert.ok(adder, 'вторую площадку можно добавить');
    block.querySelector('[data-variant="telegram"] [data-variant-field="text"]').value = 'ТГ введённый';
    adder.value = 'vk';
    adder.dispatchEvent(new f.w.Event('change', {bubbles: true}));
    const vk = block.querySelector('[data-variant="vk"]');
    assert.ok(vk, 'панель новой площадки создана');
    assert.equal(vk.hidden, false, 'и сразу открыта');
    assert.equal(vk.querySelector('[data-variant-field="text"]').getAttribute('maxlength'), '16000',
      'лимит взят у ВКонтакте, а не у Telegram');
    assert.equal(vk.querySelector('[data-variant-field="text"]').value, '', 'чужой текст не скопирован');
    assert.match(vk.querySelector('[data-variant-text-label]').textContent, /ВКонтакте/);
    const tab = block.querySelector('[data-variant-tab="vk"]');
    assert.ok(tab, 'вкладка новой площадки появилась');
    assert.equal(adder.querySelector('option[value="vk"]'), null, 'дважды одну площадку не добавить');
    // Переключение туда и обратно работает сразу, без сохранения.
    vk.querySelector('[data-variant-field="text"]').value = 'ВК введённый';
    block.querySelector('[data-variant-tab="telegram"]').click();
    assert.equal(block.querySelector('[data-variant="telegram"]').hidden, false);
    assert.equal(vk.hidden, true);
    tab.click();
    assert.equal(vk.hidden, false, 'к новой версии можно вернуться до сохранения');
    // Сохранение уносит обе версии со всеми введёнными полями.
    submit(f.w, f.node.querySelector('#mentor-plan-form')); await tick(); await tick();
    const call = f.calls.find((item) => item.method === 'PUT' && item.path.endsWith('/plan'));
    const idea = call.body.days.find((day) => day.ideaId === 'idea-1');
    assert.equal(idea.variants.telegram.text, 'ТГ введённый');
    assert.equal(idea.variants.vk.text, 'ВК введённый');
  } finally { f.close(); }
});

test('у новой строки плана версии добавляются и собираются так же', async () => {
  const f = fixture();
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const before = f.node.querySelectorAll('[data-plan-feed] [data-row]').length;
    f.node.querySelector('[data-add="days"]').click(); await tick();
    const rows = [...f.node.querySelectorAll('[data-plan-feed] [data-row]')];
    assert.equal(rows.length, before + 1, 'материал добавлен');
    const fresh = rows[rows.length - 1];
    const block = fresh.querySelector('[data-variants]');
    assert.ok(block, 'у новой строки есть блок версий');
    const adder = block.querySelector('[data-variant-add]');
    assert.ok(adder, 'первую версию новой идеи можно добавить');
    adder.value = 'telegram';
    adder.dispatchEvent(new f.w.Event('change', {bubbles: true}));
    const panel = block.querySelector('[data-variant="telegram"]');
    assert.ok(panel, 'панель создана, хотя копировать было не с чего');
    panel.querySelector('[data-variant-field="text"]').value = 'Текст новой идеи';
    fresh.querySelector('[data-field="date"]').value = '2026-10-08';
    fresh.querySelector('[data-field="topic"]').value = 'Новая тема';
    fresh.querySelector('[data-field="platform"]').value = 'telegram';
    submit(f.w, f.node.querySelector('#mentor-plan-form')); await tick(); await tick();
    const call = f.calls.find((item) => item.method === 'PUT' && item.path.endsWith('/plan'));
    const added = call.body.days.at(-1);
    assert.equal(added.topic, 'Новая тема');
    assert.equal(added.ideaId, undefined, 'идентификатор новой идеи выдаёт сервер');
    assert.equal(added.variants.telegram.text, 'Текст новой идеи');
  } finally { f.close(); }
});

test('кнопка «ниже» меняет материалы датами и план уходит по возрастанию дат', async () => {
  const f = fixture();
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const rows = [...f.node.querySelectorAll('[data-plan-feed] [data-row]')];
    rows[0].querySelector('[data-move="down"]').click();
    submit(f.w, f.node.querySelector('#mentor-plan-form')); await tick(); await tick();
    const call = f.calls.find((item) => item.method === 'PUT' && item.path.endsWith('/plan'));
    const dates = call.body.days.map((day) => day.date);
    assert.deepEqual([...dates].sort(), dates, 'сервер получает дни по возрастанию даты');
    assert.deepEqual(dates.slice(0, 2), ['2026-10-01', '2026-10-02'], 'набор дат не изменился');
    assert.deepEqual(call.body.days.slice(0, 2).map((day) => day.ideaId), ['idea-2', 'idea-1'],
      'материалы действительно поменялись местами, идентификаторы сохранились');
    assert.equal(call.body.days.length, 7);
    assert.equal(call.body.days[1].variants.telegram.text, 'ТГ текст 1',
      'версии переехали вместе со своей идеей');
  } finally { f.close(); }
});

test('весь план согласуется одной кнопкой и переносится в независимые черновики', async () => {
  const days = planDays();
  const f = fixture({query: () => payload({
    variants: statesFor(days, Object.fromEntries(days.flatMap((day) => Object.keys(day.variants)
      .map((platform) => [`${day.ideaId}|${platform}`, 'approved'])))),
    variantTransfer: {planRevision: 1, briefRevision: 2, approvedCount: 14, awaitingTransfer: 14,
      canTransfer: true, blockedReason: '', items: [], notice: 'Только черновики.',
      createsPublications: false, schedules: false, choosesChannels: false},
  }, days)});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const block = f.node.querySelector('[data-plan-variants]');
    assert.match(block.textContent, /согласовано 14/);
    assert.match(block.textContent, /материал в «Автопостинге» всё равно одобряется отдельно/);
    block.querySelector('[data-variant-decide="approved"][data-variant-scope="plan"]').click();
    await tick(); await tick();
    const decision = f.calls.find((item) => item.path.endsWith('/plan/variants/decision'));
    assert.equal(decision.body.scope, 'plan');
    assert.equal(decision.body.ideaId, undefined, 'для всего плана идея не указывается');
    f.calls.length = 0;
    f.node.querySelector('[data-variants-transfer]').click(); await tick(); await tick();
    const transfer = f.calls.find((item) => item.path.endsWith('/plan/variants/transfer'));
    assert.ok(transfer, 'перенос версий вызывается именно своим маршрутом');
    assert.deepEqual([transfer.method, transfer.body.planRevision, transfer.body.briefRevision],
      ['POST', 1, 2]);
  } finally { f.close(); }
});

test('расписка переноса показывается у своей версии, а не по номеру дня', async () => {
  const days = planDays();
  const f = fixture({query: () => payload({
    variantTransfer: {planRevision: 1, briefRevision: 2, approvedCount: 1, awaitingTransfer: 0,
      canTransfer: false, blockedReason: 'Все согласованные версии уже перенесены',
      items: [{ideaId: 'idea-3', platform: 'vk', contentRevision: 1, postId: 77,
        cardStatus: 'draft', hasMedia: false, planDate: '2026-10-03'}],
      notice: '', createsPublications: false, schedules: false, choosesChannels: false},
  }, days)});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const mine = f.node.querySelector('[data-variants="idea-3"] [data-variant="vk"] [data-variant-card]');
    assert.equal(mine.dataset.variantCard, '77');
    assert.match(mine.textContent, /черновик №77/);
    assert.match(mine.textContent, /после отдельного одобрения материала/);
    const other = f.node.querySelector('[data-variants="idea-3"] [data-variant="telegram"] [data-variant-card]');
    assert.equal(other.dataset.variantCard, '', 'соседней версии чужая расписка не приписывается');
    const another = f.node.querySelector('[data-variants="idea-1"] [data-variant="vk"] [data-variant-card]');
    assert.equal(another.dataset.variantCard, '');
    assert.equal(f.node.querySelector('[data-variants-transfer]').disabled, true,
      'переносить нечего — кнопка не обещает действия');
  } finally { f.close(); }
});

test('редактору кнопки решений не рисуются, но тексты версий он правит', async () => {
  const f = fixture({role: 'editor'});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    assert.equal(f.node.querySelector('[data-variant-decide]'), null, 'решений редактору не предлагают');
    assert.match(f.node.querySelector('[data-variants="idea-1"] [data-variant-readonly]').textContent,
      /Решения по версиям принимает владелец кабинета/);
    assert.ok(f.node.querySelector('[data-variants="idea-1"] [data-variant-field="text"]'),
      'правка текста редактору доступна');
    assert.ok(f.node.querySelector('[data-variants-transfer]'), 'перенос — это правка карточек, он доступен');
  } finally { f.close(); }
});

test('читателю тексты версий видны, а кнопок решений и правки нет', async () => {
  const f = fixture({role: 'viewer', permissions: ['autoposting.view']});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const panel = f.node.querySelector('[data-variants="idea-1"] [data-variant="telegram"]');
    assert.ok(panel, 'версии видны на чтение');
    assert.match(panel.querySelector('[data-variant-text]').textContent, /ТГ текст 1/);
    assert.equal(panel.querySelector('[data-variant-field="text"]'), null, 'править нельзя');
    assert.equal(f.node.querySelector('[data-variant-decide]'), null);
    assert.equal(f.node.querySelector('[data-variants-transfer]'), null);
    assert.equal(f.node.querySelector('[data-variant-add]'), null);
  } finally { f.close(); }
});

/* ---------- Раунд 2: интеграция со старым путём согласования и переноса ---------- */

const LEGACY_TRANSFER = {planRevision: 1, briefRevision: 2, approvalStatus: 'pending',
  canTransfer: true, blockedReason: '', current: null, notice: 'Только черновики.',
  target: 'autoposting-drafts', createsPublications: false, schedules: false, choosesChannels: false,
  leavesUnfilled: ['Текст поста'], previousTransfers: 0, repeatProtection: 'В пределах версии',
  newVersionNotice: '', awaitingMaterial: 0, materialUploadPath: '/content/publishing-assets',
  materialNotice: 'Материал — это файл.', history: []};
const variantReceipt = (patch = {}) => ({ideaId: 'idea-1', platform: 'telegram', contentRevision: 1,
  planRevision: 1, briefRevision: 2, planDate: '2026-10-01', plannedDate: '', plannedTime: '',
  planTimezone: '', planAssetId: 'a1', postId: 501, transferredAt: '2026-09-19T09:00:00.000Z',
  actorName: 'Владелец', cardStatus: 'draft', postRevision: 2, mediaUrls: [], mediaCount: 0,
  hasMedia: false, ...patch});
const withReceipts = (items, extra = {}) => {
  const days = planDays();
  return payload({transfer: {...LEGACY_TRANSFER, ...(extra.transfer || {})},
    variantTransfer: {planRevision: 1, briefRevision: 2, approvedCount: items.length,
      awaitingTransfer: 0, canTransfer: false, blockedReason: 'Все согласованные версии уже перенесены',
      items, notice: '', createsPublications: false, schedules: false, choosesChannels: false},
    variants: statesFor(days, Object.fromEntries(items.map((item) => [`${item.ideaId}|${item.platform}`, 'approved']))),
    ...extra.payload}, days);
};

test('после переноса версий старый блок согласования не спорит с новым и уходит в архив', async () => {
  const f = fixture({query: () => withReceipts([variantReceipt()])});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    // Второго набора кнопок согласования нет — решение принимается только по версиям.
    assert.equal(f.node.querySelector('#mentor-decision-form'), null,
      'прежняя форма согласования плана целиком больше не конкурирует с версиями');
    const archive = f.node.querySelector('[data-legacy-approval]');
    assert.ok(archive, 'прежнее согласование осталось читаемым как архив');
    assert.match(archive.textContent, /Согласование ведётся по версиям площадок/);
    assert.equal(archive.querySelector('button'), null, 'в архиве кнопок решений нет');
    // Новый путь на месте.
    assert.ok(f.node.querySelector('[data-plan-variants] [data-variant-decide][data-variant-scope="plan"]'));
  } finally { f.close(); }
});

test('старый блок переноса не предлагает перенести уже перенесённые версии', async () => {
  const f = fixture({query: () => withReceipts([variantReceipt()])});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    assert.equal(f.node.querySelector('#mentor-transfer-form'), null,
      'второй кнопки переноса нет: перенос идёт по версиям');
    const section = f.node.querySelector('.mentor-transfer');
    assert.equal(/Переносить можно только согласованную версию плана/.test(section.textContent), false,
      'старый блок больше не противоречит согласованным версиям');
    assert.match(f.node.querySelector('[data-variant-transfer-here]').textContent,
      /Перенос выполняется в блоке «Версии площадок»/);
    // Черновики версий показаны и принимают файлы.
    const drafts = f.node.querySelector('[data-variant-drafts]');
    assert.ok(drafts, 'черновики версий видны в «Черновиках и файлах»');
    assert.match(drafts.textContent, /черновик №501/);
    assert.ok(drafts.querySelector('[data-material-add="501"]'), 'файл к карточке версии можно приложить');
  } finally { f.close(); }
});

test('шапка карточки показывает черновик версии, медиа и следующее действие', async () => {
  const f = fixture({query: () => withReceipts([
    variantReceipt({hasMedia: true, mediaCount: 1, mediaUrls: ['/content/publishing-assets/alvi/a.jpg']}),
    variantReceipt({platform: 'vk', postId: 502})])});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const row = f.node.querySelector('[data-row][data-idea-id="idea-1"]');
    assert.equal(row.dataset.cardStatus, 'draft', 'состояние берётся у реальных карточек');
    assert.match(row.querySelector('.mentor-day-status').textContent, /№501/);
    assert.match(row.querySelector('.mentor-day-status').textContent, /№502/);
    assert.equal(/Пока только в плане/.test(row.querySelector('.mentor-day-status').textContent), false);
    assert.match(row.querySelector('.mentor-day-status').textContent, /медиа загружено/);
    assert.ok(row.querySelector('.mentor-day-preview-media img, .mentor-day-preview-media video'),
      'превью берётся из карточки, где файл действительно есть');
    assert.match(row.querySelector('.mentor-day-action').textContent, /Проверьте подготовленный материал/);
    // Фильтр состояния знает про черновики, а не только про «Только в плане».
    const statuses = [...f.node.querySelectorAll('[data-plan-filter="status"] option')].map((item) => item.value);
    assert.ok(statuses.includes('draft'), statuses.join(','));
  } finally { f.close(); }
});

test('опубликованная карточка не затирается черновиком соседней версии', async () => {
  const f = fixture({query: () => withReceipts([
    variantReceipt({postId: 601, cardStatus: 'published'}),
    variantReceipt({platform: 'vk', postId: 602, cardStatus: 'draft'})])});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const row = f.node.querySelector('[data-row][data-idea-id="idea-1"]');
    assert.equal(row.dataset.cardStatus, 'published', 'опубликованное состояние не перезаписано черновиком');
    assert.match(row.querySelector('.mentor-day-action').textContent, /опубликован/i);
    assert.equal(row.querySelector('[data-variant-drafts] [data-material-add="601"]'), null);
  } finally { f.close(); }
});

test('неизвестное состояние карточки черновиком не подменяется', async () => {
  const f = fixture({query: () => withReceipts([
    variantReceipt({postId: 701, cardStatus: 'что-то новое'}),
    variantReceipt({platform: 'vk', postId: 702, cardStatus: 'draft'})])});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const row = f.node.querySelector('[data-row][data-idea-id="idea-1"]');
    assert.equal(row.dataset.cardStatus, 'unknown');
    assert.match(row.querySelector('.mentor-day-action').textContent, /Уточните состояние карточки/);
  } finally { f.close(); }
});

test('один и тот же номер карточки не задваивается со старой распиской', async () => {
  const legacyCurrent = {planRevision: 1, briefRevision: 2, dayCount: 1, profileRevision: 1,
    complete: true, transferredAt: '2026-09-18T12:00:00.000Z', actorName: 'Редактор', postIds: [501],
    items: [{dayIndex: 0, planDate: '2026-10-01', planPlatform: 'telegram', postId: 501,
      planAssetId: 'a1', topic: 'Тема дня 1', hook: '', format: 'post', role: 'reach', mentorNote: '',
      asset: null, postRevision: 2, cardStatus: 'draft', mediaUrls: [], mediaCount: 0, hasMedia: false}]};
  const f = fixture({query: () => withReceipts([variantReceipt()],
    {transfer: {current: legacyCurrent, canTransfer: false, blockedReason: 'Эта версия плана уже перенесена'}})});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const row = f.node.querySelector('[data-row][data-idea-id="idea-1"]');
    assert.deepEqual(row.dataset.cardIds.split(' '), ['501'], 'карточка учтена один раз');
    assert.equal((row.querySelector('.mentor-day-status').textContent.match(/№501/g) || []).length, 1);
    // В списке черновиков номер тоже не повторяется.
    assert.ok(f.node.querySelector('[data-legacy-drafts]'), 'старая расписка осталась читаемой');
    assert.equal(f.node.querySelectorAll('[data-material-add="501"]').length, 1);
  } finally { f.close(); }
});

test('контекст черновика версии читается из сохранённых версий, а не из старого адреса', async () => {
  const days = planDays();
  const f = fixture({query: (call) => {
    if (/\/plan\/versions\//.test(call.path)) {
      return {revision: 1, briefRevision: 2, createdAt: '2026-09-18T00:00:00.000Z',
        days: days.map((day) => (day.ideaId === 'idea-1'
          ? {...day, assetId: 'a1', variants: {...day.variants,
            telegram: {...day.variants.telegram, text: 'Сохранённый текст', assetId: ''}}} : day))};
    }
    if (/\/brief\/versions\//.test(call.path)) return {revision: 2, fields: FIELDS};
    return withReceipts([variantReceipt()]);
  }});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const button = f.node.querySelector('[data-variant-context="501"]');
    assert.ok(button, 'у черновика версии есть своя кнопка контекста');
    button.click(); await tick(); await tick(); await tick();
    // Старый адрес расписки по дням не вызывается: для карточки версии он ответил бы «не найдено».
    assert.equal(f.calls.some((item) => /\/plan\/transfer\//.test(item.path)), false);
    assert.ok(f.calls.find((item) => item.path.endsWith('/plan/versions/1')));
    assert.ok(f.calls.find((item) => item.path.endsWith('/brief/versions/2')));
    const body = f.node.querySelector('[data-variant-context-body="501"]');
    assert.match(body.textContent, /Сохранённый текст/);
    assert.match(body.textContent, /Съёмка кабинета/, 'исходник унаследован от идеи');
    assert.match(body.textContent, /Текущие правки формы сюда не попадают/);
  } finally { f.close(); }
});

test('у плана без идентификаторов идей контекст честно сообщает, что идея не найдена', async () => {
  const f = fixture({query: (call) => {
    if (/\/plan\/versions\//.test(call.path)) {
      return {revision: 1, briefRevision: 2, createdAt: '2026-09-18T00:00:00.000Z',
        days: [{date: '2026-10-01', platform: 'telegram', format: 'post', role: 'reach',
          topic: 'Старый план', hook: '', assetId: '', mentorNote: ''}]};
    }
    if (/\/brief\/versions\//.test(call.path)) return {revision: 2, fields: FIELDS};
    return withReceipts([variantReceipt()]);
  }});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    f.node.querySelector('[data-variant-context="501"]').click();
    await tick(); await tick(); await tick();
    const body = f.node.querySelector('[data-variant-context-body="501"]');
    assert.match(body.textContent, /без идентификаторов идей/);
  } finally { f.close(); }
});

test('фильтр площадки находит идею по версии, а не по основной площадке', async () => {
  // Идея в Telegram, версия — для ВКонтакте.
  const days = planDays().map((day, index) => (index === 0
    ? {...day, platform: 'telegram', variants: {vk: day.variants.vk}} : day));
  const f = fixture({query: () => payload({variants: statesFor(days)}, days)});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const filter = f.node.querySelector('[data-plan-filter="platform"]');
    filter.value = 'vk';
    filter.dispatchEvent(new f.w.Event('change', {bubbles: true}));
    const shown = [...f.node.querySelectorAll('[data-plan-feed] [data-row]')].filter((row) => !row.hidden);
    assert.equal(shown.length, 7, 'все идеи с версией для ВКонтакте найдены');
    assert.ok(shown.some((row) => row.dataset.ideaId === 'idea-1'),
      'идея в Telegram с версией для ВКонтакте по этому фильтру находится');
    assert.match(f.node.querySelector('[data-plan-filter-state]').textContent, /Показано 7 из 7/);
  } finally { f.close(); }
});

test('только что добавленная несохранённая версия уже попадает в свой фильтр', async () => {
  const days = planDays(7, false);
  const f = fixture({query: () => payload({}, days)});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const filter = f.node.querySelector('[data-plan-filter="platform"]');
    filter.value = 'vk';
    filter.dispatchEvent(new f.w.Event('change', {bubbles: true}));
    assert.equal([...f.node.querySelectorAll('[data-plan-feed] [data-row]')].filter((row) => !row.hidden).length, 0);
    const block = f.node.querySelector('[data-variants="idea-1"]');
    block.querySelector('[data-variant="telegram"] [data-variant-field="text"]').value = 'ТГ не потерять';
    const adder = block.querySelector('[data-variant-add]');
    adder.value = 'vk';
    adder.dispatchEvent(new f.w.Event('change', {bubbles: true}));
    const shown = [...f.node.querySelectorAll('[data-plan-feed] [data-row]')].filter((row) => !row.hidden);
    assert.deepEqual(shown.map((row) => row.dataset.ideaId), ['idea-1'],
      'несохранённая версия уже видна по своему фильтру');
    // Остальной план и введённые тексты не потеряны.
    assert.equal(f.node.querySelectorAll('[data-plan-feed] [data-row]').length, 7);
    submit(f.w, f.node.querySelector('#mentor-plan-form')); await tick(); await tick();
    const call = f.calls.find((item) => item.method === 'PUT' && item.path.endsWith('/plan'));
    assert.equal(call.body.days.length, 7, 'скрытые фильтром материалы всё равно сохраняются');
    assert.equal(call.body.days[0].variants.telegram.text, 'ТГ не потерять');
    assert.equal(call.body.days[0].variants.vk.text, '');
  } finally { f.close(); }
});

test('обмен датами двигает плановую дату версии, совпадавшую с датой идеи', async () => {
  const days = planDays().map((day, index) => (index === 0
    ? {...day, variants: {...day.variants,
      telegram: {...day.variants.telegram, plannedDate: '2026-10-01'},
      vk: {...day.variants.vk, plannedDate: '2026-11-20'}}} : day));
  const f = fixture({query: () => payload({variants: statesFor(days)}, days)});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const row = f.node.querySelector('[data-row][data-idea-id="idea-1"]');
    row.querySelector('[data-move="down"]').click();
    // Версия, державшаяся за дату идеи, переехала вместе с ней.
    assert.equal(row.querySelector('[data-variant="telegram"] [data-variant-field="plannedDate"]').value,
      '2026-10-02');
    // Своя отдельная дата не переписана молча — и о ней сказано прямо.
    assert.equal(row.querySelector('[data-variant="vk"] [data-variant-field="plannedDate"]').value,
      '2026-11-20');
    assert.match(row.querySelector('[data-move-note]').textContent, /своя дата выхода, она не менялась: vk/);
    submit(f.w, f.node.querySelector('#mentor-plan-form')); await tick(); await tick();
    const call = f.calls.find((item) => item.method === 'PUT' && item.path.endsWith('/plan'));
    const moved = call.body.days.find((day) => day.ideaId === 'idea-1');
    assert.equal(moved.date, '2026-10-02');
    assert.equal(moved.variants.telegram.plannedDate, '2026-10-02');
    assert.equal(moved.variants.vk.plannedDate, '2026-11-20');
    const dates = call.body.days.map((day) => day.date);
    assert.deepEqual([...dates].sort(), dates, 'сервер получает дни по возрастанию даты');
  } finally { f.close(); }
});

test('без своих дат перестановка сообщает об этом и ничего не оставляет позади', async () => {
  const f = fixture();
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const row = f.node.querySelector('[data-row][data-idea-id="idea-1"]');
    row.querySelector('[data-move="down"]').click();
    assert.match(row.querySelector('[data-move-note]').textContent,
      /поменялись датами вместе со своими версиями/);
  } finally { f.close(); }
});

test('payload без состояний версий оставляет старый путь согласования нетронутым', async () => {
  const days = planDays();
  const f = fixture({query: () => {
    const base = payload({transfer: {...LEGACY_TRANSFER, approvalStatus: 'approved'}}, days);
    delete base.variants;
    delete base.variantTransfer;
    return base;
  }});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    assert.ok(f.node.querySelector('#mentor-decision-form'), 'прежний путь остаётся для прежних ответов');
    assert.ok(f.node.querySelector('#mentor-transfer-form'));
    assert.equal(f.node.querySelector('[data-legacy-approval]'), null);
  } finally { f.close(); }
});

'use strict';
// CF1: предложения плана внутри Контент-завода — вводные не над планом, бриф свёрнут под планом.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const {JSDOM} = require('jsdom');
const script = fs.readFileSync(require.resolve('./media-mentor.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

const VOCABULARY = {
  platforms: [{id: 'telegram', label: 'Telegram'}, {id: 'vk', label: 'ВКонтакте'}, {id: 'instagram', label: 'Instagram / Reels'}],
  formats: [{id: 'post', label: 'Пост'}, {id: 'reel', label: 'Reels / Shorts / клип'}],
  roles: [{id: 'reach', label: 'Охватный'}, {id: 'sale', label: 'На продажу'}],
  shootingComfort: [{id: 'unknown', label: 'Не выяснено'}, {id: 'hands_only', label: 'Руки и процесс без лица'}],
  assetKinds: [{id: 'photo', label: 'Фото'}, {id: 'video', label: 'Видео'}],
  minDays: 7, maxDays: 14,
};
const FIELDS = {
  goal: 'Записи на массаж <img src=x onerror="throw 1">', product: 'Массаж 60 минут', audience: 'Офисные сотрудники',
  pains: ['Болит спина', 'Нет времени'],
  confirmedFacts: [{id: 'f1', statement: 'Приём 10:00–21:00', source: 'Карточка ЛК'}],
  assets: [{id: 'a1', title: 'Съёмка кабинета', kind: 'photo', note: 'Снято 12.09'}],
  shootingComfort: {level: 'hands_only', notes: 'Лицо не показываем'},
  platforms: ['telegram', 'vk'],
};
const planDays = (count = 7) => Array.from({length: count}, (item, index) => ({
  date: `2026-10-${String(index + 1).padStart(2, '0')}`, platform: 'telegram', format: 'post', role: 'reach',
  topic: `Тема дня ${index + 1}`, hook: '', assetId: 'a1', mentorNote: ''}));

function payload(overrides = {}) {
  return {companyCode: 'alvi',
    notice: 'Согласование версии плана — решение по тексту, а не разрешение публиковать.',
    brief: {revision: 2, updatedAt: '2026-09-18T00:00:00.000Z', fields: FIELDS,
      history: [{revision: 2, createdAt: '2026-09-18T00:00:00.000Z', actorId: 7, actorName: 'Редактор', reason: 'Уточнили боли'}]},
    plan: {revision: 1, briefRevision: 2, updatedAt: '2026-09-18T00:00:00.000Z', days: planDays(),
      startDate: '2026-10-01', endDate: '2026-10-07', windowDays: 7,
      history: [{revision: 1, briefRevision: 2, createdAt: '2026-09-18T00:00:00.000Z', actorId: 7, actorName: 'Редактор', reason: ''}]},
    approval: {planRevision: 1, briefRevision: null, decision: null, decidedAt: null, actorId: null,
      actorName: null, comment: '', status: 'pending', requiresReapproval: true, reason: 'Эта версия плана ещё не согласована'},
    transfer: {planRevision: 1, briefRevision: 2, approvalStatus: 'pending', canTransfer: false,
      blockedReason: 'Переносить можно только согласованную версию плана', current: null,
      notice: 'Перенос создаёт только черновики автопостинга. Публикация не выполняется, в очередь ничего не ставится.',
      target: 'autoposting-drafts', createsPublications: false, schedules: false, choosesChannels: false,
      leavesUnfilled: ['Текст поста', 'Материалы (фото или видео)', 'Каналы публикации', 'Дата и время отправки'],
      previousTransfers: 0, repeatProtection: 'Повтор защищён в пределах одной версии плана',
      newVersionNotice: '', awaitingMaterial: 0, materialUploadPath: '/content/publishing-assets',
      materialNotice: 'Материал — это файл, загруженный существующим приёмом материалов автопостинга.',
      history: []},
    approvals: [], vocabulary: VOCABULARY,
    capabilities: {publishing: false, modelSuggestions: false, httpApi: true, cabinetUi: true,
      planApprovalAuthorizesPublishing: false},
    ...overrides};
}

function fixture({role = 'editor', permissions = ['autoposting.view', 'autoposting.edit'], query} = {}) {
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
  return {dom, w, node, calls, ctx, views, view: views['media-mentor'], close: () => w.close()};
}

test('CF1: план идёт первым, бриф свёрнут под планом, поля брифа и история сохранены', async () => {
  const f = fixture();
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    assert.equal(f.node.querySelector('h2').textContent, 'Предложения плана');
    const plan = f.node.querySelector('.mentor-plan'), brief = f.node.querySelector('details.mentor-brief');
    assert.ok(plan && brief);
    assert.ok(plan.compareDocumentPosition(brief) & f.w.Node.DOCUMENT_POSITION_FOLLOWING, 'бриф ниже плана');
    assert.equal(brief.open, false, 'бриф свёрнут');
    assert.match(brief.querySelector('summary').textContent, /Настройки модуля/);
    assert.ok(brief.querySelector('[name="goal"]'), 'форма брифа сохранена');
    assert.match(brief.textContent, /История брифа/);
    assert.equal(f.node.querySelector('a[href="#content-factory/settings"]'), null, 'приглашения нет, когда бриф заполнен');
    assert.ok(f.calls.every((call) => call.method === 'GET'));
  } finally { f.close(); }
});

test('CF1: пустой бриф — приглашение в «Настройки модуля» над планом, без автоматического раскрытия формы', async () => {
  const empty = {revision: 0, updatedAt: null, history: [], fields: {goal: '', product: '', audience: '', pains: [], confirmedFacts: [], assets: [],
    shootingComfort: {level: 'unknown', notes: ''}, platforms: []}};
  const f = fixture({query: () => payload({brief: empty, plan: null})});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    const invite = f.node.querySelector('a[href="#content-factory/settings"]');
    assert.ok(invite, 'приглашение заполнить вводные');
    const brief = f.node.querySelector('details.mentor-brief');
    assert.equal(brief.open, false);
    assert.ok(invite.compareDocumentPosition(f.node.querySelector('.mentor-plan')) & f.w.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(f.calls.every((call) => call.method === 'GET'), 'ничего не генерируется и не пишется');
  } finally { f.close(); }
});

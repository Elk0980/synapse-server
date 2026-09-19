const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const {JSDOM} = require('jsdom');
const script = fs.readFileSync(require.resolve('./media-mentor-rollout.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

const QUESTIONS = [
  {key: 'usefulness', kind: 'scale', min: 1, max: 5, optional: true,
    title: 'Насколько наставник был полезен за последние 7 дней?', hint: '1 — не помог, 5 — заметно помог'},
  {key: 'blocking', kind: 'text', max: 2000, optional: true, title: 'Что мешает двигаться дальше?', hint: 'Любая помеха'},
  {key: 'improvement', kind: 'text', max: 2000, optional: true, title: 'Что улучшить в работе наставника?', hint: 'Что сделать иначе'},
];
const TRACKS = [
  {key: 'product', title: 'Разработка модуля',
    basis: 'Состояние самого Медиа-наставника. Готовность модуля не означает, что материалы компании собраны.'},
  {key: 'company', title: 'Настройка у клиента',
    basis: 'Что нужно от компании. Заполненность этих этапов не означает, что модуль дописан.'},
];
const stage = (key, track, title, required, extra = {}) => ({key, track, title, required,
  detail: `Описание этапа ${title}`, evidenceHint: 'Чем подтверждается', status: 'not_started',
  statusLabel: 'Не начат', targetDate: null, confirmedOn: null, evidence: '', blocker: '', note: '',
  updatedAt: '2026-09-01T00:00:00.000Z', actorId: null, actorName: '', ...extra});
const track = (key, done, total, percent, extra = {}) => ({track: key, requiredDone: done,
  requiredTotal: total, percent, optionalDone: 0, optionalTotal: 1, blocked: 0,
  label: `${done} из ${total} обязательных этапов дорожки`, basis: `Основание дорожки ${key}`, ...extra});

function payload(overrides = {}) {
  const stages = [
    stage('product_storage', 'product', 'Хранилище брифа и контент-плана', true),
    stage('product_api', 'product', 'HTTP-маршруты брифа и плана', true),
    stage('product_suggestions', 'product', 'Подсказки Хью по плану', false),
    stage('company_brief', 'company', 'Бриф компании', true, {status: 'done', statusLabel: 'Готово',
      confirmedOn: '2026-09-02', targetDate: '2026-09-02',
      evidence: 'Бриф v3 <img src=x onerror="throw 1">', actorName: 'Владелец'}),
    stage('company_assets', 'company', 'Исходники и комфорт съёмки', true, {status: 'in_progress', statusLabel: 'В работе'}),
    stage('company_plan', 'company', 'Контент-план на 7–14 дней', true, {status: 'blocked', statusLabel: 'Блокер',
      blocker: 'Нет доступа к галерее исходников'}),
    stage('company_approval', 'company', 'Согласование плана владельцем', true),
    stage('company_routine', 'company', 'Еженедельный разбор с наставником', false),
  ];
  return {companyCode: 'alvi', revision: 3, startedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z', stages, tracks: TRACKS,
    tracksBasis: 'Дорожки считаются отдельно и никогда не складываются в один процент.',
    progress: {product: track('product', 0, 2, 0), company: track('company', 1, 4, 25, {blocked: 1})},
    nextStep: {
      product: {track: 'product', stageKey: 'product_storage', title: 'Хранилище брифа и контент-плана',
        status: 'not_started', required: true, reason: 'Начать этап', targetDate: null, detail: 'Модуль ещё не отмечен'},
      company: {track: 'company', stageKey: 'company_plan', title: 'Контент-план на 7–14 дней', status: 'blocked',
        required: true, reason: 'Снять блокер', targetDate: null, detail: 'Нет доступа к галерее исходников'}},
    survey: {intervalDays: 7, anchorAt: '2026-09-12T00:00:00.000Z', dueAt: '2026-09-19T00:00:00.000Z',
      due: false, cycleKey: '2026-09-12T00:00:00.000Z', questions: QUESTIONS, lastResponse: null,
      answered: 0, responses: [],
      basis: 'Опрос открывается через 7 дней после последнего ответа и живёт внутри кабинета.'},
    history: [], capabilities: {stageEditing: 'admin', clientAccess: 'autoposting.view', surveyChannel: 'cabinet',
      outboundMessages: false, scheduledReminders: false, modelSuggestions: false},
    ...overrides};
}
const dueSurvey = (overrides = {}) => payload({survey: {...payload().survey, due: true, ...overrides}});

function fixture({role = 'editor', permissions = ['autoposting.view'], query} = {}) {
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
    crmQuery: async (path, params, options = {}) => {
      const call = {path, params, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null};
      calls.push(call);
      return query ? query(call) : payload();
    },
  };
  return {dom, w, node, calls, ctx, views, view: views['media-mentor-rollout'], close: () => w.close()};
}

test('раздел зарегистрирован как настоящий маршрут кабинета', () => {
  const f = fixture();
  try {
    assert.equal(typeof f.view?.render, 'function');
    assert.equal(f.view.title, 'Медиа-наставник');
    assert.equal(typeof f.view.onProjectChange, 'function');
  } finally { f.close(); }
});

test('без права просмотра раздел не запрашивает данные компании', async () => {
  const f = fixture({permissions: []});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    assert.equal(f.calls.length, 0);
    assert.match(f.node.textContent, /Автопостинг: просмотр/);
  } finally { f.close(); }
});

test('клиент видит этапы, знаменатель процента и следующий шаг, но не правит этапы', async () => {
  const f = fixture();
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    assert.deepEqual(f.calls.map((call) => [call.path, call.method, call.params.companyCode]),
      [['/media-mentor-rollout', 'GET', 'alvi']]);
    assert.match(f.node.textContent, /1 из 4/);
    assert.match(f.node.textContent, /25%/);
    assert.match(f.node.textContent, /в процент не входят/);
    assert.match(f.node.textContent, /Снять блокер: Контент-план/);
    assert.match(f.node.textContent, /Нет доступа к галерее исходников/);
    assert.match(f.node.textContent, /Свидетельство готовности:/);
    assert.equal(f.node.querySelectorAll('.mentor-stage').length, 8);
    assert.equal(f.node.querySelector('form[data-stage]'), null);
    assert.match(f.node.textContent, /Этапы ведёт администратор Synapse/);
    // Свидетельство приходит как текст и остаётся текстом.
    assert.equal(f.node.querySelector('img'), null);
    assert.match(f.node.textContent, /Бриф v3 <img src=x/);
  } finally { f.close(); }
});

test('две дорожки показаны раздельно, со своим процентом и своим следующим шагом', async () => {
  const f = fixture();
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    const sections = [...f.node.querySelectorAll('.mentor-track')];
    assert.deepEqual(sections.map((section) => section.dataset.track), ['product', 'company']);
    assert.match(f.node.textContent, /никогда не складываются в один процент/);
    const [product, company] = sections;
    assert.match(product.textContent, /Разработка модуля/);
    assert.match(product.textContent, /0 из 2/);
    assert.match(product.textContent, /Начать этап: Хранилище брифа/);
    assert.match(company.textContent, /Настройка у клиента/);
    assert.match(company.textContent, /1 из 4/);
    assert.match(company.textContent, /Снять блокер: Контент-план/);
    // Ни один процент не показан как общий: полос ровно две, по одной на дорожку.
    assert.equal(f.node.querySelectorAll('.mentor-progress-bar').length, 2);
    assert.equal(product.querySelector('.mentor-progress-bar span').getAttribute('style'), 'width:0%');
    assert.equal(company.querySelector('.mentor-progress-bar span').getAttribute('style'), 'width:25%');
    // Этапы лежат в своей дорожке и не перемешиваются.
    assert.ok([...product.querySelectorAll('.mentor-stage')].length === 3);
    assert.doesNotMatch(product.textContent, /Бриф компании/);
    assert.doesNotMatch(company.textContent, /HTTP-маршруты/);
  } finally { f.close(); }
});

test('нетронутые этапы показываются как «не начат» и не поднимают процент', async () => {
  const f = fixture();
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    const untouched = [...f.node.querySelectorAll('.mentor-stage')].filter(
      (card) => card.dataset.status === 'not_started');
    assert.equal(untouched.length, 5);
    assert.ok(untouched.every((card) => !/Свидетельство готовности/.test(card.textContent)));
  } finally { f.close(); }
});

test('администратор правит этап: готовность требует свидетельства и даты, запрос уходит с версией', async () => {
  const f = fixture({role: 'owner', permissions: [], query: (call) => (call.method === 'GET' ? payload() : payload({revision: 4}))});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    const form = f.node.querySelector('form[data-stage="company_assets"]');
    assert.ok(form);
    form.elements.status.value = 'done';
    form.elements.status.dispatchEvent(new f.w.Event('change'));
    assert.equal(form.elements.evidence.required, true);
    assert.equal(form.elements.confirmedOn.required, true);
    assert.equal(form.elements.blocker.required, false);
    form.elements.evidence.value = 'Фото и видео переданы 18.09';
    form.elements.confirmedOn.value = '2026-09-18';
    form.dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true}));
    await tick();
    const write = f.calls.find((call) => call.method === 'PUT');
    assert.equal(write.path, '/media-mentor-rollout/stages');
    assert.equal(write.params.companyCode, 'alvi');
    assert.equal(write.body.revision, 3);
    assert.deepEqual(write.body.stages, [{key: 'company_assets', status: 'done', targetDate: null,
      confirmedOn: '2026-09-18', evidence: 'Фото и видео переданы 18.09', blocker: '', note: ''}]);
    // Форма блокера скрывается и не уходит вместе с готовностью.
    assert.equal(form.querySelector('[data-blocked]').hidden, true);
  } finally { f.close(); }
});

test('статус «блокер» требует описания и не сохраняет свидетельство готовности', async () => {
  const f = fixture({role: 'owner', permissions: []});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    const form = f.node.querySelector('form[data-stage="company_brief"]');
    assert.equal(form.elements.evidence.value, 'Бриф v3 <img src=x onerror="throw 1">');
    form.elements.status.value = 'blocked';
    form.elements.status.dispatchEvent(new f.w.Event('change'));
    assert.equal(form.elements.blocker.required, true);
    assert.equal(form.elements.evidence.required, false);
    form.elements.blocker.value = 'Владелец не подтвердил факты';
    form.dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true}));
    await tick();
    const write = f.calls.find((call) => call.method === 'PUT');
    assert.deepEqual(write.body.stages, [{key: 'company_brief', status: 'blocked', targetDate: '2026-09-02',
      confirmedOn: null, evidence: '', blocker: 'Владелец не подтвердил факты', note: ''}]);
  } finally { f.close(); }
});

test('закрытый опрос не показывает форму, а называет дату следующего опроса', async () => {
  const answered = payload({survey: {...payload().survey,
    lastResponse: {id: 4, cycleKey: '2026-09-05T00:00:00.000Z', usefulness: 4, blocking: 'Мало времени',
      improvement: 'Больше заготовок', skipped: false, createdAt: '2026-09-12T00:00:00.000Z',
      actorId: 7, actorName: 'Клиент'},
    answered: 1,
    responses: [{id: 4, cycleKey: '2026-09-05T00:00:00.000Z', usefulness: 4, blocking: 'Мало времени',
      improvement: 'Больше заготовок', skipped: false, createdAt: '2026-09-12T00:00:00.000Z',
      actorId: 7, actorName: 'Клиент'}]}});
  const f = fixture({query: () => answered});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    assert.equal(f.node.querySelector('#mentor-survey-form'), null);
    const due = new Date('2026-09-19T00:00:00.000Z')
      .toLocaleDateString('ru-RU', {day: '2-digit', month: '2-digit', year: 'numeric'});
    assert.ok(f.node.textContent.includes(`Следующий опрос откроется ${due}`));
    assert.match(f.node.textContent, /полезность:\s*4 из 5/);
    assert.match(f.node.textContent, /Больше заготовок/);
  } finally { f.close(); }
});

test('открытый опрос принимает три ответа и разрешает пропуск, номер отправки не меняется при повторе', async () => {
  const failures = [];
  const f = fixture({query: (call) => {
    if (call.method === 'POST' && failures.length === 0) { failures.push(call); throw new Error('Сеть недоступна'); }
    return dueSurvey();
  }});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    const form = f.node.querySelector('#mentor-survey-form');
    assert.ok(form);
    assert.equal(form.elements.usefulness.value, '');
    assert.equal(f.node.querySelectorAll('.mentor-scale-options input[type="radio"]').length, 6);
    form.elements.usefulness.value = '5';
    form.elements.blocking.value = '  Не хватает времени  ';
    form.elements.improvement.value = 'Короче созвоны';
    form.dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true}));
    await tick();
    assert.match(f.node.textContent, /Сеть недоступна/);
    form.dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true}));
    await tick();
    const writes = f.calls.filter((call) => call.method === 'POST');
    assert.equal(writes.length, 2);
    assert.equal(writes[0].path, '/media-mentor-rollout/survey');
    assert.equal(writes[0].params.companyCode, 'alvi');
    assert.equal(writes[0].body.cycleKey, '2026-09-12T00:00:00.000Z');
    assert.deepEqual([writes[0].body.usefulness, writes[0].body.blocking, writes[0].body.improvement],
      [5, 'Не хватает времени', 'Короче созвоны']);
    // Повтор той же отправки идёт с тем же номером: сервер отбросит дубль.
    assert.equal(writes[1].body.requestId, writes[0].body.requestId);
    assert.match(writes[0].body.requestId, /^[\w-]{8,100}$/);
  } finally { f.close(); }
});

test('пропуск опроса отправляет пустой ответ отдельным номером', async () => {
  const f = fixture({query: () => dueSurvey()});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    f.node.querySelector('[data-survey-skip]').click();
    await tick();
    const skip = f.calls.find((call) => call.method === 'POST');
    assert.deepEqual([skip.body.usefulness, skip.body.blocking, skip.body.improvement], [null, '', '']);
    assert.match(skip.body.requestId, /-skip$/);
    assert.equal(skip.body.cycleKey, '2026-09-12T00:00:00.000Z');
  } finally { f.close(); }
});

test('ответ прежней компании не рисуется после смены проекта', async () => {
  let finish;
  const f = fixture({query: () => new Promise((resolve) => { finish = resolve; })});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    f.ctx.selectedProjectId = 'avokado';
    finish(payload({stages: payload().stages.map((item) => ({...item, note: 'ЧУЖАЯ КОМПАНИЯ'}))}));
    await tick();
    assert.doesNotMatch(f.node.textContent, /ЧУЖАЯ КОМПАНИЯ/);
    assert.equal(f.node.querySelector('.mentor-stage'), null);
  } finally { f.close(); }
});

test('ответ с чужим кодом компании не показывается как свой', async () => {
  const f = fixture({query: () => payload({companyCode: 'avokado'})});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    assert.match(f.node.textContent, /Ответ другой компании/);
    assert.equal(f.node.querySelector('.mentor-stage'), null);
  } finally { f.close(); }
});

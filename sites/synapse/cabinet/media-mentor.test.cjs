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
const submit = (w, form) => form.dispatchEvent(new w.Event('submit', {bubbles: true, cancelable: true}));

test('раздел зарегистрирован как настоящий маршрут кабинета', () => {
  const f = fixture();
  try {
    assert.equal(typeof f.view?.render, 'function');
    assert.equal(f.view.title, 'Бриф и план');
    assert.equal(typeof f.view.onProjectChange, 'function');
  } finally { f.close(); }
});

test('путь клиента объясняет этапы и пользу вопросов без обещания мгновенных продаж', async () => {
  const f = fixture();
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    const panels = f.node.querySelectorAll('.mentor-journey-grid li');
    assert.equal(panels.length, 6);
    assert.equal(f.node.querySelectorAll('.mentor-journey-grid img[src="/cabinet/mentor-person.svg"]').length, 6);
    assert.match(f.node.querySelector('.mentor-journey').textContent, /не обещание мгновенных продаж/);
    assert.match(f.node.querySelector('.mentor-journey').textContent, /Массаж 60 минут/);
    assert.equal(f.node.querySelector('.mentor-journey-grid img[src="x"]'), null);
    assert.match(f.node.querySelector('[name="goal"]').closest('label').textContent, /Зачем:/);
    assert.match(f.node.querySelector('[name="comfortLevel"]').closest('label').textContent, /без давления/);
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

test('только просмотр: бриф и план видны, форм правки нет', async () => {
  const f = fixture({permissions: ['autoposting.view']});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    assert.deepEqual(f.calls.map((call) => [call.path, call.method, call.params.companyCode]),
      [['/media-mentor', 'GET', 'alvi']]);
    assert.equal(f.node.querySelector('#mentor-brief-form'), null);
    assert.equal(f.node.querySelector('#mentor-plan-form'), null);
    assert.equal(f.node.querySelector('#mentor-decision-form'), null);
    assert.match(f.node.textContent, /Массаж 60 минут/);
    assert.match(f.node.textContent, /Источник: Карточка ЛК/);
    assert.match(f.node.textContent, /Тема дня 1/);
    assert.match(f.node.textContent, /Решение принимает владелец кабинета/);
    // Текст с сервера остаётся текстом.
    assert.equal(f.node.querySelector('.mentor-brief-view img'), null);
    assert.match(f.node.textContent, /Записи на массаж <img src=x/);
  } finally { f.close(); }
});

test('раздел не путает согласование плана с разрешением публиковать', async () => {
  const f = fixture({permissions: ['autoposting.view']});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    assert.match(f.node.textContent, /не разрешение публиковать/);
    assert.match(f.node.textContent, /очередь публикаций не создаётся/);
    assert.doesNotMatch(f.node.textContent, /Опубликовать|Отправить в публикацию/);
  } finally { f.close(); }
});

test('редактор сохраняет бриф целиком: списки, площадки и комфорт съёмки уходят в запрос', async () => {
  const f = fixture();
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    const form = f.node.querySelector('#mentor-brief-form');
    assert.ok(form);
    form.elements.goal.value = 'Новая цель';
    form.elements.pains.value = 'Болит спина\n\nНет времени\n';
    form.querySelector('[data-add="facts"]').click();
    const facts = form.querySelectorAll('[data-rows="facts"] [data-row]');
    assert.equal(facts.length, 2);
    facts[1].querySelector('[data-field="statement"]').value = 'Работаем без выходных';
    facts[1].querySelector('[data-field="source"]').value = 'Сайт компании';
    form.querySelector('input[name="platform"][value="instagram"]').checked = true;
    submit(f.w, form);
    await tick();
    const write = f.calls.find((call) => call.method === 'PUT');
    assert.equal(write.path, '/media-mentor/brief');
    assert.equal(write.params.companyCode, 'alvi');
    assert.equal(write.body.revision, 2);
    assert.equal(write.body.brief.goal, 'Новая цель');
    assert.deepEqual(write.body.brief.pains, ['Болит спина', 'Нет времени']);
    assert.equal(write.body.brief.confirmedFacts.length, 2);
    assert.equal(write.body.brief.confirmedFacts[0].id, 'f1', 'существующий идентификатор сохраняется');
    assert.ok(write.body.brief.confirmedFacts[1].id, 'новому факту выдан идентификатор');
    assert.equal(write.body.brief.confirmedFacts[1].source, 'Сайт компании');
    assert.deepEqual(write.body.brief.assets, FIELDS.assets);
    assert.deepEqual(write.body.brief.shootingComfort, {level: 'hands_only', notes: 'Лицо не показываем'});
    assert.deepEqual(write.body.brief.platforms, ['telegram', 'vk', 'instagram']);
  } finally { f.close(); }
});

test('пустые строки списков не уходят на сервер, а удаление строки работает', async () => {
  const f = fixture();
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    const form = f.node.querySelector('#mentor-brief-form');
    form.querySelector('[data-add="assets"]').click();
    form.querySelector('[data-rows="assets"] [data-row] [data-remove]').click();
    submit(f.w, form);
    await tick();
    const write = f.calls.find((call) => call.method === 'PUT');
    assert.deepEqual(write.body.brief.assets, [], 'исходный исходник удалён, пустая новая строка не отправлена');
  } finally { f.close(); }
});

test('план отправляется с обеими версиями и только с площадками из брифа', async () => {
  const f = fixture();
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    const form = f.node.querySelector('#mentor-plan-form');
    assert.ok(form);
    const firstDay = form.querySelector('[data-rows="days"] [data-row]');
    const platforms = [...firstDay.querySelectorAll('[data-field="platform"] option')].map((option) => option.value);
    assert.deepEqual(platforms, ['telegram', 'vk'], 'Instagram не выбран в брифе и в плане недоступен');
    const assets = [...firstDay.querySelectorAll('[data-field="assetId"] option')].map((option) => option.value);
    assert.deepEqual(assets, ['', 'a1']);
    form.querySelector('[data-add="days"]').click();
    const rows = form.querySelectorAll('[data-rows="days"] [data-row]');
    assert.equal(rows.length, 8);
    rows[7].querySelector('[data-field="date"]').value = '2026-10-08';
    rows[7].querySelector('[data-field="topic"]').value = 'Тема дня 8';
    submit(f.w, form);
    await tick();
    const write = f.calls.find((call) => call.method === 'PUT');
    assert.equal(write.path, '/media-mentor/plan');
    assert.equal(write.body.planRevision, 1);
    assert.equal(write.body.briefRevision, 2);
    assert.equal(write.body.days.length, 8);
    assert.equal(write.body.days[7].date, '2026-10-08');
    assert.equal(write.body.days[7].platform, 'telegram');
  } finally { f.close(); }
});

test('конфликт версий показывается клиенту и не стирает форму', async () => {
  const f = fixture({query: (call) => {
    if (call.method === 'PUT') { const error = new Error('Бриф уже изменили. Обновите страницу.'); error.status = 409; throw error; }
    return payload();
  }});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    const form = f.node.querySelector('#mentor-brief-form');
    submit(f.w, form);
    await tick();
    assert.match(f.node.textContent, /Бриф уже изменили/);
    assert.ok(f.node.querySelector('#mentor-brief-form'), 'форма осталась на месте');
    assert.equal(f.node.querySelector('#mentor-brief-form').elements.goal.disabled, false);
  } finally { f.close(); }
});

test('решение по плану доступно владельцу, отклонение требует комментария', async () => {
  const f = fixture({role: 'owner', permissions: []});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    const form = f.node.querySelector('#mentor-decision-form');
    assert.ok(form);
    const reject = [...form.querySelectorAll('button[name="decision"]')].find((button) => button.value === 'rejected');
    reject.click();
    await tick();
    assert.match(f.node.textContent, /Укажите, что исправить в плане/);
    assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
    form.elements.comment.value = 'Добавьте продающий день';
    reject.click();
    await tick();
    const write = f.calls.find((call) => call.method === 'POST');
    assert.equal(write.path, '/media-mentor/plan/decision');
    assert.deepEqual(write.body, {planRevision: 1, briefRevision: 2, decision: 'rejected',
      comment: 'Добавьте продающий день'});
  } finally { f.close(); }
});

test('устаревший план не даёт решать, пока его не обновили под свежий бриф', async () => {
  const stale = payload({approval: {...payload().approval, status: 'needs_reapproval', requiresReapproval: true,
    reason: 'Бриф изменён до версии 3, план составлен по версии 2.'}});
  stale.brief = {...stale.brief, revision: 3};
  const f = fixture({role: 'owner', permissions: [], query: () => stale});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    assert.equal(f.node.querySelector('#mentor-decision-form'), null);
    assert.match(f.node.textContent, /Нужно пересогласовать/);
    assert.match(f.node.textContent, /Сначала обновите план под свежий бриф/);
  } finally { f.close(); }
});

test('без брифа и без площадок план составить нельзя', async () => {
  for (const [override, message] of [
    [{brief: {revision: 0, updatedAt: null, fields: {...FIELDS, platforms: []}, history: []}, plan: null}, /Сначала сохраните бриф/],
    [{brief: {revision: 1, updatedAt: null, fields: {...FIELDS, platforms: []}, history: []}, plan: null}, /Выберите площадки в брифе/],
  ]) {
    const f = fixture({query: () => payload(override)});
    try {
      f.view.render(f.node, f.ctx);
      await tick();
      assert.equal(f.node.querySelector('#mentor-plan-form'), null);
      assert.match(f.node.textContent, message);
    } finally { f.close(); }
  }
});

const approvedTransfer = (overrides = {}) => payload({
  approval: {...payload().approval, status: 'approved', requiresReapproval: false, reason: '',
    decision: 'approved', briefRevision: 2, decidedAt: '2026-09-18T10:00:00.000Z', actorName: 'Владелец'},
  transfer: {...payload().transfer, canTransfer: true, blockedReason: '', approvalStatus: 'approved', ...overrides}});

test('несогласованный план переносить нельзя: кнопки нет, причина названа', async () => {
  const f = fixture();
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    assert.equal(f.node.querySelector('#mentor-transfer-form'), null);
    assert.match(f.node.textContent, /Переносить можно только согласованную версию плана/);
    assert.match(f.node.textContent, /Остаются незаполненными: Текст поста · Материалы/);
  } finally { f.close(); }
});

test('кнопка переноса шлёт обе версии и говорит, что публикации не будет', async () => {
  const f = fixture({query: (call) => (call.method === 'POST'
    ? {created: true, posts: [], postIds: [10]} : approvedTransfer())});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    const form = f.node.querySelector('#mentor-transfer-form');
    assert.ok(form);
    assert.match(f.node.textContent, /Публикация не выполняется/);
    assert.match(f.node.textContent, /в очередь ничего не ставится/);
    assert.doesNotMatch(f.node.textContent, /Опубликовать|Поставить в очередь|Отправить/);
    submit(f.w, form);
    await tick();
    const write = f.calls.find((call) => call.method === 'POST');
    assert.equal(write.path, '/media-mentor/plan/transfer');
    assert.equal(write.params.companyCode, 'alvi');
    assert.deepEqual(write.body, {planRevision: 1, briefRevision: 2});
  } finally { f.close(); }
});

test('уже перенесённая версия показывает расписку и не предлагает повтор', async () => {
  const f = fixture({query: () => approvedTransfer({canTransfer: false,
    blockedReason: 'Эта версия плана уже перенесена',
    current: {planRevision: 1, briefRevision: 2, dayCount: 2, profileRevision: 1, complete: true,
      transferredAt: '2026-09-18T12:00:00.000Z', actorName: 'Редактор', postIds: [10, 11],
      items: [{dayIndex: 0, planDate: '2026-10-01', planPlatform: 'telegram', postId: 10,
        planAssetId: 'a1', topic: 'Тема дня 1', hook: 'Зацепка 1', format: 'post', role: 'reach',
        mentorNote: 'Заметка 1', asset: {id: 'a1', title: 'Съёмка кабинета', kind: 'photo', note: 'Снято 12.09'},
        postRevision: 3, cardStatus: 'draft', mediaUrls: [], mediaCount: 0, hasMedia: false},
      {dayIndex: 1, planDate: '2026-10-02', planPlatform: 'vk', postId: 11,
        planAssetId: '', topic: 'Тема дня 2', hook: '', format: 'reel', role: 'sale',
        mentorNote: '', asset: null,
        postRevision: 5, cardStatus: 'draft',
        mediaUrls: ['https://synapse.test/content/publishing-assets/alvi/aaaa.jpg'], mediaCount: 1, hasMedia: true}]},
    awaitingMaterial: 1,
    history: [{planRevision: 1, briefRevision: 2, dayCount: 2, transferredAt: '2026-09-18T12:00:00.000Z', actorName: 'Редактор'}]})});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    assert.equal(f.node.querySelector('#mentor-transfer-form'), null);
    assert.match(f.node.textContent, /Эта версия плана уже перенесена/);
    assert.match(f.node.textContent, /01\.10\.2026 ·\s*telegram · черновик №10/);
    assert.match(f.node.textContent, /02\.10\.2026 ·\s*vk · черновик №11/);
    assert.match(f.node.textContent, /Прошлые переносы \(1\)/);
    // Задание дня и исходник видны у самого черновика: искать вручную не нужно.
    assert.match(f.node.textContent, /Тема дня 1/);
    assert.match(f.node.textContent, /Заметка наставника: Заметка 1/);
    assert.match(f.node.textContent, /Исходник из брифа \(описание словами\):\s*Съёмка кабинета · photo/);
    assert.match(f.node.textContent, /Это описание, а не загруженный файл/);
    assert.match(f.node.textContent, /Исходник в плане не указан/);
    // Состояние материала показано отдельно от описания исходника.
    const materials = [...f.node.querySelectorAll('.mentor-material')];
    assert.deepEqual(materials.map((node) => node.dataset.hasMedia), ['no', 'yes']);
    assert.match(materials[0].textContent, /Материал:\s*не добавлен/);
    assert.match(materials[1].textContent, /Материал:\s*добавлен · файлов 1/);
    assert.match(f.node.textContent, /Без файла ждут заданий: 1/);
  } finally { f.close(); }
});

test('материал добавляется существующим приёмом файлов и прикладывается к той же карточке', async () => {
  const transferred = approvedTransfer({canTransfer: false, blockedReason: 'Эта версия плана уже перенесена',
    awaitingMaterial: 1,
    current: {planRevision: 1, briefRevision: 2, dayCount: 1, profileRevision: 1, complete: true,
      transferredAt: '2026-09-18T12:00:00.000Z', actorName: 'Редактор', postIds: [10],
      items: [{dayIndex: 0, planDate: '2026-10-01', planPlatform: 'telegram', postId: 10,
        planAssetId: 'a1', topic: 'Тема дня 1', hook: '', format: 'post', role: 'reach', mentorNote: '',
        asset: {id: 'a1', title: 'Съёмка кабинета', kind: 'photo', note: ''},
        postRevision: 3, cardStatus: 'draft', mediaUrls: [], mediaCount: 0, hasMedia: false}]}});
  const uploads = [];
  const f = fixture({query: () => transferred});
  f.ctx.apiJson = async (path, options) => {
    uploads.push({path, method: options.method, type: options.headers['Content-Type'],
      csrf: options.headers['X-CSRF-Token'], body: options.body});
    return {url: 'https://synapse.test/content/publishing-assets/alvi/bbbb.jpg', sha256: 'abc'};
  };
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    const button = f.node.querySelector('[data-material-add="10"]');
    assert.ok(button);
    // Без выбранного файла ничего не отправляется.
    button.click();
    await tick();
    assert.equal(uploads.length, 0);
    assert.match(f.node.querySelector('[data-material-state="10"]').textContent, /Выберите файл материала/);

    const file = new f.w.File([new Uint8Array([1, 2, 3])], 'photo.jpg', {type: 'image/jpeg'});
    const input = f.node.querySelector('[data-material-file="10"]');
    Object.defineProperty(input, 'files', {value: [file], configurable: true});
    button.click();
    await tick();
    await tick();
    // Загрузка идёт в существующий приём материалов своей компании.
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].path, '/content/publishing-assets?companyCode=alvi');
    assert.equal(uploads[0].method, 'POST');
    assert.equal(uploads[0].type, 'image/jpeg');
    assert.equal(uploads[0].csrf, 'csrf-token');
    assert.equal(uploads[0].body, file);
    // Ссылка дописывается в ту же карточку существующим маршрутом автопостинга.
    const attach = f.calls.find((call) => call.method === 'PATCH');
    assert.equal(attach.path, '/autoposting/posts/10');
    assert.equal(attach.params.companyCode, 'alvi');
    assert.deepEqual(attach.body, {revision: 3,
      mediaUrls: ['https://synapse.test/content/publishing-assets/alvi/bbbb.jpg']});
  } finally { f.close(); }
});

test('без права правки материал добавить нельзя', async () => {
  const transferred = approvedTransfer({canTransfer: false, blockedReason: 'Эта версия плана уже перенесена',
    current: {planRevision: 1, briefRevision: 2, dayCount: 1, profileRevision: 1, complete: true,
      transferredAt: '2026-09-18T12:00:00.000Z', actorName: 'Редактор', postIds: [10],
      items: [{dayIndex: 0, planDate: '2026-10-01', planPlatform: 'telegram', postId: 10,
        planAssetId: '', topic: 'Тема дня 1', hook: '', format: 'post', role: 'reach', mentorNote: '',
        asset: null, postRevision: 3, cardStatus: 'draft', mediaUrls: [], mediaCount: 0, hasMedia: false}]}});
  const f = fixture({permissions: ['autoposting.view'], query: () => transferred});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    assert.equal(f.node.querySelector('[data-material-add="10"]'), null);
    assert.equal(f.node.querySelector('[data-material-file="10"]'), null);
    // Состояние материала при этом видно.
    assert.match(f.node.querySelector('.mentor-material').textContent, /не добавлен/);
  } finally { f.close(); }
});

test('бриф согласованной версии подгружается по кнопке из неизменяемой версии', async () => {
  const transferred = approvedTransfer({canTransfer: false, blockedReason: 'Эта версия плана уже перенесена',
    current: {planRevision: 1, briefRevision: 2, dayCount: 1, profileRevision: 1, complete: true,
      transferredAt: '2026-09-18T12:00:00.000Z', actorName: 'Редактор', postIds: [10],
      items: [{dayIndex: 0, planDate: '2026-10-01', planPlatform: 'telegram', postId: 10,
        planAssetId: 'a1', topic: 'Тема дня 1', hook: '', format: 'post', role: 'reach',
        mentorNote: '', asset: {id: 'a1', title: 'Съёмка кабинета', kind: 'photo', note: ''}}]}});
  const context = {companyCode: 'alvi', postId: 10, planRevision: 1, briefRevision: 2, assetIsMedia: false,
    notice: 'Исходник описан словами — это не готовое медиа.',
    brief: {...FIELDS, audience: 'ПОЛНАЯ АУДИТОРИЯ ИЗ БРИФА'}, decision: {decision: 'approved'}};
  const f = fixture({query: (call) => (/transfer\/10$/.test(call.path) ? context : transferred)});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    assert.doesNotMatch(f.node.textContent, /ПОЛНАЯ АУДИТОРИЯ ИЗ БРИФА/);
    f.node.querySelector('[data-brief-context="10"]').click();
    await tick();
    const request = f.calls.find((call) => /transfer\/10$/.test(call.path));
    assert.equal(request.method, 'GET');
    assert.equal(request.params.companyCode, 'alvi');
    assert.match(f.node.textContent, /ПОЛНАЯ АУДИТОРИЯ ИЗ БРИФА/);
    assert.match(f.node.textContent, /Источник: Карточка ЛК/);
    assert.equal(f.node.querySelector('[data-brief-context-body="10"] img'), null);
  } finally { f.close(); }
});

test('перед переносом новой версии кабинет предупреждает, что старые черновики остаются', async () => {
  const f = fixture({query: () => approvedTransfer({previousTransfers: 1,
    newVersionNotice: 'Перенос новой согласованной версии создаёт новые черновики. Ранее перенесённые черновики остаются в автопостинге как есть.'})});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    assert.ok(f.node.querySelector('#mentor-transfer-form'));
    const warning = f.node.querySelector('.mentor-warning');
    assert.ok(warning);
    assert.match(warning.textContent, /создаёт новые черновики/);
    assert.match(warning.textContent, /остаются в автопостинге как есть/);
    assert.match(f.node.textContent, /Повтор защищён в пределах одной версии плана/);
    assert.doesNotMatch(f.node.textContent, /дубли исключены|защита от дублей/i);
  } finally { f.close(); }
});

test('без права правки кнопки переноса нет даже у согласованного плана', async () => {
  const f = fixture({permissions: ['autoposting.view'], query: () => approvedTransfer()});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    assert.equal(f.node.querySelector('#mentor-transfer-form'), null);
    assert.match(f.node.textContent, /Переносит план тот, у кого есть право правки автопостинга/);
    assert.equal(f.calls.filter((call) => call.method !== 'GET').length, 0);
  } finally { f.close(); }
});

test('отказ сервера на переносе показывается и не выдаётся за успех', async () => {
  const f = fixture({query: (call) => {
    if (call.method === 'POST') { const error = new Error('Версия плана уже изменилась. Обновите страницу.'); error.status = 409; throw error; }
    return approvedTransfer();
  }});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    submit(f.w, f.node.querySelector('#mentor-transfer-form'));
    await tick();
    assert.match(f.node.textContent, /Версия плана уже изменилась/);
    assert.doesNotMatch(f.node.textContent, /Перенесено /);
  } finally { f.close(); }
});

test('ответ прежней компании не рисуется после смены проекта', async () => {
  let finish;
  const f = fixture({query: () => new Promise((resolve) => { finish = resolve; })});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    f.ctx.selectedProjectId = 'avokado';
    finish(payload({brief: {...payload().brief, fields: {...FIELDS, goal: 'ЧУЖАЯ КОМПАНИЯ'}}}));
    await tick();
    assert.doesNotMatch(f.node.textContent, /ЧУЖАЯ КОМПАНИЯ/);
    assert.equal(f.node.querySelector('#mentor-brief-form'), null);
  } finally { f.close(); }
});

test('ответ с чужим кодом компании не показывается как свой', async () => {
  const f = fixture({query: () => payload({companyCode: 'avokado'})});
  try {
    f.view.render(f.node, f.ctx);
    await tick();
    assert.match(f.node.textContent, /Ответ другой компании/);
    assert.equal(f.node.querySelector('#mentor-brief-form'), null);
  } finally { f.close(); }
});

/* Проверка плана по курсу. Модуль правил живёт отдельно; экран показывает его вывод
   и молчит, когда модуля нет — пустой зелёный блок был бы обещанием, которого не давали. */
const rulesScript = fs.readFileSync(require.resolve('./media-mentor-rules.js'), 'utf8');
function withRules(options = {}) {
  const f = fixture(options);
  f.w.eval(rulesScript);
  return f;
}
const reelDay = (date, patch = {}) => ({date, platform: 'telegram', format: 'reel', role: 'reach',
  topic: 'Тема', hook: '', assetId: 'a1', mentorNote: '', ...patch});
const planOf = (days) => payload({plan: {revision: 1, briefRevision: 2,
  updatedAt: '2026-09-18T00:00:00.000Z', days, startDate: days[0].date,
  endDate: days[days.length - 1].date, windowDays: 7, history: []}});

test('план против правил курса показывает замечание с датой', async () => {
  const f = withRules({query: () => planOf([reelDay('2026-09-25')])});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const block = f.node.querySelector('[data-rules]');
    assert.ok(block, 'блок проверки должен появиться');
    assert.match(block.textContent, /25\.09\.2026/);
    assert.match(block.textContent, /худшим/);
    assert.equal(f.node.querySelector('[data-rules-level="violation"]') !== null, true);
  } finally { f.close(); }
});

test('план по правилам курса получает честное «противоречий нет», а не обещание', async () => {
  const f = withRules({query: () => planOf([reelDay('2026-09-20'), reelDay('2026-09-22'), reelDay('2026-09-24')])});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const ok = f.node.querySelector('[data-rules-ok]');
    assert.ok(ok, 'должно быть сказано, что противоречий нет');
    assert.match(ok.textContent, /не обещание просмотров/);
    assert.equal(f.node.querySelector('[data-rules-list]'), null);
  } finally { f.close(); }
});

test('напоминания о решениях человека показаны отдельно от замечаний', async () => {
  const f = withRules({query: () => planOf([reelDay('2026-09-22')])});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    const reminders = f.node.querySelector('[data-rules-reminders]');
    assert.ok(reminders);
    assert.match(reminders.textContent, /субтитры/);
  } finally { f.close(); }
});

test('без модуля правил экран работает и о проверке молчит', async () => {
  const f = fixture({query: () => planOf([reelDay('2026-09-25')])});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    assert.equal(f.node.querySelector('[data-rules]'), null);
    assert.match(f.node.textContent, /Тема/, 'сам план при этом виден');
  } finally { f.close(); }
});

test('без плана блок проверки не показывается', async () => {
  const f = withRules({query: () => payload({plan: null})});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    assert.equal(f.node.querySelector('[data-rules]'), null);
  } finally { f.close(); }
});

test('текст замечания выводится как текст, а не как разметка', async () => {
  const f = withRules({query: () => planOf([reelDay('2026-09-25',
    {topic: '<img src=x onerror="throw 1">'})])});
  try {
    await f.view.render(f.node, f.ctx); await tick(); await tick();
    assert.equal(f.node.querySelector('[data-rules] img'), null);
  } finally { f.close(); }
});

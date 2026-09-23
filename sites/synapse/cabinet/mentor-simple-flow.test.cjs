const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const script = fs.readFileSync(require.resolve('./media-mentor.js'), 'utf8');
const materials = fs.readFileSync(require.resolve('./media-mentor-materials.js'), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));
const freeze = (value) => {Object.freeze(value); Object.values(value).forEach((item) => {if (item && typeof item === 'object') freeze(item);}); return value;};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function example() {
  const dates = ['26', '24', '20', '25', '23', '21', '22'];
  return {companyCode: 'alvi',
    brief: {revision: 2, history: [], fields: {goal: 'Понятно объяснить услугу', product: 'Учебная услуга', audience: 'Учебная аудитория', pains: [], confirmedFacts: [],
      assets: [{id: 'a1', title: 'Фото рабочего места', kind: 'photo', note: 'На телефоне'}],
      shootingComfort: {level: 'unknown', notes: ''}, platforms: ['telegram', 'vk']}},
    plan: {revision: 3, briefRevision: 2, startDate: '2026-09-20', endDate: '2026-09-26', windowDays: 7, history: [],
      days: dates.map((date, index) => ({date: `2026-09-${date}`, platform: index % 2 ? 'vk' : 'telegram', format: 'post', role: 'reach',
        topic: `Тема ${index}`, hook: `Зацепка ${index}`, assetId: '', mentorNote: `Задание ${index}`}))},
    approval: {status: 'approved', requiresReapproval: false, planRevision: 3, briefRevision: 2, decision: 'approved'}, approvals: [], feedback: [],
    transfer: {planRevision: 3, briefRevision: 2, canTransfer: false, blockedReason: 'Уже перенесено', leavesUnfilled: ['Текст', 'Фото'],
      repeatProtection: 'Повтор защищён', notice: 'Перенос создаёт только черновики. Публикация не выполняется.',
      materialNotice: 'Файл добавляется отдельно.', materialUploadPath: '/content/publishing-assets', history: [],
      current: {planRevision: 3, briefRevision: 2, postIds: [100, 101, 102, 103], items: ['published', 'draft', 'failed', 'scheduled'].map((cardStatus, index) =>
        ({dayIndex: index, postId: 100 + index, postRevision: 1, cardStatus, hasMedia: false, mediaUrls: [], mediaCount: 0,
          planDate: `2026-09-${dates[index]}`, planPlatform: index % 2 ? 'vk' : 'telegram', topic: `Тема ${index}`, format: 'post', role: 'reach'}))}},
    vocabulary: {platforms: [{id: 'telegram', label: 'Telegram'}, {id: 'vk', label: 'ВКонтакте'}],
      formats: [{id: 'post', label: 'Пост'}], roles: [{id: 'reach', label: 'Охватный'}],
      shootingComfort: [{id: 'unknown', label: 'Не выяснено'}], assetKinds: [{id: 'photo', label: 'Фото'}], minDays: 7, maxDays: 14}};
}
function fixture({readOnly = false, override, data = example()} = {}) {
  const original = clone(data);
  freeze(data);
  const dom = new JSDOM('<main><section id="view"></section></main>', {url: 'https://demo.test/#media-mentor', runScripts: 'outside-only'});
  const w = dom.window, node = w.document.querySelector('#view'), calls = [], views = {};
  const NativeDate = w.Date;
  const fixed = new NativeDate(2026, 8, 24, 12).getTime();
  w.Date = class extends NativeDate {constructor(...args) {super(...(args.length ? args : [fixed]));} static now() {return fixed;}};
  w.SbCabinet = {registerView(name, view) {views[name] = view;}};
  w.eval(materials); w.eval(script);
  const ctx = {identity: {role: readOnly ? 'editor' : 'owner', permissions: ['autoposting.view'], companies: [{id: 'alvi', name: 'Учебная компания'}]},
    selectedProjectId: 'alvi',
    csrfOptions: (method, body) => ({method, headers: {'X-CSRF-Token': 'test'}, body: JSON.stringify(body)}),
    crmQuery: async (path, params, options = {}) => {
      const call = {path, params, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, headers: options.headers};
      calls.push(call);
      if (override) {const result = await override(call); if (result !== undefined) return result;}
      if (path.endsWith('/feedback')) return {...data, feedback: [{dayIndex: call.body.dayIndex, message: call.body.message, actorName: 'Участник'}]};
      return data;
    }};
  const find = (selector) => node.querySelector(selector);
  const settle = async () => {for (let i = 0; i < 4; i++) await tick();};
  const start = async () => {views['media-mentor'].render(node, ctx); await settle();};
  const filter = (key, value) => {const el = find(`[data-plan-filter="${key}"]`); el.value = value; el.dispatchEvent(new w.Event('change', {bubbles: true}));};
  const rows = () => [...node.querySelectorAll('[data-plan-feed] > [data-row]')];
  const visible = () => rows().filter((row) => !row.hidden);
  const row = (index) => find(`[data-day-index="${index}"]`);
  const input = (index, field, value) => {const el = row(index).querySelector(`[data-field="${field}"]`); el.value = value; el.dispatchEvent(new w.Event('input', {bubbles: true}));};
  return {w, node, calls, data, original, ctx, find, start, filter, rows, visible, row, input, settle, close: () => w.close()};
}

test('лента по умолчанию показывает ближайшие локальные даты, затем прошлые; source dayIndex не меняется', async () => {
  const f = fixture();
  try {
    await f.start();
    assert.deepEqual(f.visible().map((row) => Number(row.dataset.dayIndex)), [1, 3, 0, 4, 6, 5, 2]);
    assert.equal(f.visible().length, 7);
    assert.deepEqual(f.data, f.original);
    assert.ok(f.rows().every((row) => row.dataset.dayIndex === row.dataset.sourceOrder));
    assert.ok(f.calls.every((call) => call.method === 'GET'));
  } finally {f.close();}
});

test('площадка, дата/диапазон и фактический статус фильтруют только видимые карточки', async () => {
  const f = fixture();
  try {
    await f.start(); f.filter('platform', 'vk');
    assert.deepEqual(f.visible().map((row) => Number(row.dataset.dayIndex)), [1, 3, 5]);
    f.filter('from', '2026-09-24'); f.filter('to', '2026-09-24');
    assert.deepEqual(f.visible().map((row) => Number(row.dataset.dayIndex)), [1]);
    f.filter('status', 'draft'); assert.equal(f.visible().length, 1);
    f.filter('status', 'published'); assert.equal(f.visible().length, 0);
    assert.equal(f.find('[data-plan-filter-empty]').hidden, false);
    assert.equal(f.rows().length, 7);
    assert.match(f.find('[data-plan-filter-state]').textContent, /Показано 0 из 7/);
    assert.match(f.find('[data-plan-extra-summary]').textContent, /выбрано 2/);
    const options = [...f.find('[data-plan-filter="status"]').options].map((option) => option.value);
    assert.deepEqual(options.sort(), ['', 'plan', 'published', 'draft', 'failed', 'scheduled'].sort());
    assert.deepEqual(f.data, f.original);
  } finally {f.close();}
});

test('фильтры и сортировка сохраняют те же DOM-узлы, ввод, раскрытие и несохранённую обратную связь', async () => {
  const f = fixture();
  try {
    await f.start(); const row = f.row(2);
    f.input(2, 'topic', 'Несохранённая тема'); f.input(2, 'hook', 'Новая зацепка');
    row.querySelector('[data-feedback-input]').value = 'Пока не отправленное предложение';
    row.querySelector('.mentor-day-details').open = true;
    f.filter('platform', 'vk'); f.filter('order', 'desc'); f.filter('platform', '');
    assert.equal(f.row(2), row);
    assert.equal(row.querySelector('[data-field="topic"]').value, 'Несохранённая тема');
    assert.equal(row.querySelector('[data-field="hook"]').value, 'Новая зацепка');
    assert.equal(row.querySelector('[data-feedback-input]').value, 'Пока не отправленное предложение');
    assert.equal(row.querySelector('.mentor-day-details').open, true);
    assert.deepEqual(f.data, f.original);
  } finally {f.close();}
});

test('сохранение при фильтре отправляет все строки в исходном порядке с исходными версиями', async () => {
  let resolveSave;
  const f = fixture({override: (call) => call.method === 'PUT' ? new Promise((resolve) => {resolveSave = resolve;}) : undefined});
  try {
    await f.start(); f.input(0, 'topic', 'Своя новая тема'); f.filter('platform', 'vk'); f.filter('status', 'draft'); f.filter('order', 'desc');
    assert.equal(f.visible().length, 1);
    f.find('#mentor-plan-form').dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true})); await f.settle();
    const save = f.calls.find((call) => call.path === '/media-mentor/plan' && call.method === 'PUT');
    assert.equal(save.params.companyCode, 'alvi'); assert.equal(save.headers['X-CSRF-Token'], 'test');
    assert.equal(save.body.planRevision, 3); assert.equal(save.body.briefRevision, 2);
    assert.deepEqual(save.body.days, f.original.plan.days.map((item, index) => index ? item : {...item, topic: 'Своя новая тема'}));
    assert.equal(save.body.days.length, 7);
    assert.deepEqual(f.data, f.original);
    resolveSave(f.data); await f.settle();
  } finally {f.close();}
});

test('обратная связь сохраняет исходный dayIndex после сортировки, фильтра и удаления другой строки', async () => {
  const f = fixture();
  try {
    await f.start(); f.row(1).querySelector('[data-remove]').click();
    f.filter('platform', 'telegram'); f.filter('order', 'desc');
    const row = f.row(2); f.input(2, 'topic', 'Правка темы');
    row.querySelector('[data-feedback-input]').value = 'Лучше показать процесс';
    row.querySelector('[data-feedback-send]').click(); await f.settle();
    const sent = f.calls.find((call) => call.path.endsWith('/feedback'));
    assert.deepEqual(sent.body, {planRevision: 3, dayIndex: 2, message: 'Лучше показать процесс'});
    assert.equal(row.querySelector('[data-field="topic"]').value, 'Правка темы');
    assert.match(row.querySelector('[data-feedback-list]').textContent, /Лучше показать процесс/);
    assert.equal(f.rows().length, 6);
    assert.deepEqual(f.data, f.original);
  } finally {f.close();}
});

test('невалидная скрытая новая карточка раскрывается до native submit и не удаляется', async () => {
  const f = fixture();
  try {
    await f.start(); f.find('[data-add="days"]').click();
    const row = f.row(-1);
    f.filter('platform', 'vk'); row.querySelector('.mentor-day-details').open = false;
    assert.equal(row.hidden, true);
    f.find('#mentor-plan-form button[type="submit"]').click(); await f.settle();
    assert.equal(row.hidden, false);
    assert.equal(row.querySelector('.mentor-day-details').open, true);
    assert.equal(f.rows().length, 8);
    assert.match(f.find('#mentor-plan-state').textContent, /Заполните выделенное поле/);
    assert.equal(f.calls.some((call) => call.method === 'PUT'), false);
    assert.equal(f.find('[data-plan-filter="platform"]').value, '');
  } finally {f.close();}
});

test('новый материал при активном фильтре сразу виден и не получает индекс feedback сохранённой версии', async () => {
  const f = fixture();
  try {
    await f.start(); f.filter('status', 'published'); f.find('[data-add="days"]').click();
    const row = f.row(-1);
    assert.equal(row.hidden, false); assert.equal(row.dataset.sourceOrder, '7');
    assert.equal(row.querySelector('[data-feedback-send]'), null);
    assert.equal(row.querySelector('.mentor-day-details').open, true);
    assert.equal(f.find('[data-plan-filter="status"]').value, '');
  } finally {f.close();}
});

test('пустой и обратный диапазон дают понятный результат, сброс возвращает все материалы', async () => {
  const f = fixture();
  try {
    await f.start(); f.filter('from', '2026-10-01');
    assert.equal(f.visible().length, 0); assert.equal(f.find('[data-plan-filter-empty]').hidden, false);
    f.filter('to', '2026-09-01');
    assert.match(f.find('[data-plan-filter-state]').textContent, /Дата начала позже/);
    f.find('[data-plan-reset]').click();
    assert.equal(f.visible().length, 7); assert.equal(f.find('[data-plan-filter-empty]').hidden, true);
    assert.deepEqual(f.data, f.original);
  } finally {f.close();}
});

test('компактная карточка раскрывает поля и feedback; бриф, схема и технические требования закрыты', async () => {
  const f = fixture();
  try {
    await f.start();
    const row = f.row(1), details = row.querySelector('.mentor-day-details');
    assert.equal(details.open, false);
    assert.equal(row.querySelector('[data-field="topic"]').closest('.mentor-day-details'), details);
    assert.equal(row.querySelector('[data-feedback-input]').closest('.mentor-day-details'), details);
    details.querySelector('summary').click(); assert.equal(details.open, true);
    assert.equal(row.querySelector('.mentor-day-preview').textContent.includes('Тема'), false);
    assert.equal(row.querySelector('.mentor-day-summary').textContent.includes('Зацепка'), false);
    assert.equal(f.find('.mentor-brief').open, false);
    assert.equal(f.find('.mentor-methods').open, false);
    assert.equal(f.find('.mentor-extra-filters').open, false);
    assert.equal(f.find('.mentor-approval').closest('details'), null);
    assert.match(f.find('.mentor-methods summary').textContent, /Как контент приводит к обращению/);
  } finally {f.close();}
});

test('что уже есть объясняет описание без загрузки; что подготовить оставляет требования под раскрытием', async () => {
  const f = fixture();
  try {
    await f.start();
    const assets = f.find('[data-rows="assets"]');
    assert.match(assets.textContent, /Что у вас уже есть · необязательно/);
    assert.match(assets.textContent, /Фото кабинета на телефоне/);
    assert.match(assets.textContent, /файлы не загружаются/);
    assert.equal(assets.querySelector('input[type="file"]'), null);
    const preparation = f.find('.mentor-materials');
    assert.equal(preparation.querySelector('h2').textContent, 'Что подготовить');
    assert.match(preparation.textContent, /Подберите или сделайте изображение/);
    const prompt = preparation.querySelector('[data-prompt]');
    assert.ok(prompt); assert.equal(prompt.closest('details').open, false);
    assert.match(prompt.closest('details').querySelector('summary').textContent, /Для команды/);
    const plan = f.find('.mentor-plan');
    assert.equal(plan.compareDocumentPosition(preparation) & f.w.Node.DOCUMENT_POSITION_FOLLOWING, f.w.Node.DOCUMENT_POSITION_FOLLOWING);
  } finally {f.close();}
});

test('добавить файл раскрывает существующий приём только у черновика без медиа, без отправки', async () => {
  const f = fixture();
  try {
    await f.start();
    assert.equal(f.node.querySelectorAll('[data-material-target]').length, 1);
    assert.equal(f.find('[data-material-target]').dataset.materialTarget, '101');
    const input = f.find('[data-material-file="101"]');
    assert.equal(input.closest('details').open, false);
    f.find('[data-material-target]').click();
    assert.equal(input.closest('details').open, true);
    assert.equal(f.w.document.activeElement, input);
    assert.equal(f.calls.some((call) => call.method !== 'GET'), false);
  } finally {f.close();}
});

test('уже загруженный файл исключает повторную задачу подготовки без изменения плана', async () => {
  const data = example();
  data.transfer.current.items[1].hasMedia = true;
  data.transfer.current.items[1].mediaUrls = ['/content/publishing-assets/demo.png'];
  const f = fixture({data});
  try {
    await f.start();
    const tasks = [...f.find('.mentor-materials').querySelectorAll('.mentor-material-task > strong')].map((item) => item.textContent);
    assert.equal(tasks.includes('Тема 1'), false); assert.equal(tasks.includes('Тема 0'), true);
    assert.equal(tasks.length, 6);
    assert.match(f.row(1).textContent, /медиа загружено/);
    assert.equal(f.row(1).querySelector('[data-material-target]'), null);
    assert.equal(f.data.plan.days[1].assetId, '');
    assert.deepEqual(f.data, f.original);
  } finally {f.close();}
});

test('read-only получает ту же ленту и фильтры, без обещания правки и без пишущих controls', async () => {
  const f = fixture({readOnly: true});
  try {
    await f.start(); f.filter('platform', 'vk'); f.filter('status', 'draft');
    assert.equal(f.visible().length, 1);
    assert.equal(f.find('#mentor-plan-form'), null);
    assert.equal(f.find('[data-feedback-send]'), null);
    assert.equal(f.find('[data-material-target]'), null);
    assert.equal(f.find('[data-material-file]'), null);
    assert.doesNotMatch(f.find('.mentor-plan').textContent, /предложите правку|Подробности и правки|Для изменений/);
    assert.ok(f.find('.mentor-methods'));
  } finally {f.close();}
});

test('раскрытие полей не превращает данные в HTML и фильтры не создают запросов', async () => {
  const data = example(); data.plan.days[1].topic = '<img src=x onerror=alert(1)>'; data.plan.days[1].hook = '<script>alert(1)</script>';
  const f = fixture({data});
  try {
    await f.start(); const calls = f.calls.length;
    f.filter('order', 'asc'); f.filter('status', 'draft'); f.row(1).querySelector('summary').click();
    assert.equal(f.find('img[src="x"]'), null); assert.equal(f.find('script'), null);
    assert.match(f.row(1).querySelector('[data-preview-topic]').textContent, /<img src=x/);
    assert.equal(f.calls.length, calls);
  } finally {f.close();}
});

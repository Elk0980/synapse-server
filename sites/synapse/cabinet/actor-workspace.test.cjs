const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const script = fs.readFileSync(require.resolve('./actor-workspace.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../cabinet.html'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const entry = (topic = 'Моя первая идея') => ({date: '2026-09-24', platform: 'youtube', format: 'short', topic, status: 'idea'});
const own = (companyCode = 'alvi', actorId = 17, entries = [], revision = 0) =>
  ({companyCode, actorId, entries, revision, updatedAt: null, publicationEnabled: false});
const question = (overrides = {}) => ({id: 1, text: 'Помоги со сценарием', createdAt: '2026-09-24T10:00:00Z',
  aiStatus: 'pending', reply: null, attempts: 1, retryAfterAt: null, ...overrides});
function fixture({role = 'editor', permissions = ['actor-onboarding.self'], override} = {}) {
  const dom = new JSDOM('<main><section id="view"></section></main>', {url: 'https://cabinet.test/#actor-workspace', runScripts: 'outside-only'});
  const w = dom.window, container = w.document.querySelector('#view'), views = {}, calls = [], plans = new Map();
  w.SbCabinet = {registerView(name, view) {views[name] = view;}};
  w.eval(script);
  const ctx = {identity: {userId: 17, role, permissions, companies: [{id: 'alvi', name: 'Компания А'}, {id: 'avokado', name: 'Компания Б'}]},
    selectedProjectId: 'alvi', currentView: 'actor-workspace',
    csrfOptions: (method, body) => ({method, headers: {'X-CSRF-Token': 'test'}, body: JSON.stringify(body)}),
    apiJson: async (url, options = {}) => {
      const parsed = new URL(url, 'https://cabinet.test');
      const call = {path: parsed.pathname, code: parsed.searchParams.get('companyCode'), params: parsed.searchParams,
        method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, headers: options.headers || {}};
      calls.push(call);
      if (override) {const data = await override(call); if (data !== undefined) return data;}
      const key = `${ctx.identity.userId}:${call.code}`;
      if (call.path.endsWith('/plan')) {
        if (call.method === 'PUT') plans.set(key, own(call.code, ctx.identity.userId, call.body.entries, call.body.revision + 1));
        return plans.get(key) || own(call.code, ctx.identity.userId);
      }
      if (call.path.endsWith('/stats')) return {companyCode: call.code, from: '2026-09-01', to: '2026-09-24',
        socialAggregate: {views: 1234, likes: 0, shares: null}, platforms: {youtube: {configured: true, dataStatus: 'partial', totals: {views: 1234}}}};
      if (call.path.endsWith('/messages') && call.method === 'GET') return {companyCode: call.code, actorId: ctx.identity.userId, messages: [], assistantEnabled: true};
      if (call.path.endsWith('/messages') && call.method === 'POST') return {message: question({text: call.body.text}), assistantEnabled: true};
      if (call.path.endsWith('/retry')) return {message: question({aiStatus: 'done', reply: 'Начните с одного примера.', attempts: call.body.attempt + 1}), repeated: false};
      throw new Error(`Unexpected endpoint ${call.path}`);
    }};
  const settle = async () => {for (let i = 0; i < 6; i++) await tick();};
  const view = views['actor-workspace'];
  const find = (selector) => container.querySelector(selector);
  const type = (selector, value) => {const el = find(selector); el.value = value; el.dispatchEvent(new w.Event('input', {bubbles: true}));};
  const submit = (selector) => find(selector).dispatchEvent(new w.Event('submit', {bubbles: true, cancelable: true}));
  const start = async () => {view.render(container, ctx); await settle();};
  return {w, ctx, view, calls, container, find, type, submit, settle, start, close: () => w.close()};
}

test('в кабинете зарегистрированы маршрут, меню, ресурсы и персональное право', () => {
  assert.match(html, /id="actor-workspace-link" href="#actor-workspace"/);
  assert.match(html, /id="actor-workspace-view" data-view="actor-workspace" hidden/);
  assert.match(html, /"actor-workspace": "Моё рабочее место"/);
  for (const name of ['cabinetAssets', 'cabinetStyles']) {
    assert.match(html.match(new RegExp(`const ${name} = \\[([\\s\\S]+?)\\];`))[1], /"actor-workspace"/);
  }
  assert.match(html, /if \(value === "actor-workspace"\).*actor-onboarding\.self/);
  assert.match(html, /byId\("actor-workspace-link"\)\.hidden = !permittedView\("actor-workspace"\)/);
});

test('открытие делает только три личных/обезличенных GET и не публикует материалы', async () => {
  const f = fixture();
  try {
    await f.start();
    assert.equal(f.view.title, 'Моё рабочее место');
    assert.deepEqual(f.calls.map((c) => c.path), ['/content/actor-workspace/plan', '/content/actor-workspace/messages', '/content/actor-workspace/stats']);
    assert.ok(f.calls.every((c) => c.method === 'GET' && c.code === 'alvi'));
    assert.match(f.container.textContent, /Сохранение не запускает публикации/);
    assert.match(f.container.textContent, /сохранённую анкету и личный план/);
    assert.equal(f.find('[data-aw-save]').disabled, true);
  } finally {f.close();}
});

test('без self и без идентифицированного участника нет запросов; owner получает своё место', async () => {
  for (const config of [{permissions: []}, {}]) {
    const f = fixture(config);
    try {
      if (!config.permissions) delete f.ctx.identity.userId;
      await f.start();
      assert.equal(f.calls.length, 0);
      assert.equal(f.find('form'), null);
    } finally {f.close();}
  }
  const f = fixture({role: 'owner', permissions: []});
  try {await f.start(); assert.equal(f.calls.length, 3); assert.equal(f.calls.some((c) => c.path.endsWith('/summary')), false);}
  finally {f.close();}
});

test('карточка сохраняет пять полей, свою версию и CSRF после явного submit', async () => {
  const f = fixture();
  try {
    await f.start(); f.find('[data-aw-add]').click();
    for (const [key, value] of Object.entries({...entry('  Своя тема  '), status: 'recorded'})) f.type(`[name="${key}"]`, value);
    assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 0);
    f.submit('[data-aw-plan-form]'); await f.settle();
    const save = f.calls.find((c) => c.method === 'PUT');
    assert.deepEqual(save.body, {revision: 0, entries: [{...entry('Своя тема'), status: 'recorded'}]});
    assert.deepEqual([...save.params.keys()], ['companyCode']);
    assert.equal(save.headers['X-CSRF-Token'], 'test');
    assert.match(f.find('[data-aw-plan-status]').textContent, /Программа сохранена.*Версия 1/);
    assert.equal(f.find('[data-aw-save]').disabled, true);
  } finally {f.close();}
});

test('лимиты программы проверяются до записи, удаление остаётся черновиком до сохранения', async () => {
  const f = fixture();
  try {
    await f.start();
    for (let i = 0; i < 4; i++) {f.find('[data-aw-add]').click(); f.type(`[data-aw-entry="${i}"] [name="topic"]`, `Тема ${i}`);}
    f.submit('[data-aw-plan-form]'); await f.settle();
    assert.equal(f.calls.some((c) => c.method === 'PUT'), false);
    assert.match(f.find('[data-aw-plan-status]').textContent, /трёх материалов/);
    f.find('[data-aw-remove="3"]').click();
    assert.equal(f.calls.some((c) => c.method === 'PUT'), false);
    f.submit('[data-aw-plan-form]'); await f.settle();
    assert.equal(f.calls.find((c) => c.method === 'PUT').body.entries.length, 3);
  } finally {f.close();}
});

test('409 сохраняет ввод; сравнение не перезаписывает его, замена требует явного действия', async () => {
  let puts = 0, gets = 0;
  const f = fixture({override: (c) => {
    if (!c.path.endsWith('/plan')) return;
    if (c.method === 'PUT' && ++puts === 1) throw Object.assign(new Error('{secret: raw}'), {status: 409});
    if (c.method === 'GET' && ++gets > 1) return own(c.code, 17, [entry('Серверная тема')], 4);
  }});
  try {
    await f.start(); f.find('[data-aw-add]').click(); f.type('[name="topic"]', 'Мой черновик');
    f.submit('[data-aw-plan-form]'); await f.settle();
    assert.equal(f.find('[name="topic"]').value, 'Мой черновик');
    assert.equal(f.find('[data-aw-save]').disabled, true);
    assert.doesNotMatch(f.container.textContent, /secret|raw/);
    f.find('[data-aw-compare]').click(); await f.settle();
    assert.equal(f.find('[name="topic"]').value, 'Мой черновик');
    assert.match(f.find('[data-aw-conflict]').textContent, /Серверная тема/);
    assert.equal(puts, 1);
    f.find('[data-aw-replace-saved]').click(); await f.settle();
    assert.equal(f.calls.filter((c) => c.method === 'PUT')[1].body.revision, 4);
    assert.equal(f.find('[name="topic"]').value, 'Мой черновик');
    assert.equal(f.find('[data-aw-conflict]').hidden, true);
  } finally {f.close();}
});

test('черновики изолированы по компании и участнику и возвращаются только своему автору', async () => {
  const f = fixture();
  try {
    await f.start(); f.find('[data-aw-add]').click(); f.type('[name="topic"]', 'Личная тема 17');
    f.type('[data-aw-message]', 'Мой вопрос');
    f.ctx.selectedProjectId = 'avokado'; f.view.onProjectChange(f.ctx); await f.settle();
    assert.equal(f.find('[name="topic"]'), null); assert.equal(f.find('[data-aw-message]').value, '');
    f.ctx.selectedProjectId = 'alvi'; f.ctx.identity.userId = 18; f.view.render(f.container, f.ctx); await f.settle();
    assert.equal(f.find('[name="topic"]'), null); assert.equal(f.find('[data-aw-message]').value, '');
    f.ctx.identity.userId = 17; f.view.render(f.container, f.ctx); await f.settle();
    assert.equal(f.find('[name="topic"]').value, 'Личная тема 17'); assert.equal(f.find('[data-aw-message]').value, 'Мой вопрос');
    assert.equal(f.w.localStorage.length, 0);
  } finally {f.close();}
});

test('запоздалые ответы и ошибки старой компании не меняют новый экран', async () => {
  const deferred = [];
  const f = fixture({override: (c) => c.code === 'alvi' ? new Promise((resolve, reject) => deferred.push({c, resolve, reject})) : undefined});
  try {
    await f.start(); f.ctx.selectedProjectId = 'avokado'; f.view.onProjectChange(f.ctx); await f.settle();
    const content = f.container.textContent;
    deferred.find((d) => d.c.path.endsWith('/plan')).reject(new Error('old private raw'));
    deferred.find((d) => d.c.path.endsWith('/stats')).reject(new Error('old private raw'));
    deferred.find((d) => d.c.path.endsWith('/messages')).resolve({companyCode: 'alvi', actorId: 17, messages: [question({text: 'Чужая компания'})]});
    await f.settle();
    assert.equal(f.container.textContent, content);
    assert.match(f.find('[data-aw-stats]').textContent, /1\s*234/);
  } finally {f.close();}
});

test('задержавшееся сохранение старого участника не попадает к новому', async () => {
  let resolveSave;
  const f = fixture({override: (c) => c.method === 'PUT' ? new Promise((resolve) => {resolveSave = resolve;}) : undefined});
  try {
    await f.start(); f.find('[data-aw-add]').click(); f.type('[name="topic"]', 'Личный материал 17');
    f.submit('[data-aw-plan-form]'); await f.settle();
    f.ctx.identity.userId = 18; f.view.render(f.container, f.ctx); await f.settle();
    resolveSave(own('alvi', 17, [entry('Личный материал 17')], 1)); await f.settle();
    assert.equal(f.find('[name="topic"]'), null);
    assert.doesNotMatch(f.container.textContent, /Личный материал 17|Программа сохранена/);
  } finally {f.close();}
});

test('ответ с чужим actorId отклоняется, даже когда компания совпала', async () => {
  const f = fixture({override: (c) => {
    if (c.path.endsWith('/plan')) return own(c.code, 999, [entry('Чужая тема')]);
    if (c.path.endsWith('/messages')) return {companyCode: c.code, actorId: 999, messages: [question({text: 'Чужая история'})]};
  }});
  try {
    await f.start();
    assert.doesNotMatch(f.container.textContent, /Чужая тема|Чужая история/);
    assert.equal(f.find('[data-aw-send]').disabled, true);
    assert.equal(f.find('[data-aw-add]').disabled, true);
  } finally {f.close();}
});

test('таймаут отправки сохраняет текст и ключ; повтор не создаёт новое сообщение', async () => {
  let posts = 0;
  const f = fixture({override: (c) => {
    if (c.method === 'POST' && ++posts === 1) throw Error('secret raw error');
  }});
  try {
    await f.start(); f.type('[data-aw-message]', 'Помоги со сценарием');
    assert.equal(f.calls.some((c) => c.method === 'POST'), false);
    f.submit('[data-aw-chat-form]'); await f.settle();
    assert.equal(f.find('[data-aw-message]').value, 'Помоги со сценарием');
    assert.equal(f.find('[data-aw-message]').readOnly, true);
    assert.match(f.find('[data-aw-chat-status]').textContent, /Результат отправки неизвестен/);
    assert.doesNotMatch(f.container.textContent, /secret raw/);
    f.submit('[data-aw-chat-form]'); await f.settle();
    const sends = f.calls.filter((c) => c.method === 'POST');
    assert.deepEqual(sends[0].body, sends[1].body);
    assert.match(sends[0].body.clientMessageId, /^[A-Za-z0-9_-]{8,100}$/);
    assert.equal(sends[0].headers['X-CSRF-Token'], 'test');
    assert.deepEqual(Object.keys(sends[0].body).sort(), ['clientMessageId', 'text']);
    assert.equal(f.find('[data-aw-message]').value, '');
    assert.match(f.find('[data-aw-chat-status]').textContent, /Автоматический повтор не выполняется/);
    assert.equal(f.container.querySelectorAll('.aw-exchange').length, 1);
  } finally {f.close();}
});

test('идентификатор неизвестной отправки сохраняется после смены компании, чужой ответ не показывается', async () => {
  let resolveSend;
  const f = fixture({override: (c) => c.method === 'POST' && !resolveSend ? new Promise((resolve) => {resolveSend = resolve;}) : undefined});
  try {
    await f.start(); f.type('[data-aw-message]', 'Свой вопрос'); f.submit('[data-aw-chat-form]'); await f.settle();
    f.ctx.selectedProjectId = 'avokado'; f.view.onProjectChange(f.ctx); await f.settle();
    resolveSend({message: question({text: 'Свой вопрос', aiStatus: 'done', reply: 'Свой ответ'})}); await f.settle();
    assert.doesNotMatch(f.container.textContent, /Свой вопрос|Свой ответ/);
    f.ctx.selectedProjectId = 'alvi'; f.view.onProjectChange(f.ctx); await f.settle();
    assert.equal(f.find('[data-aw-message]').value, 'Свой вопрос');
    f.submit('[data-aw-chat-form]'); await f.settle();
    const sends = f.calls.filter((c) => c.method === 'POST');
    assert.deepEqual(sends[0].body, sends[1].body);
  } finally {f.close();}
});

test('pending повторяется только явной кнопкой с номером попытки; текст ответа экранирован', async () => {
  const f = fixture({override: (c) => {
    if (c.path.endsWith('/messages') && c.method === 'GET') return {companyCode: c.code, actorId: 17, messages: [question({text: '<img src=x onerror=alert(1)>'})]};
    if (c.path.endsWith('/retry')) return {message: question({aiStatus: 'done', reply: '<script>secret()</script>', attempts: 2})};
  }});
  try {
    await f.start(); assert.equal(f.calls.some((c) => c.method === 'POST'), false);
    assert.equal(f.find('img'), null);
    f.find('[data-aw-retry]').click(); await f.settle();
    const retry = f.calls.find((c) => c.path.endsWith('/retry'));
    assert.deepEqual(retry.body, {messageId: 1, attempt: 1});
    assert.equal(retry.headers['X-CSRF-Token'], 'test');
    assert.match(f.find('[data-aw-messages]').textContent, /<script>secret\(\)<\/script>/);
    assert.equal(f.find('script'), null); assert.equal(f.find('[data-aw-retry]'), null);
  } finally {f.close();}
});

test('running, cooldown и лимит попыток не получают кнопку повтора', async () => {
  const messages = [question({id: 1, aiStatus: 'running'}), question({id: 2, retryAfterAt: '2099-01-01T00:00:00Z'}), question({id: 3, attempts: 3})];
  const f = fixture({override: (c) => c.path.endsWith('/messages') ? {companyCode: c.code, actorId: 17, messages} : undefined});
  try {
    await f.start();
    assert.equal(f.find('[data-aw-retry]'), null); assert.equal(f.find('[data-aw-send]').disabled, true);
    assert.match(f.container.textContent, /Лимит повторов исчерпан/);
    assert.match(f.container.textContent, /Повтор доступен после/);
    assert.match(f.container.textContent, /Хью готовит ответ/);
  } finally {f.close();}
});

test('обновление истории и отправка не конкурируют; до завершения GET отправка заблокирована', async () => {
  let getCount = 0, resolveRefresh;
  const f = fixture({override: (c) => c.path.endsWith('/messages') && c.method === 'GET' && ++getCount > 1 ?
    new Promise((resolve) => {resolveRefresh = resolve;}) : undefined});
  try {
    await f.start(); f.type('[data-aw-message]', 'Новый вопрос'); f.find('[data-aw-refresh-messages]').click(); await f.settle();
    f.submit('[data-aw-chat-form]'); await f.settle();
    assert.equal(f.find('[data-aw-send]').disabled, true); assert.equal(f.calls.some((c) => c.method === 'POST'), false);
    resolveRefresh({companyCode: 'alvi', actorId: 17, messages: []}); await f.settle();
    assert.equal(f.find('[data-aw-send]').disabled, false);
  } finally {f.close();}
});

test('история догружается только своей компанией без повторяющихся сообщений', async () => {
  const f = fixture({override: (c) => {
    if (c.path.endsWith('/messages') && c.method === 'GET') return {companyCode: c.code, actorId: 17,
      messages: c.params.has('before') ? [question({id: 1})] : Array.from({length: 50}, (_, i) => question({id: i + 2}))};
  }});
  try {
    await f.start(); f.find('[data-aw-older]').click(); await f.settle();
    const get = f.calls.filter((c) => c.path.endsWith('/messages')).at(-1);
    assert.equal(get.params.get('before'), '2'); assert.equal(get.code, 'alvi');
    assert.deepEqual([...get.params.keys()].sort(), ['before', 'companyCode', 'limit']);
    assert.equal(f.container.querySelectorAll('.aw-exchange').length, 51);
    assert.equal(f.find('[data-aw-older]').hidden, true);
  } finally {f.close();}
});

test('статистика показывает null как отсутствие данных, настоящий 0 и только разрешённые показатели', async () => {
  const f = fixture({override: (c) => c.path.endsWith('/stats') ? {companyCode: c.code, socialAggregate: {views: 0, likes: null},
    platforms: {}, participants: [{name: 'Скрытый участник', text: 'Скрытая переписка'}], raw: 'api-payload'} : undefined});
  try {
    await f.start();
    const stats = f.find('[data-aw-stats]');
    assert.equal(stats.querySelector('dd').textContent, '0');
    assert.match(stats.textContent, /Нет данных/); assert.match(stats.textContent, /Источник не подключён/);
    assert.doesNotMatch(f.container.textContent, /Скрытый участник|Скрытая переписка|api-payload/);
  } finally {f.close();}
});

test('ошибка статистики не подменяется нулями и не блокирует личную программу', async () => {
  const f = fixture({override: (c) => {if (c.path.endsWith('/stats')) throw Error('{raw: API}');}});
  try {
    await f.start();
    assert.match(f.find('[data-aw-stats-status]').textContent, /не означает нулевые показатели/);
    assert.equal(f.find('[data-aw-stats]').textContent, ''); assert.equal(f.find('[data-aw-add]').disabled, false);
    assert.doesNotMatch(f.container.textContent, /raw: API/);
  } finally {f.close();}
});

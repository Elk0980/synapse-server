'use strict';
// CF1: «Настройки модуля» контент-завода. Синтетические данные, поддельный CRM в памяти.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const settle = async () => { for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 0)); };
const EMPTY_PROFILE = {genders: [], ageFrom: null, ageTo: null, geography: '', targetAction: '', targetUrl: '', occasions: [], questions: [],
  proofs: [], sourcesNote: '', styleNotes: ''};

const PLATFORMS = [{id: 'telegram', label: 'Telegram'}, {id: 'vk', label: 'ВКонтакте'}];
// Форма DTO как у реального getSettings (ops/crm/autoposting-transport.js): строка есть у каждой площадки, даже ненастроенной.
const channel = (id, extra = {}) => ({id, platform: id, provider: 'direct', name: id, target: '', enabled: false, connected: false, tokenConfigured: false,
  revision: 0, status: 'not_configured', checkedAt: null, profileDisplayName: null, ...extra});
const CHANNELS = [channel('telegram', {target: '@synthetic_channel', enabled: true, connected: true, tokenConfigured: true, revision: 2, status: 'connected',
  checkedAt: '2026-09-30T02:00:00.000Z'}), channel('vk')];
function server({brief = {}, profile = {}, delay = null, platforms = PLATFORMS, channels = CHANNELS} = {}) {
  const state = {};
  for (const code of ['one', 'two']) state[code] = {
    brief: {revision: code === 'one' ? 3 : 0, fields: {goal: 'Цель', product: code === 'one' ? 'Шары под ключ' : '', audience: code === 'one' ? 'Родители' : '',
      pains: code === 'one' ? ['Нет времени на оформление'] : [], confirmedFacts: [], assets: [], shootingComfort: {level: 'unknown', notes: ''}, platforms: ['telegram'], ...brief}},
    profile: {revision: code === 'one' ? 1 : 0, fields: {...EMPTY_PROFILE, ...(code === 'one' ? {genders: ['women'], geography: 'Город N', ...profile} : {})}},
    months: {}};
  const calls = [];
  const days = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const monthDto = (code, month) => {
    const m = state[code].months[month] || {revision: 0, inputs: {priorities: [], events: [], excludedDays: [], platforms: [], perDay: {}, note: ''}};
    const per = Object.values(m.inputs.perDay).reduce((a, b) => a + b, 0);
    return {companyCode: code, month, daysInMonth: days(month), revision: m.revision, inputs: m.inputs, history: [],
      publicationCount: (days(month) - m.inputs.excludedDays.length) * per};
  };
  async function crmQuery(p, params = {}, options = {}) {
    const method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : undefined, code = params.companyCode;
    calls.push({path: p, method, code, body});
    if (delay) await delay(p, code);
    const s = state[code];
    if (p === '/media-mentor' && method === 'GET') return {companyCode: code, brief: {...s.brief, history: []}};
    if (p === '/media-mentor/brief' && method === 'PUT') {
      if (body.revision !== s.brief.revision) throw Object.assign(new Error('Бриф уже изменили. Обновите страницу.'), {status: 409});
      s.brief = {revision: s.brief.revision + 1, fields: {...s.brief.fields, ...body.brief}};
      return {companyCode: code, brief: {...s.brief, history: []}};
    }
    if (p === '/media-mentor/inputs' && method === 'GET') return {companyCode: code, timezone: 'Asia/Irkutsk', profile: {...s.profile, history: []},
      vocabulary: {genders: [{id: 'women', label: 'Женщины'}, {id: 'men', label: 'Мужчины'}], platforms, maxPerDay: 3}};
    if (p === '/media-mentor/inputs' && method === 'PUT') {
      if (body.revision !== s.profile.revision) throw Object.assign(new Error('Вводные уже изменили. Обновите страницу.'), {status: 409});
      s.profile = {revision: s.profile.revision + 1, fields: {...s.profile.fields, ...body.profile}};
      return {companyCode: code, timezone: 'Asia/Irkutsk', profile: {...s.profile, history: []}};
    }
    const month = /^\/media-mentor\/inputs\/months\/(\d{4}-\d{2})$/.exec(p)?.[1];
    if (month && method === 'GET') return monthDto(code, month);
    if (month && method === 'PUT') {
      const m = s.months[month] || {revision: 0, inputs: monthDto(code, month).inputs};
      if (body.revision !== m.revision) throw Object.assign(new Error('Пожелания уже изменили.'), {status: 409});
      s.months[month] = {revision: m.revision + 1, inputs: {...m.inputs, ...body.inputs}};
      return monthDto(code, month);
    }
    if (p === '/autoposting/settings') return {companyCode: code, timezone: 'Asia/Irkutsk', channels};
    throw Object.assign(new Error('Неожиданный адрес ' + p), {status: 404});
  }
  return {state, calls, crmQuery};
}

function page({role = 'owner', permissions = ['autoposting.view', 'autoposting.edit'], srv = server(), project = 'one'} = {}) {
  const errors = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM('<main><section id="view" data-view="content-factory-settings"></section></main>', {url: 'https://cabinet.test/cabinet.html#content-factory/settings', runScripts: 'outside-only', virtualConsole: vc, pretendToBeVisual: true});
  const w = dom.window, d = w.document, views = {};
  w.SbCabinet = {registerView(name, def) { views[name] = def; }};
  w.eval(fs.readFileSync(path.join(__dirname, 'content-factory.js'), 'utf8'));
  const ctx = {identity: {role, permissions, csrfToken: 'qa'}, selectedProjectId: project, crmQuery: srv.crmQuery,
    csrfOptions: (method, body) => ({method, headers: {'X-CSRF-Token': 'qa'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}),
    navigate() {}, escapeHTML: (v) => String(v)};
  const node = d.getElementById('view');
  return {w, d, srv, ctx, node, errors, views, close: () => w.close(),
    render: async (next = ctx) => { views['content-factory-settings'].render(node, next); await settle(); },
    q: (s) => node.querySelector(s), qa: (s) => [...node.querySelectorAll(s)]};
}

test('короткая форма открыта, «Уточнить план», площадки и планирование свёрнуты; вводные подставлены из брифа и профиля', async () => {
  const f = page(); try {
    await f.render();
    const form = f.q('#cf-business-form');
    assert.ok(form);
    assert.equal(form.elements.product.value, 'Шары под ключ');
    assert.equal(form.elements.situation.value, 'Нет времени на оформление');
    assert.equal(form.elements.audience.value, 'Родители');
    assert.deepEqual(f.qa('[name="gender"]').map((n) => [n.value, n.checked]), [['women', true], ['men', false]]);
    assert.equal(form.elements.geography.value, 'Город N');
    assert.equal(f.q('#cf-refine').open, false);
    assert.equal(f.q('[data-cf-section="channels"]').open, false);
    assert.equal(f.q('[data-cf-section="planning"]').open, false);
    assert.match(f.q('label[for="cf-situation"]').textContent, /Ситуация и задача покупателя/);
    assert.doesNotMatch(f.node.textContent, /Боль клиента/);
    assert.doesNotMatch(f.node.textContent, /осведомл/i, 'уровень осведомлённости не спрашиваем');
    assert.equal(f.srv.calls.filter((c) => c.method !== 'GET').length, 0, 'открытие ничего не пишет');
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('подсказки: кнопка «Подсказка: поле» открывает пояснение с примером, доступна клавиатурой', async () => {
  const f = page(); try {
    await f.render();
    const hint = f.q('button[aria-label="Подсказка: Ситуация и задача покупателя"]');
    assert.ok(hint, 'кнопка подсказки');
    assert.equal(hint.getAttribute('aria-expanded'), 'false');
    hint.click();
    assert.equal(hint.getAttribute('aria-expanded'), 'true');
    const note = f.d.getElementById(hint.getAttribute('aria-controls'));
    assert.equal(note.hidden, false);
    assert.match(note.textContent, /Например/);
    assert.ok(f.qa('.cf-hint').length >= 10, 'подсказки у полей');
  } finally { f.close(); }
});

test('пол: обе галочки сохраняются; возраст пусто — без ограничения; от > до — ошибка у поля без запроса', async () => {
  const f = page(); try {
    await f.render();
    const form = f.q('#cf-business-form');
    f.qa('[name="gender"]').forEach((n) => { n.checked = true; });
    form.elements.ageFrom.value = '40'; form.elements.ageTo.value = '30';
    form.requestSubmit(); await settle();
    assert.equal(f.q('#cf-age-error').hidden, false);
    assert.match(f.q('#cf-age-error').textContent, /не больше/);
    assert.equal(f.srv.calls.filter((c) => c.method === 'PUT').length, 0);
    form.elements.ageFrom.value = ''; form.elements.ageTo.value = '';
    form.requestSubmit(); await settle();
    const put = f.srv.calls.filter((c) => c.method === 'PUT');
    assert.equal(put.length, 1);
    assert.equal(put[0].path, '/media-mentor/inputs');
    assert.deepEqual(put[0].body, {revision: 1, profile: {genders: ['women', 'men']}}, 'только изменённое поле профиля; бриф не отправляется');
    assert.match(f.q('#cf-business-state').textContent, /Сохранено/);
    assert.deepEqual(f.srv.state.one.profile.fields.genders, ['women', 'men']);
    assert.equal(f.srv.state.one.profile.fields.ageFrom, null);
  } finally { f.close(); }
});

test('изменение поля брифа показывает следствие и отправляет только изменённое поле брифа', async () => {
  const f = page(); try {
    await f.render();
    const form = f.q('#cf-business-form');
    assert.equal(f.q('#cf-brief-warning').hidden, true);
    form.elements.product.value = 'Оформление шарами под ключ для праздников';
    form.elements.product.dispatchEvent(new f.w.Event('input', {bubbles: true}));
    assert.equal(f.q('#cf-brief-warning').hidden, false);
    assert.match(f.q('#cf-brief-warning').textContent, /новую версию брифа/);
    form.requestSubmit(); await settle();
    const put = f.srv.calls.filter((c) => c.method === 'PUT');
    assert.deepEqual(put.map((c) => c.path), ['/media-mentor/brief']);
    assert.deepEqual(put[0].body, {revision: 3, brief: {product: 'Оформление шарами под ключ для праздников'}});
    assert.equal(f.srv.state.one.brief.fields.goal, 'Цель', 'прочие поля брифа не потеряны');
    form.requestSubmit(); await settle();
    assert.equal(f.srv.calls.filter((c) => c.method === 'PUT').length, 1, 'повторное сохранение без изменений ничего не пишет');
    assert.match(f.q('#cf-business-state').textContent, /Изменений нет/);
  } finally { f.close(); }
});

test('неизвестное остаётся пустым: пустая компания, ссылка только HTTP(S)', async () => {
  const f = page({project: 'two'}); try {
    await f.render();
    const form = f.q('#cf-business-form');
    assert.equal(form.elements.product.value, '');
    assert.ok(f.qa('[name="gender"]').every((n) => !n.checked));
    assert.match(f.q('#cf-gender-summary').textContent, /Не указано/);
    assert.match(f.q('#cf-age-summary').textContent, /Не ограничивать/);
    form.elements.targetUrl.value = 'javascript:alert(1)';
    form.requestSubmit(); await settle();
    assert.equal(f.q('#cf-url-error').hidden, false);
    assert.equal(f.srv.calls.filter((c) => c.method === 'PUT').length, 0);
  } finally { f.close(); }
});

test('месяц: площадки и объём дают итог; дни-исключения; события с отметкой подтверждения; профиль не трогается', async () => {
  const f = page(); try {
    await f.render();
    const month = f.q('#cf-month');
    assert.match(month.value, /^\d{4}-\d{2}$/);
    month.value = '2026-10'; month.dispatchEvent(new f.w.Event('change', {bubbles: true})); await settle();
    const form = f.q('#cf-month-form');
    form.querySelector('[name="platform"][value="telegram"]').checked = true;
    form.querySelector('[name="perDay-telegram"]').value = '2';
    form.elements.excluded.value = '4, 5';
    form.elements.priorities.value = 'Оформление шарами\nФотозона';
    f.q('[data-cf-add-event]').click();
    const row = form.querySelector('[data-cf-event]');
    row.querySelector('[name="eventTitle"]').value = 'Осенняя акция';
    row.querySelector('[name="eventDate"]').value = '2026-10-15';
    row.querySelector('[name="eventConditions"]').value = 'Скидка по прайсу владельца';
    row.querySelector('[name="eventConfirmed"]').checked = true;
    form.dispatchEvent(new f.w.Event('input', {bubbles: true}));
    assert.match(f.q('#cf-month-total').textContent, /58/, '(31 − 2) × 2');
    form.requestSubmit(); await settle();
    const put = f.srv.calls.filter((c) => c.method === 'PUT');
    assert.deepEqual(put.map((c) => c.path), ['/media-mentor/inputs/months/2026-10']);
    assert.deepEqual(put[0].body.inputs.excludedDays, ['2026-10-04', '2026-10-05']);
    assert.deepEqual(put[0].body.inputs.perDay, {telegram: 2});
    assert.deepEqual(put[0].body.inputs.events, [{title: 'Осенняя акция', date: '2026-10-15', conditions: 'Скидка по прайсу владельца', confirmed: true}]);
    assert.deepEqual(put[0].body.inputs.priorities, ['Оформление шарами', 'Фотозона']);
    assert.equal(f.srv.state.one.profile.revision, 1, 'месяц не меняет профиль');
    assert.match(f.q('#cf-month-state').textContent, /Сохранено/);
    form.elements.excluded.value = '32';
    form.requestSubmit(); await settle();
    assert.equal(f.q('#cf-excluded-error').hidden, false);
    assert.equal(f.srv.calls.filter((c) => c.method === 'PUT').length, 1);
  } finally { f.close(); }
});

test('площадки: подключённость — по состоянию канала, не по ссылке; режим выпуска не меняется', async () => {
  const f = page(); try {
    await f.render();
    const text = f.q('[data-cf-section="channels"]').textContent;
    assert.match(text, /Telegram[\s\S]*Подключение проверено/);
    assert.match(text, /ВКонтакте — Нужно подключить/);
    const planning = f.q('[data-cf-section="planning"]').textContent;
    assert.match(planning, /Asia\/Irkutsk/);
    assert.match(planning, /Согласование не включает автоматическую публикацию/);
    assert.equal(f.qa('[data-cf-section="planning"] input, [data-cf-section="planning"] select').length, 0, 'в CF1 режимы не переключаются');
  } finally { f.close(); }
});

test('смена компании: ответ прежней компании отбрасывается, форма новой не смешивается', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const srv = server({});
  const slow = server({});
  slow.state = srv.state;
  const f = page({srv: {...srv, crmQuery: async (p, params, options) => { if (params.companyCode === 'one' && p === '/media-mentor/inputs') await gate; return srv.crmQuery(p, params, options); }}});
  try {
    f.views['content-factory-settings'].render(f.node, f.ctx);
    const next = {...f.ctx, selectedProjectId: 'two'};
    f.views['content-factory-settings'].onProjectChange(next);
    await settle();
    release(); await settle();
    assert.equal(f.q('#cf-business-form').elements.product.value, '', 'данные компании one не попали в форму two');
    assert.equal(f.q('#cf-business-form').dataset.company, 'two');
    // Сохранение после переключения пишет только в новую компанию и по её ревизии.
    const form = f.q('#cf-business-form');
    form.elements.geography.value = 'Город M';
    form.requestSubmit(); await settle();
    const put = srv.calls.filter((c) => c.method === 'PUT');
    assert.deepEqual(put.map((c) => [c.path, c.code, c.body.revision]), [['/media-mentor/inputs', 'two', 0]]);
    assert.equal(srv.state.one.profile.fields.geography, 'Город N', 'компания one не изменена');
  } finally { f.close(); }
});

test('без права правки — только просмотр, без кнопок сохранения', async () => {
  const f = page({role: 'client', permissions: ['autoposting.view']}); try {
    await f.render();
    assert.equal(f.qa('button[type="submit"]').length, 0);
    assert.ok(f.qa('#cf-business-form input, #cf-business-form textarea').every((n) => n.disabled));
    assert.match(f.node.textContent, /только просмотр/i);
  } finally { f.close(); }
});

/* ---------- CF1-R1: честное сохранение по частям, повтор, двойное нажатие, состояние площадок ---------- */
const puts = (srv, p) => srv.calls.filter((c) => c.method === 'PUT' && (!p || c.path === p));
function failing(srv, rule) {
  return {...srv, crmQuery: async (p, params = {}, options = {}) => {
    const method = options.method || 'GET';
    const error = rule(p, method);
    if (error) { srv.calls.push({path: p, method, code: params.companyCode, body: options.body ? JSON.parse(options.body) : undefined, failed: true}); throw error; }
    return srv.crmQuery(p, params, options);
  }};
}

test('R1: бриф сохранён, профиль упал — честный частичный статус, ввод остаётся, повтор отправляет только профиль', async () => {
  const srv = server();
  let profileFails = 1;
  const f = page({srv: failing(srv, (p, method) => p === '/media-mentor/inputs' && method === 'PUT' && profileFails-- > 0
    ? Object.assign(new Error('Сбой сохранения профиля'), {status: 503}) : null)});
  try {
    await f.render();
    const form = f.q('#cf-business-form');
    form.elements.product.value = 'Новый продукт';
    form.elements.geography.value = 'Город M';
    form.dispatchEvent(new f.w.Event('input', {bubbles: true}));
    form.requestSubmit(); await settle();
    const text = f.q('#cf-business-state').textContent;
    assert.match(text, /Частично сохранено/);
    assert.match(text, /Сохранено: бриф \(версия 4\)/);
    assert.match(text, /Не сохранено: вводные профиля — Сбой сохранения профиля/);
    assert.match(text, /Значения остались в форме/);
    assert.doesNotMatch(text, /^Не удалось сохранить/, 'частично сохранённое не выдаётся за полный отказ');
    assert.equal(srv.state.one.brief.fields.product, 'Новый продукт');
    assert.equal(srv.state.one.profile.fields.geography, 'Город N');
    assert.equal(form.elements.product.value, 'Новый продукт', 'ввод не потерян');
    assert.equal(form.elements.geography.value, 'Город M', 'несохранённый ввод не потерян');
    assert.equal(f.q('#cf-brief-warning').hidden, true, 'бриф уже сохранён — предупреждение о новой версии снято');
    form.requestSubmit(); await settle();
    assert.equal(puts(srv, '/media-mentor/brief').length, 1, 'повтор не создаёт лишнюю версию брифа');
    assert.deepEqual(puts(srv, '/media-mentor/inputs').filter((c) => !c.failed).map((c) => c.body), [{revision: 1, profile: {geography: 'Город M'}}]);
    assert.equal(srv.state.one.brief.revision, 4);
    assert.equal(srv.state.one.profile.fields.geography, 'Город M');
    assert.match(f.q('#cf-business-state').textContent, /^Сохранено: вводные профиля \(версия 2\)/);
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('R1: ничего не сохранилось — так и сказано, ввод остаётся', async () => {
  const srv = server();
  const f = page({srv: failing(srv, (p, method) => method === 'PUT' ? Object.assign(new Error('Сервис недоступен'), {status: 503}) : null)});
  try {
    await f.render();
    const form = f.q('#cf-business-form');
    form.elements.product.value = 'Новый продукт';
    form.elements.geography.value = 'Город M';
    form.requestSubmit(); await settle();
    const text = f.q('#cf-business-state').textContent;
    assert.match(text, /^Ничего не сохранено/);
    assert.match(text, /бриф — Сервис недоступен/);
    assert.match(text, /вводные профиля — Сервис недоступен/);
    assert.equal(form.elements.product.value, 'Новый продукт');
    assert.equal(f.q('#cf-brief-warning').hidden, false, 'бриф не сохранён — предупреждение остаётся');
    assert.equal(srv.state.one.brief.revision, 3);
  } finally { f.close(); }
});

test('R1: двойное нажатие — по одному запросу на часть, кнопка заблокирована на время сохранения', async () => {
  const srv = server();
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = page({srv: {...srv, crmQuery: async (p, params, options = {}) => { if (options.method === 'PUT') await gate; return srv.crmQuery(p, params, options); }}});
  try {
    await f.render();
    const form = f.q('#cf-business-form'), button = form.querySelector('button[type="submit"]');
    form.elements.product.value = 'Новый продукт';
    form.elements.geography.value = 'Город M';
    form.requestSubmit(); await settle();
    assert.equal(button.disabled, true, 'кнопка заблокирована, пока идёт сохранение');
    assert.equal(form.getAttribute('aria-busy'), 'true');
    form.requestSubmit(); button.click(); await settle();
    release(); await settle();
    assert.equal(puts(srv, '/media-mentor/brief').length, 1);
    assert.equal(puts(srv, '/media-mentor/inputs').length, 1);
    assert.equal(srv.state.one.brief.revision, 4, 'ровно одна новая версия брифа');
    assert.equal(button.disabled, false);
    assert.notEqual(form.getAttribute('aria-busy'), 'true');
  } finally { f.close(); }
});

test('R1: 409 профиля — подтягивается актуальная версия, чужая правка не затирается, свой ввод остаётся, повтор без перезагрузки', async () => {
  const srv = server();
  const f = page({srv});
  try {
    await f.render();
    // Другое окно сохранило доказательства после загрузки этой формы.
    srv.state.one.profile = {revision: 2, fields: {...srv.state.one.profile.fields, proofs: ['Отзыв из другого окна']}};
    const form = f.q('#cf-business-form');
    form.elements.geography.value = 'Город M';
    form.requestSubmit(); await settle();
    const text = f.q('#cf-business-state').textContent;
    assert.match(text, /вводные профиля — изменены в другом окне/);
    assert.match(text, /версия 2/);
    assert.doesNotMatch(text, /Обновите страницу/);
    assert.equal(form.elements.geography.value, 'Город M', 'свой ввод остаётся');
    assert.equal(form.elements.proofs.value, 'Отзыв из другого окна', 'поле, которое здесь не меняли, обновлено из новой версии');
    form.requestSubmit(); await settle();
    const ok = puts(srv, '/media-mentor/inputs');
    assert.equal(ok.length, 2);
    assert.deepEqual(ok[1].body, {revision: 2, profile: {geography: 'Город M'}}, 'отправлено только своё изменение по новой ревизии');
    assert.deepEqual(srv.state.one.profile.fields.proofs, ['Отзыв из другого окна'], 'правка другого окна не затёрта');
    assert.match(f.q('#cf-business-state').textContent, /^Сохранено/);
  } finally { f.close(); }
});

test('R1: 409 брифа — профиль сохраняется отдельно, бриф подтягивается, повтор отправляет только своё поле брифа', async () => {
  const srv = server();
  const f = page({srv});
  try {
    await f.render();
    srv.state.one.brief = {revision: 4, fields: {...srv.state.one.brief.fields, audience: 'Родители и школы'}};
    const form = f.q('#cf-business-form');
    form.elements.product.value = 'Новый продукт';
    form.elements.geography.value = 'Город M';
    form.requestSubmit(); await settle();
    const text = f.q('#cf-business-state').textContent;
    assert.match(text, /Частично сохранено/);
    assert.match(text, /Сохранено: вводные профиля \(версия 2\)/);
    assert.match(text, /бриф — изменён в другом окне/);
    assert.equal(form.elements.audience.value, 'Родители и школы');
    assert.equal(form.elements.product.value, 'Новый продукт');
    form.requestSubmit(); await settle();
    const briefPuts = puts(srv, '/media-mentor/brief');
    assert.deepEqual(briefPuts.at(-1).body, {revision: 4, brief: {product: 'Новый продукт'}});
    assert.equal(puts(srv, '/media-mentor/inputs').length, 1, 'сохранённый профиль не отправляется повторно');
    assert.equal(srv.state.one.brief.fields.audience, 'Родители и школы');
  } finally { f.close(); }
});

test('R1: состояние площадок — по полям DTO; пустой аккаунт не выдаётся за указанный', async () => {
  const platforms = [['telegram', 'Telegram'], ['vk', 'ВКонтакте'], ['max', 'MAX'], ['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['youtube', 'YouTube'], ['dzen', 'Дзен']]
    .map(([id, label]) => ({id, label}));
  const channels = [
    channel('telegram', {enabled: false}), // строка есть, но ничего не настроено — сценарий проверки Codex
    channel('vk', {tokenConfigured: true, status: 'needs_check'}), // ключ есть, аккаунт не указан
    channel('max', {target: '-100200', status: 'needs_check'}), // аккаунт указан, ключа нет
    channel('instagram', {target: '@synthetic', tokenConfigured: true, status: 'error', checkedAt: '2026-09-29T03:00:00.000Z'}),
    channel('tiktok', {target: '@synthetic', tokenConfigured: true, status: 'needs_check', revision: 2}),
    channel('youtube', {target: 'UCsynthetic', tokenConfigured: true, status: 'connected', connected: true, enabled: false, checkedAt: '2026-09-30T02:00:00.000Z'}),
    channel('dzen', {target: 'synthetic', tokenConfigured: true, status: 'connected', connected: true, enabled: true, checkedAt: '2026-09-30T02:00:00.000Z'})];
  const f = page({srv: server({platforms, channels})});
  try {
    await f.render();
    const row = (label) => f.qa('[data-cf-section="channels"] li').find((li) => li.querySelector('strong').textContent === label).textContent;
    assert.match(row('Telegram'), /Нужно подключить/);
    assert.match(row('ВКонтакте'), /Аккаунт не указан/);
    assert.match(row('MAX'), /Аккаунт указан, ключ доступа не задан/);
    assert.match(row('Instagram'), /Требует внимания: проверка подключения не прошла/);
    assert.match(row('Instagram'), /29\.09\.2026/);
    assert.match(row('TikTok'), /Аккаунт указан, подключение не проверено/);
    assert.match(row('YouTube'), /Подключение проверено, отправка выключена/);
    assert.match(row('Дзен'), /Подключение проверено · проверка 30\.09\.2026, 10:00/, 'время проверки в поясе проекта');
    for (const label of ['Telegram', 'ВКонтакте']) assert.doesNotMatch(row(label), /Аккаунт указан/, `${label}: пустой target`);
    const text = f.q('[data-cf-section="channels"]').textContent;
    assert.doesNotMatch(text, /не сообщают/, 'время проверки есть в DTO и показывается');
    assert.equal(f.srv.calls.filter((c) => c.method !== 'GET').length, 0, 'состояние читается, проверка подключения не запускается');
  } finally { f.close(); }
});

test('R1: событие месяца удаляется явной кнопкой', async () => {
  const f = page(); try {
    await f.render();
    const month = f.q('#cf-month');
    month.value = '2026-10'; month.dispatchEvent(new f.w.Event('change', {bubbles: true})); await settle();
    f.q('[data-cf-add-event]').click(); f.q('[data-cf-add-event]').click();
    const rows = f.qa('[data-cf-event]');
    rows[0].querySelector('[name="eventTitle"]').value = 'Первое';
    rows[1].querySelector('[name="eventTitle"]').value = 'Второе';
    const remove = rows[0].querySelector('[data-cf-remove-event]');
    assert.ok(remove, 'кнопка удаления у события');
    assert.match(remove.getAttribute('aria-label') || remove.textContent, /Удалить событие/);
    remove.click();
    assert.deepEqual(f.qa('[data-cf-event] [name="eventTitle"]').map((n) => n.value), ['Второе']);
    f.q('#cf-month-form').requestSubmit(); await settle();
    assert.deepEqual(puts(f.srv).at(-1).body.inputs.events.map((e) => e.title), ['Второе']);
  } finally { f.close(); }
});

test('R1: состояние площадок другой компании не показывается', async () => {
  const srv = server();
  const f = page({srv: {...srv, crmQuery: async (p, params, options) => {
    const result = await srv.crmQuery(p, params, options);
    return p === '/autoposting/settings' ? {...result, companyCode: 'two'} : result;
  }}});
  try {
    await f.render();
    const text = f.q('[data-cf-section="channels"]').textContent;
    assert.match(text, /Состояние площадок не загрузилось/);
    assert.doesNotMatch(text, /Подключение проверено/);
  } finally { f.close(); }
});

test('R1: 409, одно поле изменено в обоих окнах — свой ввод не затирается, расхождение названо', async () => {
  const srv = server();
  const f = page({srv});
  try {
    await f.render();
    srv.state.one.profile = {revision: 2, fields: {...srv.state.one.profile.fields, geography: 'Город K'}};
    const form = f.q('#cf-business-form');
    form.elements.geography.value = 'Город M';
    form.requestSubmit(); await settle();
    assert.equal(form.elements.geography.value, 'Город M', 'своё значение остаётся в форме');
    assert.match(f.q('#cf-business-state').textContent, /в обоих окнах изменено: география — при повторе сохранится ваш вариант/);
    assert.equal(srv.state.one.profile.fields.geography, 'Город K', 'до повтора ничего не перезаписано');
    form.requestSubmit(); await settle();
    assert.deepEqual(puts(srv, '/media-mentor/inputs').at(-1).body, {revision: 2, profile: {geography: 'Город M'}});
  } finally { f.close(); }
});

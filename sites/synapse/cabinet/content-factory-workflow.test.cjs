'use strict';
// CF23: «Настройки модуля» → «Подготовка и выпуск» (GET/PUT /media-mentor/workflow). Синтетический CRM в памяти по CONTRACT.md
// снимка CONTENT_FACTORY_CF23_BACKEND_REVIEW_20261001. Реальных API нет.
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
function server({brief = {}, profile = {}, delay = null, platforms = PLATFORMS, channels = CHANNELS, workflowHook = null} = {}) {
  const state = {};
  const workflows = {one: {revision: 0, configured: false, fields: {releaseMode: 'manual', publisherName: '', hours: [], preparationDays: 0, reviewDays: 0}},
    two: {revision: 0, configured: false, fields: {releaseMode: 'manual', publisherName: '', hours: [], preparationDays: 0, reviewDays: 0}}};
  const wfDto = (code) => JSON.parse(JSON.stringify({companyCode: code, revision: workflows[code].revision, configured: workflows[code].configured, fields: workflows[code].fields, approverRole: 'owner'}));
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
    if (p === '/media-mentor/workflow') {
      if (workflowHook) { const out = await workflowHook({method, body, code, state: workflows}); if (out !== undefined) return out; }
      const w = workflows[code];
      if (method === 'GET') return wfDto(code);
      if (method === 'PUT') {
        if (body.revision !== w.revision) throw Object.assign(new Error('Настройки выпуска уже изменили. Обновите страницу.'), {status: 409, code: 'REVISION_CONFLICT'});
        const fields = {...w.fields, ...body.fields};
        if (w.configured && JSON.stringify(fields) === JSON.stringify(w.fields)) return wfDto(code);
        Object.assign(w, {revision: w.revision + 1, configured: true, fields}); return wfDto(code);
      }
    }
    if (p === '/autoposting/settings') return {companyCode: code, timezone: 'Asia/Irkutsk', channels};
    throw Object.assign(new Error('Неожиданный адрес ' + p), {status: 404});
  }
  return {state, calls, crmQuery, workflows};
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


const wf = (f) => f.q('[data-cf-workflow]');
const set = (f, name, value) => { const el = wf(f).elements[name]; el.value = value; el.dispatchEvent(new f.w.Event('input', {bubbles: true})); };
const mode = (f, value) => { const el = wf(f).querySelector(`[name="releaseMode"][value="${value}"]`); el.checked = true; el.dispatchEvent(new f.w.Event('change', {bubbles: true})); };
const save = async (f) => { wf(f).querySelector('[data-cf-workflow-save]').click(); await settle(); };
const status = (f) => wf(f).querySelector('[data-cf-workflow-status]').textContent;
const err = (f, id) => wf(f).querySelector(`[data-cf-workflow-error="${id}"]`);
const puts = (f) => f.srv.calls.filter((c) => c.method === 'PUT');

test('CF23 выпуск: свёрнутый блок; первая загрузка ничего не пишет; режим «ещё не выбран» без отметки; подсказки и пояснения', async () => {
  const f = page(); try {
    await f.render();
    const block = f.q('[data-cf-section="planning"]');
    assert.equal(block.open, false); assert.match(block.querySelector('summary').textContent, /Подготовка и выпуск/);
    assert.ok(f.srv.calls.some((c) => c.path === '/media-mentor/workflow' && c.method === 'GET' && c.code === 'one'));
    assert.deepEqual(puts(f), [], 'загрузка ничего не сохраняет');
    assert.match(block.textContent, /Режим ещё не выбран — сохранённых настроек выпуска нет/);
    assert.deepEqual(f.qa('[name="releaseMode"]').map((n) => [n.value, n.checked]), [['manual', false], ['scheduled', false]], 'manual по умолчанию — не выбор пользователя');
    for (const id of ['releaseMode', 'hours', 'preparationDays', 'reviewDays', 'publisherName', 'approver']) assert.ok(f.q(`[aria-controls="cf-hint-${id}"]`), 'подсказка ' + id);
    f.q('[aria-controls="cf-hint-publisherName"]').click();
    assert.match(f.q('#cf-hint-publisherName').textContent, /не подключённый аккаунт и не назначенная задача. Например: Дарья/);
    assert.match(f.q('[data-cf-workflow-approver]').textContent, /Владелец кабинета/); assert.equal(f.q('[data-cf-workflow-approver] input'), null, 'согласующий только для чтения');
    const notes = f.q('[data-cf-workflow-notes]').textContent;
    assert.match(notes, /действует на новые назначения; уже стоящую очередь не отменяет/);
    assert.match(notes, /сам расписание не создаёт и генерацию не запускает/);
    assert.match(notes, /не обещанные даты готовности/);
    assert.match(block.textContent, /Asia\/Irkutsk/);
    await save(f);
    assert.match(err(f, 'releaseMode').textContent, /Выберите режим выпуска: первое сохранение фиксирует ваш выбор/);
    assert.equal(err(f, 'releaseMode').hidden, false); assert.deepEqual(puts(f), [], 'без явного режима не отправляется');
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('CF23 выпуск: ошибки рядом с полем до запроса; сохранение одним PUT с ревизией и всеми полями; поля показывают сохранённое', async () => {
  const f = page(); try {
    await f.render();
    mode(f, 'scheduled'); set(f, 'hours', '18:30, 25:00'); set(f, 'preparationDays', '31'); set(f, 'publisherName', '  Дарья  ');
    await save(f);
    assert.match(err(f, 'hours').textContent, /«25:00» — укажите время как ЧЧ:ММ/); assert.match(err(f, 'preparationDays').textContent, /от 0 до 30/);
    assert.deepEqual(puts(f), []);
    set(f, 'hours', '18:30, 10:00'); set(f, 'preparationDays', '3'); set(f, 'reviewDays', '1');
    await save(f);
    assert.equal(err(f, 'hours').hidden, true);
    assert.equal(puts(f).length, 1);
    assert.deepEqual(puts(f)[0].body, {revision: 0, fields: {releaseMode: 'scheduled', publisherName: 'Дарья', hours: ['10:00', '18:30'], preparationDays: 3, reviewDays: 1}});
    assert.match(status(f), /Сохранено: версия 1\. Действует для новых назначений; очередь, расписание и генерация не изменены/);
    assert.equal(wf(f).elements.hours.value, '10:00, 18:30'); assert.equal(wf(f).elements.publisherName.value, 'Дарья');
    assert.match(f.q('[data-cf-workflow-state]').textContent, /Сохранено: версия 1/);
    assert.ok(f.srv.calls.every((c) => c.method === 'GET' || c.path === '/media-mentor/workflow'), 'ничего кроме настроек выпуска не пишется');
    await save(f);
    assert.equal(puts(f)[1].body.revision, 1); assert.match(status(f), /Изменений нет — действует сохранённая версия 1/);
  } finally { f.close(); }
});

test('CF23 выпуск: 409 — ввод остаётся, перечитана сохранённая версия; следующее сохранение только по нажатию', async () => {
  const f = page(); try {
    await f.render();
    f.srv.workflows.one = {revision: 2, configured: true, fields: {releaseMode: 'manual', publisherName: 'Анна', hours: ['09:00'], preparationDays: 1, reviewDays: 1}};
    mode(f, 'scheduled'); set(f, 'publisherName', 'Дарья'); set(f, 'hours', '12:00');
    await save(f);
    assert.match(status(f), /уже изменили в другом окне \(версия 2\)\. Ваш ввод не сохранён и остаётся в форме/);
    assert.match(f.q('[data-cf-workflow-state]').textContent, /На сервере сейчас версия 2: ручной выпуск; часы: 09:00.*выпускает: Анна/);
    assert.equal(wf(f).elements.publisherName.value, 'Дарья'); assert.equal(wf(f).elements.hours.value, '12:00');
    assert.equal(wf(f).querySelector('[value="scheduled"]').checked, true);
    assert.equal(puts(f).length, 1, 'автоповтора нет');
    await save(f);
    assert.equal(puts(f)[1].body.revision, 2); assert.match(status(f), /Сохранено: версия 3/);
    assert.equal(f.srv.workflows.one.fields.publisherName, 'Дарья');
  } finally { f.close(); }
});

test('CF23 выпуск: ответ потерян или не подтверждает сохранение — не успех; «Проверить» сверяет с вводом', async () => {
  let mode2 = 'network';
  const srv = server({workflowHook: ({method, body, code, state}) => {
    if (method !== 'PUT') return undefined;
    if (mode2 === 'network') { Object.assign(state[code], {revision: state[code].revision + 1, configured: true, fields: {...state[code].fields, ...body.fields}}); throw new Error('Failed to fetch'); }
    if (mode2 === 'foreign') return {companyCode: 'two', revision: 9, configured: true, fields: body.fields};
    return undefined;
  }});
  const f = page({srv}); try {
    await f.render();
    mode(f, 'manual'); set(f, 'publisherName', 'Дарья');
    await save(f);
    assert.match(status(f), /Ответ сервера не получен \(Failed to fetch\)\. Настройки могли сохраниться\. Ввод остаётся в форме/);
    assert.doesNotMatch(status(f), /^Сохранено/);
    const check = wf(f).querySelector('[data-cf-workflow-check]'); assert.equal(check.hidden, false);
    check.click(); await settle();
    assert.match(status(f), /Подтверждено перечитыванием: сохранено, версия 1/); assert.equal(check.hidden, true);
    mode2 = 'foreign'; set(f, 'publisherName', 'Ирина');
    await save(f);
    assert.match(status(f), /Ответ сервера не подтвердил сохранение\. Ввод остаётся в форме/);
    assert.equal(wf(f).elements.publisherName.value, 'Ирина');
    wf(f).querySelector('[data-cf-workflow-check]').click(); await settle();
    assert.match(status(f), /Ваш ввод не сохранён — на сервере версия 1 с другими значениями/);
  } finally { f.close(); }
});

test('CF23 выпуск: 400 и 403 — честно не сохранено; без права правки — только просмотр; маршрут не подключён — без полей', async () => {
  for (const [error, pattern] of [[Object.assign(new Error('Укажите до 24 разных часов'), {status: 400}), /Сервер не принял настройки: Укажите до 24 разных часов\. Ничего не сохранено/],
    [Object.assign(new Error('Недостаточно прав'), {status: 403}), /Недостаточно прав для изменения настроек выпуска\. Ничего не сохранено/]]) {
    const f = page({srv: server({workflowHook: ({method}) => { if (method === 'PUT') throw error; return undefined; }})}); try {
      await f.render(); mode(f, 'scheduled'); set(f, 'hours', '10:00'); await save(f);
      assert.match(status(f), pattern); assert.equal(wf(f).elements.hours.value, '10:00');
    } finally { f.close(); }
  }
  const view = page({role: 'client', permissions: ['autoposting.view']}); try {
    await view.render();
    assert.ok(view.qa('[data-cf-workflow] input').every((n) => n.disabled)); assert.equal(view.q('[data-cf-workflow-save]'), null);
    assert.match(view.q('[data-cf-workflow]').textContent, /Изменить может участник с правом «Автопостинг: правка»/);
  } finally { view.close(); }
  const off = page({srv: server({workflowHook: () => { throw Object.assign(new Error('Not found'), {status: 404}); }})}); try {
    await off.render();
    assert.match(off.q('[data-cf-section="planning"]').textContent, /Настройки выпуска на сервере пока не подключены/);
    assert.equal(off.q('[data-cf-workflow]'), null);
  } finally { off.close(); }
});

test('CF23 выпуск: смена компании — ответ прежней компании не рисуется, форма новой своя', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const srv = server({workflowHook: async ({method, code}) => { if (method === 'GET' && code === 'one') await gate; return undefined; }});
  srv.workflows.two = {revision: 4, configured: true, fields: {releaseMode: 'scheduled', publisherName: 'Компания два', hours: ['11:00'], preparationDays: 2, reviewDays: 2}};
  const f = page({srv}); try {
    void f.render(); await settle();
    await f.render({...f.ctx, selectedProjectId: 'two'});
    release(); await settle();
    assert.equal(wf(f).elements.publisherName.value, 'Компания два'); assert.match(f.q('[data-cf-workflow-state]').textContent, /Сохранено: версия 4/);
    assert.equal(wf(f).querySelector('[value="scheduled"]').checked, true);
  } finally { f.close(); }
});

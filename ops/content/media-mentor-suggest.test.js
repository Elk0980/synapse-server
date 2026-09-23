'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMediaMentorSuggest, createMediaMentorSuggestRoute } = require('./media-mentor-suggest');

const BRIEF = {
  goal: 'Записи на массаж', product: 'Тайский массаж', audience: 'Женщины 30-45',
  pains: ['болит спина'], confirmedFacts: [{ id: 'f1', statement: 'Работаем с 2019', source: 'сайт' }],
  assets: [{ id: 'a1', title: 'Фото кабинета', kind: 'photo', note: '' }],
  shootingComfort: { level: 'hands_only', notes: '' }, platforms: ['vk', 'telegram'],
};
const fake = (text) => async () => (text === null ? null : { text, provider: 'deepseek', model: 'deepseek-flash' });
const row = (over = {}) => ({ date: '2026-09-21', platform: 'vk', format: 'post', role: 'reach',
  topic: 'Тема', hook: 'Зацепка', assetId: '', mentorNote: '', ...over });

test('нормальный ответ превращается в позиции плана', async () => {
  const s = createMediaMentorSuggest({ ask: fake(JSON.stringify([row(), row({ date: '2026-09-22', platform: 'telegram' })])) });
  const out = await s.suggest(BRIEF, { startDate: '2026-09-21', days: 7 });
  assert.equal(out.status, 'ok');
  assert.equal(out.items.length, 2);
  assert.equal(out.capabilities.saved, false);
  assert.equal(out.capabilities.approved, false);
});

test('модель получает только факты, которые владелец разрешил для контента', async () => {
  const brief = {...BRIEF, confirmedFacts: [
    {id: 'internal', statement: 'Внутренний технический отчёт', source: 'закрытая CRM'},
    {id: 'public', statement: 'Часы приёма 10–20', source: 'официальный сайт', approvedForContent: true},
  ]};
  const prompts = [];
  const s = createMediaMentorSuggest({ask: async (payload) => {
    prompts.push(JSON.parse(payload).messages[0].content);
    return {text: prompts.length === 1 ? JSON.stringify([row()]) : JSON.stringify({
      positioning: 'Салон', rubrics: [{title: 'Вопросы', why: 'польза', formats: ['post']}], gaps: []})};
  }});
  await s.suggest(brief, {startDate: '2026-09-21', days: 7});
  await s.analyze(brief);
  for (const prompt of prompts) {
    assert.match(prompt, /Часы приёма 10–20/);
    assert.doesNotMatch(prompt, /Внутренний технический отчёт|закрытая CRM/);
  }
});

test('площадка вне брифа отбрасывается с причиной', async () => {
  const s = createMediaMentorSuggest({ ask: fake(JSON.stringify([row(), row({ platform: 'instagram' })])) });
  const out = await s.suggest(BRIEF, { startDate: '2026-09-21', days: 7 });
  assert.equal(out.items.length, 1);
  assert.ok(out.dropped.some((d) => d.includes('instagram')));
});

test('формат и роль вне словаря не принимаются', async () => {
  const s = createMediaMentorSuggest({ ask: fake(JSON.stringify([row({ format: 'lives' }), row({ role: 'viral' })])) });
  const out = await s.suggest(BRIEF, { startDate: '2026-09-21', days: 7 });
  assert.equal(out.status, 'unusable');
  assert.equal(out.items.length, 0);
});

test('выдуманный материал стирается, позиция остаётся', async () => {
  const s = createMediaMentorSuggest({ ask: fake(JSON.stringify([row({ assetId: 'a999' })])) });
  const out = await s.suggest(BRIEF, { startDate: '2026-09-21', days: 7 });
  assert.equal(out.items[0].assetId, '');
  assert.ok(out.dropped.some((d) => d.includes('a999')));
});

test('существующий материал сохраняется', async () => {
  const s = createMediaMentorSuggest({ ask: fake(JSON.stringify([row({ assetId: 'a1' })])) });
  const out = await s.suggest(BRIEF, { startDate: '2026-09-21', days: 7 });
  assert.equal(out.items[0].assetId, 'a1');
});

test('дата вне окна плана отбрасывается', async () => {
  const s = createMediaMentorSuggest({ ask: fake(JSON.stringify([row({ date: '2026-10-30' }), row()])) });
  const out = await s.suggest(BRIEF, { startDate: '2026-09-21', days: 7 });
  assert.equal(out.items.length, 1);
  assert.ok(out.dropped.some((d) => d.includes('2026-10-30')));
});

test('больше трёх позиций в день не проходит', async () => {
  const s = createMediaMentorSuggest({ ask: fake(JSON.stringify([row(), row(), row(), row()])) });
  const out = await s.suggest(BRIEF, { startDate: '2026-09-21', days: 7 });
  assert.equal(out.items.length, 3);
  assert.ok(out.dropped.some((d) => d.includes('сверх 3')));
});

test('недоступный провайдер не выдаёт пустой план за результат', async () => {
  const s = createMediaMentorSuggest({ ask: fake(null) });
  const out = await s.suggest(BRIEF, { startDate: '2026-09-21', days: 7 });
  assert.equal(out.status, 'unavailable');
  assert.equal(out.items.length, 0);
});

test('болтовня вместо JSON не превращается в план', async () => {
  const s = createMediaMentorSuggest({ ask: fake('Конечно! Вот ваш отличный план на неделю.') });
  const out = await s.suggest(BRIEF, { startDate: '2026-09-21', days: 7 });
  assert.equal(out.status, 'unusable');
});

test('JSON в разметке всё равно разбирается', async () => {
  const s = createMediaMentorSuggest({ ask: fake('```json\n' + JSON.stringify([row()]) + '\n```') });
  const out = await s.suggest(BRIEF, { startDate: '2026-09-21', days: 7 });
  assert.equal(out.status, 'ok');
});

test('бриф без площадок не идёт к модели', async () => {
  let called = false;
  const s = createMediaMentorSuggest({ ask: async () => { called = true; return { text: '[]' }; } });
  const out = await s.suggest({ ...BRIEF, platforms: [] }, { startDate: '2026-09-21', days: 7 });
  assert.equal(out.status, 'brief_incomplete');
  assert.equal(called, false);
});

test('длина плана вне 7-14 дней отклоняется', async () => {
  const s = createMediaMentorSuggest({ ask: fake('[]') });
  await assert.rejects(() => s.suggest(BRIEF, { startDate: '2026-09-21', days: 3 }));
  await assert.rejects(() => s.suggest(BRIEF, { startDate: '2026-09-21', days: 30 }));
});

test('даты в задании ставит код, а не модель', async () => {
  const s = createMediaMentorSuggest({ ask: fake('[]') });
  const prompt = s.buildPrompt(BRIEF, { startDate: '2026-09-21', days: 7 });
  assert.ok(prompt.messages[0].content.includes('2026-09-21'));
  assert.ok(prompt.messages[0].content.includes('2026-09-27'));
  assert.ok(!prompt.messages[0].content.includes('2026-09-28'));
});

test('задание на план объясняет ОВП и учитывает комфорт съёмки без обещаний алгоритма', async () => {
  let payload;
  const s = createMediaMentorSuggest({ask: async (p) => { payload = JSON.parse(p); return {text: JSON.stringify(days())}; }});
  await s.suggest(BRIEF, {startDate: '2026-10-01', days: 7});
  assert.match(payload.system, /reach — охват/);
  assert.match(payload.system, /affection — доверие/);
  assert.match(payload.system, /sale — отдельное конкретное предложение/);
  assert.match(payload.system, /лицо и голос не требуй/);
  assert.match(payload.system, /зачем мы это просим/);
  assert.match(payload.system, /Не навязывай фиксированные дни/);
});

test('в задание не попадают исходники, которых нет, и не теряется источник факта', async () => {
  const s = createMediaMentorSuggest({ ask: fake('[]') });
  const brief = {...BRIEF, confirmedFacts: BRIEF.confirmedFacts.map((fact) => ({...fact, approvedForContent: true}))};
  const prompt = s.buildPrompt(brief, { startDate: '2026-09-21', days: 7 });
  assert.ok(prompt.messages[0].content.includes('a1 — Фото кабинета [photo]'));
  assert.ok(prompt.messages[0].content.includes('источник: сайт'));
});

test('сбой транспорта не выпускает исключение в кабинет', async () => {
  const s = createMediaMentorSuggest({ ask: async () => { throw Error('runtime down'); } });
  const out = await s.suggest(BRIEF, { startDate: '2026-09-21', days: 7 });
  assert.equal(out.status, 'unavailable');
  assert.equal(out.items.length, 0);
});

test('к модели уходит строка JSON, а не объект', async () => {
  let got = null;
  const s = createMediaMentorSuggest({ ask: async (payload) => { got = payload; return { text: '[]' }; } });
  await s.suggest(BRIEF, { startDate: '2026-09-21', days: 7 });
  assert.equal(typeof got, 'string');
  const parsed = JSON.parse(got);
  assert.ok(parsed.system && Array.isArray(parsed.messages));
});

// --- маршрут ---
const fail = (status, message) => { const e = Error(message); e.status = status; throw e; };
const routeDeps = (over = {}) => ({
  suggester: { suggest: async () => ({ status: 'ok', items: [], dropped: [], notice: 'n' }),
    analyze: async () => ({ status: 'ok', rubrics: [], gaps: [], dropped: [], notice: 'n' }),
    review: async () => ({ status: 'ok', findings: [], planChanges: [], questions: [], dropped: [], notice: 'n' }) },
  loadBrief: async () => BRIEF,
  loadStats: async () => ({ overview: {}, plan: null }),
  requireSession: () => ({ user: { role: 'owner' } }),
  requireCsrf: () => {}, requirePermission: () => { throw Error('право не должно спрашиваться у владельца'); },
  sendJson: () => {}, readBody: async () => ({ startDate: '2026-09-21', days: 7 }), fail, ...over,
});
const req = (method = 'POST') => ({ method });
const link = (path = '/content/media-mentor-suggest', search = '?companyCode=alvi') => new URL(`https://x${path}${search}`);

test('чужой адрес маршрут не перехватывает', async () => {
  const r = createMediaMentorSuggestRoute(routeDeps());
  assert.equal(await r.handle(req(), {}, link('/content/owner-chat', '')), false);
});

test('без companyCode маршрут отказывает', async () => {
  const r = createMediaMentorSuggestRoute(routeDeps());
  await assert.rejects(() => r.handle(req(), {}, link('/content/media-mentor-suggest', '')), /Выберите компанию/);
});

test('не-владелец обязан иметь право правки автопостинга', async () => {
  let asked = null;
  const r = createMediaMentorSuggestRoute(routeDeps({
    requireSession: () => ({ user: { role: 'manager' } }),
    requirePermission: (_request, permission, code) => { asked = `${permission}:${code}`; },
  }));
  await r.handle(req(), {}, link());
  assert.equal(asked, 'autoposting.edit:alvi');
});

test('бриф берётся с сервера, а не из тела запроса', async () => {
  let asked = null;
  const r = createMediaMentorSuggestRoute(routeDeps({ loadBrief: async (code) => { asked = code; return BRIEF; } }));
  await r.handle(req(), {}, link());
  assert.equal(asked, 'alvi');
});

test('чтение брифа и статистики получает подтверждённую личность сессии', async () => {
  const identity = {id: 'owner-1', role: 'owner'};
  let briefIdentity, statsIdentity;
  const r = createMediaMentorSuggestRoute(routeDeps({
    requireSession: () => ({user: identity}),
    loadBrief: async (_code, received) => { briefIdentity = received; return BRIEF; },
    loadStats: async (_code, _period, received) => { statsIdentity = received; return {overview: OVERVIEW(), plan: PLAN}; },
    readBody: async (request) => request.review ? {} : {startDate: '2026-09-21', days: 7},
  }));
  await r.handle(req(), {}, link());
  const reviewRequest = {...req(), review: true};
  await r.handle(reviewRequest, {}, link('/content/media-mentor-review'));
  assert.equal(briefIdentity, identity);
  assert.equal(statsIdentity, identity);
});

test('лишние поля в теле не принимаются', async () => {
  const r = createMediaMentorSuggestRoute(routeDeps({ readBody: async () => ({ startDate: '2026-09-21', brief: {} }) }));
  await assert.rejects(() => r.handle(req(), {}, link()), /лишние поля/);
});

test('GET не поддерживается', async () => {
  const r = createMediaMentorSuggestRoute(routeDeps());
  await assert.rejects(() => r.handle(req('GET'), {}, link()), /Метод не поддерживается/);
});

test('отсутствующий бриф — 404, а не пустое предложение', async () => {
  const r = createMediaMentorSuggestRoute(routeDeps({ loadBrief: async () => null }));
  await assert.rejects(() => r.handle(req(), {}, link()), /Бриф компании не найден/);
});

// --- разбор брифа ---
const analysis = (over = {}) => JSON.stringify({ positioning: 'Салон у дома', audience: 'Женщины 30-45',
  rubrics: [{ title: 'До и после', why: 'показывает результат', formats: ['post', 'reel'] }],
  gaps: ['нет цен'], ...over });

test('разбор брифа возвращает позиционирование, рубрики и пробелы', async () => {
  const s = createMediaMentorSuggest({ ask: fake(analysis()) });
  const out = await s.analyze(BRIEF);
  assert.equal(out.status, 'ok');
  assert.equal(out.positioning, 'Салон у дома');
  assert.equal(out.rubrics.length, 1);
  assert.deepEqual(out.rubrics[0].formats, ['post', 'reel']);
  assert.deepEqual(out.gaps, ['нет цен']);
  assert.equal(out.capabilities.factsVerified, false);
});

test('формат рубрики вне словаря удаляется и это видно', async () => {
  const s = createMediaMentorSuggest({ ask: fake(analysis({
    rubrics: [{ title: 'Прямые эфиры', why: '', formats: ['live', 'post'] }] })) });
  const out = await s.analyze(BRIEF);
  assert.deepEqual(out.rubrics[0].formats, ['post']);
  assert.ok(out.dropped.some((d) => d.includes('Прямые эфиры')));
});

test('рубрика без названия не проходит', async () => {
  const s = createMediaMentorSuggest({ ask: fake(analysis({ rubrics: [{ title: '  ', why: 'x', formats: ['post'] }] })) });
  const out = await s.analyze(BRIEF);
  assert.equal(out.rubrics.length, 0);
  assert.ok(out.dropped.some((d) => d.includes('без названия')));
});

test('больше восьми рубрик не принимается', async () => {
  const many = Array.from({ length: 12 }, (unused, i) => ({ title: `Р${i}`, why: '', formats: ['post'] }));
  const s = createMediaMentorSuggest({ ask: fake(analysis({ rubrics: many })) });
  const out = await s.analyze(BRIEF);
  assert.equal(out.rubrics.length, 8);
  assert.ok(out.dropped.some((d) => d.includes('больше 8')));
});

test('разбор без позиционирования и рубрик не выдаётся за результат', async () => {
  const s = createMediaMentorSuggest({ ask: fake(JSON.stringify({ positioning: '', rubrics: [], gaps: ['что-то'] })) });
  const out = await s.analyze(BRIEF);
  assert.equal(out.status, 'unusable');
});

test('недоступная модель при разборе не выдаёт пустой разбор', async () => {
  const s = createMediaMentorSuggest({ ask: fake(null) });
  const out = await s.analyze(BRIEF);
  assert.equal(out.status, 'unavailable');
  assert.equal(out.rubrics.length, 0);
});

test('маршрут разбора не принимает параметры плана', async () => {
  const r = createMediaMentorSuggestRoute(routeDeps({
    suggester: { suggest: async () => ({}), analyze: async () => ({ status: 'ok' }), review: async () => ({}) },
    readBody: async () => ({ startDate: '2026-09-21' }) }));
  await assert.rejects(() => r.handle(req(), {}, link('/content/media-mentor-analyze')), /лишние поля/);
});

test('маршрут разбора зовёт именно разбор', async () => {
  let which = '';
  const r = createMediaMentorSuggestRoute(routeDeps({
    suggester: { suggest: async () => { which = 'suggest'; return {}; },
      analyze: async () => { which = 'analyze'; return {}; }, review: async () => ({}) },
    readBody: async () => ({}) }));
  await r.handle(req(), {}, link('/content/media-mentor-analyze'));
  assert.equal(which, 'analyze');
});

// --- разбор статистики ---
const OVERVIEW = (over = {}) => ({ from: '2026-09-01', to: '2026-09-19', platforms: {
  vk: { dataStatus: 'complete', totals: { views: 1200, likes: 48 }, latest: { followers: { value: 310 } } },
  telegram: { dataStatus: 'no_data', totals: {}, latest: {} },
}, ...over });
const PLAN = { days: [
  { date: '2026-09-01', platform: 'vk', format: 'post', role: 'reach' },
  { date: '2026-09-02', platform: 'vk', format: 'reel', role: 'sale' } ] };
const reviewAnswer = (over = {}) => JSON.stringify({
  findings: [{ statement: 'Охват растёт', basis: 'views=1200' }],
  planChanges: [{ action: 'strengthen', platform: 'vk', format: 'reel', why: 'больше просмотров' }],
  questions: [], ...over });

test('разбор статистики даёт выводы и правки плана', async () => {
  const s = createMediaMentorSuggest({ ask: fake(reviewAnswer()) });
  const out = await s.review(OVERVIEW(), PLAN);
  assert.equal(out.status, 'ok');
  assert.equal(out.findings[0].basis, 'views=1200');
  assert.equal(out.planChanges[0].actionLabel, 'усилить');
  assert.equal(out.capabilities.planChanged, false);
});

test('площадка без данных в задание не попадает', async () => {
  let payload = null;
  const s = createMediaMentorSuggest({ ask: async (p) => { payload = p; return { text: reviewAnswer() }; } });
  await s.review(OVERVIEW(), PLAN);
  const user = JSON.parse(payload).messages[0].content;
  assert.ok(user.includes('vk: views=1200'));
  assert.ok(user.includes('без данных (о них выводов не делай): telegram'));
});

test('вывод по площадке без данных отбрасывается', async () => {
  const s = createMediaMentorSuggest({ ask: fake(reviewAnswer({
    planChanges: [{ action: 'reduce', platform: 'telegram', format: '', why: 'там провал' }] })) });
  const out = await s.review(OVERVIEW(), PLAN);
  assert.equal(out.planChanges.length, 0);
  assert.ok(out.dropped.some((d) => d.includes('telegram')));
});

test('вывод без опоры на цифру не принимается', async () => {
  const s = createMediaMentorSuggest({ ask: fake(reviewAnswer({
    findings: [{ statement: 'Кажется, стало лучше', basis: '' }] })) });
  const out = await s.review(OVERVIEW(), PLAN);
  assert.equal(out.findings.length, 0);
  assert.ok(out.dropped.some((d) => d.includes('без опоры')));
});

test('действие вне словаря отбрасывается', async () => {
  const s = createMediaMentorSuggest({ ask: fake(reviewAnswer({
    planChanges: [{ action: 'удалить всё', platform: 'vk', format: '', why: 'x' }] })) });
  const out = await s.review(OVERVIEW(), PLAN);
  assert.equal(out.planChanges.length, 0);
  assert.ok(out.dropped.some((d) => d.includes('вне словаря')));
});

test('без данных по всем площадкам к модели не обращаемся', async () => {
  let called = false;
  const s = createMediaMentorSuggest({ ask: async () => { called = true; return { text: reviewAnswer() }; } });
  const out = await s.review(OVERVIEW({ platforms: { vk: { dataStatus: 'no_data', totals: {}, latest: {} } } }), PLAN);
  assert.equal(out.status, 'no_data');
  assert.equal(called, false);
  assert.match(out.notice, /были бы выдумкой/);
});

test('неполные данные помечаются в задании', async () => {
  let payload = null;
  const s = createMediaMentorSuggest({ ask: async (p) => { payload = p; return { text: reviewAnswer() }; } });
  await s.review(OVERVIEW({ platforms: { vk: { dataStatus: 'partial', totals: { views: 10 }, latest: {} } } }), PLAN);
  assert.ok(JSON.parse(payload).messages[0].content.includes('данные неполные'));
});

test('план без дней не выдаётся за существующий', async () => {
  let payload = null;
  const s = createMediaMentorSuggest({ ask: async (p) => { payload = p; return { text: reviewAnswer() }; } });
  await s.review(OVERVIEW(), null);
  assert.ok(JSON.parse(payload).messages[0].content.includes('Текущий план: плана нет'));
});

test('маршрут разбора статистики зовёт статистику, а не бриф', async () => {
  let which = '', briefAsked = false;
  const r = createMediaMentorSuggestRoute(routeDeps({
    suggester: { suggest: async () => ({}), analyze: async () => ({}), review: async () => { which = 'review'; return {}; } },
    loadBrief: async () => { briefAsked = true; return BRIEF; },
    loadStats: async () => ({ overview: OVERVIEW(), plan: PLAN }),
    readBody: async () => ({ from: '2026-09-01', to: '2026-09-19' }) }));
  await r.handle(req(), {}, link('/content/media-mentor-review'));
  assert.equal(which, 'review');
  assert.equal(briefAsked, false);
});

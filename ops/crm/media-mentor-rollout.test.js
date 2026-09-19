'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createMediaMentorRollout, createMediaMentorRolloutHandler, TRACKS, STAGES} =
  require('./media-mentor-rollout');

const DAY = 24 * 60 * 60 * 1000;
const required = (track) => STAGES.filter((stage) => stage.track === track && stage.required);
const optional = (track) => STAGES.filter((stage) => stage.track === track && !stage.required);
const PRODUCT_REQUIRED = required('product').length, COMPANY_REQUIRED = required('company').length;
const ADMIN = {userId: 1, userName: 'Владелец', role: 'owner'};
const CLIENT = {userId: 7, userName: 'Клиент', role: 'editor'};

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,timezone TEXT,
      is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies(id,code,name,timezone) VALUES(1,'alvi','ALVI','Asia/Irkutsk'),(2,'avokado','Авокадо','UTC');`);
  let time = Date.parse('2026-09-19T09:00:00Z');
  const options = {now: () => time};
  return {db, options, api: createMediaMentorRollout(db, options),
    advance: (ms) => { time += ms; return time; }, at: () => time};
}
const stage = (state, key) => state.stages.find((item) => item.key === key);
const doneStage = (key, confirmedOn, evidence) => ({key, status: 'done', confirmedOn, evidence});
// Закрывает всю обязательную дорожку одним сохранением.
const closeTrack = (api, code, track, revision, actor) => api.saveStages(code, {revision,
  stages: required(track).map((item) => doneStage(item.key, '2026-09-19', `Основание ${item.key}`))}, actor);

test('пустая карточка не объявляет незавершённое готовым и даёт свой знаменатель каждой дорожке', (t) => {
  const f = fixture(t), state = f.api.get('alvi');
  assert.equal(state.companyCode, 'alvi');
  assert.equal(state.revision, 0);
  assert.equal(state.stages.length, STAGES.length);
  assert.ok(state.stages.every((item) => item.status === 'not_started'));
  assert.ok(state.stages.every((item) => item.evidence === '' && item.blocker === '' && item.confirmedOn === null));
  assert.deepEqual(state.tracks.map((track) => track.key), ['product', 'company']);
  assert.match(state.tracksBasis, /никогда не складываются/);
  assert.deepEqual(
    [state.progress.product.requiredTotal, state.progress.company.requiredTotal],
    [PRODUCT_REQUIRED, COMPANY_REQUIRED]);
  assert.deepEqual([state.progress.product.percent, state.progress.company.percent], [0, 0]);
  assert.equal(state.progress.product.label, `0 из ${PRODUCT_REQUIRED} обязательных этапов дорожки «Разработка модуля»`);
  assert.equal(state.progress.company.label, `0 из ${COMPANY_REQUIRED} обязательных этапов дорожки «Настройка у клиента»`);
  assert.match(state.progress.product.basis, /Готовность модуля не означает/);
  assert.match(state.progress.company.basis, /не означает, что модуль дописан/);
  assert.equal(state.nextStep.product.stageKey, 'product_storage');
  assert.equal(state.nextStep.company.stageKey, 'company_brief');
  assert.equal(state.nextStep.company.reason, 'Начать этап');
  assert.deepEqual(state.capabilities,
    {stageEditing: 'admin', clientAccess: 'autoposting.view', surveyChannel: 'cabinet',
      outboundMessages: false, scheduledReminders: false, modelSuggestions: false});
});

test('дорожки считаются раздельно: настройка у клиента не выдаётся за готовность модуля', (t) => {
  const f = fixture(t);
  const client = closeTrack(f.api, 'alvi', 'company', 0, ADMIN);
  assert.equal(client.progress.company.percent, 100);
  assert.equal(client.progress.company.requiredDone, COMPANY_REQUIRED);
  // Ключевая проверка: клиент всё заполнил, а модуль от этого готовым не стал.
  assert.equal(client.progress.product.percent, 0);
  assert.equal(client.progress.product.requiredDone, 0);
  assert.equal(client.nextStep.product.stageKey, 'product_storage');
  assert.equal(client.nextStep.company.stageKey, 'company_analytics', 'обязательные закрыты, следующий — необязательный');
  const product = f.api.saveStages('alvi',
    {revision: client.revision, stages: [doneStage('product_storage', '2026-09-19', 'Модуль и его тесты')]}, ADMIN);
  assert.equal(product.progress.product.requiredDone, 1);
  assert.equal(product.progress.product.percent, Math.round((1 / PRODUCT_REQUIRED) * 100));
  assert.equal(product.progress.company.percent, 100, 'дорожка клиента не меняется от правки модуля');
  assert.equal(product.progress.company.requiredTotal, COMPANY_REQUIRED);
  // Необязательные этапы не входят в процент ни одной дорожки.
  const extra = f.api.saveStages('alvi',
    {revision: product.revision, stages: [doneStage('product_suggestions', '2026-09-19', 'Подсказки включены')]}, ADMIN);
  assert.equal(extra.progress.product.percent, product.progress.product.percent);
  assert.deepEqual([extra.progress.product.optionalDone, extra.progress.product.optionalTotal],
    [1, optional('product').length]);
});

test('этап хранит дату, свидетельство и блокер; следующий шаг дорожки ведёт к её блокеру', (t) => {
  const f = fixture(t);
  const saved = f.api.saveStages('alvi', {revision: 0, reason: 'Первая неделя', stages: [
    doneStage('company_brief', '2026-09-18', 'Бриф подтверждён владельцем'),
    {key: 'company_assets', status: 'in_progress', targetDate: '2026-09-25', note: 'Ждём фото с процедуры'},
    {key: 'company_plan', status: 'blocked', blocker: 'Нет доступа к галерее исходников'},
    {key: 'product_api', status: 'blocked', blocker: 'Маршруты брифа не подключены'},
  ]}, ADMIN);
  assert.equal(saved.revision, 1);
  assert.equal(stage(saved, 'company_brief').confirmedOn, '2026-09-18');
  assert.equal(stage(saved, 'company_brief').evidence, 'Бриф подтверждён владельцем');
  assert.equal(stage(saved, 'company_brief').actorName, 'Владелец');
  assert.equal(stage(saved, 'company_brief').track, 'company');
  assert.equal(stage(saved, 'company_assets').targetDate, '2026-09-25');
  assert.equal(stage(saved, 'company_plan').blocker, 'Нет доступа к галерее исходников');
  assert.deepEqual([saved.progress.company.blocked, saved.progress.product.blocked], [1, 1]);
  assert.deepEqual(
    {key: saved.nextStep.company.stageKey, reason: saved.nextStep.company.reason, detail: saved.nextStep.company.detail},
    {key: 'company_plan', reason: 'Снять блокер', detail: 'Нет доступа к галерее исходников'});
  assert.deepEqual(
    {key: saved.nextStep.product.stageKey, detail: saved.nextStep.product.detail},
    {key: 'product_api', detail: 'Маршруты брифа не подключены'});
  assert.equal(saved.history.length, 4);
  assert.equal(saved.history.at(-1).fromStatus, 'not_started');
  assert.equal(saved.history[0].reason, 'Первая неделя');
  assert.throws(() => f.db.prepare("UPDATE media_mentor_rollout_stage_events SET reason='x' WHERE company_id=1").run(), /Immutable/);
  assert.throws(() => f.db.prepare('DELETE FROM media_mentor_rollout_stage_events WHERE company_id=1').run(), /Immutable/);
});

test('статус без основания не сохраняется, а устаревшая версия не переписывает чужую правку', (t) => {
  const f = fixture(t), before = f.api.get('alvi');
  for (const stages of [
    [{key: 'company_brief', status: 'done', confirmedOn: '2026-09-18'}],
    [{key: 'company_brief', status: 'done', evidence: 'Есть'}],
    [{key: 'company_brief', status: 'done', confirmedOn: '2026-09-30', evidence: 'Есть'}],
    [{key: 'company_brief', status: 'blocked'}],
    [{key: 'company_brief', status: 'in_progress', evidence: 'Готово'}],
    [{key: 'company_brief', status: 'in_progress', confirmedOn: '2026-09-18'}],
    [{key: 'company_brief', status: 'in_progress', blocker: 'Есть'}],
    [{key: 'company_brief', status: 'ready', evidence: 'Есть'}],
    [{key: 'unknown_stage', status: 'in_progress'}],
    [{key: 'brief', status: 'in_progress'}],
    [{key: 'company_brief', status: 'in_progress'}, {key: 'company_brief', status: 'blocked', blocker: 'Есть'}],
    [{key: 'company_brief', status: 'in_progress', targetDate: '2026-02-30'}],
    [],
  ]) {
    assert.throws(() => f.api.saveStages('alvi', {revision: 0, stages}, ADMIN), (error) => error.status === 400);
  }
  assert.deepEqual(f.api.get('alvi').stages, before.stages);
  const saved = f.api.saveStages('alvi', {revision: 0, stages: [{key: 'company_brief', status: 'in_progress'}]}, ADMIN);
  assert.throws(() => f.api.saveStages('alvi', {revision: 0, stages: [{key: 'company_plan', status: 'in_progress'}]}, ADMIN),
    (error) => error.status === 409 && error.details.code === 'REVISION_CONFLICT');
  assert.equal(stage(f.api.get('alvi'), 'company_brief').status, 'in_progress');
  assert.equal(f.api.get('alvi').revision, saved.revision);
  // Повтор того же состояния не создаёт новую версию и не засоряет журнал внедрения.
  const repeat = f.api.saveStages('alvi', {revision: saved.revision, stages: [{key: 'company_brief', status: 'in_progress'}]}, ADMIN);
  assert.equal(repeat.revision, saved.revision);
  assert.equal(repeat.history.length, 1);
});

test('дата готовности проверяется по часовому поясу компании, а не по UTC', (t) => {
  const f = fixture(t);
  f.advance(Date.parse('2026-09-20T18:00:00Z') - f.at());
  // В Иркутске (UTC+8) уже 21 сентября: своя дата не должна считаться будущим.
  const saved = f.api.saveStages('alvi', {revision: 0, stages: [doneStage('company_brief', '2026-09-21', 'Бриф')]}, ADMIN);
  assert.equal(stage(saved, 'company_brief').confirmedOn, '2026-09-21');
  assert.throws(() => f.api.saveStages('avokado', {revision: 0, stages: [doneStage('company_brief', '2026-09-21', 'Бриф')]}, ADMIN),
    (error) => error.status === 400);
});

test('этапы и ответы одной компании не попадают в другую, а ключ цикла называет свою компанию', (t) => {
  const f = fixture(t);
  f.api.saveStages('alvi', {revision: 0, stages: [doneStage('company_brief', '2026-09-19', 'Секрет ALVI')]}, ADMIN);
  // Обе карточки существуют с одной и той же отметкой времени: ключ обязан различаться и без разницы во времени.
  const both = [f.api.get('alvi'), f.api.get('avokado')];
  assert.equal(both[0].survey.anchorAt, both[1].survey.anchorAt, 'якоря совпадают по времени');
  assert.notEqual(both[0].survey.cycleKey, both[1].survey.cycleKey);
  assert.equal(both[0].survey.cycleKey, `alvi:${both[0].survey.anchorAt}`);
  assert.equal(both[1].survey.cycleKey, `avokado:${both[1].survey.anchorAt}`);
  f.advance(7 * DAY);
  f.api.submitFeedback('alvi', {requestId: 'alvi-cycle-1', cycleKey: f.api.get('alvi').survey.cycleKey,
    usefulness: 5, improvement: 'Секретное пожелание ALVI'}, CLIENT);
  // Чужой ключ не открывает чужой опрос даже при совпадении якоря.
  assert.throws(() => f.api.submitFeedback('avokado',
    {requestId: 'wrong-company-key', cycleKey: `alvi:${both[1].survey.anchorAt}`, usefulness: 5}, CLIENT),
  (error) => error.status === 409 && error.details.code === 'SURVEY_CYCLE_CHANGED');
  const other = f.api.get('avokado');
  assert.equal(other.revision, 0);
  assert.ok(other.stages.every((item) => item.status === 'not_started' && item.evidence === ''));
  assert.equal(other.progress.company.requiredDone, 0);
  assert.equal(other.history.length, 0);
  assert.deepEqual(other.survey.responses, []);
  assert.equal(other.survey.lastResponse, null);
  assert.doesNotMatch(JSON.stringify(other), /Секрет/);
  assert.throws(() => f.api.get('missing'), (error) => error.status === 404);
  assert.throws(() => f.api.get('../alvi'), (error) => error.status === 400);
  f.db.prepare('UPDATE companies SET is_deleted=1 WHERE code=?').run('alvi');
  assert.throws(() => f.api.get('alvi'), (error) => error.status === 404);
  assert.throws(() => f.api.submitFeedback('alvi', {requestId: 'after-delete', cycleKey: 'x'}, CLIENT),
    (error) => error.status === 404);
});

test('срок опроса отсчитывается от появления карточки, а не от запуска сервиса', (t) => {
  const f = fixture(t);
  // Сервис работает месяц, но компания раздел ещё не открывала: отсчёт не начинался.
  f.advance(30 * DAY);
  const first = f.api.get('alvi');
  assert.equal(first.survey.due, false);
  assert.equal(first.survey.anchorAt, first.startedAt);
  assert.equal(Date.parse(first.startedAt), f.at());
  assert.equal(Date.parse(first.survey.dueAt) - Date.parse(first.startedAt), 7 * DAY);
  f.advance(7 * DAY);
  assert.equal(f.api.get('alvi').survey.due, true);
});

test('опрос открывается через 7 дней после последнего ответа и не принимает ранние ответы', (t) => {
  const f = fixture(t), start = f.api.get('alvi');
  assert.equal(start.survey.intervalDays, 7);
  assert.equal(start.survey.due, false);
  assert.equal(start.survey.anchorAt, start.startedAt);
  assert.equal(Date.parse(start.survey.dueAt) - Date.parse(start.startedAt), 7 * DAY);
  assert.deepEqual(start.survey.questions.map((question) => [question.key, question.optional]),
    [['usefulness', true], ['blocking', true], ['improvement', true]]);
  assert.throws(() => f.api.submitFeedback('alvi',
    {requestId: 'too-early-1', cycleKey: start.survey.cycleKey, usefulness: 4}, CLIENT),
  (error) => error.status === 409 && error.details.code === 'SURVEY_NOT_DUE');

  f.advance(7 * DAY - 1);
  assert.equal(f.api.get('alvi').survey.due, false);
  f.advance(1);
  const open = f.api.get('alvi');
  assert.equal(open.survey.due, true);

  const answered = f.api.submitFeedback('alvi', {requestId: 'cycle-one-answer',
    cycleKey: open.survey.cycleKey, usefulness: 4, blocking: 'Мало времени на съёмку',
    improvement: 'Больше готовых заготовок'}, CLIENT).state;
  assert.equal(answered.survey.due, false);
  assert.equal(answered.survey.lastResponse.usefulness, 4);
  assert.equal(answered.survey.lastResponse.blocking, 'Мало времени на съёмку');
  assert.equal(answered.survey.lastResponse.skipped, false);
  assert.equal(answered.survey.lastResponse.actorName, 'Клиент');
  assert.equal(answered.survey.anchorAt, answered.survey.lastResponse.createdAt);
  assert.equal(Date.parse(answered.survey.dueAt) - Date.parse(answered.survey.lastResponse.createdAt), 7 * DAY);
  assert.notEqual(answered.survey.cycleKey, open.survey.cycleKey);

  f.advance(7 * DAY);
  const second = f.api.get('alvi');
  assert.equal(second.survey.due, true);
  f.api.submitFeedback('alvi', {requestId: 'cycle-two-answer', cycleKey: second.survey.cycleKey, usefulness: 5}, CLIENT);
  assert.equal(f.api.get('alvi').survey.answered, 2);
  assert.throws(() => f.db.prepare('DELETE FROM media_mentor_rollout_feedback WHERE company_id=1').run(), /Immutable/);
});

test('повтор отправки не создаёт второй ответ, а ответ по закрытому циклу отклоняется', (t) => {
  const f = fixture(t);
  // Карточка появляется при первом чтении: отсчёт 7 дней начинается с этого момента.
  f.api.get('alvi');
  f.advance(7 * DAY);
  const open = f.api.get('alvi').survey;
  assert.equal(open.due, true);
  const first = f.api.submitFeedback('alvi', {requestId: 'double-click-1', cycleKey: open.cycleKey, usefulness: 3}, CLIENT);
  assert.equal(first.created, true);
  // Повтор того же запроса (двойное нажатие, повтор сети) возвращает то же состояние без второй записи.
  const repeat = f.api.submitFeedback('alvi', {requestId: 'double-click-1', cycleKey: open.cycleKey, usefulness: 1}, CLIENT);
  assert.equal(repeat.created, false);
  assert.equal(repeat.state.survey.answered, 1);
  assert.equal(repeat.state.survey.lastResponse.usefulness, 3);
  // Вторая вкладка отвечает по уже закрытому циклу: ответ не подменяет сохранённый.
  assert.throws(() => f.api.submitFeedback('alvi', {requestId: 'second-tab-1', cycleKey: open.cycleKey, usefulness: 1}, CLIENT),
    (error) => error.status === 409 && error.details.code === 'SURVEY_CYCLE_CHANGED');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM media_mentor_rollout_feedback WHERE company_id=1').get().n, 1);
  assert.throws(() => f.db.prepare(`INSERT INTO media_mentor_rollout_feedback
    (company_id,cycle_key,created_at,actor_name,request_id) VALUES(1,?,?,'x','manual-duplicate')`)
    .run(open.cycleKey, new Date().toISOString()), /UNIQUE/);
});

test('пропуск опроса разрешён, сохраняется как пропуск и сдвигает следующий срок', (t) => {
  const f = fixture(t);
  // Карточка появляется при первом чтении: отсчёт 7 дней начинается с этого момента.
  f.api.get('alvi');
  f.advance(7 * DAY);
  const skipped = f.api.submitFeedback('alvi',
    {requestId: 'skip-week-1', cycleKey: f.api.get('alvi').survey.cycleKey}, CLIENT).state;
  assert.equal(skipped.survey.lastResponse.skipped, true);
  assert.equal(skipped.survey.lastResponse.usefulness, null);
  assert.equal(skipped.survey.due, false);
  assert.equal(Date.parse(skipped.survey.dueAt) - f.at(), 7 * DAY);
  // Частичный ответ пропуском не считается.
  f.advance(7 * DAY);
  const partial = f.api.submitFeedback('alvi',
    {requestId: 'partial-week-2', cycleKey: f.api.get('alvi').survey.cycleKey, improvement: 'Короче созвоны'}, CLIENT).state;
  assert.equal(partial.survey.lastResponse.skipped, false);
  assert.equal(partial.survey.lastResponse.usefulness, null);
  [0, 6, 2.5, '4', true].forEach((usefulness, index) => {
    f.advance(7 * DAY);
    assert.throws(() => f.api.submitFeedback('alvi',
      {requestId: `bad-usefulness-${index}`, cycleKey: f.api.get('alvi').survey.cycleKey, usefulness}, CLIENT),
    (error) => error.status === 400 && /полезности/.test(error.message));
  });
  assert.equal(f.api.get('alvi').survey.answered, 2);
});

test('состояние и ответы переживают перезапуск сервиса', (t) => {
  const f = fixture(t);
  f.api.saveStages('alvi', {revision: 0, stages: [doneStage('company_brief', '2026-09-19', 'Бриф v3')]}, ADMIN);
  f.advance(7 * DAY);
  f.api.submitFeedback('alvi', {requestId: 'before-restart', cycleKey: f.api.get('alvi').survey.cycleKey,
    usefulness: 4, improvement: 'Чаще показывать план'}, CLIENT);
  const restarted = createMediaMentorRollout(f.db, f.options).get('alvi');
  assert.equal(restarted.revision, 1);
  assert.equal(stage(restarted, 'company_brief').evidence, 'Бриф v3');
  assert.equal(restarted.survey.lastResponse.improvement, 'Чаще показывать план');
  assert.equal(restarted.survey.due, false);
});

test('маршрут отдаёт чтение клиенту, запрещает ему правку этапов и принимает ответ опроса', async (t) => {
  const f = fixture(t);
  const calls = [];
  const handler = createMediaMentorRolloutHandler({
    rollout: f.api,
    companyModuleContext: (request, code, permission) => {
      calls.push({code, permission});
      const identity = request.identity;
      if (!identity) { const error = new Error('Недостаточно прав'); error.status = 403; throw error; }
      if (identity.role !== 'owner' && !identity.companies.includes(String(code).toLowerCase())) {
        const error = new Error('Нет доступа к компании'); error.status = 403; throw error;
      }
      return {identity};
    },
    readJson: async (request) => request.body,
    send: (response, status, result) => { response.sent = {status, result}; },
  });
  const owner = {...ADMIN, companies: []};
  const client = {...CLIENT, companies: ['alvi']};
  const call = async (method, path, identity, body, code = 'alvi') => {
    const response = {};
    const url = new URL(`http://crm.local${path}?companyCode=${code}`);
    const handled = await handler({method, identity, body}, response, url, {});
    return {handled, ...response.sent || {}};
  };

  assert.equal(await handler({method: 'GET'}, {}, new URL('http://crm.local/leads'), {}), false);

  const read = await call('GET', '/media-mentor-rollout', client);
  assert.equal(read.status, 200);
  assert.equal(read.result.companyCode, 'alvi');
  assert.deepEqual(calls[0], {code: 'alvi', permission: 'autoposting.view'});

  await assert.rejects(call('PUT', '/media-mentor-rollout/stages', client,
    {revision: 0, stages: [{key: 'company_brief', status: 'in_progress'}]}),
  (error) => error.status === 403 && /администратор Synapse/.test(error.message));
  assert.equal(f.api.get('alvi').revision, 0);

  const saved = await call('PUT', '/media-mentor-rollout/stages', owner,
    {revision: 0, stages: [doneStage('company_brief', '2026-09-19', 'Бриф v3')]});
  assert.equal(saved.status, 200);
  assert.equal(saved.result.revision, 1);

  await assert.rejects(call('GET', '/media-mentor-rollout', client, undefined, 'avokado'),
    (error) => error.status === 403);
  await assert.rejects(call('GET', '/media-mentor-rollout', null), (error) => error.status === 403);
  await assert.rejects(call('DELETE', '/media-mentor-rollout', owner), (error) => error.status === 405);
  await assert.rejects(call('GET', '/media-mentor-rollout/survey', owner), (error) => error.status === 405);

  f.advance(7 * DAY);
  const cycleKey = f.api.get('alvi').survey.cycleKey;
  const answer = await call('POST', '/media-mentor-rollout/survey', client,
    {requestId: 'route-answer-1', cycleKey, usefulness: 5, improvement: 'Больше примеров'});
  assert.equal(answer.status, 201);
  assert.equal(answer.result.survey.lastResponse.actorId, 7);
  const again = await call('POST', '/media-mentor-rollout/survey', client,
    {requestId: 'route-answer-1', cycleKey, usefulness: 5});
  assert.equal(again.status, 200);
  assert.equal(again.result.survey.answered, 1);
});

test('каталог дорожек согласован: у каждого этапа есть известная дорожка и обязательные в обеих', () => {
  assert.deepEqual(TRACKS.map((track) => track.key), ['product', 'company']);
  const keys = new Set(TRACKS.map((track) => track.key));
  assert.ok(STAGES.every((item) => keys.has(item.track)));
  assert.equal(new Set(STAGES.map((item) => item.key)).size, STAGES.length);
  assert.ok(PRODUCT_REQUIRED > 0 && COMPANY_REQUIRED > 0);
});

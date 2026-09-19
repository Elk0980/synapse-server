'use strict';

// Внедрение Медиа-наставника глазами клиента: этапы с датой, статусом и свидетельством,
// процент закрытых обязательных этапов с явным знаменателем и еженедельный опрос внутри ЛК.
// Модуль ничего не отправляет наружу, не заводит таймеров и не обращается к моделям.
const {company, fail, object, text, revision} = require('./company-information');

// Две разные вещи, которые нельзя складывать: готовность самого модуля и настройка у клиента.
const TRACKS = Object.freeze([
  {key:'product', title:'Разработка модуля',
    basis:'Состояние самого Медиа-наставника: хранилище, маршруты, экран брифа, тесты и перенос ' +
      'плана в публикации. Отметки ведёт администратор Synapse. Готовность модуля не означает, ' +
      'что материалы компании собраны.'},
  {key:'company', title:'Настройка у клиента',
    basis:'Что нужно от компании: бриф, исходники, план, согласование, каналы и первая публикация. ' +
      'Заполненность этих этапов не означает, что модуль дописан.'},
]);
const TRACK_KEYS = Object.freeze(TRACKS.map((track) => track.key));
// Каталог этапов. Ключи стабильны: по ним хранится состояние и неизменяемая история.
const STAGES = Object.freeze([
  {key:'product_storage', track:'product', required:true, title:'Хранилище брифа и контент-плана',
    detail:'Серверный модуль брифа и плана с версиями, историей и именным согласованием.',
    evidenceHint:'Файл модуля и результат его тестов'},
  {key:'product_api', track:'product', required:true, title:'HTTP-маршруты брифа и плана',
    detail:'Маршруты брифа и плана в CRM и разрешение их в прокси кабинета с проверкой прав.',
    evidenceHint:'Какие маршруты подключены и чем проверены'},
  {key:'product_cabinet', track:'product', required:true, title:'Экран брифа и плана в кабинете',
    detail:'Раздел, где компания заполняет бриф и видит контент-план.',
    evidenceHint:'Файл раздела кабинета и его тесты'},
  {key:'product_checks', track:'product', required:true, title:'Тесты модуля в проверке сборки',
    detail:'Тесты Медиа-наставника запускаются автоматической проверкой, а не только вручную.',
    evidenceHint:'Шаг проверки сборки, который их запускает'},
  {key:'product_publishing', track:'product', required:true, title:'Перенос плана в автопостинг',
    detail:'Согласованная версия плана становится карточками публикаций без ручного переписывания.',
    evidenceHint:'Чем подтверждён перенос согласованной версии'},
  {key:'product_suggestions', track:'product', required:false, title:'Подсказки Хью по плану',
    detail:'Наставник предлагает темы и правки. Сейчас все тексты вводит человек.',
    evidenceHint:'Что именно предлагает наставник и где это видно'},
  {key:'company_brief', track:'company', required:true, title:'Бриф компании',
    detail:'Цель, продукт, аудитория, боли и подтверждённые факты записаны и проверены.',
    evidenceHint:'Версия сохранённого брифа или имя того, кто его подтвердил'},
  {key:'company_assets', track:'company', required:true, title:'Исходники и комфорт съёмки',
    detail:'Перечислено, какие материалы уже есть и в каком виде клиент готов появляться в кадре.',
    evidenceHint:'Перечень исходников и согласованный уровень участия в съёмке'},
  {key:'company_plan', track:'company', required:true, title:'Контент-план на 7–14 дней',
    detail:'План составлен по площадкам, форматам и ролям публикаций.',
    evidenceHint:'Версия плана и период, который он закрывает'},
  {key:'company_approval', track:'company', required:true, title:'Согласование плана владельцем',
    detail:'Конкретная версия плана согласована владельцем компании, решение записано.',
    evidenceHint:'Кто и когда согласовал, по какой версии плана'},
  {key:'company_channels', track:'company', required:true, title:'Каналы публикации',
    detail:'Площадки подключены в разделе автопостинга, доступ проверен живой проверкой канала.',
    evidenceHint:'Какие каналы проверены и результат проверки'},
  {key:'company_first_publication', track:'company', required:true, title:'Первая публикация по плану',
    detail:'Первый согласованный материал опубликован, ссылка на опубликованный пост проверена.',
    evidenceHint:'Ссылка на опубликованный материал'},
  {key:'company_analytics', track:'company', required:false, title:'Сбор статистики площадок',
    detail:'Показатели площадок собираются или вносятся вручную с датой снятия.',
    evidenceHint:'Какие площадки отдают числа и каким способом'},
  {key:'company_routine', track:'company', required:false, title:'Еженедельный разбор с наставником',
    detail:'Договорённость о регулярном разборе результатов и корректировке плана.',
    evidenceHint:'День недели разбора и участники'},
]);
const CATALOG = new Map(STAGES.map((stage) => [stage.key, stage]));
const STATUSES = Object.freeze(['not_started', 'in_progress', 'blocked', 'done']);
const STATUS_LABELS = Object.freeze({
  not_started: 'Не начат', in_progress: 'В работе', blocked: 'Блокер', done: 'Готово',
});
// Порядок разбора «следующего шага»: блокер важнее начатого этапа, начатый — важнее нетронутого.
const NEXT_STEP_ORDER = Object.freeze(['blocked', 'in_progress', 'not_started']);
const NEXT_STEP_REASONS = Object.freeze({
  blocked: 'Снять блокер', in_progress: 'Довести начатый этап до готовности', not_started: 'Начать этап',
});
const SURVEY_INTERVAL_DAYS = 7;
const SURVEY_INTERVAL_MS = SURVEY_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
const SURVEY_QUESTIONS = Object.freeze([
  {key:'usefulness', kind:'scale', min:1, max:5, optional:true,
    title:'Насколько наставник был полезен за последние 7 дней?', hint:'1 — не помог, 5 — заметно помог'},
  {key:'blocking', kind:'text', max:2000, optional:true,
    title:'Что мешает двигаться дальше?', hint:'Любая помеха: время, материалы, согласования, доступы'},
  {key:'improvement', kind:'text', max:2000, optional:true,
    title:'Что улучшить в работе наставника?', hint:'Что сделать иначе на следующей неделе'},
]);
const PROGRESS_BASIS = 'Процент считается только от обязательных этапов своей дорожки. ' +
  'Необязательные этапы показываются отдельно и в процент не входят.';
const TRACKS_BASIS = 'Дорожки считаются отдельно и никогда не складываются в один процент: ' +
  'готовность модуля и настройка у клиента — разные вещи.';
const SURVEY_BASIS = 'Опрос открывается через 7 дней после последнего ответа и живёт внутри кабинета: ' +
  'писем, сообщений и напоминаний по расписанию у него нет. Любой вопрос можно пропустить.';

function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(400, 'Укажите дату в формате ГГГГ-ММ-ДД');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(400, 'Такой даты не существует');
  return value;
}
function optionalDate(value) {
  return value === undefined || value === null || value === '' ? null : calendarDate(value);
}

function createMediaMentorRollout(db, {now = Date.now} = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS media_mentor_rollout_state (
    company_id INTEGER PRIMARY KEY REFERENCES companies(id), revision INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS media_mentor_rollout_stages (
    company_id INTEGER NOT NULL REFERENCES companies(id), stage_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'not_started', target_date TEXT, confirmed_on TEXT,
    evidence TEXT NOT NULL DEFAULT '', blocker TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL, actor_id INTEGER, actor_name TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(company_id,stage_key));
    CREATE TABLE IF NOT EXISTS media_mentor_rollout_stage_events (
    id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), revision INTEGER NOT NULL,
    stage_key TEXT NOT NULL, from_status TEXT NOT NULL, to_status TEXT NOT NULL,
    target_date TEXT, confirmed_on TEXT, evidence TEXT NOT NULL, blocker TEXT NOT NULL, note TEXT NOT NULL,
    reason TEXT NOT NULL, created_at TEXT NOT NULL, actor_id INTEGER, actor_name TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS media_mentor_rollout_stage_events_idx
    ON media_mentor_rollout_stage_events(company_id,id);
    CREATE TRIGGER IF NOT EXISTS media_mentor_rollout_events_immutable_update
    BEFORE UPDATE ON media_mentor_rollout_stage_events
    BEGIN SELECT RAISE(ABORT,'Immutable media mentor rollout event'); END;
    CREATE TRIGGER IF NOT EXISTS media_mentor_rollout_events_immutable_delete
    BEFORE DELETE ON media_mentor_rollout_stage_events
    BEGIN SELECT RAISE(ABORT,'Immutable media mentor rollout event'); END;
    CREATE TABLE IF NOT EXISTS media_mentor_rollout_feedback (
    id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), cycle_key TEXT NOT NULL,
    usefulness INTEGER, blocking TEXT NOT NULL DEFAULT '', improvement TEXT NOT NULL DEFAULT '',
    skipped INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, actor_id INTEGER,
    actor_name TEXT NOT NULL DEFAULT '', request_id TEXT NOT NULL,
    UNIQUE(company_id,cycle_key), UNIQUE(company_id,request_id));
    CREATE TRIGGER IF NOT EXISTS media_mentor_rollout_feedback_immutable_update
    BEFORE UPDATE ON media_mentor_rollout_feedback
    BEGIN SELECT RAISE(ABORT,'Immutable media mentor rollout feedback'); END;
    CREATE TRIGGER IF NOT EXISTS media_mentor_rollout_feedback_immutable_delete
    BEFORE DELETE ON media_mentor_rollout_feedback
    BEGIN SELECT RAISE(ABORT,'Immutable media mentor rollout feedback'); END;`);

  const iso = () => new Date(now()).toISOString();
  const companyToday = (zone) => {
    try {
      return new Intl.DateTimeFormat('en-CA', {timeZone: zone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'})
        .format(new Date(now()));
    } catch {
      return new Date(now()).toISOString().slice(0, 10);
    }
  };
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  // Начальные строки заводятся со статусом «не начат»: пустая карточка ничего не объявляет готовым.
  function ensure(owner) {
    let state = db.prepare('SELECT * FROM media_mentor_rollout_state WHERE company_id=?').get(owner.id);
    if (!state) {
      const time = iso();
      db.prepare('INSERT INTO media_mentor_rollout_state(company_id,revision,started_at,updated_at) VALUES(?,0,?,?)')
        .run(owner.id, time, time);
      state = db.prepare('SELECT * FROM media_mentor_rollout_state WHERE company_id=?').get(owner.id);
    }
    const known = new Set(db.prepare('SELECT stage_key FROM media_mentor_rollout_stages WHERE company_id=?')
      .all(owner.id).map((row) => row.stage_key));
    const insert = db.prepare(`INSERT INTO media_mentor_rollout_stages(company_id,stage_key,status,updated_at)
      VALUES(?,?,'not_started',?)`);
    for (const stage of STAGES) if (!known.has(stage.key)) insert.run(owner.id, stage.key, state.started_at);
    return state;
  }

  function stagesOf(owner) {
    const rows = new Map(db.prepare('SELECT * FROM media_mentor_rollout_stages WHERE company_id=?')
      .all(owner.id).map((row) => [row.stage_key, row]));
    return STAGES.map((stage) => {
      const row = rows.get(stage.key);
      return {key: stage.key, track: stage.track, title: stage.title, detail: stage.detail,
        evidenceHint: stage.evidenceHint,
        required: stage.required, status: row.status, statusLabel: STATUS_LABELS[row.status],
        targetDate: row.target_date, confirmedOn: row.confirmed_on, evidence: row.evidence,
        blocker: row.blocker, note: row.note, updatedAt: row.updated_at,
        actorId: row.actor_id, actorName: row.actor_name};
    });
  }

  // Прогресс считается внутри дорожки: обязательные этапы своей дорожки и есть знаменатель.
  function trackProgress(stages, track) {
    const own = stages.filter((stage) => stage.track === track.key);
    const required = own.filter((stage) => stage.required);
    const optional = own.filter((stage) => !stage.required);
    const requiredDone = required.filter((stage) => stage.status === 'done').length;
    return {track: track.key, title: track.title, requiredDone, requiredTotal: required.length,
      percent: required.length ? Math.round((requiredDone / required.length) * 100) : 0,
      optionalDone: optional.filter((stage) => stage.status === 'done').length, optionalTotal: optional.length,
      blocked: own.filter((stage) => stage.status === 'blocked').length,
      label: `${requiredDone} из ${required.length} обязательных этапов дорожки «${track.title}»`,
      basis: `${track.basis} ${PROGRESS_BASIS}`};
  }

  function progressOf(stages) {
    return Object.fromEntries(TRACKS.map((track) => [track.key, trackProgress(stages, track)]));
  }

  function trackNextStep(stages, track) {
    for (const required of [true, false]) {
      for (const status of NEXT_STEP_ORDER) {
        const stage = stages.find((item) => item.track === track.key &&
          item.required === required && item.status === status);
        if (!stage) continue;
        return {track: track.key, stageKey: stage.key, title: stage.title, status: stage.status,
          required: stage.required, reason: NEXT_STEP_REASONS[status], targetDate: stage.targetDate,
          detail: stage.status === 'blocked' ? stage.blocker : stage.note || stage.detail};
      }
    }
    return null;
  }

  function nextStepOf(stages) {
    return Object.fromEntries(TRACKS.map((track) => [track.key, trackNextStep(stages, track)]));
  }

  function surveyOf(owner, state) {
    const responses = db.prepare(`SELECT id,cycle_key cycleKey,usefulness,blocking,improvement,skipped,
      created_at createdAt,actor_id actorId,actor_name actorName
      FROM media_mentor_rollout_feedback WHERE company_id=? ORDER BY id DESC LIMIT 12`).all(owner.id)
      .map((row) => ({...row, skipped: row.skipped === 1}));
    const last = responses[0] || null;
    // Отсчёт идёт от последнего ответа, а для ещё не опрошенной компании — от начала внедрения.
    const anchorAt = last ? last.createdAt : state.started_at;
    const dueAt = new Date(Date.parse(anchorAt) + SURVEY_INTERVAL_MS).toISOString();
    const answered = db.prepare('SELECT COUNT(*) total FROM media_mentor_rollout_feedback WHERE company_id=?')
      .get(owner.id).total;
    // Ключ цикла называет свою компанию: ключ одной компании не подходит другой, даже если
    // карточки появились в одну миллисекунду. Изоляция держится на данных, а не на совпадении времени.
    return {intervalDays: SURVEY_INTERVAL_DAYS, anchorAt, dueAt, due: now() >= Date.parse(dueAt),
      cycleKey: `${owner.code.toLowerCase()}:${anchorAt}`, questions: SURVEY_QUESTIONS, lastResponse: last,
      answered, responses, basis: SURVEY_BASIS};
  }

  function snapshot(owner) {
    const state = ensure(owner), stages = stagesOf(owner);
    return {companyCode: owner.code.toLowerCase(), revision: state.revision, startedAt: state.started_at,
      updatedAt: state.updated_at, statuses: STATUSES, statusLabels: STATUS_LABELS,
      tracks: TRACKS, tracksBasis: TRACKS_BASIS, stages,
      progress: progressOf(stages), nextStep: nextStepOf(stages), survey: surveyOf(owner, state),
      history: db.prepare(`SELECT revision,stage_key stageKey,from_status fromStatus,to_status toStatus,
        reason,created_at createdAt,actor_id actorId,actor_name actorName
        FROM media_mentor_rollout_stage_events WHERE company_id=? ORDER BY id DESC LIMIT 40`).all(owner.id),
      capabilities: {stageEditing: 'admin', clientAccess: 'autoposting.view', surveyChannel: 'cabinet',
        outboundMessages: false, scheduledReminders: false, modelSuggestions: false}};
  }

  function get(code) { return transaction(() => snapshot(company(db, code))); }

  function normalizeStage(item) {
    object(item, ['key', 'status', 'targetDate', 'confirmedOn', 'evidence', 'blocker', 'note']);
    const key = text(item.key, 64, true);
    if (!CATALOG.has(key)) fail(400, 'Неизвестный этап внедрения');
    if (!STATUSES.includes(item.status)) fail(400, 'Выберите статус этапа');
    const status = item.status;
    const evidence = item.evidence === undefined ? '' : text(item.evidence, 2000);
    const blocker = item.blocker === undefined ? '' : text(item.blocker, 2000);
    const note = item.note === undefined ? '' : text(item.note, 2000);
    const targetDate = optionalDate(item.targetDate), confirmedOn = optionalDate(item.confirmedOn);
    // Готовность подтверждается свидетельством и датой: статус сам по себе ничего не доказывает.
    if (status === 'done') {
      if (!evidence) fail(400, 'Завершённый этап требует свидетельства готовности');
      if (!confirmedOn) fail(400, 'Укажите дату готовности этапа');
      if (blocker) fail(400, 'У завершённого этапа не может быть блокера');
    } else {
      if (evidence) fail(400, 'Свидетельство готовности сохраняется только у завершённого этапа');
      if (confirmedOn) fail(400, 'Дата готовности сохраняется только у завершённого этапа');
      if (status === 'blocked' && !blocker) fail(400, 'Опишите блокер этапа');
      if (status !== 'blocked' && blocker) fail(400, 'Блокер сохраняется только у заблокированного этапа');
    }
    return {key, status, targetDate, confirmedOn, evidence, blocker, note};
  }

  function saveStages(code, body, actor = {}) {
    object(body, ['revision', 'stages', 'reason']);
    revision(body.revision);
    const reason = body.reason === undefined ? 'Обновление этапов внедрения' : text(body.reason, 500, true);
    if (!Array.isArray(body.stages) || !body.stages.length || body.stages.length > STAGES.length) {
      fail(400, 'Укажите изменяемые этапы');
    }
    const seen = new Set(), patches = body.stages.map((item) => {
      const patch = normalizeStage(item);
      if (seen.has(patch.key)) fail(400, 'Этап указан дважды');
      seen.add(patch.key);
      return patch;
    });
    return transaction(() => {
      const owner = company(db, code), state = ensure(owner);
      if (body.revision !== state.revision) fail(409, 'Этапы уже изменились. Обновите страницу.', 'REVISION_CONFLICT');
      const today = companyToday(owner.timezone);
      for (const patch of patches) {
        if (patch.confirmedOn && patch.confirmedOn > today) fail(400, 'Дата готовности не может быть в будущем');
      }
      const current = new Map(db.prepare('SELECT * FROM media_mentor_rollout_stages WHERE company_id=?')
        .all(owner.id).map((row) => [row.stage_key, row]));
      const changed = patches.filter((patch) => {
        const before = current.get(patch.key);
        return before.status !== patch.status || (before.target_date || null) !== patch.targetDate ||
          (before.confirmed_on || null) !== patch.confirmedOn || before.evidence !== patch.evidence ||
          before.blocker !== patch.blocker || before.note !== patch.note;
      });
      // Сохранение без изменений не создаёт новую версию и не засоряет журнал внедрения.
      if (!changed.length) return snapshot(owner);
      const next = state.revision + 1, time = iso();
      const actorId = Number.isSafeInteger(actor.userId) ? actor.userId : null;
      const actorName = actor.userName ? text(actor.userName, 200) : '';
      for (const patch of changed) {
        db.prepare(`UPDATE media_mentor_rollout_stages SET status=?,target_date=?,confirmed_on=?,evidence=?,
          blocker=?,note=?,updated_at=?,actor_id=?,actor_name=? WHERE company_id=? AND stage_key=?`)
          .run(patch.status, patch.targetDate, patch.confirmedOn, patch.evidence, patch.blocker, patch.note,
            time, actorId, actorName, owner.id, patch.key);
        db.prepare(`INSERT INTO media_mentor_rollout_stage_events(company_id,revision,stage_key,from_status,
          to_status,target_date,confirmed_on,evidence,blocker,note,reason,created_at,actor_id,actor_name)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(owner.id, next, patch.key, current.get(patch.key).status, patch.status, patch.targetDate,
            patch.confirmedOn, patch.evidence, patch.blocker, patch.note, reason, time, actorId, actorName);
      }
      db.prepare('UPDATE media_mentor_rollout_state SET revision=?,updated_at=? WHERE company_id=?')
        .run(next, time, owner.id);
      return snapshot(owner);
    });
  }

  function submitFeedback(code, body, actor = {}) {
    object(body, ['requestId', 'cycleKey', 'usefulness', 'blocking', 'improvement']);
    const requestId = text(body.requestId, 100, true);
    if (!/^[\w-]{8,100}$/.test(requestId)) fail(400, 'Некорректный номер ответа');
    const cycleKey = text(body.cycleKey, 120, true);
    const usefulness = body.usefulness === undefined || body.usefulness === null ? null : body.usefulness;
    if (usefulness !== null && (!Number.isSafeInteger(usefulness) || usefulness < 1 || usefulness > 5)) {
      fail(400, 'Оценка полезности — целое число от 1 до 5');
    }
    const blocking = body.blocking === undefined ? '' : text(body.blocking, 2000);
    const improvement = body.improvement === undefined ? '' : text(body.improvement, 2000);
    return transaction(() => {
      const owner = company(db, code), state = ensure(owner);
      // Повтор той же отправки (двойное нажатие, повтор запроса) не создаёт второй ответ.
      const repeat = db.prepare('SELECT id FROM media_mentor_rollout_feedback WHERE company_id=? AND request_id=?')
        .get(owner.id, requestId);
      if (repeat) return {created: false, state: snapshot(owner)};
      const survey = surveyOf(owner, state);
      // Ключ цикла сверяется с текущим: ответ по уже закрытому опросу не попадает в новый период.
      if (survey.cycleKey !== cycleKey) fail(409, 'Опрос уже обновился. Откройте раздел заново.', 'SURVEY_CYCLE_CHANGED');
      if (!survey.due) fail(409, 'Следующий опрос откроется позже', 'SURVEY_NOT_DUE');
      const skipped = usefulness === null && !blocking && !improvement;
      db.prepare(`INSERT INTO media_mentor_rollout_feedback(company_id,cycle_key,usefulness,blocking,improvement,
        skipped,created_at,actor_id,actor_name,request_id) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(owner.id, cycleKey, usefulness, blocking, improvement, skipped ? 1 : 0, iso(),
          Number.isSafeInteger(actor.userId) ? actor.userId : null,
          actor.userName ? text(actor.userName, 200) : '', requestId);
      return {created: true, state: snapshot(owner)};
    });
  }

  return {get, saveStages, submitFeedback};
}

function createMediaMentorRolloutHandler({rollout, companyModuleContext, readJson, send}) {
  return async function handleMediaMentorRollout(request, response, url, cors = {}) {
    if (!/^\/media-mentor-rollout(?:\/|$)/.test(url.pathname)) return false;
    const code = url.searchParams.get('companyCode');
    // Клиент видит внедрение по членству в компании и уже выданному праву раздела публикаций.
    const {identity} = companyModuleContext(request, code, 'autoposting.view');
    let result, status = 200;
    if (url.pathname === '/media-mentor-rollout' && request.method === 'GET') result = rollout.get(code);
    else if (url.pathname === '/media-mentor-rollout/stages' && request.method === 'PUT') {
      // Этапы внедрения ведёт администратор Synapse: клиент их только читает.
      if (identity.role !== 'owner') fail(403, 'Этапы внедрения ведёт администратор Synapse', 'FORBIDDEN');
      result = rollout.saveStages(code, await readJson(request), identity);
    } else if (url.pathname === '/media-mentor-rollout/survey' && request.method === 'POST') {
      const feedback = rollout.submitFeedback(code, await readJson(request), identity);
      result = feedback.state;
      status = feedback.created ? 201 : 200;
    } else fail(405, 'Метод не поддерживается');
    send(response, status, result, {...cors, 'cache-control': 'no-store'});
    return true;
  };
}

module.exports = {createMediaMentorRollout, createMediaMentorRolloutHandler,
  TRACKS, TRACK_KEYS, STAGES, STATUSES, STATUS_LABELS, SURVEY_QUESTIONS, SURVEY_INTERVAL_DAYS};

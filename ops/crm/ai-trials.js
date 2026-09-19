'use strict';

/* Журнал испытаний моделей-кандидатов: что за набор и задача, какая модель фактически
   отвечала, сколько попыток и времени, был ли успех, были ли нарушения фактов и изоляции,
   правил ли человек результат, оценка человека, ссылка на безопасный отчёт и стоимость
   с учётом неудач и повторов.

   Здесь не хранятся: тексты клиентов, сами ответы моделей, ключи и любые секреты.
   Ссылка на отчёт — это ссылка, а не содержимое.

   Выводы считаются по фактическим строкам. Размер выборки указывается всегда: без него
   доля успеха ничего не значит. Ожидаемые показатели за фактические не выдаются. */

const VERDICTS = ['pending', 'accepted', 'rejected', 'needs_review'];
const FIELDS = ['setId', 'taskId', 'provider', 'modelId', 'role', 'attempts', 'durationMs',
  'success', 'factViolations', 'isolationViolations', 'manualEdit', 'humanScore', 'reportRef',
  'costKnown', 'costCurrency', 'costAmount', 'costBasis', 'verdict', 'note'];
const SECRET_RE = /(?:token|secret|password|bearer|api[_-]?key|sk-|op_)/i;
const ID_RE = /^[a-z0-9][a-z0-9_.:-]{0,79}$/i;
const CURRENCY_RE = /^[A-Z]{3}$/;

function createAiTrials({db, fail}) {
  db.exec(`CREATE TABLE IF NOT EXISTS ai_model_trials(
    id INTEGER PRIMARY KEY AUTOINCREMENT, owner_scope TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
    data TEXT NOT NULL, request_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(owner_scope,request_id))`);
  const bad = (message) => fail(400, message, {code: 'VALIDATION_ERROR'});
  const text = (value, max, {required = false, name = 'поле', secretSafe = true} = {}) => {
    if (typeof value !== 'string' || value.length > max) bad(`Проверьте ${name}`);
    const clean = value.trim();
    if (required && !clean) bad(`Укажите ${name}`);
    if (secretSafe && SECRET_RE.test(clean)) bad(`В поле «${name}» не должно быть ключей и паролей`);
    return clean;
  };
  const code = (value, name) => {
    if (typeof value !== 'string' || !ID_RE.test(value)) bad(`Проверьте ${name}`);
    return value.toLowerCase();
  };
  const whole = (value, name, max = 1e9) => {
    if (!Number.isSafeInteger(value) || value < 0 || value > max) bad(`Проверьте ${name}`);
    return value;
  };
  const flag = (value, name) => {
    if (typeof value !== 'boolean') bad(`Проверьте ${name}`);
    return value;
  };
  const scope = (value) => {
    if (typeof value !== 'string' || !db.prepare('SELECT 1 FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get(value)) bad('Выберите проект');
    return value.toLowerCase();
  };

  function normalize(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some((key) => !['requestId', 'version', ...FIELDS].includes(key))) bad('Неизвестные поля испытания');
    const out = {setId: code(body.setId, 'набор'), taskId: code(body.taskId, 'задачу'),
      provider: code(body.provider, 'провайдера')};
    // Фактическая модель обязательна: испытание без неё ничего не доказывает.
    out.modelId = text(body.modelId ?? '', 200, {required: true, name: 'фактический идентификатор модели'});
    out.role = body.role === undefined || body.role === null || body.role === '' ? null : code(body.role, 'роль');
    out.attempts = whole(body.attempts, 'число попыток', 1000);
    if (out.attempts < 1) bad('Попыток должно быть не меньше одной');
    out.durationMs = whole(body.durationMs, 'длительность', 86400000);
    out.success = flag(body.success, 'признак успеха');
    out.factViolations = whole(body.factViolations, 'нарушения фактов', 1000);
    out.isolationViolations = whole(body.isolationViolations, 'нарушения изоляции', 1000);
    out.manualEdit = flag(body.manualEdit, 'признак ручной правки');
    // Оценка человека необязательна: её отсутствие не превращается в ноль.
    out.humanScore = body.humanScore === undefined || body.humanScore === null ? null
      : whole(body.humanScore, 'оценку человека', 5);
    if (out.humanScore !== null && out.humanScore < 1) bad('Оценка человека — целое от 1 до 5');
    out.reportRef = text(body.reportRef ?? '', 300, {name: 'ссылку на безопасный отчёт'});
    out.note = text(body.note ?? '', 2000, {name: 'комментарий'});
    if (typeof body.costKnown !== 'boolean') bad('Укажите, известна ли стоимость испытания');
    out.costKnown = body.costKnown;
    out.costCurrency = body.costCurrency === undefined || body.costCurrency === null || body.costCurrency === ''
      ? null : text(body.costCurrency, 3, {name: 'валюту стоимости'}).toUpperCase();
    if (out.costCurrency !== null && !CURRENCY_RE.test(out.costCurrency)) bad('Валюта стоимости — три латинские буквы');
    if (out.costKnown) {
      if (typeof body.costAmount !== 'number' || !Number.isFinite(body.costAmount) ||
        body.costAmount < 0 || body.costAmount > 1e9) bad('Проверьте стоимость испытания');
      if (!out.costCurrency) bad('При известной стоимости укажите валюту');
      if (!['invoice', 'estimate'].includes(body.costBasis)) bad('Основание стоимости: invoice или estimate');
      // Стоимость учитывает неудачи и повторы: это стоимость всего испытания, а не одной попытки.
      out.costAmount = Math.round(body.costAmount * 1e6) / 1e6;
      out.costBasis = body.costBasis;
    } else {
      if (body.costAmount !== undefined && body.costAmount !== null) {
        bad('Неизвестная стоимость записывается без суммы');
      }
      out.costAmount = null;
      out.costBasis = body.costBasis === 'estimate' ? 'estimate' : null;
    }
    out.verdict = body.verdict === undefined ? 'pending' : body.verdict;
    if (!VERDICTS.includes(out.verdict)) bad('Вывод: pending, accepted, rejected или needs_review');
    if (out.verdict !== 'pending' && !out.note) bad('Для вывода укажите основание в комментарии');
    return out;
  }

  const dto = (row) => ({id: row.id, version: row.version, createdAt: row.created_at,
    updatedAt: row.updated_at, ...JSON.parse(row.data)});
  const entry = (id, ownerScope) => {
    const row = db.prepare('SELECT * FROM ai_model_trials WHERE id=? AND owner_scope=?').get(id, ownerScope);
    if (!row) fail(404, 'Испытание не найдено');
    return row;
  };

  /* Идемпотентность повторного импорта: тот же набор, задача, провайдер и модель
     одной компании не заводятся дважды. */
  function requestId(trial) {
    const key = ['trial', trial.setId, trial.taskId, trial.provider, trial.modelId].join(':')
      .toLowerCase().replace(/[^a-z0-9:_.-]+/g, '-').replace(/:+/g, '-').replace(/-+/g, '-');
    return key.slice(0, 80).replace(/^[^a-z0-9]+/, '') || null;
  }

  function save(id, ownerScope, body, actor) {
    const target = scope(ownerScope);
    const previous = id ? entry(id, target) : null;
    if (previous && previous.version !== body.version) fail(409, 'Испытание изменено. Обновите данные.');
    const data = normalize(body);
    const key = previous ? previous.request_id : (body.requestId ? code(body.requestId, 'номер записи') : requestId(data));
    if (!previous) {
      const existing = db.prepare('SELECT * FROM ai_model_trials WHERE owner_scope=? AND request_id=?').get(target, key);
      if (existing) return dto(existing);
    }
    const time = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      let rowId = id;
      if (previous) {
        const changed = db.prepare('UPDATE ai_model_trials SET version=version+1,data=?,updated_at=? WHERE id=? AND version=?')
          .run(JSON.stringify(data), time, rowId, body.version);
        if (!changed.changes) fail(409, 'Испытание уже изменено');
      } else {
        rowId = Number(db.prepare('INSERT INTO ai_model_trials(owner_scope,data,request_id,created_at,updated_at) VALUES(?,?,?,?,?)')
          .run(target, JSON.stringify(data), key, time, time).lastInsertRowid);
      }
      db.exec('COMMIT');
      return dto(entry(rowId, target));
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    // Автор фиксируется общим аудитом Финансов на уровне маршрута; секреты сюда не попадают.
  }

  /* Выводы по кандидатам: только фактические строки, с обязательным размером выборки.
     Стоимость успешной принятой задачи считается лишь когда есть и стоимость, и успех. */
  function conclusions(trials) {
    const byModel = new Map();
    for (const trial of trials) {
      const key = `${trial.provider}|${trial.modelId}`;
      const current = byModel.get(key) || {provider: trial.provider, modelId: trial.modelId,
        sampleSize: 0, attempts: 0, successes: 0, factViolations: 0, isolationViolations: 0,
        manualEdits: 0, durationMs: 0, scored: 0, scoreSum: 0,
        costKnownCount: 0, costUnknownCount: 0, costByCurrency: {}, verdicts: {}};
      current.sampleSize += 1;
      current.attempts += trial.attempts;
      current.successes += trial.success ? 1 : 0;
      current.factViolations += trial.factViolations;
      current.isolationViolations += trial.isolationViolations;
      current.manualEdits += trial.manualEdit ? 1 : 0;
      current.durationMs += trial.durationMs;
      if (trial.humanScore !== null && trial.humanScore !== undefined) {
        current.scored += 1; current.scoreSum += trial.humanScore;
      }
      if (trial.costKnown && trial.costAmount !== null && trial.costCurrency) {
        current.costKnownCount += 1;
        const bucket = current.costByCurrency[trial.costCurrency] || {total: 0, successTotal: 0, successes: 0};
        bucket.total = Math.round((bucket.total + trial.costAmount) * 1e6) / 1e6;
        if (trial.success) {
          bucket.successTotal = Math.round((bucket.successTotal + trial.costAmount) * 1e6) / 1e6;
          bucket.successes += 1;
        }
        current.costByCurrency[trial.costCurrency] = bucket;
      } else current.costUnknownCount += 1;
      current.verdicts[trial.verdict] = (current.verdicts[trial.verdict] || 0) + 1;
      byModel.set(key, current);
    }
    const models = [...byModel.values()].map((item) => {
      const costPerAcceptedTask = {};
      for (const [currency, bucket] of Object.entries(item.costByCurrency)) {
        // Без успешных задач стоимость успешной задачи не считается: делить не на что.
        costPerAcceptedTask[currency] = bucket.successes
          ? Math.round((bucket.successTotal / bucket.successes) * 1e6) / 1e6 : null;
      }
      return {...item,
        successRate: item.sampleSize ? Math.round((item.successes / item.sampleSize) * 1000) / 10 : null,
        averageScore: item.scored ? Math.round((item.scoreSum / item.scored) * 100) / 100 : null,
        averageDurationMs: item.sampleSize ? Math.round(item.durationMs / item.sampleSize) : null,
        costPerAcceptedTask,
        costComplete: item.costUnknownCount === 0};
    }).sort((left, right) => right.sampleSize - left.sampleSize || left.modelId.localeCompare(right.modelId));
    return {models, sampleSize: trials.length,
      basis: 'Доли считаются по фактическим строкам этого журнала. Размер выборки указан рядом ' +
        'с каждой долей: без него доля ничего не значит. Строки с неизвестной стоимостью ' +
        'в стоимость не входят и видны отдельно. Ожидаемые показатели за фактические не выдаются.'};
  }

  function list(ownerScope, {offset = 0} = {}) {
    const target = scope(ownerScope);
    const rows = db.prepare('SELECT * FROM ai_model_trials WHERE owner_scope=? ORDER BY id DESC').all(target);
    const trials = rows.map(dto);
    return {trials: trials.slice(offset, offset + 100), total: trials.length, offset,
      conclusions: conclusions(trials), verdicts: VERDICTS};
  }

  return {save, list, conclusions, requestId, normalize};
}

module.exports = {createAiTrials, AI_TRIAL_VERDICTS: VERDICTS, AI_TRIAL_FIELDS: FIELDS};

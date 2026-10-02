'use strict';

/* Настройки выпуска — сохранённый выбор компании, без исполнения расписания.
   hours/preparationDays/reviewDays — пожелания для будущего плана, не назначенные сроки задач.
   publisherName не подтверждает учётную запись; права согласования остаются у owner.
   Аутентификация, company scope и CSRF принадлежат существующему вызывающему HTTP слою. */
const {company, fail, object, text, revision} = require('./company-information');

const FIELD_NAMES = Object.freeze(['releaseMode', 'publisherName', 'hours', 'preparationDays', 'reviewDays']);
const DEFAULT_FIELDS = Object.freeze({releaseMode: 'manual', publisherName: '', hours: Object.freeze([]), preparationDays: 0, reviewDays: 0});
const MAX_HOURS = 24;
const HOUR_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const defaults = () => ({...DEFAULT_FIELDS, hours: []});

function normalizeFields(patch) {
  object(patch, FIELD_NAMES);
  if (!Object.keys(patch).length) fail(400, 'Укажите, что изменить в настройках выпуска');
  const clean = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'releaseMode') {
      if (!['manual', 'scheduled'].includes(value)) fail(400, 'Выберите ручной выпуск или выпуск согласованных материалов по расписанию');
      clean[key] = value;
    } else if (key === 'publisherName') clean[key] = text(value, 200);
    else if (key === 'hours') {
      if (!Array.isArray(value) || value.length > MAX_HOURS || value.some((item) => typeof item !== 'string' || !HOUR_RE.test(item))
        || new Set(value).size !== value.length) fail(400, `Укажите до ${MAX_HOURS} разных часов в формате ЧЧ:ММ`);
      clean[key] = [...value].sort();
    } else {
      if (!Number.isSafeInteger(value) || value < 0 || value > 30) fail(400, 'Срок подготовки и согласования — целое число дней от 0 до 30');
      clean[key] = value;
    }
  }
  return clean;
}

function createContentFactoryWorkflow(db, {now = Date.now} = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS content_factory_workflow_versions (
    company_id INTEGER NOT NULL REFERENCES companies(id),revision INTEGER NOT NULL CHECK(revision>0),fields TEXT NOT NULL,
    created_at TEXT NOT NULL,actor_id INTEGER,actor_name TEXT NOT NULL DEFAULT '',PRIMARY KEY(company_id,revision));
    CREATE TRIGGER IF NOT EXISTS content_factory_workflow_versions_immutable_update BEFORE UPDATE ON content_factory_workflow_versions
    BEGIN SELECT RAISE(ABORT,'Immutable content factory workflow version'); END;
    CREATE TRIGGER IF NOT EXISTS content_factory_workflow_versions_immutable_delete BEFORE DELETE ON content_factory_workflow_versions
    BEGIN SELECT RAISE(ABORT,'Immutable content factory workflow version'); END;
    CREATE TABLE IF NOT EXISTS content_factory_workflows (
    company_id INTEGER PRIMARY KEY REFERENCES companies(id),revision INTEGER NOT NULL CHECK(revision>0),
    FOREIGN KEY(company_id,revision) REFERENCES content_factory_workflow_versions(company_id,revision));`);

  function stateOf(owner) {
    const row = db.prepare(`SELECT current.revision,version.fields FROM content_factory_workflows current
      LEFT JOIN content_factory_workflow_versions version ON version.company_id=current.company_id AND version.revision=current.revision
      WHERE current.company_id=?`).get(owner.id);
    let fields = defaults();
    if (row) {
      try {
        const saved = JSON.parse(row.fields);
        fields = normalizeFields(saved);
        if (Object.keys(fields).length !== FIELD_NAMES.length) throw Error('Incomplete workflow version');
      } catch {
        fail(500, 'Сохранённые настройки выпуска повреждены; требуется проверка данных', 'WORKFLOW_STORAGE_INVALID');
      }
    }
    return {companyCode: owner.code.toLowerCase(), revision: row?.revision || 0, configured: Boolean(row), fields, approverRole: 'owner'};
  }
  function get(code) { return stateOf(company(db, code)); }

  function save(code, body, actor = {}) {
    object(body, ['revision', 'fields']); revision(body.revision);
    const patch = normalizeFields(body.fields);
    const person = actor && typeof actor === 'object' ? actor : {};
    const actorId = Number.isSafeInteger(person.userId) && person.userId > 0 ? person.userId : null;
    const actorName = typeof person.userName === 'string' ? text(person.userName.slice(0, 200), 200) : '';
    db.exec('BEGIN IMMEDIATE');
    try {
      const owner = company(db, code), current = stateOf(owner);
      if (body.revision !== current.revision) fail(409, 'Настройки выпуска уже изменили. Обновите страницу.', 'REVISION_CONFLICT');
      const fields = {...current.fields, ...patch};
      const same = FIELD_NAMES.every((key) => JSON.stringify(fields[key]) === JSON.stringify(current.fields[key]));
      if (current.configured && same) { db.exec('COMMIT'); return current; }
      const next = current.revision + 1, createdAt = new Date(now()).toISOString();
      db.prepare('INSERT INTO content_factory_workflow_versions(company_id,revision,fields,created_at,actor_id,actor_name) VALUES(?,?,?,?,?,?)')
        .run(owner.id, next, JSON.stringify(fields), createdAt, actorId, actorName);
      db.prepare(`INSERT INTO content_factory_workflows(company_id,revision) VALUES(?,?)
        ON CONFLICT(company_id) DO UPDATE SET revision=excluded.revision`).run(owner.id, next);
      const result = stateOf(owner);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return {get, save};
}

module.exports = {createContentFactoryWorkflow, DEFAULT_FIELDS, FIELD_NAMES, MAX_HOURS};

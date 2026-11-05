'use strict';

/* Заказы с сайтов (корзина/форма сервиса контента) становятся обычными заявками CRM.
   Тот же реестр leads и тот же INSERT, что у публичного POST /leads; отличие — ключ идемпотентности
   external_ref = «site-order:<сайт>:<номер заказа>»: повтор передачи того же заказа не создаёт вторую
   заявку. По контакту заказы не склеиваются: каждый заказ — отдельная заявка.
   Вызов только служебный (x-api-key проверяет маршрутизатор). Компания должна быть активной;
   заказ, уже переданный другой компании, не перепривязывается. Письма о заявке здесь не ставятся:
   получатель уже уведомлён каналом заказа в сервисе контента. Сумма заказа — не продажа: sale_amount
   и этап не меняются, сумма и состав записываются в комментарий. */

const EXTERNAL_REF = /^site-order:[a-z0-9][a-z0-9_-]{0,39}:[1-9]\d{0,11}$/;
const BODY_FIELDS = new Set(['companyCode', 'externalRef', 'name', 'contact', 'channel', 'source', 'page', 'comment', 'firstQuestion',
  'utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm']);
const LIMITS = { name: 120, contact: 120, channel: 60, source: 120, page: 500, comment: 4000, firstQuestion: 1000,
  utmSource: 200, utmMedium: 200, utmCampaign: 200, utmContent: 200, utmTerm: 200 };

/* Обратимая миграция: колонка и частичный уникальный индекс. Прежние строки получают NULL — не участвуют. */
function migrateSiteOrderLeads(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(leads)').all().map((row) => row.name));
  if (!columns.has('external_ref')) db.exec('ALTER TABLE leads ADD COLUMN external_ref TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS leads_external_ref_idx ON leads(external_ref) WHERE external_ref IS NOT NULL');
}
function revertSiteOrderLeads(db) {
  db.exec('DROP INDEX IF EXISTS leads_external_ref_idx');
  const columns = new Set(db.prepare('PRAGMA table_info(leads)').all().map((row) => row.name));
  if (columns.has('external_ref')) db.exec('ALTER TABLE leads DROP COLUMN external_ref');
}

function createSiteOrderLeads({ db, fail, createLead, getLead, insertStageHistory, normalizeContact }) {
  migrateSiteOrderLeads(db);
  const byRef = db.prepare('SELECT * FROM leads WHERE external_ref = ?');
  const setRef = db.prepare('UPDATE leads SET external_ref = ? WHERE id = ?');
  const text = (body, field, required = false) => {
    const value = body[field];
    if (value === undefined || value === null || value === '') {
      if (required) fail(400, `Поле «${field}» обязательно`);
      return null;
    }
    if (typeof value !== 'string') fail(400, `Поле «${field}» должно быть строкой`);
    const clean = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
    if (!clean) { if (required) fail(400, `Поле «${field}» обязательно`); return null; }
    if (clean.length > LIMITS[field]) fail(400, `Слишком длинное поле «${field}»`);
    return clean;
  };
  const view = (row, duplicate) => ({ ok: true, leadId: row.id, companyCode: row.company_code, duplicate });

  function accept(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Ожидался JSON-объект');
    for (const key of Object.keys(body)) if (!BODY_FIELDS.has(key)) fail(400, `Неизвестное поле ${key}`);
    const code = text(body, 'companyCode', true)?.toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(code)) fail(400, 'Некорректный код компании');
    const company = db.prepare('SELECT code FROM companies WHERE code = ? COLLATE NOCASE AND is_deleted = 0').get(code);
    if (!company) fail(409, 'Активная компания с таким кодом не найдена', { code: 'COMPANY_NOT_ACTIVE' });
    const ref = typeof body.externalRef === 'string' ? body.externalRef : '';
    if (!EXTERNAL_REF.test(ref)) fail(400, 'Некорректный номер заказа');
    const sameCompany = (row) => String(row.company_code || '').toLowerCase() === company.code.toLowerCase();
    const existing = byRef.get(ref);
    if (existing) {
      if (!sameCompany(existing)) fail(409, 'Заказ уже передан другой компании', { code: 'COMPANY_MISMATCH' });
      return { status: 200, body: view(existing, true) };
    }
    const name = text(body, 'name', true), contact = text(body, 'contact', true);
    const values = Object.fromEntries(Object.keys(LIMITS).map((field) => [field, ['name', 'contact'].includes(field) ? null : text(body, field)]));
    let row;
    db.exec('BEGIN IMMEDIATE');
    try {
      const again = byRef.get(ref);
      if (again) { db.exec('ROLLBACK'); if (!sameCompany(again)) fail(409, 'Заказ уже передан другой компании', { code: 'COMPANY_MISMATCH' }); return { status: 200, body: view(again, true) }; }
      const result = createLead.run(new Date().toISOString(), name, contact, normalizeContact(contact), values.channel,
        values.source, 'site-order', values.page, values.firstQuestion, values.comment, values.utmSource, values.utmMedium,
        values.utmCampaign, values.utmContent, values.utmTerm, null, null, values.page, company.code);
      const id = Number(result.lastInsertRowid);
      setRef.run(ref, id);
      row = getLead.get(id);
      insertStageHistory.run(row.id, row.created_at, null, row.stage);
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
    return { status: 201, body: view(row, false) };
  }
  return { accept };
}

module.exports = { createSiteOrderLeads, migrateSiteOrderLeads, revertSiteOrderLeads, EXTERNAL_REF };

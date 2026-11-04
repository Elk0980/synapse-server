'use strict';
/* №98 Б: согласующие контент-плана из «Настроек → Контент» (контракт А, таблица content_settings
   в базе content). Прокси передаёт список в CRM доверенным заголовком только для
   /media-mentor/plan/signoffs; присланный браузером заголовок с тем же именем удаляется.
   В список попадают только люди этой компании с правом content-plan.approve и владельцы — те же
   кандидаты, что и в «Настройках». Нет таблицы (каркас А ещё не выпущен) или никто не выбран —
   пустой заголовок: CRM оставляет согласующим владельца. */
const HEADER = 'x-synapse-content-approvers';

function createContentPlanApprovers({ db, authStore }) {
  function forCompany(companyCode) {
    const code = String(companyCode || '').toLowerCase();
    let row;
    try { row = db.prepare('SELECT body FROM content_settings WHERE lower(company_code) = ?').get(code); }
    catch { return null; }
    let ids;
    try { ids = JSON.parse(row?.body || '{}').approverUserIds; } catch { return null; }
    if (!Array.isArray(ids) || !ids.length) return null;
    const list = [];
    for (const id of ids.slice(0, 20)) {
      const user = Number.isSafeInteger(id) ? authStore.getById(id) : null;
      if (!user) continue;
      const allowed = user.role === 'owner'
        || ((user.companyCodes || []).includes(code) && (user.permissions || []).includes('content-plan.approve'));
      if (allowed) list.push({ userId: user.id, label: String(user.displayName || user.login || `#${user.id}`).slice(0, 200) });
    }
    return list.length ? list : null;
  }
  // Значение заголовка: base64url(JSON) или '' — тогда заголовок не ставится.
  function header(companyCode) {
    const list = forCompany(companyCode);
    return list ? Buffer.from(JSON.stringify(list)).toString('base64url') : '';
  }
  return { forCompany, header };
}

module.exports = { createContentPlanApprovers, APPROVERS_HEADER: HEADER };

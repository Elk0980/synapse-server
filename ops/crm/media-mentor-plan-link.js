'use strict';

/* Связь карточки автопостинга с версией идеи контент-плана и охрана отправки по ней.

   Смысл один: карточка, которая появилась из согласованной версии плана, отправляется только
   пока эта самая версия согласована. Правка текста версии, её исключение, отзыв согласования,
   смена брифа или подмена идеи в плане останавливают отправку — молча уйти в эфир по отозванному
   тексту нельзя ни через план, ни через фоновый обход очереди, ни в последний момент перед POST.

   Охрана читает ТОЛЬКО факты в базе и работает синхронно: её нельзя обойти подделкой поля в теле
   запроса. Связь ищется по паре (карточка, её компания), взятой из самой строки карточки, поэтому
   чужая компания чужую расписку не видит. Карточка без связи (обычный автопостинг) не ограничивается.

   Признаки очереди (day_key, подписи площадок) на связь не влияют: она живёт в своей таблице,
   и очистка подписей её не снимает. */

const REASON = 'PLAN_APPROVAL_REVOKED';
const MESSAGE = 'Версия контент-плана для этой площадки больше не согласована. ' +
  'Согласуйте её заново в разделе «Бриф и план».';
const PLATFORM_REASON = 'PLAN_PLATFORM_MISMATCH';
const PLATFORM_MESSAGE = 'Этот материал согласован в плане для другой площадки. ' +
  'Отправить его на выбранный канал нельзя: согласуйте версию для этой площадки в плане.';

function createMediaMentorPlanLink(db) {
  const has = (table) => Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  // Таблицы появляются вместе с Медиа-наставником. Пока его нет, охранять нечего,
  // но наличие проверяется на каждом вызове: модуль может быть поднят позже.
  const ready = () => has('media_mentor_variant_transfers') && has('media_mentor_plans')
    && has('media_mentor_briefs') && has('media_mentor_variant_approvals');

  function linkOf(postId, companyId) {
    if (!ready()) return null;
    return db.prepare(`SELECT idea_id ideaId,platform,content_revision contentRevision,
      plan_revision planRevision,brief_revision briefRevision
      FROM media_mentor_variant_transfers WHERE post_id=? AND company_id=?`).get(postId, companyId) || null;
  }

  /* Пусто — отправка разрешена. Непустая строка — причина запрета.
     Проверяются ровно те факты, которые делают отправку правомерной сейчас, а не когда-то. */
  function blockedReason(row) {
    if (!row || !row.id || !row.company_id) return '';
    const link = linkOf(row.id, row.company_id);
    if (!link) return '';
    const planRow = db.prepare('SELECT revision,brief_revision briefRevision,plan FROM media_mentor_plans WHERE company_id=?').get(row.company_id);
    if (!planRow) return REASON;
    const briefRow = db.prepare('SELECT revision FROM media_mentor_briefs WHERE company_id=?').get(row.company_id);
    // Бриф уехал вперёд — согласование прежней версии больше не действует.
    if (!briefRow || briefRow.revision !== planRow.briefRevision) return REASON;
    let idea = null;
    try {
      idea = (JSON.parse(planRow.plan).days || []).find((day) => day && day.ideaId === link.ideaId) || null;
    } catch { return REASON; }
    const variant = idea && idea.variants ? idea.variants[link.platform] : null;
    // Версии нет, она исключена или пуста — согласовывать было нечего.
    if (!variant || variant.excluded === true || !variant.text) return REASON;
    // Текст версии изменили после переноса: карточка держит прежнюю ревизию содержимого.
    if (variant.contentRevision !== link.contentRevision) return REASON;
    /* Решение обязано относиться к ДЕЙСТВУЮЩЕМУ брифу. Решение, принятое по прежней версии
       брифа, разрешением не является, даже если текст версии с тех пор не менялся: контекст,
       в котором его принимали, другой. Один актуальный контекст для связи, брифа и решения. */
    const decision = db.prepare(`SELECT decision FROM media_mentor_variant_approvals
      WHERE company_id=? AND idea_id=? AND platform=? AND content_revision=? AND brief_revision=?
      ORDER BY id DESC LIMIT 1`).get(row.company_id, link.ideaId, link.platform,
      link.contentRevision, briefRow.revision);
    if (!decision || decision.decision !== 'approved') return REASON;
    return '';
  }

  /* Подмена площадки: карточка согласована для одной площадки, а канал выбран на другой.
     Сверяется ФАКТИЧЕСКАЯ площадка канала, а не его идентификатор: у канала id и platform
     совпадать не обязаны, и предполагать это нельзя. Отдельное одобрение материала
     эту проверку не отменяет — оно про текст и медиа, а не про то, куда они уйдут. */
  function platformMismatch(row, platform) {
    if (!row || !row.id || !row.company_id) return '';
    const link = linkOf(row.id, row.company_id);
    if (!link) return '';
    return link.platform === platform ? '' : PLATFORM_REASON;
  }

  const allowed = (row) => !blockedReason(row);
  return {linkOf, blockedReason, platformMismatch, allowed, REASON, MESSAGE,
    PLATFORM_REASON, PLATFORM_MESSAGE};
}

module.exports = {createMediaMentorPlanLink, MEDIA_MENTOR_PLAN_LINK_REASON: REASON,
  MEDIA_MENTOR_PLAN_LINK_MESSAGE: MESSAGE,
  MEDIA_MENTOR_PLAN_PLATFORM_REASON: PLATFORM_REASON,
  MEDIA_MENTOR_PLAN_PLATFORM_MESSAGE: PLATFORM_MESSAGE};

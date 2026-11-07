'use strict';
/* Проверка выхода публикаций через сервис (specs/215-publish-verify).
   Только чтение у провайдера: статус задания, поиск задания без идентификатора, ссылка на пост.
   Никогда не публикует повторно и не вызывает /posts/{id}/retry или /publish: это создало бы дубль.

   Решение Влада 07.11: после публикации из кабинета система сама подтверждает выход и сохраняет ссылку.
   Выход подтверждает ПОВТОРНОЕ чтение задания (GET), а не ответ на отправку. Источник подтверждения
   хранится в confirmed_via: provider_status — сервис сообщил «опубликовано», provider_permalink — найдена
   ссылка на конкретный пост. Ссылки нет — url остаётся пустым с кодом PROVIDER_LINK_UNAVAILABLE. */
const {contentDigest} = require('./onlypult-provider');

const MINUTE = 60000, HOUR = 60 * MINUTE;
const LINK_PLATFORMS = Object.freeze(['instagram', 'tiktok']);
const STATUSES = Object.freeze(['draft', 'scheduled', 'published', 'failed']);

function createPublishVerifier(db, {transport, now = Date.now, logger = console, days = 7, perTick = 5, linksPerTick = 2} = {}) {
  const iso = () => new Date(now()).toISOString();
  const windowDays = Number.isInteger(days) && days > 0 && days <= 60 ? days : 7;
  const since = ms => new Date(now() - ms).toISOString();

  // Текст, отправленный именно в этот канал: подпись площадки или общий текст. Правка содержимого
  // удаляет доставки, поэтому у существующей доставки содержимое то же, что ушло провайдеру.
  function sentText(postId, channelId) {
    const row = db.prepare('SELECT text,captions FROM autoposting_posts WHERE id=?').get(postId);
    if (!row) return '';
    let captions = {};
    try {captions = JSON.parse(row.captions || '{}') || {};} catch {}
    return String((captions && typeof captions === 'object' && captions[channelId]) || row.text || '');
  }

  // Итог карточки по доставкам: все вышли — «опубликовано»; иначе код первой непроверенной.
  function refreshPost(postId) {
    const rows = db.prepare('SELECT status,error_code FROM autoposting_deliveries WHERE post_id=? ORDER BY channel_id').all(postId);
    if (!rows.length) return;
    if (rows.every(row => row.status === 'published')) {
      db.prepare(`UPDATE autoposting_posts SET status='published',last_error_code=NULL,revision=revision+1,updated_at=?
        WHERE id=? AND status IN ('needs_review','failed')`).run(iso(), postId);
      return;
    }
    const open = rows.find(row => row.status === 'needs_review') || rows.find(row => row.status === 'failed');
    if (open) db.prepare(`UPDATE autoposting_posts SET last_error_code=?,revision=revision+1,updated_at=?
      WHERE id=? AND status IN ('needs_review','failed') AND COALESCE(last_error_code,'')<>?`).run(open.error_code || 'PROVIDER_PENDING', iso(), postId, open.error_code || 'PROVIDER_PENDING');
  }

  /* Результат чтения задания. «published» переводит доставку в опубликованные: повторная отправка после
     этого закрыта существующими проверками (PUBLICATION_REVIEW_REQUIRED). Остальные статусы только
     обновляют сведения; доставка остаётся на проверке. Опубликованная доставка не понижается. */
  async function apply(delivery, code, result) {
    const key = [delivery.post_id, delivery.channel_id, result.providerPostId];
    if (result.providerStatus === 'published') {
      const publishedAt = result.publishedAt || iso();
      const link = await findLink({...delivery, provider_post_id: result.providerPostId}, code, publishedAt);
      const changed = db.prepare(`UPDATE autoposting_deliveries SET status='published',provider_status='published',provider_checked_at=?,
        provider_published_at=?,external_id=COALESCE(external_id,?),url=?,error_code=?,confirmed_via=?,finished_at=COALESCE(finished_at,?),link_checked_at=?
        WHERE post_id=? AND channel_id=? AND provider_post_id=? AND status IN ('needs_review','failed')`)
        .run(iso(), publishedAt, `onlypult:${result.providerPostId}`, link, link ? null : 'PROVIDER_LINK_UNAVAILABLE',
          link ? 'provider_permalink' : 'provider_status', publishedAt, LINK_PLATFORMS.includes(delivery.channel_id) ? iso() : null, ...key).changes;
      if (changed) refreshPost(delivery.post_id);
      return;
    }
    db.prepare(`UPDATE autoposting_deliveries SET provider_status=?,provider_checked_at=?,error_code=?
      WHERE post_id=? AND channel_id=? AND provider_post_id=? AND status IN ('needs_review','failed')`)
      .run(result.providerStatus, iso(), result.errorCode || 'PROVIDER_PENDING', ...key);
    refreshPost(delivery.post_id);
  }

  async function findLink(delivery, code, publishedAt) {
    if (!LINK_PLATFORMS.includes(delivery.channel_id) || !transport.postLink) return null;
    /* Подпись карточки без метки рилса (specs/217 дописывает её только при отправке). Правка содержимого удаляет
       доставки, поэтому у существующей доставки подпись та же; метка в конце не мешает сравнению по началу. */
    const text = sentText(delivery.post_id, delivery.channel_id);
    try {
      return await transport.postLink({companyCode: code, channelId: delivery.channel_id, channelRevision: delivery.channel_revision,
        providerPostId: delivery.provider_post_id, publishedAt, text}) || null;
    } catch {return null;}
  }

  async function checkKnown(delivery, code) {
    let result;
    try {
      result = await transport.reconcile({companyCode: code, channelId: delivery.channel_id,
        channelRevision: delivery.channel_revision, providerPostId: delivery.provider_post_id});
      if (!result || result.providerPostId !== delivery.provider_post_id || !STATUSES.includes(result.providerStatus)) throw Error('Invalid provider receipt');
    } catch {
      // Неудачное чтение не разрешает повторную отправку и не стирает известный идентификатор задания.
      db.prepare(`UPDATE autoposting_deliveries SET provider_checked_at=?,error_code='PROVIDER_CHECK_FAILED'
        WHERE post_id=? AND channel_id=? AND provider_post_id=? AND status='needs_review'`)
        .run(iso(), delivery.post_id, delivery.channel_id, delivery.provider_post_id);
      return;
    }
    await apply(delivery, code, result);
  }

  /* Задание без идентификатора: ответ на отправку потерян или был ошибкой, но запрос ушёл. Ищем у провайдера
     строго по профилю, отпечатку текста и окну времени. Нашли одно — идентификатор сохраняется и дальше
     обычная сверка. Не нашли — отметка времени проверки, состояние прежнее. */
  async function lookup(delivery, code) {
    const text = sentText(delivery.post_id, delivery.channel_id);
    const contentSha = delivery.provider_content_sha || (text.trim() ? contentDigest(text) : '');
    const submittedAt = delivery.provider_submitted_at || (Number.isSafeInteger(delivery.started_at) ? new Date(delivery.started_at).toISOString() : '');
    const mark = () => db.prepare('UPDATE autoposting_deliveries SET provider_checked_at=? WHERE post_id=? AND channel_id=? AND provider_post_id IS NULL')
      .run(iso(), delivery.post_id, delivery.channel_id);
    if (!contentSha || !submittedAt || !transport.lookupSubmitted) {mark(); return;}
    let result;
    try {
      result = await transport.lookupSubmitted({companyCode: code, channelId: delivery.channel_id,
        channelRevision: delivery.channel_revision, contentSha, submittedAt});
    } catch {mark(); return;}
    if (!result || typeof result.providerPostId !== 'string' || !STATUSES.includes(result.providerStatus)) {mark(); return;}
    // Одно задание провайдера — одна доставка: уже присвоенный идентификатор второй раз не берётся.
    if (db.prepare('SELECT 1 FROM autoposting_deliveries WHERE channel_id=? AND provider_post_id=?').get(delivery.channel_id, result.providerPostId)) {mark(); return;}
    const adopted = db.prepare(`UPDATE autoposting_deliveries SET provider_post_id=?,provider_status=?,provider_checked_at=?,
      provider_content_sha=COALESCE(provider_content_sha,?),status='needs_review',error_code=?
      WHERE post_id=? AND channel_id=? AND provider_post_id IS NULL AND status IN ('needs_review','failed')`)
      .run(result.providerPostId, result.providerStatus, iso(), contentSha, result.errorCode || 'PROVIDER_PENDING', delivery.post_id, delivery.channel_id).changes;
    if (!adopted) return;
    db.prepare(`UPDATE autoposting_posts SET status='needs_review',revision=revision+1,updated_at=? WHERE id=? AND status='failed'`).run(iso(), delivery.post_id);
    // Найденное в списке подтверждается отдельным чтением именно этого задания.
    const adoptedRow = db.prepare('SELECT * FROM autoposting_deliveries WHERE post_id=? AND channel_id=?').get(delivery.post_id, delivery.channel_id);
    await checkKnown(adoptedRow, code);
  }

  // Ссылка для уже подтверждённого выхода (сверка опубликованных за последние N дней).
  async function relink(delivery, code) {
    const link = await findLink(delivery, code, delivery.provider_published_at || delivery.finished_at);
    db.prepare(`UPDATE autoposting_deliveries SET link_checked_at=?${link ? ",url=?,error_code=NULL,confirmed_via='provider_permalink'" : ''}
      WHERE post_id=? AND channel_id=? AND status='published' AND url IS NULL`)
      .run(...(link ? [iso(), link] : [iso()]), delivery.post_id, delivery.channel_id);
  }

  const base = `FROM autoposting_deliveries d JOIN autoposting_posts p ON p.id=d.post_id JOIN companies c ON c.id=p.company_id
    WHERE c.is_deleted=0 AND p.archived_at IS NULL AND p.deleted_at IS NULL`;
  function candidates(postId = null) {
    const one = postId === null ? '' : ' AND d.post_id=?', args = postId === null ? [] : [postId];
    const pick = postId === null;
    const known = db.prepare(`SELECT d.*,c.code ${base}${one} AND d.status='needs_review' AND d.provider_post_id IS NOT NULL AND (
        (d.provider_status IN ('draft','scheduled') AND (d.provider_checked_at IS NULL OR d.provider_checked_at<=?))
        OR (d.provider_status IN ('failed','published') AND (d.provider_checked_at IS NULL OR d.provider_checked_at<=?)
          AND COALESCE(d.started_at,0)>=?))
      ORDER BY d.provider_checked_at LIMIT ?`).all(...args, pick ? since(MINUTE) : iso(), pick ? since(10 * MINUTE) : iso(),
      now() - windowDays * 24 * HOUR, perTick);
    const missing = db.prepare(`SELECT d.*,c.code ${base}${one} AND d.status IN ('needs_review','failed') AND d.provider_post_id IS NULL
      AND (d.provider_submitted_at IS NOT NULL OR d.error_code IN ('PUBLISH_FAILED','PUBLICATION_UNCERTAIN'))
      AND d.started_at IS NOT NULL AND d.started_at>=? AND d.started_at<=? AND ${viaProvider()}
      AND (d.provider_checked_at IS NULL OR d.provider_checked_at<=?)
      ORDER BY d.started_at LIMIT ?`).all(...args, now() - windowDays * 24 * HOUR, pick ? now() - 2 * MINUTE : now(), pick ? since(10 * MINUTE) : iso(), perTick);
    const links = db.prepare(`SELECT d.*,c.code ${base}${one} AND d.status='published' AND d.url IS NULL AND d.provider_post_id IS NOT NULL
      AND d.channel_id IN ('instagram','tiktok') AND COALESCE(d.provider_published_at,d.finished_at,'')>=?
      AND (d.link_checked_at IS NULL OR d.link_checked_at<=?) ORDER BY d.link_checked_at LIMIT ?`)
      .all(...args, since(windowDays * 24 * HOUR), pick ? since(HOUR) : iso(), linksPerTick);
    return {known, missing, links};
  }
  /* Искать задание у сервиса имеет смысл только для канала, подключённого через сервис. Прямые ВК/Telegram
     сразу получают ссылку от площадки и у сервиса не ищутся. Нет таблицы каналов — только каналы «только через сервис». */
  function viaProvider() {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='autoposting_channels'").get();
    return exists ? "EXISTS(SELECT 1 FROM autoposting_channels ch WHERE ch.company_code=c.code AND ch.id=d.channel_id AND ch.provider='onlypult')"
      : "d.channel_id IN ('instagram','tiktok','youtube_shorts','max')";
  }

  let stopped = false;
  async function tick(postId = null) {
    if (!transport.reconcile) return {known: 0, missing: 0, links: 0};
    const {known, missing, links} = candidates(postId);
    for (const delivery of known) {if (stopped) break; await checkKnown(delivery, delivery.code);}
    for (const delivery of missing) {if (stopped) break; await lookup(delivery, delivery.code);}
    for (const delivery of links) {if (stopped) break; await relink(delivery, delivery.code);}
    if (known.length + missing.length + links.length) logger.warn?.(`[crm] autoposting verify known=${known.length} missing=${missing.length} links=${links.length}`);
    return {known: known.length, missing: missing.length, links: links.length};
  }
  return {tick, checkKnown, stop() {stopped = true;}};
}

module.exports = {createPublishVerifier, LINK_PLATFORMS};

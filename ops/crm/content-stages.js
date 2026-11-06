'use strict';
/* Вычисляемый этап идеи контент-плана (specs/209-cf-stages, решение Влада 07.11: этап меняется сам по действию).
   Только чтение фактов из базы CRM и доверенных фактов съёмки от прокси content. Ничего не пишет, ничего не
   отправляет, кнопок «подтвердить этап» нет. Идентификаторы этапов — CfKit.STAGES кабинета.

   Порядок: чем дальше по цепочке факт, тем он главнее —
   публикация → монтаж → съёмка → решение по сценарию → черновик плана.
   Нет факта — этап не выдумывается: идея остаётся на ближайшем подтверждённом этапе.
   «Снято с публикации» (unpublished) в CRM пока не фиксируется — этот этап сервер не выдаёт. */

const STAGE_IDS = Object.freeze(['draft', 'script_review', 'script_rework', 'planned', 'shot', 'editing', 'edit_review',
  'edit_rework', 'ready', 'scheduled', 'published', 'publish_error', 'unpublished']);
const FACTS_HEADER = 'x-synapse-shooting-facts';
const VIDEO = /\.(?:mp4|webm|mov)(?:$|[?#])/i;
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };

/* Факты съёмки приходят от content только для своей компании. Подделку из браузера content удаляет,
   здесь дополнительно сверяется компания и форма: чужой или битый заголовок → фактов съёмки нет. */
function shootingFacts(request, code) {
  const raw = request?.headers?.[FACTS_HEADER];
  if (!raw) return null;
  const value = parse(Buffer.from(String(raw), 'base64url').toString('utf8'), null);
  if (!value || value.v !== 1 || String(value.companyCode || '').toLowerCase() !== String(code || '').toLowerCase()) return null;
  if (value.truncated || !value.reels || typeof value.reels !== 'object' || Array.isArray(value.reels)) return null;
  const reels = new Map();
  for (const [ideaId, entry] of Object.entries(value.reels)) {
    if (!Array.isArray(entry) || entry.length !== 5 || entry.slice(0, 4).some((n) => !Number.isSafeInteger(n) || n < 0)) continue;
    reels.set(ideaId, {frames: entry[0], framesShot: entry[1], takes: entry[2], drafts: entry[3],
      manualStatus: ['approved', 'shot', 'editing', 'draft'].includes(entry[4]) ? entry[4] : null});
  }
  return reels;
}

function createContentStages(db) {
  const has = (table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));

  /* Публикации автопостинга, связанные с идеями компании: перенос версии плана (media_mentor_variant_transfers)
     и ролик «Материалов», привязанный к идее (reel_materials.idea_id → post_id). Только своя company_id. */
  function postsByIdea(companyId) {
    const out = new Map();
    if (!has('autoposting_posts')) return out;
    const add = (ideaId, postId, via) => {
      if (!ideaId || !postId) return;
      const list = out.get(ideaId) || out.set(ideaId, new Map()).get(ideaId);
      if (!list.has(postId)) list.set(postId, via);
    };
    if (has('media_mentor_variant_transfers'))
      for (const row of db.prepare('SELECT idea_id, post_id FROM media_mentor_variant_transfers WHERE company_id=?').all(companyId)) add(row.idea_id, row.post_id, 'plan');
    if (has('reel_materials') && columns('reel_materials').has('idea_id'))
      for (const row of db.prepare('SELECT idea_id, post_id FROM reel_materials WHERE company_id=? AND idea_id IS NOT NULL AND post_id IS NOT NULL').all(companyId))
        add(row.idea_id, row.post_id, 'materials');
    return out;
  }

  function postFacts(companyId, postId, via) {
    const row = db.prepare('SELECT * FROM autoposting_posts WHERE id=? AND company_id=?').get(postId, companyId);
    if (!row || row.deleted_at || row.archived_at) return null;
    const receipts = has('autoposting_publication_receipts') ? db.prepare(`SELECT platform, url, published_at publishedAt, content_revision contentRevision
      FROM autoposting_publication_receipts WHERE post_id=? AND company_id=? ORDER BY published_at DESC, id DESC`).all(row.id, companyId) : [];
    const deliveries = has('autoposting_deliveries') ? db.prepare(`SELECT channel_id channelId, status, url, finished_at finishedAt
      FROM autoposting_deliveries WHERE post_id=? ORDER BY channel_id`).all(row.id) : [];
    const platforms = parse(row.platform_ids || '[]', []);
    const media = parse(row.media_urls || '[]', []);
    const approved = row.approved_revision !== null && row.approved_revision !== undefined && row.approved_revision === (row.content_revision ?? 1);
    return {row, via, receipts, deliveries, platforms: Array.isArray(platforms) ? platforms : [],
      video: via === 'materials' || (Array.isArray(media) && media.some((item) => VIDEO.test(String(item)))), approved};
  }

  /* Публикации идеи по площадкам: {platform, status, url, publishedAt}. status — draft|scheduled|publishing|
     published|error|cancelled. «published» — только по факту: доставка площадки со статусом published или
     отметка «опубликовано вне ЛК» текущей версии; ссылка — та, что пришла от площадки или из отметки. */
  function publicationsOf(facts) {
    const out = [];
    for (const item of facts) {
      const {row, receipts, deliveries} = item;
      const byPlatform = new Map();
      const put = (platform, entry) => { if (!byPlatform.has(platform)) byPlatform.set(platform, entry); };
      for (const receipt of receipts) if (receipt.contentRevision === (row.content_revision ?? 1))
        put(receipt.platform, {platform: receipt.platform, status: 'published', url: receipt.url || null, publishedAt: receipt.publishedAt || null});
      for (const delivery of deliveries) {
        const status = delivery.status === 'published' ? 'published' : ['failed', 'needs_review'].includes(delivery.status) ? 'error'
          : delivery.status === 'cancelled' ? 'cancelled' : delivery.status === 'publishing' ? 'publishing' : row.status === 'scheduled' ? 'scheduled' : 'draft';
        put(delivery.channelId, {platform: delivery.channelId, status, url: delivery.url || null,
          publishedAt: status === 'published' ? delivery.finishedAt || null : null});
      }
      const fallback = row.status === 'published' ? 'published' : ['failed', 'needs_review'].includes(row.status) ? 'error' : row.status;
      // Без доставок площадки берутся из карточки: id канала и площадка совпадать не обязаны, поэтому не смешиваются.
      if (!deliveries.length) for (const platform of item.platforms)
        put(platform, {platform, status: fallback, url: null, publishedAt: null});
      for (const entry of byPlatform.values()) out.push({...entry, postId: row.id});
    }
    return out;
  }

  function publicationStage(facts, publications) {
    const live = facts.filter((item) => item.row.status !== 'cancelled');
    const published = publications.filter((p) => p.status === 'published');
    if (published.length) return 'published';
    if (live.some((item) => ['failed', 'needs_review'].includes(item.row.status)) || publications.some((p) => p.status === 'error')) return 'publish_error';
    if (live.some((item) => ['scheduled', 'publishing'].includes(item.row.status))) return 'scheduled';
    // Монтаж согласован: карточка с роликом одобрена для текущей версии содержимого и ждёт выхода.
    if (live.some((item) => item.video && item.approved)) return 'ready';
    return '';
  }

  /* Ролики «Материалов» идеи: прямая связь idea_id или публикация, перенесённая из этой идеи. */
  function reelsByIdea(companyId, postIdea) {
    const out = new Map();
    if (!has('reel_materials')) return out;
    const direct = columns('reel_materials').has('idea_id');
    for (const row of db.prepare(`SELECT id, post_id${direct ? ', idea_id' : ''} FROM reel_materials WHERE company_id=?`).all(companyId)) {
      const ideaId = (direct && row.idea_id) || (row.post_id && postIdea.get(row.post_id)) || null;
      if (!ideaId) continue;
      const versions = db.prepare('SELECT COUNT(*) n FROM reel_versions WHERE reel_id=?').get(row.id).n;
      const open = db.prepare("SELECT COUNT(*) n FROM reel_edits WHERE reel_id=? AND company_id=? AND status IN ('pending','in_progress')").get(row.id, companyId).n;
      const entry = out.get(ideaId) || out.set(ideaId, {versions: 0, openEdits: 0}).get(ideaId);
      entry.versions += versions; entry.openEdits += open;
    }
    return out;
  }

  function scriptStage(idea, variants, wholePlan) {
    const own = variants.filter((v) => v.ideaId === idea.ideaId).map((v) => v.status);
    if (own.includes('rejected')) return 'script_rework';
    if (own.includes('pending')) return 'script_review';
    if (own.includes('approved') || (wholePlan && own.length && own.some((s) => s !== 'excluded' && s !== 'empty'))) return 'planned';
    return 'draft';
  }

  /* snapshot — ответ mentor.get(code) для компании, уже проверенной companyModuleContext; код сверяется ещё раз.
     Возвращает копию: план в модуле Медиа-наставника не меняется. */
  function apply(snapshot, code, shooting) {
    const companyRow = db.prepare('SELECT id, code, timezone FROM companies WHERE code=? COLLATE NOCASE AND COALESCE(is_deleted,0)=0').get(String(code || ''));
    if (!companyRow || String(companyRow.code).toLowerCase() !== String(snapshot.companyCode || '').toLowerCase()) return snapshot;
    const companyId = companyRow.id;
    const timeZone = String(companyRow?.timezone || '').trim();
    const company = {code: String(companyRow?.code || snapshot.companyCode || '').toLowerCase(), timeZone: timeZone || null,
      timeZoneSource: timeZone ? 'company' : 'unset'};
    if (!snapshot.plan) return {...snapshot, company};
    const links = postsByIdea(companyId), postIdea = new Map();
    for (const [ideaId, posts] of links) for (const postId of posts.keys()) if (!postIdea.has(postId)) postIdea.set(postId, ideaId);
    const reels = reelsByIdea(companyId, postIdea);
    const variants = snapshot.variants || [], wholePlan = snapshot.approval?.status === 'approved';
    const days = snapshot.plan.days.map((idea) => {
      const facts = [...(links.get(idea.ideaId) || new Map())].map(([postId, via]) => postFacts(companyId, postId, via)).filter(Boolean);
      const publications = publicationsOf(facts);
      let stage = publicationStage(facts, publications), source = stage ? 'publication' : '';
      const reel = reels.get(idea.ideaId);
      if (!stage && reel && reel.versions) { stage = reel.openEdits ? 'edit_rework' : 'edit_review'; source = 'montage'; }
      const shot = shooting?.get(idea.ideaId);
      if (!stage && shot) {
        if (shot.drafts || shot.manualStatus === 'draft') stage = 'edit_review';
        else if (shot.manualStatus === 'editing') stage = 'editing';
        else if (shot.manualStatus === 'shot' || (shot.frames ? shot.framesShot >= shot.frames : shot.takes > 0)) stage = 'shot';
        if (stage) source = 'shooting';
      }
      if (!stage && idea.productionStatus === 'draft') { stage = 'draft'; source = 'plan'; }
      if (!stage && ['shot', 'editing'].includes(idea.productionStatus)) { stage = idea.productionStatus; source = 'plan'; }
      if (!stage) { stage = scriptStage(idea, variants, wholePlan); source = 'script'; }
      return {...idea, stage, stageSource: source, publications: publications.map(({platform, status, url, publishedAt}) => ({platform, status, url, publishedAt}))};
    });
    return {...snapshot, company, plan: {...snapshot.plan, days,
      stageFacts: {stages: STAGE_IDS, shooting: Boolean(shooting), unpublished: false,
        note: shooting ? '' : 'Факты съёмки недоступны: этапы «Отснято»/«В монтаже» по загрузкам не учтены'}}};
  }
  return {apply};
}

/* Поля, которые сервер добавляет к идее при чтении. Клиент может прислать идею обратно целиком —
   при сохранении плана они отбрасываются и не считаются правкой. */
const COMPUTED_DAY_FIELDS = Object.freeze(['stage', 'stageSource', 'publications']);

module.exports = {createContentStages, shootingFacts, STAGE_IDS, FACTS_HEADER, COMPUTED_DAY_FIELDS};

'use strict';
/* Зафиксированный замер «до нашей работы». Исходные social_snapshots меняются при
   последующем сборе; baseline хранит собственную неизменяемую копию и историю версий. */
const { createHash } = require('node:crypto');
const { localDay, PLATFORMS } = require('./social-stats');

const MAX_DAYS = 90;
const MAX_POSTS = 500;
const MAX_SOURCES = 500;
const MAX_MEASUREMENTS = 10000;
const fail = (message) => { throw Object.assign(new Error(message), { code: 'VALIDATION_ERROR', status: 400 }); };
const date = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('Укажите дату в формате ГГГГ-ММ-ДД');
  const parsed = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) fail('Укажите существующую дату');
  return value;
};
const adjacentDay = (value, offset) => new Date(Date.parse(value + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
const safeNote = (value) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 300 || /[\u0000-\u001f\u007f]/.test(value)) fail('Укажите источник даты начала работы');
  return value.trim();
};
const source = (row) => ({ provider: row.provider || 'unknown', capturedAt: row.collected_at || null,
  runId: row.run_id ?? null, note: row.error?.startsWith('Источник: ') ? row.error.slice(10) : null });

function createSocialBaselines(db, stats, { now = () => Date.now() } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS social_baselines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_code TEXT NOT NULL COLLATE NOCASE,
    version INTEGER NOT NULL,
    cutover_date TEXT NOT NULL,
    period_from TEXT NOT NULL,
    period_to TEXT NOT NULL,
    source_note TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_by INTEGER,
    created_at TEXT NOT NULL,
    supersedes_id INTEGER REFERENCES social_baselines(id),
    UNIQUE(company_code,version));
    CREATE INDEX IF NOT EXISTS social_baselines_company ON social_baselines(company_code,version DESC);
    CREATE TRIGGER IF NOT EXISTS social_baselines_no_update BEFORE UPDATE ON social_baselines
      BEGIN SELECT RAISE(ABORT,'baseline is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS social_baselines_no_delete BEFORE DELETE ON social_baselines
      BEGIN SELECT RAISE(ABORT,'baseline is immutable'); END;`);

  const company = (code) => {
    const row = db.prepare('SELECT code,timezone FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get(code);
    if (!row) throw Object.assign(new Error('Компания не найдена'), { code: 'NOT_FOUND', status: 404 });
    return row;
  };
  const dto = (row) => row && ({ id: row.id, version: row.version, cutoverDate: row.cutover_date, from: row.period_from,
    to: row.period_to, sourceNote: row.source_note, createdAt: row.created_at, createdBy: row.created_by,
    supersedesId: row.supersedes_id, snapshot: JSON.parse(row.snapshot_json) });

  function get(code, version = null) {
    const scope = company(code);
    if (version !== null && (!Number.isSafeInteger(version) || version < 1)) fail('Неверная версия замера');
    const selected = version === null
      ? db.prepare('SELECT * FROM social_baselines WHERE company_code=? COLLATE NOCASE ORDER BY version DESC LIMIT 1').get(scope.code)
      : db.prepare('SELECT * FROM social_baselines WHERE company_code=? COLLATE NOCASE AND version=?').get(scope.code, version);
    if (version !== null && !selected) throw Object.assign(new Error('Замер не найден'), { code: 'NOT_FOUND', status: 404 });
    return { companyCode: scope.code.toLowerCase(), latest: dto(selected) || null,
      versions: db.prepare(`SELECT version,cutover_date,period_from,period_to,created_at,supersedes_id
        FROM social_baselines WHERE company_code=? COLLATE NOCASE ORDER BY version DESC`).all(scope.code).map((row) => ({ version: row.version, cutoverDate: row.cutover_date, from: row.period_from,
        to: row.period_to, createdAt: row.created_at, supersedesId: row.supersedes_id })) };
  }

  function buildSnapshot(scope, from, to) {
    const overview = stats.overview(scope.code, from, to);
    const periodDays = Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1;
    const platforms = {};
    for (const platform of Object.keys(PLATFORMS)) {
      const item = overview.platforms[platform], recordedDays = Object.keys(item.days || {}).length;
      // «Полное покрытие» тут означает только наличие хотя бы одного показателя на каждый день,
      // а не полноту всех метрик или публикаций площадки.
      const coverage = !item.configured ? 'account_not_configured' : !recordedDays ? 'no_data'
        : recordedDays === periodDays && item.dataStatus === 'complete' ? 'days_recorded' : 'partial';
      const raw = item.configured ? db.prepare(`SELECT s.date,s.period,s.metric,s.value,s.unit,s.kind,s.completeness,s.provider,s.collected_at,s.run_id,r.error
        FROM social_snapshots s LEFT JOIN social_collect_runs r ON r.id=s.run_id
        WHERE s.company_code=? COLLATE NOCASE AND s.platform=? AND s.account_ref=? AND
          ((s.period='day' AND s.date>=? AND s.date<=?) OR
           (s.period='lifetime' AND s.date=(SELECT MAX(t.date) FROM social_snapshots t
             WHERE t.company_code=s.company_code AND t.platform=s.platform AND t.account_ref=s.account_ref
               AND t.metric=s.metric AND t.period='lifetime' AND t.date<=?)))
        ORDER BY s.date,s.metric LIMIT ?`).all(scope.code, platform, item.accountRef || '', from, to, to, MAX_MEASUREMENTS + 1) : [];
      if (raw.length > MAX_MEASUREMENTS) fail('Слишком много исходных показателей: сократите период замера');
      const measurements = raw.map((row) => ({ date: row.date, period: row.period, metric: row.metric,
        value: row.value, unit: row.unit, kind: row.kind, completeness: row.completeness, ...source(row) }));
      const refs = [...new Map(raw.map((row) => {
        const evidence = source(row);
        return [`${evidence.provider}|${evidence.capturedAt}|${evidence.runId}`, evidence];
      })).values()];
      platforms[platform] = { accountRef: item.accountRef || null, accountConfigured: item.configured,
        accountProvider: item.provider, access: item.access?.status || 'unknown', coverage, recordedDays, periodDays,
        totals: item.configured ? item.totals : {}, latest: item.configured ? item.latest : {},
        aggregation: item.configured ? item.aggregation : {}, measurements,
        days: item.configured ? item.days : {}, sources: refs.slice(0, MAX_SOURCES), sourcesTruncated: refs.length > MAX_SOURCES };
    }

    // Посты без сохранённой даты выхода не считаются историческими публикациями.
    // Расширяем SQL-окно на день с каждой стороны из-за часовых поясов, затем проверяем локальную дату.
    const timezone = scope.timezone || 'Asia/Bangkok';
    const candidates = db.prepare(`SELECT p.*,r.error AS source_note FROM social_posts p LEFT JOIN social_collect_runs r ON r.id=p.source_run_id WHERE p.company_code=? COLLATE NOCASE
      AND p.published_at IS NOT NULL AND substr(p.published_at,1,10)>=? AND substr(p.published_at,1,10)<=?
      ORDER BY p.published_at DESC,p.id DESC`).all(scope.code, adjacentDay(from, -1), adjacentDay(to, 1));
    const observed = candidates.filter((post) => {
      const ms = Date.parse(post.published_at);
      return Number.isFinite(ms) && localDay(ms, timezone) >= from && localDay(ms, timezone) <= to;
    });
    const posts = observed.slice(0, MAX_POSTS).map((post) => {
      const metrics = db.prepare(`SELECT m.date,m.metric,m.value,m.unit,m.completeness,m.provider,m.collected_at,m.run_id,r.error
        FROM social_post_metrics m LEFT JOIN social_collect_runs r ON r.id=m.run_id
        WHERE m.post_id=? AND m.date>=? AND m.date<=? ORDER BY m.date DESC,m.metric`).all(post.id, from, to);
      return { platform: post.platform, platformPostId: post.platform_post_id, url: post.url || null,
        contentId: post.content_id || null, publishedAt: post.published_at, provider: post.provider,
        source: { provider: post.provider, capturedAt: post.source_collected_at || post.created_at, runId: post.source_run_id,
          note: post.source_note?.startsWith('Источник: ') ? post.source_note.slice(10) : null },
        // Эти записи не удостоверяют, что найдены ВСЕ публикации за период.
        metrics: metrics.map((metric) => ({ date: metric.date, metric: metric.metric, value: metric.value,
          unit: metric.unit, completeness: metric.completeness, ...source(metric) })) };
    });
    // Подтверждения владельца — доказательства выхода, а не собранные метрики. Они
    // сохраняются отдельно: одно подтверждение может относиться к уже собранному посту.
    const hasReceipts = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='autoposting_publication_receipts'").get())
      && Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='autoposting_posts'").get());
    const rawReceipts = hasReceipts ? db.prepare(`SELECT r.platform,r.url,r.published_at,r.recorded_at,r.note
      FROM autoposting_publication_receipts r JOIN autoposting_posts p ON p.id=r.post_id AND p.company_id=r.company_id
      JOIN companies c ON c.id=r.company_id WHERE c.code=? COLLATE NOCASE AND c.is_deleted=0
      AND substr(r.published_at,1,10)>=? AND substr(r.published_at,1,10)<=?
      ORDER BY r.published_at DESC,r.id DESC`).all(scope.code, adjacentDay(from, -1), adjacentDay(to, 1)) : [];
    const observedReceipts = rawReceipts.filter((receipt) => {
      const ms = Date.parse(receipt.published_at);
      return Number.isFinite(ms) && localDay(ms, timezone) >= from && localDay(ms, timezone) <= to;
    });
    const receipts = observedReceipts.slice(0, MAX_POSTS).map((receipt) => ({ platform: receipt.platform,
      url: receipt.url, publishedAt: receipt.published_at,
      source: { type: 'owner_confirmation', capturedAt: receipt.recorded_at, note: receipt.note || null }, metrics: null }));
    const anyData = Object.values(platforms).some((p) => p.recordedDays > 0 || Object.keys(p.latest).length > 0) || posts.length > 0 || receipts.length > 0;
    const socialAggregate = Object.fromEntries(['views','impressions','likes','comments','shares','saves'].map((metric) => {
      const values = Object.values(platforms).filter((item) => item.accountConfigured).map((item) => item.totals[metric]).filter((value) => typeof value === 'number');
      return [metric, values.length ? values.reduce((sum, value) => sum + value, 0) : null];
    }));
    socialAggregate.reach = null;
    socialAggregate.reachNote = 'Охват разных площадок не является числом уникальных людей и не суммируется.';
    return { timezone, status: anyData ? 'partial' : 'no_data', coverageNote: 'Зафиксированы только доступные на момент замера данные; записанные посты и подтверждения могут относиться к одному выходу, а их число не равно всем публикациям без полной выгрузки.',
      platforms, postsRecorded: observed.length, postsTruncated: observed.length > MAX_POSTS, posts,
      receiptsRecorded: observedReceipts.length, receiptsTruncated: observedReceipts.length > MAX_POSTS, receipts,
      socialAggregate };
  }

  function freeze(code, body, actor = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['cutoverDate','from','to','sourceNote','confirmedStart'].includes(key))) fail('Проверьте поля замера');
    const scope = company(code), cutoverDate = date(body.cutoverDate), from = date(body.from), to = date(body.to), sourceNote = safeNote(body.sourceNote);
    if (body.confirmedStart !== true) fail('Подтвердите дату начала работы');
    if (from > to || to >= cutoverDate) fail('Период «до» должен закончиться раньше начала работы');
    const periodDays = Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1;
    if (periodDays > MAX_DAYS) fail('Период замера не должен превышать 90 дней');
    const timezone = scope.timezone || 'Asia/Bangkok';
    if (to >= localDay(now(), timezone)) fail('Для замера «до» выберите завершённый день');
    db.exec('BEGIN IMMEDIATE');
    try {
      const snapshot = buildSnapshot(scope, from, to), serialized = JSON.stringify(snapshot);
      const hash = createHash('sha256').update(JSON.stringify({ cutoverDate, from, to, sourceNote, snapshot })).digest('hex');
      const previous = db.prepare('SELECT * FROM social_baselines WHERE company_code=? COLLATE NOCASE ORDER BY version DESC LIMIT 1').get(scope.code);
      if (previous?.content_hash === hash) { db.exec('COMMIT'); return { ...dto(previous), unchanged: true }; }
      const createdAt = new Date(now()).toISOString();
      const id = Number(db.prepare(`INSERT INTO social_baselines(company_code,version,cutover_date,period_from,period_to,source_note,snapshot_json,content_hash,created_by,created_at,supersedes_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(scope.code.toLowerCase(), (previous?.version || 0) + 1, cutoverDate, from, to, sourceNote,
          serialized, hash, Number.isSafeInteger(actor.userId) ? actor.userId : null, createdAt, previous?.id || null).lastInsertRowid);
      const saved = db.prepare('SELECT * FROM social_baselines WHERE id=?').get(id);
      db.exec('COMMIT');
      return { ...dto(saved), unchanged: false };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return { get, freeze };
}

module.exports = { createSocialBaselines };

'use strict';
/* Сквозная аналитика соцсетей ТайСабай: ежедневные снимки аккаунтов и публикаций по площадкам, единый адаптер провайдеров
   (Onlypult — временный источник, прямые API — по мере доступа), идемпотентные сборы, журнал запусков, атрибуция
   contentId → платформенный пост/URL → обращения (leads) → продажи. Правила честности: нет данных = null (UNKNOWN), не 0;
   сумма просмотров разных площадок — не уникальный охват; органика/реклама различаются полем kind; секреты не хранятся здесь. */
const { createHash } = require('node:crypto');
const PLATFORMS = Object.freeze({ instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', vk: 'ВКонтакте', telegram: 'Telegram' });
const PROVIDERS = Object.freeze(['onlypult', 'direct', 'manual']);
const KINDS = Object.freeze(['organic', 'paid', 'mixed', 'unknown']);
const PERIODS = Object.freeze(['day', 'lifetime']);
const COMPLETENESS = Object.freeze(['complete', 'partial', 'unknown']);
const RUN_STATUS = Object.freeze(['ok', 'partial', 'missing_access', 'unsupported', 'failed']);
/* Единый словарь метрик: ключ Synapse → единица. Исходное имя поля площадки хранится отдельно (source_field). */
const METRICS = Object.freeze({
  followers: 'count', follower_change: 'count', reach: 'people', impressions: 'views', views: 'views', profile_visits: 'count',
  likes: 'count', comments: 'count', shares: 'count', saves: 'count', clicks: 'count', link_clicks: 'count',
  watch_time_seconds: 'seconds', avg_watch_seconds: 'seconds', retention_percent: 'percent', posts_published: 'count',
});
/* Тип агрегации за период: sum — складывается по дням; avg — НЕВЗВЕШЕННОЕ среднее суточных значений (проценты и средние длительности
   складывать нельзя; это не общее удержание за период — просмотры разных дней не взвешиваются); latest — состояние на дату (подписчики). */
const AGGREGATION = Object.freeze({
  followers: 'latest', follower_change: 'sum', reach: 'sum', impressions: 'sum', views: 'sum', profile_visits: 'sum',
  likes: 'sum', comments: 'sum', shares: 'sum', saves: 'sum', clicks: 'sum', link_clicks: 'sum',
  watch_time_seconds: 'sum', avg_watch_seconds: 'avg', retention_percent: 'avg', posts_published: 'sum',
});
/* Метрики со знаком: отток подписчиков — законное отрицательное число, а не ошибка. */
const SIGNED = Object.freeze(new Set(['follower_change']));
/* Как часто обновляется незавершённый (текущий) день. */
const OPEN_DAY_REFRESH_MS = 60 * 60 * 1000;
const ERRORS = Object.freeze({
  VALIDATION_ERROR: 'Проверьте поля запроса аналитики соцсетей.',
  NOT_FOUND: 'Аккаунт или запись не найдены для выбранной компании.',
  REVISION_CONFLICT: 'Настройки аккаунтов изменились. Обновите данные перед сохранением.',
  FORBIDDEN: 'Недостаточно прав.',
});
const fail = (code = 'VALIDATION_ERROR', status = 400, extra = {}) => { throw Object.assign(new Error(ERRORS[code]), { code, status, ...extra }); };
const text = (value, max, required = false) => {
  if (value === undefined || value === null) { if (required) fail(); return ''; }
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail();
  const out = value.trim(); if (required && !out) fail(); return out;
};
const object = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(); for (const key of Object.keys(value)) if (!keys.includes(key)) fail('VALIDATION_ERROR', 400, { field: key }); };
const oneOf = (value, list, required = true) => { if (value === undefined || value === null || value === '') { if (required) fail(); return ''; } if (!list.includes(value)) fail(); return value; };
const day = (value) => { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + 'T00:00:00Z'))) fail(); return value; };
const timezone = (value) => { const tz = text(value, 80) || 'Asia/Bangkok'; try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { fail(); } return tz; };
/* Необратимый отпечаток ревизии подключения площадки: в журнал попадает только SHA256, а не сама ревизия/цель (и тем более не секрет).
   Пустая строка — подключения нет (провайдер без connectionRevision): такие запуски сравниваются между собой как прежде. */
const connectionFingerprint = (value) => (value === null || value === undefined ? ''
  : createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'));
const metricValue = (value, metric) => { if (value === null || value === undefined) return null; if (typeof value !== 'number' || !Number.isFinite(value) || (value < 0 && !SIGNED.has(metric))) fail(); return value; };
/* Локальный день площадки в часовом поясе компании (Asia/Bangkok по умолчанию). */
function localDay(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function localHour(ms, tz) { return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date(ms))); }
/* Смещение пояса (мс) в данный момент: местное время минус UTC. Учитывает летнее время на конкретную дату. */
function tzOffsetMs(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')) - Math.floor(ms / 1000) * 1000;
}
/* Реальные границы локального дня площадки: [startMs, endMs) в UTC для даты YYYY-MM-DD в поясе tz. */
function dayBounds(date, tz) {
  day(date);
  const bound = (iso) => { let guess = Date.parse(iso + 'Z'); for (let i = 0; i < 2; i += 1) guess = Date.parse(iso + 'Z') - tzOffsetMs(guess, tz); return guess; };
  const next = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  return { startMs: bound(date + 'T00:00:00'), endMs: bound(next + 'T00:00:00') };
}

function createSocialStats(db, { now = () => Date.now(), adapters = {}, logger = console } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_accounts (
      company_code TEXT NOT NULL COLLATE NOCASE, platform TEXT NOT NULL, account_ref TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT 'manual', provider_ref TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
      kind TEXT NOT NULL DEFAULT 'organic', timezone TEXT NOT NULL DEFAULT 'Asia/Bangkok', collect_hour INTEGER NOT NULL DEFAULT 6,
      revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, PRIMARY KEY(company_code, platform));
    CREATE TABLE IF NOT EXISTS social_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL COLLATE NOCASE, platform TEXT NOT NULL, account_ref TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL, period TEXT NOT NULL DEFAULT 'day', metric TEXT NOT NULL, value REAL, unit TEXT NOT NULL, source_field TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'unknown', completeness TEXT NOT NULL DEFAULT 'unknown', provider TEXT NOT NULL, timezone TEXT NOT NULL,
      collected_at TEXT NOT NULL, run_id INTEGER, UNIQUE(company_code, platform, account_ref, date, period, metric));
    CREATE INDEX IF NOT EXISTS social_snapshots_scope ON social_snapshots(company_code, platform, date);
    CREATE TABLE IF NOT EXISTS social_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL COLLATE NOCASE, platform TEXT NOT NULL, platform_post_id TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '', content_id TEXT NOT NULL DEFAULT '', published_at TEXT, provider TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'organic',
      created_at TEXT NOT NULL, UNIQUE(company_code, platform, platform_post_id));
    CREATE INDEX IF NOT EXISTS social_posts_content ON social_posts(company_code, content_id);
    CREATE TABLE IF NOT EXISTS social_post_metrics (
      post_id INTEGER NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE, date TEXT NOT NULL, metric TEXT NOT NULL, value REAL, unit TEXT NOT NULL,
      source_field TEXT NOT NULL DEFAULT '', completeness TEXT NOT NULL DEFAULT 'unknown', provider TEXT NOT NULL, collected_at TEXT NOT NULL, run_id INTEGER,
      PRIMARY KEY(post_id, date, metric));
    CREATE TABLE IF NOT EXISTS social_collect_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL COLLATE NOCASE, platform TEXT NOT NULL, provider TEXT NOT NULL, trigger TEXT NOT NULL,
      date TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL DEFAULT 'failed', rows INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '', missing TEXT NOT NULL DEFAULT '[]');
    CREATE INDEX IF NOT EXISTS social_collect_runs_scope ON social_collect_runs(company_code, platform, id);
  `);
  // closed=1 — сбор завершённого дня (итог), 0 — обновление текущего дня (partial). Колонка добавляется к уже созданной таблице.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('social_collect_runs') WHERE name='closed'").get()) db.exec('ALTER TABLE social_collect_runs ADD COLUMN closed INTEGER NOT NULL DEFAULT 1');
  // Запуск привязан к аккаунту и его ревизии: после смены account_ref/подключения старые запуски (в т.ч. missing_access) не блокируют новый сбор.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('social_collect_runs') WHERE name='account_ref'").get()) db.exec("ALTER TABLE social_collect_runs ADD COLUMN account_ref TEXT NOT NULL DEFAULT ''");
  if (!db.prepare("SELECT 1 FROM pragma_table_info('social_collect_runs') WHERE name='account_revision'").get()) db.exec('ALTER TABLE social_collect_runs ADD COLUMN account_revision INTEGER NOT NULL DEFAULT 0');
  // Ревизия самого подключения площадки (токен/цель) живёт вне social_accounts: храним её необратимый SHA256-отпечаток, чтобы после
  // пересохранения подключения прежний missing_access не подавлял сбор. Миграция безопасна: старые строки получают '' (отпечатка не было),
  // данные журнала не переписываются; у аккаунта с подключением первый сбор после миграции просто пройдёт заново.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('social_collect_runs') WHERE name='connection_fp'").get()) db.exec("ALTER TABLE social_collect_runs ADD COLUMN connection_fp TEXT NOT NULL DEFAULT ''");
  const stamp = (ms = now()) => new Date(ms).toISOString();
  // Ревизия подключения читается локально (без сети). Три исхода различаются явно: {ok:true,value:null} — подключения/метода нет,
  // {ok:true,value} — ревизия прочитана, {ok:false} — чтение сорвалось. Сбой чтения нельзя выдавать за «подключения нет»: два таких
  // сбоя до и после запроса дали бы одинаковый пустой отпечаток и пропустили бы в базу ответ от неизвестно какого подключения.
  const connectionRevision = (adapter, context) => {
    if (typeof adapter?.connectionRevision !== 'function') return { ok: true, value: null };
    try { return { ok: true, value: adapter.connectionRevision(context) ?? null }; }
    catch (error) { return { ok: false, code: error?.code || 'connection revision failed' }; }
  };
  const transact = (fn) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  function company(code) {
    if (typeof code !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code)) fail();
    const row = db.prepare('SELECT id,code,name,timezone FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get(code);
    if (!row) fail('NOT_FOUND', 404); return row;
  }
  const accountRow = (code, platform) => db.prepare('SELECT * FROM social_accounts WHERE company_code=? COLLATE NOCASE AND platform=?').get(code, platform);
  const accountDto = (row, platform) => ({ platform, label: PLATFORMS[platform], accountRef: row?.account_ref || '', displayLabel: row?.label || '', provider: row?.provider || 'manual',
    providerRef: row?.provider_ref || '', enabled: Boolean(row?.enabled), kind: row?.kind || 'organic', timezone: row?.timezone || 'Asia/Bangkok', collectHour: row?.collect_hour ?? 6,
    revision: row?.revision || 0, configured: Boolean(row), access: !row ? { status: 'not_configured', missing: ['аккаунт площадки не настроен в кабинете'] }
      : adapters[row.provider]?.describe?.(platform, row) || { status: 'unsupported', missing: ['адаптер не подключён'] } });
  function accounts(code) {
    const scope = company(code);
    return { companyCode: scope.code.toLowerCase(), timezone: 'Asia/Bangkok', accounts: Object.keys(PLATFORMS).map((p) => accountDto(accountRow(scope.code, p), p)),
      providers: Object.fromEntries(PROVIDERS.map((p) => [p, adapters[p]?.info?.() || { name: p, available: false }])) };
  }
  /* Настройки аккаунтов — только ссылки/идентификаторы, никаких ключей: доступ живёт в подключениях площадок (autoposting) или у провайдера. */
  function saveAccounts(code, body) {
    object(body, ['revision', 'accounts']);
    if (!Array.isArray(body.accounts) || body.accounts.length > 10) fail();
    const scope = company(code);
    return transact(() => {
      for (const item of body.accounts) {
        object(item, ['platform', 'accountRef', 'displayLabel', 'provider', 'providerRef', 'enabled', 'kind', 'timezone', 'collectHour', 'revision']);
        const platform = oneOf(item.platform, Object.keys(PLATFORMS)), current = accountRow(scope.code, platform);
        if ((current?.revision || 0) !== (item.revision ?? 0)) fail('REVISION_CONFLICT', 409);
        const ref = text(item.accountRef, 200), provider = oneOf(item.provider ?? 'manual', PROVIDERS), providerRef = text(item.providerRef, 200), label = text(item.displayLabel, 200);
        if (/(?:token|key|secret|password|bearer)/i.test(ref + providerRef)) fail();
        const kind = oneOf(item.kind ?? 'organic', KINDS), tz = timezone(item.timezone), hour = item.collectHour === undefined ? 6 : (Number.isInteger(item.collectHour) && item.collectHour >= 0 && item.collectHour <= 23 ? item.collectHour : fail());
        db.prepare(`INSERT INTO social_accounts(company_code,platform,account_ref,label,provider,provider_ref,enabled,kind,timezone,collect_hour,revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,?)
          ON CONFLICT(company_code,platform) DO UPDATE SET account_ref=excluded.account_ref,label=excluded.label,provider=excluded.provider,provider_ref=excluded.provider_ref,enabled=excluded.enabled,
          kind=excluded.kind,timezone=excluded.timezone,collect_hour=excluded.collect_hour,revision=social_accounts.revision+1,updated_at=excluded.updated_at`)
          .run(scope.code.toLowerCase(), platform, ref, label, provider, providerRef, item.enabled === false ? 0 : 1, kind, tz, hour, stamp());
      }
      return accounts(scope.code);
    });
  }
  /* Идемпотентная запись снимков: одинаковый ключ (компания, площадка, аккаунт, день, период, метрика) обновляется, не дублируется. */
  function writeSnapshots(code, platform, accountRef, rows, { provider, tz, runId = null, collectedAt = stamp() }) {
    const stmt = db.prepare(`INSERT INTO social_snapshots(company_code,platform,account_ref,date,period,metric,value,unit,source_field,kind,completeness,provider,timezone,collected_at,run_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(company_code,platform,account_ref,date,period,metric) DO UPDATE SET value=excluded.value,unit=excluded.unit,source_field=excluded.source_field,
      kind=excluded.kind,completeness=excluded.completeness,provider=excluded.provider,timezone=excluded.timezone,collected_at=excluded.collected_at,run_id=excluded.run_id`);
    let count = 0;
    for (const row of rows) {
      const metric = oneOf(row.metric, Object.keys(METRICS));
      stmt.run(code.toLowerCase(), platform, accountRef, day(row.date), oneOf(row.period ?? 'day', PERIODS), metric, metricValue(row.value, metric), METRICS[metric], text(row.sourceField, 100),
        oneOf(row.kind ?? 'unknown', KINDS), oneOf(row.completeness ?? 'unknown', COMPLETENESS), provider, tz, collectedAt, runId);
      count += 1;
    }
    return count;
  }
  function writePosts(code, platform, posts, { provider, runId = null, collectedAt = stamp() }) {
    let count = 0;
    for (const post of posts) {
      object(post, ['platformPostId', 'url', 'contentId', 'publishedAt', 'kind', 'metrics', 'date']);
      const pid = text(post.platformPostId, 200, true), url = text(post.url, 2000);
      if (url && !/^https:\/\//.test(url)) fail();
      db.prepare(`INSERT INTO social_posts(company_code,platform,platform_post_id,url,content_id,published_at,provider,kind,created_at) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(company_code,platform,platform_post_id) DO UPDATE SET url=CASE WHEN excluded.url<>'' THEN excluded.url ELSE social_posts.url END,
        content_id=CASE WHEN excluded.content_id<>'' THEN excluded.content_id ELSE social_posts.content_id END,published_at=COALESCE(excluded.published_at,social_posts.published_at),provider=excluded.provider`)
        .run(code.toLowerCase(), platform, pid, url, text(post.contentId, 200), post.publishedAt ? text(post.publishedAt, 40) : null, provider, oneOf(post.kind ?? 'organic', KINDS), collectedAt);
      const id = db.prepare('SELECT id FROM social_posts WHERE company_code=? COLLATE NOCASE AND platform=? AND platform_post_id=?').get(code, platform, pid).id;
      for (const m of post.metrics || []) {
        const metric = oneOf(m.metric, Object.keys(METRICS));
        db.prepare(`INSERT INTO social_post_metrics(post_id,date,metric,value,unit,source_field,completeness,provider,collected_at,run_id) VALUES(?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(post_id,date,metric) DO UPDATE SET value=excluded.value,unit=excluded.unit,source_field=excluded.source_field,completeness=excluded.completeness,provider=excluded.provider,collected_at=excluded.collected_at,run_id=excluded.run_id`)
          .run(id, day(m.date || post.date), metric, metricValue(m.value, metric), METRICS[metric], text(m.sourceField, 100), oneOf(m.completeness ?? 'unknown', COMPLETENESS), provider, collectedAt, runId);
        count += 1;
      }
    }
    return count;
  }
  /* Сбор по одному аккаунту: адаптер возвращает {status, snapshots, posts, missing, error}. Любой исход записывается в журнал запусков. */
  async function collect(code, platform, { trigger = 'manual', date = null } = {}) {
    const scope = company(code), row = accountRow(scope.code, oneOf(platform, Object.keys(PLATFORMS)));
    const tz = row?.timezone || 'Asia/Bangkok', today = localDay(now(), tz), target = date ? day(date) : today;
    if (target > today) fail();
    // Завершённый день даёт итог (complete); текущий день ещё идёт — его показатели только partial и обновляются позже.
    const closed = target < today;
    const provider = row?.provider || 'manual', adapter = adapters[provider];
    // Отпечаток сохранённого подключения площадки (ревизия токена/цели, без секрета) — до сетевого вызова и сразу в журнал:
    // по нему расписание отличает «та же неработающая связка» от «владелец пересохранил подключение».
    const connectionBefore = row ? connectionRevision(adapter, { company: scope, platform, account: row }) : { ok: true, value: null };
    // Отпечаток сорвавшегося чтения не вычисляется: такой запуск всё равно закончится failed и ничего не запишет.
    const connectionFp = connectionBefore.ok ? connectionFingerprint(connectionBefore.value) : '';
    const runId = Number(db.prepare(`INSERT INTO social_collect_runs(company_code,platform,provider,trigger,date,started_at,closed,account_ref,account_revision,connection_fp) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(scope.code.toLowerCase(), platform, provider, trigger, target, stamp(), closed ? 1 : 0, row?.account_ref || '', row?.revision || 0, connectionFp).lastInsertRowid);
    const finish = (status, extra = {}) => {
      db.prepare('UPDATE social_collect_runs SET finished_at=?,status=?,rows=?,error=?,missing=? WHERE id=?')
        .run(stamp(), oneOf(status, RUN_STATUS), extra.rows || 0, text(extra.error || '', 300), JSON.stringify(extra.missing || []), runId);
      return { runId, status, rows: extra.rows || 0, missing: extra.missing || [], error: extra.error || '', date: target, platform, provider, closed };
    };
    if (!row || !row.enabled) return finish('unsupported', { missing: ['аккаунт площадки не настроен или выключен в кабинете'] });
    if (!adapter?.collect) return finish('unsupported', { missing: [`провайдер ${provider} не умеет собирать статистику`] });
    // Ревизия подключения не прочиталась — сравнивать «до и после» не с чем: площадку не дёргаем и ни одной цифры не сохраняем.
    if (!connectionBefore.ok) {
      logger.warn?.(`[crm] social-stats ${platform}/${provider}: ${connectionBefore.code}`);
      return finish('failed', { error: 'Ревизия подключения площадки не прочитана: сбор остановлен до запроса к провайдеру' });
    }
    const bounds = dayBounds(target, tz);
    let result;
    try { result = await adapter.collect({ company: scope, platform, account: row, date: target, timezone: tz, closed, dayStartMs: bounds.startMs, dayEndMs: bounds.endMs }); }
    catch (error) { logger.warn?.(`[crm] social-stats ${platform}/${provider}: ${error?.code || 'collect failed'}`); return finish('failed', { error: 'Сбор не удался: провайдер не ответил или ответ не распознан' }); }
    // Пока ждали ответ, владелец мог сменить аккаунт аналитики или само подключение площадки (токен/цель): старый ответ к новому не относится.
    const fresh = accountRow(scope.code, platform);
    if (!fresh || fresh.revision !== row.revision || fresh.account_ref !== row.account_ref || fresh.provider !== row.provider || fresh.provider_ref !== row.provider_ref) {
      return finish('failed', { error: 'Настройки аккаунта изменились во время сбора: ответ отброшен, сбор повторится' });
    }
    const connectionAfter = connectionRevision(adapter, { company: scope, platform, account: fresh });
    if (!connectionAfter.ok) {
      logger.warn?.(`[crm] social-stats ${platform}/${provider}: ${connectionAfter.code}`);
      return finish('failed', { error: 'Ревизия подключения площадки не прочитана после ответа: ответ отброшен, сбор повторится' });
    }
    if (connectionFingerprint(connectionAfter.value) !== connectionFp) return finish('failed', { error: 'Подключение площадки изменилось во время сбора: ответ отброшен, сбор повторится' });
    if (!result || !RUN_STATUS.includes(result.status)) return finish('failed', { error: 'Адаптер вернул некорректный результат' });
    if (result.status === 'missing_access' || result.status === 'unsupported') return finish(result.status, { missing: result.missing || [] });
    // Незавершённый день никогда не помечается complete, что бы ни сказал адаптер. Lifetime-снимки (подписчики) — состояние на момент
    // снятия: датируются сегодняшним локальным днём, а не целевой датой, иначе сбор за вчера перепишет вчерашнюю историю сегодняшним числом.
    const snapshots = (result.snapshots || []).map((r) => ((r.period ?? 'day') === 'lifetime' ? { ...r, date: today, completeness: r.completeness ?? 'complete' }
      : !closed ? { ...r, completeness: 'partial' } : r));
    const rows = transact(() => writeSnapshots(scope.code, platform, row.account_ref, snapshots, { provider, tz, runId }) + writePosts(scope.code, platform, result.posts || [], { provider, runId }));
    const status = rows ? (closed ? result.status : (result.status === 'ok' ? 'partial' : result.status)) : 'partial';
    return finish(status, { rows, missing: result.missing || [], error: result.error || '' });
  }
  /* Ежедневный сбор. Итог — только за завершённый предыдущий локальный день: один раз после collect_hour (closed=1).
     Текущий день собирается как partial и обновляется не чаще раза в час, чтобы вечерняя активность не терялась; lifetime-снимки
     (подписчики) приходят с каждым сбором и хранятся отдельно по датам. Повторный вызов ничего не дублирует. */
  async function collectDue() {
    const due = db.prepare(`SELECT a.* FROM social_accounts a JOIN companies c ON c.code=a.company_code COLLATE NOCASE WHERE a.enabled=1 AND c.is_deleted=0 AND a.provider<>'manual'`).all();
    const results = [];
    // Только запуски этого же аккаунта, его ревизии и той же ревизии подключения площадки: после смены account_ref или пересохранения
    // подключения (токен/цель) прежний missing_access не блокирует новый сбор — иначе восстановленный доступ ждал бы до завтра.
    const lastRun = (row, fp, date, closed) => db.prepare(`SELECT status, started_at FROM social_collect_runs WHERE company_code=? COLLATE NOCASE AND platform=? AND date=? AND closed=? AND account_ref=? AND account_revision=? AND connection_fp=? ORDER BY id DESC LIMIT 1`)
      .get(row.company_code, row.platform, date, closed ? 1 : 0, row.account_ref || '', row.revision || 0, fp);
    for (const row of due) {
      // Сбой по одному аккаунту (нечитаемая ревизия подключения, испорченный пояс, отказ адаптера) не отменяет расписание остальных.
      try {
        const ms = now(), today = localDay(ms, row.timezone), yesterday = localDay(ms - 86400000, row.timezone);
        const scope = company(row.company_code);
        const revision = connectionRevision(adapters[row.provider], { company: scope, platform: row.platform, account: row });
        // Ревизия не прочитана — сравнивать запуски не с чем: идём в collect, он закончит запуск статусом failed и ничего не запишет.
        const fp = revision.ok ? connectionFingerprint(revision.value) : '';
        if (localHour(ms, row.timezone) >= row.collect_hour) {
          const done = lastRun(row, fp, yesterday, true);
          if (!done || !['ok', 'partial', 'missing_access', 'unsupported'].includes(done.status)) results.push(await collect(row.company_code, row.platform, { trigger: 'schedule', date: yesterday }));
        }
        const open = lastRun(row, fp, today, false);
        // Без доступа текущий день не дёргаем повторно: причина не изменится до вмешательства владельца, итог за день соберётся утром.
        if (open && ['missing_access', 'unsupported'].includes(open.status)) continue;
        if (!open || Date.parse(open.started_at) <= ms - OPEN_DAY_REFRESH_MS) results.push(await collect(row.company_code, row.platform, { trigger: 'schedule', date: today }));
      } catch (error) {
        logger.warn?.(`[crm] social-stats ${row.platform}/${row.provider}: ${error?.code || 'schedule failed'}`);
        results.push({ runId: null, status: 'failed', rows: 0, missing: [], error: 'Аккаунт пропущен в расписании: сбор не удалось начать', date: '', platform: row.platform, provider: row.provider, closed: null });
      }
    }
    return results;
  }
  /* Ручной импорт реальных чисел из кабинета площадки (снимок экрана/выгрузка): провайдер manual, обязательны момент снятия и пометка источника. Не заглушка: без чисел строки нет. */
  function importManual(code, body, actor = {}) {
    object(body, ['platform', 'capturedAt', 'sourceNote', 'kind', 'rows', 'posts']);
    const scope = company(code), platform = oneOf(body.platform, Object.keys(PLATFORMS)), row = accountRow(scope.code, platform);
    const capturedAt = text(body.capturedAt, 40, true), note = text(body.sourceNote, 300, true);
    if (Number.isNaN(Date.parse(capturedAt))) fail();
    const rows = Array.isArray(body.rows) ? body.rows : [], posts = Array.isArray(body.posts) ? body.posts : [];
    if (!rows.length && !posts.length) fail();
    if (rows.length > 500 || posts.length > 200) fail();
    for (const r of rows) { object(r, ['date', 'metric', 'value', 'period', 'sourceField', 'completeness', 'kind']); if (r.value === null || r.value === undefined) fail('VALIDATION_ERROR', 400, { field: 'value' }); }
    const tz = row?.timezone || 'Asia/Bangkok';
    return transact(() => {
      const runId = Number(db.prepare(`INSERT INTO social_collect_runs(company_code,platform,provider,trigger,date,started_at,finished_at,status,error) VALUES(?,?,'manual',?,?,?,?,'ok',?)`)
        .run(scope.code.toLowerCase(), platform, `manual:${actor.userName || actor.userId || 'owner'}`, rows[0]?.date ? day(rows[0].date) : localDay(now(), tz), stamp(), stamp(), `Источник: ${note}`).lastInsertRowid);
      const kind = oneOf(body.kind ?? 'organic', KINDS);
      const count = writeSnapshots(scope.code, platform, row?.account_ref || '', rows.map((r) => ({ ...r, kind: r.kind ?? kind, completeness: r.completeness ?? 'complete' })), { provider: 'manual', tz, runId, collectedAt: new Date(capturedAt).toISOString() })
        + writePosts(scope.code, platform, posts, { provider: 'manual', runId, collectedAt: new Date(capturedAt).toISOString() });
      db.prepare('UPDATE social_collect_runs SET rows=? WHERE id=?').run(count, runId);
      return { ok: true, runId, rows: count, platform, provider: 'manual' };
    });
  }
  /* Связь контента с обращениями и продажами через реальные события CRM. Каждое обращение засчитывается не более одного раза:
     1) URL поста в referrer/landing_page (точное совпадение или продолжение через ?, # или /) — однозначно посту;
     2) utm_content/utm_campaign = contentId — посту только если площадка однозначна: у contentId один пост, или площадка обращения
        (utm_source/source) совпадает ровно с одной площадкой поста; иначе — отдельная группа «по контенту» без размножения по постам. */
  const PLATFORM_ALIASES = Object.freeze({ instagram: ['instagram', 'ig', 'инстаграм'], tiktok: ['tiktok', 'тикток'], youtube: ['youtube', 'yt', 'ютуб'], vk: ['vk', 'vkontakte', 'вк', 'вконтакте'], telegram: ['telegram', 'tg', 'телеграм', 'телеграмм'] });
  const leadPlatform = (lead) => { const raw = String(lead.utm_source || lead.source || '').trim().toLowerCase(); if (!raw) return ''; return Object.keys(PLATFORM_ALIASES).find((p) => PLATFORM_ALIASES[p].includes(raw)) || ''; };
  const urlMatches = (value, url) => { if (!value || !url) return false; if (value === url) return true; if (!value.startsWith(url)) return false; const next = value.charAt(url.length), tail = url.endsWith('/'); return tail || next === '?' || next === '#' || next === '/'; };
  function attribution(code, from, to) {
    const scope = company(code); day(from); day(to);
    const posts = db.prepare('SELECT * FROM social_posts WHERE company_code=? COLLATE NOCASE ORDER BY published_at DESC, id DESC LIMIT 200').all(scope.code);
    const leads = db.prepare(`SELECT id, stage, sale_amount, source, utm_source, utm_content, utm_campaign, referrer, landing_page FROM leads WHERE company_code=? COLLATE NOCASE AND created_at>=? AND created_at<?
      AND (COALESCE(utm_content,'')<>'' OR COALESCE(utm_campaign,'')<>'' OR COALESCE(referrer,'')<>'' OR COALESCE(landing_page,'')<>'')`).all(scope.code, from + 'T00:00:00', to + 'T23:59:59.999');
    const byContent = new Map();
    for (const post of posts) if (post.content_id) { if (!byContent.has(post.content_id)) byContent.set(post.content_id, []); byContent.get(post.content_id).push(post); }
    const perPost = new Map(posts.map((p) => [p.id, { leads: [], confidence: new Set() }])), ambiguous = new Map();
    for (const lead of leads) {
      const byUrl = posts.filter((p) => p.url && (urlMatches(lead.referrer, p.url) || urlMatches(lead.landing_page, p.url)));
      if (byUrl.length === 1) { perPost.get(byUrl[0].id).leads.push(lead); perPost.get(byUrl[0].id).confidence.add('url'); continue; }
      const contentId = [lead.utm_content, lead.utm_campaign].map((v) => String(v || '').trim()).find((v) => v && byContent.has(v));
      if (!contentId && !byUrl.length) continue;
      const candidates = contentId ? byContent.get(contentId) : byUrl;
      const platform = leadPlatform(lead), scoped = platform ? candidates.filter((p) => p.platform === platform) : [];
      const pick = candidates.length === 1 ? candidates[0] : scoped.length === 1 ? scoped[0] : null;
      if (pick) { perPost.get(pick.id).leads.push(lead); perPost.get(pick.id).confidence.add(contentId ? 'utm' : 'url'); continue; }
      const key = contentId || byUrl[0].url;
      if (!ambiguous.has(key)) ambiguous.set(key, { contentId: contentId || '', url: contentId ? '' : key, platforms: Object.keys(PLATFORMS).filter((p) => candidates.some((c) => c.platform === p)), leads: [] });
      ambiguous.get(key).leads.push(lead);
    }
    const sum = (list) => ({ leads: list.length, sales: list.filter((l) => l.stage === 'продажа').length, revenue: list.filter((l) => l.stage === 'продажа').reduce((s, l) => s + (l.sale_amount || 0), 0) });
    const bySource = db.prepare(`SELECT source, COUNT(*) leads, SUM(CASE WHEN stage='продажа' THEN 1 ELSE 0 END) sales, SUM(CASE WHEN stage='продажа' THEN COALESCE(sale_amount,0) ELSE 0 END) revenue
      FROM leads WHERE company_code=? COLLATE NOCASE AND created_at>=? AND created_at<? GROUP BY source`).all(scope.code, from + 'T00:00:00', to + 'T23:59:59.999');
    return {
      posts: posts.map((post) => { const m = perPost.get(post.id); return { platform: post.platform, platformPostId: post.platform_post_id, url: post.url, contentId: post.content_id, publishedAt: post.published_at, ...sum(m.leads),
        attribution: m.leads.length ? 'exact' : (post.content_id || post.url ? 'none_in_period' : 'unknown'), confidence: m.confidence.has('url') ? 'url' : m.confidence.has('utm') ? 'utm' : 'none' }; }),
      byContent: [...ambiguous.values()].map((g) => ({ contentId: g.contentId, url: g.url, platforms: g.platforms, ...sum(g.leads), attribution: 'content_only',
        note: 'Метка указывает на контент, но не на конкретную площадку: обращение не приписано ни одному посту и не задвоено.' })),
      bySource: bySource.map((r) => ({ source: r.source || 'unknown', leads: r.leads, sales: r.sales, revenue: r.revenue })),
      note: 'Обращение засчитывается одному посту только по однозначной связи: URL поста в referrer/landing или метка contentId с однозначной площадкой (utm_source/source). Неоднозначные метки — отдельно, по контенту. Остальное — неизвестная атрибуция.',
    };
  }
  /* Сводка по дням и площадкам: агрегат соцсетей отдельно от CRM; null = данных нет; охваты площадок не складываются в «уникальных людей». */
  function overview(code, from, to) {
    const scope = company(code); day(from); day(to); if (from > to) fail();
    const rows = db.prepare(`SELECT platform, account_ref, date, metric, value, unit, kind, completeness, provider, collected_at FROM social_snapshots
      WHERE company_code=? COLLATE NOCASE AND period='day' AND date>=? AND date<=? ORDER BY platform, date, metric`).all(scope.code, from, to);
    const lifetime = db.prepare(`SELECT platform, account_ref, date, metric, value, provider, collected_at, kind FROM social_snapshots s WHERE company_code=? COLLATE NOCASE AND period='lifetime' AND date=(
      SELECT MAX(date) FROM social_snapshots WHERE company_code=s.company_code AND platform=s.platform AND account_ref=s.account_ref AND metric=s.metric AND period='lifetime' AND date<=?)`).all(scope.code, to);
    /* Агрегат по типу метрики: сумма — только для складываемых; проценты и средние — среднее по дням; состояние (подписчики) — не суммируется. */
    const aggregate = (list) => { const totals = {}; for (const metric of [...new Set(list.map((r) => r.metric))]) {
      const values = list.filter((r) => r.metric === metric && r.value !== null).map((r) => r.value);
      totals[metric] = !values.length ? null : AGGREGATION[metric] === 'sum' ? values.reduce((a, b) => a + b, 0) : AGGREGATION[metric] === 'avg' ? values.reduce((a, b) => a + b, 0) / values.length : null; } return totals; };
    const platforms = {};
    for (const p of Object.keys(PLATFORMS)) {
      const account = accountRow(scope.code, p), all = rows.filter((r) => r.platform === p), lifetimeAll = lifetime.filter((r) => r.platform === p);
      // Текущий аккаунт площадки и история прежних account_ref не смешиваются: сводка — по текущему, прежние — отдельной группой.
      const ref = account ? account.account_ref : null, mine = ref === null ? all : all.filter((r) => r.account_ref === ref), latest = ref === null ? lifetimeAll : lifetimeAll.filter((r) => r.account_ref === ref);
      const otherRefs = [...new Set(all.concat(lifetimeAll).map((r) => r.account_ref).filter((r) => ref !== null && r !== ref))];
      const lastRun = db.prepare('SELECT * FROM social_collect_runs WHERE company_code=? COLLATE NOCASE AND platform=? ORDER BY id DESC LIMIT 1').get(scope.code, p);
      const days = {};
      for (const r of mine) { days[r.date] ||= {}; days[r.date][r.metric] = { value: r.value, kind: r.kind, completeness: r.completeness, provider: r.provider }; }
      const totals = aggregate(mine);
      platforms[p] = { label: PLATFORMS[p], configured: Boolean(account), provider: account?.provider || null, enabled: Boolean(account?.enabled), accountRef: ref || '',
        access: accountDto(account, p).access, dataStatus: mine.length ? (mine.some((r) => r.completeness !== 'complete') ? 'partial' : 'complete') : 'no_data',
        lastCollectedAt: mine.reduce((m, r) => (r.collected_at > m ? r.collected_at : m), '') || null,
        lastRun: lastRun ? { status: lastRun.status, date: lastRun.date, closed: Boolean(lastRun.closed), finishedAt: lastRun.finished_at, error: lastRun.error, missing: JSON.parse(lastRun.missing || '[]'), provider: lastRun.provider } : null,
        totals, aggregation: Object.fromEntries(Object.keys(totals).map((m) => [m, AGGREGATION[m]])),
        latest: Object.fromEntries(latest.map((r) => [r.metric, { value: r.value, date: r.date, provider: r.provider }])),
        days, kinds: [...new Set(mine.map((r) => r.kind))],
        history: otherRefs.map((other) => ({ accountRef: other, totals: aggregate(all.filter((r) => r.account_ref === other)), days: [...new Set(all.filter((r) => r.account_ref === other).map((r) => r.date))].length })) };
    }
    const sumAcross = (metric) => { if (AGGREGATION[metric] !== 'sum') return null; const values = Object.values(platforms).map((p) => p.totals[metric]).filter((v) => typeof v === 'number'); return values.length ? values.reduce((a, b) => a + b, 0) : null; };
    return { companyCode: scope.code.toLowerCase(), from, to, timezone: 'Asia/Bangkok', platforms, aggregation: AGGREGATION,
      aggregationNote: 'avg — невзвешенное среднее суточных значений за период (каждый день с равным весом), а не общее удержание/средняя длительность за период.',
      socialAggregate: { views: sumAcross('views'), impressions: sumAcross('impressions'), likes: sumAcross('likes'), comments: sumAcross('comments'), shares: sumAcross('shares'), saves: sumAcross('saves'),
        reachNote: 'Охват площадок не суммируется: одни и те же люди могут быть на нескольких площадках. Уникальный охват — UNKNOWN.', reach: null },
      crm: attribution(scope.code, from, to), metrics: METRICS, runs: db.prepare('SELECT id,platform,provider,trigger,date,started_at,finished_at,status,rows,error,missing FROM social_collect_runs WHERE company_code=? COLLATE NOCASE ORDER BY id DESC LIMIT 30').all(scope.code)
        .map((r) => ({ ...r, missing: JSON.parse(r.missing || '[]') })) };
  }
  return { accounts, saveAccounts, collect, collectDue, importManual, overview, attribution, writeSnapshots, writePosts, localDay, dayBounds, PLATFORMS, METRICS, AGGREGATION };
}
module.exports = { createSocialStats, SOCIAL_STATS_ERRORS: ERRORS, PLATFORMS, METRICS, AGGREGATION, KINDS, localDay, dayBounds };

'use strict';
/* Сквозная аналитика соцсетей ТайСабай: ежедневные снимки аккаунтов и публикаций по площадкам, единый адаптер провайдеров
   (Onlypult — временный источник, прямые API — по мере доступа), идемпотентные сборы, журнал запусков, атрибуция
   contentId → платформенный пост/URL → обращения (leads) → продажи. Правила честности: нет данных = null (UNKNOWN), не 0;
   сумма просмотров разных площадок — не уникальный охват; органика/реклама различаются полем kind; секреты не хранятся здесь. */
const { createHash } = require('node:crypto');
const { receiptFormat } = require('./autoposting');
const PLATFORMS = Object.freeze({ instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', vk: 'ВКонтакте', telegram: 'Telegram' });
const { buildInsights, previousPeriod } = require('./social-insights');
const PROVIDERS = Object.freeze(['onlypult', 'direct', 'manual']);
const KINDS = Object.freeze(['organic', 'paid', 'mixed', 'unknown']);
/* Подсказка для выбора системы суток в кабинете. Это не ограничение: сохраняется любой
   пояс, который понимает Intl. Прежде пояс был жёстко Asia/Bangkok, и аккаунт в Иркутске
   считался чужими сутками. Историческим записям новый пояс задним числом не присваивается:
   он хранится в каждой строке снимка и входит в ключ. */
const TIMEZONE_CHOICES = Object.freeze(['Asia/Bangkok', 'Asia/Irkutsk', 'Asia/Krasnoyarsk', 'Asia/Novosibirsk',
  'Asia/Yekaterinburg', 'Europe/Moscow', 'Europe/Kaliningrad', 'Asia/Vladivostok', 'UTC']);
const PERIODS = Object.freeze(['day', 'lifetime']);
const COMPLETENESS = Object.freeze(['complete', 'partial', 'unknown']);
const RUN_STATUS = Object.freeze(['ok', 'partial', 'missing_access', 'unsupported', 'failed']);
/* Подтверждение внешней публикации (autoposting_publication_receipts) владелец записывает по площадкам автопостинга: там YouTube Shorts —
   отдельная площадка подписи, здесь это та же площадка аналитики youtube. Обратная карта нужна, чтобы разбирать адрес поста тем же
   форматом, каким подтверждение принималось при записи. */
const RECEIPT_TO_PLATFORM = Object.freeze({ instagram: 'instagram', tiktok: 'tiktok', youtube_shorts: 'youtube', vk: 'vk', telegram: 'telegram' });
const PLATFORM_TO_RECEIPT = Object.freeze(Object.fromEntries(Object.entries(RECEIPT_TO_PLATFORM).map(([receipt, platform]) => [platform, receipt])));
const RECEIPT_LIMIT = 200;
/* Канонический ключ записи площадки — только по разобранному формату адреса (тот же receiptFormat, что принимает подтверждение).
   Он объединяет разные написания одного и того же адреса: youtube watch?v=… и shorts/…, косая черта в конце, витрина страницы
   ВКонтакте с ?w=…. Неизвестный формат даёт пустой ключ: похожие адреса не склеиваются по догадке.
   Ключ — не идентификатор поста в API площадки: shortcode Instagram не равен media id Graph, номер сообщения Telegram — не id поста.
   Поэтому наружу он не выдаётся: у записи без собранного поста в DTO стоит собственная ссылка receipt:<id>. */
function canonicalPostKey(platform, value) {
  const receiptPlatform = PLATFORM_TO_RECEIPT[platform];
  const normalized = receiptPlatform ? receiptFormat(receiptPlatform, value) : null;
  if (!normalized) return '';
  const parsed = new URL(normalized), segments = parsed.pathname.split('/').filter(Boolean);
  switch (platform) {
    // Один и тот же shortcode площадка отдаёт и как /p/, и как /reel/, и под именем автора: адрес записи — сам shortcode (регистр значим).
    case 'instagram': return `instagram:${segments[segments.length - 1]}`;
    // Аккаунт сохраняется: номер ролика без автора адресом записи не является.
    case 'tiktok': return `tiktok:${segments[0].toLowerCase()}/${segments[segments.length - 1]}`;
    case 'youtube': return `youtube:${segments[0] === 'shorts' ? segments[1] : parsed.searchParams.get('v')}`;
    // Объект ВКонтакте (wall-1_2) уже несёт владельца записи; короткое имя страницы — витрина того же объекта.
    case 'vk': return `vk:${(parsed.searchParams.get('w') || segments[0]).toLowerCase()}`;
    // Канал сохраняется: номер сообщения уникален только внутри канала.
    case 'telegram': return `telegram:${segments.join('/').toLowerCase()}`;
    default: return '';
  }
}
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

/* evidence — журнал доказательств (ops/crm/social-analytics-evidence.js). Инъекцией, а не
   импортом: без него модуль работает как прежде, с ним каждое изменение проекции сопровождается
   неизменяемой записью о том, откуда взялось число. */
function createSocialStats(db, { now = () => Date.now(), adapters = {}, evidence = null, logger = console } = {}) {
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
      error TEXT NOT NULL DEFAULT '', missing TEXT NOT NULL DEFAULT '[]', source_note TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS social_collect_runs_scope ON social_collect_runs(company_code, platform, id);
  `);
  /* Семантика интервала и область в ключе проекции.

     Прежний UNIQUE(company_code,platform,account_ref,date,period,metric) не различал
     ни систему суток, ни область источника. Из-за этого «2026-09-21 в Asia/Irkutsk» и
     «2026-09-21 в Asia/Bangkok» — разные наблюдения разных интервалов — вытесняли друг
     друга, а показатель профиля и показатель публикаций могли столкнуться на одном ключе.
     Ключ расширяется до (…, timezone, scope). Таблица перестраивается транзакционно и
     только когда обнаружен старый ключ; данные переносятся как есть. */
  const snapshotsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='social_snapshots'").get()?.sql || '';
  if (snapshotsSql && !/timezone, ?scope\)/.test(snapshotsSql)) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const columns = new Set(db.prepare('PRAGMA table_info(social_snapshots)').all().map((r) => r.name));
      if (!columns.has('scope')) db.exec("ALTER TABLE social_snapshots ADD COLUMN scope TEXT NOT NULL DEFAULT 'profile'");
      db.exec(`CREATE TABLE social_snapshots_next (
        id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL COLLATE NOCASE, platform TEXT NOT NULL, account_ref TEXT NOT NULL DEFAULT '',
        date TEXT NOT NULL, period TEXT NOT NULL DEFAULT 'day', metric TEXT NOT NULL, value REAL, unit TEXT NOT NULL, source_field TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'unknown', completeness TEXT NOT NULL DEFAULT 'unknown', provider TEXT NOT NULL, timezone TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'profile', collected_at TEXT NOT NULL, run_id INTEGER,
        UNIQUE(company_code, platform, account_ref, date, period, metric, timezone, scope));
        INSERT INTO social_snapshots_next(id,company_code,platform,account_ref,date,period,metric,value,unit,source_field,kind,completeness,provider,timezone,scope,collected_at,run_id)
          SELECT id,company_code,platform,account_ref,date,period,metric,value,unit,source_field,kind,completeness,provider,timezone,COALESCE(scope,'profile'),collected_at,run_id FROM social_snapshots;
        DROP TABLE social_snapshots;
        ALTER TABLE social_snapshots_next RENAME TO social_snapshots;
        CREATE INDEX IF NOT EXISTS social_snapshots_scope ON social_snapshots(company_code, platform, date);`);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  /* Аренда сбора. Без неё ручная кнопка и таймер могут пойти за одними и теми же сутками
     одновременно и записать разный результат. Владелец аренды опознаётся токеном И поколением:
     проверки только ревизии доступа недостаточно — вернувшийся зависший сборщик имеет ту же
     ревизию, но чужое поколение, и права записывать уже не имеет. */
  db.exec(`CREATE TABLE IF NOT EXISTS social_collect_leases (
    company_code TEXT NOT NULL COLLATE NOCASE, platform TEXT NOT NULL, account_ref TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL, interval_key TEXT NOT NULL DEFAULT '',
    token TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1, binding_fp TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT '', acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    PRIMARY KEY(company_code, platform, account_ref, date, interval_key));
  /* Очередь повторов. Неполный день не должен забываться после полуночи, а закрытые сутки
     недавнего окна перепроверяются: источник может позднее исправить 20 на 25. */
  CREATE TABLE IF NOT EXISTS social_collect_queue (
    company_code TEXT NOT NULL COLLATE NOCASE, platform TEXT NOT NULL, account_ref TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL, last_status TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(company_code, platform, account_ref, date));`);
  // closed=1 — сбор завершённого дня (итог), 0 — обновление текущего дня (partial). Колонка добавляется к уже созданной таблице.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('social_collect_runs') WHERE name='closed'").get()) db.exec('ALTER TABLE social_collect_runs ADD COLUMN closed INTEGER NOT NULL DEFAULT 1');
  // Запуск привязан к аккаунту и его ревизии: после смены account_ref/подключения старые запуски (в т.ч. missing_access) не блокируют новый сбор.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('social_collect_runs') WHERE name='account_ref'").get()) db.exec("ALTER TABLE social_collect_runs ADD COLUMN account_ref TEXT NOT NULL DEFAULT ''");
  if (!db.prepare("SELECT 1 FROM pragma_table_info('social_collect_runs') WHERE name='account_revision'").get()) db.exec('ALTER TABLE social_collect_runs ADD COLUMN account_revision INTEGER NOT NULL DEFAULT 0');
  // Ревизия самого подключения площадки (токен/цель) живёт вне social_accounts: храним её необратимый SHA256-отпечаток, чтобы после
  // пересохранения подключения прежний missing_access не подавлял сбор. Миграция безопасна: старые строки получают '' (отпечатка не было),
  // данные журнала не переписываются; у аккаунта с подключением первый сбор после миграции просто пройдёт заново.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('social_collect_runs') WHERE name='connection_fp'").get()) db.exec("ALTER TABLE social_collect_runs ADD COLUMN connection_fp TEXT NOT NULL DEFAULT ''");
  // Источник самой исторической публикации нужен и тогда, когда её показатели не были доступны.
  /* Происхождение измерения — не ошибка. Раньше пометка источника ручного импорта писалась
     в error и показывалась в ЛК красным, хотя импорт завершался ok. Колонка отделяет одно от
     другого; старые строки не переписываются — их пометка читается из error по префиксу. */
  if (!db.prepare("SELECT 1 FROM pragma_table_info('social_collect_runs') WHERE name='source_note'").get()) db.exec("ALTER TABLE social_collect_runs ADD COLUMN source_note TEXT NOT NULL DEFAULT ''");
  if (!db.prepare("SELECT 1 FROM pragma_table_info('social_posts') WHERE name='source_run_id'").get()) db.exec('ALTER TABLE social_posts ADD COLUMN source_run_id INTEGER');
  if (!db.prepare("SELECT 1 FROM pragma_table_info('social_posts') WHERE name='source_collected_at'").get()) db.exec('ALTER TABLE social_posts ADD COLUMN source_collected_at TEXT');
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
  /* Старые записи ручного импорта хранят пометку источника в error с этим префиксом. Их
     доказательства не переписываются: происхождение достаётся при чтении, а поле ошибки
     у успешного запуска остаётся пустым — красным оно показываться не должно. */
  const LEGACY_SOURCE_PREFIX = 'Источник: ';
  const runNote = (row) => {
    if (!row) return null;
    const legacy = row.status === 'ok' && typeof row.error === 'string' && row.error.startsWith(LEGACY_SOURCE_PREFIX);
    return { sourceNote: row.source_note || (legacy ? row.error.slice(LEGACY_SOURCE_PREFIX.length) : ''), error: legacy ? '' : (row.error || '') };
  };
  const accountDto = (row, platform) => ({ platform, label: PLATFORMS[platform], accountRef: row?.account_ref || '', displayLabel: row?.label || '', provider: row?.provider || 'manual',
    providerRef: row?.provider_ref || '', enabled: Boolean(row?.enabled), kind: row?.kind || 'organic', timezone: row?.timezone || 'Asia/Bangkok', collectHour: row?.collect_hour ?? 6,
    revision: row?.revision || 0,
    /* Строка без идентификатора аккаунта — это не настроенный источник. Прежде форма
       сохраняла все пять площадок разом и пустые строки выглядели «ручной ввод». */
    configured: Boolean(row && row.account_ref),
    access: !row ? { status: 'not_configured', missing: ['аккаунт площадки не настроен в кабинете'] }
      : !row.account_ref ? { status: 'not_configured', missing: ['идентификатор аккаунта площадки не указан'] }
      : adapters[row.provider]?.describe?.(platform, row) || { status: 'unsupported', missing: ['адаптер не подключён'] } });
  function accounts(code) {
    const scope = company(code);
    return { companyCode: scope.code.toLowerCase(), timezone: scope.timezone || 'Asia/Bangkok', timezones: TIMEZONE_CHOICES,
      accounts: Object.keys(PLATFORMS).map((p) => accountDto(accountRow(scope.code, p), p)),
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
        /* Форма шлёт все площадки сразу. Пустая нетронутая строка площадки, которой ещё нет
           в базе, записи не создаёт: иначе появляются «настроенные» источники без аккаунта.
           Существующие записи это не трогает — они правятся и очищаются как раньше. */
        if (!current && !ref && !providerRef && !label && item.enabled !== true) continue;
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
    const stmt = db.prepare(`INSERT INTO social_snapshots(company_code,platform,account_ref,date,period,metric,value,unit,source_field,kind,completeness,provider,timezone,scope,collected_at,run_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(company_code,platform,account_ref,date,period,metric,timezone,scope) DO UPDATE SET value=excluded.value,unit=excluded.unit,source_field=excluded.source_field,
      kind=excluded.kind,completeness=excluded.completeness,provider=excluded.provider,collected_at=excluded.collected_at,run_id=excluded.run_id
      WHERE excluded.collected_at>=social_snapshots.collected_at`);
    /* Ограждение по порядку наблюдения. Аренда держится по ключу ЗАДАНИЯ (целевая дата), а
       lifetime-снимок пишется по ФАКТИЧЕСКОМУ ключу (сегодняшний день): сбор за вчера и сбор
       за сегодня берут разные аренды и сталкиваются на одной строке. Задержавшийся ответ
       со старым временем наблюдения более свежее значение не перезаписывает. */
    let count = 0;
    for (const row of rows) {
      const metric = oneOf(row.metric, Object.keys(METRICS));
      /* Область источника в ключе: показатель профиля и показатель публикаций больше
         не сталкиваются на одном ключе и не вытесняют друг друга. */
      // Отброшенная по порядку наблюдения строка записью не считается: иначе запуск отчитался бы о работе, которой не было.
      count += stmt.run(code.toLowerCase(), platform, accountRef, day(row.date), oneOf(row.period ?? 'day', PERIODS), metric, metricValue(row.value, metric), METRICS[metric], text(row.sourceField, 100),
        oneOf(row.kind ?? 'unknown', KINDS), oneOf(row.completeness ?? 'unknown', COMPLETENESS), provider, tz, text(row.scope ?? 'profile', 60) || 'profile', collectedAt, runId).changes;
    }
    return count;
  }
  function writePosts(code, platform, posts, { provider, runId = null, collectedAt = stamp() }) {
    let count = 0;
    for (const post of posts) {
      object(post, ['platformPostId', 'url', 'contentId', 'publishedAt', 'kind', 'metrics', 'date']);
      const pid = text(post.platformPostId, 200, true), url = text(post.url, 2000);
      if (url && !/^https:\/\//.test(url)) fail();
      db.prepare(`INSERT INTO social_posts(company_code,platform,platform_post_id,url,content_id,published_at,provider,kind,created_at,source_run_id,source_collected_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(company_code,platform,platform_post_id) DO UPDATE SET url=CASE WHEN excluded.url<>'' THEN excluded.url ELSE social_posts.url END,
        content_id=CASE WHEN excluded.content_id<>'' THEN excluded.content_id ELSE social_posts.content_id END,published_at=COALESCE(excluded.published_at,social_posts.published_at),
        provider=excluded.provider,source_run_id=COALESCE(excluded.source_run_id,social_posts.source_run_id),source_collected_at=excluded.source_collected_at`)
        .run(code.toLowerCase(), platform, pid, url, text(post.contentId, 200), post.publishedAt ? text(post.publishedAt, 40) : null, provider, oneOf(post.kind ?? 'organic', KINDS), collectedAt, runId, collectedAt);
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
  const LEASE_MS = 10 * 60 * 1000, QUEUE_MAX_ATTEMPTS = 6, RECHECK_WINDOW_DAYS = 7;
  /* Аренда сбора с ограждением (fencing).

     Ключ аренды — компания, площадка, аккаунт, дата и семантика интервала: за одни и те же
     сутки одного аккаунта в одной системе суток работает ровно один сборщик.
     Владелец опознаётся парой token+generation. Поколение растёт при каждом перехвате
     истёкшей аренды, поэтому вернувшийся зависший сборщик отличим от нового даже при той же
     ревизии доступа — и записать уже ничего не может. */
  function acquireLease({ code, platform, accountRef, date, intervalKey, bindingFp, owner }) {
    const at = stamp(), expires = new Date(now() + LEASE_MS).toISOString();
    return transact(() => {
      const current = db.prepare(`SELECT * FROM social_collect_leases WHERE company_code=? COLLATE NOCASE AND platform=? AND account_ref=? AND date=? AND interval_key=?`)
        .get(code, platform, accountRef, date, intervalKey);
      if (current && current.expires_at > at) return { ok: false, reason: 'busy', holder: current.owner };
      const token = randomToken(), generation = (current?.generation || 0) + 1;
      db.prepare(`INSERT INTO social_collect_leases(company_code,platform,account_ref,date,interval_key,token,generation,binding_fp,owner,acquired_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(company_code,platform,account_ref,date,interval_key) DO UPDATE SET token=excluded.token,generation=excluded.generation,
          binding_fp=excluded.binding_fp,owner=excluded.owner,acquired_at=excluded.acquired_at,expires_at=excluded.expires_at`)
        .run(code, platform, accountRef, date, intervalKey, token, generation, bindingFp || '', String(owner || '').slice(0, 60), at, expires);
      return { ok: true, token, generation, expiresAt: expires };
    });
  }
  const leaseHeld = (lease) => {
    if (!lease?.ok) return null;
    const row = db.prepare(`SELECT * FROM social_collect_leases WHERE company_code=? COLLATE NOCASE AND platform=? AND account_ref=? AND date=? AND interval_key=?`)
      .get(lease.code, lease.platform, lease.accountRef, lease.date, lease.intervalKey);
    return row && row.token === lease.token && row.generation === lease.generation ? row : null;
  };
  // Освобождается только СВОЯ аренда: чужую (перехваченную после истечения) не трогаем.
  function releaseLease(lease) {
    if (!lease?.ok) return false;
    return db.prepare(`DELETE FROM social_collect_leases WHERE company_code=? COLLATE NOCASE AND platform=? AND account_ref=? AND date=? AND interval_key=? AND token=? AND generation=?`)
      .run(lease.code, lease.platform, lease.accountRef, lease.date, lease.intervalKey, lease.token, lease.generation).changes > 0;
  }
  const randomToken = () => require('node:crypto').randomBytes(16).toString('hex');

  /* Очередь повторов. partial и предупреждения источника ставят дату в очередь с нарастающей
     задержкой; закрытые сутки недавнего окна перепроверяются не чаще раза в день на дату.
     missing_access и unsupported в очередь не ставятся: причина не изменится сама. */
  function queueDate({ code, platform, accountRef, date, reason, status, delayMs }) {
    const at = stamp(), current = db.prepare(`SELECT attempts FROM social_collect_queue WHERE company_code=? COLLATE NOCASE AND platform=? AND account_ref=? AND date=?`)
      .get(code, platform, accountRef, date);
    const attempts = (current?.attempts || 0) + 1;
    if (attempts > QUEUE_MAX_ATTEMPTS) { dropQueued({ code, platform, accountRef, date }); return null; }
    const next = new Date(now() + (delayMs ?? Math.min(6 * 3600000, 15 * 60000 * 2 ** (attempts - 1)))).toISOString();
    db.prepare(`INSERT INTO social_collect_queue(company_code,platform,account_ref,date,reason,attempts,next_attempt_at,last_status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(company_code,platform,account_ref,date) DO UPDATE SET reason=excluded.reason,attempts=excluded.attempts,
        next_attempt_at=excluded.next_attempt_at,last_status=excluded.last_status,updated_at=excluded.updated_at`)
      .run(code, platform, accountRef, date, String(reason || '').slice(0, 200), attempts, next, String(status || '').slice(0, 20), at, at);
    return { attempts, nextAttemptAt: next };
  }
  const dropQueued = ({ code, platform, accountRef, date }) => db.prepare(
    `DELETE FROM social_collect_queue WHERE company_code=? COLLATE NOCASE AND platform=? AND account_ref=? AND date=?`)
    .run(code, platform, accountRef, date).changes > 0;
  const dueQueued = (row) => db.prepare(`SELECT date, reason, attempts FROM social_collect_queue
    WHERE company_code=? COLLATE NOCASE AND platform=? AND account_ref=? AND next_attempt_at<=? ORDER BY date LIMIT 3`)
    .all(row.company_code, row.platform, row.account_ref || '', stamp());
  const queuedDates = (code, platform, accountRef) => db.prepare(`SELECT date, reason, attempts, next_attempt_at nextAttemptAt, last_status lastStatus
    FROM social_collect_queue WHERE company_code=? COLLATE NOCASE AND platform=? AND account_ref=? ORDER BY date`).all(code, platform, accountRef || '');

  /* Перенос уже сохранённых измерений в неизменяемые доказательства. Делается до первого
     изменения проекций и идемпотентно: повтор не создаёт копий, исходные 136 и настоящий 0
     остаются со своими датами, временем снятия и происхождением. Ни accountRef, ни timezone
     не меняются, native ID и покрытие не выдумываются. */
  function migrateLegacyEvidence({ limit = 1000 } = {}) {
    if (!evidence?.record) return { migrated: 0, reused: 0, skipped: 'журнал доказательств не подключён' };
    /* Идемпотентность и продвижение вперёд. Прежний LIMIT без отбора каждый раз брал первые
       1000 строк: при 1001 измерении второй запуск давал migrated=0/reused=1000, а 1001-я
       строка не переносилась никогда. Теперь берутся только ещё не перенесённые — страница
       за страницей, пока не кончатся. Исходные данные при этом не переписываются. */
    const page = db.prepare(`SELECT s.* FROM social_snapshots s
      WHERE NOT EXISTS (SELECT 1 FROM social_analytics_evidence e
        WHERE e.company_code=s.company_code COLLATE NOCASE AND e.legacy_ref='social_snapshots:'||s.id)
      ORDER BY s.id LIMIT ?`);
    const rows = page.all(limit);
    const total = db.prepare('SELECT COUNT(*) n FROM social_snapshots').get().n;
    let migrated = 0, reused = 0;
    for (const row of rows) {
      const entry = {
        companyCode: row.company_code, provider: row.provider || 'manual', platform: row.platform,
        nativeAccountId: row.account_ref || '', runId: 'legacy-migration', kind: 'legacy',
        legacyRef: `social_snapshots:${row.id}`, source: 'unknown',
        synapseMetric: row.metric, scope: row.scope || 'profile', unit: row.unit || '',
        granularity: row.period || 'day', periodFrom: row.date, periodTo: row.date,
        timezone: row.timezone || null, notes: row.source_field || '',
        points: [{ date: row.date, value: row.value === null || row.value === undefined ? null : row.value }],
        summary: row.value === null || row.value === undefined ? null : row.value,
        completeness: ['complete', 'partial'].includes(row.completeness) ? row.completeness : 'unknown',
        reason: 'перенос прежнего измерения в доказательства',
        collectedAt: new Date(row.collected_at).toISOString(),
      };
      let result;
      try { result = evidence.record(entry); }
      catch (error) { logger.warn?.(`[crm] social-stats legacy evidence ${row.id}: ${error?.code || 'skip'}`); continue; }
      if (result.created) migrated += 1; else reused += 1;
    }
    const done = db.prepare(`SELECT COUNT(*) n FROM social_snapshots s
      WHERE EXISTS (SELECT 1 FROM social_analytics_evidence e
        WHERE e.company_code=s.company_code COLLATE NOCASE AND e.legacy_ref='social_snapshots:'||s.id)`).get().n;
    // remaining>0 — миграция не закончена: вызывающий повторяет, и каждый раз идёт вперёд.
    return { migrated, reused, remaining: Math.max(0, total - done), total };
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
    /* Аренда берётся до сетевого вызова: ручная кнопка и таймер не пойдут за одними сутками
       одновременно. Ключ включает семантику интервала — часовой пояс аккаунта. */
    const lease = { code: scope.code.toLowerCase(), platform, accountRef: row.account_ref || '', date: target, intervalKey: tz,
      ...acquireLease({ code: scope.code.toLowerCase(), platform, accountRef: row.account_ref || '', date: target, intervalKey: tz,
        bindingFp: connectionFp, owner: trigger }) };
    if (!lease.ok) return finish('partial', { missing: [`сбор за ${target} уже идёт (${lease.holder || 'другой запуск'}): повторный запуск не начат`] });
    // Ревизия подключения не прочиталась — сравнивать «до и после» не с чем: площадку не дёргаем и ни одной цифры не сохраняем.
    if (!connectionBefore.ok) {
      logger.warn?.(`[crm] social-stats ${platform}/${provider}: ${connectionBefore.code}`);
      return finish('failed', { error: 'Ревизия подключения площадки не прочитана: сбор остановлен до запроса к провайдеру' });
    }
    const bounds = dayBounds(target, tz);
    let result;
    /* Время наблюдения фиксируется ДО сетевого вызова и тянется до самой записи. Иначе
       порядок задавался моментом завершения запроса: задержавшийся сбор, начатый раньше,
       завершался позже и перезаписывал более свежий lifetime-снимок — ключ записи у них
       общий (сегодняшний день), а аренды разные, по целевым датам. */
    const observedAt = stamp();
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
      releaseLease(lease);
      return finish('failed', { error: 'Ревизия подключения площадки не прочитана после ответа: ответ отброшен, сбор повторится' });
    }
    if (connectionFingerprint(connectionAfter.value) !== connectionFp) { releaseLease(lease); return finish('failed', { error: 'Подключение площадки изменилось во время сбора: ответ отброшен, сбор повторится' }); }
    if (!result || !RUN_STATUS.includes(result.status)) { releaseLease(lease); return finish('failed', { error: 'Адаптер вернул некорректный результат' }); }
    if (result.status === 'missing_access' || result.status === 'unsupported') {
      releaseLease(lease);
      // Причина не изменится сама: такую дату в очередь повторов не ставим.
      dropQueued({ code: scope.code.toLowerCase(), platform, accountRef: row.account_ref || '', date: target });
      return finish(result.status, { missing: result.missing || [] });
    }
    // Незавершённый день никогда не помечается complete, что бы ни сказал адаптер. Lifetime-снимки (подписчики) — состояние на момент
    // снятия: датируются сегодняшним локальным днём, а не целевой датой, иначе сбор за вчера перепишет вчерашнюю историю сегодняшним числом.
    /* Lifetime-снимок текущего замера прямого API — состояние на момент снятия, он датируется
       сегодняшним локальным днём (прежнее поведение сохранено). Но если адаптер честно пометил
       точку как historical — это состояние источника на СВОЮ дату, и переименовывать её в
       сегодня нельзя: так историю подписчиков затирали сегодняшним числом. */
    const snapshots = (result.snapshots || []).map((r) => ((r.period ?? 'day') === 'lifetime' && r.historical !== true
      ? { ...r, date: today, completeness: r.completeness ?? 'complete' }
      : !closed && (r.period ?? 'day') !== 'lifetime' ? { ...r, completeness: 'partial' } : r));
    /* Фиксация одной транзакцией: владелец аренды, срок, ревизии и порядок результата
       проверяются ВНУТРИ неё, и только потом пишутся доказательство и проекция.
       Вернувшийся зависший сборщик сюда не пройдёт: его token/generation уже не владельцы. */
    let rows = 0, fenced = false;
    try {
      rows = transact(() => {
        const held = leaseHeld(lease);
        if (!held || held.expires_at <= stamp()) { fenced = true; return 0; }
        const latest = accountRow(scope.code, platform);
        if (!latest || latest.revision !== row.revision || latest.account_ref !== row.account_ref || (latest.timezone || 'Asia/Bangkok') !== tz) { fenced = true; return 0; }
        if (evidence?.recordRun && (result.provenance || snapshots.length)) {
          const pr = result.provenance || {};
          const byMetric = new Map();
          for (const item of snapshots) {
            const key = `${item.metric}|${item.scope || 'profile'}`;
            if (!byMetric.has(key)) byMetric.set(key, []);
            byMetric.get(key).push({ date: item.date, value: item.value === null || item.value === undefined ? null : item.value });
          }
          const entries = [...byMetric.entries()].map(([key, points]) => {
            const [metric, scopeName] = key.split('|');
            return { companyCode: scope.code.toLowerCase(), provider, providerRef: pr.providerRef || '', platform,
              nativeAccountId: pr.nativeAccountId || row.account_ref || '', runId: `run-${runId}`, kind: 'collector',
              endpoint: 'overview', synapseMetric: metric, scope: scopeName, source: 'unknown',
              unit: METRICS[metric] || '', granularity: 'day',
              periodFrom: pr.period?.from || target, periodTo: pr.period?.to || target, timezone: tz,
              catalogVersion: pr.catalogVersion || '', mappingVersion: pr.mappingVersion || '',
              coverage: pr.coverage ?? null, warnings: pr.warnings || [], points,
              summary: null, summaryReason: 'итог за период источником не подтверждён',
              completeness: closed ? (result.status === 'ok' && !(pr.warnings || []).length ? 'complete' : 'partial') : 'partial',
              structureConfirmed: Boolean(pr.period), reason: result.missing?.length ? String(result.missing[0]).slice(0, 300) : '',
              // Доказательство всегда добавляется, даже если проекция этот ответ не примет.
              collectedAt: observedAt };
          });
          /* Исходные блоки ответа — отдельные доказательства, не зависящие от проекции.
             Кандидатный график, итог источника и ряд из одних null тоже имели место и
             должны остаться в журнале: иначе «ответ был, следа нет». */
          const base = { companyCode: scope.code.toLowerCase(), provider, providerRef: pr.providerRef || '', platform,
            nativeAccountId: pr.nativeAccountId || row.account_ref || '', runId: `run-${runId}`, kind: 'collector',
            endpoint: 'overview', granularity: 'day', timezone: tz,
            periodFrom: pr.period?.from || target, periodTo: pr.period?.to || target,
            catalogVersion: pr.catalogVersion || '', mappingVersion: pr.mappingVersion || '',
            coverage: pr.coverage ?? null, warnings: pr.warnings || [],
            collectedAt: observedAt };
          for (const block of (pr.blocks || []).slice(0, 50)) {
            if (!block || typeof block.chart !== 'string') continue;
            const summary = typeof block.summary === 'number' && Number.isFinite(block.summary) ? block.summary : null;
            entries.push({ ...base, chart: String(block.chart).slice(0, 120),
              source: 'unknown', scope: 'raw', unit: typeof block.unit === 'string' ? block.unit.slice(0, 40) : '',
              points: (block.points || []).slice(0, 1000).map((point) => ({ date: point.date,
                value: point.value === null || point.value === undefined ? null : point.value,
                ...(point.reason ? { reason: String(point.reason).slice(0, 200) } : {}) })),
              summary, summaryReason: summary === null ? (block.summaryReason || 'источник не вернул итог за период') : '',
              // Исходный блок — это то, что пришло; полнота относится к проекции, не к нему.
              completeness: 'unknown', structureConfirmed: true,
              notes: pr.identityConfirmed ? 'принадлежность ответа подтверждена источником'
                : 'источник не назвал принадлежность ответа: подтверждена адресом запроса и списком профилей',
              reason: pr.projectable === false ? 'ответ в дневную проекцию не пошёл: исходный блок сохранён как есть' : '' });
          }
          if (entries.length) evidence.recordRun(entries);
        }
        return writeSnapshots(scope.code, platform, row.account_ref, snapshots, { provider, tz, runId, collectedAt: observedAt })
          + writePosts(scope.code, platform, result.posts || [], { provider, runId, collectedAt: observedAt });
      });
    } finally { releaseLease(lease); }
    if (fenced) return finish('failed', { error: 'Аренда сбора потеряна или привязка изменилась: результат отброшен, проекция не тронута' });
    const status = rows ? (closed ? result.status : (result.status === 'ok' ? 'partial' : result.status)) : 'partial';
    /* Неполный день не забывается после полуночи, а закрытые сутки недавнего окна
       перепроверяются: источник может позднее исправить значение. */
    const queueKey = { code: scope.code.toLowerCase(), platform, accountRef: row.account_ref || '', date: target };
    if (status === 'partial' || (result.missing || []).length) queueDate({ ...queueKey, reason: (result.missing || [])[0] || 'день неполный', status });
    else if (closed) dropQueued(queueKey);
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
        /* Даты, реально собранные в ЭТОМ проходе. Раньше очередь безусловно пропускала
           today и yesterday, а основная ветка считала вчерашний partial обработанным —
           и вчерашняя дата не перепроверялась никогда, сколько бы ни ждала в очереди. */
        const handled = new Set();
        if (localHour(ms, row.timezone) >= row.collect_hour) {
          const done = lastRun(row, fp, yesterday, true);
          if (!done || !['ok', 'partial', 'missing_access', 'unsupported'].includes(done.status)) {
            handled.add(yesterday);
            results.push(await collect(row.company_code, row.platform, { trigger: 'schedule', date: yesterday }));
          }
        }
        const open = lastRun(row, fp, today, false);
        // Без доступа текущий день не дёргаем повторно: причина не изменится до вмешательства владельца, итог за день соберётся утром.
        if (open && ['missing_access', 'unsupported'].includes(open.status)) continue;
        if (!open || Date.parse(open.started_at) <= ms - OPEN_DAY_REFRESH_MS) {
          handled.add(today);
          results.push(await collect(row.company_code, row.platform, { trigger: 'schedule', date: today }));
        }
        /* Очередь повторов: даты, оставшиеся неполными, и закрытые сутки недавнего окна.
           Каждая дата берётся не чаще, чем разрешает её next_attempt_at, повторы ограничены. */
        for (const item of dueQueued(row)) {
          /* Пропускается только то, что реально сделано этим проходом, и текущий день —
              у него своя частота обновления (OPEN_DAY_REFRESH_MS) и своя ветка выше.
              Вчерашняя дата больше не исключается безусловно: если она ждёт в очереди и
              её задержка истекла, повтор делается. */
          if (handled.has(item.date) || item.date === today) continue;
          results.push(await collect(row.company_code, row.platform, { trigger: 'retry', date: item.date }));
        }
        /* Закрытые сутки недавнего окна перепроверяются даже после ok без предупреждений —
           но только у источников, которые сами объявили, что задним числом правят историю
           (revisesHistory). Прямые подключения площадок так не делают, и навязывать им
           лишний суточный опрос нельзя. */
        if (adapters[row.provider]?.revisesHistory === true) for (let back = 2; back <= RECHECK_WINDOW_DAYS; back += 1) {
          const date = localDay(ms - back * 86400000, row.timezone);
          const last = lastRun(row, fp, date, true);
          if (!last || ['missing_access', 'unsupported'].includes(last.status)) continue;
          if (Date.parse(last.started_at) > ms - 86400000) continue;
          results.push(await collect(row.company_code, row.platform, { trigger: 'recheck', date }));
          break;
        }
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
      const runId = Number(db.prepare(`INSERT INTO social_collect_runs(company_code,platform,provider,trigger,date,started_at,finished_at,status,error,source_note) VALUES(?,?,'manual',?,?,?,?,'ok','',?)`)
        .run(scope.code.toLowerCase(), platform, `manual:${actor.userName || actor.userId || 'owner'}`, rows[0]?.date ? day(rows[0].date) : localDay(now(), tz), stamp(), stamp(), note).lastInsertRowid);
      const kind = oneOf(body.kind ?? 'organic', KINDS);
      /* Доказательство пишется ДО проекции и той же транзакцией. Проекция идемпотентна:
         второй импорт за ту же дату перезаписывает строку, и без этой записи от первого
         наблюдения не осталось бы следа — было «20 и ноль доказательств». Журнал
         добавляемый, поэтому оба фактических наблюдения сохраняются отдельно. */
      if (evidence?.recordRun) {
        const observedAt = new Date(capturedAt).toISOString();
        const entries = rows.map((r) => ({
          companyCode: scope.code.toLowerCase(), provider: 'manual', platform,
          nativeAccountId: row?.account_ref || '', runId: `run-${runId}`, kind: 'manual',
          endpoint: 'manual', synapseMetric: oneOf(r.metric, Object.keys(METRICS)),
          scope: text(r.scope ?? 'profile', 60) || 'profile', source: 'unknown',
          unit: METRICS[r.metric] || '', granularity: oneOf(r.period ?? 'day', PERIODS),
          periodFrom: day(r.date), periodTo: day(r.date), timezone: tz,
          points: [{ date: day(r.date), value: r.value === null || r.value === undefined ? null : r.value }],
          summary: r.value === null || r.value === undefined ? null : r.value,
          summaryReason: '', notes: text(r.sourceField, 500),
          completeness: ['complete', 'partial'].includes(r.completeness) ? r.completeness : 'complete',
          structureConfirmed: true, reason: `ручной импорт владельца: ${note}`.slice(0, 300),
          collectedAt: observedAt,
        }));
        if (entries.length) { try { evidence.recordRun(entries); }
          catch (error) { logger.warn?.(`[crm] social-stats manual evidence: ${error?.code || 'skip'}`); } }
      }
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
  const hasTable = (name) => Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
  /* READ-ONLY проекция подтверждений внешних публикаций в атрибуцию. Подтверждение — доказательство владельца (ссылка и время выхода),
     а не сбор по API: здесь не создаётся ни постов, ни метрик, ни запусков сбора, и уже сохранённые social_posts не переписываются.
     Изоляция компании строгая: компания подтверждения берётся join companies.id = receipts.company_id и сверяется с кодом компании
     аналитики, а карточка обязана принадлежать той же компании. Пока таблиц автопостинга нет — проекции просто нет.
     contentId подтверждения — external_id карточки (идентификатор из пакета контент-плана, тот же, что владелец ставит в utm_content);
     у карточки, заведённой руками, его нет, и он не выдумывается. */
  /* Сколько подтверждений у компании всего — та же защита по компании и is_deleted, что и при чтении строк. */
  function receiptTotal(scope) {
    if (!hasTable('autoposting_publication_receipts') || !hasTable('autoposting_posts')) return 0;
    return db.prepare(`SELECT COUNT(*) n FROM autoposting_publication_receipts r
      JOIN autoposting_posts p ON p.id=r.post_id AND p.company_id=r.company_id
      JOIN companies c ON c.id=r.company_id WHERE c.code=? COLLATE NOCASE AND c.is_deleted=0`).get(scope.code).n;
  }
  function receiptRows(scope) {
    if (!hasTable('autoposting_publication_receipts') || !hasTable('autoposting_posts')) return [];
    const content = db.prepare("SELECT 1 FROM pragma_table_info('autoposting_posts') WHERE name='external_id'").get() ? 'p.external_id' : "''";
    return db.prepare(`SELECT r.id, r.platform, r.url, r.published_at, r.post_id, ${content} content_id FROM autoposting_publication_receipts r
      JOIN autoposting_posts p ON p.id=r.post_id AND p.company_id=r.company_id
      JOIN companies c ON c.id=r.company_id WHERE c.code=? COLLATE NOCASE AND c.is_deleted=0
      ORDER BY r.published_at DESC, r.id DESC LIMIT ${RECEIPT_LIMIT}`).all(scope.code);
  }
  /* Собранные посты и подтверждения сводятся в один список записей выхода. Запись — это один канонический адрес площадки, а не строка
     базы: если две строки social_posts (разные platform_post_id — например, тот же ролик пришёл от провайдера и был внесён вручную)
     разбираются в один и тот же канонический адрес, в отчёте это один выход с несколькими источниками, иначе обращение по этому адресу
     оказалось бы неоднозначным между двумя записями и не засчиталось бы никому. Подтверждение прикладывается к собранному посту по тому
     же строгому совпадению адреса: остаются настоящие platform_post_id и provider собранного поста, а адрес подтверждения добавляется
     к списку адресов для сопоставления обращений — чтобы один и тот же выход не считался дважды.
     Объединение живёт только в этой проекции: social_posts не переписываются и не удаляются. Адрес, который разбор площадки не понял,
     ключа не даёт и ни с чем не объединяется. */
  function attributionPosts(scope) {
    const stored = db.prepare('SELECT * FROM social_posts WHERE company_code=? COLLATE NOCASE ORDER BY published_at DESC, id DESC LIMIT 200').all(scope.code);
    // Копии строк базы: дальше список правится (адреса, contentId подтверждений), а social_posts остаются нетронутыми.
    const posts = [], byKey = new Map();
    for (const p of stored) {
      const key = canonicalPostKey(p.platform, p.url), same = key ? byKey.get(key) : null;
      const identity = { platformPostId: p.platform_post_id, provider: p.provider, contentId: p.content_id || '' };
      // Служебная привязка к строке базы нужна только чтению показателей и в публичный DTO атрибуции не попадает.
      const sourceRow = { postId: p.id, referenceId: `post:${p.id}`, platformPostId: p.platform_post_id, provider: p.provider, contentId: p.content_id || '' };
      if (same) {
        // Тот же канонический адрес, другая строка базы: один выход, несколько источников. Первая строка (свежая по дате, затем по id)
        // задаёт адрес и ссылку записи; её contentId не объявляется общим — расхождение карточек разбирается ниже списком кандидатов.
        same.identities.push(identity);
        same.sourceRows.push(sourceRow);
        if (p.url && !same.urls.includes(p.url)) same.urls.push(p.url);
        if (p.content_id) same.storedContentIds.add(p.content_id);
        if (!same.publishedAt && p.published_at) same.publishedAt = p.published_at;
        continue;
      }
      const post = { key: `post:${p.id}`, platform: p.platform, platformPostId: p.platform_post_id, url: p.url, urls: p.url ? [p.url] : [],
        identities: [identity], sourceRows: [sourceRow], storedContentIds: new Set(p.content_id ? [p.content_id] : []), contentId: p.content_id,
        publishedAt: p.published_at, provenance: 'stored', receipts: [], receiptContentIds: new Set() };
      posts.push(post);
      if (key) byKey.set(key, post);
    }
    let projected = 0, merged = 0, skipped = 0;
    for (const receipt of receiptRows(scope)) {
      const platform = RECEIPT_TO_PLATFORM[receipt.platform];
      // Площадка подтверждения, которой нет в аналитике, не пропадает молча: её видно счётчиком skipped.
      if (!platform) { skipped += 1; continue; }
      projected += 1;
      // Ключ несёт площадку, поэтому подтверждение не приклеится к посту другой площадки. Неразобранный адрес (формат площадки сменился
      // после записи) ключа не даёт: такая запись живёт отдельной строкой и ни с чем не объединяется.
      const key = canonicalPostKey(platform, receipt.url);
      let post = key ? byKey.get(key) : null;
      // merged считает только подтверждения, легшие на собранный пост: второе написание того же адреса подтверждения — не объединение.
      if (post) { if (post.provenance !== 'external_receipt') { post.provenance = 'stored_with_receipt'; merged += 1; } }
      else {
        post = { key: `receipt:${receipt.id}`, platform, platformPostId: `receipt:${receipt.id}`, url: receipt.url, urls: [],
          identities: [], sourceRows: [], storedContentIds: new Set(), contentId: '', publishedAt: receipt.published_at, provenance: 'external_receipt', receipts: [], receiptContentIds: new Set() };
        posts.push(post);
        if (key) byKey.set(key, post);
      }
      post.receipts.push({ referenceId: `receipt:${receipt.id}`, url: receipt.url, publishedAt: receipt.published_at, contentId: receipt.content_id || '' });
      if (!post.urls.includes(receipt.url)) post.urls.push(receipt.url);
      if (receipt.content_id) post.receiptContentIds.add(receipt.content_id);
    }
    for (const post of posts) {
      const ids = [...post.receiptContentIds], storedIds = [...post.storedContentIds];
      // Провайдер записи — настоящий провайдер её источника, а не догадка: один источник — его провайдер; несколько источников с разными
      // провайдерами одним не называются, а у записи без собранного поста провайдера сбора нет вовсе. В обоих случаях null, не выдумка.
      const providers = [...new Set(post.identities.map((i) => i.provider))];
      post.provider = providers.length === 1 ? providers[0] : null;
      post.sources = post.identities.length;
      // Два собранных поста одного канонического адреса с разными карточками — расхождение настоящих contentId: общего у записи нет.
      post.contentId = storedIds.length === 1 ? storedIds[0] : '';
      // Один адрес подтверждён на разных карточках (или карточка спорит с собранным постом): выбрать contentId наугад нельзя.
      // Кандидаты — все настоящие карточки записи, и от источников, и от подтверждений: список честно показывает сам спор,
      // а не только его вторую сторону. Непустой список означает спорную запись: метка utm по ней никому не приписывается.
      const all = [...new Set([...storedIds, ...ids])].sort();
      post.contentIdCandidates = all.length > 1 ? all : [];
      if (!post.contentId && !storedIds.length && ids.length === 1) post.contentId = ids[0];
    }
    // Порядок общий и устойчивый: свежие выходы сверху, записи без даты — в конце; при равной дате сохраняется порядок выборки.
    posts.sort((a, b) => { const x = a.publishedAt || '', y = b.publishedAt || ''; return x === y ? 0 : x > y ? -1 : 1; });
    return { posts, projected, merged, skipped, receiptOnly: posts.filter((p) => p.provenance === 'external_receipt').length };
  }
  function attribution(code, from, to) {
    const scope = company(code); day(from); day(to);
    const projection = attributionPosts(scope), posts = projection.posts;
    const leads = db.prepare(`SELECT id, stage, sale_amount, source, utm_source, utm_content, utm_campaign, referrer, landing_page FROM leads WHERE company_code=? COLLATE NOCASE AND created_at>=? AND created_at<?
      AND (COALESCE(utm_content,'')<>'' OR COALESCE(utm_campaign,'')<>'' OR COALESCE(referrer,'')<>'' OR COALESCE(landing_page,'')<>'')`).all(scope.code, from + 'T00:00:00', to + 'T23:59:59.999');
    const byContent = new Map();
    // По метке ищутся только записи с бесспорной карточкой. У спорной записи (contentIdCandidates непуст) настоящий contentId
    // сохранён в отчёте для диагностики, но меткой не пользуется: к какой из расходящихся карточек относится обращение — неизвестно.
    for (const post of posts) if (post.contentId && !post.contentIdCandidates.length) { if (!byContent.has(post.contentId)) byContent.set(post.contentId, []); byContent.get(post.contentId).push(post); }
    const perPost = new Map(posts.map((p) => [p.key, { leads: [], confidence: new Set() }])), ambiguous = new Map();
    for (const lead of leads) {
      const byUrl = posts.filter((p) => p.urls.some((u) => urlMatches(lead.referrer, u) || urlMatches(lead.landing_page, u)));
      if (byUrl.length === 1) { perPost.get(byUrl[0].key).leads.push(lead); perPost.get(byUrl[0].key).confidence.add('url'); continue; }
      const contentId = [lead.utm_content, lead.utm_campaign].map((v) => String(v || '').trim()).find((v) => v && byContent.has(v));
      if (!contentId && !byUrl.length) continue;
      const candidates = contentId ? byContent.get(contentId) : byUrl;
      const platform = leadPlatform(lead), scoped = platform ? candidates.filter((p) => p.platform === platform) : [];
      const pick = candidates.length === 1 ? candidates[0] : scoped.length === 1 ? scoped[0] : null;
      if (pick) { perPost.get(pick.key).leads.push(lead); perPost.get(pick.key).confidence.add(contentId ? 'utm' : 'url'); continue; }
      const key = contentId || byUrl[0].url;
      if (!ambiguous.has(key)) ambiguous.set(key, { contentId: contentId || '', url: contentId ? '' : key, platforms: Object.keys(PLATFORMS).filter((p) => candidates.some((c) => c.platform === p)), leads: [] });
      ambiguous.get(key).leads.push(lead);
    }
    const sum = (list) => ({ leads: list.length, sales: list.filter((l) => l.stage === 'продажа').length, revenue: list.filter((l) => l.stage === 'продажа').reduce((s, l) => s + (l.sale_amount || 0), 0) });
    const bySource = db.prepare(`SELECT source, COUNT(*) leads, SUM(CASE WHEN stage='продажа' THEN 1 ELSE 0 END) sales, SUM(CASE WHEN stage='продажа' THEN COALESCE(sale_amount,0) ELSE 0 END) revenue
      FROM leads WHERE company_code=? COLLATE NOCASE AND created_at>=? AND created_at<? GROUP BY source`).all(scope.code, from + 'T00:00:00', to + 'T23:59:59.999');
    return {
      posts: posts.map((post) => { const m = perPost.get(post.key); return { platform: post.platform, platformPostId: post.platformPostId, url: post.url, contentId: post.contentId, publishedAt: post.publishedAt, ...sum(m.leads),
        attribution: m.leads.length ? 'exact' : (post.contentId || post.url ? 'none_in_period' : 'unknown'), confidence: m.confidence.has('url') ? 'url' : m.confidence.has('utm') ? 'utm' : 'none',
        provenance: post.provenance, provider: post.provider, sources: post.sources, identities: post.identities, receipts: post.receipts, contentIdCandidates: post.contentIdCandidates }; }),
      byContent: [...ambiguous.values()].map((g) => ({ contentId: g.contentId, url: g.url, platforms: g.platforms, ...sum(g.leads), attribution: 'content_only',
        note: 'Метка указывает на контент, но не на конкретную площадку: обращение не приписано ни одному посту и не задвоено.' })),
      bySource: bySource.map((r) => ({ source: r.source || 'unknown', leads: r.leads, sales: r.sales, revenue: r.revenue })),
      receipts: { projected: projection.projected, merged: projection.merged, receiptOnly: projection.receiptOnly, skipped: projection.skipped,
        note: 'Подтверждение внешней публикации — ссылка и время выхода, зафиксированные владельцем, а не сбор по API: показателей площадки у такой записи нет, идентификатор поста в API по ссылке не выдумывается (в отчёте стоит собственная ссылка receipt:<id>). Подтверждение объединяется с собранным постом только при строгом совпадении разобранного адреса площадки.' },
      note: 'Обращение засчитывается одному посту только по однозначной связи: URL поста в referrer/landing или метка contentId с однозначной площадкой (utm_source/source). Неоднозначные метки — отдельно, по контенту. Остальное — неизвестная атрибуция.',
    };
  }
  /* Сводка по дням и площадкам: агрегат соцсетей отдельно от CRM; null = данных нет; охваты площадок не складываются в «уникальных людей». */
  /* Показатели публикаций из сохранённых social_post_metrics. Только чтение: в соцсети не обращаемся,
     сбор не включаем, чисел не выдумываем.
     У метрики поста нет признака периода (день это или накопительный итог), поэтому даты НЕ суммируются
     и прирост по ним не считается. Показывается последнее измерение каждой метрики каждой исходной записи
     внутри выбранного интервала. null — данных нет, настоящий 0 сохраняется и от null отличается.
     Один канонический адрес может объединять несколько строк social_posts: их измерения остаются раздельными,
     молча один источник не выбирается и значения не складываются. */
  function postMetrics(code, from, to) {
    const scope = company(code); day(from); day(to); if (from > to) fail();
    const projection = attributionPosts(scope);
    const storedTotal = db.prepare('SELECT COUNT(*) n FROM social_posts WHERE company_code=? COLLATE NOCASE').get(scope.code).n;
    const read = db.prepare(`SELECT date, metric, value, unit, source_field, completeness, provider, collected_at, run_id
      FROM social_post_metrics WHERE post_id=? AND date>=? AND date<=? ORDER BY date, metric`);
    const dates = new Set();
    let measurementsRead = 0, sourcesWithMetrics = 0, knownValues = 0, latestKnownValues = 0, sourcesWithKnownValues = 0;
    const posts = projection.posts.map((post) => {
      const sources = post.sourceRows.map((source) => {
        const rows = read.all(source.postId, from, to);
        measurementsRead += rows.length;
        // Последнее измерение каждой метрики ВНУТРИ интервала: за его границы не выходим и «последнее вообще» не подставляем.
        const latest = new Map();
        // Известное значение считается по всем прочитанным строкам периода, а не по последним:
        // если вчера значение было, а сегодня null, история известного не исчезает, но последним остаётся null.
        let knownRows = 0;
        for (const row of rows) { dates.add(row.date); latest.set(row.metric, row); if (row.value !== null && row.value !== undefined) knownRows += 1; }
        if (rows.length) sourcesWithMetrics += 1;
        const measurements = [...latest.values()].map((row) => ({ metric: row.metric,
          date: row.date, value: row.value === null || row.value === undefined ? null : row.value, unit: row.unit,
          hasValue: !(row.value === null || row.value === undefined),
          sourceField: row.source_field || '', completeness: row.completeness || 'unknown', provider: row.provider,
          collectedAt: row.collected_at, runId: row.run_id ?? null, referenceId: source.referenceId }))
          .sort((a, b) => a.metric.localeCompare(b.metric));
        // Строка измерения и известное значение — разное: строка с value=null данных не даёт.
        // knownValuesInPeriod — по всем строкам периода; latestKnownValues — сколько показанных последних измерений известны.
        const latestKnown = measurements.filter((m) => m.hasValue).length;
        knownValues += knownRows;
        latestKnownValues += latestKnown;
        if (knownRows) sourcesWithKnownValues += 1;
        return { referenceId: source.referenceId, platformPostId: source.platformPostId, provider: source.provider,
          contentId: source.contentId, measurementsInPeriod: rows.length, knownValuesInPeriod: knownRows,
          latestKnownValues: latestKnown, measurements };
      });
      return { key: post.key, platform: post.platform, platformLabel: PLATFORMS[post.platform] || post.platform,
        url: post.url, publishedAt: post.publishedAt, provenance: post.provenance, provider: post.provider,
        // Подтверждение владельца — ссылка и время, а не сбор по API: показателей площадки у него нет.
        receiptOnly: post.provenance === 'external_receipt', receipts: post.receipts.map((r) => r.referenceId),
        sources };
    });
    const dateList = [...dates].sort();
    const receiptsTotal = receiptTotal(scope);
    const coverage = {
      period: { from, to },
      // Список публикаций — последние 200 записей архива компании, а не выборка по датам публикации.
      // Период фильтрует только измерения.
      storedPostsTotal: storedTotal, storedPostsRead: Math.min(storedTotal, 200), postsLimit: 200,
      storedPostsTruncated: storedTotal > 200, storedPostsOmitted: Math.max(0, storedTotal - 200),
      postsSelection: 'last_stored', periodAppliesTo: 'measurement_dates',
      projectedPosts: posts.length, sourceRows: posts.reduce((n, p) => n + p.sources.length, 0),
      sourcesWithMeasurements: sourcesWithMetrics, sourcesWithKnownValues,
      measurementsRead, knownValues, latestKnownValues,
      receiptsTotal: receiptsTotal, receiptsRead: Math.min(receiptsTotal, RECEIPT_LIMIT), receiptsLimit: RECEIPT_LIMIT,
      receiptsTruncated: receiptsTotal > RECEIPT_LIMIT, receiptsOmitted: Math.max(0, receiptsTotal - RECEIPT_LIMIT),
      receiptsProjected: projection.projected, receiptsMerged: projection.merged,
      receiptsOnly: projection.receiptOnly, receiptsSkipped: projection.skipped,
      measurementDates: dateList, measurementDaysCovered: dateList.length,
      firstMeasurementDate: dateList[0] || null, lastMeasurementDate: dateList[dateList.length - 1] || null,
      note: 'Прочитано столько сохранённых публикаций, сколько показано: остальное отрезано лимитом и названо отдельно. Строки со completeness=complete говорят о полноте конкретного измерения, но не доказывают ни полноту дней периода, ни полноту всего архива.',
    };
    const findings = [], limits = [], next = [];
    if (!measurementsRead) {
      findings.push('Сохранённых измерений за этот период нет.');
      limits.push('Без измерений нельзя сказать ничего ни об охватах, ни о просмотрах: данных недостаточно.');
      next.push('Проверить, настроен ли сбор показателей для площадок этой компании, и за какие дни он действительно проходил.');
    } else if (!knownValues) {
      // Строки есть, а известных значений нет: это тоже «данных недостаточно», а не «есть данные».
      findings.push(`Строк измерений в периоде: ${measurementsRead}, но ни в одной нет известного значения.`);
      limits.push('Известных значений нет: строки сохранены пустыми, поэтому данных недостаточно для любых выводов.');
      next.push('Разобрать, почему сбор сохранил строки без значений, прежде чем что-либо сравнивать.');
    } else {
      findings.push(`Строк измерений в периоде: ${measurementsRead}, из них с известным значением: ${knownValues}.`);
      if (latestKnownValues < knownValues) findings.push(`Последних показанных измерений с известным значением: ${latestKnownValues}. Исторические измерения периода учитываются отдельно.`);
      if (posts.some(post => post.sources.some(source => source.knownValuesInPeriod > 0 && source.measurements.some(measurement => !measurement.hasValue)))) findings.push('У части метрик самое свежее измерение пустое, и прежнее известное им не подменяется.');
      findings.push(`Известные значения есть у ${sourcesWithKnownValues} исходных записей из ${coverage.sourceRows}.`);
      findings.push(`Даты измерений в периоде: ${dateList.join(', ')}.`);
      limits.push('У метрики поста не сохранён признак периода, поэтому дни не суммируются, прирост и конверсия по ним не считаются.');
      if (coverage.sourceRows > sourcesWithKnownValues) limits.push('У части публикаций известных значений нет: сравнивать их между собой нельзя.');
    }
    limits.push('Список публикаций — последние сохранённые записи архива, а не выборка по датам публикации: период фильтрует только измерения.');
    if (coverage.storedPostsTruncated) limits.push(`Прочитаны не все публикации архива: ${coverage.storedPostsRead} из ${storedTotal}, не показано ${coverage.storedPostsOmitted}.`);
    if (coverage.receiptsTruncated) limits.push(`Прочитаны не все подтверждения владельца: ${coverage.receiptsRead} из ${receiptsTotal}, не показано ${coverage.receiptsOmitted}.`);
    if (projection.receiptOnly) limits.push(`Подтверждений владельца без собранного поста: ${projection.receiptOnly}. У них показателей площадки нет и быть не может.`);
    if (projection.skipped) limits.push(`Подтверждений с площадкой вне аналитики: ${projection.skipped}.`);
    limits.push('Вывод «все публикации» не делается: доказательств полноты архива здесь нет.');
    if (!next.length) next.push('Разобрать записи без измерений и дни без сбора, прежде чем сравнивать публикации между собой.');
    return { companyCode: scope.code, period: { from, to }, posts, coverage,
      summary: { visible: findings, cannotConclude: limits, nextStep: next },
      note: 'Показано последнее измерение каждой метрики каждой исходной записи внутри выбранного периода. Значения не складываются между датами и между источниками одного адреса. Пустое значение — данных нет; ноль — измеренный ноль.' };
  }
  function overview(code, from, to) {
    const scope = company(code); day(from); day(to); if (from > to) fail();
    const rows = db.prepare(`SELECT platform, account_ref, date, metric, value, unit, kind, completeness, provider, timezone, scope, collected_at FROM social_snapshots
      WHERE company_code=? COLLATE NOCASE AND period='day' AND date>=? AND date<=? ORDER BY platform, date, metric`).all(scope.code, from, to);
    /* Последний lifetime-замер ищется ВНУТРИ своей системы суток и своей области. Иначе
       MAX(date) брал максимум по всем поясам, а внешний фильтр активного пояса потом
       отбрасывал найденную чужую строку — и правильная, более ранняя, уже была потеряна. */
    const lifetime = db.prepare(`SELECT platform, account_ref, date, metric, value, provider, timezone, scope, collected_at, kind FROM social_snapshots s WHERE company_code=? COLLATE NOCASE AND period='lifetime' AND date=(
      SELECT MAX(date) FROM social_snapshots WHERE company_code=s.company_code AND platform=s.platform AND account_ref=s.account_ref AND metric=s.metric AND period='lifetime'
        AND timezone=s.timezone AND COALESCE(scope,'profile')=COALESCE(s.scope,'profile') AND date<=?)`).all(scope.code, to);
    /* Агрегат по типу метрики: сумма — только для складываемых; проценты и средние — среднее по дням; состояние (подписчики) — не суммируется. */
    const aggregate = (list) => { const totals = {}; for (const metric of [...new Set(list.map((r) => r.metric))]) {
      const values = list.filter((r) => r.metric === metric && r.value !== null).map((r) => r.value);
      totals[metric] = !values.length ? null : AGGREGATION[metric] === 'sum' ? values.reduce((a, b) => a + b, 0) : AGGREGATION[metric] === 'avg' ? values.reduce((a, b) => a + b, 0) / values.length : null; } return totals; };
    const platforms = {};
    for (const p of Object.keys(PLATFORMS)) {
      const account = accountRow(scope.code, p), all = rows.filter((r) => r.platform === p), lifetimeAll = lifetime.filter((r) => r.platform === p);
      // Текущий аккаунт площадки и история прежних account_ref не смешиваются: сводка — по текущему, прежние — отдельной группой.
      const ref = account ? account.account_ref : null;
      const byRef = ref === null ? all : all.filter((r) => r.account_ref === ref);
      const latestByRef = ref === null ? lifetimeAll : lifetimeAll.filter((r) => r.account_ref === ref);
      /* Активная семантика интервала — система суток текущей настройки аккаунта. Наблюдения
         той же даты в другой системе суток не складываются с ней и не вытесняют её: они
         показываются отдельной группой otherIntervals. Область источника — так же. */
      const activeInterval = account?.timezone || null;
      const sameInterval = (r) => activeInterval === null || (r.timezone || '') === activeInterval;
      const profileScope = (r) => (r.scope || 'profile') === 'profile';
      const mine = byRef.filter((r) => sameInterval(r) && profileScope(r));
      const latest = latestByRef.filter((r) => sameInterval(r) && profileScope(r));
      const otherRows = byRef.concat(latestByRef).filter((r) => !sameInterval(r) || !profileScope(r));
      const otherIntervals = [...new Map(otherRows.map((r) => [`${r.timezone || ''}|${r.scope || 'profile'}`,
        { timezone: r.timezone || '', scope: r.scope || 'profile' }])).values()]
        .map((group) => { const part = otherRows.filter((r) => (r.timezone || '') === group.timezone && (r.scope || 'profile') === group.scope);
          return { ...group, totals: aggregate(part), days: [...new Set(part.map((r) => r.date))].length,
            note: 'Наблюдения другой системы суток или другой области источника: с основным рядом не складываются.' }; });
      const otherRefs = [...new Set(all.concat(lifetimeAll).map((r) => r.account_ref).filter((r) => ref !== null && r !== ref))];
      const lastRun = db.prepare('SELECT * FROM social_collect_runs WHERE company_code=? COLLATE NOCASE AND platform=? ORDER BY id DESC LIMIT 1').get(scope.code, p);
      const days = {};
      for (const r of mine) { days[r.date] ||= {}; days[r.date][r.metric] = { value: r.value, kind: r.kind, completeness: r.completeness, provider: r.provider }; }
      const totals = aggregate(mine);
      const note = runNote(lastRun);
      platforms[p] = { label: PLATFORMS[p], configured: Boolean(account && account.account_ref), provider: account?.provider || null, enabled: Boolean(account?.enabled), accountRef: ref || '',
        providerRef: account?.provider_ref || '', timezone: account?.timezone || null, collectHour: account?.collect_hour ?? null,
        access: accountDto(account, p).access,
        dataStatus: mine.length ? (mine.some((r) => r.completeness !== 'complete') ? 'partial' : 'complete') : (latest.length ? 'lifetime_only' : 'no_data'),
        /* Свежесть и разметка считаются и по lifetime-замерам: карточка с одним ручным
           снимком подписчиков раньше показывала число и дату, но «Свежесть: — · разметка: —». */
        lastCollectedAt: mine.concat(latest).reduce((m, r) => (r.collected_at > m ? r.collected_at : m), '') || null,
        lastRun: lastRun ? { status: lastRun.status, date: lastRun.date, closed: Boolean(lastRun.closed), finishedAt: lastRun.finished_at,
          error: note.error, sourceNote: note.sourceNote, missing: JSON.parse(lastRun.missing || '[]'), provider: lastRun.provider } : null,
        totals, aggregation: Object.fromEntries(Object.keys(totals).map((m) => [m, AGGREGATION[m]])),
        latest: Object.fromEntries(latest.map((r) => [r.metric, { value: r.value, date: r.date, provider: r.provider }])),
        days, kinds: [...new Set(mine.concat(latest).map((r) => r.kind).filter(Boolean))],
        activeInterval, otherIntervals,
        // Даты, оставшиеся неполными или ждущие перепроверки источника.
        pendingDates: queuedDates(scope.code, p, ref || ''),
        history: otherRefs.map((other) => ({ accountRef: other, totals: aggregate(all.filter((r) => r.account_ref === other)), days: [...new Set(all.filter((r) => r.account_ref === other).map((r) => r.date))].length })) };
    }
    const sumAcross = (metric) => { if (AGGREGATION[metric] !== 'sum') return null; const values = Object.values(platforms).map((p) => p.totals[metric]).filter((v) => typeof v === 'number'); return values.length ? values.reduce((a, b) => a + b, 0) : null; };
    return { companyCode: scope.code.toLowerCase(), from, to, timezone: scope.timezone || 'Asia/Bangkok', timezones: TIMEZONE_CHOICES, platforms, aggregation: AGGREGATION,
      aggregationNote: 'avg — невзвешенное среднее суточных значений за период (каждый день с равным весом), а не общее удержание/средняя длительность за период.',
      socialAggregate: { views: sumAcross('views'), impressions: sumAcross('impressions'), likes: sumAcross('likes'), comments: sumAcross('comments'), shares: sumAcross('shares'), saves: sumAcross('saves'),
        reachNote: 'Охват площадок не суммируется: одни и те же люди могут быть на нескольких площадках. Уникальный охват — UNKNOWN.', reach: null },
      crm: attribution(scope.code, from, to), postMetrics: postMetrics(scope.code, from, to), metrics: METRICS, runs: db.prepare('SELECT id,platform,provider,trigger,date,started_at,finished_at,status,rows,error,source_note,missing FROM social_collect_runs WHERE company_code=? COLLATE NOCASE ORDER BY id DESC LIMIT 30').all(scope.code)
        .map((r) => ({ ...r, missing: JSON.parse(r.missing || '[]'), ...runNote(r) })) };
  }
  /* «Что видно по данным». Ничего не собирает и не пишет: читает уже сохранённые
     измерения через overview/postMetrics и отдаёт их чистому модулю выводов. Сводка 2ГИС и
     выбранная версия замера «ДО» приходят снаружи — здесь их хранилище не дублируется. */
  function insights(code, from, to, { companyMetrics = null, previousCompanyMetrics = null, baseline = null } = {}) {
    const scope = company(code); day(from); day(to); if (from > to) fail();
    const comparison = previousPeriod(from, to);
    return buildInsights({
      companyCode: scope.code.toLowerCase(),
      period: { from, to, timezone: scope.timezone || 'Asia/Bangkok' },
      current: overview(scope.code, from, to),
      previous: comparison ? overview(scope.code, comparison.from, comparison.to) : null,
      comparison,
      postMetrics: postMetrics(scope.code, from, to),
      baseline, companyMetrics, previousCompanyMetrics,
      today: localDay(now(), scope.timezone || 'Asia/Bangkok'),
    });
  }
  return { accounts, saveAccounts, collect, collectDue, importManual, overview, insights, attribution, postMetrics, writeSnapshots, writePosts,
    migrateLegacyEvidence, queuedDates, acquireLease, releaseLease, localDay, dayBounds, PLATFORMS, METRICS, AGGREGATION };
}
module.exports = { createSocialStats, SOCIAL_STATS_ERRORS: ERRORS, PLATFORMS, METRICS, AGGREGATION, KINDS, TIMEZONE_CHOICES, localDay, dayBounds, canonicalPostKey, RECEIPT_TO_PLATFORM };

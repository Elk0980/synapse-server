'use strict';
/* Настройки → Контент (задача №98, контракт А): кто согласует контент-план, дни съёмки,
   дедлайн, площадки и стиль титров. Хранение по компании в SQLite content; чтение — любой
   пользователь компании, запись — владелец или settings.edit. Права и компания проверяются здесь. */
const PLATFORMS = Object.freeze(['instagram', 'tiktok', 'youtube', 'vk', 'telegram', 'max', 'dzen']);
const FONTS = Object.freeze(['Inter', 'Montserrat', 'Roboto', 'Golos Text', 'Manrope', 'PT Sans', 'Oswald', 'Unbounded']);
const SIZES = Object.freeze(['s', 'm', 'l']);
const SETTINGS_KEYS = 'approverUserIds,caption,deadlineDays,platforms,shootingWeekdays';
const CAPTION_KEYS = 'color,font,size,uppercase';
const DEFAULTS = Object.freeze({ approverUserIds: [], shootingWeekdays: [], deadlineDays: 2, platforms: [],
  caption: { font: 'Inter', size: 'm', color: '#ffffff', uppercase: false } });
const ROUTE = '/content/content-settings';

const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, ...(code ? { details: { code } } : {}) }); };
const sortedKeys = (value) => Object.keys(value).sort().join(',');
const uniqueInts = (list, test) => Array.isArray(list) && list.every((item) => Number.isSafeInteger(item) && test(item))
  && new Set(list).size === list.length;

function createContentSettings({ db, authStore, requireSession, requireCsrf, readJson, sendJson }) {
  db.exec(`CREATE TABLE IF NOT EXISTS content_settings (
    company_code TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by INTEGER NOT NULL
  );`);
  const selectRow = db.prepare('SELECT * FROM content_settings WHERE company_code = ?');

  // Пользователь берётся заново из базы: отозванные права и компании действуют сразу.
  function actor(session, code) {
    const user = authStore.getById(session.user.id);
    if (!user) fail(401, 'Требуется вход в кабинет');
    if (typeof code !== 'string' || !code) fail(400, 'Укажите компанию');
    if (!user.companyCodes.includes(code)) fail(403, 'Нет доступа к компании');
    return user;
  }
  const canEdit = (user) => user.role === 'owner' || user.permissions.includes('settings.edit');

  // Согласующие — люди этой компании с правом content-plan.approve и владельцы системы.
  function candidates(code) {
    return authStore.list()
      .filter((user) => user.role === 'owner' || (user.companyCodes.includes(code) && user.permissions.includes('content-plan.approve')))
      .map((user) => ({ id: user.id, name: user.displayName || user.login, role: user.role }));
  }

  function validate(input, code) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![SETTINGS_KEYS, SETTINGS_KEYS + ',contentPlanSheetUrl'].map(value => value.split(',').sort().join(',')).includes(sortedKeys(input))) {
      fail(400, 'Ожидались поля approverUserIds, shootingWeekdays, deadlineDays, platforms, caption');
    }
    if (Object.hasOwn(input,'contentPlanSheetUrl')) {
      if (typeof input.contentPlanSheetUrl !== 'string' || input.contentPlanSheetUrl.length > 2048) fail(400,'Некорректная ссылка таблицы');
      if (input.contentPlanSheetUrl) {
        let url; try { url = new URL(input.contentPlanSheetUrl); } catch { fail(400,'Нужна ссылка Google Таблицы'); }
        if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || url.port || url.username || url.password || !/^\/spreadsheets\/d\/[\w-]+(?:\/|$)/.test(url.pathname)) fail(400,'Нужна ссылка Google Таблицы');
      }
    }
    const allowed = new Set(candidates(code).map((item) => item.id));
    if (!uniqueInts(input.approverUserIds, (id) => allowed.has(id))) fail(400, 'Согласующим можно выбрать только человека компании с правом согласования');
    if (!uniqueInts(input.shootingWeekdays, (day) => day >= 1 && day <= 7)) fail(400, 'Дни съёмки: числа от 1 (пн) до 7 (вс) без повторов');
    if (!Number.isSafeInteger(input.deadlineDays) || input.deadlineDays < 0 || input.deadlineDays > 60) fail(400, 'Дедлайн: от 0 до 60 дней до выхода');
    if (!Array.isArray(input.platforms) || new Set(input.platforms).size !== input.platforms.length
      || input.platforms.some((item) => !PLATFORMS.includes(item))) fail(400, 'Неизвестная площадка');
    const caption = input.caption;
    if (!caption || typeof caption !== 'object' || Array.isArray(caption) || sortedKeys(caption) !== CAPTION_KEYS) fail(400, 'Стиль титров: font, size, color, uppercase');
    if (!FONTS.includes(caption.font)) fail(400, 'Неизвестный шрифт титров');
    if (!SIZES.includes(caption.size)) fail(400, 'Размер титров: s, m или l');
    if (typeof caption.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(caption.color)) fail(400, 'Цвет титров в формате #rrggbb');
    if (typeof caption.uppercase !== 'boolean') fail(400, 'uppercase должен быть true или false');
    return {
      ...(Object.hasOwn(input,'contentPlanSheetUrl') ? {contentPlanSheetUrl:input.contentPlanSheetUrl} : {}),
      approverUserIds: [...input.approverUserIds].sort((a, b) => a - b),
      shootingWeekdays: [...input.shootingWeekdays].sort((a, b) => a - b),
      deadlineDays: input.deadlineDays,
      platforms: PLATFORMS.filter((item) => input.platforms.includes(item)),
      caption: { font: caption.font, size: caption.size, color: caption.color.toLowerCase(), uppercase: caption.uppercase }
    };
  }

  function read(user, code) {
    const row = selectRow.get(code);
    const people = candidates(code);
    let settings = structuredClone(DEFAULTS);
    if (row) {
      try { settings = { ...settings, ...JSON.parse(row.body) }; } catch { /* повреждённая запись — значения по умолчанию */ }
    }
    // Согласующий, потерявший право или доступ, в выдаче не показывается и при сохранении отбрасывается.
    const ids = new Set(people.map((item) => item.id));
    settings.approverUserIds = settings.approverUserIds.filter((id) => ids.has(id));
    const editor = row ? authStore.getById(row.updated_by) : null;
    return { companyCode: code, version: row ? row.version : 0, updatedAt: row ? row.updated_at : null,
      updatedBy: row ? (editor?.displayName || editor?.login || 'удалённый пользователь') : null,
      canEdit: canEdit(user), settings, candidates: people,
      options: { platforms: PLATFORMS, fonts: FONTS, sizes: SIZES } };
  }

  function save(user, code, body) {
    if (!canEdit(user)) fail(403, 'Настройки контента меняет владелец или настройщик компании');
    if (!body || typeof body !== 'object' || Array.isArray(body) || sortedKeys(body) !== 'settings,version') fail(400, 'Ожидались поля version и settings');
    if (!Number.isSafeInteger(body.version) || body.version < 0) fail(400, 'Некорректная версия');
    const settings = validate(body.settings, code);
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = selectRow.get(code);
      if ((current?.version || 0) !== body.version) fail(409, 'Настройки уже изменил другой пользователь. Обновите экран.', 'VERSION_CONFLICT');
      // Старые открытые формы не знают поля ссылки: сохраняем его при старом PUT.
      if (!Object.hasOwn(body.settings,'contentPlanSheetUrl') && current) {
        const previous = JSON.parse(current.body);
        if (Object.hasOwn(previous,'contentPlanSheetUrl')) settings.contentPlanSheetUrl = previous.contentPlanSheetUrl;
      }
      const stamp = new Date().toISOString();
      db.prepare(`INSERT INTO content_settings(company_code, body, version, updated_at, updated_by) VALUES(?,?,?,?,?)
        ON CONFLICT(company_code) DO UPDATE SET body = excluded.body, version = excluded.version,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
        .run(code, JSON.stringify(settings), body.version + 1, stamp, user.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return read(user, code);
  }

  async function handle(request, response, url) {
    if (url.pathname !== ROUTE) return false;
    const session = requireSession(request);
    const code = url.searchParams.get('companyCode');
    const user = actor(session, code);
    if (request.method === 'GET') { sendJson(response, 200, read(user, code)); return true; }
    if (request.method === 'PUT') {
      requireCsrf(request, session);
      sendJson(response, 200, save(user, code, await readJson(request)));
      return true;
    }
    fail(405, 'Метод не поддерживается');
  }

  return { handle, read: (userId, code) => read(actor({ user: { id: userId } }, code), code),
    save: (userId, code, body) => save(actor({ user: { id: userId } }, code), code, body) };
}

module.exports = { createContentSettings, PLATFORMS, FONTS, SIZES, DEFAULTS };

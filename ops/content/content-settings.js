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
/* №208: «кому о чём сообщать» — матрица «этап × роль» (Настройки → Контент-план → Уведомления).
   Только хранение выбора компании: отправку по матрице этот модуль не выполняет. Этапы — id общей цепочки CfKit. */
const NOTIFY_STAGES = Object.freeze(['script_review', 'script_rework', 'planned', 'shot', 'edit_review', 'edit_rework', 'ready', 'published', 'publish_error']);
const NOTIFY_ROLES = Object.freeze(['owner', 'approver', 'content', 'shooting', 'editor']);
const NOTIFY_DEFAULTS = Object.freeze({
  script_review: ['owner', 'approver'], script_rework: ['content'], planned: ['content', 'shooting'], shot: ['content', 'editor'],
  edit_review: ['approver', 'content'], edit_rework: ['editor'], ready: ['content'], published: [...NOTIFY_ROLES], publish_error: ['owner', 'content'] });
/* specs/214-notification-delivery: выключатель рассылки по матрице и люди в ролях «Контент/Съёмка/Монтажёр».
   off — ничего не формируется; trial — только журнал «что ушло бы»; on — очередь существующего канала people.
   По умолчанию off. Менять режим может только владелец. */
const DELIVERY_MODES = Object.freeze(['off', 'trial', 'on']);
const PEOPLE_ROLES = Object.freeze(['content', 'shooting', 'editor']);
const OPTIONAL_KEYS = Object.freeze(['contentPlanSheetUrl', 'notificationMatrix', 'notificationDelivery', 'rolePeople']);
const emptyRolePeople = () => Object.fromEntries(PEOPLE_ROLES.map((role) => [role, []]));
const matrixDefaults = () => Object.fromEntries(NOTIFY_STAGES.map((stage) => [stage, [...NOTIFY_DEFAULTS[stage]]]));
// Строго: ровно все этапы, у каждого — массив известных ролей без повторов. Порядок ролей канонический.
function normalizeMatrix(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || sortedKeys(value) !== [...NOTIFY_STAGES].sort().join(',')) return null;
  const out = {};
  for (const stage of NOTIFY_STAGES) {
    const roles = value[stage];
    if (!Array.isArray(roles) || roles.length > NOTIFY_ROLES.length || new Set(roles).size !== roles.length
      || roles.some((role) => typeof role !== 'string' || !NOTIFY_ROLES.includes(role))) return null;
    out[stage] = NOTIFY_ROLES.filter((role) => roles.includes(role));
  }
  return out;
}

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
  const canDeliver = (user) => user.role === 'owner';

  // Люди компании для ролей уведомлений: все учётные записи с доступом к компании (владельцы — тоже).
  function people(code) {
    return authStore.list().filter((user) => user.role === 'owner' || user.companyCodes.includes(code))
      .map((user) => ({ id: user.id, name: user.displayName || user.login, role: user.role }));
  }
  // Строго: ровно три роли, у каждой — id людей компании без повторов. Иначе null.
  function normalizeRolePeople(value, code, { drop = false } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || sortedKeys(value) !== [...PEOPLE_ROLES].sort().join(',')) return null;
    const ids = new Set(people(code).map((item) => item.id)), out = {};
    for (const role of PEOPLE_ROLES) {
      const list = value[role];
      if (!Array.isArray(list) || list.length > 100 || !uniqueInts(list, () => true)) return null;
      if (!drop && list.some((id) => !ids.has(id))) return null;
      out[role] = list.filter((id) => ids.has(id)).sort((a, b) => a - b);
    }
    return out;
  }

  // Согласующие — люди этой компании с правом content-plan.approve и владельцы системы.
  function candidates(code) {
    return authStore.list()
      .filter((user) => user.role === 'owner' || (user.companyCodes.includes(code) && user.permissions.includes('content-plan.approve')))
      .map((user) => ({ id: user.id, name: user.displayName || user.login, role: user.role }));
  }

  function validate(input, code) {
    // Обязательные поля — все; необязательные (ссылка таблицы, матрица уведомлений) — по одному разу, лишних нет.
    const required = SETTINGS_KEYS.split(',');
    if (!input || typeof input !== 'object' || Array.isArray(input) || !required.every((key) => Object.hasOwn(input, key))
      || Object.keys(input).some((key) => !required.includes(key) && !OPTIONAL_KEYS.includes(key))) {
      fail(400, 'Ожидались поля approverUserIds, shootingWeekdays, deadlineDays, platforms, caption');
    }
    let notificationMatrix = null;
    if (Object.hasOwn(input, 'notificationMatrix')) {
      notificationMatrix = normalizeMatrix(input.notificationMatrix);
      if (!notificationMatrix) fail(400, `Уведомления: для каждого этапа (${NOTIFY_STAGES.join(', ')}) — список ролей из ${NOTIFY_ROLES.join(', ')} без повторов`);
    }
    if (Object.hasOwn(input, 'notificationDelivery') && !DELIVERY_MODES.includes(input.notificationDelivery)) fail(400, 'Режим уведомлений: off, trial или on');
    let rolePeople = null;
    if (Object.hasOwn(input, 'rolePeople')) {
      rolePeople = normalizeRolePeople(input.rolePeople, code);
      if (!rolePeople) fail(400, 'Роли уведомлений: content, shooting, editor — списки людей этой компании без повторов');
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
      ...(notificationMatrix ? { notificationMatrix } : {}),
      ...(Object.hasOwn(input, 'notificationDelivery') ? { notificationDelivery: input.notificationDelivery } : {}),
      ...(rolePeople ? { rolePeople } : {}),
      approverUserIds: [...input.approverUserIds].sort((a, b) => a - b),
      shootingWeekdays: [...input.shootingWeekdays].sort((a, b) => a - b),
      deadlineDays: input.deadlineDays,
      platforms: PLATFORMS.filter((item) => input.platforms.includes(item)),
      caption: { font: caption.font, size: caption.size, color: caption.color.toLowerCase(), uppercase: caption.uppercase }
    };
  }

  // Сохранённые настройки компании без проверки пользователя (для сервера рассылки), нормализованные как в выдаче.
  function stored(code) {
    const row = selectRow.get(code);
    let settings = structuredClone(DEFAULTS);
    if (row) {
      try { settings = { ...settings, ...JSON.parse(row.body) }; } catch { /* повреждённая запись — значения по умолчанию */ }
    }
    // Согласующий, потерявший право или доступ, в выдаче не показывается и при сохранении отбрасывается.
    const ids = new Set(candidates(code).map((item) => item.id));
    settings.approverUserIds = Array.isArray(settings.approverUserIds) ? settings.approverUserIds.filter((id) => ids.has(id)) : [];
    // Матрица не сохранялась или повреждена — значения по умолчанию (каждый узнаёт о своём следующем действии).
    settings.notificationMatrix = normalizeMatrix(settings.notificationMatrix) || matrixDefaults();
    // Неизвестный или повреждённый режим — выключено. Отметка включения ставится только сервером.
    if (!DELIVERY_MODES.includes(settings.notificationDelivery)) settings.notificationDelivery = 'off';
    settings.rolePeople = normalizeRolePeople(settings.rolePeople, code, { drop: true }) || emptyRolePeople();
    const enabledAt = typeof settings.deliveryEnabledAt === 'string' ? settings.deliveryEnabledAt : null;
    const epoch = Number.isSafeInteger(settings.deliveryEpoch) ? settings.deliveryEpoch : null;
    delete settings.deliveryEnabledAt; delete settings.deliveryEpoch;
    return { row, settings, enabledAt, epoch };
  }

  function read(user, code) {
    const { row, settings, enabledAt } = stored(code);
    const approverCandidates = candidates(code);
    const editor = row ? authStore.getById(row.updated_by) : null;
    return { companyCode: code, version: row ? row.version : 0, updatedAt: row ? row.updated_at : null,
      updatedBy: row ? (editor?.displayName || editor?.login || 'удалённый пользователь') : null,
      canEdit: canEdit(user), canDeliver: canDeliver(user), settings, candidates: approverCandidates, people: people(code),
      delivery: { mode: settings.notificationDelivery, enabledAt },
      options: { platforms: PLATFORMS, fonts: FONTS, sizes: SIZES,
        notifications: { stages: NOTIFY_STAGES, roles: NOTIFY_ROLES }, delivery: { modes: DELIVERY_MODES, peopleRoles: PEOPLE_ROLES } } };
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
      if (current) {
        let previous = {};
        try { previous = JSON.parse(current.body) || {}; } catch { /* повреждённая запись — переносить нечего */ }
        if (!Object.hasOwn(body.settings,'contentPlanSheetUrl') && Object.hasOwn(previous,'contentPlanSheetUrl')) settings.contentPlanSheetUrl = previous.contentPlanSheetUrl;
        // Формы, не знающие матрицы уведомлений, её не стирают.
        const kept = Object.hasOwn(body.settings, 'notificationMatrix') ? null : normalizeMatrix(previous.notificationMatrix);
        if (kept) settings.notificationMatrix = kept;
        if (!Object.hasOwn(body.settings, 'rolePeople') && previous.rolePeople) {
          const keptPeople = normalizeRolePeople(previous.rolePeople, code, { drop: true });
          if (keptPeople) settings.rolePeople = keptPeople;
        }
      }
      // Режим рассылки: без ключа — прежний; менять может только владелец (настройщик присылает прежнее значение).
      const before = stored(code), was = before.settings.notificationDelivery;
      if (!Object.hasOwn(settings, 'notificationDelivery')) settings.notificationDelivery = was;
      if (settings.notificationDelivery !== was && !canDeliver(user)) fail(403, 'Рассылку уведомлений включает и выключает только владелец');
      // Отметка включения меняется при каждом выходе из «выкл.»: детектор по ней заново запоминает этапы без рассылки.
      if (settings.notificationDelivery === 'off') { /* выключено — отметки нет */ }
      else if (was === 'off' || !before.enabledAt || !before.epoch) {
        settings.deliveryEnabledAt = new Date().toISOString(); settings.deliveryEpoch = body.version + 1;
      } else { settings.deliveryEnabledAt = before.enabledAt; settings.deliveryEpoch = before.epoch; }
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

  /* Для сервера рассылки (content-stage-notify.js): только чтение сохранённого выбора компании. */
  function delivery(code) {
    const { settings, enabledAt, epoch } = stored(code);
    return { mode: settings.notificationDelivery, enabledAt, epoch, matrix: settings.notificationMatrix,
      approverUserIds: settings.approverUserIds, rolePeople: settings.rolePeople };
  }
  const deliveryCompanies = () => db.prepare('SELECT company_code FROM content_settings ORDER BY company_code').all()
    .map((row) => row.company_code).filter((code) => delivery(code).mode !== 'off');

  return { handle, read: (userId, code) => read(actor({ user: { id: userId } }, code), code),
    save: (userId, code, body) => save(actor({ user: { id: userId } }, code), code, body),
    canView: (userId, code) => canEdit(actor({ user: { id: userId } }, code)), delivery, deliveryCompanies };
}

module.exports = { createContentSettings, PLATFORMS, FONTS, SIZES, DEFAULTS, NOTIFY_STAGES, NOTIFY_ROLES, NOTIFY_DEFAULTS,
  DELIVERY_MODES, PEOPLE_ROLES };

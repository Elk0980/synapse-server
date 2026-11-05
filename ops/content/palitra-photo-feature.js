'use strict';
/* Palitra: фото черновика в native content-сервере (PALITRA-BOT-EDITOR-35, проход 2). НЕ УСТАНОВЛЕНО.
   Устанавливается рядом с server.js как palitra-photo-feature.js (+ palitra-photo-model.js, palitra-image-check.js);
   подключение — server-candidate/photo-feature.patch.json. Основа — BASE/server.js 7b601873…, site-workspaces.js a28a4154….

   Маршруты (обрабатываются до workspaceFeature.routes):
     GET  /content/palitra/site-photos          слоты фото, без HTML                     право фото «просмотр»
     PUT  /content/palitra/site-photos          {baseRevision, operations[, message]}    право фото «изменение» + CSRF
     POST /content/palitra/site-photos/assets   байты фото (JPEG/PNG/WebP, до 8 МБ)      право фото «изменение» + CSRF
     GET  /content/palitra/site-photos/access   сотрудники Palitra и их права на фото     только владелец
     PUT  /content/palitra/site-photos/access   {userId, view, edit}                      только владелец + CSRF

   Права:
   - владелец (role === 'owner') — существующая привилегия владельца;
   - остальные — только явная запись в palitra_site_photo_grants для фиксированного черновика + актуальное членство
     palitra-love в companyCodes. Глобальные права (site_editor.*, whoami, сессия, auth-store) не меняются.
     Таблица создаётся пустой: ничего не выдаётся автоматически, Дарья не добавляется.
   - Сессия, аккаунт, членство и grant перечитываются на каждом запросе и ещё раз синхронно непосредственно перед
     каждой записью (requireSession перечитывает authStore.getById и sessionVersion). Между этой проверкой и
     записью нет await: в однопоточном Node проверка и CAS-запись выполняются одним шагом (F03).

   Запись черновика: только workspaceStore.workspace/file/save, только site-44bbe13f1bad5e005b2a и только index.html,
   от временного внутреннего principal {id, login нативного пользователя, companyCodes:['palitra-love'],
   permissions:['site_editor.view','site_editor.edit']}. Сессия и аккаунт пользователя не меняются.
   store.save синхронен и сам делает CAS по baseRevision внутри BEGIN IMMEDIATE (409 → conflict).

   Фото: ASSETS_DIR/publishing/palitra-love/<sha256[0..32]>.<jpg|png|webp>, публичный адрес
   https://synapse.synapsebusiness.ru/content/publishing-assets/palitra-love/<имя> (его отдаёт существующий маршрут).
   Имя — из содержимого: повтор тех же байтов не создаёт копию, после сбоя исход сверяется по имени и sha256 (F01).
   Материалы не удаляются. Внешние адреса не запрашиваются: /api/assets/<имя> читается локально из ASSETS_DIR/palitra.
   Новое фото принимается только после structural-проверки и доверенного декодера deps.decodeImage (F02);
   без декодера загрузка и применение новых фото отключены с понятным сообщением, чтение работает. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sibling = (installed, work) => require(fs.existsSync(path.join(__dirname, installed)) ? `./${installed}` : work);
const model = sibling('palitra-photo-model.js', '../photo-model/palitra-photo-model.js');
const imageCheck = sibling('palitra-image-check.js', '../photo-model/image-probe.js');

const SITE_ID = model.TARGET.siteId;
const COMPANY = model.TARGET.companyId;
const BASE_PATH = '/content/palitra/site-photos';
const ASSETS_PATH = `${BASE_PATH}/assets`;
const ACCESS_PATH = `${BASE_PATH}/access`;
const MAX_UPLOAD = 8 * 1024 * 1024;
const MAX_LOCAL_READ = 10 * 1024 * 1024;
const MESSAGE_MAX = 240;
const PUBLISHING_ORIGIN = 'https://synapse.synapsebusiness.ru';
const DRAFT_URL_RE = /^https:\/\/(?:palitra-love-draft-\d+|palitra-draft)\.synapsebusiness\.ru\/$/;
const PUBLISHING_URL_RE = /^https:\/\/synapse\.synapsebusiness\.ru\/content\/publishing-assets\/palitra-love\/([a-f0-9]{32}\.(?:jpg|png|webp))$/;
const SITE_ASSET_URL_RE = /^https:\/\/(?:palitra-love\.ru|palitra-love\.synapsebusiness\.ru)\/api\/assets\/([a-z0-9][a-z0-9-]{0,120}\.(?:jpe?g|png|webp))$/;
const EXT_BY_MIME = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });
const DECODER_MESSAGE = 'Проверка новых фото на сервере ещё не подключена. Порядок, подписи и уже загруженные фото менять можно, новые фото — пока нет';
const NONE = Object.freeze({ view: false, edit: false, owner: false });

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const httpError = (status, message) => Object.assign(new Error(message), { status });
const isOurs = pathname => pathname === BASE_PATH || pathname === ASSETS_PATH || pathname === ACCESS_PATH;

function createPalitraPhotoFeature(options = {}) {
  const { db, authStore, requireSession, requireCsrf, readJson, readRaw, workspaceStore, assetsDir,
    decodeImage = null, expectedPublicUrl = null, log = console } = options;
  const ready = db && typeof db.prepare === 'function' && typeof db.exec === 'function' &&
    authStore && typeof authStore.getById === 'function' && typeof authStore.list === 'function' &&
    [requireSession, requireCsrf, readJson, readRaw].every(fn => typeof fn === 'function') &&
    workspaceStore && ['workspace', 'file', 'save'].every(name => typeof workspaceStore[name] === 'function') &&
    typeof assetsDir === 'string' && assetsDir.length > 0;
  if (!ready) {
    // Сервер не должен падать из-за фото: маршруты честно отвечают 503, остальное работает как раньше.
    log.warn('content: фото Palitra отключены — не переданы зависимости');
    return Object.freeze({ enabled: false, handle: async (request, reply, url) => {
      if (!isOurs(url.pathname)) return false;
      reply(503, { error: 'unavailable', message: 'Редактор фото Palitra не подключён' });
      return true;
    } });
  }
  if (decodeImage !== null && typeof decodeImage !== 'function') throw new Error('decodeImage должен быть функцией или null');
  if (expectedPublicUrl !== null && !DRAFT_URL_RE.test(expectedPublicUrl)) throw new Error('expectedPublicUrl должен быть адресом черновика');

  db.exec(`CREATE TABLE IF NOT EXISTS palitra_site_photo_grants(
      site_id TEXT NOT NULL, user_id INTEGER NOT NULL, can_view INTEGER NOT NULL, can_edit INTEGER NOT NULL,
      granted_by INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(site_id,user_id),
      CHECK(can_view IN (0,1) AND can_edit IN (0,1) AND (can_edit = 0 OR can_view = 1)));
    CREATE TABLE IF NOT EXISTS palitra_site_photo_audit(
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, actor_id INTEGER NOT NULL, actor_login TEXT NOT NULL,
      action TEXT NOT NULL, target_user_id INTEGER, details_json TEXT NOT NULL);`);
  const grantGet = db.prepare('SELECT can_view, can_edit FROM palitra_site_photo_grants WHERE site_id = ? AND user_id = ?');
  const grantUpsert = db.prepare(`INSERT INTO palitra_site_photo_grants(site_id,user_id,can_view,can_edit,granted_by,updated_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(site_id,user_id) DO UPDATE SET can_view=excluded.can_view, can_edit=excluded.can_edit,
    granted_by=excluded.granted_by, updated_at=excluded.updated_at`);
  const grantDelete = db.prepare('DELETE FROM palitra_site_photo_grants WHERE site_id = ? AND user_id = ?');
  const auditInsert = db.prepare('INSERT INTO palitra_site_photo_audit(created_at,actor_id,actor_login,action,target_user_id,details_json) VALUES(?,?,?,?,?,?)');
  const audit = (actor, action, target, details) => auditInsert.run(new Date().toISOString(), actor.id, String(actor.login), action, target ?? null, JSON.stringify(details));

  const publishingDir = path.join(assetsDir, 'publishing', COMPANY);
  const siteAssetsDir = path.join(assetsDir, 'palitra');

  /* ---------- Права ---------- */

  const isMember = user => Array.isArray(user && user.companyCodes) && user.companyCodes.includes(COMPANY);
  const accessOf = user => {
    if (!user) return NONE;
    if (user.role === 'owner') return { view: true, edit: true, owner: true };
    if (!Number.isInteger(user.id) || !isMember(user)) return NONE;
    const row = grantGet.get(SITE_ID, user.id);
    if (!row) return NONE;
    const view = row.can_view === 1;
    return { view, edit: view && row.can_edit === 1, owner: false };
  };
  /* Синхронно: свежая сессия (authStore.getById + sessionVersion), членство, grant, при записи — CSRF. */
  const authorize = (request, need) => {
    const session = requireSession(request);
    const access = accessOf(session.user);
    if (need === 'owner' ? !access.owner : !access.view || (need === 'edit' && !access.edit)) {
      throw httpError(403, need === 'owner' ? 'Доступно только владельцу' : need === 'edit' ? 'Нет права менять фото сайта Palitra' : 'Нет доступа к фото сайта Palitra');
    }
    if (need !== 'view' && request.method !== 'GET') requireCsrf(request, session);
    return { session, access };
  };
  const reauthorize = (request, first, need) => {
    const again = authorize(request, need);
    if (again.session.user.id !== first.session.user.id) throw httpError(403, 'Доступ изменился. Обновите страницу');
    return again;
  };
  // Внутренний principal только для workspaceStore; наружу не отдаётся, сессию и аккаунт не меняет.
  const principalFor = user => Object.freeze({ id: user.id, login: user.login, displayName: user.displayName,
    role: 'site-photos', companyCodes: Object.freeze([COMPANY]), permissions: Object.freeze(['site_editor.view', 'site_editor.edit']) });

  /* ---------- Черновик ---------- */

  const readDraft = user => {
    const principal = principalFor(user);
    const workspace = workspaceStore.workspace(principal, SITE_ID);
    if (workspace.siteId !== SITE_ID || workspace.companyCode !== COMPANY) throw httpError(409, 'Черновик не совпал с сайтом Palitra');
    const urlOk = expectedPublicUrl ? workspace.publicUrl === expectedPublicUrl : DRAFT_URL_RE.test(String(workspace.publicUrl));
    if (!urlOk) throw httpError(409, 'Адрес черновика не подтверждён');
    if (!Array.isArray(workspace.files) || !workspace.files.some(file => file.path === 'index.html')) throw httpError(409, 'В черновике нет index.html');
    const file = workspaceStore.file(principal, SITE_ID, 'index.html');
    if (file.revision !== workspace.revision) throw httpError(409, 'Черновик изменился во время чтения. Обновите состояние');
    model.checkTarget({ siteId: workspace.siteId, companyId: workspace.companyCode });
    return { revision: workspace.revision, version: workspace.version, publicUrl: workspace.publicUrl, content: file.content };
  };
  const stateBody = (draft, auth) => ({
    siteId: SITE_ID, companyId: COMPANY, revision: draft.revision, version: draft.version, publicUrl: draft.publicUrl,
    canEdit: auth.access.edit, owner: auth.access.owner, login: auth.session.user.login, decoder: Boolean(decodeImage),
    slots: model.parseSlots(draft.content),
    limits: { galleryMin: model.GALLERY_MIN, galleryMax: model.GALLERY_MAX, galleryInitial: model.GALLERY_INITIAL, maxBytes: MAX_UPLOAD }
  });

  /* ---------- Материалы ---------- */

  const localFileFor = url => {
    let match = PUBLISHING_URL_RE.exec(url);
    if (match) return path.join(publishingDir, match[1]);
    match = SITE_ASSET_URL_RE.exec(url);
    if (match && path.basename(match[1]) === match[1]) return path.join(siteAssetsDir, match[1]);
    return null;
  };
  const readLocal = file => {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_LOCAL_READ) return null;
      return fs.readFileSync(file);
    } catch (error) {
      // ENOTDIR: часть пути — файл, значит такого материала точно нет.
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
  };
  const fileState = (file, sha) => {
    try { const bytes = readLocal(file); return !bytes ? 'absent' : digest(bytes) === sha ? 'same' : 'different'; }
    catch (_) { return 'unknown'; }
  };

  /* Синхронно: имя из sha256, атомарная запись без перезаписи чужого файла, чтение обратно. */
  function storeAsset(bytes, ext) {
    const sha = digest(bytes);
    const name = `${sha.slice(0, 32)}.${ext}`;
    const file = path.join(publishingDir, name);
    const url = `${PUBLISHING_ORIGIN}/content/publishing-assets/${COMPANY}/${name}`;
    const collision = { status: 409, body: { error: 'collision', message: 'В хранилище уже есть другой файл с тем же именем. Загрузка остановлена, ничего не перезаписано' } };
    const before = fileState(file, sha);
    if (before === 'same') return { ok: true, url, sha, reused: true };
    if (before === 'different') return collision;
    if (before === 'unknown') return { status: 503, body: { error: 'unknown', message: 'Хранилище фото сейчас не читается. Попробуйте позже' } };
    let temp = null;
    try {
      fs.mkdirSync(publishingDir, { recursive: true });
      temp = path.join(publishingDir, `.palitra-upload-${crypto.randomBytes(8).toString('hex')}.tmp`);
      const fd = fs.openSync(temp, 'wx', 0o644);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try { fs.linkSync(temp, file); }
      catch (error) {
        if (error.code === 'EEXIST') { /* уже есть — ниже сверим содержимое */ }
        else if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK'].includes(error.code)) fs.copyFileSync(temp, file, fs.constants.COPYFILE_EXCL);
        else throw error;
      }
    } catch (_) {
      /* исход неочевиден — решает сверка ниже, а не совет «повторите» */
    } finally {
      if (temp) { try { fs.rmSync(temp, { force: true }); } catch (_) { /* временный файл не мешает: имя с точкой не отдаётся */ } }
    }
    const after = fileState(file, sha);
    if (after === 'same') return { ok: true, url, sha, reused: false };
    if (after === 'different') return collision;
    if (after === 'absent') return { status: 502, body: { error: 'upload_failed', message: 'Фото не записано: файла нет в хранилище. Повторная загрузка безопасна — тот же файл не создаст копию' } };
    return { status: 503, body: { error: 'unknown', message: 'Результат записи фото неизвестен. Повторная загрузка безопасна: тот же файл получит то же имя' } };
  }

  /* Новое фото — по байтам из локального хранилища: существует, проходит структурную проверку и декодер, размеры
     совпадают с правкой. Уже стоящие на сайте фото с теми же размерами повторно не проверяются. */
  async function verifyImages(operations, slots) {
    const known = new Set();
    for (const card of slots.categories) known.add(`${card.src}|${card.width}|${card.height}`);
    for (const card of slots.budget) known.add(`${card.src}|${card.width}|${card.height}`);
    for (const item of slots.gallery) known.add(`${item.url}|${item.width}|${item.height}`);
    const images = [];
    for (const op of operations) {
      if (op.type === 'hero.scene') {
        const scene = slots.hero.find(item => item.scene === op.scene);
        for (const format of model.HERO_FORMATS) if (op[format].url !== scene.formats[format]) images.push(op[format]);
      } else if (op.type === 'category.photo') {
        images.push(op);
        const card = slots.categories.find(item => item.key === op.category);
        if (op.mobile && op.mobile.url !== card.mobile) images.push(op.mobile);
      } else if (op.type === 'budget.photo') images.push(op);
      else if (op.type === 'gallery.set') images.push(...op.items);
    }
    const fresh = images.filter(image => !known.has(`${image.url}|${image.width}|${image.height}`));
    if (fresh.length && !decodeImage) return { status: 503, body: { error: 'decoder_unavailable', message: DECODER_MESSAGE } };
    const checked = new Set();
    for (const image of fresh) {
      const key = `${image.url}|${image.width}|${image.height}`;
      if (checked.has(key)) continue;
      const file = localFileFor(image.url);
      const bytes = file ? readLocal(file) : null;
      if (!bytes) return { status: 422, body: { error: 'asset', message: 'Фото не найдено в хранилище материалов Palitra', url: image.url } };
      let info;
      try { info = imageCheck.inspect(bytes); } catch (error) { return { status: 422, body: { error: 'asset', message: error.message, url: image.url } }; }
      let decoded;
      try { decoded = await decodeImage(bytes); } catch (_) { return { status: 422, body: { error: 'asset', message: 'Фото не читается полностью', url: image.url } }; }
      if (!decoded || decoded.width !== info.width || decoded.height !== info.height) return { status: 422, body: { error: 'asset', message: 'Размер фото по декодеру не совпал с файлом', url: image.url } };
      if (info.width !== image.width || info.height !== image.height) {
        return { status: 422, body: { error: 'asset', message: `Размер фото ${info.width}×${info.height}, а в правке ${image.width}×${image.height}`, url: image.url } };
      }
      checked.add(key);
    }
    return null;
  }

  /* ---------- Маршруты фото ---------- */

  async function getState(request, reply) {
    const auth = authorize(request, 'view');
    reply(200, stateBody(readDraft(auth.session.user), auth));
  }

  async function putState(request, reply) {
    const first = authorize(request, 'edit');
    const body = await readJson(request);
    const keys = Object.keys(body).sort().join(',');
    if (keys !== 'baseRevision,operations' && keys !== 'baseRevision,message,operations') return reply(400, { error: 'invalid', message: 'Переданы лишние поля' });
    if (typeof body.baseRevision !== 'string' || !body.baseRevision) return reply(400, { error: 'invalid', message: 'Нет ревизии черновика' });
    const message = body.message === undefined ? '' : body.message;
    if (typeof message !== 'string' || message.length > MESSAGE_MAX) return reply(400, { error: 'invalid', message: 'Описание правки слишком длинное' });
    let operations;
    try { operations = model.normalizeOperations(body.operations); }
    catch (error) { return reply(400, { error: error.code || 'invalid', message: error.message }); }

    let auth = reauthorize(request, first, 'edit');
    const before = readDraft(auth.session.user);
    if (before.revision !== body.baseRevision) {
      return reply(409, { error: 'conflict', message: 'Черновик изменён другим сохранением. Ваши правки не записаны и остались в браузере', revision: before.revision });
    }
    const slots = model.parseSlots(before.content);
    const problem = await verifyImages(operations, slots);
    if (problem) return reply(problem.status, problem.body);
    let result;
    try { result = model.applyOperations(before.content, operations, model.TARGET); }
    catch (error) { return reply(error.code === 'invalid' || error.code === 'url' ? 400 : 422, { error: error.code || 'invalid', message: error.message }); }
    const text = (message.trim() || `Фото сайта: изменений ${operations.length}`).slice(0, MESSAGE_MAX);

    // Фиксация одним синхронным шагом: свежие сессия/CSRF/членство/grant → CAS-запись store.save. Без await.
    let writeError = null;
    try {
      auth = reauthorize(request, first, 'edit');
      workspaceStore.save(principalFor(auth.session.user), SITE_ID, { baseRevision: before.revision, files: [{ path: 'index.html', content: result.html }], message: text });
    } catch (error) {
      if (error.status === 401 || error.status === 403) throw error; // проверка не пройдена до записи — ничего не записано
      if (error.status === 409) return reply(409, { error: 'conflict', message: 'Черновик изменён другим сохранением. Ваши правки не записаны и остались в браузере' });
      writeError = error;
    }
    if (writeError) {
      // Исход записи неизвестен: сначала читаем фактическое состояние, повторной записи нет.
      let after = null;
      try { after = readDraft(auth.session.user); } catch (_) { after = null; }
      if (after && after.content === result.html) return reply(200, { ...stateBody(after, auth), applied: result.patches, recovered: true });
      if (after && after.revision === before.revision && after.content === before.content) return reply(502, { error: 'write_failed', message: 'Черновик не сохранён. Правки остались в браузере' });
      return reply(503, { error: 'unknown', message: 'Результат сохранения неизвестен. Обновите состояние перед повтором', revision: after ? after.revision : null });
    }
    const after = readDraft(auth.session.user);
    if (after.content !== result.html) {
      return reply(500, { error: 'readback_mismatch', message: 'После сохранения черновик не совпал с ожидаемым. Проверьте состояние перед повтором', revision: after.revision });
    }
    try { audit(auth.session.user, 'SITE_PHOTOS_SAVED', null, { siteId: SITE_ID, revision: after.revision, slots: result.patches.map(p => p.slot) }); }
    catch (error) { log.warn(`content: аудит фото Palitra не записан: ${error.message}`); }
    return reply(200, { ...stateBody(after, auth), applied: result.patches });
  }

  async function upload(request, reply) {
    const first = authorize(request, 'edit');
    if (!decodeImage) return reply(503, { error: 'decoder_unavailable', message: DECODER_MESSAGE });
    const type = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!Object.hasOwn(EXT_BY_MIME, type)) return reply(415, { error: 'image', message: 'Подходят только фото JPEG, PNG или WebP' });
    const bytes = await readRaw(request, MAX_UPLOAD);
    if (!bytes.length) return reply(400, { error: 'invalid', message: 'Пустой файл' });
    let info;
    try { info = imageCheck.inspect(bytes); } catch (error) { return reply(415, { error: 'image', message: error.message }); }
    if (info.mime !== type) return reply(415, { error: 'image', message: 'Содержимое файла не совпало с его типом' });
    let decoded;
    try { decoded = await decodeImage(bytes); } catch (_) { return reply(415, { error: 'image', message: 'Фото не читается полностью. Сохраните его заново и загрузите ещё раз' }); }
    if (!decoded || decoded.width !== info.width || decoded.height !== info.height) return reply(415, { error: 'image', message: 'Размер фото по декодеру не совпал с файлом' });
    // Запись материала — мутация: свежая проверка непосредственно перед синхронной записью.
    const auth = reauthorize(request, first, 'edit');
    const stored = storeAsset(bytes, info.ext);
    if (!stored.ok) return reply(stored.status, stored.body);
    try { audit(auth.session.user, 'SITE_PHOTO_UPLOADED', null, { siteId: SITE_ID, url: stored.url, sha256: stored.sha, reused: stored.reused }); }
    catch (error) { log.warn(`content: аудит фото Palitra не записан: ${error.message}`); }
    return reply(201, { url: stored.url, width: info.width, height: info.height, mime: info.mime, bytes: bytes.length, sha256: stored.sha, reused: stored.reused });
  }

  /* ---------- Доступ (только владелец) ---------- */

  const palitraStaff = () => authStore.list()
    .filter(user => user && Number.isInteger(user.id) && user.role !== 'owner' && isMember(user))
    .map(user => {
      const access = accessOf(user);
      return { userId: user.id, login: String(user.login || ''), displayName: typeof user.displayName === 'string' ? user.displayName : '', view: access.view, edit: access.edit };
    })
    .sort((a, b) => a.login.localeCompare(b.login));

  async function getAccess(request, reply) {
    authorize(request, 'owner');
    reply(200, { siteId: SITE_ID, companyId: COMPANY, users: palitraStaff() });
  }

  async function putAccess(request, reply) {
    const first = authorize(request, 'owner');
    const body = await readJson(request);
    if (Object.keys(body).sort().join(',') !== 'edit,userId,view') return reply(400, { error: 'invalid', message: 'Переданы лишние поля' });
    if (!Number.isInteger(body.userId) || typeof body.view !== 'boolean' || typeof body.edit !== 'boolean') return reply(400, { error: 'invalid', message: 'Неверный запрос' });
    if (body.edit && !body.view) return reply(400, { error: 'invalid', message: 'Изменение фото возможно только вместе с просмотром' });
    // Непосредственно перед записью: свежая сессия владельца, CSRF, актуальный аккаунт и членство Palitra.
    const fresh = reauthorize(request, first, 'owner');
    const target = authStore.getById(body.userId);
    if (!target || target.role === 'owner' || !isMember(target)) return reply(404, { error: 'not_found', message: 'Сотрудник Palitra не найден' });
    const stamp = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      if (body.view) grantUpsert.run(SITE_ID, target.id, 1, body.edit ? 1 : 0, fresh.session.user.id, stamp);
      else grantDelete.run(SITE_ID, target.id);
      audit(fresh.session.user, body.view ? 'SITE_PHOTO_GRANT_SET' : 'SITE_PHOTO_GRANT_REVOKED', target.id, { siteId: SITE_ID, view: body.view, edit: body.view && body.edit });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    log.log(`content: site_photos_access time=${stamp} actor=${JSON.stringify(fresh.session.user.login)} target=${JSON.stringify(target.login)} view=${body.view} edit=${body.view && body.edit}`);
    const access = accessOf(target);
    return reply(200, { userId: target.id, login: String(target.login || ''), view: access.view, edit: access.edit });
  }

  async function handle(request, reply, url) {
    const pathname = url.pathname;
    if (!isOurs(pathname)) return false;
    try {
      if (pathname === BASE_PATH && request.method === 'GET') await getState(request, reply);
      else if (pathname === BASE_PATH && request.method === 'PUT') await putState(request, reply);
      else if (pathname === ASSETS_PATH && request.method === 'POST') await upload(request, reply);
      else if (pathname === ACCESS_PATH && request.method === 'GET') await getAccess(request, reply);
      else if (pathname === ACCESS_PATH && request.method === 'PUT') await putAccess(request, reply);
      else throw httpError(405, 'Метод не поддерживается');
    } catch (error) {
      if (error instanceof model.PhotoModelError) { reply(422, { error: error.code, message: error.message }); return true; }
      throw error; // 401/403/404/405/413 и прочее — общий обработчик server.js (с журналом отказов)
    }
    return true;
  }

  return Object.freeze({ enabled: true, handle, accessOf, _test: { storeAsset, localFileFor, principalFor } });
}

module.exports = { createPalitraPhotoFeature, BASE_PATH, ASSETS_PATH, ACCESS_PATH, SITE_ID, COMPANY };

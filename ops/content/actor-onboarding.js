'use strict';

// Короткий личный опрос участника компании. Он не выдаёт доступ к общему брифу,
// контент-плану, чату, каналам публикации или статистике.
const { COMPANIES } = require('./auth-store');

const CAMERA = Object.freeze(['unknown', 'off_camera', 'small_steps', 'on_camera']);
const VOICE = Object.freeze(['unknown', 'text_only', 'short_voice', 'comfortable']);
const FIELDS = Object.freeze(['direction', 'role', 'cameraComfort', 'voiceComfort', 'boundaries', 'suggestions']);
const EMPTY = Object.freeze({ direction: '', role: '', cameraComfort: 'unknown',
  voiceComfort: 'unknown', boundaries: '', suggestions: '' });
const CHECK_IN_DELAY = 14 * 24 * 60 * 60 * 1000;
const CHECK_IN_COMFORT = Object.freeze(['comfortable', 'mixed', 'difficult']);
const CHECK_IN_QUESTIONS = Object.freeze([
  { key: 'comfort', label: 'Насколько вам сейчас комфортно участвовать?',
    why: 'Чтобы понять, подходит ли вам нынешний темп и формат.' },
  { key: 'obstacles', label: 'Что вам мешает?',
    why: 'Чтобы заметить трудности и понять, какая помощь нужна.' },
  { key: 'improvements', label: 'Что стоит улучшить?',
    why: 'Чтобы опираться на ваш опыт и сделать участие удобнее.' },
  { key: 'nextStep', label: 'Какой следующий шаг вам по силам?',
    why: 'Чтобы выбрать небольшое действие без лишнего давления.' },
]);
const CHECK_IN_EMPTY = Object.freeze({ comfort: '', obstacles: '', improvements: '', nextStep: '' });
const complete = (profile) => Boolean(profile.direction?.trim() && profile.role?.trim() &&
  CAMERA.includes(profile.cameraComfort) && profile.cameraComfort !== 'unknown' &&
  VOICE.includes(profile.voiceComfort) && profile.voiceComfort !== 'unknown');
const QUESTIONS = Object.freeze([
  { key: 'direction', label: 'О каком направлении компании вы рассказываете?',
    why: 'Чтобы готовить темы по вашей работе и не смешивать направления.' },
  { key: 'role', label: 'Что вы готовы делать для контента?',
    why: 'Чтобы первые задания соответствовали вашей роли и опыту.' },
  { key: 'cameraComfort', label: 'Насколько вам комфортно быть в кадре?',
    why: 'Чтобы начинать с посильного формата и постепенно привыкать к съёмке.' },
  { key: 'voiceComfort', label: 'Насколько вам комфортно записывать голос?',
    why: 'Чтобы предложить текст, короткую озвучку или разговорный ролик.' },
  { key: 'boundaries', label: 'Какие темы или форматы не следует предлагать?',
    why: 'Чтобы уважать ваши границы при подготовке контента.' },
  { key: 'suggestions', label: 'Что вы предложили бы улучшить?',
    why: 'Чтобы учитывать ваши идеи ещё до составления личного плана.' },
]);
// Только публичные адреса профилей. Эти записи не являются OAuth-подключением
// и не дают системе права публиковать или читать статистику аккаунта.
const SOCIAL_PROFILES = Object.freeze({
  instagram: { hosts: ['instagram.com', 'www.instagram.com'], path: /^\/[a-zA-Z0-9._]{1,30}\/?$/ },
  tiktok: { hosts: ['tiktok.com', 'www.tiktok.com'], path: /^\/@[a-zA-Z0-9._]{2,24}\/?$/ },
  youtube: { hosts: ['youtube.com', 'www.youtube.com'],
    path: /^\/(?:@[a-zA-Z0-9._-]+|(?:channel|c|user)\/[a-zA-Z0-9_-]+)\/?$/ },
  vk: { hosts: ['vk.com', 'www.vk.com'], path: /^\/[a-zA-Z0-9_.-]{1,64}\/?$/ },
  telegram: { hosts: ['t.me', 'telegram.me'], path: /^\/[a-zA-Z0-9_]{5,32}\/?$/ },
  facebook: { hosts: ['facebook.com', 'www.facebook.com'], path: /^\/[a-zA-Z0-9_.-]{1,100}\/?$/ },
  threads: { hosts: ['threads.net', 'www.threads.net'], path: /^\/@[a-zA-Z0-9._]{1,30}\/?$/ },
  x: { hosts: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'],
    path: /^\/[a-zA-Z0-9_]{1,15}\/?$/ },
});

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function cleanText(value, max, name) {
  if (typeof value !== 'string' || value.length > max) fail(400, `Проверьте поле «${name}»`);
  return value.trim();
}
function normalizeProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...FIELDS].sort().join(',')) {
    fail(400, 'Заполните поля личного опроса без дополнительных данных');
  }
  if (!CAMERA.includes(value.cameraComfort) || !VOICE.includes(value.voiceComfort)) {
    fail(400, 'Выберите уровень комфорта для кадра и голоса');
  }
  return { direction: cleanText(value.direction, 200, 'Направление'),
    role: cleanText(value.role, 500, 'Роль'), cameraComfort: value.cameraComfort,
    voiceComfort: value.voiceComfort, boundaries: cleanText(value.boundaries, 2000, 'Ограничения'),
    suggestions: cleanText(value.suggestions, 2000, 'Предложения') };
}
function requireShape(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== [...keys].sort().join(',')) {
    fail(400, 'Проверьте поля запроса');
  }
}
function socialPlatform(value) {
  if (typeof value !== 'string' || !Object.hasOwn(SOCIAL_PROFILES, value)) {
    fail(400, 'Выберите доступную площадку');
  }
  return value;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail(400, 'Некорректная версия ссылки');
  return value;
}
function publicProfileUrl(value, platform) {
  if (typeof value !== 'string' || value.length > 300 || value !== value.trim()) {
    fail(400, 'Укажите публичную ссылку на профиль');
  }
  let parsed;
  try { parsed = new URL(value); } catch { fail(400, 'Укажите корректную ссылку на профиль'); }
  const rule = SOCIAL_PROFILES[platform];
  if (parsed.protocol !== 'https:' || !rule.hosts.includes(parsed.hostname) || parsed.port ||
      parsed.username || parsed.password || parsed.search || parsed.hash || !rule.path.test(parsed.pathname)) {
    fail(400, 'Нужна публичная HTTPS-ссылка на профиль выбранной площадки без параметров и ключей');
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
}

function createActorOnboarding({ db, authStore, requireSession, requireCsrf, readJson, sendJson,
  now = () => new Date().toISOString() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS actor_onboarding_profiles (
    company_code TEXT NOT NULL COLLATE NOCASE,
    user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    profile_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (company_code, user_id)
  );
  CREATE TABLE IF NOT EXISTS actor_social_link_proposals (
    company_code TEXT NOT NULL COLLATE NOCASE,
    user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    public_url TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
    reviewed_by INTEGER REFERENCES auth_users(id) ON DELETE SET NULL,
    reviewed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (company_code, user_id, platform)
  );
  CREATE TABLE IF NOT EXISTS actor_onboarding_completion (
    company_code TEXT NOT NULL COLLATE NOCASE,
    user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    completed_at TEXT NOT NULL,
    PRIMARY KEY (company_code, user_id)
  );
  CREATE TABLE IF NOT EXISTS actor_onboarding_check_ins (
    company_code TEXT NOT NULL COLLATE NOCASE,
    user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    answers_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (company_code, user_id)
  );`);
  // Старые анкеты не хранили дату первого полного заполнения. Для уже полных
  // используем последнюю известную дату сохранения; дальше дата не сдвигается.
  const existing = db.prepare(`SELECT p.company_code,p.user_id,p.profile_json,p.updated_at
    FROM actor_onboarding_profiles p LEFT JOIN actor_onboarding_completion c
    ON c.company_code=p.company_code AND c.user_id=p.user_id WHERE c.user_id IS NULL`).all();
  for (const row of existing) {
    if (complete(JSON.parse(row.profile_json))) db.prepare(`INSERT OR IGNORE INTO
      actor_onboarding_completion(company_code,user_id,completed_at) VALUES(?,?,?)`)
      .run(row.company_code, row.user_id, row.updated_at);
  }

  // Перечитываем права на каждый запрос: прежняя cookie не сохраняет отозванный доступ.
  function access(request, code, permission) {
    const session = requireSession(request);
    const user = authStore.getById(session.user.id);
    if (!user || user.sessionVersion !== session.user.sessionVersion) fail(401, 'Требуется вход в кабинет');
    if (!Object.hasOwn(COMPANIES, code)) fail(404, 'Компания не найдена');
    if (user.role !== 'owner' && (!user.companyCodes.includes(code) || !user.permissions.includes(permission))) {
      fail(403, 'Нет доступа к этому разделу компании');
    }
    return { session, user };
  }
  function own(code, user) {
    const row = db.prepare(`SELECT revision,profile_json,created_at,updated_at
      FROM actor_onboarding_profiles WHERE company_code=? AND user_id=?`).get(code, user.id);
    return { companyCode: code, actorId: user.id, actorName: user.displayName,
      revision: row?.revision || 0, profile: row ? JSON.parse(row.profile_json) : { ...EMPTY },
      createdAt: row?.created_at || null, updatedAt: row?.updated_at || null, questions: QUESTIONS,
      cameraOptions: CAMERA, voiceOptions: VOICE };
  }
  function getOwnProfile(code, userId) {
    if (!Object.hasOwn(COMPANIES, code) || !Number.isSafeInteger(userId) || userId < 1) return null;
    const user = authStore.getById(userId);
    if (!user || (user.role !== 'owner' && (!user.companyCodes.includes(code) ||
        !user.permissions.includes('actor-onboarding.self')))) return null;
    const row = db.prepare(`SELECT profile_json FROM actor_onboarding_profiles
      WHERE company_code=? AND user_id=?`).get(code, userId);
    return row ? JSON.parse(row.profile_json) : null;
  }
  function checkInStatus(completedAt, savedAt) {
    const dueAt = completedAt ? new Date(Date.parse(completedAt) + CHECK_IN_DELAY).toISOString() : null;
    return { status: savedAt ? 'saved' : !dueAt ? 'not_ready' :
      Date.parse(now()) >= Date.parse(dueAt) ? 'due' : 'waiting',
    completedAt: completedAt || null, dueAt, savedAt: savedAt || null };
  }
  function ownCheckIn(code, user) {
    const completion = db.prepare(`SELECT completed_at FROM actor_onboarding_completion
      WHERE company_code=? AND user_id=?`).get(code, user.id);
    const row = db.prepare(`SELECT revision,answers_json,created_at,updated_at
      FROM actor_onboarding_check_ins WHERE company_code=? AND user_id=?`).get(code, user.id);
    return { companyCode: code, actorId: user.id,
      ...checkInStatus(completion?.completed_at, row?.updated_at), revision: row?.revision || 0,
      answers: row ? JSON.parse(row.answers_json) : { ...CHECK_IN_EMPTY },
      createdAt: row?.created_at || null, questions: CHECK_IN_QUESTIONS,
      comfortOptions: CHECK_IN_COMFORT };
  }
  function saveCheckIn(code, user, body) {
    requireShape(body, ['revision', 'answers']);
    if (!Number.isSafeInteger(body.revision) || body.revision < 0) fail(400, 'Некорректная версия ответов');
    requireShape(body.answers, CHECK_IN_QUESTIONS.map((item) => item.key));
    if (!CHECK_IN_COMFORT.includes(body.answers.comfort)) fail(400, 'Выберите, насколько вам комфортно');
    const answers = { comfort: body.answers.comfort,
      obstacles: cleanText(body.answers.obstacles, 2000, 'Что мешает'),
      improvements: cleanText(body.answers.improvements, 2000, 'Что улучшить'),
      nextStep: cleanText(body.answers.nextStep, 1000, 'Следующий шаг') };
    if (!answers.nextStep) fail(400, 'Укажите посильный следующий шаг или напишите, что нужна помощь с выбором');
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = ownCheckIn(code, user);
      if (current.status === 'not_ready' || current.status === 'waiting') {
        fail(409, 'Этот опрос станет доступен через 14 дней после заполнения основных ответов анкеты');
      }
      if (body.revision !== current.revision) fail(409, 'Ответы опроса уже изменились. Обновите их перед сохранением.');
      if (current.revision === 0 || JSON.stringify(current.answers) !== JSON.stringify(answers)) {
        const at = now();
        db.prepare(`INSERT INTO actor_onboarding_check_ins
          (company_code,user_id,revision,answers_json,created_at,updated_at) VALUES(?,?,1,?,?,?)
          ON CONFLICT(company_code,user_id) DO UPDATE SET
          revision=actor_onboarding_check_ins.revision+1,answers_json=excluded.answers_json,
          updated_at=excluded.updated_at`).run(code, user.id, JSON.stringify(answers), at, at);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return ownCheckIn(code, user);
  }
  function summary(code) {
    // Отозванные участники остаются в истории, но не показываются среди текущих.
    const rows = db.prepare(`SELECT p.user_id actorId,u.display_name actorName,p.revision,
      p.profile_json profileJson,p.updated_at updatedAt,c.completed_at completedAt,k.updated_at checkInSavedAt
      FROM actor_onboarding_profiles p JOIN auth_users u ON u.id=p.user_id
      LEFT JOIN actor_onboarding_completion c ON c.company_code=p.company_code AND c.user_id=p.user_id
      LEFT JOIN actor_onboarding_check_ins k ON k.company_code=p.company_code AND k.user_id=p.user_id
      LEFT JOIN auth_user_companies m ON m.user_id=u.id AND m.company_code=p.company_code
      LEFT JOIN auth_user_permissions a ON a.user_id=u.id AND a.permission='actor-onboarding.self'
      WHERE p.company_code=? AND (u.role='owner' OR (m.user_id IS NOT NULL AND a.user_id IS NOT NULL))
      ORDER BY u.display_name,p.user_id`).all(code);
    const participants = rows.map((row) => {
      const profile = JSON.parse(row.profileJson);
      return { actorId: row.actorId, actorName: row.actorName, revision: row.revision,
        direction: profile.direction, role: profile.role, cameraComfort: profile.cameraComfort,
        voiceComfort: profile.voiceComfort, hasBoundaries: Boolean(profile.boundaries),
        hasSuggestions: Boolean(profile.suggestions), updatedAt: row.updatedAt,
        checkIn: checkInStatus(row.completedAt, row.checkInSavedAt) };
    });
    return { companyCode: code, total: participants.length,
      ready: participants.filter((item) => item.direction && item.role &&
        item.cameraComfort !== 'unknown' && item.voiceComfort !== 'unknown').length,
      participants };
  }
  function ownSocialLinks(code, user) {
    const links = db.prepare(`SELECT platform,public_url publicUrl,revision,status,
      created_at createdAt,updated_at updatedAt,reviewed_at reviewedAt
      FROM actor_social_link_proposals WHERE company_code=? AND user_id=? ORDER BY platform`)
      .all(code, user.id);
    return { companyCode: code, actorId: user.id, platforms: Object.keys(SOCIAL_PROFILES), links,
      notice: 'Ссылка предложена для проверки. Публикация и статистика не подключаются автоматически.' };
  }
  function reviewSocialLinks(code) {
    const links = db.prepare(`SELECT p.user_id actorId,u.display_name actorName,p.platform,
      p.public_url publicUrl,p.revision,p.status,p.created_at createdAt,
      p.updated_at updatedAt,p.reviewed_at reviewedAt
      FROM actor_social_link_proposals p JOIN auth_users u ON u.id=p.user_id
      LEFT JOIN auth_user_companies m ON m.user_id=u.id AND m.company_code=p.company_code
      LEFT JOIN auth_user_permissions a ON a.user_id=u.id AND a.permission='actor-onboarding.self'
      WHERE p.company_code=? AND (u.role='owner' OR (m.user_id IS NOT NULL AND a.user_id IS NOT NULL))
      ORDER BY p.updated_at DESC,p.user_id,p.platform`).all(code);
    return { companyCode: code, links,
      notice: 'Подтверждение публичной ссылки не подключает аккаунт к публикации или аналитике.' };
  }
  function saveSocialLink(code, user, body) {
    requireShape(body, ['platform', 'publicUrl', 'revision']);
    const platform = socialPlatform(body.platform);
    const url = publicProfileUrl(body.publicUrl, platform);
    revision(body.revision);
    db.exec('BEGIN IMMEDIATE');
    try {
      const old = db.prepare(`SELECT revision,public_url publicUrl FROM actor_social_link_proposals
        WHERE company_code=? AND user_id=? AND platform=?`).get(code, user.id, platform);
      if (body.revision !== (old?.revision || 0)) fail(409, 'Ссылка уже изменилась. Обновите страницу.');
      if (!old || old.publicUrl !== url) {
        const at = now();
        db.prepare(`INSERT INTO actor_social_link_proposals
          (company_code,user_id,platform,public_url,revision,status,created_at,updated_at)
          VALUES(?,?,?,?,1,'pending',?,?) ON CONFLICT(company_code,user_id,platform) DO UPDATE SET
          public_url=excluded.public_url,revision=actor_social_link_proposals.revision+1,
          status='pending',reviewed_by=NULL,reviewed_at=NULL,updated_at=excluded.updated_at`)
          .run(code, user.id, platform, url, at, at);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return ownSocialLinks(code, user);
  }
  function removeSocialLink(code, user, body) {
    requireShape(body, ['platform', 'revision']);
    const platform = socialPlatform(body.platform);
    revision(body.revision);
    db.exec('BEGIN IMMEDIATE');
    try {
      const old = db.prepare(`SELECT revision FROM actor_social_link_proposals
        WHERE company_code=? AND user_id=? AND platform=?`).get(code, user.id, platform);
      if (!old) fail(404, 'Ссылка не найдена');
      if (body.revision !== old.revision) fail(409, 'Ссылка уже изменилась. Обновите страницу.');
      db.prepare(`DELETE FROM actor_social_link_proposals
        WHERE company_code=? AND user_id=? AND platform=?`).run(code, user.id, platform);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return ownSocialLinks(code, user);
  }
  function decideSocialLink(code, reviewer, body) {
    requireShape(body, ['actorId', 'platform', 'revision', 'decision']);
    if (!Number.isSafeInteger(body.actorId) || body.actorId < 1) fail(400, 'Участник не найден');
    const platform = socialPlatform(body.platform);
    revision(body.revision);
    if (!['approved', 'rejected'].includes(body.decision)) fail(400, 'Выберите решение');
    if (reviewer.id === body.actorId && reviewer.role !== 'owner') {
      fail(403, 'Свою ссылку должен подтвердить другой управляющий');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare(`SELECT p.revision,p.status FROM actor_social_link_proposals p
        JOIN auth_users u ON u.id=p.user_id
        LEFT JOIN auth_user_companies m ON m.user_id=u.id AND m.company_code=p.company_code
        LEFT JOIN auth_user_permissions a ON a.user_id=u.id AND a.permission='actor-onboarding.self'
        WHERE p.company_code=? AND p.user_id=? AND p.platform=?
          AND (u.role='owner' OR (m.user_id IS NOT NULL AND a.user_id IS NOT NULL))`)
        .get(code, body.actorId, platform);
      if (!current) fail(404, 'Ссылка участника не найдена');
      if (body.revision !== current.revision) fail(409, 'Ссылка уже изменилась. Обновите страницу.');
      if (current.status !== body.decision) {
        const at = now();
        db.prepare(`UPDATE actor_social_link_proposals SET status=?,revision=revision+1,
          reviewed_by=?,reviewed_at=?,updated_at=?
          WHERE company_code=? AND user_id=? AND platform=?`)
          .run(body.decision, reviewer.id, at, at, code, body.actorId, platform);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return reviewSocialLinks(code);
  }
  async function handle(request, response, url) {
    if (!['/content/actor-onboarding', '/content/actor-onboarding/summary',
      '/content/actor-onboarding/check-in',
      '/content/actor-onboarding/social-links',
      '/content/actor-onboarding/social-links/review'].includes(url.pathname)) return false;
    if ([...url.searchParams.keys()].some((key) => key !== 'companyCode')) fail(400, 'Лишние параметры запроса');
    const code = url.searchParams.get('companyCode');
    if (typeof code !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(code)) fail(400, 'Выберите компанию');
    if (url.pathname === '/content/actor-onboarding/check-in') {
      if (!['GET', 'PUT'].includes(request.method)) fail(405, 'Метод не поддерживается');
      const { session, user } = access(request, code, 'actor-onboarding.self');
      if (request.method === 'GET') sendJson(response, 200, ownCheckIn(code, user));
      else {
        requireCsrf(request, session);
        const body = await readJson(request);
        access(request, code, 'actor-onboarding.self');
        sendJson(response, 200, saveCheckIn(code, user, body));
      }
      return true;
    }
    if (url.pathname === '/content/actor-onboarding/social-links/review') {
      if (!['GET', 'PUT'].includes(request.method)) fail(405, 'Метод не поддерживается');
      const { session } = access(request, code, 'actor-onboarding.manage');
      if (request.method === 'GET') sendJson(response, 200, reviewSocialLinks(code));
      else {
        requireCsrf(request, session);
        const body = await readJson(request);
        const { user } = access(request, code, 'actor-onboarding.manage');
        sendJson(response, 200, decideSocialLink(code, user, body));
      }
      return true;
    }
    if (url.pathname === '/content/actor-onboarding/social-links') {
      if (!['GET', 'PUT', 'DELETE'].includes(request.method)) fail(405, 'Метод не поддерживается');
      const { session, user } = access(request, code, 'actor-onboarding.self');
      if (request.method === 'GET') sendJson(response, 200, ownSocialLinks(code, user));
      else {
        requireCsrf(request, session);
        const body = await readJson(request);
        access(request, code, 'actor-onboarding.self');
        sendJson(response, 200, request.method === 'PUT'
          ? saveSocialLink(code, user, body) : removeSocialLink(code, user, body));
      }
      return true;
    }
    if (url.pathname.endsWith('/summary')) {
      if (request.method !== 'GET') fail(405, 'Метод не поддерживается');
      access(request, code, 'actor-onboarding.manage');
      sendJson(response, 200, summary(code));
      return true;
    }
    if (!['GET', 'PUT'].includes(request.method)) fail(405, 'Метод не поддерживается');
    const { session, user } = access(request, code, 'actor-onboarding.self');
    if (request.method === 'GET') {
      sendJson(response, 200, own(code, user));
      return true;
    }
    requireCsrf(request, session);
    const body = await readJson(request);
    access(request, code, 'actor-onboarding.self');
    if (Object.keys(body).sort().join(',') !== 'profile,revision' ||
        !Number.isSafeInteger(body.revision) || body.revision < 0) fail(400, 'Некорректная версия опроса');
    const profile = normalizeProfile(body.profile);
    db.exec('BEGIN IMMEDIATE');
    try {
      const old = db.prepare(`SELECT revision,profile_json FROM actor_onboarding_profiles
        WHERE company_code=? AND user_id=?`).get(code, user.id);
      const revision = old?.revision || 0;
      if (body.revision !== revision) fail(409, 'Ответы уже изменились. Обновите страницу.');
      if (!old || old.profile_json !== JSON.stringify(profile)) {
        const at = now();
        db.prepare(`INSERT INTO actor_onboarding_profiles
          (company_code,user_id,revision,profile_json,created_at,updated_at)
          VALUES(?,?,1,?,?,?) ON CONFLICT(company_code,user_id) DO UPDATE SET
          revision=actor_onboarding_profiles.revision+1,profile_json=excluded.profile_json,
          updated_at=excluded.updated_at`).run(code, user.id, JSON.stringify(profile), at, at);
      }
      if (complete(profile)) db.prepare(`INSERT OR IGNORE INTO actor_onboarding_completion
        (company_code,user_id,completed_at) VALUES(?,?,?)`).run(code, user.id, now());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    sendJson(response, 200, own(code, user));
    return true;
  }
  return { handle, getOwnProfile };
}

module.exports = { createActorOnboarding };

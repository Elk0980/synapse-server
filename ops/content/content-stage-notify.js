'use strict';
/* Рассылка уведомлений Контент-завода по матрице «этап × роль» (specs/214-notification-delivery).

   Источник этапа — сервер CRM (specs/209-cf-stages, действие people `contentStages`). Модуль сравнивает этап каждой
   идеи с последним запомненным снимком компании и на каждый реальный переход формирует событие
   {company, ideaId, from, to}. По матрице выбираются роли, по ролям — люди этой компании.

   Выключатель — `notificationDelivery` в настройках контента компании (по умолчанию 'off'):
   - off   — компания не опрашивается, снимок и отметка первого запуска сбрасываются;
   - trial — пробный режим: в журнал пишется, что ушло бы и кому, без постановки в очередь;
   - on    — сообщение ставится в существующую очередь people (people-notifications.js: согласие человека,
             канал push/Telegram из его профиля, уникальность события, глобальный выключатель PEOPLE_NOTIFICATIONS_*).
   Первый проход после включения только запоминает этапы. Появление новой идеи — не переход этапа.
   Новых каналов, ботов и секретов модуль не заводит и сам ничего наружу не отправляет. */
const { NOTIFY_STAGES } = require('./content-settings');

const LABELS = Object.freeze({ draft: 'Черновик', script_review: 'Сценарий на согласовании', script_rework: 'Сценарий на доработке',
  planned: 'Запланировано', shot: 'Отснято', editing: 'В монтаже', edit_review: 'Монтаж на согласовании',
  edit_rework: 'Монтаж на доработке', ready: 'Готово к выходу', scheduled: 'Запланировано к выходу', published: 'Опубликовано',
  publish_error: 'Ошибка публикации', unpublished: 'Снято с публикации' });
const ROUTE = '/content/content-stage-notify/log';
const DEFAULT_CABINET = 'https://synapse.synapsebusiness.ru/cabinet.html';
const IDEA = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KEY = /^cf-stage:([a-z0-9][a-z0-9_-]{0,63}):([A-Za-z0-9][A-Za-z0-9_-]{0,99}):(\d{1,9}):([a-z_]{1,20})$/;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const clean = (value, max) => String(value ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function createContentStageNotify({ db, authStore, settings, call, notifications = null, shootingFacts = () => '',
  now = Date.now, cabinetUrl = process.env.CABINET_PUBLIC_URL || DEFAULT_CABINET, peopleDeliveryEnabled = false,
  requireSession = null, sendJson = null, intervalMs = 60000 } = {}) {
  if (!db || !authStore || !settings || typeof call !== 'function') throw new Error('Нужны база, учётные записи, настройки и источник этапов');
  db.exec(`CREATE TABLE IF NOT EXISTS content_stage_baseline (
      company_code TEXT PRIMARY KEY, epoch INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS content_stage_snapshot (
      company_code TEXT NOT NULL, idea_id TEXT NOT NULL, stage TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL, PRIMARY KEY(company_code, idea_id));
    CREATE TABLE IF NOT EXISTS content_stage_notify_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL, event_key TEXT NOT NULL, idea_id TEXT NOT NULL,
      from_stage TEXT NOT NULL, to_stage TEXT NOT NULL, user_id INTEGER NOT NULL DEFAULT 0, roles TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('trial','on')), status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(company_code, event_key, user_id));
    CREATE INDEX IF NOT EXISTS content_stage_notify_log_company ON content_stage_notify_log(company_code, id);`);
  const stamp = () => new Date(now()).toISOString();
  const link = `${String(cabinetUrl).split('#')[0]}#content/plan`;
  let timer = null, active = null, stopping = false;

  // Роль → люди компании. Владелец — учётные записи-владельцы с доступом к компании; согласующий — выбор «Участники»;
  // контент/съёмка/монтажёр — назначение в «Участники». Человек без доступа к компании пропускается.
  function recipients(code, config, stage) {
    const out = new Map();
    const add = (id, role) => {
      const user = authStore.getById(id);
      if (!user || !Array.isArray(user.companyCodes) || !user.companyCodes.includes(code)) return;
      if (!out.has(id)) out.set(id, new Set());
      out.get(id).add(role);
    };
    for (const role of config.matrix?.[stage] || []) {
      const ids = role === 'owner' ? authStore.list().filter((u) => u.role === 'owner' && u.companyCodes.includes(code)).map((u) => u.id)
        : role === 'approver' ? config.approverUserIds || [] : config.rolePeople?.[role] || [];
      for (const id of ids) add(id, role);
    }
    return out;
  }
  const sourceOwner = (code) => authStore.list().filter((u) => u.role === 'owner' && u.companyCodes.includes(code)).sort((a, b) => a.id - b.id)[0] || null;
  function factsFor(code) {
    let header = '';
    try { header = shootingFacts(code) || ''; } catch { return { header: '', truncated: true }; }
    if (!header) return { header: '', truncated: false };
    let value = null;
    try { value = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')); } catch { /* битый — как обрезанный */ }
    return { header, truncated: !value || value.truncated === true };
  }
  const reset = (code) => {
    db.prepare('DELETE FROM content_stage_snapshot WHERE company_code=?').run(code);
    db.prepare('DELETE FROM content_stage_baseline WHERE company_code=?').run(code);
  };
  const message = (idea, from, to) => ({
    title: clean(`№${idea.number} ${clean(idea.topic, 100) || 'без темы'}`, 120),
    body: clean(`Новый этап: ${LABELS[to] || to} (было: ${LABELS[from] || from}). Открыть в кабинете: ${link}`, 1000) });

  // Один проход по одной компании. Возвращает число событий (переходов), записанных в журнал.
  async function scanCompany(code) {
    const config = settings.delivery(code);
    if (config.mode === 'off') { reset(code); return 0; }
    const owner = sourceOwner(code);
    if (!owner) return 0;
    const facts = factsFor(code);
    // Обрезанные/недоступные факты съёмки дали бы ложный откат «Отснято → Запланировано». Ждём следующего прохода.
    if (facts.truncated) return 0;
    const data = await call('contentStages', facts.header ? { shootingFacts: facts.header } : {}, owner, code);
    if (!data || data.companyCode !== code || !Array.isArray(data.ideas)) fail(502, 'Источник этапов вернул другой проект');
    if (facts.header && data.shooting !== true) return 0;
    const ideas = data.ideas.filter((idea) => idea && IDEA.test(String(idea.ideaId)) && Object.hasOwn(LABELS, idea.stage)
      && Number.isSafeInteger(idea.number) && idea.number > 0);
    // Режим могли переключить, пока шёл запрос к CRM: решение принимается по свежему выбору.
    const fresh = settings.delivery(code);
    if (fresh.mode === 'off') { reset(code); return 0; }
    let events = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      const baseline = db.prepare('SELECT epoch FROM content_stage_baseline WHERE company_code=?').get(code);
      if (!baseline || baseline.epoch !== fresh.epoch) {
        // Первый проход после включения: только запомнить этапы, ничего не формировать.
        reset(code);
        const insert = db.prepare('INSERT INTO content_stage_snapshot(company_code,idea_id,stage,seq,updated_at) VALUES(?,?,?,0,?)');
        for (const idea of ideas) insert.run(code, idea.ideaId, idea.stage, stamp());
        db.prepare('INSERT INTO content_stage_baseline(company_code,epoch,created_at) VALUES(?,?,?)').run(code, fresh.epoch ?? 0, stamp());
        db.exec('COMMIT');
        return 0;
      }
      const seen = new Set();
      for (const idea of ideas) {
        if (seen.has(idea.ideaId)) continue;
        seen.add(idea.ideaId);
        const prev = db.prepare('SELECT stage, seq FROM content_stage_snapshot WHERE company_code=? AND idea_id=?').get(code, idea.ideaId);
        if (!prev) {
          // Новая идея — запомнить; появление в плане само по себе не переход этапа.
          db.prepare('INSERT INTO content_stage_snapshot(company_code,idea_id,stage,seq,updated_at) VALUES(?,?,?,0,?)').run(code, idea.ideaId, idea.stage, stamp());
          continue;
        }
        if (prev.stage === idea.stage) continue;
        const seq = prev.seq + 1, from = prev.stage, to = idea.stage;
        db.prepare('UPDATE content_stage_snapshot SET stage=?, seq=?, updated_at=? WHERE company_code=? AND idea_id=?').run(to, seq, stamp(), code, idea.ideaId);
        events++;
        if (!NOTIFY_STAGES.includes(to)) continue; // этапы вне матрицы (черновик, в монтаже, …) — только запомнить
        const eventKey = `cf-stage:${code}:${idea.ideaId}:${seq}:${to}`, text = message(idea, from, to);
        const log = db.prepare(`INSERT OR IGNORE INTO content_stage_notify_log(company_code,event_key,idea_id,from_stage,to_stage,user_id,roles,mode,status,reason,title,body,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        const people = recipients(code, fresh, to);
        if (!people.size) { log.run(code, eventKey, idea.ideaId, from, to, 0, '', fresh.mode, 'no_recipients', 'Для этапа в матрице нет назначенных людей', text.title, text.body, stamp()); continue; }
        for (const [userId, roles] of people) {
          let status = 'trial', reason = '';
          if (fresh.mode === 'on') {
            if (!notifications) { status = 'not_configured'; reason = 'Очередь уведомлений не подключена'; }
            // Глобальная доставка people выключена — не копить очередь, которая уйдёт пачкой при включении.
            else if (peopleDeliveryEnabled !== true) { status = 'server_off'; reason = 'Отправка уведомлений на сервере выключена'; }
            else {
              try {
                const queued = notifications.enqueue({ userId, companyCode: code, eventKey, title: text.title, body: text.body, url: '/cabinet.html#content/plan' }).queued;
                status = queued > 0 ? 'queued' : 'no_channel';
                if (!queued) reason = 'Человек не включил уведомления (push/Telegram) в своём профиле';
              } catch (error) { status = 'denied'; reason = clean(error.message || 'Нет права получать уведомления', 200); }
            }
          }
          log.run(code, eventKey, idea.ideaId, from, to, userId, [...roles].join(','), fresh.mode, status, reason, text.title, text.body, stamp());
        }
      }
      // Идеи, ушедшие из плана, забываются.
      for (const row of db.prepare('SELECT idea_id FROM content_stage_snapshot WHERE company_code=?').all(code)) {
        if (!seen.has(row.idea_id)) db.prepare('DELETE FROM content_stage_snapshot WHERE company_code=? AND idea_id=?').run(code, row.idea_id);
      }
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* уже откатано */ } throw error; }
    return events;
  }

  function runOnce() {
    if (stopping) return Promise.resolve({ companies: 0 });
    if (active) return active;
    active = (async () => {
      const codes = new Set(settings.deliveryCompanies());
      // Выключенные компании: сбросить остатки снимка, чтобы повторное включение снова начиналось без рассылки.
      for (const row of db.prepare('SELECT company_code FROM content_stage_baseline').all()) if (!codes.has(row.company_code)) reset(row.company_code);
      let scanned = 0;
      for (const code of codes) {
        if (stopping) break;
        try { await scanCompany(code); scanned++; } catch { /* ошибка чтения — не событие; повтор на следующем проходе */ }
      }
      return { companies: scanned };
    })().finally(() => { active = null; });
    return active;
  }

  // Проверка перед доставкой из очереди people: событие актуально, режим «вкл.», человек всё ещё в нужной роли.
  function validateEvent({ userId, companyCode, eventKey }) {
    const match = KEY.exec(String(eventKey || ''));
    if (!match || match[1] !== companyCode) return false;
    const config = settings.delivery(companyCode);
    if (config.mode !== 'on') return false;
    const snap = db.prepare('SELECT stage, seq FROM content_stage_snapshot WHERE company_code=? AND idea_id=?').get(companyCode, match[2]);
    if (!snap || snap.seq !== Number(match[3]) || snap.stage !== match[4]) return false;
    return recipients(companyCode, config, match[4]).has(userId);
  }

  function log(userId, code) {
    if (typeof code !== 'string' || !CODE.test(code)) fail(400, 'Укажите компанию');
    if (!settings.canView(userId, code)) fail(403, 'Журнал видят владелец и настройщик компании');
    const config = settings.delivery(code);
    const baseline = db.prepare('SELECT created_at FROM content_stage_baseline WHERE company_code=?').get(code);
    const items = db.prepare(`SELECT id, idea_id ideaId, from_stage "from", to_stage "to", user_id userId, roles, mode, status, reason, title, body,
      created_at createdAt FROM content_stage_notify_log WHERE company_code=? ORDER BY id DESC LIMIT 50`).all(code).map((row) => {
      const person = row.userId ? authStore.getById(row.userId) : null;
      return { ...row, roles: row.roles ? row.roles.split(',') : [], person: row.userId ? (person?.displayName || person?.login || 'удалённый пользователь') : null };
    });
    return { companyCode: code, mode: config.mode, enabledAt: config.enabledAt, baselineAt: baseline?.created_at || null,
      peopleDeliveryEnabled: peopleDeliveryEnabled === true, labels: LABELS, items };
  }

  async function handle(request, response, url) {
    if (url.pathname !== ROUTE) return false;
    if (request.method !== 'GET') fail(405, 'Метод не поддерживается');
    const session = requireSession(request);
    sendJson(response, 200, log(session.user.id, url.searchParams.get('companyCode')));
    return true;
  }

  return { scanCompany, runOnce, validateEvent, log, handle, recipients,
    start() { if (timer || stopping) return; timer = setInterval(() => void runOnce().catch(() => {}), intervalMs); timer.unref?.(); },
    async stop() { stopping = true; clearInterval(timer); timer = null; await active; } };
}

module.exports = { createContentStageNotify, LABELS, ROUTE };

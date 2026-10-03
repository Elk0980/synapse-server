'use strict';

/* Личное напоминание от Хью участнику проекта (specs/083-project-chat-personal-reminders).

   Кому. Только участнику комнаты этой компании (не владельцу), у которого ровно одна привязка Telegram,
   подтверждённая владельцем кодом из Mini App, и подписанное Telegram разрешение писать лично
   (allows_write_to_pm) ТОГО ЖЕ бота: последнее по подписанному времени запуска наблюдение, запуск строго
   позже этой привязки и последнего отказа 403. Участие в группе разрешением не считается. Telegram ID не вводится руками и не угадывается: он берётся только из привязки.

   Что. Владелец пишет просьбу и чем важен ответ; сервер собирает текст с номером и названием задачи
   этой комнаты. Подпись Хью добавляет мост, как и в группе.

   Как уходит. Отдельная очередь personal:<n>; её получает только мост, объявивший capabilities=personal.
   В момент выдачи заново сверяются участник, задача (снятая — не отправляется), привязка, разрешение, бот.
   Ровно один sendMessage. Неизвестный исход НЕ повторяется (отправка не идемпотентна): запись остаётся
   uncertain. Отказ 403 виден владельцу и снимает разрешение до нового действия получателя.
   Никаких автоматических повторов, «через сутки» и запасной отправки в группу.

   Квитанция. Успех — только ответ Bot API с message_id и chat.id, равным получателю. */

const PERSONAL_JOB = /^personal:(\d{1,12})$/;
const PERSONAL_CAPABILITY = 'personal';
const REQUEST_LIMIT = 1500;
const DEPENDENCY_LIMIT = 500;
const LEASE = 10 * 60 * 1000;
const KEY = /^[a-zA-Z0-9_.:-]{8,128}$/;
const TELEGRAM_ID = /^[1-9]\d{0,19}$/;
const OPEN = ['pending', 'sending'];

const STATES = Object.freeze({
  ready: 'Можно отправить лично',
  no_link: 'Telegram участника не привязан: участник открывает чат проекта в Telegram, владелец привязывает его код',
  several_links: 'К участнику привязано несколько Telegram — личное напоминание не отправляется, оставьте одну привязку',
  no_permission: 'Нужно действие получателя: открыть чат проекта в Telegram, нажать «Разрешить Хью писать мне лично», затем закрыть чат и открыть его снова',
  stale_permission: 'Нужно действие получателя: не раньше чем через минуту после привязки открыть чат проекта в Telegram ещё раз (при необходимости нажать «Разрешить Хью писать мне лично» и открыть снова)',
  revoked: 'Telegram отказал в отправке (403) или получатель запретил: нужно его действие — открыть чат проекта, разрешить Хью писать и не раньше чем через минуту открыть чат снова',
  bot_disabled: 'Вход через Telegram не настроен: разрешение писать проверить нельзя',
});

const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, ...(code ? { code } : {}) }); };
const clean = (value, max, field) => {
  if (typeof value !== 'string' || value.length > max) fail(400, `Некорректное поле ${field}`);
  return value.replace(/\r\n?/g, '\n').trim();
};
const shortText = (value, max) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, max);

function createPersonalReminders({ db, tx, authStore, miniApp, assigned, isMember, companies,
  signature, partLimit, stamp = () => new Date().toISOString(), now = () => Date.now() }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_chat_personal_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_code TEXT NOT NULL REFERENCES project_chat_rooms(company_code),
      task_id INTEGER NOT NULL REFERENCES project_chat_tasks(id),
      recipient_user_id INTEGER NOT NULL, telegram_user_id TEXT NOT NULL, bot_id TEXT NOT NULL,
      link_at TEXT NOT NULL, access_auth_date INTEGER NOT NULL,
      request_text TEXT NOT NULL, dependency TEXT NOT NULL, text TEXT NOT NULL,
      author_id TEXT NOT NULL, client_reminder_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','uncertain','error')),
      attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', forbidden INTEGER NOT NULL DEFAULT 0,
      telegram_message_id TEXT, telegram_chat_id TEXT,
      created_at TEXT NOT NULL, claimed_at TEXT, finished_at TEXT,
      UNIQUE(company_code, client_reminder_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS project_chat_personal_reminders_open
      ON project_chat_personal_reminders(company_code, recipient_user_id, task_id) WHERE status IN ('pending','sending');
    CREATE INDEX IF NOT EXISTS project_chat_personal_reminders_queue ON project_chat_personal_reminders(status, id);
  `);
  const textLimit = partLimit - signature.length - 1;

  /* Состояние получателя. Разрешение засчитывается только для текущего бота, только по подписанному запуску
     не раньше чем через минуту после текущей привязки (с учётом допустимого опережения часов Telegram),
     принятому после неё, и без более свежего отказа: отвязка, новая привязка и 403 требуют нового входа
     получателя (критерий — miniApp.writeAccessState, общий с Mini App). */
  function eligibility(code, user) {
    const base = { userId: user.id, displayName: user.displayName };
    if (!miniApp.enabled) return { ...base, state: 'bot_disabled' };
    const links = miniApp.linksOfUser(user.id);
    if (!links.length) return { ...base, state: 'no_link' };
    if (links.length > 1) return { ...base, state: 'several_links' };
    const [link] = links;
    const result = { ...base, telegramUserId: link.telegram_user_id, linkedAt: link.linked_at };
    // Тот же критерий, что показывает получателю Mini App: подписанный запуск позже привязки, без более свежего отказа.
    const state = miniApp.writeAccessState(link.telegram_user_id, link.linked_at);
    if (state !== 'ready') return { ...result, state };
    return { ...result, state: 'ready', botId: miniApp.botId, accessAuthDate: miniApp.writeAccess(link.telegram_user_id).auth_date };
  }
  // Получатели — участники этой комнаты, кроме владельцев: напоминание адресуется сотруднику компании.
  const memberOf = (code, user) => Boolean(user && user.role !== 'owner' && assigned(user, code) && isMember(user, code));
  function recipients(code) {
    return authStore.list().filter(user => memberOf(code, user)).map(user => {
      const value = eligibility(code, user);
      return { userId: value.userId, displayName: value.displayName, state: value.state, stateLabel: STATES[value.state],
        ...(value.telegramUserId ? { telegramUserId: value.telegramUserId } : {}) };
    });
  }
  const taskRef = (task) => `№${task.external_ref ? task.external_ref : task.id}`;
  function compose(code, task, request, dependency) {
    const project = companies[code]?.name || code;
    return `Напоминание по задаче ${taskRef(task)} «${shortText(task.title, 200)}» (проект ${project}).\n${request}\nОт вашего ответа зависит: ${dependency}`;
  }
  function view(row) {
    const recipient = authStore.getById(row.recipient_user_id);
    return { id: row.id, taskId: row.task_id, recipientUserId: row.recipient_user_id,
      recipientName: recipient?.displayName || 'Участник вне проекта', telegramUserId: row.telegram_user_id,
      text: row.text, status: row.status, error: row.error, forbidden: row.forbidden === 1,
      telegramMessageId: row.telegram_message_id || null, createdAt: row.created_at, finishedAt: row.finished_at || null };
  }
  function list(code, taskId = null) {
    const rows = taskId
      ? db.prepare('SELECT * FROM project_chat_personal_reminders WHERE company_code=? AND task_id=? ORDER BY id DESC LIMIT 50').all(code, taskId)
      : db.prepare('SELECT * FROM project_chat_personal_reminders WHERE company_code=? ORDER BY id DESC LIMIT 50').all(code);
    return rows.map(view);
  }

  function create(code, body, author) {
    const fields = ['recipientUserId', 'taskId', 'text', 'dependency', 'expectedTelegramUserId', 'clientReminderId'];
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !fields.includes(k))) fail(400, 'Неизвестное поле напоминания');
    const recipientId = Number(body.recipientUserId), taskId = Number(body.taskId);
    if (!Number.isSafeInteger(recipientId) || recipientId < 1 || !Number.isSafeInteger(taskId) || taskId < 1) fail(400, 'Некорректный получатель или задача');
    const request = clean(body.text ?? '', REQUEST_LIMIT, 'text');
    const dependency = clean(body.dependency ?? '', DEPENDENCY_LIMIT, 'dependency');
    if (!request) fail(400, 'Напишите, о чём напоминание');
    if (!dependency) fail(400, 'Укажите, что зависит от ответа');
    const expected = String(body.expectedTelegramUserId ?? '');
    if (!TELEGRAM_ID.test(expected)) fail(400, 'Нужен Telegram получателя из привязки');
    const clientId = clean(body.clientReminderId ?? '', 128, 'clientReminderId');
    if (!KEY.test(clientId)) fail(400, 'Нужен уникальный идентификатор напоминания');
    return tx(() => {
      const old = db.prepare('SELECT * FROM project_chat_personal_reminders WHERE company_code=? AND client_reminder_id=?').get(code, clientId);
      if (old) {
        if (old.recipient_user_id !== recipientId || old.task_id !== taskId || old.request_text !== request || old.dependency !== dependency
          || old.telegram_user_id !== expected || old.author_id !== String(author.id)) fail(409, 'Этот идентификатор уже использован для другого напоминания');
        return { reminder: view(old), duplicate: true };
      }
      const recipient = authStore.getById(recipientId);
      if (!memberOf(code, recipient) || recipient.id === author.id) fail(404, 'Получатель не найден среди участников этого проекта');
      const task = db.prepare('SELECT * FROM project_chat_tasks WHERE id=? AND company_code=?').get(taskId, code);
      if (!task) fail(404, 'Задача не найдена в этом проекте');
      if (task.status === 'cancelled') fail(409, 'Задача снята — напоминать по ней не нужно');
      const state = eligibility(code, recipient);
      if (state.state !== 'ready') fail(409, STATES[state.state], state.state);
      if (state.telegramUserId !== expected) fail(409, 'Привязка Telegram получателя изменилась. Обновите окно', 'link_changed');
      if (db.prepare(`SELECT 1 FROM project_chat_personal_reminders WHERE company_code=? AND recipient_user_id=? AND task_id=? AND status IN ('pending','sending')`)
        .get(code, recipientId, taskId)) fail(409, 'Напоминание этому участнику по этой задаче уже отправляется');
      const text = compose(code, task, request, dependency);
      if (text.length > textLimit) fail(400, `Текст длиннее одного сообщения Telegram: не больше ${textLimit} символов вместе с номером задачи`);
      const at = stamp();
      const id = Number(db.prepare(`INSERT INTO project_chat_personal_reminders
        (company_code,task_id,recipient_user_id,telegram_user_id,bot_id,link_at,access_auth_date,request_text,dependency,text,author_id,client_reminder_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(code, taskId, recipientId, expected, state.botId, state.linkedAt, state.accessAuthDate,
        request, dependency, text, String(author.id), clientId, at).lastInsertRowid);
      return { reminder: view(db.prepare('SELECT * FROM project_chat_personal_reminders WHERE id=?').get(id)), duplicate: false };
    });
  }

  /* Условия перепроверяются непосредственно при выдаче мосту: участник, актуальное состояние задачи
     (снятая после постановки — не напоминается), привязка, разрешение и бот. Пустая строка — можно отправлять. */
  function dispatchBlocker(row) {
    const recipient = authStore.getById(row.recipient_user_id);
    if (!memberOf(row.company_code, recipient)) return 'Получатель больше не участник проекта; не отправлено';
    const task = db.prepare('SELECT status FROM project_chat_tasks WHERE id=? AND company_code=?').get(row.task_id, row.company_code);
    if (!task) return 'Задача не найдена; не отправлено';
    if (task.status === 'cancelled') return 'Задача снята после постановки напоминания; не отправлено';
    const state = eligibility(row.company_code, recipient);
    if (state.state !== 'ready') return `${STATES[state.state]}; не отправлено`;
    if (state.telegramUserId !== row.telegram_user_id || state.linkedAt !== row.link_at) return 'Привязка Telegram получателя изменилась; не отправлено';
    if (state.botId !== row.bot_id) return 'Бот сменился; не отправлено';
    return '';
  }
  // Вызывается внутри транзакции выдачи заданий: условия перепроверяются в момент отправки.
  function pending() {
    const at = stamp();
    // Истёкшая аренда: исход неизвестен, сообщение могло уйти. Повтора нет.
    db.prepare(`UPDATE project_chat_personal_reminders SET status='uncertain',claimed_at=NULL,finished_at=?,
      error='Нет подтверждения отправки от Telegram; повтор не выполняется' WHERE status='sending' AND claimed_at<?`)
      .run(at, new Date(now() - LEASE).toISOString());
    for (;;) {
      const row = db.prepare("SELECT * FROM project_chat_personal_reminders WHERE status='pending' ORDER BY id LIMIT 1").get();
      if (!row) return null;
      const blocker = dispatchBlocker(row);
      if (blocker) {
        db.prepare("UPDATE project_chat_personal_reminders SET status='error',error=?,finished_at=?,claimed_at=NULL WHERE id=?").run(blocker, at, row.id);
        continue;
      }
      db.prepare("UPDATE project_chat_personal_reminders SET status='sending',claimed_at=?,attempts=attempts+1 WHERE id=?").run(at, row.id);
      return { id: `personal:${row.id}`, kind: 'personal', companyCode: row.company_code, chatId: row.telegram_user_id,
        botId: row.bot_id, text: row.text, authorType: 'assistant', authorName: 'Хью' };
    }
  }

  const isJob = (jobId) => PERSONAL_JOB.test(String(jobId));
  function acknowledge(jobId, result = {}) {
    const id = Number(PERSONAL_JOB.exec(String(jobId))[1]);
    return tx(() => {
      const row = db.prepare('SELECT * FROM project_chat_personal_reminders WHERE id=?').get(id);
      if (!row) fail(404, 'Напоминание не найдено');
      if (row.status === 'sent') return { ok: true, status: 'sent' };
      const at = stamp();
      const confirmed = result.ok === true && /^\d{1,20}$/.test(String(result.messageId ?? '')) && String(result.chatId ?? '') === row.telegram_user_id;
      // Подтверждение доставки засчитывается и после истёкшей аренды: оно правдиво.
      if (confirmed && ['sending', 'pending', 'uncertain'].includes(row.status)) {
        db.prepare("UPDATE project_chat_personal_reminders SET status='sent',error='',telegram_message_id=?,telegram_chat_id=?,finished_at=?,claimed_at=NULL WHERE id=?")
          .run(String(result.messageId), String(result.chatId), at, row.id);
        return { ok: true, status: 'sent' };
      }
      if (row.status !== 'sending') return { ok: false, status: row.status };
      if (result.ok === true || result.uncertain || !Object.hasOwn(result, 'ok')) {
        // ok без подтверждения этого получателя или неизвестный исход: сообщение могло уйти — без повтора.
        db.prepare("UPDATE project_chat_personal_reminders SET status='uncertain',error=?,finished_at=?,claimed_at=NULL WHERE id=?")
          .run(result.ok === true ? 'Telegram не подтвердил доставку именно этому получателю' : shortText(result.error || 'Нет подтверждения отправки от Telegram', 300), at, row.id);
        return { ok: false, status: 'uncertain' };
      }
      const forbidden = result.forbidden === true;
      const error = forbidden
        ? 'Telegram запретил отправку (403): получатель не разрешил боту писать или заблокировал его — нужно действие получателя'
        : shortText(result.error || 'Telegram отказал в отправке', 300);
      db.prepare("UPDATE project_chat_personal_reminders SET status='error',error=?,forbidden=?,finished_at=?,claimed_at=NULL WHERE id=?")
        .run(error, forbidden ? 1 : 0, at, row.id);
      if (forbidden) miniApp.revokeWriteAccess(row.telegram_user_id, row.bot_id, 'telegram_403');
      return { ok: false, status: 'error' };
    });
  }

  return { recipients, list, create, pending, acknowledge, isJob, states: STATES, textLimit };
}

module.exports = { createPersonalReminders, PERSONAL_CAPABILITY, PERSONAL_JOB, REQUEST_LIMIT, DEPENDENCY_LIMIT };

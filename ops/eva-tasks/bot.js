'use strict';

const { randomBytes } = require('node:crypto');

const PAGE_SIZE = 6;
const PROJECT_PAGE_SIZE = 8;
const CACHE_LIMIT = 2048;
const CALLBACK_TTL_MS = 30 * 60 * 1000;
const UPDATE_TTL_MS = 60 * 60 * 1000;
const CABINET_URL = 'https://synapse.synapsebusiness.ru/cabinet.html#tasks';
const CLOSED = new Set(['done', 'cancelled']);
const STATUSES = Object.freeze({
  inbox: 'Входящие', planned: 'Запланирована', in_progress: 'В работе',
  done: 'Завершена', cancelled: 'Отменена',
});

function text(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim();
}

function clip(value, limit) {
  const clean = text(value);
  if (clean.length <= limit) return clean;
  let end = limit - 1;
  if (/[\uD800-\uDBFF]/.test(clean[end - 1])) end -= 1;
  return clean.slice(0, end) + '…';
}

function line(value, limit) {
  return clip(text(value).replace(/\s+/g, ' '), limit);
}

function validId(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00.000Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function trimCache(cache, nowMs, ttl) {
  for (const [key, value] of cache) {
    if (nowMs - value.createdAt >= ttl || cache.size > CACHE_LIMIT) cache.delete(key);
  }
}

/**
 * Read-only Telegram UI. The source must expose only the configured owner's
 * authorized task scope. This module performs no network or persistence I/O.
 * audit receives an allowlisted event name only, never task or Telegram text.
 */
function createBot({ ownerUserId, source, timeZone, now = () => new Date(), audit = () => {} } = {}) {
  const owner = typeof ownerUserId === 'string' && /^[1-9]\d*$/.test(ownerUserId)
    ? Number(ownerUserId) : ownerUserId;
  if (!validId(owner)) throw new TypeError('A valid numeric ownerUserId is required');
  if (!source || typeof source.listTasks !== 'function') throw new TypeError('A task source is required');
  if (typeof now !== 'function' || typeof audit !== 'function') throw new TypeError('Invalid callbacks');
  if (typeof timeZone !== 'string' || !timeZone.trim()) throw new TypeError('An IANA timeZone is required');
  const dateFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const callbacks = new Map();
  const seenUpdates = new Map();

  async function record(event) {
    try { await audit(event); } catch { /* Observability cannot override access control. */ }
  }

  function localDay(date) {
    const parts = Object.fromEntries(dateFormat.formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function dueDay(value) {
    const due = text(value);
    if (validDay(due)) return due;
    // Reject timezone-free datetimes and invalid calendar dates; no host-local parsing.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(due)
      || !validDay(due.slice(0, 10))) return null;
    const parsed = new Date(due);
    return Number.isNaN(parsed.getTime()) ? null : localDay(parsed);
  }

  // SQLite's built-in NOCASE folds ASCII A-Z; preserve non-ASCII distinctions.
  function companyKey(code) { return code.replace(/[A-Z]/g, character => character.toLowerCase()); }
  function taskKey(task) { return JSON.stringify([companyKey(task.companyCode), task.id]); }

  function snapshot(raw) {
    if (!Array.isArray(raw)) throw new TypeError('Invalid task source response');
    const keys = new Set();
    return raw.map(item => {
      if (!item || typeof item !== 'object' || !text(item.id)) throw new TypeError('Invalid task');
      const task = {
        id: text(item.id), title: text(item.title) || 'Без названия',
        companyCode: text(item.companyCode), companyName: text(item.companyName),
        status: text(item.status), dueAt: text(item.dueAt),
        nextAction: text(item.nextAction), blocker: text(item.blocker),
        waitingForOwner: item.waitingForOwner === true,
      };
      const key = taskKey(task);
      if (keys.has(key)) throw new TypeError('Duplicate task identity');
      keys.add(key);
      return task;
    });
  }

  function projectName(task) { return task.companyName || task.companyCode || 'Без проекта'; }
  function statusName(task) { return Object.hasOwn(STATUSES, task.status) ? STATUSES[task.status] : task.status || 'Не указан'; }
  function waitsForOwner(task) { return task.waitingForOwner && !CLOSED.has(task.status); }
  function dueLabel(task, today) {
    const day = dueDay(task.dueAt);
    if (!day) return task.dueAt ? 'Срок не распознан' : 'Без срока';
    return day + (!CLOSED.has(task.status) && day < today ? ' · просрочена' : '');
  }

  function button(label, action, nowMs) {
    const key = randomBytes(12).toString('base64url');
    callbacks.set(key, { action, createdAt: nowMs });
    trimCache(callbacks, nowMs, CALLBACK_TTL_MS);
    return { text: line(label, 64), callback_data: `eva:${key}` };
  }

  function homeButton(nowMs) { return button('⌂ Главная', { view: 'home' }, nowMs); }
  function cabinetButton() { return { text: 'Открыть кабинет', url: CABINET_URL }; }

  function sorted(tasks) {
    return [...tasks].sort((a, b) => Number(CLOSED.has(a.status)) - Number(CLOSED.has(b.status))
      || (dueDay(a.dueAt) || '9999-99-99').localeCompare(dueDay(b.dueAt) || '9999-99-99')
      || projectName(a).localeCompare(projectName(b), 'ru')
      || a.title.localeCompare(b.title, 'ru') || taskKey(a).localeCompare(taskKey(b)));
  }

  function filtered(tasks, state, today) {
    if (state.view === 'today') return sorted(tasks.filter(task => !CLOSED.has(task.status)
      && dueDay(task.dueAt) && dueDay(task.dueAt) <= today));
    if (state.view === 'waiting') return sorted(tasks.filter(waitsForOwner));
    if (state.view === 'project') return sorted(tasks.filter(task => companyKey(task.companyCode) === companyKey(state.companyCode)));
    return sorted(tasks);
  }

  function pagination(page, pages, state, nowMs) {
    const row = [];
    if (page > 0) row.push(button('← Предыдущая', { ...state, page: page - 1 }, nowMs));
    if (page + 1 < pages) row.push(button('Следующая →', { ...state, page: page + 1 }, nowMs));
    return row;
  }

  function renderHome(tasks, nowMs, today) {
    return {
      text: 'Eva · SynapseBusiness\n\nИсточник: задачи CRM Synapse.\n'
        + 'Другие списки чатов могут содержать ещё не связанные задачи.\n\n'
        + 'Выберите список. Изменить задачу можно в кабинете Synapse.',
      keyboard: [
        [button(`Сегодня · ${filtered(tasks, { view: 'today' }, today).length}`, { view: 'today', page: 0 }, nowMs),
          button('Проекты', { view: 'projects', page: 0 }, nowMs)],
        [button(`Все задачи · ${tasks.length}`, { view: 'all', page: 0 }, nowMs),
          button(`Ждут меня · ${tasks.filter(waitsForOwner).length}`, { view: 'waiting', page: 0 }, nowMs)],
        [cabinetButton()],
      ],
    };
  }

  function renderProjects(tasks, state, nowMs) {
    const grouped = new Map();
    for (const task of tasks) {
      const key = companyKey(task.companyCode);
      if (!grouped.has(key)) grouped.set(key, { name: projectName(task), count: 0 });
      grouped.get(key).count += 1;
    }
    const projects = [...grouped].sort((a, b) => a[1].name.localeCompare(b[1].name, 'ru'));
    const pages = Math.max(1, Math.ceil(projects.length / PROJECT_PAGE_SIZE));
    const page = Math.min(state.page || 0, pages - 1);
    const rows = projects.slice(page * PROJECT_PAGE_SIZE, (page + 1) * PROJECT_PAGE_SIZE)
      .map(([companyCode, project]) => [button(`${project.name} · ${project.count}`,
        { view: 'project', companyCode, page: 0, projectPage: page }, nowMs)]);
    const pager = pagination(page, pages, { view: 'projects' }, nowMs);
    if (pager.length) rows.push(pager);
    rows.push([homeButton(nowMs)]);
    return { text: 'Проекты\n\n' + (projects.length
      ? `Выберите проект с задачами.\nСтраница ${page + 1} из ${pages}.`
      : 'Пока нет проектов с задачами.'), keyboard: rows };
  }

  function renderList(tasks, state, nowMs, today) {
    const selected = filtered(tasks, state, today);
    const pages = Math.max(1, Math.ceil(selected.length / PAGE_SIZE));
    const page = Math.min(state.page || 0, pages - 1);
    const current = { ...state, page };
    const titles = { today: 'Сегодня', all: 'Все задачи', waiting: 'Ждут меня' };
    const heading = state.view === 'project'
      ? `Проект: ${line(selected.length ? projectName(selected[0]) : state.companyCode || 'Без проекта', 140)}`
      : titles[state.view];
    let description = state.view === 'today'
      ? `${today} · ${timeZone}\nОткрытые задачи на сегодня и просроченные.`
      : state.view === 'waiting' ? 'Задачи, явно ожидающие вашего действия.'
        : state.view === 'all' ? 'Все задачи CRM, включая завершённые и отменённые.'
          : 'Задачи CRM, включая завершённые и отменённые.';
    const empty = state.view === 'today' ? 'Нет открытых задач со сроком на сегодня или ранее.'
      : state.view === 'waiting' ? 'Нет задач, явно ожидающих вашего действия.'
        : state.view === 'project' ? 'В этом проекте пока нет задач.' : 'Пока нет задач.';
    const shown = selected.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const rows = shown.map((task, index) => [button(`${page * PAGE_SIZE + index + 1}. ${task.title}`,
      { view: 'task', key: taskKey(task), back: current }, nowMs)]);
    const entries = shown.map((task, index) => `${page * PAGE_SIZE + index + 1}. ${line(task.title, 150)}\n`
      + `${line(projectName(task), 80)} · ${line(statusName(task), 60)} · ${dueLabel(task, today)}\n`
      + `Далее: ${line(task.nextAction, 90) || 'Не указан'}`);
    const pager = pagination(page, pages, current, nowMs);
    if (pager.length) rows.push(pager);
    rows.push(state.view === 'project'
      ? [button('‹ Проекты', { view: 'projects', page: state.projectPage || 0 }, nowMs), homeButton(nowMs)]
      : [homeButton(nowMs)]);
    if (selected.length) description += `\nВсего: ${selected.length}. Страница ${page + 1} из ${pages}.`;
    return { text: `${heading}\n${description}\n\n${entries.length ? entries.join('\n\n') : empty}`, keyboard: rows };
  }

  function renderTask(tasks, state, nowMs, today) {
    // Never retain task contents in callback state; resolve id + company afresh.
    const task = tasks.find(candidate => taskKey(candidate) === state.key);
    if (!task) return null;
    const project = projectName(task) + (task.companyCode && task.companyName ? ` (${task.companyCode})` : '');
    return {
      text: `${clip(task.title, 650)}\n\nID: CRM #${line(task.id, 128)}\nПроект: ${line(project, 180)}\n`
        + `Статус: ${line(statusName(task), 90)}\nСрок: ${dueLabel(task, today)}\n\n`
        + `Следующий шаг:\n${clip(task.nextAction, 1600) || 'Не указан'}\n\n`
        + `Блокер:\n${clip(task.blocker, 500) || 'Нет записи'}\n\n`
        + (waitsForOwner(task) ? 'Ожидает вашего действия.\n' : '')
        + 'Изменить задачу можно в кабинете Synapse.',
      keyboard: [[button('‹ Назад', state.back, nowMs), homeButton(nowMs)], [cabinetButton()]],
    };
  }

  function renderError(state, nowMs) {
    return {
      text: 'Задачи сейчас недоступны.\n\nНе удалось прочитать данные Synapse. Попробуйте ещё раз.',
      keyboard: [[button('Повторить', state, nowMs), homeButton(nowMs)]],
    };
  }

  function actionFor(view, callback, messageId) {
    return {
      method: callback ? 'editMessageText' : 'sendMessage',
      params: {
        chat_id: owner, ...(callback ? { message_id: messageId } : {}),
        text: clip(view.text, 4096),
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: view.keyboard },
      },
    };
  }

  async function handleUpdate(update) {
    if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) return [];
    const callback = update.callback_query;
    const message = callback ? callback.message : update.message;
    const sender = callback ? callback.from : message && message.from;
    if (!message || !sender || !validId(sender.id) || sender.id !== owner
      || !message.chat || message.chat.type !== 'private' || message.chat.id !== owner
      || !validId(message.chat.id) || !validId(message.message_id)
      || message.forward_origin || message.forward_date || message.forward_from
      || message.forward_from_chat || message.forward_sender_name || message.is_automatic_forward
      || (callback && (callback.inline_message_id || typeof callback.id !== 'string'
        || !callback.id || callback.id.length > 256))) {
      await record('access_denied');
      return [];
    }
    const instant = new Date(now());
    if (Number.isNaN(instant.getTime())) throw new TypeError('Invalid clock');
    const nowMs = instant.getTime();
    trimCache(seenUpdates, nowMs, UPDATE_TTL_MS);
    if (seenUpdates.has(update.update_id)) {
      await record('duplicate_update');
      return [];
    }
    // Claim synchronously before awaiting the source: concurrent duplicates are suppressed.
    seenUpdates.set(update.update_id, { createdAt: nowMs });
    trimCache(seenUpdates, nowMs, UPDATE_TTL_MS);
    trimCache(callbacks, nowMs, CALLBACK_TTL_MS);
    let state = { view: 'home' };
    if (callback) {
      const data = callback.data;
      const key = typeof data === 'string' && Buffer.byteLength(data, 'utf8') <= 64
        && /^eva:[A-Za-z0-9_-]{16}$/.test(data) ? data.slice(4) : null;
      const stored = key && callbacks.get(key);
      if (!stored) {
        await record('stale_callback');
        return [{ method: 'answerCallbackQuery', params: { callback_query_id: callback.id,
          text: 'Кнопка устарела или недействительна. Откройте /tasks.', show_alert: true } }];
      }
      state = stored.action;
    } else if (typeof message.text !== 'string'
      || !/^\/(?:start|tasks)(?:@[A-Za-z0-9_]+)?(?:\s.*)?$/s.test(message.text.trim())) return [];

    const today = localDay(instant);
    let view;
    try {
      const tasks = snapshot(await source.listTasks());
      view = state.view === 'home' ? renderHome(tasks, nowMs, today)
        : state.view === 'projects' ? renderProjects(tasks, state, nowMs)
          : state.view === 'task' ? renderTask(tasks, state, nowMs, today)
            : renderList(tasks, state, nowMs, today);
    } catch {
      await record('source_error');
      view = renderError(state, nowMs);
    }
    if (!view) {
      await record('stale_callback');
      return [{ method: 'answerCallbackQuery', params: { callback_query_id: callback.id,
        text: 'Задача больше недоступна. Откройте /tasks, чтобы обновить список.', show_alert: true } }];
    }
    await record('navigation');
    const actions = callback
      ? [{ method: 'answerCallbackQuery', params: { callback_query_id: callback.id } }] : [];
    actions.push(actionFor(view, callback, message.message_id));
    return actions;
  }

  return { handleUpdate };
}

module.exports = { createBot };

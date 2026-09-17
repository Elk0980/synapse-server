(() => {
  "use strict";
  const cabinet = window.SbCabinet = window.SbCabinet || {};
  const statuses = { todo: "Новая", in_progress: "В работе", done: "Готово", blocked: "Нужна помощь" };
  const delivery = { local: "В чате проекта", pending: "Ожидает отправки в Telegram", sending: "Отправляется в Telegram…", sent: "Отправлено в Telegram", error: "Не отправлено в Telegram", uncertain: "Доставка в Telegram уточняется" };
  const TITLE_LIMIT = 200, PAGE = 100;
  // Локальный обработчик отдаёт ссылку и код входа не сразу: команда уходит на компьютер Хью.
  const LOGIN_POLL_MS = 3000, LOGIN_POLLS = 40;
  // Ответ ИИ помечается всегда одинаково: участники видят, что пишет бот, а не Влад.
  const AI_BADGE = "ИИ · бизнес-ассистент Синапс Бизнес";
  let current;
  const list = value => Array.isArray(value) ? value : [];
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const date = value => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };
  const identifier = () => crypto.randomUUID();
  const assetUrl = value => {
    try {
      const url = new URL(value, location.origin);
      return url.origin === location.origin && url.pathname.startsWith("/content/project-chat/") ? url.href : "";
    } catch (_) { return ""; }
  };
  const active = state => current === state && !state.controller.signal.aborted && state.ctx.selectedProjectId === state.company && state.ctx.currentView === "hugh";
  // A shared view generation invalidates callbacks started before a tab switch, so a late
  // upload or send never writes into a rebuilt (or private) panel.
  const live = (state, view) => active(state) && !state.revoked && state.mode === "shared" && state.view === view;
  const q = (state, selector) => state.root?.querySelector(selector) || null;
  const request = async (state, suffix = "", options = {}, absolute = false) => {
    if (!active(state)) throw new DOMException("Запрос отменён", "AbortError");
    // timeoutMs — наш параметр, а не поле fetch: запрос входа ждёт дольше обычного,
    // потому что сервер выдаёт код устройства не мгновенно.
    const { timeoutMs, ...init } = options;
    const response = await fetch(absolute ? suffix : state.base + suffix, {
      credentials: "same-origin", cache: "no-store", ...init,
      signal: AbortSignal.any([state.controller.signal, AbortSignal.timeout(timeoutMs || (init.body instanceof Blob ? 45000 : 20000))]),
      headers: { "Content-Type": "application/json", ...(init.method && init.method !== "GET" ? { "X-CSRF-Token": state.ctx.identity.csrfToken } : {}), ...init.headers }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(response.status === 403 ? "Доступ к чату проекта не назначен. Владелец проекта может добавить вас в участники."
        : response.status === 401 ? "Сессия завершена. Войдите в кабинет заново."
        : data.error || "Не удалось выполнить запрос. Попробуйте ещё раз.");
      error.status = response.status;
      throw error;
    }
    if (!active(state)) throw new DOMException("Запрос отменён", "AbortError");
    return data;
  };
  const write = (state, path, method, body) => request(state, path, { method, body: JSON.stringify(body) });
  const denied = error => error.status === 401 || error.status === 403;
  const notice = (state, text, error = false) => {
    const node = q(state, "[data-pc-notice]");
    if (node) { node.textContent = text; node.classList.toggle("pc-error", error); }
  };
  const options = (items, selected, empty) => `<option value="">${escape(empty)}</option>` + items.map(([id, title]) => `<option value="${escape(id)}"${String(id) === String(selected) ? " selected" : ""}>${escape(title)}</option>`).join("");
  const FORMER_NOTE = "бывший участник";
  const chosen = id => id !== null && id !== undefined && id !== "";
  const activeMember = (state, id) => list(state.data?.members).some(member => String(member.userId) === String(id));
  const personName = (state, id) => [...list(state.data?.members), ...list(state.data?.formerMembers)]
    .find(person => String(person.userId) === String(id))?.displayName || "";
  // Исполнитель мог выйти из проекта: историю назначения показываем и помечаем, а не стираем.
  const assigneeLabel = (state, task) => {
    if (!chosen(task.assigneeId)) return "Не назначен";
    const name = task.assigneeName || personName(state, task.assigneeId) || "Участник вне проекта";
    const active = task.assigneeActive === undefined ? activeMember(state, task.assigneeId) : task.assigneeActive !== false;
    return active ? name : `${name} (${FORMER_NOTE})`;
  };
  // Вышедшего исполнителя оставляем в списке только его собственной задачи, чтобы правка
  // соседнего поля не обнулила назначение. Назначить нового бывшего участника нельзя.
  const assigneeOptions = (state, task) => {
    const items = list(state.data.members).map(member => [member.userId, member.displayName]);
    if (chosen(task.assigneeId) && !activeMember(state, task.assigneeId)) {
      items.push([task.assigneeId, `${task.assigneeName || personName(state, task.assigneeId) || "Участник вне проекта"} (${FORMER_NOTE})`]);
    }
    return options(items, task.assigneeId, "Не назначен");
  };
  const stageName = (state, id) => list(state.data?.stages).find(stage => String(stage.id) === String(id))?.title || "Без этапа";
  const canReply = state => state.data?.access?.canReply === true;
  const isOwner = state => state.data?.access?.owner === true;
  // Снимок приносит только последнее окно переписки, поэтому кабинет хранит объединение
  // всего, что уже показал в этой комнате: иначе сообщение, выпавшее из окна, исчезло бы.
  const timeline = state => state.history;
  const pageMore = data => data?.hasMore === true || data?.history?.hasMore === true;
  const mergeMessages = (state, incoming, older) => {
    const fresh = [];
    for (const item of list(incoming)) {
      const id = String(item.id);
      const known = state.seen.get(id);
      if (known) {
        // Обновления доставки и ответа Хью приходят под тем же ID: правим запись на месте.
        for (const key of Object.keys(known)) if (!(key in item)) delete known[key];
        Object.assign(known, item);
      } else {
        const stored = { ...item };
        state.seen.set(id, stored);
        fresh.push(stored);
      }
    }
    if (fresh.length) {
      if (older) state.history.unshift(...fresh);
      else state.history.push(...fresh);
    }
    return fresh.length;
  };
  const absorbSnapshot = (state, snapshot) => {
    const batch = list(snapshot.messages);
    if (state.history.length && batch.length && !batch.some(item => state.seen.has(String(item.id)))) {
      // Новых сообщений между опросами больше, чем помещается в окно: непрерывной ленты
      // уже нет, начинаем историю заново, чтобы не склеить её с разрывом посередине.
      state.history = [];
      state.seen = new Map();
      state.loadedOlder = false;
    }
    mergeMessages(state, batch, false);
    // «Есть ещё старее» из снимка относится к его собственному окну: после подгрузки
    // более ранних страниц этот признак берётся только из их ответов.
    if (!state.loadedOlder) state.hasMore = pageMore(snapshot);
    state.cursor = state.history[0]?.id ?? null;
  };
  const aiInfo = state => {
    const ai = state.data?.ai || {};
    return { ...ai, connected: ai.connected === true || ai.runtimeState === "connected", limited: ai.limited === true };
  };
  const waitText = seconds => {
    const total = Math.round(Number(seconds));
    if (!Number.isFinite(total) || total <= 0) return "";
    if (total < 60) return "меньше чем через минуту";
    const minutes = Math.round(total / 60);
    if (minutes < 60) return `примерно через ${minutes} мин`;
    const hours = Math.floor(minutes / 60), rest = minutes % 60;
    return `примерно через ${hours} ч${rest ? ` ${rest} мин` : ""}`;
  };
  // Пояснение сервера видно всем участникам комнаты, поэтому ссылку входа или код
  // владельца в общую строку не пропускаем: они показываются только в настройках.
  const safeReason = value => {
    const reason = String(value ?? "").replace(/\s+/g, " ").trim();
    return !reason || /https?:\/\/|www\.|[A-Z0-9]{4}-[A-Z0-9]{4}/i.test(reason) ? "" : reason.slice(0, 200);
  };
  const aiSummary = state => {
    const ai = aiInfo(state);
    if (!ai.connected) {
      const reason = !ai.configured ? "Автоматические ответы Хью пока не подключены."
        : ai.runtimeState === "offline" ? "Компьютер Хью сейчас не на связи: вопросы к нему ждут его возвращения."
        : ai.runtimeState === "login_pending" ? "Хью ждёт, пока владелец подтвердит вход."
        : ai.runtimeState === "connecting" ? "Хью подключается к подписке Codex…"
        : ai.runtimeState === "login_required" ? "Хью ждёт подтверждения входа владельцем."
        : ai.runtimeState === "unavailable" ? "Сервис ответов Хью сейчас недоступен."
        : "Хью пока не подключён.";
      return `${reason} Переписка, файлы и задачи проекта работают.${ai.queued ? ` Ожидают ответа: ${ai.queued}.` : ""}`;
    }
    const waiting = Number(ai.queued) || 0, failed = Number(ai.failed) || 0;
    if (ai.limited) {
      // Подписка подключена, но исчерпан лимит: отвечать прямо сейчас Хью не может.
      const wait = waitText(ai.retryAfter);
      return [
        "Хью сейчас не отвечает: достигнут предел подписки.",
        safeReason(ai.waitingReason),
        wait ? `Повторим ${wait}.` : "",
        waiting ? `Ждут ответа: ${waiting}.` : "",
        failed ? `Не удалось ответить: ${failed}.` : "",
        waiting || failed
          ? "Сохранённые вопросы Хью обработает автоматически, когда ограничение снимется."
          : "Переписка, файлы и задачи проекта работают."
      ].filter(Boolean).join(" ");
    }
    const parts = [state.data?.room?.replyMode === "delegate" ? "Хью заменяет Влада в обсуждении." : "Хью отвечает по обращению."];
    if (waiting) parts.push(`Готовит ответы: ${waiting}.`);
    if (failed) parts.push(`Не удалось ответить: ${failed}.`);
    return parts.join(" ");
  };
  const attachmentHTML = attachment => {
    const url = assetUrl(attachment.url);
    if (!url) return `<span class="pc-attachment-missing pc-muted">${escape(attachment.name || "Файл")} · ${escape(attachment.note || "файл доступен только в Telegram")}</span>`;
    return `<a class="pc-attachment" href="${escape(url)}" target="_blank" rel="noopener">${/^image\/(jpeg|png|webp|gif)$/i.test(attachment.mime || "") ? `<img src="${escape(url)}" alt="${escape(attachment.name || "Фотография")}" loading="lazy">` : ""}<span>${escape(attachment.name || "Открыть файл")}</span></a>`;
  };
  const aiNoteHTML = (message, ai) => {
    if (["pending", "queued", "running"].includes(message.aiStatus)) {
      return !ai.connected ? (ai.runtimeState === "offline"
        ? '<small class="pc-muted">Ответ Хью появится, когда его компьютер снова будет на связи. Вопрос сохранён.</small>'
        : '<small class="pc-muted">Ответ Хью появится после подключения подписки.</small>')
        : ai.limited ? '<small class="pc-muted">Ответ Хью отложен до снятия ограничения подписки. Вопрос сохранён.</small>'
        : '<small class="pc-muted">Хью готовит ответ…</small>';
    }
    if (["failed", "error"].includes(message.aiStatus)) return '<small class="pc-error">Хью пока не ответил. Сообщение сохранено.</small>';
    return "";
  };
  const messagesHTML = state => {
    const ai = aiInfo(state), reply = canReply(state);
    return timeline(state).map(message => `<li class="pc-message${message.authorType === "assistant" ? " pc-message-ai" : ""}" data-message-id="${escape(message.id)}">
    <div class="pc-message-meta"><strong>${escape(message.authorName || (message.authorType === "assistant" ? "Хью" : "Участник"))}</strong>${message.authorType === "assistant" ? `<span class="pc-ai-badge">${AI_BADGE}</span>` : ""}<time datetime="${escape(message.createdAt)}">${escape(date(message.createdAt))}</time>${message.authorType === "telegram" ? '<span>Telegram</span>' : ""}</div>
    ${message.text ? `<p class="pc-message-text">${escape(message.text)}</p>` : ""}
    ${list(message.attachments).length ? `<div class="pc-attachments">${message.attachments.map(attachmentHTML).join("")}</div>` : ""}
    <div class="pc-message-footer"><small${message.deliveryStatus === "error" ? ' class="pc-error"' : ""}>${escape(delivery[message.deliveryStatus] || "")}</small>${reply ? `<button type="button" data-pc-message-task="${escape(message.id)}">В задачу</button>` : ""}</div>
    ${aiNoteHTML(message, ai)}
  </li>`).join("") || '<li class="pc-empty">Здесь будет общая переписка участников проекта.</li>';
  };
  const renderSnapshot = (state, view) => {
    if (!live(state, view) || !state.data) return;
    const data = state.data, root = state.root, history = q(state, "[data-pc-messages]");
    if (!history) return;
    const ai = aiInfo(state);
    const signature = JSON.stringify([timeline(state), data.access?.canReply, ai.connected, ai.limited, ai.runtimeState]);
    if (signature !== state.messageSignature) {
      const follow = !state.messageSignature || history.scrollHeight - history.scrollTop - history.clientHeight < 100;
      const previous = history.scrollTop;
      history.innerHTML = messagesHTML(state);
      history.scrollTop = follow ? history.scrollHeight : previous;
      state.messageSignature = signature;
    }
    const older = q(state, "[data-pc-older]");
    if (older) { older.hidden = !state.hasMore || !state.cursor; older.disabled = state.loadingOlder; }
    q(state, "[data-pc-members]").textContent = list(data.members).map(member => member.displayName).join(", ") || "Участники пока не назначены";
    q(state, "[data-pc-connection]").textContent = data.room?.telegramChatId ? "Telegram привязан к проекту. Состояние доставки показано у сообщений." : "Telegram пока не привязан";
    q(state, "[data-pc-ai]").textContent = aiSummary(state);
    q(state, "[data-pc-retry-ai]").hidden = !(isOwner(state) && Number(ai.failed) > 0);
    q(state, "[data-pc-compose]").hidden = !canReply(state);
    q(state, "[data-pc-readonly]").hidden = canReply(state);
    root.querySelectorAll("[data-pc-owner]").forEach(node => { node.hidden = !isOwner(state); });
    root.querySelectorAll("[data-pc-write]").forEach(node => { node.hidden = !canReply(state); });
    const tasksSignature = JSON.stringify([data.tasks, data.stages, data.members, data.formerMembers, data.access]);
    if (tasksSignature !== state.tasksSignature) {
      q(state, "[data-pc-tasks]").innerHTML = list(data.tasks).map(task => `<li class="pc-task${task.status === "done" ? " pc-task-done" : ""}"><button type="button" data-pc-task="${escape(task.id)}"><strong>${escape(task.title)}</strong><span>${escape(assigneeLabel(state, task))} · ${escape(stageName(state, task.stageId))}</span><small>${escape(statuses[task.status] || task.status)}${task.due ? " · " + escape(task.due) : ""}</small></button></li>`).join("") || '<li class="pc-empty">Из сообщения можно создать задачу, назначить исполнителя и срок.</li>';
      q(state, "[data-pc-task-count]").textContent = String(list(data.tasks).filter(task => task.status !== "done").length);
      state.tasksSignature = tasksSignature;
    }
  };
  const clearHistory = (state, message) => {
    const history = q(state, "[data-pc-messages]");
    if (history) history.innerHTML = `<li class="pc-empty">${escape(message)} <button type="button" data-pc-refresh>Проверить доступ</button></li>`;
    const tasks = q(state, "[data-pc-tasks]");
    if (tasks) tasks.innerHTML = '<li class="pc-empty">Задачи проекта недоступны.</li>';
    ["[data-pc-task-count]", "[data-pc-members]", "[data-pc-connection]", "[data-pc-ai]", "[data-pc-sync]"].forEach(selector => {
      const node = q(state, selector);
      if (node) node.textContent = "";
    });
  };
  // A revoked membership or session must not leave the previous project history on screen.
  const revoke = (state, message) => {
    state.revoked = true;
    state.data = null;
    state.history = [];
    state.seen = new Map();
    state.loadedOlder = false;
    state.hasMore = false;
    state.cursor = null;
    state.messageSignature = "";
    state.tasksSignature = "";
    state.attempt = null;
    state.attachments = [];
    state.draft = "";
    state.loadingOlder = false;
    clearTimeout(state.timer);
    clearTimeout(state.loginTimer);
    state.root.querySelectorAll("dialog").forEach(dialog => dialog.remove());
    const compose = q(state, "[data-pc-compose]");
    if (compose) {
      compose.hidden = true;
      compose.querySelectorAll("button,input,textarea").forEach(node => { node.disabled = true; });
      const input = compose.querySelector("textarea");
      if (input) { input.value = ""; input.readOnly = true; }
    }
    const readonly = q(state, "[data-pc-readonly]");
    if (readonly) { readonly.hidden = false; readonly.textContent = message; }
    state.root.querySelectorAll("[data-pc-owner],[data-pc-write],[data-pc-older]").forEach(node => { node.hidden = true; });
    const pending = q(state, "[data-pc-pending]");
    if (pending) pending.innerHTML = "";
    clearHistory(state, message);
    notice(state, message, true);
  };
  const refresh = async (state, view) => {
    if (!live(state, view)) return;
    const sequence = ++state.readSequence;
    const snapshot = await request(state);
    if (!live(state, view) || sequence !== state.readSequence) return;
    state.data = snapshot;
    absorbSnapshot(state, snapshot);
    renderSnapshot(state, view);
  };
  const loadOlder = async (state, view) => {
    if (!live(state, view) || state.loadingOlder || !state.hasMore || !state.cursor) return;
    const button = q(state, "[data-pc-older]"), history = q(state, "[data-pc-messages]");
    state.loadingOlder = true;
    if (button) { button.disabled = true; button.textContent = "Загружаем более ранние…"; }
    try {
      const page = await request(state, `/messages?before=${encodeURIComponent(state.cursor)}&limit=${PAGE}`);
      if (!live(state, view)) return;
      const height = history ? history.scrollHeight : 0, top = history ? history.scrollTop : 0;
      const added = mergeMessages(state, page.messages, true);
      state.loadedOlder = true;
      // Страница, не добавившая ничего нового, дальше нас не продвинет: не зацикливаемся.
      state.hasMore = pageMore(page) && added > 0;
      state.cursor = state.history[0]?.id ?? null;
      state.messageSignature = "";
      state.loadingOlder = false;
      renderSnapshot(state, view);
      // Keep the message the reader was looking at in place after older history is prepended.
      if (history) history.scrollTop = top + (history.scrollHeight - height);
    } catch (error) {
      if (!live(state, view) || error.name === "AbortError") return;
      if (denied(error)) revoke(state, error.message);
      else notice(state, error.message, true);
    } finally {
      state.loadingOlder = false;
      // Корень общий для всех компаний: опоздавший ответ прежней комнаты не должен
      // вернуть свою кнопку в уже открытый чат другого проекта.
      const node = live(state, view) ? q(state, "[data-pc-older]") : null;
      if (node) { node.disabled = false; node.textContent = "Показать более ранние сообщения"; node.hidden = !state.hasMore || !state.cursor || state.revoked; }
    }
  };
  const schedule = (state, view) => {
    clearTimeout(state.timer);
    if (!live(state, view)) return;
    state.timer = setTimeout(async () => {
      if (!live(state, view)) return;
      if (!document.hidden) {
        try { await refresh(state, view); const sync = q(state, "[data-pc-sync]"); if (sync) sync.textContent = ""; }
        catch (error) {
          if (!live(state, view) || error.name === "AbortError") return;
          if (denied(error)) { revoke(state, error.message); return; }
          const sync = q(state, "[data-pc-sync]");
          if (sync) sync.textContent = "Не удалось обновить переписку. Повторим автоматически.";
        }
      }
      schedule(state, view);
    }, 5000);
  };
  const modal = (state, title, body) => {
    const dialog = document.createElement("dialog");
    dialog.className = "pc-dialog";
    dialog.innerHTML = `<header><h2>${escape(title)}</h2><button type="button" data-pc-close aria-label="Закрыть">×</button></header>${body}`;
    state.root.append(dialog);
    dialog.querySelector("[data-pc-close]").onclick = () => { clearTimeout(state.loginTimer); dialog.close(); dialog.remove(); };
    dialog.addEventListener("close", () => dialog.remove());
    dialog.showModal();
    return dialog;
  };
  const formSave = (state, dialog, handler) => {
    const view = state.view;
    const form = dialog.querySelector("form"), submit = form.querySelector('[type="submit"]');
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (submit.disabled || !live(state, view)) return;
      submit.disabled = true;
      const result = form.querySelector('[role="alert"]');
      result.textContent = "";
      try { await handler(form); if (!live(state, view)) return; dialog.close(); await refresh(state, view); }
      catch (error) {
        if (!live(state, view) || error.name === "AbortError") return;
        if (denied(error)) { revoke(state, error.message); return; }
        if (dialog.isConnected) result.textContent = error.message;
      }
      finally { submit.disabled = false; }
    });
  };
  const taskDialog = (state, task = {}, source) => {
    if (!state.data) return;
    const writable = canReply(state);
    const prefill = task.title || source?.text?.split("\n")[0]?.slice(0, TITLE_LIMIT) || "";
    const dialog = modal(state, task.id ? "Задача проекта" : "Новая задача", `<form class="pc-fields"><label>Название<input name="title" required maxlength="${TITLE_LIMIT}" value="${escape(prefill)}"></label>
      <label>Исполнитель<select name="assigneeId">${assigneeOptions(state, task)}</select></label>
      <label>Этап<select name="stageId">${options(list(state.data.stages).map(stage => [stage.id, stage.title]), task.stageId, "Без этапа")}</select></label>
      <label>Срок<input name="due" type="date" value="${escape(task.due || "")}"></label>
      <label>Статус<select name="status">${Object.entries(statuses).map(([id, title]) => `<option value="${id}"${(task.status || "todo") === id ? " selected" : ""}>${title}</option>`).join("")}</select></label>
      ${source || task.sourceMessageId ? '<p class="pc-muted">Задача связана с сообщением в этом проекте.</p>' : ""}
      <button type="submit"${writable ? "" : " hidden"}>Сохранить задачу</button><p role="alert"></p></form>`);
    if (!writable) dialog.querySelectorAll("input,select").forEach(node => { node.disabled = true; });
    formSave(state, dialog, form => {
      const fields = form.elements;
      const title = fields.title.value.trim().slice(0, TITLE_LIMIT);
      if (!title) throw new Error("Укажите название задачи");
      if (fields.due.value && !/^\d{4}-\d{2}-\d{2}$/.test(fields.due.value)) throw new Error("Укажите срок в формате даты");
      if (!Object.hasOwn(statuses, fields.status.value)) throw new Error("Выберите статус задачи");
      const assigneeId = Number(fields.assigneeId.value) || null;
      if (assigneeId && !activeMember(state, assigneeId) && String(assigneeId) !== String(task.assigneeId ?? "")) {
        throw new Error("Этот участник вышел из проекта. Выберите активного исполнителя.");
      }
      const payload = { title, assigneeId, stageId: Number(fields.stageId.value) || null, due: fields.due.value || null, status: fields.status.value };
      if (!task.id) payload.sourceMessageId = source?.id || null;
      return write(state, task.id ? `/tasks/${task.id}` : "/tasks", task.id ? "PATCH" : "POST", payload);
    });
  };
  const stagesDialog = state => {
    if (!canReply(state)) return;
    const dialog = modal(state, "Этапы проекта", `<ul class="pc-stage-list">${list(state.data.stages).map(stage => `<li><span>${escape(stage.title)}</span><button type="button" data-pc-edit-stage="${escape(stage.id)}">Изменить</button></li>`).join("")}</ul><form class="pc-fields"><label>Новый этап<input name="title" maxlength="${TITLE_LIMIT}" required></label><button type="submit">Добавить этап</button><p role="alert"></p></form>`);
    formSave(state, dialog, form => write(state, "/stages", "POST", { title: form.elements.title.value.trim().slice(0, TITLE_LIMIT) }));
    dialog.querySelectorAll("[data-pc-edit-stage]").forEach(button => { button.onclick = () => {
      const stage = list(state.data.stages).find(item => String(item.id) === button.dataset.pcEditStage);
      if (!stage) return;
      dialog.close();
      const editor = modal(state, "Изменить этап", `<form class="pc-fields"><label>Название<input name="title" value="${escape(stage.title)}" maxlength="${TITLE_LIMIT}" required></label><button type="submit">Сохранить</button><p role="alert"></p></form>`);
      formSave(state, editor, form => write(state, `/stages/${stage.id}`, "PATCH", { title: form.elements.title.value.trim().slice(0, TITLE_LIMIT) }));
    }; });
  };
  const membersDialog = async state => {
    if (!isOwner(state)) return;
    const view = state.view;
    try {
      const data = await request(state, "/candidates");
      if (!live(state, view)) return;
      const selected = new Set(list(state.data.members).map(member => String(member.userId)));
      const dialog = modal(state, "Участники проекта", `<form class="pc-fields"><p>Участники видят всю переписку и фотографии этого проекта.</p><p class="pc-muted">Это доступ только в кабинете. Состав Telegram-группы задаётся в самом Telegram: если убрать человека здесь, он продолжит читать группу, пока его не удалят там.</p>${list(data.candidates).map(member => `<label class="pc-check"><input type="checkbox" name="userIds" value="${escape(member.userId)}"${selected.has(String(member.userId)) ? " checked" : ""}>${escape(member.displayName)}</label>`).join("") || '<p>Нет учётных записей с доступом к этой компании.</p>'}<button type="submit">Сохранить участников</button><p role="alert"></p></form>`);
      formSave(state, dialog, form => write(state, "/members", "PUT", { userIds: [...form.querySelectorAll('[name="userIds"]:checked')].map(input => Number(input.value)) }));
    } catch (error) {
      if (!live(state, view) || error.name === "AbortError") return;
      if (denied(error)) revoke(state, error.message);
      else notice(state, error.message, true);
    }
  };
  // The backend owns the login flow, but the cabinet only ever offers the official device page.
  const loginLink = value => {
    try {
      const url = new URL(value);
      return url.origin === "https://auth.openai.com" && url.pathname.replace(/\/+$/, "") === "/codex/device" ? url.href : "";
    } catch (_) { return ""; }
  };
  // Код устройства выдаётся ровно в этом виде (device-login.js). Чужая строка кодом не считается.
  const deviceCode = value => /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(String(value ?? "")) ? String(value) : "";
  const CONNECT_HINT = "Нажмите «Подключить подписку»: сервер откроет вход и выдаст ссылку с кодом подтверждения.";
  // Пояснение сервера приходит без завершающей точки: дописываем, чтобы соседние фразы не слиплись.
  const sentence = value => {
    const text = String(value ?? "").replace(/\s*[.;:!?]+$/, "").trim();
    return text ? `${text}.` : "";
  };
  const LOCAL_HINT = "Нажмите «Подключить подписку»: команда уйдёт на компьютер Хью, а ссылка с кодом появится здесь.";
  // Локальный обработчик: подписка живёт на компьютере владельца, а не на сервере. Выключенный
  // компьютер — это ожидание, а не поломка, и просить подключить подписку заново в этот момент нельзя.
  const localRuntimeHTML = data => {
    const model = data.model ? ` Модель: ${escape(data.model)}.` : "";
    const detail = data.error ? ` ${escape(sentence(data.error))}` : "";
    const seen = data.lastSeen ? ` Последний сигнал: ${escape(date(data.lastSeen))}.` : " Сигналов от него ещё не было.";
    if (data.state === "offline") {
      return `Компьютер Хью сейчас не на связи.${seen}${data.loginPending ? " Команда входа сохранена и выполнится после его возвращения." : ""} Переписка, файлы и задачи проекта работают; вопросы к Хью ждут.`;
    }
    const url = loginLink(data.loginUrl), code = deviceCode(data.userCode);
    if (url && code) {
      return `<p>Откройте официальную страницу входа Codex и подтвердите подключение подписки этим кодом.</p><a href="${escape(url)}" target="_blank" rel="noopener">Войти в Codex</a><p>Код: <strong>${escape(code)}</strong></p>${data.expiresAt ? `<p class="pc-muted">Код действует до ${escape(date(data.expiresAt))}.</p>` : ""}`;
    }
    if (data.state === "login_pending") return "Запрос входа передан компьютеру Хью. Ссылка и код появятся здесь через несколько секунд…";
    if (data.connected === true && data.authenticated === true) {
      return data.state === "connected"
        ? `Подписка Codex подключена на компьютере Хью.${model}`
        : `Подписка Codex подключена на компьютере Хью, но ответы сейчас недоступны.${detail}${model} Переписка, файлы и задачи проекта работают.`;
    }
    return `Подписка Codex на компьютере Хью пока не подключена.${detail} ${LOCAL_HINT}`;
  };
  const runtimeHTML = data => {
    if (data.local === true) return localRuntimeHTML(data);
    const model = data.model ? ` Модель: ${escape(data.model)}.` : "";
    const detail = data.error ? ` ${escape(sentence(data.error))}` : "";
    // Вход выполнен — это ещё не «готово»: при исчерпанной квоте сервер оставляет
    // connected и authenticated истинными, но состояние уже не connected. Вход при этом
    // не сломан, поэтому подключать подписку заново здесь не предлагается.
    if (data.connected === true && data.authenticated === true) {
      return data.state === "connected"
        ? `Подписка Codex подключена к серверу.${model}`
        : `Подписка Codex подключена, но ответы сейчас недоступны.${detail}${model} Переписка, файлы и задачи проекта работают.`;
    }
    const url = loginLink(data.loginUrl), code = deviceCode(data.userCode);
    // Подтверждать вход есть чем только при паре «проверенная ссылка + код»: одна страница
    // без кода бесполезна, а код без официальной ссылки вести никуда нельзя.
    if (url && code) {
      return `<p>Откройте официальную страницу входа Codex и подтвердите подключение подписки этим кодом.</p><a href="${escape(url)}" target="_blank" rel="noopener">Войти в Codex</a><p>Код: <strong>${escape(code)}</strong></p>`;
    }
    if (data.state === "login_required" || url || data.userCode) {
      return `Подписка Codex пока не подключена. ${CONNECT_HINT}`;
    }
    if (data.state === "connecting") return "Подключение к Codex…";
    if (data.state === "unavailable") return `Сервис ответов Хью сейчас недоступен. Общая переписка, файлы и задачи работают.${detail}`;
    return `Подписка Codex пока не подключена. Общая переписка и задачи доступны.${detail} ${CONNECT_HINT}`;
  };
  const settingsDialog = async state => {
    if (!isOwner(state)) return;
    const view = state.view;
    const room = state.data.room || {};
    const dialog = modal(state, "Настройки чата", `<form class="pc-fields"><label>Когда отвечает Хью<select name="replyMode"><option value="addressed"${room.replyMode !== "delegate" ? " selected" : ""}>По обращению</option><option value="delegate"${room.replyMode === "delegate" ? " selected" : ""}>Заменять Влада</option></select></label><p class="pc-muted">В режиме «По обращению» начните сообщение с «Хью». В режиме замены Хью участвует в обсуждении проекта.</p><label>Telegram-группа<input name="telegramChatId" inputmode="numeric" placeholder="Например, -1001234567890" value="${escape(room.telegramChatId || "")}"></label><p class="pc-muted">Укажите ID рабочей группы, куда добавлен бот. Пустое поле отключает дублирование.</p><p class="pc-muted">Кто читает группу, решает Telegram. Список участников кабинета на это не влияет: удаление участника здесь не удаляет его из группы.</p><button type="submit">Сохранить настройки</button><p role="alert"></p></form><section class="pc-runtime"><h3>Ответы Хью через Codex</h3><div data-pc-runtime role="status">Проверяем подключение…</div><div class="pc-toolbar"><button type="button" data-pc-login>Подключить подписку</button><button type="button" data-pc-runtime-check>Проверить</button></div><p class="pc-muted">Наличие настроек ещё не означает подключение. Хью отвечает только при подтверждённом входе; недоступный источник не считается подключённым.</p></section>`);
    formSave(state, dialog, form => write(state, "/settings", "PATCH", { replyMode: form.elements.replyMode.value, telegramChatId: form.elements.telegramChatId.value.trim() }));
    // Опрос входа живёт не дольше диалога: закрытие окна снимает таймер.
    dialog.addEventListener("close", () => clearTimeout(state.loginTimer));
    // Компания уходит в запросе: для компании с локальным обработчиком сервер отвечает из его состояния.
    const statusPath = "/content/project-chat-runtime/status?companyCode=" + encodeURIComponent(state.company);
    const show = data => {
      dialog.querySelector("[data-pc-runtime]").innerHTML = runtimeHTML(data);
      // Локальный обработчик присылает ссылку и код следующим опросом: ждём, пока команда в работе.
      if (data.local === true && data.state === "login_pending" && state.loginPolls < LOGIN_POLLS) {
        state.loginTimer = setTimeout(() => { if (live(state, view) && dialog.isConnected) runtime(false, true); }, LOGIN_POLL_MS);
      }
    };
    const runtime = async (login, quiet = false) => {
      const buttons = dialog.querySelectorAll("[data-pc-login],[data-pc-runtime-check]");
      if (!quiet) buttons.forEach(button => { button.disabled = true; });
      clearTimeout(state.loginTimer);
      try {
        // Вход ждёт дольше проверки: сервер сначала запрашивает код устройства.
        const data = await request(state, login ? "/content/project-chat-runtime/login" : statusPath,
          login ? { method: "POST", body: JSON.stringify({ companyCode: state.company }), timeoutMs: 40000 } : {}, true);
        if (!live(state, view) || !dialog.isConnected) return;
        state.loginPolls = quiet ? state.loginPolls + 1 : 0;
        show(data);
      } catch (error) {
        if (error.name === "AbortError" || !live(state, view)) return;
        // Сессия или роль отозваны: код входа и опрос исчезают вместе с диалогом и комнатой.
        if (denied(error)) { revoke(state, error.message); return; }
        if (!dialog.isConnected) return;
        if (login && !Number.isInteger(error.status)) {
          // Потерянный ответ на запрос входа не доказывает, что команда не создана: сначала спрашиваем состояние.
          let data = null;
          try { data = await request(state, statusPath, {}, true); } catch (_) { data = null; }
          if (!live(state, view) || !dialog.isConnected) return;
          if (data && data.local === true && (data.state === "login_pending" || deviceCode(data.userCode))) { state.loginPolls = 0; show(data); return; }
        }
        // Пояснение сервера уже очищено и локализовано — показываем его как есть, не заменяя
        // догадкой. Если ответа не было вовсе, причина неизвестна, и так и говорим: выдавать
        // «временный сбой сети» за установленный факт нельзя, как и рассуждать про регион
        // или учётную запись владельца.
        const head = login ? "Подключение не начато" : "Проверка не удалась";
        const again = login ? "Повторите попытку." : "Повторите проверку.";
        const reported = Number.isInteger(error.status) ? sentence(error.message) : "";
        dialog.querySelector("[data-pc-runtime]").textContent = reported
          ? `${head}. ${reported} ${again}`
          : `${head}: ответ от сервера не получен, причина неизвестна. ${again}`;
      }
      finally { if (!quiet) buttons.forEach(button => { button.disabled = false; }); }
    };
    dialog.querySelector("[data-pc-login]").onclick = () => runtime(true);
    dialog.querySelector("[data-pc-runtime-check]").onclick = () => runtime(false);
    state.loginPolls = 0;
    await runtime(false);
  };
  const retryAI = async (state, view) => {
    if (!live(state, view) || !isOwner(state)) return;
    const button = q(state, "[data-pc-retry-ai]");
    if (button) button.disabled = true;
    try {
      await write(state, "/retry-ai", "POST", {});
      if (!live(state, view)) return;
      notice(state, "Хью попробует ответить ещё раз.");
      await refresh(state, view);
    } catch (error) {
      if (!live(state, view) || error.name === "AbortError") return;
      if (denied(error)) revoke(state, error.message);
      else notice(state, error.message, true);
    } finally { const node = live(state, view) ? q(state, "[data-pc-retry-ai]") : null; if (node) node.disabled = false; }
  };
  const renderPending = state => {
    const node = q(state, "[data-pc-pending]");
    if (!node) return;
    node.innerHTML = list(state.attachments).map((item, index) => `<span class="pc-pending-file">${escape(item.name)}<button type="button" data-pc-remove="${index}" aria-label="Убрать ${escape(item.name)}"${state.busy || state.attempt ? " disabled" : ""}>×</button></span>`).join("");
  };
  const composeBusy = state => {
    const form = q(state, "[data-pc-compose]");
    if (!form || state.revoked) return;
    form.querySelectorAll("button,input").forEach(node => { node.disabled = state.busy || Boolean(state.attempt && node.type !== "submit"); });
    const input = form.querySelector("textarea");
    if (input) input.readOnly = state.busy || Boolean(state.attempt);
    form.querySelector('[type="submit"]').textContent = state.busy ? "Подождите…" : state.attempt ? "Повторить отправку" : "Отправить";
    renderPending(state);
  };
  const settle = state => { state.busy = false; if (current === state && state.mode === "shared") composeBusy(state); };
  const send = async (state, form) => {
    const view = state.view;
    if (!live(state, view) || state.busy || !canReply(state)) return;
    const input = form.querySelector("textarea"), text = input.value.trim();
    if (!state.attempt && !text && !list(state.attachments).length) return;
    // The same clientMessageId is reused on retry so a delivered message is never duplicated.
    state.attempt ||= { text, attachmentIds: state.attachments.map(item => item.id), clientMessageId: identifier() };
    state.busy = true;
    composeBusy(state);
    notice(state, "Отправляем сообщение…");
    try {
      await write(state, "/messages", "POST", state.attempt);
      state.attempt = null;
      state.attachments = [];
      state.draft = "";
      input.value = "";
      if (!live(state, view)) return;
      notice(state, "Сообщение сохранено в чате проекта.");
      await refresh(state, view);
    } catch (error) {
      if (!live(state, view) || error.name === "AbortError") return;
      if (denied(error)) { revoke(state, error.message); return; }
      if (error.status >= 400 && error.status < 500 && error.status !== 429) state.attempt = null;
      notice(state, state.attempt ? "Не получили подтверждение отправки. Повторите отправку: одинаковое сообщение не будет добавлено дважды." : error.message, true);
    } finally { settle(state); }
  };
  const upload = async (state, input) => {
    const view = state.view;
    if (!live(state, view) || state.busy || state.attempt || !canReply(state)) return;
    const files = [...input.files];
    if (!files.length) return;
    state.busy = true;
    composeBusy(state);
    try {
      for (const file of files) {
        notice(state, `Загружаем: ${file.name}`);
        const result = await request(state, "/attachments", { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", "X-Filename": encodeURIComponent(file.name) }, body: file });
        if (!result.attachment?.id) throw new Error("Сервер не подтвердил загрузку файла");
        state.attachments.push(result.attachment);
        renderPending(state);
      }
      if (live(state, view)) notice(state, "Файлы готовы. Нажмите «Отправить», чтобы добавить их в переписку.");
    } catch (error) {
      if (!live(state, view) || error.name === "AbortError") return;
      if (denied(error)) { revoke(state, error.message); return; }
      notice(state, error.message, true);
    } finally { input.value = ""; settle(state); }
  };
  const sharedShell = state => `<div class="pc-layout"><section class="pc-conversation" aria-label="Общий чат проекта"><header class="pc-room-header"><h2>${escape(state.ctx.identity.companies?.find(company => company.id === state.company)?.name || state.company)}</h2><p data-pc-members></p><p class="pc-muted" data-pc-connection></p><p class="pc-muted" data-pc-ai></p><button type="button" data-pc-retry-ai hidden>Повторить ответы Хью</button></header><div class="pc-history-more"><button type="button" data-pc-older hidden>Показать более ранние сообщения</button></div><ol class="pc-messages" data-pc-messages aria-label="Общая переписка" role="log" aria-live="polite"><li class="pc-empty">Загрузка…</li></ol><p data-pc-sync class="pc-muted pc-sync" role="status"></p><form data-pc-compose class="pc-compose" hidden><label class="sr-only" for="pc-message-input">Сообщение участникам проекта</label><textarea id="pc-message-input" name="text" rows="2" maxlength="12000" placeholder="Сообщение участникам проекта…"></textarea><div data-pc-pending class="pc-pending"></div><div class="pc-toolbar"><label class="pc-file-button">Прикрепить фото или файл<input type="file" multiple data-pc-upload aria-label="Прикрепить фото или файл"></label><button type="submit">Отправить</button></div></form><p data-pc-readonly class="pc-muted pc-readonly" hidden>У вас доступ к просмотру. Для сообщений нужно право ответа в чате проекта.</p></section><aside class="pc-project"><div class="pc-toolbar"><h2>Задачи <span data-pc-task-count></span></h2><button type="button" data-pc-new-task data-pc-write hidden>Добавить</button></div><ul class="pc-tasks" data-pc-tasks></ul><div class="pc-project-actions"><button type="button" data-pc-stages data-pc-write hidden>Этапы проекта</button><button type="button" data-pc-edit-members data-pc-owner hidden>Участники</button><button type="button" data-pc-settings data-pc-owner hidden>Настройки чата</button></div></aside></div>`;
  const switchMode = async (state, mode) => {
    if (!active(state) || (mode === "private" && state.ctx.identity.role !== "owner")) return;
    const body = q(state, "[data-pc-body]");
    if (!body) return;
    // An unsent draft belongs to the person, not to the tab that was open.
    const draft = body.querySelector("[data-pc-compose] textarea");
    if (draft && !state.revoked) state.draft = draft.value;
    cabinet.privateHugh?.stop();
    state.mode = mode;
    state.view++;
    const view = state.view;
    state.readSequence++;
    clearTimeout(state.timer);
    clearTimeout(state.loginTimer);
    state.root.querySelectorAll("dialog").forEach(dialog => dialog.remove());
    state.root.querySelectorAll("[data-pc-mode]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.pcMode === mode)));
    if (mode === "private") {
      body.innerHTML = '<p class="pc-muted">Личная переписка владельца. Участники проекта её не видят.</p><div data-pc-private></div>';
      const privateContext = Object.create(state.ctx);
      privateContext.byId = id => id === "hugh-view" ? body.querySelector("[data-pc-private]") : state.ctx.byId(id);
      await cabinet.privateHugh?.render(privateContext);
      return;
    }
    state.revoked = false;
    state.messageSignature = "";
    state.tasksSignature = "";
    state.loadingOlder = false;
    body.innerHTML = sharedShell(state);
    body.querySelector("[data-pc-compose]").onsubmit = event => { event.preventDefault(); send(state, event.currentTarget); };
    body.querySelector("[data-pc-upload]").onchange = event => upload(state, event.currentTarget);
    body.querySelector("textarea").value = state.attempt?.text ?? state.draft ?? "";
    composeBusy(state);
    try { await refresh(state, view); notice(state, ""); }
    catch (error) {
      if (!live(state, view) || error.name === "AbortError") return;
      if (denied(error)) { revoke(state, error.message); return; }
      notice(state, error.message, true);
      const history = q(state, "[data-pc-messages]");
      if (history) history.innerHTML = '<li class="pc-empty">Переписка недоступна. <button type="button" data-pc-refresh>Повторить</button></li>';
    }
    schedule(state, view);
  };
  const mount = async (_, ctx) => {
    if (current) { current.controller.abort(); clearTimeout(current.timer); clearTimeout(current.loginTimer); }
    cabinet.privateHugh?.stop();
    const root = ctx.byId("hugh-view");
    const state = current = { ctx, root, company: ctx.selectedProjectId, base: "/content/project-chat/" + encodeURIComponent(ctx.selectedProjectId), controller: new AbortController(), mode: "shared", view: 0, readSequence: 0, attachments: [], history: [], seen: new Map(), loadedOlder: false, hasMore: false, cursor: null, loadingOlder: false, busy: false, attempt: null, draft: "", revoked: false };
    root.innerHTML = `<div class="content-header"><h1>Хью · чат проекта</h1></div><nav class="pc-tabs" aria-label="Переписка"><button type="button" data-pc-mode="shared" aria-pressed="true">Общий чат проекта</button>${ctx.identity.role === "owner" ? '<button type="button" data-pc-mode="private" aria-pressed="false">Личный Хью</button>' : ""}</nav><p data-pc-notice class="pc-notice" role="status"></p><div data-pc-body></div>`;
    root.onclick = event => {
      if (!active(state)) return;
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.pcMode) { if (button.dataset.pcMode !== state.mode) switchMode(state, button.dataset.pcMode); return; }
      if (state.mode !== "shared") return;
      if (button.matches("[data-pc-refresh]")) { switchMode(state, "shared"); return; }
      if (state.revoked) return;
      if (button.matches("[data-pc-older]")) { loadOlder(state, state.view); return; }
      if (button.matches("[data-pc-retry-ai]")) { retryAI(state, state.view); return; }
      if (button.matches("[data-pc-remove]") && !state.busy && !state.attempt) { state.attachments.splice(Number(button.dataset.pcRemove), 1); renderPending(state); }
      if (button.matches("[data-pc-new-task]")) taskDialog(state);
      if (button.matches("[data-pc-task]")) { const task = list(state.data?.tasks).find(item => String(item.id) === button.dataset.pcTask); if (task) taskDialog(state, task); }
      if (button.matches("[data-pc-message-task]")) { const message = timeline(state).find(item => String(item.id) === button.dataset.pcMessageTask); if (message) taskDialog(state, {}, message); }
      if (button.matches("[data-pc-stages]")) stagesDialog(state);
      if (button.matches("[data-pc-edit-members]")) membersDialog(state);
      if (button.matches("[data-pc-settings]")) settingsDialog(state);
    };
    await switchMode(state, "shared");
  };
  cabinet.registerView("hugh", { title: "Хью", render: mount, onProjectChange: ctx => mount(null, ctx) });
})();

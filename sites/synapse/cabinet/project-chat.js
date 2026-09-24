(() => {
  "use strict";
  const cabinet = window.SbCabinet = window.SbCabinet || {};
  /* Отложенная отправка: состояние самой записи и, для отправленной, состояние доставки
     из той же очереди Telegram, что и у обычных сообщений. */
  const scheduledStates = { pending: "Ожидает отправки", sent: "Отправлено", cancelled: "Отменено",
    expired: "Срок прошёл, не отправлено", error: "Не отправлено" };
  const scheduledDelivery = { local: "в чате проекта", pending: "ожидает отправки в Telegram",
    sending: "отправляется в Telegram", sent: "доставлено в Telegram", uncertain: "доставка уточняется",
    error: "не доставлено в Telegram" };
  const ZONES = ["Asia/Irkutsk", "Asia/Bangkok", "Europe/Moscow", "UTC"];
  const statuses = { todo: "Не начато", in_progress: "В работе", done: "Сделано", blocked: "Нужна помощь", cancelled: "Отменено" };
  // Состояние публикации показывается отдельно от состояния работы: «готово» у нас ещё не значит «на сайте».
  const publications = { not_started: "Не опубликовано", prepared: "Готово, на сайте ещё нет",
    published: "На сайте", awaiting_clarification: "Ожидает уточнения", not_required: "Публикация не требуется" };
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
  const active = state => current === state && !state.controller.signal.aborted && state.ctx.selectedProjectId === (state.selectedCompany || state.company) && state.ctx.currentView === "hugh";
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
      // Хост Mini App подписывает запросы своим заголовком вместо cookie и CSRF-токена кабинета.
      headers: { "Content-Type": "application/json", ...(init.method && init.method !== "GET" && state.ctx.identity.csrfToken ? { "X-CSRF-Token": state.ctx.identity.csrfToken } : {}), ...(state.ctx.authHeaders?.() || {}), ...init.headers }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(response.status === 403 ? "Доступ к чату проекта не назначен. Владелец проекта может добавить вас в участники."
        : response.status === 401 ? (state.ctx.authHeaders ? "Сессия чата истекла. Закройте и снова откройте чат из Telegram." : "Сессия завершена. Войдите в кабинет заново.")
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
  /* Дата проверки может прийти из реестра как дата-время. input type="date" принимает только YYYY-MM-DD,
     поэтому показываем день, а полное значение храним рядом и возвращаем нетронутым, если день не меняли. */
  const dayOf = value => String(value || "").slice(0, 10);
  // День не трогали — возвращаем исходное значение целиком, чтобы не потерять время из реестра.
  const keepMoment = (full, day) => (day && dayOf(full) === day ? full : (day || ""));
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
  // Резервные провайдеры: показываем только факт настройки и живой ответ, без адресов и ключей.
  const fallbackText = ai => {
    const fb = ai.fallback;
    if (!fb || !fb.configured) return "";
    const live = fb.providers.filter(p => p.live).length, cooling = fb.providers.filter(p => p.cooling).length;
    // Ноль доступных без причины выглядит как поломка неизвестной природы: называем причину.
    const stopped = !fb.available && fb.stoppedReason ? ` Причина: ${safeReason(fb.stoppedReason)}.` : "";
    return ` Резерв ответов: ${fb.providers.length} провайдер(а), доступно ${fb.available}` +
      (live ? `, живой ответ получен от ${live}` : ", живой ответ ещё не подтверждён") + (cooling ? `, на паузе ${cooling}` : "") + "." + stopped;
  };
  const aiSummary = state => {
    const ai = aiInfo(state);
    const reserve = fallbackText(ai);
    if (!ai.connected) {
      const reason = !ai.configured ? "Автоматические ответы Хью пока не подключены."
        : ai.runtimeState === "offline" ? "Компьютер Хью сейчас не на связи: вопросы к нему ждут его возвращения."
        : ai.runtimeState === "login_pending" ? "Хью ждёт, пока владелец подтвердит вход."
        : ai.runtimeState === "connecting" ? "Хью подключается к подписке Codex…"
        : ai.runtimeState === "login_required" ? "Хью ждёт подтверждения входа владельцем."
        : ai.runtimeState === "unavailable" ? "Сервис ответов Хью сейчас недоступен."
        : "Хью пока не подключён.";
      return `${reason}${reserve} Переписка, файлы и задачи проекта работают.${ai.queued ? ` Ожидают ответа: ${ai.queued}.` : ""}`;
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
          : "Переписка, файлы и задачи проекта работают.",
        reserve.trim()
      ].filter(Boolean).join(" ");
    }
    const parts = [state.data?.room?.replyMode === "delegate" ? "Хью заменяет Влада в обсуждении." : "Хью отвечает по обращению."];
    if (waiting) parts.push(`Готовит ответы: ${waiting}.`);
    if (failed) parts.push(`Не удалось ответить: ${failed}.`);
    return parts.join(" ");
  };
  const attachmentHTML = (attachment, state) => {
    const url = assetUrl(attachment.url);
    if (!url) return `<span class="pc-attachment-missing pc-muted">${escape(attachment.name || "Файл")} · ${escape(attachment.note || "файл доступен только в Telegram")}</span>`;
    const image = /^image\/(jpeg|png|webp|gif)$/i.test(attachment.mime || "");
    if (state?.ctx.fetchAsset) {
      // Хост без cookie (Mini App): картинка и ссылка не могут нести заголовок, поэтому файл
      // читается защищённым запросом, а сюда попадает уже локальный blob-адрес (см. hydrateAssets).
      return `<a class="pc-attachment pc-attachment-protected" data-pc-asset="${escape(url)}" data-pc-asset-name="${escape(attachment.name || (image ? "Фотография" : "Файл"))}">${image ? `<img alt="${escape(attachment.name || "Фотография")}">` : ""}<span>${escape(attachment.name || "Открыть файл")}</span><small class="pc-muted" data-pc-asset-state>Загружаем…</small></a>`;
    }
    return `<a class="pc-attachment" href="${escape(url)}" target="_blank" rel="noopener">${image ? `<img src="${escape(url)}" alt="${escape(attachment.name || "Фотография")}" loading="lazy">` : ""}<span>${escape(attachment.name || "Открыть файл")}</span></a>`;
  };
  // Blob-адреса живут не дольше комнаты: смена компании, отзыв доступа и переход на личную
  // вкладку освобождают их, чтобы память и чужие файлы не оставались в странице.
  const releaseAssets = state => {
    for (const entry of (state.assets || new Map()).values()) { try { URL.revokeObjectURL(entry.objectUrl); } catch (_) { /* уже освобождён */ } }
    state.assets = new Map();
  };
  const hydrateAssets = (state, view) => {
    if (!state.ctx.fetchAsset) return;
    state.assets ||= new Map();
    const assets = state.assets;
    for (const node of state.root.querySelectorAll("[data-pc-asset]:not([data-pc-asset-ready])")) {
      node.setAttribute("data-pc-asset-ready", "");
      const url = node.dataset.pcAsset;
      const apply = entry => {
        const img = node.querySelector("img");
        if (img) img.src = entry.objectUrl;
        node.href = entry.objectUrl;
        node.target = "_blank";
        node.rel = "noopener";
        node.querySelector("[data-pc-asset-state]")?.remove();
      };
      const cached = assets.get(url);
      if (cached) { apply(cached); continue; }
      Promise.resolve().then(() => state.ctx.fetchAsset(url)).then(blob => {
        // Поздний ответ после смены комнаты не создаёт адрес, который некому освободить.
        if (!live(state, view) || state.assets !== assets) return;
        const entry = { objectUrl: URL.createObjectURL(blob), name: node.dataset.pcAssetName || "" };
        assets.set(url, entry);
        if (node.isConnected) apply(entry);
      }).catch(() => {
        const status = node.querySelector("[data-pc-asset-state]");
        if (status) status.textContent = "Не удалось загрузить файл";
      });
    }
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
    ${list(message.attachments).length ? `<div class="pc-attachments">${message.attachments.map(attachment => attachmentHTML(attachment, state)).join("")}</div>` : ""}
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
      hydrateAssets(state, view);
    }
    const older = q(state, "[data-pc-older]");
    if (older) { older.hidden = !state.hasMore || !state.cursor; older.disabled = state.loadingOlder; }
    q(state, "[data-pc-members]").textContent = list(data.members).map(member => member.displayName).join(", ") || "Участники пока не назначены";
    q(state, "[data-pc-connection]").textContent = data.room?.telegramChatId ? "Telegram привязан к проекту. Состояние доставки показано у сообщений." : "Telegram пока не привязан";
    q(state, "[data-pc-ai]").textContent = aiSummary(state);
    renderPersonas(state, data.personas);
    q(state, "[data-pc-retry-ai]").hidden = !(isOwner(state) && Number(ai.failed) > 0);
    q(state, "[data-pc-compose]").hidden = !canReply(state);
    q(state, "[data-pc-readonly]").hidden = canReply(state);
    root.querySelectorAll("[data-pc-owner]").forEach(node => { node.hidden = !isOwner(state); });
    root.querySelectorAll("[data-pc-write]").forEach(node => { node.hidden = !canReply(state); });
    const tasksSignature = JSON.stringify([data.tasks, data.stages, data.members, data.formerMembers, data.access]);
    if (tasksSignature !== state.tasksSignature) {
      q(state, "[data-pc-tasks]").innerHTML = list(data.tasks).map(task => {
        const publication = task.publication || "not_started";
        // Сайт обязателен для показа: у собственника два сайта в одной переписке, карточка без метки вводит в заблуждение.
        const site = task.siteStatus === "needs_clarification"
          ? '<span class="pc-badge pc-badge-ask">Нужно уточнить сайт</span>'
          : `<span class="pc-badge">${escape(task.siteLabel || task.site || "")}</span>`;
        /* Ссылка НЕ внутри кнопки: вложенные интерактивные элементы недопустимы, и клик по ссылке
           открывал бы редактирование задачи вместо страницы. Выносим её отдельной строкой под кнопкой. */
        const link = task.publishedUrl
          ? `<p class="pc-task-link"><a href="${escape(task.publishedUrl)}" target="_blank" rel="noopener noreferrer">Открыть страницу</a>${task.verifiedAt ? " · проверено " + escape(dayOf(task.verifiedAt)) : ""}</p>`
          : "";
        const quote = task.sourceQuote ? `<span class="pc-task-quote">«${escape(task.sourceQuote)}»</span>` : "";
        const notes = list(task.notes).length
          ? `<span class="pc-task-notes">Уточнения: ${list(task.notes).map(note => escape(note.text)).join(" · ")}</span>` : "";
        const cancelled = task.cancelled || task.status === "cancelled";
        const kind = task.kind === "internal" ? '<span class="pc-badge">Внутренняя работа</span>' : "";
        // Кнопка напоминания стоит рядом с задачей, а не внутри её кнопки: вложенные кнопки недопустимы.
        const remind = canReply(state)
          ? `<button type="button" class="pc-task-remind" data-pc-task-remind="${escape(task.id)}">Напомнить</button>` : "";
        return `<li class="pc-task${cancelled ? " pc-task-cancelled" : task.fixedOnSite ? " pc-task-done" : ""}"><button type="button" data-pc-task="${escape(task.id)}"><strong>${task.externalRef ? escape(task.externalRef) + ". " : ""}${escape(task.title)}</strong>${quote}<span class="pc-task-badges">${site}${kind}${cancelled ? '<span class="pc-badge pc-pub-cancelled">Отменено — не исправление</span>' : ""}<span class="pc-badge pc-pub-${escape(publication)}">${escape(publications[publication] || publication)}</span></span>${notes}<span>${escape(assigneeLabel(state, task))} · ${escape(stageName(state, task.stageId))}</span><small>Работа: ${escape(statuses[task.status] || task.status)}${task.due ? " · " + escape(task.due) : ""}</small></button>${link}${remind}</li>`;
      }).join("") || '<li class="pc-empty">Из сообщения можно создать задачу, назначить исполнителя и срок.</li>';
      /* В счётчике — только замечания клиента, которые ещё не на сайте и не сняты. Внутренние работы
         (резервы, счётчики) считаются отдельно и в клиентский счёт не входят. */
      renderScheduled(state, data);
      /* Сводка вместо одного числа. Раньше в заголовке стояло только количество незакрытых замечаний,
         и при шестнадцати видимых карточках там появлялся ноль — список выглядел пустым.
         Теперь видно всё: сколько замечаний клиента всего, сколько из них на сайте, сколько осталось
         и сколько снято. Снятое исправлением не считается, внутренние работы стоят отдельно
         и в клиентский счёт не входят. Карточки этим не меняются и не задваиваются. */
      const clientTasks = list(data.tasks).filter(task => (task.kind || "client_remark") === "client_remark");
      const cancelledTasks = clientTasks.filter(task => task.cancelled || task.status === "cancelled");
      const onSite = clientTasks.filter(task => task.fixedOnSite && !(task.cancelled || task.status === "cancelled"));
      const open = clientTasks.filter(task => !(task.cancelled || task.status === "cancelled") && !task.fixedOnSite);
      const internal = list(data.tasks).filter(task => task.kind === "internal").length;
      const parts = clientTasks.length
        ? [`Замечания: ${clientTasks.length}`, `на сайте ${onSite.length}`, `осталось ${open.length}`,
          ...(cancelledTasks.length ? [`отменено ${cancelledTasks.length}`] : [])]
        : [];
      if (internal) parts.push(`внутренних ${internal}`);
      q(state, "[data-pc-task-count]").textContent = parts.join(" · ");
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
    releaseAssets(state);
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
    // Хост Mini App показывает свой экран повторного открытия вместо кабинетного текста.
    state.ctx.onRevoked?.(message);
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
  /* Список запланированного: срок показывается в том поясе, который выбрал владелец, состояние —
     отдельно для записи и для доставки. Изменить и отменить можно только то, что ещё ждёт отправки. */
  const zoneTime = (iso, timeZone) => {
    try {
      return new Intl.DateTimeFormat("ru-RU", { timeZone, day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
    } catch { return String(iso || ""); }
  };
  const renderScheduled = (state, data) => {
    const items = list(data.scheduled);
    const block = q(state, "[data-pc-scheduled-block]");
    const node = q(state, "[data-pc-scheduled]");
    if (!block || !node) return;
    block.hidden = items.length === 0;
    const signature = JSON.stringify(items);
    if (signature === state.scheduledSignature) return;
    state.scheduledSignature = signature;
    node.innerHTML = items.map(item => {
      const delivery = item.status === "sent" && item.deliveryStatus
        ? ` · ${escape(scheduledDelivery[item.deliveryStatus] || item.deliveryStatus)}` : "";
      // Право менять приходит с сервера: чужую отправку кабинет не предлагает трогать.
      const actions = item.canManage
        ? `<span class="pc-scheduled-actions"><button type="button" data-pc-schedule-edit="${escape(item.id)}">Изменить</button><button type="button" data-pc-schedule-cancel="${escape(item.id)}">Отменить</button></span>`
        : "";
      const reminder = item.kind === "task_reminder" ? '<span class="pc-badge">Напоминание по задаче</span>' : "";
      return `<li class="pc-scheduled-item"><p>${escape(item.text)}</p><small>${escape(zoneTime(item.dueAt, item.timezone))} · ${escape(item.timezone)} · ${escape(scheduledStates[item.status] || item.status)}${delivery}${item.error ? " · " + escape(item.error) : ""}</small>${reminder}${actions}</li>`;
    }).join("");
  };

  /* Диалог планирования. Дата, время и часовой пояс задаются явно: сервер переводит их в UTC сам,
     поэтому «9:00 у Татьяны» остаётся 9:00 у Татьяны независимо от того, где открыт кабинет. */
  const cancelScheduled = async (state, id) => {
    if (!canReply(state)) return;
    const view = state.view;
    try {
      await write(state, `/scheduled/${id}`, "PATCH", { status: "cancelled" });
      if (!live(state, view)) return;
      notice(state, "Отправка отменена");
      await refresh(state, view);
    } catch (error) {
      if (!live(state, view) || error.name === "AbortError") return;
      if (denied(error)) { revoke(state, error.message); return; }
      notice(state, error.message || "Не удалось отменить отправку", true);
    }
  };
  const scheduleDialog = (state, { item = null, task = null } = {}) => {
    if (!canReply(state)) return;
    const view = state.view;
    const browserZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
    const zones = [...new Set([...ZONES, browserZone])];
    const current = item ? new Date(item.dueAt) : new Date(Date.now() + 3600000);
    const zone = item ? item.timezone : (zones.includes("Asia/Irkutsk") ? "Asia/Irkutsk" : browserZone);
    const parts = (() => {
      try {
        const formatted = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit",
          day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(current);
        const get = (type) => formatted.find(part => part.type === type)?.value || "";
        return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
      } catch { return { date: "", time: "09:00" }; }
    })();
    const draft = item ? item.text : (q(state, "[data-pc-compose]")?.elements.text.value || "").trim();
    const title = task ? "Напоминание по задаче" : item ? "Изменить отправку" : "Запланировать отправку";
    const dialog = modal(state, title, `<form class="pc-fields">${task ? `<p class="pc-muted">Задача: ${escape(task.title)}</p>` : ""}<label>Текст<textarea name="text" rows="3" maxlength="12000" required>${escape(draft)}</textarea></label><label>Дата<input name="date" type="date" value="${escape(parts.date)}" required></label><label>Время<input name="time" type="time" value="${escape(parts.time)}" required></label><label>Часовой пояс<select name="timezone">${zones.map(value => `<option value="${escape(value)}"${value === zone ? " selected" : ""}>${escape(value)}</option>`).join("")}</select></label><p class="pc-muted">Сообщение уйдёт в чат проекта и в связанную Telegram-группу в указанное время. До отправки его можно изменить или отменить.</p><button type="submit">${item ? "Сохранить" : "Запланировать"}</button><p role="alert"></p></form>`);
    formSave(state, dialog, async form => {
      const text = form.elements.text.value.trim();
      if (!text) throw new Error("Введите текст сообщения");
      if (!form.elements.date.value || !form.elements.time.value) throw new Error("Укажите дату и время");
      const payload = { text, dueAtLocal: `${form.elements.date.value}T${form.elements.time.value}`,
        timezone: form.elements.timezone.value };
      /* Ключ повтора запроса живёт на форме: потерянный ответ и повторное нажатие не создадут
         вторую отложенную отправку — сервер узнает тот же запрос. */
      if (!item) {
        form.dataset.pcClientId = form.dataset.pcClientId || `plan-${crypto.randomUUID()}`;
        payload.clientId = form.dataset.pcClientId;
      }
      if (item) await write(state, `/scheduled/${item.id}`, "PATCH", payload);
      else await write(state, "/scheduled", "POST", task ? { ...payload, kind: "task_reminder", taskId: task.id } : payload);
      if (!live(state, view)) return;
      // Черновик из поля ввода уходит в запланированное: оставлять его вторым экземпляром нельзя.
      if (!item && !task) { const compose = q(state, "[data-pc-compose]"); if (compose) compose.elements.text.value = ""; }
      notice(state, item ? "Отправка перенесена" : "Сообщение запланировано");
    });
  };

  /* Выбор сайтов комнаты: только проекты, доступные этому владельцу, и без самой комнаты —
     её код обслуживается всегда. Сервер проверяет список повторно, интерфейс лишь удобство. */
  const siteChoices = (state, room) => {
    const current = new Set(list(room.sites).map(code => String(code)));
    const others = list(state.ctx.identity.companies).filter(company => String(company.id) !== String(state.company));
    if (!others.length) return '<p class="pc-muted">Других проектов у вас нет — задачи помечаются этим сайтом.</p>';
    return others.map(company => `<label class="pc-site-choice"><input type="checkbox" data-pc-site value="${escape(company.id)}"${current.has(String(company.id)) ? " checked" : ""}> ${escape(company.name || company.id)}</label>`).join("");
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
      <label>Статус работы<select name="status">${Object.entries(statuses).map(([id, title]) => `<option value="${id}"${(task.status || "todo") === id ? " selected" : ""}>${title}</option>`).join("")}</select></label>
      <label>Сайт<select name="site">${options(list(state.data.room?.sites).concat([state.company]).map(code => [code, state.ctx.identity.companies?.find(company => company.id === code)?.name || code]), task.site, "Нужно уточнить")}</select></label>
      <label>Вид<select name="kind">${Object.entries({ client_remark: "Замечание клиента", internal: "Внутренняя работа" })
        .map(([id, title]) => `<option value="${id}"${(task.kind || "client_remark") === id ? " selected" : ""}>${title}</option>`).join("")}</select></label>
      <label>Публикация<select name="publication">${Object.entries(publications).map(([id, title]) => `<option value="${id}"${(task.publication || "not_started") === id ? " selected" : ""}>${title}</option>`).join("")}</select></label>
      <label>Ссылка на страницу<input name="publishedUrl" type="url" maxlength="500" value="${escape(task.publishedUrl || "")}" placeholder="https://"></label>
      <label>Дата проверки на сайте<input name="verifiedAt" type="date" value="${escape(dayOf(task.verifiedAt))}"></label>
      <input type="hidden" name="verifiedAtFull" value="${escape(task.verifiedAt || "")}">
      <p class="pc-muted">«На сайте» ставится только после проверки работающей страницы: нужны ссылка и дата. Статус работы «Отменено» оставляет задачу видимой, но исправлением она не считается — даже если раньше была опубликована.</p>
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
      const payload = { title, assigneeId, stageId: Number(fields.stageId.value) || null, due: fields.due.value || null, status: fields.status.value,
        site: fields.site.value || "", publication: fields.publication.value, kind: fields.kind.value,
        publishedUrl: fields.publishedUrl.value.trim(), verifiedAt: keepMoment(fields.verifiedAtFull.value, fields.verifiedAt.value) };
      // Сервер откажет без ссылки и даты — предупреждаем раньше, чем уходит запрос.
      if (payload.publication === "published" && (!payload.publishedUrl || !payload.verifiedAt)) {
        return Promise.reject(new Error("Для «На сайте» укажите ссылку на страницу и дату проверки"));
      }
      if (payload.publication === "published" && !payload.site) {
        return Promise.reject(new Error("Сначала уточните, какого сайта касается задача"));
      }
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
  // Привязки Telegram участников этой комнаты: ожидающие коды и уже привязанные аккаунты.
  // Привязать можно только к действующему участнику — список берётся из состава комнаты.
  const telegramLinks = async (state, dialog, view) => {
    const body = dialog.querySelector("[data-pc-tg-body]"), alertNode = dialog.querySelector("[data-pc-tg-alert]");
    const render = data => {
      if (!live(state, view) || !dialog.isConnected) return;
      const members = list(state.data?.members).map(member => [member.userId, member.displayName]);
      const pending = list(data.pending), links = list(data.links);
      body.innerHTML = `${pending.length ? `<p>Ожидают привязки:</p><ul class="pc-stage-list">${pending.map(item => `<li><span>${escape(item.firstName)} · код <strong>${escape(item.code)}</strong></span><span class="pc-tg-actions"><select data-pc-tg-user="${escape(item.code)}" aria-label="Аккаунт участника для кода ${escape(item.code)}">${options(members, "", "Выберите участника")}</select><button type="button" data-pc-tg-link="${escape(item.code)}">Привязать</button></span></li>`).join("")}</ul>` : '<p class="pc-muted">Сейчас никто не ждёт привязки.</p>'}${links.length ? `<p>Привязаны:</p><ul class="pc-stage-list">${links.map(item => `<li><span>${escape(item.displayName)} · Telegram ID ${escape(item.telegramUserId)}</span><button type="button" data-pc-tg-unlink="${escape(item.telegramUserId)}">Отвязать</button></li>`).join("")}</ul>` : ""}`;
    };
    const load = async () => render(await request(state, "/telegram-links"));
    body.onclick = async event => {
      const button = event.target.closest("button[data-pc-tg-link],button[data-pc-tg-unlink]");
      if (!button || !live(state, view)) return;
      alertNode.textContent = "";
      button.disabled = true;
      try {
        if (button.dataset.pcTgLink) {
          const userId = Number(dialog.querySelector(`[data-pc-tg-user="${button.dataset.pcTgLink}"]`)?.value);
          if (!userId) throw new Error("Выберите участника, чей это Telegram");
          render(await write(state, "/telegram-links", "POST", { linkCode: button.dataset.pcTgLink, userId }));
        } else {
          render(await request(state, `/telegram-links/${encodeURIComponent(button.dataset.pcTgUnlink)}`, { method: "DELETE" }));
        }
      } catch (error) {
        if (!live(state, view) || error.name === "AbortError") return;
        if (denied(error)) { revoke(state, error.message); return; }
        if (dialog.isConnected) alertNode.textContent = error.message;
        button.disabled = false;
      }
    };
    try { await load(); }
    catch (error) {
      if (!live(state, view) || error.name === "AbortError") return;
      if (denied(error)) { revoke(state, error.message); return; }
      if (dialog.isConnected) body.textContent = "Не удалось загрузить привязки Telegram.";
    }
  };
  const membersDialog = async state => {
    if (!isOwner(state)) return;
    const view = state.view;
    try {
      const data = await request(state, "/candidates");
      if (!live(state, view)) return;
      const selected = new Set(list(state.data.members).map(member => String(member.userId)));
      const dialog = modal(state, "Участники проекта", `<form class="pc-fields"><p>Участники видят всю переписку и фотографии этого проекта.</p><p class="pc-muted">Это доступ только в кабинете. Состав Telegram-группы задаётся в самом Telegram: если убрать человека здесь, он продолжит читать группу, пока его не удалят там.</p>${list(data.candidates).map(member => `<label class="pc-check"><input type="checkbox" name="userIds" value="${escape(member.userId)}"${selected.has(String(member.userId)) ? " checked" : ""}>${escape(member.displayName)}</label>`).join("") || '<p>Нет учётных записей с доступом к этой компании.</p>'}<button type="submit">Сохранить участников</button><p role="alert"></p></form><section class="pc-tg-links" data-pc-tg-links><h3>Чат проекта в Telegram</h3><p class="pc-muted">Участник открывает чат проекта в Telegram и видит код. Выберите здесь, чей это аккаунт, и нажмите «Привязать». Без привязки доступа из Telegram нет.</p><div data-pc-tg-body>Загружаем…</div><p role="alert" data-pc-tg-alert></p></section>`);
      formSave(state, dialog, form => write(state, "/members", "PUT", { userIds: [...form.querySelectorAll('[name="userIds"]:checked')].map(input => Number(input.value)) }));
      telegramLinks(state, dialog, view);
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
  /* Импорт реестра замечаний файлом. Второго реестра не заводим: это тот же список задач комнаты,
     сервер сам решает, что обновить и что пропустить. Личные данные в исходники не попадают —
     файл выбирает владелец у себя. В Telegram при импорте ничего не уходит: задачи не сообщения. */
  const importDialog = state => {
    if (!isOwner(state)) return;
    const view = state.view;
    const dialog = modal(state, "Импорт реестра замечаний", `<form class="pc-fields"><label>Файл реестра (JSON)<input type="file" name="registry" accept="application/json,.json" required></label><p class="pc-muted">Ожидается объект с полями schemaVersion, asOf и tasks. Уже существующие задачи обновляются по их идентификатору реестра, копии не создаются.</p><label class="pc-site-choice"><input type="checkbox" name="force"> Перезаписать правки, сделанные в кабинете</label><p class="pc-muted">Без этой отметки задачи, изменённые в кабинете позже снимка, и снимки старше записанного пропускаются.</p><button type="submit">Загрузить</button><p role="alert"></p></form><p class="pc-muted" data-pc-import-result role="status"></p>`);
    formSave(state, dialog, async form => {
      const file = form.elements.registry.files[0];
      if (!file) throw new Error("Выберите файл реестра");
      const text = await file.text();
      let payload;
      try { payload = JSON.parse(text); } catch { throw new Error("Это не JSON: файл не разобран"); }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("В файле должен быть объект реестра");
      if (!Array.isArray(payload.tasks) || !payload.tasks.length) throw new Error("В файле нет списка задач");
      /* force берётся ТОЛЬКО из отметки владельца: force:true, случайно оставшийся в файле,
         не должен молча разрешать перезапись правок, сделанных в кабинете. */
      payload.force = Boolean(form.elements.force.checked);
      const data = await write(state, "/tasks/import", "POST", payload);
      if (!live(state, view)) return;
      const skipped = list(data.results).filter(item => item.skipped);
      notice(state, `Реестр загружен: обновлено ${Number(data.imported) || 0}, пропущено ${Number(data.skipped) || 0}`
        + (skipped.length ? `. Пропущены: ${skipped.map(item => item.reason).join("; ")}` : ""));
    });
  };
  const settingsDialog = async state => {
    if (!isOwner(state)) return;
    const view = state.view;
    const room = state.data.room || {};
    const dialog = modal(state, "Настройки чата", `<form class="pc-fields"><label>Когда отвечает Хью<select name="replyMode"><option value="addressed"${room.replyMode !== "delegate" ? " selected" : ""}>По обращению</option><option value="delegate"${room.replyMode === "delegate" ? " selected" : ""}>Заменять Влада</option></select></label><p class="pc-muted">В режиме «По обращению» начните сообщение с «Хью». В режиме замены Хью участвует в обсуждении проекта.</p><fieldset class="pc-sites"><legend>Сайты, которые обслуживает этот чат</legend>${siteChoices(state, room)}</fieldset><p class="pc-muted">У одного собственника может быть несколько сайтов в одной переписке. Метка сайта у задачи принимается только из этого списка.</p><label>Telegram-группа<input name="telegramChatId" inputmode="numeric" placeholder="Например, -1001234567890" value="${escape(room.telegramChatId || "")}"></label><p class="pc-muted">Укажите ID рабочей группы, куда добавлен бот. Пустое поле отключает дублирование.</p><p class="pc-muted">Кто читает группу, решает Telegram. Список участников кабинета на это не влияет: удаление участника здесь не удаляет его из группы.</p><button type="submit">Сохранить настройки</button><p role="alert"></p></form><section class="pc-runtime"><h3>Ответы Хью через Codex</h3><div data-pc-runtime role="status">Проверяем подключение…</div><div class="pc-toolbar"><button type="button" data-pc-login>Подключить подписку</button><button type="button" data-pc-runtime-check>Проверить</button></div><p class="pc-muted">Наличие настроек ещё не означает подключение. Хью отвечает только при подтверждённом входе; недоступный источник не считается подключённым.</p></section>`);
    formSave(state, dialog, form => write(state, "/settings", "PATCH", { replyMode: form.elements.replyMode.value,
      telegramChatId: form.elements.telegramChatId.value.trim(),
      sites: [...form.querySelectorAll("[data-pc-site]:checked")].map(box => box.value) }));
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
  /* Имена персон приходят с сервера: подсказка и правило постановки задания не должны
     разойтись. Человек, не знающий имён, не получит ответа ни от кого — на этом легко
     потерять час, поэтому имена видны всегда, а не только в баннере. */
  const personasSeen = id => {
    try { return window.localStorage.getItem(`pc-personas-seen:${id}`) === "1"; } catch { return false; }
  };
  const markPersonasSeen = id => {
    try { window.localStorage.setItem(`pc-personas-seen:${id}`, "1"); } catch { /* приватный режим — покажем снова */ }
  };
  function renderPersonas(state, personas) {
    const hint = q(state, "[data-pc-personas-hint]"), banner = q(state, "[data-pc-personas]");
    if (!hint || !banner) return;
    if (!personas || !personas.hint) { hint.textContent = ""; banner.hidden = true; return; }
    hint.textContent = personas.hint;
    const info = personas.banner;
    // Состав персон изменится — изменится и идентификатор, и баннер покажется снова.
    if (!info || !info.id || personasSeen(info.id)) { banner.hidden = true; return; }
    q(state, "[data-pc-personas-title]").textContent = info.title || "";
    const list = q(state, "[data-pc-personas-list]");
    list.innerHTML = "";
    for (const line of info.lines || []) {
      const item = state.root.ownerDocument.createElement("li");
      item.textContent = line;
      list.appendChild(item);
    }
    banner.hidden = false;
    const close = q(state, "[data-pc-personas-close]");
    if (close && !close.dataset.bound) {
      close.dataset.bound = "1";
      close.addEventListener("click", () => { markPersonasSeen(info.id); banner.hidden = true; });
    }
  }

  const sharedShell = state => `<div class="pc-layout"><section class="pc-conversation" aria-label="Общий чат проекта"><header class="pc-room-header"><h2>${escape(state.sharedTitle || state.ctx.identity.companies?.find(company => company.id === state.company)?.name || state.company)}</h2><p class="opc-audience opc-audience-shared" role="note">Общий чат проекта: сообщения видят клиент и участники, они уходят в Telegram проекта.</p><p data-pc-members></p><p class="pc-muted" data-pc-connection></p><p class="pc-muted" data-pc-ai></p><section class="pc-personas" data-pc-personas hidden role="note"><h3 data-pc-personas-title></h3><ul data-pc-personas-list></ul><button type="button" data-pc-personas-close>Понятно</button></section><button type="button" data-pc-retry-ai hidden>Повторить ответы Хью</button></header><div class="pc-history-more"><button type="button" data-pc-older hidden>Показать более ранние сообщения</button></div><ol class="pc-messages" data-pc-messages aria-label="Общая переписка" role="log" aria-live="polite"><li class="pc-empty">Загрузка…</li></ol><p data-pc-sync class="pc-muted pc-sync" role="status"></p><form data-pc-compose class="pc-compose" hidden><label class="sr-only" for="pc-message-input">Сообщение участникам проекта</label><textarea id="pc-message-input" name="text" rows="2" maxlength="12000" placeholder="Сообщение участникам проекта…"></textarea><p class="pc-muted pc-personas-hint" data-pc-personas-hint></p><div data-pc-pending class="pc-pending"></div><div class="pc-toolbar"><label class="pc-file-button">Прикрепить фото или файл<input type="file" multiple data-pc-upload aria-label="Прикрепить фото или файл"></label><button type="button" data-pc-schedule data-pc-write hidden>Запланировать</button><button type="submit">Отправить</button></div></form><p data-pc-readonly class="pc-muted pc-readonly" hidden>У вас доступ к просмотру. Для сообщений нужно право ответа в чате проекта.</p></section><aside class="pc-project"><div class="pc-toolbar"><h2>Задачи <span data-pc-task-count></span></h2><button type="button" data-pc-new-task data-pc-write hidden>Добавить</button></div><ul class="pc-tasks" data-pc-tasks></ul><section class="pc-scheduled" data-pc-scheduled-block hidden><h3>Запланировано</h3><ul data-pc-scheduled></ul></section><div class="pc-project-actions"><button type="button" data-pc-stages data-pc-write hidden>Этапы проекта</button><button type="button" data-pc-import data-pc-owner hidden>Импорт реестра</button><button type="button" data-pc-edit-members data-pc-owner hidden>Участники</button><button type="button" data-pc-settings data-pc-owner hidden>Настройки чата</button></div></aside></div>`;
  const switchMode = async (state, mode) => {
    if (!active(state) || (mode === "private" && state.ctx.identity.role !== "owner")) return;
    const body = q(state, "[data-pc-body]");
    if (!body) return;
    // An unsent draft belongs to the person, not to the tab that was open.
    const draft = body.querySelector("[data-pc-compose] textarea");
    if (draft && !state.revoked) state.draft = draft.value;
    cabinet.ownerPrivateChat?.stop();
    state.mode = mode;
    state.view++;
    const view = state.view;
    state.readSequence++;
    clearTimeout(state.timer);
    clearTimeout(state.loginTimer);
    releaseAssets(state);
    state.root.querySelectorAll("dialog").forEach(dialog => dialog.remove());
    state.root.querySelectorAll("[data-pc-mode]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.pcMode === mode)));
    if (mode === "private") {
      body.innerHTML = '<div data-pc-private></div>';
      const host = body.querySelector("[data-pc-private]");
      // Личная переписка идёт по собственному маршруту с серверной проверкой владельца.
      // Область каждой записи — владелец и проект; общий чат её не читает.
      const started = await cabinet.ownerPrivateChat?.render({
        identity: state.ctx.identity, root: host, escapeHTML: escape,
        project: state.company, openShared: () => switchMode(state, "shared")
      });
      if (!started) host.innerHTML = '<p class="pc-muted">Личная переписка доступна только владельцу.</p>';
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
    if (current) { current.controller.abort(); clearTimeout(current.timer); clearTimeout(current.loginTimer); releaseAssets(current); }
    cabinet.ownerPrivateChat?.stop();
    const root = ctx.byId("hugh-view");
    const state = current = { ctx, root, selectedCompany: ctx.selectedProjectId, company: ctx.selectedProjectId, base: "/content/project-chat/" + encodeURIComponent(ctx.selectedProjectId), controller: new AbortController(), mode: "shared", view: 0, readSequence: 0, attachments: [], history: [], seen: new Map(), loadedOlder: false, hasMore: false, cursor: null, loadingOlder: false, busy: false, attempt: null, draft: "", revoked: false };
    root.innerHTML = '<p role="status">Открываем переписку…</p>';
    try {
      const resolved = ctx.authHeaders ? {shared:false} : await request(state, '/resolve');
      if (!active(state)) return;
      state.sharedTitle = resolved.title;
      if (resolved.shared && /^[a-z0-9_-]+$/.test(resolved.companyCode)) {
        state.company = resolved.companyCode;
        state.base = '/content/project-chat/' + encodeURIComponent(state.company);
        state.sharedTitle = resolved.title;
      }
    } catch (error) {
      if (!active(state) || error.name === 'AbortError') return;
      root.innerHTML = `<p role="alert">${escape(error.message)}</p>`;
      return;
    }
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
      if (button.matches("[data-pc-schedule]")) scheduleDialog(state);
      if (button.matches("[data-pc-task-remind]")) {
        const task = list(state.data?.tasks).find(row => String(row.id) === button.dataset.pcTaskRemind);
        if (task) scheduleDialog(state, { task });
      }
      if (button.matches("[data-pc-schedule-edit]")) {
        const item = list(state.data?.scheduled).find(row => String(row.id) === button.dataset.pcScheduleEdit);
        if (item) scheduleDialog(state, { item });
      }
      if (button.matches("[data-pc-schedule-cancel]")) cancelScheduled(state, button.dataset.pcScheduleCancel);
      if (button.matches("[data-pc-import]")) importDialog(state);
      if (button.matches("[data-pc-settings]")) settingsDialog(state);
    };
    await switchMode(state, "shared");
  };
  // Хост без постоянной страницы (Mini App) снимает вид явно: опрос, blob-адреса, диалоги и поздние ответы.
  const unmount = () => {
    if (!current) return;
    current.controller.abort();
    clearTimeout(current.timer);
    clearTimeout(current.loginTimer);
    releaseAssets(current);
    current.root?.querySelectorAll("dialog").forEach(dialog => dialog.remove());
    current = null;
  };
  cabinet.registerView("hugh", { title: "Хью", render: mount, onProjectChange: ctx => mount(null, ctx), unmount });
})();

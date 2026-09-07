(() => {
  "use strict";

  const cabinet = window.SbCabinet = window.SbCabinet || {};
  const panel = document.getElementById("chat-view");
  let ctx;
  let controller;
  let generation = 0;
  let dialogs = [];
  let selectedId = null;
  let status = "loading";
  let errorText = "";
  let nextRequestAt = 0;

  // The shell activates iframe URLs before calling render. Remove the obsolete inbox now.
  panel.replaceChildren();

  const wait = (delay, signal) => new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Запрос отменён", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, Math.max(0, delay));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  const query = async (context, path, scope, signal) => {
    // CRM defaults to 120 reads/minute; non-owner detail reads also perform a scope lookup.
    const interval = context.identity.role === "owner" ? 750 : 1500;
    for (let attempt = 0; attempt < 3; attempt++) {
      const scheduled = Math.max(Date.now(), nextRequestAt);
      nextRequestAt = scheduled + interval;
      await wait(scheduled - Date.now(), signal);
      try {
        return await context.crmQuery(path, { ...scope }, { signal });
      } catch (error) {
        const limited = ["Слишком много запросов", "CRM_HTTP_429"].includes(error.message);
        if (!limited || attempt === 2 || signal.aborted) throw error;
        nextRequestAt = Math.max(nextRequestAt, Date.now() + 60000);
      }
    }
  };
  const value = (input) => String(input ?? "").trim() ? String(input) : "—";
  const escape = (input) => ctx.escapeHTML(value(input));
  const timestamp = (input) => Date.parse(input) || 0;
  const dateLabel = (input) => timestamp(input) ? new Date(input).toLocaleString("ru-RU", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
  }) : "—";
  const firstValue = (...items) => items.find((item) => String(item ?? "").trim());
  const leadName = (lead) => firstValue(lead.name, lead.contact);
  const inScope = (lead, scope) => !scope.companyCode ||
    String(lead.companyCode ?? "").toLowerCase() === String(scope.companyCode).toLowerCase();
  const messagesByTime = (messages) => [...messages].sort((a, b) =>
    timestamp(a.createdAt) - timestamp(b.createdAt) || Number(a.id) - Number(b.id));
  const timeHTML = (input) => timestamp(input)
    ? `<time datetime="${escape(new Date(input).toISOString())}">${escape(dateLabel(input))}</time>`
    : "<span>—</span>";
  const direction = (message) => {
    const author = String(message.author ?? "").trim().toLowerCase();
    if (["incoming", "inbound", "входящее"].includes(author)) return ["incoming", "Входящее"];
    if (["outgoing", "outbound", "исходящее"].includes(author)) return ["outgoing", "Исходящее"];
    return ["unknown", "Направление: —"];
  };
  const stateHTML = (text, isError = false) =>
    `<p class="chat-state${isError ? " chat-error" : ""}" role="${isError ? "alert" : "status"}">
      ${escape(text)}</p>`;
  const listHTML = () => {
    if (status === "loading") return stateHTML("Загружаю…");
    if (status === "error") return `${stateHTML(errorText, true)}
      <button type="button" class="plain-button chat-retry" data-chat-retry>Повторить</button>`;
    if (!dialogs.length) return stateHTML("Пока нет диалогов");
    return `<ul class="chat-dialogs">${dialogs.map((lead) => `
      <li><button type="button" class="chat-dialog" data-chat-id="${escape(lead.id)}"
        aria-pressed="${String(String(lead.id) === selectedId)}" aria-controls="chat-conversation">
        <strong>${escape(leadName(lead))}</strong>
        <span class="chat-dialog-source">${escape(firstValue(lead.channel, lead.source))}</span>
        <span class="chat-dialog-time">${timeHTML(lead.lastMessageAt)}</span>
        <span class="chat-stage">${escape(lead.stage)}</span>
      </button></li>`).join("")}</ul>`;
  };
  const conversationHTML = () => {
    const lead = dialogs.find((item) => String(item.id) === selectedId);
    if (!lead) return stateHTML("Выберите диалог, чтобы посмотреть переписку");
    return `
      <header class="chat-conversation-header">
        <button type="button" class="plain-button chat-back" data-chat-back>Назад</button>
        <div><h2 tabindex="-1" data-chat-heading>${escape(leadName(lead))}</h2>
          <p>${escape(firstValue(lead.channel, lead.source))}</p></div>
      </header>
      <ol class="chat-messages" aria-label="Сообщения">
        ${lead.messages.map((message) => {
          const [kind, label] = direction(message);
          return `<li class="chat-message chat-message-${kind}">
            <div class="chat-message-meta"><strong>${label}</strong>${timeHTML(message.createdAt)}</div>
            <p class="chat-message-author">Автор: ${escape(message.author)}</p>
            <p class="chat-message-text">${escape(message.text)}</p>
          </li>`;
        }).join("")}
      </ol>
      <footer class="chat-crm-link">
        <div><span>Этап заявки</span><strong>${escape(lead.stage)}</strong></div>
        ${ctx.hasPermission("crm.view") ? `<button type="button" class="plain-button"
          data-chat-lead="${escape(lead.id)}">
          Открыть карточку заявки
        </button>` : ""}
      </footer>`;
  };
  const render = () => {
    panel.innerHTML = `
      <div class="content-header"><h1>Чат</h1></div>
      <div class="cabinet-chat${selectedId ? " is-conversation" : ""}">
        <section class="chat-list" aria-label="Диалоги" aria-busy="${status === "loading"}">
          <h2 class="chat-list-title">Диалоги${status === "ready" ? ` · ${dialogs.length}` : ""}</h2>
          ${listHTML()}
        </section>
        <section class="chat-conversation" id="chat-conversation" aria-label="Переписка">
          ${conversationHTML()}
        </section>
      </div>`;
  };
  const load = async (context) => {
    ctx = context;
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    const current = ++generation;
    const scope = { ...ctx.scopeParams() };
    const project = ctx.selectedProjectId;
    const active = () => current === generation && ctx.currentView === "chat" &&
      project === ctx.selectedProjectId && !signal.aborted;
    dialogs = [];
    selectedId = null;
    status = "loading";
    render();
    try {
      const payload = await query(ctx, "/leads", scope, signal);
      if (!active()) return;
      if (!Array.isArray(payload?.leads)) throw new Error("CRM вернула некорректный список заявок");
      const leads = payload.leads.filter((lead) => inScope(lead, scope));
      const found = [];
      let next = 0;
      // The existing CRM embeds messages in GET /leads/:id, with no message summary on the list.
      const worker = async () => {
        while (next < leads.length && active()) {
          const item = leads[next++];
          const lead = await query(ctx, `/leads/${encodeURIComponent(item.id)}`, scope, signal);
          if (!active()) return;
          if (!inScope(lead, scope)) continue;
          if (!Array.isArray(lead.messages)) throw new Error("CRM вернула некорректную переписку заявки");
          if (!lead.messages.length) continue;
          const messages = messagesByTime(lead.messages);
          found.push({ ...lead, messages, lastMessageAt: messages.at(-1).createdAt });
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, leads.length) }, worker));
      if (!active()) return;
      dialogs = found.sort((a, b) => timestamp(b.lastMessageAt) - timestamp(a.lastMessageAt) || b.id - a.id);
      status = "ready";
      render();
    } catch (error) {
      if (!active()) return;
      controller.abort();
      status = "error";
      errorText = error.message || String(error);
      render();
    }
  };
  panel.addEventListener("click", (event) => {
    const dialog = event.target.closest("[data-chat-id]");
    if (dialog) {
      selectedId = dialog.dataset.chatId;
      render();
      panel.querySelector("[data-chat-heading]")?.focus();
    }
    if (event.target.closest("[data-chat-back]")) {
      const previous = selectedId;
      selectedId = null;
      render();
      [...panel.querySelectorAll("[data-chat-id]")].find((item) => item.dataset.chatId === previous)?.focus();
    }
    if (event.target.closest("[data-chat-retry]")) load(ctx);
    const lead = event.target.closest("[data-chat-lead]");
    if (lead && ctx.hasPermission("crm.view")) ctx.navigate(`crm?lead=${encodeURIComponent(lead.dataset.chatLead)}`);
  });
  cabinet.registerView("chat", { title: "Чат", render: (_, context) => load(context), onProjectChange: load });

  // The native leads view has no card route. Add a scoped read-only route without changing its list.
  const leadsView = cabinet.views.crm;
  let cardController;
  let cardGeneration = 0;
  const cardId = () => new URLSearchParams(location.hash.split("?")[1]).get("lead");
  const renderCard = async (container, context) => {
    ctx = context;
    cardController?.abort();
    cardController = new AbortController();
    const { signal } = cardController;
    const current = ++cardGeneration;
    const id = cardId();
    const scope = { ...context.scopeParams() };
    const project = context.selectedProjectId;
    container.classList.add("chat-show-lead");
    let card = container.querySelector(".chat-lead-card");
    if (!card) {
      card = document.createElement("article");
      card.className = "chat-lead-card card";
      container.append(card);
      card.addEventListener("click", (event) => {
        if (event.target.closest("[data-chat-return]")) context.navigate("chat");
        if (event.target.closest("[data-chat-crm]")) context.navigate("crm");
      });
    }
    card.innerHTML = stateHTML("Загружаю…");
    const back = `<div class="chat-card-actions">
      <button type="button" class="plain-button" data-chat-return>Назад к диалогам</button>
      <button type="button" class="plain-button" data-chat-crm>Все заявки</button></div>`;
    const active = () => current === cardGeneration && context.currentView === "crm" &&
      project === context.selectedProjectId && id === cardId() && !signal.aborted;
    try {
      if (!/^\d+$/.test(id)) throw new Error("Некорректный номер заявки");
      const lead = await query(context, `/leads/${encodeURIComponent(id)}`, scope, signal);
      if (!active()) return;
      if (!inScope(lead, scope)) throw new Error("Заявка недоступна в выбранном проекте");
      const fields = [["Контакт", lead.contact], ["Канал", lead.channel], ["Источник", lead.source],
        ["Этап заявки", lead.stage], ["Создана", dateLabel(lead.createdAt)], ["Комментарий", lead.comment]];
      card.innerHTML = `<h1>Карточка заявки</h1><h2>${escape(leadName(lead))}</h2>
        <dl class="chat-lead-fields">${fields.map(([label, item]) =>
          `<div><dt>${label}</dt><dd>${escape(item)}</dd></div>`).join("")}</dl>${back}`;
    } catch (error) {
      if (active()) card.innerHTML = stateHTML(error.message || String(error), true) + back;
    }
  };
  const closeCard = (container) => {
    cardGeneration++;
    cardController?.abort();
    container.classList.remove("chat-show-lead");
    container.querySelector(".chat-lead-card")?.remove();
  };
  cabinet.registerView("crm", {
    ...leadsView,
    render(container, context) {
      if (cardId() !== null) return renderCard(container, context);
      closeCard(container);
      return leadsView.render(container, context);
    },
    onProjectChange(context) {
      if (cardId() !== null) return renderCard(context.byId("crm-view"), context);
      return leadsView.onProjectChange(context);
    }
  });
})();

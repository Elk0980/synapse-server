(() => {
  "use strict";

  const cabinet = window.SbCabinet = window.SbCabinet || {};
  let context;
  let controller;
  let conversation;
  let sending = false;

  const storageKey = () => [
    "synapse_hugh_conversation",
    context.identity.userId,
    context.selectedProjectId
  ].join(":");

  const savedConversation = () => {
    try {
      return JSON.parse(localStorage.getItem(storageKey()) || "null");
    } catch (error) {
      return null;
    }
  };

  const saveConversation = (value) => {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(value));
    } catch (error) {
      // The current conversation remains available until the page is closed.
    }
  };

  const request = async (path, options = {}) => {
    const response = await fetch(`/content/hugh${path}`, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Не удалось связаться с Хью");
    return body;
  };

  const unsafeOptions = (method, body, token) => ({
    method,
    headers: {
      "X-CSRF-Token": context.identity.csrfToken,
      ...(token ? { "X-Visitor-Token": token } : {})
    },
    body: JSON.stringify(body)
  });

  const messageText = (message) => message.text || "";
  const messageRole = (message) => {
    if (["assistant", "system"].includes(message.role)) return "assistant";
    return "owner";
  };

  const messagesHTML = (messages) => messages.map((message) => {
    const role = messageRole(message);
    const author = role === "assistant" ? "Хью" : "Вы";
    return `<li class="hugh-message hugh-message-${role}">
      <span class="hugh-author">${author}</span>
      <p>${context.escapeHTML(messageText(message))}</p>
    </li>`;
  }).join("");

  const shellHTML = () => `<div class="content-header"><h1>Хью</h1></div>
    <div class="hugh-chat">
      <div class="hugh-messages" id="hugh-messages" role="log" aria-live="polite"></div>
      <form class="hugh-compose" id="hugh-form">
        <label class="sr-only" for="hugh-input">Сообщение Хью</label>
        <textarea id="hugh-input" rows="1" maxlength="4000" placeholder="Напишите Хью…" required></textarea>
        <button type="submit">Отправить</button>
      </form>
    </div>`;

  const showMessages = (messages) => {
    const list = context.byId("hugh-messages");
    list.innerHTML = `<ul>${messagesHTML(messages)}</ul>`;
    list.scrollTop = list.scrollHeight;
  };

  const showError = (message, retry) => {
    const list = context.byId("hugh-messages");
    list.innerHTML = `<div class="hugh-error" role="alert">
      <p>${context.escapeHTML(message)}</p><button type="button">Повторить</button>
    </div>`;
    list.querySelector("button").addEventListener("click", retry, { once: true });
  };

  const createConversation = async (signal) => {
    const project = context.selectedProjectId;
    const result = await request("/conversations", {
      ...unsafeOptions("POST", { site: project, title: `Хью · ${project}` }),
      signal
    });
    const saved = { id: result.id, token: result.visitorToken };
    saveConversation(saved);
    return saved;
  };

  const load = async (newContext) => {
    context = newContext;
    controller?.abort();
    controller = new AbortController();
    conversation = null;
    const panel = context.byId("hugh-view");
    panel.innerHTML = shellHTML();
    context.byId("hugh-messages").textContent = "Загрузка…";
    context.byId("hugh-form").addEventListener("submit", send);
    try {
      let saved = savedConversation();
      if (!saved?.id || !saved?.token) saved = await createConversation(controller.signal);
      const result = await request(`/conversations/${encodeURIComponent(saved.id)}`, {
        signal: controller.signal
      });
      conversation = { ...saved, messages: Array.isArray(result.messages) ? result.messages : [] };
      showMessages(conversation.messages);
    } catch (error) {
      if (error.name !== "AbortError") showError(error.message, () => load(context));
    }
  };

  const send = async (event) => {
    event.preventDefault();
    const input = context.byId("hugh-input");
    const text = input.value.trim();
    if (!text || sending || !conversation) return;
    sending = true;
    input.disabled = true;
    event.currentTarget.querySelector("button").disabled = true;
    try {
      const result = await request(`/conversations/${encodeURIComponent(conversation.id)}/messages`, {
        ...unsafeOptions("POST", { text }, conversation.token),
        signal: controller.signal
      });
      conversation.messages.push({ role: "owner", text }, { role: "assistant", text: result.reply });
      input.value = "";
      showMessages(conversation.messages);
    } catch (error) {
      if (error.name !== "AbortError") showError(error.message, () => load(context));
    } finally {
      sending = false;
      input.disabled = false;
      event.currentTarget.querySelector("button").disabled = false;
      input.focus();
    }
  };

  cabinet.registerView("hugh", { title: "Хью", render: (_, ctx) => load(ctx), onProjectChange: load });
})();

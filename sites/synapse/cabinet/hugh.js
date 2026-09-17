(() => {
  "use strict";

  const cabinet = window.SbCabinet = window.SbCabinet || {};
  let context;
  let controller;
  let conversation;
  let sending = false;
  // The shared project chat can replace this panel at any moment. Every load and send
  // carries the generation it started in, so a late answer never writes into a gone view.
  let generation = 0;
  const outdated = (run) => run !== generation || !context;
  const panelNode = (id) => {
    const node = context?.byId(id);
    return node && node.isConnected ? node : null;
  };

  const storageKey = (project) => [
    "synapse_hugh_conversation",
    context.identity.userId,
    project
  ].join(":");

  const savedConversation = (project) => {
    try {
      return JSON.parse(localStorage.getItem(storageKey(project)) || "null");
    } catch (error) {
      return null;
    }
  };

  const saveConversation = (project, value) => {
    try {
      localStorage.setItem(storageKey(project), JSON.stringify(value));
    } catch (error) {
      // The current conversation remains available until the page is closed.
    }
  };

  const request = async (path, options = {}) => {
    let response;
    try {
      response = await fetch(`/content/hugh${path}`, {
        credentials: "same-origin",
        cache: "no-store",
        ...options,
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
        headers: { "Content-Type": "application/json", ...(options.headers || {}) }
      });
    } catch (error) {
      if (error.name === "TimeoutError") throw new Error("Время ожидания истекло (15 секунд)");
      throw error;
    }
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
      <span class="hugh-author sb-hugh-author">${role === "assistant" ? '<span class="sb-orb" aria-hidden="true"><i class="sb-orb__stone"></i><i class="sb-orb__current"></i><i class="sb-orb__pulse"></i></span>' : ""}${author}</span>
      <p>${context.escapeHTML(messageText(message))}</p>
    </li>`;
  }).join("");

  const shellHTML = () => `<div class="content-header"><div class="sb-hugh-heading"><span class="sb-orb" aria-hidden="true"><i class="sb-orb__stone"></i><i class="sb-orb__current"></i><i class="sb-orb__pulse"></i></span><h1>Хью</h1></div></div>
    <div class="hugh-chat">
      <div class="hugh-messages" id="hugh-messages" role="log" aria-live="polite"></div>
      <form class="hugh-compose" id="hugh-form">
        <label class="sr-only" for="hugh-input">Сообщение Хью</label>
        <textarea id="hugh-input" rows="1" maxlength="4000" placeholder="Напишите Хью…" required></textarea>
        <button type="submit">Отправить</button>
      </form>
    </div>`;

  const showMessages = (messages) => {
    const list = panelNode("hugh-messages");
    if (!list) return;
    list.innerHTML = `<ul>${messagesHTML(messages)}</ul>`;
    list.scrollTop = list.scrollHeight;
  };

  const showError = (message, retry) => {
    const list = panelNode("hugh-messages");
    if (!list) return;
    list.innerHTML = `<div class="hugh-error" role="alert">
      <p>${context.escapeHTML(message)}</p><button type="button">Повторить</button>
    </div>`;
    list.querySelector("button").addEventListener("click", retry, { once: true });
  };

  const createConversation = async (project, signal) => {
    const result = await request("/conversations", {
      ...unsafeOptions("POST", { site: project, title: `Хью · ${project}` }),
      signal
    });
    const saved = { id: result.id, token: result.visitorToken, reply: result.reply };
    saveConversation(project, saved);
    return saved;
  };

  const load = async (newContext) => {
    const run = ++generation;
    context = newContext;
    const project = context.selectedProjectId;
    controller?.abort();
    controller = new AbortController();
    conversation = null;
    const panel = context.byId("hugh-view");
    if (!panel) return;
    panel.innerHTML = shellHTML();
    const messagesNode = panelNode("hugh-messages");
    if (messagesNode) messagesNode.textContent = "Загрузка…";
    panelNode("hugh-form")?.addEventListener("submit", send);
    try {
      let saved = savedConversation(project);
      if (!saved?.id || !saved?.token) saved = await createConversation(project, controller.signal);
      if (outdated(run)) return;
      const result = await request(`/conversations/${encodeURIComponent(saved.id)}`, {
        signal: controller.signal
      });
      if (outdated(run)) return;
      const messages = Array.isArray(result.messages) ? result.messages : [];
      if (saved.reply && !messages.length) messages.push({ role: "assistant", text: saved.reply });
      conversation = { ...saved, messages };
      showMessages(conversation.messages);
    } catch (error) {
      if (outdated(run) || error.name === "AbortError") return;
      showError(`Не удалось загрузить: ${error.message}`, () => load(context));
    }
  };

  const send = async (event) => {
    event.preventDefault();
    const run = generation;
    const form = event.currentTarget;
    const button = form.querySelector("button");
    const input = panelNode("hugh-input");
    const text = input ? input.value.trim() : "";
    if (!text || sending || !conversation) return;
    sending = true;
    input.disabled = true;
    button.disabled = true;
    try {
      const result = await request(`/conversations/${encodeURIComponent(conversation.id)}/messages`, {
        ...unsafeOptions("POST", { text }, conversation.token),
        signal: controller.signal
      });
      if (outdated(run) || !conversation) return;
      conversation.messages.push({ role: "owner", text }, { role: "assistant", text: result.reply });
      input.value = "";
      showMessages(conversation.messages);
    } catch (error) {
      if (outdated(run) || error.name === "AbortError") return;
      showError(error.message, () => load(context));
    } finally {
      sending = false;
      input.disabled = false;
      button.disabled = false;
      if (!outdated(run) && input.isConnected) input.focus();
    }
  };

  cabinet.privateHugh = {
    render: load,
    stop() { generation += 1; controller?.abort(); conversation = null; }
  };
})();

(() => {
  "use strict";
  /* Личная переписка владельца с Хью по проектам во вкладке «Хью».

     Аудитория обозначена в самом интерфейсе: личная вкладка и общий чат проекта выглядят
     по-разному и подписаны прямо, чтобы сообщение нельзя было отправить «не туда».
     Личная история не сохраняется в браузере: она приходит с сервера при каждом открытии,
     поэтому в localStorage и в адресе страницы её нет. */
  const cabinet = window.SbCabinet = window.SbCabinet || {};
  const AUDIENCE_LABEL = "Личная переписка: только вы и Хью. Клиент её не видит.";
  let context = null, controller = null, generation = 0, state = null, sending = false;

  const outdated = (run) => run !== generation || !context;
  const escape = (value) => context.escapeHTML(String(value ?? ""));
  const node = (selector) => (state?.root && state.root.isConnected ? state.root.querySelector(selector) : null);

  async function request(path, options = {}) {
    const response = await fetch(`/content/owner-chat${path}`, {
      credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)])
        : AbortSignal.timeout(120000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Не удалось связаться с Хью");
    return body;
  }

  const tabsHTML = (data, current) => data.projects.map((project) => `<button type="button"
    class="opc-tab" data-opc-project="${escape(project.id)}"
    aria-pressed="${String(project.id === current)}">${escape(project.name)}</button>`).join("");

  const messagesHTML = (messages) => (messages.length
    ? messages.map((message) => {
      const mine = message.author !== "assistant";
      return `<li class="opc-message opc-message-${mine ? "owner" : "assistant"}">
        <span class="opc-author">${mine ? "Вы" : "Хью"}</span>
        <p>${escape(message.text)}</p></li>`;
    }).join("")
    : '<li class="opc-empty">Здесь пока пусто. Это ваша личная переписка по проекту.</li>');

  const tasksHTML = (tasks) => (tasks.length
    ? tasks.map((task) => `<li class="opc-task"><span class="opc-task-title">${escape(task.title)}</span>
        <span class="opc-task-status">${escape(task.status)}${task.due ? ` · до ${escape(task.due)}` : ""}</span></li>`).join("")
    : '<li class="opc-empty">Задач проекта пока нет.</li>');

  function render(data) {
    if (!state?.root || !state.root.isConnected) return;
    state.data = data;
    state.root.innerHTML = `
      <nav class="opc-tabs" aria-label="Проекты личной переписки">${tabsHTML(data, state.project)}</nav>
      <p class="opc-audience opc-audience-private" role="note">${escape(data.audienceLabel || AUDIENCE_LABEL)}</p>
      <div class="opc-layout">
        <section class="opc-conversation" aria-label="Личная переписка с Хью">
          <ol class="opc-messages" data-opc-messages role="log" aria-live="polite">${messagesHTML(data.messages || [])}</ol>
          <p class="opc-state" data-opc-state role="status"></p>
          <form class="opc-compose" data-opc-compose>
            <label class="sr-only" for="opc-input">Личное сообщение Хью</label>
            <textarea id="opc-input" name="text" rows="2" maxlength="4000"
              placeholder="Личное сообщение Хью по проекту…"></textarea>
            <button type="submit">Отправить лично</button>
          </form>
        </section>
        <aside class="opc-project" aria-label="Задачи проекта">
          <h3>Задачи проекта</h3>
          <p class="opc-muted">Только для чтения. Личная переписка сюда не попадает.</p>
          <ul class="opc-tasks">${tasksHTML(data.tasks || [])}</ul>
          <p class="opc-audience opc-audience-shared" role="note">${escape(data.clientChat?.label || "Общий чат проекта виден клиенту")}</p>
          <button type="button" class="opc-open-shared" data-opc-shared>Открыть общий чат проекта</button>
        </aside>
      </div>`;
    const compose = node("[data-opc-compose]");
    if (compose) compose.onsubmit = (event) => { event.preventDefault(); void send(); };
    if (state.draft && node("#opc-input")) node("#opc-input").value = state.draft;
  }

  function failure(message, retry) {
    if (!state?.root || !state.root.isConnected) return;
    state.root.innerHTML = `<p class="opc-error" role="alert">${escape(message)}</p>
      <button type="button" data-opc-retry>Повторить</button>`;
    state.root.querySelector("[data-opc-retry]")?.addEventListener("click", retry, { once: true });
  }

  async function load(project) {
    const run = ++generation;
    controller?.abort();
    controller = new AbortController();
    state.project = project;
    state.data = null;
    try {
      const data = await request(`/${encodeURIComponent(project)}`, { signal: controller.signal });
      if (outdated(run)) return;
      render(data);
    } catch (error) {
      if (outdated(run) || error.name === "AbortError") return;
      failure(`Не удалось открыть личную переписку: ${error.message}`, () => load(project));
    }
  }

  async function send() {
    const run = generation;
    const input = node("#opc-input");
    const text = input ? input.value.trim() : "";
    if (!text || sending) return;
    sending = true;
    const status = node("[data-opc-state]");
    const button = node("[data-opc-compose] button");
    if (status) status.textContent = "Хью думает…";
    if (input) input.disabled = true;
    if (button) button.disabled = true;
    try {
      const data = await request(`/${encodeURIComponent(state.project)}/messages`, {
        method: "POST",
        headers: { "X-CSRF-Token": context.identity.csrfToken },
        // Идентификатор запроса защищает от повторной отправки при обрыве связи.
        body: JSON.stringify({ text, requestId: `opc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` }),
        signal: controller.signal
      });
      if (outdated(run)) return;
      state.draft = "";
      render(data);
    } catch (error) {
      if (outdated(run) || error.name === "AbortError") return;
      state.draft = text;
      const note = node("[data-opc-state]");
      if (note) note.textContent = error.message;
      const field = node("#opc-input");
      if (field) { field.disabled = false; field.value = text; }
      const submit = node("[data-opc-compose] button");
      if (submit) submit.disabled = false;
    } finally { sending = false; }
  }

  cabinet.ownerPrivateChat = {
    async render({ identity, root, escapeHTML, project, openShared }) {
      // Вкладка существует только у владельца. Роль приходит из проверенного профиля кабинета,
      // а сервер всё равно проверяет её заново на каждом обращении.
      if (identity?.role !== "owner" || !root) return false;
      context = { identity, escapeHTML };
      state = { root, project, draft: "", data: null, openShared };
      root.onclick = (event) => {
        const button = event.target.closest("button");
        if (!button) return;
        if (button.dataset.opcProject && button.dataset.opcProject !== state.project) {
          state.draft = node("#opc-input")?.value || "";
          void load(button.dataset.opcProject);
          return;
        }
        if (button.matches("[data-opc-shared]")) state.openShared?.();
      };
      await load(project);
      return true;
    },
    stop() { generation += 1; controller?.abort(); controller = null; state = null; context = null; }
  };
})();

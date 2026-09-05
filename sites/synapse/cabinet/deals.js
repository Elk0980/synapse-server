(() => {
  "use strict";

  const cabinet = window.SbCabinet = window.SbCabinet || {};
  const tabs = {
    overview: "Обзор",
    contacts: "Контакты",
    tasks: "Задачи",
    leads: "Лиды",
    chat: "Чат",
    technology: "Дерево технологии"
  };
  const kinds = { open: "открытый", won: "выигрыш", lost: "отказ" };
  const taskStatuses = { inbox: "Входящие", planned: "Запланирована", in_progress: "В работе" };
  const state = {
    stages: [],
    companies: [],
    byCompany: {},
    summaryLoaded: false,
    total: 0,
    pending: new Set(),
    loading: false,
    saving: false,
    refreshRequested: false,
    draft: [],
    overview: null,
    tab: "overview",
    loadVersion: 0,
    drawerVersion: 0
  };
  let ctx;
  let initialized = false;
  let draggedId = null;
  let drawerOpener = null;
  const byId = (id) => ctx.byId(id);
  const html = (value) => ctx.escapeHTML(String(value ?? ""));
  const canEdit = () => ctx.hasPermission("crm.edit");
  const query = (path, params = {}, options = {}) => ctx.crmQuery(path, params, options);
  const date = (value) => {
    if (!value) return "—";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString("ru-RU");
  };
  const companyStage = (company) => company.pipelineStage || state.stages[0]?.code;
  const stageCount = (code) => state.companies.filter((company) => companyStage(company) === code).length;
  const empty = () => '<p class="muted">пока пусто</p>';
  const status = (message = "") => {
    byId("deals-error").textContent = message;
    byId("deals-error").hidden = !message;
  };
  const configureButton = () => {
    const button = byId("deals-configure");
    button.disabled = !canEdit() || !state.stages.length || state.loading || state.pending.size > 0 || state.saving;
    button.title = canEdit() ? "" : "нет прав";
  };
  const companyCard = (company) => {
    const pending = state.pending.has(String(company.id));
    const editable = canEdit() && !pending;
    const draggable = editable && !window.matchMedia("(max-width: 760px)").matches;
    const current = companyStage(company);
    const options = state.stages.map((stage) => {
      const selected = stage.code === current ? " selected" : "";
      return `<option value="${html(stage.code)}"${selected}>${html(stage.label)}</option>`;
    }).join("");
    const summary = state.byCompany[String(company.code).toLowerCase()];
    const tasks = state.summaryLoaded ? summary?.open || 0 : "—";
    return `<article class="deals-company" data-company-id="${html(company.id)}"
      draggable="${draggable}" aria-busy="${pending}">
      <button class="deals-company-open" type="button" data-company-open${pending ? " disabled" : ""}
        aria-label="Компания: ${html(company.name)}">
        <strong>${html(company.name)}</strong><span class="deals-company-code">${html(company.code)}</span>
        <span>${html(company.city || "Город не указан")}</span>
        <span>${html(company.industry || "Отрасль не указана")}</span>
        <span class="deals-company-meta">Открытых задач: ${html(tasks)}</span>
        <span class="deals-company-meta">Начало: ${html(date(company.startDate))}</span>
      </button>
      <label class="deals-stage-select">Этап<select data-deals-stage
        aria-label="Этап компании ${html(company.name)}"${editable ? "" : " disabled"}
        ${canEdit() ? "" : 'title="нет прав"'}>${options}</select></label>
    </article>`;
  };
  const renderBoard = () => {
    byId("deals-board").innerHTML = state.stages.map((stage) => {
      const companies = state.companies.filter((company) => companyStage(company) === stage.code);
      const cards = companies.map(companyCard).join("");
      return `<section class="card deals-column" data-stage-code="${html(stage.code)}"
        data-stage-kind="${html(stage.kind)}" aria-label="${html(stage.label)}">
        <header class="deals-column-heading"><h2>${html(stage.label)}</h2>
        <span class="deals-count" aria-label="Компаний: ${companies.length}">${companies.length}</span></header>
        <div class="deals-column-cards">${cards || '<p class="muted deals-empty">нет компаний</p>'}</div>
      </section>`;
    }).join("");
    const count = `${state.companies.length} компаний`;
    byId("deals-count").textContent = state.total > state.companies.length
      ? `Показано ${state.companies.length} из ${state.total} компаний` : count;
    configureButton();
  };
  const loadBoard = async (preserveError = false) => {
    if (state.pending.size || state.saving) {
      state.refreshRequested = true;
      return;
    }
    if (state.loading) return;
    state.refreshRequested = false;
    const version = ++state.loadVersion;
    state.loading = true;
    configureButton();
    if (!preserveError) status();
    byId("deals-board").setAttribute("aria-busy", "true");
    byId("deals-count").textContent = "Загрузка…";
    try {
      const results = await Promise.allSettled([
        query("/pipeline-stages"),
        query("/companies", { limit: 200, deleted: "exclude" }),
        query("/tasks/summary")
      ]);
      if (version !== state.loadVersion) return;
      const [stages, companies, summary] = results;
      if (stages.status === "rejected") throw stages.reason;
      if (companies.status === "rejected") throw companies.reason;
      state.stages = stages.value.stages || [];
      state.companies = companies.value.companies || [];
      state.total = companies.value.pagination?.total ?? state.companies.length;
      state.summaryLoaded = summary.status === "fulfilled";
      state.byCompany = Object.fromEntries(Object.entries(summary.value?.byCompany || {}).map(([code, value]) => {
        return [code.toLowerCase(), value];
      }));
      if (!state.stages.length) throw new Error("Воронка не содержит этапов");
      renderBoard();
      if (!state.summaryLoaded) status(`Счётчики задач недоступны: ${summary.reason.message}`);
    } catch (error) {
      if (version !== state.loadVersion) return;
      status(error.message);
      byId("deals-count").textContent = "Не удалось загрузить воронку";
    } finally {
      if (version === state.loadVersion) {
        state.loading = false;
        byId("deals-board").setAttribute("aria-busy", "false");
        configureButton();
      }
    }
  };
  const finishMutation = () => {
    configureButton();
    if (state.refreshRequested && !state.pending.size && !state.saving && ctx.currentView === "deals") {
      loadBoard(true);
    }
  };
  const moveCompany = async (id, stageCode) => {
    const company = state.companies.find((item) => String(item.id) === String(id));
    if (!canEdit() || !company || state.pending.has(String(id)) || state.saving || state.loading) return;
    if (!state.stages.some((stage) => stage.code === stageCode)) return;
    if (companyStage(company) === stageCode) return;
    const previous = company.pipelineStage;
    state.pending.add(String(id));
    company.pipelineStage = stageCode;
    status();
    renderBoard();
    try {
      await query(`/companies/${encodeURIComponent(id)}`, {}, ctx.csrfOptions("PATCH", { pipelineStage: stageCode }));
    } catch (error) {
      company.pipelineStage = previous;
      status(error.message);
    } finally {
      state.pending.delete(String(id));
      renderBoard();
      finishMutation();
    }
  };
  const clearDrag = () => {
    draggedId = null;
    byId("deals-board").querySelectorAll(".is-dragging, .is-drag-over").forEach((element) => {
      element.classList.remove("is-dragging", "is-drag-over");
    });
  };
  const bindBoard = () => {
    const board = byId("deals-board");
    board.addEventListener("click", (event) => {
      const button = event.target.closest("[data-company-open]");
      if (button) openDrawer(button.closest("[data-company-id]").dataset.companyId, button);
    });
    board.addEventListener("change", (event) => {
      if (!event.target.matches("[data-deals-stage]")) return;
      moveCompany(event.target.closest("[data-company-id]").dataset.companyId, event.target.value);
    });
    board.addEventListener("dragstart", (event) => {
      const card = event.target.closest("[data-company-id]");
      if (!card || card.draggable !== true || !canEdit() || state.loading) {
        event.preventDefault();
        return;
      }
      draggedId = card.dataset.companyId;
      event.dataTransfer.setData("text/plain", draggedId);
      event.dataTransfer.effectAllowed = "move";
      card.classList.add("is-dragging");
    });
    board.addEventListener("dragover", (event) => {
      const column = event.target.closest("[data-stage-code]");
      if (!column || !draggedId || !canEdit()) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      column.classList.add("is-drag-over");
    });
    board.addEventListener("dragleave", (event) => {
      const column = event.target.closest("[data-stage-code]");
      if (column && !column.contains(event.relatedTarget)) column.classList.remove("is-drag-over");
    });
    board.addEventListener("drop", (event) => {
      const column = event.target.closest("[data-stage-code]");
      if (!column || !draggedId) return;
      event.preventDefault();
      const id = draggedId;
      clearDrag();
      moveCompany(id, column.dataset.stageCode);
    });
    board.addEventListener("dragend", clearDrag);
  };
  const stageRow = (stage, index) => {
    const count = stage.code ? stageCount(stage.code) : 0;
    const options = Object.entries(kinds).map(([kind, label]) => {
      return `<option value="${kind}"${kind === stage.kind ? " selected" : ""}>${label}</option>`;
    }).join("");
    return `<div class="deals-stage-row" data-stage-index="${index}">
      <label>Название<input data-stage-label required maxlength="40" value="${html(stage.label)}"></label>
      <label>Тип<select data-stage-kind>${options}</select></label>
      <div class="deals-stage-actions">
        <button class="plain-button" type="button" data-stage-up${index === 0 ? " disabled" : ""}
          aria-label="Поднять этап ${html(stage.label)}">↑</button>
        <button class="plain-button" type="button" data-stage-down
          ${index === state.draft.length - 1 ? "disabled" : ""}
          aria-label="Опустить этап ${html(stage.label)}">↓</button>
        <button class="plain-button" type="button" data-stage-delete
          ${count || state.draft.length === 1 ? "disabled" : ""}>Удалить</button>
        <span class="muted">${count} компаний</span>
      </div>
    </div>`;
  };
  const renderSettings = () => {
    byId("deals-stage-rows").innerHTML = state.draft.map(stageRow).join("");
    byId("deals-stage-add").disabled = state.draft.length >= 12;
  };
  const readDraft = () => {
    byId("deals-stage-rows").querySelectorAll("[data-stage-index]").forEach((row, index) => {
      state.draft[index].label = row.querySelector("[data-stage-label]").value;
      state.draft[index].kind = row.querySelector("[data-stage-kind]").value;
    });
  };
  const openSettings = () => {
    if (!canEdit() || state.loading || state.pending.size || !state.stages.length) return;
    state.draft = state.stages.map(({ code, label, kind }) => ({ code, label, kind }));
    byId("deals-settings-error").textContent = "";
    renderSettings();
    byId("deals-settings").showModal();
  };
  const saveSettings = async (event) => {
    event.preventDefault();
    if (!canEdit() || state.saving) return;
    readDraft();
    const stages = state.draft.map((stage) => ({ ...stage, label: stage.label.trim() }));
    const error = byId("deals-settings-error");
    if (stages.some((stage) => !stage.label || [...stage.label].length > 40)) {
      error.textContent = "Название этапа должно содержать от 1 до 40 символов";
      return;
    }
    error.textContent = "";
    state.saving = true;
    byId("deals-settings-fields").disabled = true;
    try {
      const saved = await query("/pipeline-stages", {}, ctx.csrfOptions("PUT", { stages }));
      state.stages = saved.stages;
      renderBoard();
      byId("deals-settings").close();
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      state.saving = false;
      byId("deals-settings-fields").disabled = false;
      finishMutation();
    }
  };
  const bindSettings = () => {
    byId("deals-configure").addEventListener("click", openSettings);
    byId("deals-settings-form").addEventListener("submit", saveSettings);
    byId("deals-stage-add").addEventListener("click", () => {
      if (state.draft.length >= 12 || state.saving) return;
      readDraft();
      state.draft.push({ label: "", kind: "open" });
      renderSettings();
      byId("deals-stage-rows").lastElementChild.querySelector("input").focus();
    });
    byId("deals-stage-rows").addEventListener("click", (event) => {
      const row = event.target.closest("[data-stage-index]");
      const button = event.target.closest("button");
      if (!row || !button || button.disabled || state.saving) return;
      readDraft();
      const index = Number(row.dataset.stageIndex);
      if (button.hasAttribute("data-stage-delete")) {
        state.draft.splice(index, 1);
      } else {
        const other = index + (button.hasAttribute("data-stage-up") ? -1 : 1);
        [state.draft[index], state.draft[other]] = [state.draft[other], state.draft[index]];
      }
      renderSettings();
    });
  };
  const details = (record, fields) => {
    const rows = Object.entries(fields).map(([key, label]) => {
      let value = record[key];
      if (key.endsWith("Date")) value = date(value);
      if (key === "pipelineStage") value = state.stages.find((stage) => stage.code === value)?.label || value;
      return `<div><dt>${html(label)}</dt><dd>${html(value || "—")}</dd></div>`;
    }).join("");
    return `<dl class="crm-details">${rows}</dl>`;
  };
  const overviewMarkup = () => {
    const company = state.overview.company;
    const fields = {
      code: "Код",
      pipelineStage: "Этап",
      city: "Город",
      industry: "Отрасль",
      phone: "Телефон",
      email: "Email",
      websiteUrl: "Сайт",
      preferredChannel: "Канал",
      timezone: "Часовой пояс",
      startDate: "Дата начала",
      endDate: "Дата окончания",
      notes: "Заметки"
    };
    const legal = (state.overview.legalEntities || []).map((entity) => {
      return `<li>${html(entity.name || entity.shortName)}${entity.inn ? ` · ИНН ${html(entity.inn)}` : ""}</li>`;
    }).join("");
    return `${details(company, fields)}
      <button class="plain-button" type="button" data-open-company>Открыть в базе клиентов</button>
      <h3>Юридические лица</h3>${legal ? `<ul>${legal}</ul>` : empty()}`;
  };
  const contactsMarkup = () => {
    const rows = (state.overview.contacts || []).map((contact) => {
      const fields = { position: "Должность", phone: "Телефон", preferredChannel: "Канал" };
      return `<section class="card deals-detail-card"><h3>${html(contact.name)}</h3>
        ${details(contact, fields)}</section>`;
    }).join("");
    return rows || empty();
  };
  const tasksMarkup = () => {
    const rows = (state.overview.tasks || []).map((task) => {
      return `<li><a href="#tasks/${encodeURIComponent(task.id)}">${html(task.title)}</a>
        <p class="muted">${html(taskStatuses[task.status] || task.status)}
        · Срок: ${html(date(task.dueDate))}</p></li>`;
    }).join("");
    return rows ? `<ul class="deals-detail-list">${rows}</ul>` : empty();
  };
  const leadsMarkup = () => {
    const leads = state.overview.leads || { total: 0, last: [] };
    const rows = (leads.last || []).map((lead) => {
      return `<li><strong>${html(lead.name || `#${lead.id}`)}</strong>
        <p class="muted">${html(date(lead.createdAt))} · ${html(lead.stage || "—")}
        · ${html(lead.source || "Источник не указан")}</p></li>`;
    }).join("");
    return `<p>Всего лидов: ${html(leads.total)}</p>${rows ? `<ul class="deals-detail-list">${rows}</ul>` : empty()}`;
  };
  const renderDrawerTab = () => {
    byId("deals-drawer-tabs").querySelectorAll("[data-deals-tab]").forEach((button) => {
      const selected = button.dataset.dealsTab === state.tab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    const panel = byId("deals-drawer-content");
    panel.setAttribute("aria-labelledby", `deals-tab-${state.tab}`);
    if (!state.overview) return;
    const renderers = { overview: overviewMarkup, contacts: contactsMarkup, tasks: tasksMarkup, leads: leadsMarkup };
    if (renderers[state.tab]) panel.innerHTML = renderers[state.tab]();
    else if (state.tab === "chat") panel.innerHTML = '<p class="muted">в разработке</p>';
    else panel.innerHTML = '<p class="muted">в разработке (описание ожидается от Owner’а)</p>';
  };
  const openDrawer = async (id, opener) => {
    const version = ++state.drawerVersion;
    const company = state.companies.find((item) => String(item.id) === String(id));
    if (!company) return;
    drawerOpener = opener;
    state.overview = null;
    state.tab = "overview";
    byId("deals-drawer-title").textContent = `Компания: ${company.name}`;
    byId("deals-drawer-content").textContent = "Загрузка…";
    byId("deals-drawer-content").setAttribute("aria-busy", "true");
    renderDrawerTab();
    byId("deals-drawer").showModal();
    try {
      const overview = await query(`/companies/${encodeURIComponent(id)}/overview`);
      if (version !== state.drawerVersion || !byId("deals-drawer").open) return;
      state.overview = overview;
      byId("deals-drawer-title").textContent = `Компания: ${overview.company.name}`;
      renderDrawerTab();
    } catch (error) {
      if (version !== state.drawerVersion) return;
      byId("deals-drawer-content").innerHTML = `<p class="crm-error" role="alert">${html(error.message)}</p>`;
    } finally {
      if (version === state.drawerVersion) byId("deals-drawer-content").setAttribute("aria-busy", "false");
    }
  };
  const openCompanyInClients = () => {
    const code = state.overview.company.code;
    const content = byId("crm-companies-content");
    let timeout;
    const cleanup = () => {
      observer.disconnect();
      clearTimeout(timeout);
      window.removeEventListener("hashchange", routeChanged);
    };
    const applyFilter = () => {
      if (ctx.currentView !== "crm-companies") return;
      const input = content.querySelector("[data-entity-search]");
      if (!input) return;
      const stage = content.querySelector("[data-stage-filter]");
      if (stage?.value) {
        stage.value = "";
        stage.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
      const deleted = content.querySelector("[data-deleted-filter]");
      if (deleted?.checked) {
        deleted.checked = false;
        deleted.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
      cleanup();
      input.value = code;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const routeChanged = () => {
      if (location.hash !== "#crm-companies") cleanup();
    };
    const observer = new MutationObserver(applyFilter);
    observer.observe(content, { childList: true, subtree: true });
    window.addEventListener("hashchange", routeChanged);
    timeout = setTimeout(cleanup, 10000);
    byId("deals-drawer").close();
    ctx.navigate("crm-companies");
    applyFilter();
  };
  const bindDrawer = () => {
    const tablist = byId("deals-drawer-tabs");
    tablist.innerHTML = Object.entries(tabs).map(([key, label]) => {
      return `<button class="plain-button" type="button" role="tab" id="deals-tab-${key}"
        data-deals-tab="${key}" aria-controls="deals-drawer-content" aria-selected="false">${label}</button>`;
    }).join("");
    tablist.addEventListener("click", (event) => {
      const button = event.target.closest("[data-deals-tab]");
      if (!button) return;
      state.tab = button.dataset.dealsTab;
      renderDrawerTab();
    });
    tablist.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const keys = Object.keys(tabs);
      const offset = event.key === "ArrowLeft" ? -1 : 1;
      let index = (keys.indexOf(state.tab) + offset + keys.length) % keys.length;
      if (event.key === "Home") index = 0;
      if (event.key === "End") index = keys.length - 1;
      state.tab = keys[index];
      renderDrawerTab();
      byId(`deals-tab-${state.tab}`).focus();
    });
    byId("deals-drawer-content").addEventListener("click", (event) => {
      if (event.target.closest("[data-open-company]")) openCompanyInClients();
    });
    byId("deals-drawer").addEventListener("close", () => {
      state.drawerVersion += 1;
      if (ctx.currentView === "deals" && drawerOpener?.isConnected) drawerOpener.focus();
    });
  };
  const init = (context) => {
    ctx = context;
    if (initialized) return;
    initialized = true;
    bindBoard();
    bindSettings();
    bindDrawer();
    byId("deals-refresh").addEventListener("click", () => {
      loadBoard();
    });
    for (const id of ["deals-settings", "deals-drawer"]) {
      const dialog = byId(id);
      dialog.querySelectorAll("[data-deals-close]").forEach((button) => {
        button.addEventListener("click", () => dialog.close());
      });
      dialog.addEventListener("click", (event) => {
        const rect = dialog.getBoundingClientRect();
        const outside = event.clientX < rect.left || event.clientX > rect.right
          || event.clientY < rect.top || event.clientY > rect.bottom;
        if (event.target === dialog && outside && !state.saving) dialog.close();
      });
      dialog.addEventListener("cancel", (event) => {
        if (state.saving) event.preventDefault();
      });
    }
    window.addEventListener("hashchange", () => {
      if (location.hash.split(/[/?]/)[0] === "#deals") return;
      byId("deals-settings").close();
      byId("deals-drawer").close();
    });
    window.matchMedia("(max-width: 760px)").addEventListener("change", () => {
      if (state.stages.length) renderBoard();
    });
  };

  cabinet.registerView("deals", {
    title: "Сделки",
    render(container, context) {
      init(context);
      if (ctx.hasPermission("crm.view")) loadBoard();
    }
  });
})();

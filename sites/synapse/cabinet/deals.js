(() => {
  "use strict";

  const cabinet = window.SbCabinet = window.SbCabinet || {};
  const pipelineStages = cabinet.pipelineStages ||= {
    stages: null,
    pending: null,
    version: 0,
    replace(stages) {
      this.stages = stages;
      this.version += 1;
      return stages;
    },
    load(crmQuery, refresh = false) {
      if (this.stages && !refresh) return Promise.resolve(this.stages);
      if (this.pending) return this.pending;
      const version = this.version;
      const request = crmQuery("/pipeline-stages").then(({ stages }) => {
        if (version === this.version) this.replace(stages);
        return this.stages;
      }).finally(() => {
        if (this.pending === request) this.pending = null;
      });
      this.pending = request;
      return request;
    }
  };
  const tabs = {
    overview: "Обзор", service: "Сервис", contacts: "Контакты", tasks: "Задачи", leads: "Лиды",
    chat: "Чат", technology: "Дерево технологии"
  };
  const kinds = { open: "открытый", won: "выигрыш", lost: "отказ" };
  const companyForms = { one: "компания", few: "компании", many: "компаний", other: "компании" };
  const companyPlural = new Intl.PluralRules("ru");
  const companyCount = (count) => `${count} ${companyForms[companyPlural.select(count)]}`;
  const taskStatuses = { inbox: "Входящие", planned: "Запланирована", in_progress: "В работе" };
  const ruleDefaults = { silentDays: 14, renewalDays: 10, rejectedReturnMonths: 3, churnedReturnMonths: 6 };
  const state = {
    pipeline: "sale", pipelines: [], stages: [], stageLists: {}, companies: [], byCompany: {},
    summaryLoaded: false, total: 0, pending: new Set(), loading: false, saving: false,
    refreshRequested: false, draft: [], drafts: {}, settingsPipeline: "sale", settingsVersion: 0,
    overview: null, tab: "overview", loadVersion: 0, drawerVersion: 0, reasonMove: null
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
  const money = (value) => value === null || value === undefined || value === ""
    ? "—" : `${new Intl.NumberFormat("ru-RU").format(Number(value))} ₽/мес`;
  const companyStage = (company, pipeline = state.pipeline, stages = state.stages) => {
    return company.pipelines?.[pipeline]?.stage || (pipeline === "sale"
      ? company.pipelineStage || stages[0]?.code : null);
  };
  const stageCount = (code) => state.companies.filter((company) => {
    return companyStage(company, state.settingsPipeline, state.draft) === code;
  }).length;
  const empty = () => '<p class="muted">пока пусто</p>';
  const status = (message = "") => {
    byId("deals-error").textContent = message;
    byId("deals-error").hidden = !message;
  };
  const busy = () => state.loading || state.saving || state.pending.size > 0;
  const configureButton = () => {
    byId("deals-configure").disabled = !canEdit() || !state.stages.length || busy();
    byId("deals-configure").title = canEdit() ? "" : "нет прав";
    const refreshButton = byId("deals-refresh");
    refreshButton.disabled = busy();
    refreshButton.textContent = state.loading ? "Обновляю…" : "Обновить";
    byId("deals-pipelines").querySelectorAll("button").forEach((button) => { button.disabled = busy(); });
    byId("deals-enroll").disabled = !canEdit() || busy() || !byId("deals-enroll-company").value;
  };
  const loadStages = async (pipeline) => {
    const stages = pipeline === "sale" ? await pipelineStages.load(query, true)
      : (await query("/pipeline-stages", { pipeline })).stages;
    state.stageLists[pipeline] = stages || [];
    return stages || [];
  };
  const renderPipelines = () => {
    byId("deals-pipelines").innerHTML = state.pipelines.map((pipeline) => {
      return `<button class="plain-button" type="button" role="tab" data-pipeline-code="${html(pipeline.code)}"
        aria-selected="${pipeline.code === state.pipeline}" aria-controls="deals-board">
        ${html(pipeline.label)}</button>`;
    }).join("");
    const candidates = state.companies.filter((company) => !company.pipelines?.[state.pipeline]?.stage);
    byId("deals-enroll-fields").hidden = state.pipeline === "sale" || !canEdit();
    const options = candidates.map((company) => {
      return `<option value="${html(company.id)}">${html(company.name)}</option>`;
    }).join("");
    byId("deals-enroll-company").innerHTML = '<option value="">Выберите компанию</option>' + options;
    byId("deals-enroll-company").disabled = !candidates.length || busy();
    configureButton();
  };
  const companyCard = (company) => {
    const pending = state.pending.has(String(company.id));
    const editable = canEdit() && !pending && !state.saving;
    const draggable = editable && !window.matchMedia("(max-width: 760px)").matches;
    const current = companyStage(company);
    const options = state.stages.map((stage) => {
      return `<option value="${html(stage.code)}"${stage.code === current ? " selected" : ""}>
        ${html(stage.label)}</option>`;
    }).join("");
    const tasks = state.summaryLoaded ? state.byCompany[String(company.code).toLowerCase()]?.open || 0 : "—";
    const service = company.service || {};
    const attention = state.pipeline === "service" && ["risk", "renewal"].includes(current)
      || state.stages.find((stage) => stage.code === current)?.attention;
    const hasServiceInfo = [service.paidUntil, service.monthlyAmount, service.lastTouchAt, service.nextTouchAt,
      service.clientOwnerContactId, service.clientOwnerContact?.name]
      .some((value) => value !== null && value !== undefined && value !== "");
    const serviceInfo = state.pipeline === "service"
      ? hasServiceInfo ? `
        <span class="deals-company-meta">Оплачено до: ${html(date(service.paidUntil))}</span>
        <span class="deals-company-meta">${html(money(service.monthlyAmount))}</span>
        <span class="deals-company-meta">Последнее касание: ${html(date(service.lastTouchAt))}</span>
        <span class="deals-company-meta">Следующее касание: ${html(date(service.nextTouchAt))}</span>
        <span class="deals-company-meta">Ответственный: ${html(service.clientOwnerContact?.name || "—")}</span>`
        : '<span class="deals-company-meta">Сервисные поля не заполнены</span>'
      : `<span class="deals-company-meta">Начало: ${html(date(company.startDate))}</span>`;
    return `<article class="deals-company" data-company-id="${html(company.id)}"
      draggable="${draggable}" aria-busy="${pending}">
      <button class="deals-company-open" type="button" data-company-open${pending ? " disabled" : ""}
        aria-label="Компания: ${html(company.name)}">
        <strong>${html(company.name)}</strong><span class="deals-company-code">${html(company.code)}</span>
        ${attention ? '<span class="deals-attention">требует внимания</span>' : ""}
        <span>${html(company.city || "Город не указан")}</span>
        <span>${html(company.industry || "Отрасль не указана")}</span>
        <span class="deals-company-meta">Открытых задач: ${html(tasks)}</span>${serviceInfo}
      </button>
      <label class="deals-stage-select">Этап<select data-deals-stage
        aria-label="Этап компании ${html(company.name)}"${editable ? "" : " disabled"}
        ${canEdit() ? "" : 'title="нет прав"'}>${options}</select></label>
    </article>`;
  };
  const renderBoard = () => {
    let visible = 0;
    byId("deals-board").innerHTML = state.stages.map((stage) => {
      const companies = state.companies.filter((company) => companyStage(company) === stage.code);
      visible += companies.length;
      const cards = companies.map(companyCard).join("");
      return `<section class="card deals-column" data-stage-code="${html(stage.code)}"
        data-stage-kind="${html(stage.kind)}" aria-label="${html(stage.label)}">
        <header class="deals-column-heading"><h2>${html(stage.label)}</h2>
        <span class="deals-count" aria-label="${companyCount(companies.length)}">${companies.length}</span></header>
        <div class="deals-column-cards">${cards || '<p class="muted deals-empty">пока пусто</p>'}</div>
      </section>`;
    }).join("");
    byId("deals-count").textContent = state.total > state.companies.length
      ? `На доске: ${companyCount(visible)}. Загружено ${companyCount(state.companies.length)} из ${state.total}.`
      : companyCount(visible);
    renderPipelines();
  };
  const loadBoard = async (preserveError = false) => {
    if (state.pending.size || state.saving) { state.refreshRequested = true; return; }
    if (state.loading) return;
    state.refreshRequested = false;
    const version = ++state.loadVersion;
    const selectedCompanyId = state.overview?.company.id;
    state.loading = true;
    configureButton();
    if (!preserveError) status();
    byId("deals-board").setAttribute("aria-busy", "true");
    byId("deals-count").textContent = "Загрузка…";
    try {
      state.pipelines = (await query("/pipelines")).pipelines || [];
      if (!state.pipelines.some((pipeline) => pipeline.code === state.pipeline)) {
        state.pipeline = state.pipelines[0]?.code || "sale";
      }
      state.stages = await loadStages(state.pipeline);
      const [companies, summary] = await Promise.allSettled([
        query("/companies", { limit: 200, deleted: "exclude" }), query("/tasks/summary")
      ]);
      if (version !== state.loadVersion) return;
      if (companies.status === "rejected") throw companies.reason;
      state.companies = companies.value.companies || [];
      const selectedCompany = state.companies.find((company) => {
        return String(company.id) === String(selectedCompanyId);
      });
      if (selectedCompany && state.overview) state.overview.company = selectedCompany;
      state.total = companies.value.pagination?.total ?? state.companies.length;
      state.summaryLoaded = summary.status === "fulfilled";
      state.byCompany = Object.fromEntries(Object.entries(summary.value?.byCompany || {}).map(([code, value]) => {
        return [code.toLowerCase(), value];
      }));
      if (!state.stages.length) throw new Error("Воронка не содержит этапов");
      renderBoard();
      if (selectedCompany && byId("deals-drawer").open) renderDrawerTab();
      if (!state.summaryLoaded) status(`Счётчики задач недоступны: ${summary.reason.message}`);
    } catch (error) {
      if (version !== state.loadVersion) return;
      status(error.message);
      byId("deals-count").textContent = "Не удалось загрузить воронку";
    } finally {
      if (version === state.loadVersion) {
        state.loading = false;
        byId("deals-board").setAttribute("aria-busy", "false");
        renderPipelines();
      }
    }
  };
  const finishMutation = () => {
    configureButton();
    if (state.refreshRequested && !state.pending.size && !state.saving && ctx.currentView === "deals") {
      loadBoard(true);
    }
  };
  const replaceCompany = (company) => {
    const index = state.companies.findIndex((item) => String(item.id) === String(company.id));
    if (index !== -1) state.companies[index] = company;
    if (String(state.overview?.company.id) === String(company.id)) state.overview.company = company;
  };
  const moveCompany = async (id, stageCode, reason) => {
    const company = state.companies.find((item) => String(item.id) === String(id));
    if (!canEdit() || !company || busy() || !state.stages.some((stage) => stage.code === stageCode)) return;
    if (companyStage(company) === stageCode) return;
    const pipeline = state.pipeline;
    const previous = structuredClone(company);
    state.pending.add(String(id));
    company.pipelines ||= {};
    company.pipelines[pipeline] = { stage: stageCode, enteredAt: new Date().toISOString() };
    if (pipeline === "sale") company.pipelineStage = stageCode;
    status();
    renderBoard();
    try {
      const body = { pipeline, stageCode, ...(reason ? { reason } : {}) };
      const saved = await query(`/companies/${encodeURIComponent(id)}/pipeline`, {}, ctx.csrfOptions("PATCH", body));
      replaceCompany(saved.company);
    } catch (error) {
      replaceCompany(previous);
      status(error.message);
    } finally {
      state.pending.delete(String(id));
      renderBoard();
      finishMutation();
    }
  };
  const requestMove = (id, stageCode) => {
    const company = state.companies.find((item) => String(item.id) === String(id));
    if (!company || !canEdit() || busy()) { renderBoard(); return; }
    if (["rejected", "churned"].includes(stageCode) && companyStage(company) !== stageCode) {
      renderBoard();
      state.reasonMove = { id, stageCode };
      byId("deals-reason-text").value = "";
      byId("deals-reason").showModal();
      byId("deals-reason-text").focus();
      return;
    }
    moveCompany(id, stageCode);
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
      requestMove(event.target.closest("[data-company-id]").dataset.companyId, event.target.value);
    });
    board.addEventListener("dragstart", (event) => {
      const card = event.target.closest("[data-company-id]");
      if (!card || card.draggable !== true || !canEdit() || busy()) { event.preventDefault(); return; }
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
      requestMove(id, column.dataset.stageCode);
    });
    board.addEventListener("dragend", clearDrag);
    byId("deals-pipelines").addEventListener("click", (event) => {
      const button = event.target.closest("[data-pipeline-code]");
      if (!button || busy() || button.dataset.pipelineCode === state.pipeline) return;
      state.pipeline = button.dataset.pipelineCode;
      byId("deals-board").innerHTML = "";
      loadBoard();
    });
    byId("deals-enroll-company").addEventListener("change", configureButton);
    byId("deals-enroll").addEventListener("click", () => {
      const id = byId("deals-enroll-company").value;
      if (id && state.stages[0]) requestMove(id, state.stages[0].code);
    });
    byId("deals-reason-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const reason = byId("deals-reason-text").value.trim();
      if (!reason || !state.reasonMove) return;
      const { id, stageCode } = state.reasonMove;
      byId("deals-reason").close();
      moveCompany(id, stageCode, reason);
    });
    byId("deals-reason").addEventListener("close", () => { state.reasonMove = null; renderBoard(); });
  };
  const stageRow = (stage, index) => {
    const count = stage.code ? stageCount(stage.code) : 0;
    const system = state.stageLists[state.settingsPipeline]?.find((item) => item.code === stage.code)?.system;
    const options = Object.entries(kinds).map(([kind, label]) => {
      return `<option value="${kind}"${kind === stage.kind ? " selected" : ""}>${label}</option>`;
    }).join("");
    return `<div class="deals-stage-row" data-stage-index="${index}">
      <label>Название<input data-stage-label required maxlength="40" value="${html(stage.label)}"></label>
      <label>Тип<select data-stage-kind>${options}</select></label>
      <label class="deals-check"><input type="checkbox" data-stage-attention${stage.attention ? " checked" : ""}>
        Требует внимания</label>
      <div class="deals-stage-actions">
        <button class="plain-button" type="button" data-stage-up${index === 0 ? " disabled" : ""}
          aria-label="Поднять этап ${html(stage.label)}">↑</button>
        <button class="plain-button" type="button" data-stage-down
          ${index === state.draft.length - 1 ? "disabled" : ""}
          aria-label="Опустить этап ${html(stage.label)}">↓</button>
        <button class="plain-button" type="button" data-stage-delete
          ${count || system || state.draft.length === 1 ? "disabled" : ""}
          ${system ? 'title="Этап нужен для правил воронки"' : ""}>Удалить</button>
        <span class="muted">${companyCount(count)}</span>
      </div>
    </div>`;
  };
  const readDraft = () => {
    byId("deals-stage-rows").querySelectorAll("[data-stage-index]").forEach((row, index) => {
      state.draft[index].label = row.querySelector("[data-stage-label]").value;
      state.draft[index].kind = row.querySelector("[data-stage-kind]").value;
      state.draft[index].attention = row.querySelector("[data-stage-attention]").checked;
    });
    state.drafts[state.settingsPipeline] = state.draft;
  };
  const renderSettings = () => {
    byId("deals-stage-rows").innerHTML = state.draft.map(stageRow).join("");
    byId("deals-stage-add").disabled = state.draft.length >= 12;
    byId("deals-settings-pipeline").innerHTML = state.pipelines.map((pipeline) => {
      return `<option value="${html(pipeline.code)}"${pipeline.code === state.settingsPipeline ? " selected" : ""}>
        ${html(pipeline.label)}</option>`;
    }).join("");
    const index = state.pipelines.findIndex((pipeline) => pipeline.code === state.settingsPipeline);
    byId("deals-pipeline-label").value = state.pipelines[index]?.label || "";
    byId("deals-pipeline-up").disabled = index <= 0;
    byId("deals-pipeline-down").disabled = index === state.pipelines.length - 1;
  };
  const settingsStages = async (pipeline) => {
    const version = ++state.settingsVersion;
    state.saving = true;
    byId("deals-settings-fields").disabled = true;
    byId("deals-settings-error").textContent = "";
    try {
      const stages = await loadStages(pipeline);
      const companies = await query("/companies", { limit: 200, deleted: "exclude" });
      if (version !== state.settingsVersion) return;
      state.companies = companies.companies || [];
      state.settingsPipeline = pipeline;
      state.draft = state.drafts[pipeline] || stages.map(({ code, label, kind, attention }) => {
        return { code, label, kind, attention: Boolean(attention) };
      });
      if (pipeline === state.pipeline) state.stages = stages;
      renderSettings();
      renderBoard();
    } catch (error) {
      byId("deals-settings-error").textContent = error.message;
      byId("deals-settings-pipeline").value = state.settingsPipeline;
    } finally {
      state.saving = false;
      byId("deals-settings-fields").disabled = false;
      finishMutation();
    }
  };
  const openSettings = async () => {
    if (!canEdit() || busy() || !state.stages.length) return;
    state.settingsPipeline = state.pipeline;
    state.drafts = {};
    state.draft = state.stages.map(({ code, label, kind, attention }) => {
      return { code, label, kind, attention: Boolean(attention) };
    });
    state.rulesLoaded = false;
    byId("deals-settings-error").textContent = "";
    byId("deals-new-pipeline-label").value = "";
    renderSettings();
    byId("deals-settings").showModal();
    state.saving = true;
    byId("deals-settings-fields").disabled = true;
    try {
      const { rules } = await query("/pipeline-rules");
      state.rulesLoaded = true;
      Object.entries({ ...ruleDefaults, ...rules }).forEach(([key, value]) => {
        if (byId("deals-settings-form").elements[key]) byId("deals-settings-form").elements[key].value = value;
      });
    } catch (error) {
      byId("deals-settings-error").textContent = error.message;
    } finally {
      state.saving = false;
      byId("deals-settings-fields").disabled = false;
      finishMutation();
    }
  };
  const savePipelines = async (action) => {
    if (!canEdit() || state.saving) return;
    readDraft();
    const pipelines = state.pipelines.map(({ code, label }) => ({ code, label }));
    const index = pipelines.findIndex((pipeline) => pipeline.code === state.settingsPipeline);
    if (action === "add") {
      const label = byId("deals-new-pipeline-label").value.trim();
      if (!label) { byId("deals-settings-error").textContent = "Введите название новой воронки"; return; }
      pipelines.push({ label });
    } else if (action === "rename") {
      const label = byId("deals-pipeline-label").value.trim();
      if (!label) { byId("deals-settings-error").textContent = "Введите название воронки"; return; }
      pipelines[index].label = label;
    } else {
      const other = index + (action === "up" ? -1 : 1);
      if (other < 0 || other >= pipelines.length) return;
      [pipelines[index], pipelines[other]] = [pipelines[other], pipelines[index]];
    }
    state.saving = true;
    byId("deals-settings-fields").disabled = true;
    byId("deals-settings-error").textContent = "";
    try {
      const saved = await query("/pipelines", {}, ctx.csrfOptions("PUT", { pipelines }));
      state.pipelines = saved.pipelines;
      renderPipelines();
      renderSettings();
      byId("deals-new-pipeline-label").value = "";
    } catch (error) {
      byId("deals-settings-error").textContent = error.message;
    } finally {
      state.saving = false;
      byId("deals-settings-fields").disabled = false;
      finishMutation();
    }
  };
  const saveSettings = async (event) => {
    event.preventDefault();
    if (!canEdit() || state.saving) return;
    readDraft();
    const error = byId("deals-settings-error");
    if (!state.rulesLoaded) { error.textContent = "Откройте настройки повторно, чтобы загрузить правила"; return; }
    const drafts = Object.entries(state.drafts).map(([pipeline, stages]) => {
      return [pipeline, stages.map((stage) => ({ ...stage, label: stage.label.trim() }))];
    });
    if (drafts.some(([, stages]) => stages.some((stage) => !stage.label || [...stage.label].length > 40))) {
      error.textContent = "Название этапа должно содержать от 1 до 40 символов";
      return;
    }
    const rules = Object.fromEntries(Object.keys(ruleDefaults).map((key) => {
      return [key, Number(byId("deals-settings-form").elements[key].value)];
    }));
    error.textContent = "";
    state.saving = true;
    byId("deals-settings-fields").disabled = true;
    try {
      for (const [pipeline, stages] of drafts) {
        const saved = await query("/pipeline-stages", { pipeline }, ctx.csrfOptions("PUT", { stages }));
        state.stageLists[pipeline] = saved.stages;
        if (pipeline === "sale") pipelineStages.replace(saved.stages);
        if (pipeline === state.pipeline) state.stages = saved.stages;
        state.drafts[pipeline] = saved.stages.map(({ code, label, kind, attention }) => {
          return { code, label, kind, attention: Boolean(attention) };
        });
        if (pipeline === state.settingsPipeline) state.draft = state.drafts[pipeline];
      }
      state.draft = state.drafts[state.settingsPipeline];
      await query("/pipeline-rules", {}, ctx.csrfOptions("PUT", { rules }));
      renderBoard();
      byId("deals-settings").close();
      state.refreshRequested = true;
    } catch (failure) {
      error.textContent = failure.message;
      renderSettings();
      renderBoard();
    } finally {
      state.saving = false;
      byId("deals-settings-fields").disabled = false;
      finishMutation();
    }
  };
  const bindSettings = () => {
    byId("deals-configure").addEventListener("click", openSettings);
    byId("deals-settings-form").addEventListener("submit", saveSettings);
    byId("deals-settings-pipeline").addEventListener("change", (event) => {
      readDraft();
      settingsStages(event.target.value);
    });
    for (const action of ["add", "rename", "up", "down"]) {
      byId(`deals-pipeline-${action}`).addEventListener("click", () => savePipelines(action));
    }
    byId("deals-stage-add").addEventListener("click", () => {
      if (state.draft.length >= 12 || state.saving) return;
      readDraft();
      state.draft.push({ label: "", kind: "open", attention: false });
      renderSettings();
      byId("deals-stage-rows").lastElementChild.querySelector("input").focus();
    });
    byId("deals-stage-rows").addEventListener("click", (event) => {
      const row = event.target.closest("[data-stage-index]");
      const button = event.target.closest("button");
      if (!row || !button || button.disabled || state.saving) return;
      readDraft();
      const index = Number(row.dataset.stageIndex);
      if (button.hasAttribute("data-stage-delete")) state.draft.splice(index, 1);
      else {
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
    const company = { ...state.overview.company, pipelineStage: companyStage(state.overview.company) };
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
  const localDateTime = (value) => {
    if (!value) return "";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "";
    const pad = (number) => String(number).padStart(2, "0");
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`
      + `T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
  };
  const historyMarkup = () => {
    const history = state.overview.stageHistory || [];
    const rows = history.map((entry) => {
      const pipeline = state.pipelines.find((item) => item.code === entry.pipelineCode);
      const stages = state.stageLists[entry.pipelineCode] || [];
      const label = (code) => stages.find((stage) => stage.code === code)?.label || code || "—";
      const actor = typeof entry.by === "object" ? entry.by?.name || entry.by?.login
        : ({ auto: "Автоматически", user: "Пользователь" }[entry.by] || entry.by);
      const at = entry.at ? new Date(entry.at).toLocaleString("ru-RU") : "—";
      return `<li><strong>${html(pipeline?.label || entry.pipelineCode || "Этап")}</strong>
        <p>${html(label(entry.fromCode))} → ${html(label(entry.toCode))}</p>
        <p class="muted">${html(at)}${actor ? ` · ${html(actor)}` : ""}</p>
        ${entry.reason ? `<p>Причина: ${html(entry.reason)}</p>` : ""}</li>`;
    }).join("");
    return `<h3>История переходов</h3>${rows ? `<ul class="deals-detail-list">${rows}</ul>` : empty()}`;
  };
  const serviceMarkup = () => {
    const service = state.overview.company.service || {};
    const contacts = [...(state.overview.contacts || [])];
    if (service.clientOwnerContact && !contacts.some((contact) => contact.id === service.clientOwnerContact.id)) {
      contacts.push(service.clientOwnerContact);
    }
    if (service.clientOwnerContactId && !contacts.some((contact) => contact.id === service.clientOwnerContactId)) {
      contacts.push({ id: service.clientOwnerContactId,
        name: `Контакт #${service.clientOwnerContactId} (недоступен)` });
    }
    const ownerOptions = contacts.map((contact) => {
      return `<option value="${html(contact.id)}"
        ${String(contact.id) === String(service.clientOwnerContactId) ? "selected" : ""}>
        ${html(contact.name)}</option>`;
    }).join("");
    const noValues = ["paidUntil", "monthlyAmount", "lastTouchAt", "nextTouchAt", "clientOwnerContactId"]
      .every((key) => service[key] === null || service[key] === undefined || service[key] === "");
    return `${noValues ? empty() : ""}<form class="crm-form deals-service-form" data-service-form>
      <fieldset class="deals-service-fields"${canEdit() ? "" : ' disabled title="нет прав"'}>
        <label>Оплачено до<input type="date" name="paidUntil" value="${html(service.paidUntil?.slice(0, 10) || "")}">
        </label><label>Ежемесячная оплата, ₽<input type="number" min="0" step="0.01" name="monthlyAmount"
          value="${html(service.monthlyAmount ?? "")}"></label>
        <label>Последнее касание<input type="datetime-local" name="lastTouchAt"
          value="${html(localDateTime(service.lastTouchAt))}"></label>
        <label>Следующее касание<input type="datetime-local" name="nextTouchAt"
          value="${html(localDateTime(service.nextTouchAt))}"></label>
        <label class="wide">Ответственный контакт<select name="clientOwnerContactId"><option value="">Не выбран</option>
          ${ownerOptions}</select></label>
        ${canEdit() ? '<button class="plain-button" type="submit">Сохранить сервис</button>' : ""}
      </fieldset><p class="crm-error wide" role="alert" data-service-error></p>
      <p class="muted wide" role="status" data-service-status></p></form>${historyMarkup()}`;
  };
  const saveService = async (event) => {
    if (!event.target.matches("[data-service-form]")) return;
    event.preventDefault();
    if (!canEdit() || !state.overview || state.saving || state.pending.size) return;
    const form = event.target;
    const company = state.overview.company;
    const previous = company.service || {};
    const body = {};
    for (const key of ["paidUntil", "monthlyAmount", "lastTouchAt", "nextTouchAt", "clientOwnerContactId"]) {
      const input = form.elements[key].value;
      const current = key === "paidUntil" ? previous[key]?.slice(0, 10) || ""
        : key.endsWith("TouchAt") ? localDateTime(previous[key]) : String(previous[key] ?? "");
      if (input === current) continue;
      body[key] = !input ? null : ["monthlyAmount", "clientOwnerContactId"].includes(key) ? Number(input)
        : key.endsWith("TouchAt") ? new Date(input).toISOString() : input;
    }
    if (!Object.keys(body).length) { form.querySelector("[data-service-status]").textContent = "Сохранено"; return; }
    state.pending.add(String(company.id));
    form.querySelector("fieldset").disabled = true;
    form.querySelector("[data-service-error]").textContent = "";
    configureButton();
    try {
      const saved = await query(`/companies/${encodeURIComponent(company.id)}/service`, {},
        ctx.csrfOptions("PATCH", body));
      replaceCompany(saved.company);
      if (form.isConnected) form.querySelector("[data-service-status]").textContent = "Сохранено";
      renderBoard();
    } catch (error) {
      if (form.isConnected) form.querySelector("[data-service-error]").textContent = error.message;
    } finally {
      state.pending.delete(String(company.id));
      if (form.isConnected) form.querySelector("fieldset").disabled = false;
      renderBoard();
      finishMutation();
    }
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
    const renderers = { overview: overviewMarkup, service: serviceMarkup, contacts: contactsMarkup,
      tasks: tasksMarkup, leads: leadsMarkup };
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
    byId("deals-drawer-content").addEventListener("submit", saveService);
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
    for (const id of ["deals-settings", "deals-drawer", "deals-reason"]) {
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
      byId("deals-reason").close();
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

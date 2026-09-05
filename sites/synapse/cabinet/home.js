(() => {
"use strict";

const SbCabinet = window.SbCabinet = window.SbCabinet || {};
let ctx;
let identity, byId, escapeHTML, crmQuery, scopeParams, periodDates, navigate;
let formatMoney;
let initialized = false;
const api = {};

const WIDGETS = Object.freeze([
  {
    id: "leads",
    label: "Заявки за период",
    help: "Сколько обращений пришло с сайта, чата и Telegram за период " +
      "по выбранному проекту"
  },
  {
    id: "tasks",
    label: "Задачи в работе",
    help: "Задачи по проекту: входящие ждут разбора, " +
      "в работе — уже делаются"
  },
  {
    id: "revenue",
    label: "Выручка",
    help: "Выручка по сделкам в CRM со статусом «продажа» " +
      "за выбранный период"
  },
  {
    id: "romi",
    label: "ROMI",
    help: "Расходы учитываются только на уровне Synapse Business; " +
      "для проекта добавьте расходы в аналитике"
  },
  {
    id: "dialogs",
    label: "Последние диалоги",
    help: "Появится после подключения чата к CRM"
  }
]);
const PERIODS = Object.freeze([
  ["today", "Сегодня"],
  ["7d", "7 дней"],
  ["30d", "30 дней"]
]);
let settings = {};
let requestKey = "";
let requestPromise = null;
const payloadCache = new Map();

const storageKey = () => `synapse_cabinet_home_widgets:${identity.userId}`;
const readSettings = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey()));
    return saved && typeof saved === "object" ? saved : {};
  } catch (error) {
    return {};
  }
};
const saveSettings = () => {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(settings));
  } catch (error) {
    // Settings remain available for this browser session.
  }
};
const enabled = (id) => settings[id] !== false;
const hasCRMAccess = () => ctx.hasPermission("crm.view");
const hasDataAccess = () => hasCRMAccess() || identity.permissions.includes("analytics.view");
const canLoad = (id) => {
  if (id === "leads") return hasCRMAccess();
  if (["tasks", "revenue", "romi"].includes(id)) return hasDataAccess();
  return true;
};
const safeMoney = (value) => {
  if (value === null || value === undefined) return "нет данных";
  if (typeof formatMoney === "function") return formatMoney(value);
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0
  }).format(Number(value));
};
const metric = (value) => value === null || value === undefined
  ? "нет данных"
  : new Intl.NumberFormat("ru-RU").format(Number(value));
const dateLabel = (value) => {
  if (!value) return "нет данных";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return String(value);
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short" }).format(date);
};
const errorMessage = (error) => error?.message
  ? `Не удалось загрузить данные: ${error.message}`
  : "Не удалось загрузить данные";
const setWidgetContent = (id, markup) => {
  const content = byId(`home-widget-${id}`);
  if (content) content.innerHTML = markup;
};
const dashboardResult = (result) => {
  const dashboard = result.value || {};
  return { ...dashboard, ...(dashboard.summary || {}) };
};
const renderDashboardWidget = (id, result) => {
  if (result.status === "rejected") {
    setWidgetContent(id, `<p class="home-error" role="alert">${escapeHTML(errorMessage(result.reason))}</p>`);
    return;
  }
  const values = dashboardResult(result);
  if (id === "leads") {
    setWidgetContent(id, `<strong class="home-metric">${escapeHTML(metric(values.total))}</strong>`);
  }
  if (id === "revenue") {
    setWidgetContent(id, `<strong class="home-metric">${escapeHTML(safeMoney(values.revenue))}</strong>
      <p class="home-note">по сделкам в CRM со статусом «продажа»</p>`);
  }
  if (id === "romi") {
    const unavailable = values.expensesScope === "global_unavailable" || values.romi === null ||
      values.romi === undefined;
    const value = unavailable ? "нет данных о расходах" : `${metric(values.romi)}%`;
    setWidgetContent(id, `<strong class="home-metric ${unavailable ? "home-metric-text" : ""}">
      ${escapeHTML(value)}</strong>${unavailable ? `<p class="home-note">${escapeHTML(WIDGETS[3].help)}</p>` : ""}`);
  }
};
const renderLeads = (result) => {
  if (!enabled("leads")) return;
  const list = byId("home-leads-list");
  if (result.status === "rejected") {
    list.innerHTML = `<p class="home-error" role="alert">${escapeHTML(errorMessage(result.reason))}</p>`;
    return;
  }
  const leads = Array.isArray(result.value?.leads) ? result.value.leads.slice(0, 3) : [];
  list.innerHTML = leads.length ? `<ul>${leads.map((lead) => `<li>
    <strong>${escapeHTML(lead.name || "нет данных")}</strong>
    <span>${escapeHTML(lead.source || "нет данных")} ·
    ${escapeHTML(lead.stage || "нет данных")}</span>
    <time>${escapeHTML(dateLabel(lead.date || lead.createdAt))}</time></li>`).join("")}</ul>`
    : '<p class="home-note">нет данных</p>';
};
const renderTasks = (result) => {
  if (!enabled("tasks")) return;
  if (result.status === "rejected") {
    setWidgetContent("tasks", `<p class="home-error" role="alert">${escapeHTML(errorMessage(result.reason))}</p>`);
    return;
  }
  const summary = result.value || {};
  setWidgetContent("tasks", `<div class="home-task-metrics">
    <strong class="home-metric">${escapeHTML(metric(summary.inProgress))}</strong>
    <span><b>${escapeHTML(metric(summary.inbox))}</b> входящих</span>
    <span><b>${escapeHTML(metric(summary.planned))}</b> запланировано</span></div>
    <button class="home-link" type="button" data-home-navigate="tasks">Открыть задачи</button>`);
};
const requestSignature = () => {
  const ids = WIDGETS.filter((widget) => enabled(widget.id)).map((widget) => widget.id).join(",");
  return `${ctx.selectedProjectId}:${settings.period}:${ids}`;
};
const renderResults = (results) => {
  for (const id of ["leads", "revenue", "romi"]) {
    if (enabled(id) && canLoad(id)) renderDashboardWidget(id, results[0]);
  }
  if (canLoad("tasks")) renderTasks(results[1]);
  if (canLoad("leads")) renderLeads(results[2]);
};
const loadWidgets = async () => {
  if (ctx.currentView !== "home") return;
  const key = requestSignature();
  if (payloadCache.has(key)) {
    renderResults(payloadCache.get(key));
    return payloadCache.get(key);
  }
  if (key === requestKey) return requestPromise;
  requestKey = key;
  const dashboardNeeded = ["leads", "revenue", "romi"].some((id) => enabled(id) && canLoad(id));
  const dates = periodDates(settings.period);
  const dashboard = dashboardNeeded
    ? crmQuery("/dashboard", { ...dates, ...scopeParams() })
    : Promise.resolve(null);
  const tasks = enabled("tasks") && canLoad("tasks")
    ? crmQuery("/tasks/summary", { ...scopeParams() })
    : Promise.resolve(null);
  const leads = enabled("leads") && canLoad("leads")
    ? crmQuery("/leads", { ...scopeParams(), limit: 3 })
    : Promise.resolve(null);
  requestPromise = Promise.allSettled([dashboard, tasks, leads]).then((results) => {
    if (key !== requestKey) return;
    payloadCache.set(key, results);
    renderResults(results);
  });
  return requestPromise;
};
const renderPeriods = () => {
  byId("home-periods").querySelectorAll("[data-home-period]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.homePeriod === settings.period));
  });
};
const widgetMarkup = (widget) => {
  if (!enabled(widget.id)) return "";
  const link = widget.id === "leads" && hasCRMAccess()
    ? '<button class="home-link" type="button" data-home-navigate="crm">Все лиды</button>'
    : "";
  let content = '<p class="home-loading">Загрузка…</p>';
  if (!canLoad(widget.id)) content = '<p class="home-note">нет доступа</p>';
  if (widget.id === "dialogs") {
    content = '<span class="development-badge">в разработке</span>' +
      '<p>Появится после подключения чата к CRM</p>';
  }
  return `<article class="card home-widget" data-home-widget="${widget.id}">
    <h2>${escapeHTML(widget.label)}</h2><div id="home-widget-${widget.id}">${content}</div>
    ${widget.id === "leads" ? '<div id="home-leads-list"></div>' : ""}${link}</article>`;
};
const renderWidgets = () => {
  byId("home-widgets").innerHTML = WIDGETS.map(widgetMarkup).join("");
};
const renderSettings = () => {
  byId("home-widget-options").innerHTML = WIDGETS.map((widget) => `<label class="widget-option">
    <input type="checkbox" value="${widget.id}" ${enabled(widget.id) ? "checked" : ""}>
    <span>${escapeHTML(widget.label)}</span>
    <span class="home-help" title="${escapeHTML(widget.help)}" aria-label="${escapeHTML(widget.help)}">?</span>
    </label>`).join("");
};
const bind = () => {
  byId("home-settings-trigger").addEventListener("click", () => {
    const panel = byId("home-widget-settings");
    panel.hidden = !panel.hidden;
    byId("home-settings-trigger").setAttribute("aria-expanded", String(!panel.hidden));
  });
  byId("home-periods").addEventListener("click", (event) => {
    const button = event.target.closest("[data-home-period]");
    if (!button || settings.period === button.dataset.homePeriod) return;
    settings.period = button.dataset.homePeriod;
    saveSettings();
    renderPeriods();
    renderWidgets();
    loadWidgets();
  });
  byId("home-widget-options").addEventListener("change", (event) => {
    if (!event.target.matches('input[type="checkbox"]')) return;
    settings[event.target.value] = event.target.checked;
    saveSettings();
    renderWidgets();
    loadWidgets();
  });
  byId("home-widgets").addEventListener("click", (event) => {
    const button = event.target.closest("[data-home-navigate]");
    if (button) navigate(button.dataset.homeNavigate);
  });
};
const init = (context) => {
  ctx = context;
  ({ identity, byId, escapeHTML, crmQuery, scopeParams, periodDates, navigate } = context);
  formatMoney = context.formatMoney;
  if (initialized) return;
  initialized = true;
  settings = readSettings();
  if (!PERIODS.some(([id]) => id === settings.period)) settings.period = "today";
  bind();
  renderSettings();
};

SbCabinet.registerView("home", {
  title: "Главная",
  render(container, context) {
    init(context);
    renderPeriods();
    renderWidgets();
    api.loadWidgets();
  },
  onProjectChange(context) {
    init(context);
    renderWidgets();
    api.loadWidgets();
  }
});
Object.assign(api, { loadWidgets });
})();

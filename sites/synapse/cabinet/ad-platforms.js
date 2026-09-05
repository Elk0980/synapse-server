(() => {
"use strict";

const SbCabinet = window.SbCabinet = window.SbCabinet || {};
const METRICS = [
  ["pageViews", "Показы"],
  ["siteClicks", "Переходы на сайт"],
  ["calls", "Звонки"],
  ["routes", "Маршруты"],
  ["messengerClicks", "Мессенджер"]
];
let ctx;
let identity, byId, escapeHTML, crmQuery, csrfOptions, scopeParams, periodDates;
let initialized = false;
let dashboardState = null;
let openPlatformId = null;
let existingRequest = 0;
const api = {};

const formatDate = (value, year = true) => {
  if (!value) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    ...(year ? { year: "numeric" } : {})
  }).format(new Date(`${String(value).slice(0, 10)}T00:00:00`));
};
const recentDates = () => Array.from({ length: 7 }, (_, offset) => {
  const date = new Date();
  date.setDate(date.getDate() - offset);
  return date.toISOString().slice(0, 10);
});
const projectLabel = () => byId("project-name")?.textContent || ctx.selectedProjectId || "—";
const isEditable = () => identity.permissions.includes("crm.edit");
const platformFor = (id) => SbCabinet.ANALYTICS_PLATFORMS.find((item) => item.id === id);
const hasNumbers = (value) => value && typeof value === "object" &&
  Object.values(value).some((item) => typeof item === "number" && Number.isFinite(item));
const connectedAt = (platform, stats) => stats.filter((row) => {
  const source = String(row.source || "").toLowerCase();
  return platform.codes.includes(source) && hasNumbers(row.external);
}).map((row) => row.externalCapturedAt).filter(Boolean).sort().at(-1) || null;
const metricInputs = (date) => METRICS.map(([key, label]) => `<td>
  <input type="number" min="0" step="any" name="${key}" aria-label="${label}, ${date}">
  <small class="existing-value" data-existing="${key}"></small>
  </td>`).join("");
const dayRow = (date = new Date().toISOString().slice(0, 10)) => `<tr>
  <td><input type="date" name="date" value="${escapeHTML(date)}" required></td>
  ${metricInputs(date)}
  <td><button class="plain-button remove-day" type="button" aria-label="Удалить день">×</button></td>
  </tr>`;
const manualForm = (platform) => `<form class="manual-stats-form" data-platform="${platform.id}">
  <p class="manual-project"><strong>Проект:</strong> ${escapeHTML(projectLabel())}
  <small>Чтобы изменить, переключите проект слева</small></p>
  <p><strong>Источник:</strong> ${escapeHTML(platform.codes[0])}</p>
  <div class="manual-days-scroll"><table class="manual-days-table">
  <thead><tr><th>Дата</th>${METRICS.map(([, label]) => `<th>${label}</th>`).join("")}<th></th></tr></thead>
  <tbody>${recentDates().map(dayRow).join("")}</tbody></table></div>
  <button class="plain-button add-day" type="button">+ день</button>
  <label class="manual-note">Примечание
  <textarea name="note" placeholder="Например, снимок из кабинета 2ГИС, вручную"></textarea></label>
  <div class="manual-actions"><button class="primary-button" type="submit">Сохранить</button>
  <p class="manual-result" role="status"></p></div>
  </form>`;
const renderAdPlatforms = (dashboard = dashboardState) => {
  const stats = Array.isArray(dashboard?.sourceStats) ? dashboard.sourceStats : [];
  let currentGroup = null;
  const groups = [];
  for (const platform of SbCabinet.ANALYTICS_PLATFORMS) {
    if (platform.group !== currentGroup) {
      currentGroup = platform.group;
      groups.push({ label: currentGroup, platforms: [] });
    }
    groups.at(-1).platforms.push(platform);
  }
  byId("ad-platforms-content").innerHTML = `<div class="platform-status-list">${groups.map((group) => {
    const heading = group.label ? `<h2>${escapeHTML(group.label)}</h2>` : "";
    const rows = group.platforms.map((platform) => {
      const capturedAt = connectedAt(platform, stats);
      const status = capturedAt ? `подключено (снимок от ${formatDate(capturedAt)})` : "не подключено";
      const disabled = isEditable() ? "" : ' disabled title="нет прав"';
      const form = openPlatformId === platform.id ? manualForm(platform) : "";
      return `<div class="platform-status-item"><div class="platform-status-row">
        <span>${escapeHTML(platform.label)}${platform.note ? `<small>${escapeHTML(platform.note)}</small>` : ""}</span>
        <span class="platform-status${capturedAt ? " is-connected" : ""}">${status}</span>
        <button class="plain-button manual-open" type="button" data-platform="${platform.id}"${disabled}>
        Ввести данные вручную</button></div>${form}</div>`;
    }).join("");
    return `<section class="platform-status-group">${heading}${rows}</section>`;
  }).join("")}</div>`;
  if (openPlatformId) loadExisting(byId("ad-platforms-content").querySelector(".manual-stats-form"));
};
const formRange = (form) => {
  const dates = [...form.querySelectorAll('[name="date"]')].map((input) => input.value).filter(Boolean).sort();
  return dates.length ? { from: dates[0], to: dates.at(-1) } : null;
};
const clearExisting = (form) => form.querySelectorAll(".existing-value").forEach((item) => {
  item.textContent = "";
});
const loadExisting = async (form) => {
  const range = formRange(form);
  const platform = platformFor(form.dataset.platform);
  if (!range || !platform || !ctx.selectedProjectId) return;
  const request = ++existingRequest;
  clearExisting(form);
  try {
    const data = await crmQuery("/external-stats", {
      source: platform.codes[0],
      companyCode: ctx.selectedProjectId,
      ...range
    });
    if (request !== existingRequest || !form.isConnected) return;
    const rows = new Map((data.rows || []).map((row) => [row.date, row.metrics || {}]));
    form.querySelectorAll("tbody tr").forEach((row) => {
      const metrics = rows.get(row.querySelector('[name="date"]').value);
      if (!metrics) return;
      METRICS.forEach(([key]) => {
        if (typeof metrics[key] !== "number") return;
        row.querySelector(`[data-existing="${key}"]`).textContent = `${metrics[key]} — будет заменено`;
      });
    });
  } catch (error) {
    form.querySelector(".manual-result").textContent = error.message;
  }
};
const formRows = (form) => [...form.querySelectorAll("tbody tr")].map((row) => {
  const result = { date: row.querySelector('[name="date"]').value };
  METRICS.forEach(([key]) => {
    const value = row.querySelector(`[name="${key}"]`).value;
    if (value !== "") result[key] = Number(value);
  });
  return result;
}).filter((row) => METRICS.some(([key]) => Object.hasOwn(row, key)));
const saveForm = async (form) => {
  const result = form.querySelector(".manual-result");
  const rows = formRows(form);
  result.textContent = "";
  if (!rows.length) {
    result.textContent = "Введите хотя бы одно число.";
    return;
  }
  if (!form.reportValidity()) return;
  const platform = platformFor(form.dataset.platform);
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const saved = await crmQuery("/external-stats", {}, csrfOptions("POST", {
      source: platform.codes[0],
      companyCode: ctx.selectedProjectId,
      rows,
      note: form.elements.note.value
    }));
    const dates = (saved.dates || rows.map((row) => row.date)).slice().sort();
    result.textContent = `Сохранено: ${saved.upserted ?? rows.length} дней, ` +
      `${formatDate(dates[0], false)}–${formatDate(dates.at(-1), false)}`;
    await refreshDashboard(false);
    await loadExisting(form);
  } catch (error) {
    result.textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
const refreshDashboard = async (render = true) => {
  dashboardState = await crmQuery("/dashboard", { ...periodDates("30d"), ...scopeParams() });
  if (render && ctx.currentView === "ad-platforms") renderAdPlatforms();
  if (!render && openPlatformId) {
    const message = byId("ad-platforms-content").querySelector(".manual-result").textContent;
    renderAdPlatforms();
    byId("ad-platforms-content").querySelector(".manual-result").textContent = message;
  }
};
const loadAdPlatforms = async () => {
  if (ctx.currentView !== "ad-platforms" || !identity.permissions.includes("analytics.view")) return;
  dashboardState = null;
  openPlatformId = null;
  renderAdPlatforms();
  try {
    await refreshDashboard();
  } catch (error) {
    // Connection statuses remain conservative when dashboard data is unavailable.
  }
};
const bindEvents = () => {
  const content = byId("ad-platforms-content");
  content.addEventListener("click", (event) => {
    const open = event.target.closest(".manual-open");
    if (open && !open.disabled) {
      openPlatformId = openPlatformId === open.dataset.platform ? null : open.dataset.platform;
      renderAdPlatforms();
      return;
    }
    const form = event.target.closest(".manual-stats-form");
    if (!form) return;
    if (event.target.closest(".add-day")) {
      form.querySelector("tbody").insertAdjacentHTML("beforeend", dayRow());
      loadExisting(form);
    }
    if (event.target.closest(".remove-day")) {
      event.target.closest("tr").remove();
      loadExisting(form);
    }
  });
  content.addEventListener("change", (event) => {
    const form = event.target.closest(".manual-stats-form");
    if (form && event.target.name === "date") loadExisting(form);
  });
  content.addEventListener("submit", (event) => {
    if (!event.target.matches(".manual-stats-form")) return;
    event.preventDefault();
    saveForm(event.target);
  });
};
const init = (context) => {
  ctx = context;
  ({ identity, byId, escapeHTML, crmQuery, csrfOptions, scopeParams, periodDates } = context);
  if (initialized) return;
  initialized = true;
  bindEvents();
};

Object.assign(api, { loadAdPlatforms });
SbCabinet.registerView("ad-platforms", {
  title: "Рекламные площадки",
  render(container, context) {
    init(context);
    api.loadAdPlatforms();
  },
  onProjectChange(context) {
    init(context);
    api.loadAdPlatforms();
  }
});
})();

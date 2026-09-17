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
let dashboardRequest = 0;
let dashboardStatus = "loading";
const api = {};

const formatDate = (value, year = true) => {
  if (!value) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    ...(year ? { year: "numeric" } : {})
  }).format(new Date(`${String(value).slice(0, 10)}T00:00:00`));
};
const dateValue = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
const recentDates = () => Array.from({ length: 7 }, (_, offset) => {
  const date = new Date();
  date.setDate(date.getDate() - offset);
  return dateValue(date);
});
const dayWord = (count) => {
  const lastTwo = count % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return "дней";
  if (count % 10 === 1) return "день";
  if (count % 10 >= 2 && count % 10 <= 4) return "дня";
  return "дней";
};
const projectLabel = () => byId("project-name")?.textContent || ctx.selectedProjectId || "—";
const isEditable = () => identity.permissions.includes("crm.edit");
const isCurrentCompany = (companyCode) => ctx.currentView === "ad-platforms" &&
  ctx.selectedProjectId === companyCode && identity.permissions.includes("analytics.view");
const isCurrentForm = (form) => form?.isConnected && isCurrentCompany(form.dataset.companyCode);
const platformFor = (id) => SbCabinet.ANALYTICS_PLATFORMS.find((item) => item.id === id);
const hasNumbers = (value) => value && typeof value === "object" &&
  Object.values(value).some((item) => typeof item === "number" && Number.isFinite(item));
const snapshotRows = (platform, stats) => stats.filter((row) => {
  const source = String(row.source || "").toLowerCase();
  return platform.codes.includes(source) && hasNumbers(row.external);
});
const metricInputs = (date) => METRICS.map(([key, label]) => `<td>
  <input type="number" min="0" step="any" name="${key}" aria-label="${label}, ${date}">
  <small class="existing-value" data-existing="${key}"></small>
  </td>`).join("");
const dayRow = (date = dateValue(new Date())) => `<tr>
  <td><input type="date" name="date" value="${escapeHTML(date)}" required></td>
  ${metricInputs(date)}
  <td><button class="plain-button remove-day" type="button" aria-label="Удалить день">×</button></td>
  </tr>`;
const manualForm = (platform) => `<form class="manual-stats-form" data-platform="${platform.id}"
  data-company-code="${escapeHTML(ctx.selectedProjectId)}" novalidate>
  <p class="manual-project"><strong>Проект:</strong> ${escapeHTML(projectLabel())}
  <small>Чтобы изменить, переключите проект слева</small></p>
  <p><strong>Источник:</strong> ${escapeHTML(platform.codes[0])}</p>
  <p>Ручной снимок из отчёта площадки. Укажите фактические значения за каждый день;
  неизвестные поля оставьте пустыми. Сохранение не подключает рекламный кабинет.</p>
  <div class="manual-days-scroll"><table class="manual-days-table">
  <thead><tr><th>Дата</th>${METRICS.map(([, label]) => `<th>${label}</th>`).join("")}<th></th></tr></thead>
  <tbody>${recentDates().map(dayRow).join("")}</tbody></table></div>
  <button class="plain-button add-day" type="button">+ день</button>
  <label class="manual-note">Примечание
  <textarea name="note" placeholder="Например, снимок из кабинета 2ГИС, вручную"></textarea></label>
  <div class="manual-actions"><button class="primary-button" type="submit">Сохранить</button>
  <p class="manual-result" role="status"></p></div>
  </form>`;
const companyOverview = () => `<section class="card" aria-label="Путь клиента из рекламы">
  <h2>Реклама компании ${escapeHTML(projectLabel())}</h2>
  <p><strong>Объявление → заявка → запись → визит → абонемент</strong></p>
  <p>Заявки и этапы работы с клиентом смотрите в CRM выбранной компании.
  Запись, визит и покупку абонемента отмечайте по факту; переход по рекламе сам по себе их не подтверждает.</p>
  <p>${identity.permissions.includes("crm.view") ? '<a href="#crm">Открыть заявки и записи</a> · ' : ""}
  <a href="#analytics-through">Открыть сквозную аналитику</a></p>
  <details><summary>Как подготовить рекламу ВКонтакте</summary>
    <ol>
      <li>Проверьте сайт, предложение и контакты именно этой компании.
      Объявления и бюджет настраиваются в <a href="https://ads.vk.com/" target="_blank" rel="noopener noreferrer">VK Рекламе</a>.</li>
      <li>Добавьте к ссылке на сайт метки: <code>utm_source=vk</code>,
      <code>utm_medium=paid_social</code> и <code>utm_campaign</code> с названием кампании.
      Для разных объявлений используйте разные <code>utm_content</code>.
      Метки добавляются после «?» и разделяются «&amp;»; не помещайте в них телефоны и имена клиентов.</li>
      <li>Проверьте путь от рекламной ссылки до формы сайта. После получения реальной заявки
      сверяйте её источник в CRM, затем отмечайте запись и результат визита.</li>
      <li>Пока переносите показатели из отчёта площадки через «Ввести данные вручную».
      Сравнивайте одинаковые даты в отчёте и сквозной аналитике.</li>
    </ol>
    <p><strong>Автоматическая загрузка статистики VK пока не реализована.</strong>
    Для неё нужны доступ к API своего рекламного кабинета и отдельная настройка интеграции в Synapse.
    Подключение сообщества VK для публикаций этого не заменяет. Поля для ключей появятся вместе с работающей интеграцией.</p>
  </details>
  </section>`;
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
  const notice = dashboardStatus === "loading" ? "Загружаем ручные снимки выбранной компании…" :
    dashboardStatus === "error" ? "Не удалось загрузить ручные снимки. Повторите загрузку; это не означает, что данных нет." :
    "Показаны ручные снимки за последние 30 дней. Пустой статус означает отсутствие снимка за этот период, а не нулевой результат рекламы.";
  byId("ad-platforms-content").innerHTML = `<div class="platform-status-list">${companyOverview()}
  <p role="status">${notice}${dashboardStatus === "error" ? ' <button class="plain-button retry-platforms" type="button">Повторить загрузку</button>' : ""}</p>
  ${groups.map((group) => {
    const heading = group.label ? `<h2>${escapeHTML(group.label)}</h2>` : "";
    const rows = group.platforms.map((platform) => {
      const rows = snapshotRows(platform, stats);
      const capturedAt = rows.map((row) => row.externalCapturedAt).filter(Boolean).sort().at(-1);
      const status = rows.length ? `Ручной снимок${capturedAt ? ` от ${formatDate(capturedAt)}` : " · дата не указана"}` :
        dashboardStatus === "loading" ? "Загружаем…" : dashboardStatus === "error" ? "Данные недоступны" : "Нет ручного снимка";
      const disabled = isEditable() ? "" : ' disabled title="нет прав"';
      const form = openPlatformId === platform.id ? manualForm(platform) : "";
      const externalLinks = [SbCabinet.platformLinks?.cabinetLink(platform.id),
        platform.id === "vk" ? SbCabinet.platformLinks?.cabinetLink("vk_ads") : ""].filter(Boolean).join(" · ");
      return `<div class="platform-status-item"><div class="platform-status-row">
        <span>${escapeHTML(platform.label)}${platform.note ? `<small>${escapeHTML(platform.note)}</small>` : ""}</span>
        <span class="platform-status">${status}</span>
        <button class="plain-button manual-open" type="button" data-platform="${platform.id}"${disabled}>
        Ввести данные вручную</button></div>${externalLinks ? `<p>${externalLinks}</p>` : ""}${form}</div>`;
    }).join("");
    return `<section class="platform-status-group">${heading}${rows}</section>`;
  }).join("")}</div>`;
  if (openPlatformId) loadExisting(byId("ad-platforms-content").querySelector(".manual-stats-form"));
};
const formRange = (form) => {
  const dates = [...form.querySelectorAll('[name="date"]')].map((input) => input.value).filter(Boolean).sort();
  return dates.length ? { from: dates[0], to: dates.at(-1) } : null;
};
const nextFreeDate = (form) => {
  const dates = [...form.querySelectorAll('[name="date"]')].map((input) => input.value).filter(Boolean).sort();
  const date = dates.length ? new Date(`${dates[0]}T00:00:00`) : new Date();
  if (dates.length) date.setDate(date.getDate() - 1);
  return dateValue(date);
};
const clearExisting = (form) => form.querySelectorAll(".existing-value").forEach((item) => {
  item.textContent = "";
});
const loadExisting = async (form) => {
  if (!isCurrentForm(form)) return;
  const range = formRange(form);
  const platform = platformFor(form.dataset.platform);
  if (!range || !platform || !ctx.selectedProjectId) return;
  const request = ++existingRequest;
  clearExisting(form);
  try {
    const data = await crmQuery("/external-stats", {
      source: platform.codes[0],
      companyCode: form.dataset.companyCode,
      ...range
    });
    if (request !== existingRequest || !isCurrentForm(form)) return;
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
    if (request === existingRequest && isCurrentForm(form)) form.querySelector(".manual-result").textContent = error.message;
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
  if (!isEditable() || !isCurrentForm(form)) return;
  const result = form.querySelector(".manual-result");
  result.textContent = "";
  if (!form.reportValidity()) {
    const negative = [...form.querySelectorAll('input[type="number"]')].some((input) => input.valueAsNumber < 0);
    if (negative) result.textContent = "Значения должны быть не меньше 0";
    return;
  }
  const dates = [...form.querySelectorAll('[name="date"]')].map((input) => input.value);
  const duplicate = dates.find((date, index) => dates.indexOf(date) !== index);
  if (duplicate) {
    result.textContent = `Дата ${formatDate(duplicate, false)} повторяется`;
    return;
  }
  const rows = formRows(form);
  if (!rows.length) {
    result.textContent = "Введите хотя бы одно число.";
    return;
  }
  const platform = platformFor(form.dataset.platform);
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const saved = await crmQuery("/external-stats", {}, csrfOptions("POST", {
      source: platform.codes[0],
      companyCode: form.dataset.companyCode,
      rows,
      note: form.elements.note.value
    }));
    if (!isCurrentForm(form)) return;
    const dates = (saved.dates || rows.map((row) => row.date)).slice().sort();
    const savedCount = saved.upserted ?? rows.length;
    result.textContent = `Сохранено: ${savedCount} ${dayWord(savedCount)}, ` +
      `${formatDate(dates[0], false)}–${formatDate(dates.at(-1), false)}`;
    form.reset();
    try {
      await refreshDashboard(false);
    } catch (error) {
      // The statistics are saved even if refreshing platform statuses fails.
    }
  } catch (error) {
    if (isCurrentForm(form)) result.textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
const refreshDashboard = async (render = true) => {
  const companyCode = ctx.selectedProjectId;
  const request = ++dashboardRequest;
  const form = byId("ad-platforms-content").querySelector(".manual-stats-form");
  try {
    const data = await crmQuery("/dashboard", { ...periodDates("30d"), ...scopeParams() });
    if (request !== dashboardRequest || !isCurrentCompany(companyCode)) return;
    dashboardState = data;
    dashboardStatus = "ready";
  } catch (error) {
    if (request !== dashboardRequest || !isCurrentCompany(companyCode)) return;
    dashboardStatus = "error";
  }
  if (render) renderAdPlatforms();
  if (!render && isCurrentForm(form) && form === byId("ad-platforms-content").querySelector(".manual-stats-form")) {
    const message = form.querySelector(".manual-result").textContent;
    renderAdPlatforms();
    byId("ad-platforms-content").querySelector(".manual-result").textContent = message;
  }
};
const loadAdPlatforms = async () => {
  ++dashboardRequest;
  ++existingRequest;
  dashboardState = null;
  dashboardStatus = "loading";
  openPlatformId = null;
  if (ctx.currentView !== "ad-platforms") return;
  if (!identity.permissions.includes("analytics.view") || !ctx.selectedProjectId) {
    byId("ad-platforms-content").textContent = identity.permissions.includes("analytics.view")
      ? "Выберите компанию, чтобы открыть её рекламные площадки." : "Нет доступа к рекламным площадкам.";
    return;
  }
  renderAdPlatforms();
  await refreshDashboard();
};
const bindEvents = () => {
  const content = byId("ad-platforms-content");
  content.addEventListener("click", (event) => {
    if (event.target.closest(".retry-platforms")) { loadAdPlatforms(); return; }
    const open = event.target.closest(".manual-open");
    if (open && !open.disabled && isEditable() && isCurrentCompany(ctx.selectedProjectId)) {
      openPlatformId = openPlatformId === open.dataset.platform ? null : open.dataset.platform;
      renderAdPlatforms();
      return;
    }
    const form = event.target.closest(".manual-stats-form");
    if (!form) return;
    if (event.target.closest(".add-day")) {
      form.querySelector("tbody").insertAdjacentHTML("beforeend", dayRow(nextFreeDate(form)));
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

(() => {
"use strict";

const SbCabinet = window.SbCabinet = window.SbCabinet || {};
const ANALYTICS_PLATFORMS = SbCabinet.ANALYTICS_PLATFORMS = [
  { group: "Соцсети", id: "instagram", label: "Instagram*", codes: ["instagram"] },
  { group: "Соцсети", id: "vk", label: "ВКонтакте", codes: ["vk", "vk-ads"] },
  { group: "Соцсети", id: "youtube", label: "YouTube", codes: ["youtube"] },
  { group: "Соцсети", id: "tiktok", label: "TikTok", codes: ["tiktok"] },
  { group: "Соцсети", id: "ok", label: "Одноклассники", codes: ["ok", "odnoklassniki"] },
  { group: "Соцсети", id: "dzen", label: "Дзен", codes: ["dzen"] },
  { group: "Мессенджеры: боты и каналы", id: "telegram", label: "Telegram",
    codes: ["telegram", "telegram-ads"] },
  { group: "Мессенджеры: боты и каналы", id: "whatsapp", label: "WhatsApp*", codes: ["whatsapp"] },
  { group: "Мессенджеры: боты и каналы", id: "max", label: "MAX", codes: ["max"] },
  { group: "Яндекс Директ", id: "yandex-direct", label: "Поисковая реклама", codes: ["yandex-direct"] },
  { group: "Яндекс Директ", id: "yandex-rsya", label: "РСЯ", codes: ["yandex-rsya"] },
  { group: "Яндекс Директ", id: "yandex-master", label: "Мастер кампаний", codes: ["yandex-master"] },
  { group: "Яндекс Директ", id: "yandex-product", label: "Товарная кампания", codes: ["yandex-product"] },
  { group: "Яндекс Директ", id: "yandex-display", label: "Медийная", codes: ["yandex-display"] },
  { group: "Яндекс Директ", id: "yandex-business", label: "Яндекс Бизнес (Рекламная подписка)",
    codes: ["yandex-business"] },
  { group: "Яндекс Директ", id: "wordstat", label: "Яндекс Вордстат",
    note: "источник этапа «Потенциал»", codes: ["wordstat"] },
  { group: "Геоконтекст и карты", id: "2gis", label: "2ГИС", codes: ["2gis"] },
  { group: "Геоконтекст и карты", id: "yandex-maps", label: "Яндекс Карты",
    codes: ["yandex-maps"] },
  { group: "Геоконтекст и карты", id: "google-maps", label: "Google Maps", codes: ["google-maps"] },
  { group: "Классифайды", id: "avito", label: "Авито", codes: ["avito", "avito-ads"] },
  { group: "Поиск и бренд", id: "yandex", label: "Яндекс Поиск", codes: ["yandex"] },
  { group: "Поиск и бренд", id: "google", label: "Google Поиск", codes: ["google"] },
  { group: "Поиск и бренд", id: "brand", label: "Брендовые запросы (сарафанное радио)", codes: ["brand"] },
  { group: "", id: "direct", label: "Прямые заходы", codes: ["direct"] }
];

let ctx;
let identity, selectedProjectId, byId, escapeHTML, crmQuery, csrfOptions, scopeParams;
let formatMoney, formatROMI, periodDates, dateValue;
let initialized = false;
const api = {};
const init = (context) => {
ctx = context;
({ identity, selectedProjectId, byId, escapeHTML, crmQuery, csrfOptions, scopeParams } = context);
({ formatMoney, formatROMI, periodDates, dateValue } = context);
if (initialized) return;
initialized = true;

let analyticsBound = false;
const analyticsState = {
  period: "today",
  range: periodDates("today"),
  selected: new Set(ANALYTICS_PLATFORMS.map((platform) => platform.id)),
  payload: null
};
const optionalSum = (values) => values.some((value) => value !== null && value !== undefined)
  ? values.reduce((sum, value) => sum + (Number(value) || 0), 0) : null;
const formatMetric = (value) => value === null || value === undefined ? "—" :
  new Intl.NumberFormat("ru-RU").format(Number(value));
const sourceStatsFor = (platform, stats) => stats.filter((row) =>
  platform.codes.includes(String(row.source || "").toLowerCase())
);
const selectedPlatforms = () => ANALYTICS_PLATFORMS.filter((platform) =>
  analyticsState.selected.has(platform.id)
);
const aggregatePlatform = (platform, stats) => {
  const rows = sourceStatsFor(platform, stats);
  const externals = rows.filter((row) => row.external);
  const externalValue = (key) => optionalSum(externals.map((row) => row.external?.[key]));
  const externalClicks = optionalSum(externals.flatMap((row) => [
    row.external?.siteClicks,
    row.external?.calls,
    row.external?.routes,
    row.external?.messengerClicks
  ]));
  const visits = optionalSum(rows.map((row) => row.visits));
  return {
    platform,
    rows,
    pageViews: externalValue("pageViews"),
    externalClicks,
    visits,
    funnelClicks: optionalSum([externalClicks, visits]),
    clicks: optionalSum(rows.map((row) => row.clicks)),
    leads: optionalSum(rows.map((row) => row.leads)),
    booked: optionalSum(rows.map((row) => row.booked)),
    visited: optionalSum(rows.map((row) => row.visited)),
    sales: optionalSum(rows.map((row) => row.sales)),
    revenue: optionalSum(rows.map((row) => row.revenue)),
    expenses: optionalSum(rows.map((row) => row.expenses)),
    romi: rows.length ? optionalSum(rows.map((row) => row.romi)) : null,
    capturedAt: externals.map((row) => row.externalCapturedAt).filter(Boolean).sort().at(-1) || null,
    hasExternal: externals.length > 0
  };
};
const snapshotDate = (value) => value ? new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "short"
}).format(new Date(value)) : "";
const dataMark = (kind, date) => {
  const labels = {
    live: "LIVE",
    snapshot: `СНИМОК${date ? ` от ${snapshotDate(date)}` : ""}`,
    mixed: `LIVE + СНИМОК${date ? ` от ${snapshotDate(date)}` : ""}`,
    manual: "РУЧНОЙ ВВОД",
    none: "НЕТ ДАННЫХ"
  };
  return `<span class="data-mark" data-kind="${kind}">${labels[kind]}</span>`;
};
const renderPlatformFilter = () => {
  const panel = byId("platform-panel");
  let group = null;
  const options = ANALYTICS_PLATFORMS.map((platform) => {
    const heading = platform.group && platform.group !== group
      ? `<div class="platform-group">${escapeHTML(platform.group)}</div>` : "";
    group = platform.group || group;
    return `${heading}<label class="platform-option"><input type="checkbox" value="${platform.id}"
      ${analyticsState.selected.has(platform.id) ? "checked" : ""}>
      <span>${escapeHTML(platform.label)}${platform.note
        ? `<small class="muted"> — ${escapeHTML(platform.note)}</small>` : ""}</span></label>`;
  }).join("");
  const allChecked = analyticsState.selected.size === ANALYTICS_PLATFORMS.length;
  panel.innerHTML = `<label class="platform-option"><input type="checkbox" value="all"
    ${allChecked ? "checked" : ""}><strong>Все площадки</strong></label>${options}`;
  byId("platform-trigger").textContent = allChecked ? "Все площадки" : `Выбрано: ${analyticsState.selected.size}`;
};
const funnelProjectLabel = () => selectedProjectId === "synapse-business" ? "онлайн-созвон" :
  ["alvi", "avokado"].includes(selectedProjectId) ? "запись на визит" : "заявка";
const renderAnalytics = (dashboard, summary, expenses) => {
  analyticsState.payload = { dashboard, summary, expenses };
  const stats = Array.isArray(dashboard.sourceStats) ? dashboard.sourceStats : [];
  const allSelected = analyticsState.selected.size === ANALYTICS_PLATFORMS.length;
  const knownCodes = new Set(ANALYTICS_PLATFORMS.flatMap((platform) => platform.codes));
  const unknownCodes = allSelected ? [...new Set(stats.map((row) => String(row.source || "").toLowerCase())
    .filter((code) => !knownCodes.has(code)))] : [];
  const unknownPlatforms = unknownCodes.map((code) => ({
    group: "", id: `other-${code}`, label: `Прочие: ${code || "без кода"}`, codes: [code], isUnknown: true
  }));
  const platforms = [...selectedPlatforms(), ...unknownPlatforms]
    .map((platform) => aggregatePlatform(platform, stats));
  platforms.sort((left, right) => (left.platform.isUnknown ? 1 : 0) -
    (right.platform.isUnknown ? 1 : 0) ||
    Number(right.hasExternal) - Number(left.hasExternal) ||
    ANALYTICS_PLATFORMS.indexOf(left.platform) - ANALYTICS_PLATFORMS.indexOf(right.platform));
  const selectedCodes = selectedPlatforms().flatMap((platform) => platform.codes);
  const aggregateCodes = allSelected ? [...selectedCodes, ...unknownCodes] : selectedCodes;
  const selectedAggregate = aggregatePlatform({ codes: [...new Set(aggregateCodes)] }, stats);
  const total = (key) => selectedAggregate[key];
  const pageViews = total("pageViews");
  const funnelClicks = total("funnelClicks");
  const warmup = optionalSum([total("clicks"), total("leads")]);
  const sales = total("sales");
  const revenue = total("revenue");
  const values = { ...(dashboard.summary || {}), ...dashboard };
  const expensesUnavailable = selectedProjectId !== "synapse-business" &&
    (values.expenses === null || dashboard.expensesScope || summary.expensesScope);
  const financeExpenses = expensesUnavailable ? null : allSelected ? values.expenses : total("expenses");
  const financeRevenue = allSelected ? values.revenue : revenue;
  const financeRomi = expensesUnavailable ? null : allSelected ? values.romi :
    financeRevenue === null || financeRevenue === undefined || financeExpenses === null || !financeExpenses
      ? null : (financeRevenue - financeExpenses) / financeExpenses * 100;
  const financeUnavailable = expensesUnavailable || (!allSelected && financeExpenses === null);
  const newestCapture = platforms.map((platform) => platform.capturedAt).filter(Boolean).sort().at(-1);
  const funnel = [
    {
      id: "potential",
      label: "Потенциал",
      value: null,
      kind: "none",
      note: "поиски по целевым запросам и конкуренты — ручной ввод, появится в «Рекламных площадках»"
    },
    { id: "views", label: "Показы", value: pageViews, kind: pageViews === null ? "none" : "snapshot",
      date: newestCapture, note: "переходы на карточку площадки" },
    { id: "clicks", label: "Клики", value: funnelClicks, kind: funnelClicks === null ? "none" :
      total("externalClicks") !== null && total("visits") !== null ? "mixed" :
        total("externalClicks") !== null ? "snapshot" : "live", date: newestCapture,
      note: `карточки: ${formatMetric(total("externalClicks"))} · сайт: ${formatMetric(total("visits"))}` },
    { id: "warmup", label: "Прогрев", value: warmup, kind: warmup === null ? "none" : "live",
      note: `ключевой этап проекта: ${funnelProjectLabel()}` },
    { id: "deal", label: "Сделка", value: sales, kind: sales === null ? "none" : "live",
      note: `выручка: ${financeRevenue === null || financeRevenue === undefined
        ? "—" : formatMoney(financeRevenue)} · повторные: нет данных` }
  ];
  const numeric = funnel.map((step) => step.value).filter((value) => value !== null);
  const maximum = Math.max(...numeric, 1);
  const funnelRows = funnel.map((step, index) => {
    const previous = funnel[index - 1]?.value;
    const conversion = step.value !== null && previous > 0
      ? `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(step.value / previous * 100)}%` : "—";
    const width = step.value === null ? 28 : Math.max(28, step.value / maximum * 100);
    const details = platforms.map((platform) => {
      const key = { views: "pageViews", clicks: "funnelClicks", warmup: "clicks", deal: "sales" }[step.id];
      let value = key ? platform[key] : null;
      if (step.id === "warmup") value = optionalSum([platform.clicks, platform.leads]);
      return `<div><dt>${escapeHTML(platform.platform.label)}</dt><dd>${formatMetric(value)}</dd></div>`;
    }).join("");
    return `<div class="funnel-step"><button class="funnel-shape" type="button" style="width:${width}%"
      data-funnel-step="${step.id}" aria-expanded="false"><span class="funnel-shape-label">
      ${escapeHTML(step.label)}</span></button>
      <article class="funnel-card"><div class="funnel-card-head"><h3>${escapeHTML(step.label)}</h3>
      ${step.value === null ? "" : `<strong class="funnel-number">${formatMetric(step.value)}</strong>`}</div>
      <div class="funnel-conversion">Конверсия из предыдущей ступени: ${conversion}</div>
      <div class="funnel-note">${escapeHTML(step.note)}</div>${dataMark(step.kind, step.date)}</article>
      <div class="funnel-detail" data-funnel-detail="${step.id}" hidden>
      <dl class="funnel-detail-list">${details}</dl></div></div>`;
  }).join("");
  const tableRows = platforms.map((platform) => {
    const noExpenses = expensesUnavailable || platform.expenses === null;
    const kind = platform.hasExternal ? "snapshot" : platform.rows.length ? "live" : "none";
    const clickTargets = platform.rows.flatMap((row) => Object.entries(row.clicksByTarget || {}))
      .map(([target, count]) => `${target}: ${count}`).join(" · ");
    return `<tr><td>${escapeHTML(platform.platform.label)}</td><td>${formatMetric(platform.pageViews)}</td>
      <td>${formatMetric(platform.funnelClicks)}</td><td title="${escapeHTML(clickTargets || "Нет разбивки")}">
      ${formatMetric(platform.clicks)}</td><td>${formatMetric(platform.leads)}</td>
      <td>${formatMetric(platform.sales)}</td>
      <td>${platform.revenue === null ? "—" : formatMoney(platform.revenue)}</td>
      <td>${noExpenses ? "—" : formatMoney(platform.expenses)}</td>
      <td>${noExpenses ? "—" : formatROMI(platform.romi)}</td><td>${dataMark(kind, platform.capturedAt)}</td></tr>`;
  }).join("");
  byId("analytics-content").innerHTML = `<section class="analytics-section"><h2>Воронка</h2>
    <div class="analytics-funnel">${funnelRows}</div><div class="analytics-finance">
    <div class="crm-stat"><span>Расходы</span><strong>${financeUnavailable
      ? "по компании не ведутся" : financeExpenses === null ? "—" : formatMoney(financeExpenses)}</strong></div>
    <div class="crm-stat"><span>Выручка</span><strong>${financeRevenue === null || financeRevenue === undefined
      ? "—" : formatMoney(financeRevenue)}</strong></div>
    <div class="crm-stat"><span>ROMI</span><strong>${financeUnavailable
      ? "по компании не ведутся" : formatROMI(financeRomi)}</strong></div></div></section>
    <section class="analytics-section"><h2>Площадки</h2><div class="crm-table-wrap">
    <table class="crm-table analytics-source-table"><thead><tr><th>Площадка</th><th>Показы</th><th>Клики</th>
    <th>Обращения</th><th>Заявки</th><th>Продажи</th><th>Выручка</th><th>Расходы</th><th>ROMI</th>
    <th>Данные</th></tr></thead><tbody>${tableRows}</tbody></table></div></section>`;
  byId("analytics-content").querySelectorAll("[data-funnel-step]").forEach((button) => {
    button.addEventListener("click", () => {
      const detail = byId("analytics-content").querySelector(`[data-funnel-detail="${button.dataset.funnelStep}"]`);
      detail.hidden = !detail.hidden;
      button.setAttribute("aria-expanded", String(!detail.hidden));
    });
  });
  const legacySources = Array.isArray(summary.sources) ? summary.sources : [];
  byId("analytics-legacy").innerHTML = `<div class="crm-summary">
    <div class="crm-stat"><span>Заявки</span><strong>${formatMetric(values.total)}</strong></div>
    <div class="crm-stat"><span>Записались</span><strong>${formatMetric(values.booked)}</strong></div>
    <div class="crm-stat"><span>Пришли</span><strong>${formatMetric(values.visited)}</strong></div>
    <div class="crm-stat"><span>Продажи</span><strong>${formatMetric(values.sales)}</strong></div></div>
    <div class="analytics-actions"><h2>Заявки по источникам</h2>
    <button class="plain-button" id="analytics-csv" type="button">Выгрузить CSV</button></div>
    ${legacySources.length ? `<div class="crm-table-wrap"><table class="crm-table"><thead><tr>
    <th>Источник</th><th>Заявки</th><th>Записи</th><th>Визиты</th><th>Продажи</th><th>Выручка</th>
    </tr></thead><tbody>${legacySources.map((source) => `<tr><td>${escapeHTML(source.source)}</td>
    <td>${formatMetric(source.leads)}</td><td>${formatMetric(source.booked)}</td>
    <td>${formatMetric(source.visited)}</td>
    <td>${formatMetric(source.sales)}</td><td>${source.revenue === null ? "—" : formatMoney(source.revenue)}</td>
    </tr>`).join("")}</tbody></table></div>` : '<div class="crm-empty">Данных по источникам нет</div>'}`;
  byId("analytics-csv").addEventListener("click", () => {
    crmQuery("/leads.csv", { ...analyticsState.range, ...scopeParams() }, { open: true });
  });
  const scopedExpenses = selectedProjectId !== "synapse-business";
  byId("expenses-section").querySelector("h2").hidden = scopedExpenses;
  byId("expense-form").hidden = scopedExpenses || !identity.permissions.includes("crm.edit");
  byId("expense-result").hidden = scopedExpenses;
  if (scopedExpenses) {
    byId("expenses-content").innerHTML =
      '<p class="notice">Расходы ведутся по всему бизнесу: выберите проект «Synapse Бизнес»</p>';
    return;
  }
  const expenseRows = expenses.map((expense) => `<tr><td>${escapeHTML(expense.spentAt.slice(0, 10))}</td>
    <td>${escapeHTML(expense.source)}</td><td>${escapeHTML(formatMoney(expense.amount))}</td>
    <td>${escapeHTML(expense.comment || "—")}</td></tr>`).join("");
  byId("expenses-content").innerHTML = expenseRows
    ? `<div class="crm-table-wrap"><table class="crm-table"><thead><tr><th>Дата</th><th>Источник</th>
      <th>Сумма</th><th>Комментарий</th></tr></thead><tbody>${expenseRows}</tbody></table></div>`
    : '<div class="crm-empty">За период расходов нет</div>';
};
const loadAnalytics = async () => {
  if (ctx.currentView !== "analytics-through" || !identity.permissions.includes("analytics.view")) return;
  byId("analytics-content").innerHTML = '<div class="crm-empty">Загрузка аналитики…</div>';
  const range = analyticsState.range;
  try {
    const [dashboard, summary, expensePayload] = await Promise.all([
      crmQuery("/dashboard", { period: analyticsState.period, ...range, ...scopeParams() }),
      crmQuery("/summary", { ...range, ...scopeParams() }),
      selectedProjectId === "synapse-business" ? crmQuery("/expenses", range) : { expenses: [] }
    ]);
    renderAnalytics(dashboard, summary, expensePayload.expenses || []);
  } catch (error) {
    byId("analytics-content").innerHTML =
      '<div class="crm-error" role="alert">Не удалось загрузить сквозную аналитику.</div>';
    byId("expenses-content").replaceChildren();
  }
};
const renderAnalyticsControls = () => {
  const form = byId("analytics-dates");
  renderPlatformFilter();
  form.elements.from.value = analyticsState.range.from;
  form.elements.to.value = analyticsState.range.to;
  byId("expense-form").hidden = !identity.permissions.includes("crm.edit");
  byId("expense-form").elements.date.value = dateValue(new Date());
  if (analyticsBound) return;
  analyticsBound = true;
  byId("platform-trigger").addEventListener("click", () => {
    const trigger = byId("platform-trigger");
    const panel = byId("platform-panel");
    panel.hidden = !panel.hidden;
    trigger.setAttribute("aria-expanded", String(!panel.hidden));
  });
  byId("platform-panel").addEventListener("change", (event) => {
    if (event.target.value === "all") {
      analyticsState.selected = event.target.checked
        ? new Set(ANALYTICS_PLATFORMS.map((platform) => platform.id)) : new Set();
    } else if (event.target.checked) {
      analyticsState.selected.add(event.target.value);
    } else {
      analyticsState.selected.delete(event.target.value);
    }
    renderPlatformFilter();
    if (analyticsState.payload) {
      renderAnalytics(
        analyticsState.payload.dashboard,
        analyticsState.payload.summary,
        analyticsState.payload.expenses
      );
    }
  });
  document.addEventListener("click", (event) => {
    if (event.target.closest("#platform-filter")) return;
    byId("platform-panel").hidden = true;
    byId("platform-trigger").setAttribute("aria-expanded", "false");
  });
  byId("analytics-periods").addEventListener("click", (event) => {
    const button = event.target.closest("[data-analytics-period]");
    if (!button) return;
    analyticsState.period = button.dataset.analyticsPeriod;
    analyticsState.range = periodDates(analyticsState.period);
    form.elements.from.value = analyticsState.range.from;
    form.elements.to.value = analyticsState.range.to;
    document.querySelectorAll("[data-analytics-period]").forEach((item) => {
      item.setAttribute("aria-pressed", String(item === button));
    });
    loadAnalytics();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (form.elements.from.value > form.elements.to.value) {
      byId("analytics-content").innerHTML =
        '<div class="crm-error" role="alert">Дата «С» не может быть позже даты «По».</div>';
      return;
    }
    analyticsState.range = { from: form.elements.from.value, to: form.elements.to.value };
    const days = Math.ceil((new Date() - new Date(`${analyticsState.range.from}T00:00:00Z`)) / 86400000);
    analyticsState.period = days <= 1 ? "today" : days <= 7 ? "7d" : "30d";
    document.querySelectorAll("[data-analytics-period]").forEach((item) => {
      item.setAttribute("aria-pressed", "false");
    });
    loadAnalytics();
  });
  byId("expense-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const expenseForm = event.currentTarget;
    try {
      await crmQuery("/expenses", {}, csrfOptions("POST", {
        date: expenseForm.elements.date.value,
        source: expenseForm.elements.source.value,
        amount: Number(expenseForm.elements.amount.value),
        comment: expenseForm.elements.comment.value
      }));
      byId("expense-result").textContent = "Расход добавлен";
      expenseForm.elements.amount.value = "";
      expenseForm.elements.comment.value = "";
      await loadAnalytics();
    } catch (error) {
      byId("expense-result").textContent = "Не удалось добавить расход";
    }
  });
};
Object.assign(api, { renderAnalyticsControls, loadAnalytics });
};

SbCabinet.registerView("analytics-through", {
title: "Сквозная аналитика",
initialize(context) {
  init(context);
  api.renderAnalyticsControls();
},
render(container, context) {
  init(context);
  api.renderAnalyticsControls();
  api.loadAnalytics();
},
onProjectChange(context) {
  init(context);
  api.loadAnalytics();
},
});
})();

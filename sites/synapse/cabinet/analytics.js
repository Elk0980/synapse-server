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
let identity, byId, escapeHTML, crmQuery, csrfOptions, scopeParams;
let formatMoney, formatROMI, periodDates, dateValue;
let initialized = false;
const api = {};
const init = (context) => {
ctx = context;
({ identity, byId, escapeHTML, crmQuery, csrfOptions, scopeParams } = context);
({ formatMoney, formatROMI, periodDates, dateValue } = context);
const contextPeriodDates = periodDates;
periodDates = (period) => {
  const dates = contextPeriodDates(period);
  const length = period === '7d' ? 7 : period === '30d' ? 30 : null;
  // Обе границы включены в API: 7 дней — сегодня и шесть предыдущих дней.
  if (!length || !/^\d{4}-\d{2}-\d{2}$/.test(dates.to)) return dates;
  const last = Date.parse(dates.to + 'T12:00:00Z');
  if (!Number.isFinite(last)) return dates;
  return { ...dates, from: new Date(last - (length - 1) * 86400000).toISOString().slice(0, 10) };
};
if (initialized) return;
initialized = true;

let analyticsBound = false;
const analyticsState = {
  period: "today",
  range: periodDates("today"),
  selected: new Set(ANALYTICS_PLATFORMS.map((platform) => platform.id)),
  payload: null
};
const shortDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? value.split("-").reverse().join(".") : "—";
const shortRange = (range) => range ? `${shortDay(range.from)}–${shortDay(range.to)}` : "—";
const GRANULARITY_LABELS = { month: "целые месяцы", week: "целые недели", day: "дни", period: "периоды снимка" };
const GRANULARITY_PARTIAL_LABELS = { month: "по месяцам снимка", week: "по неделям снимка", day: "по дням снимка", period: "периоды снимка" };
// «Целые месяцы» пишется только когда ни один из периодов не помечен неполным; иначе — фактическая
// детализация с явной неполнотой, чтобы подпись не противоречила данным.
const granularityLabel = (list, partial = false) => {
  const unique = [...new Set(list || [])];
  const table = partial ? GRANULARITY_PARTIAL_LABELS : GRANULARITY_LABELS;
  const label = unique.length === 1 && table[unique[0]] ? table[unique[0]] : "периоды снимка";
  return partial ? `${label}, есть неполный период` : label;
};
// Ступень «Потенциал» строится только из снимка «Спрос по рубрикам» 2ГИС за выбранную компанию.
// Строки снимка берутся целиком и только внутри запрошенного периода, без пропорций; покрытие
// описывается точными отрезками. Конверсия в «Показы» из этой ступени не считается никогда:
// поиски по рубрикам и переходы на карточку — показатели с разным составом, напрямую не сопоставимые.
const potentialStep = (potential, requested) => {
  const base = { id: "potential", label: "Потенциал", value: null, kind: "none", date: null,
    noConversionFrom: "показатели напрямую не сопоставимы", breakdown: null, note: "" };
  const source = "источник — поиски по рубрикам 2ГИС";
  if (!analyticsState.selected.has("2gis")) return { ...base, note: `${source}; площадка 2ГИС не выбрана в фильтре` };
  if (!potential || potential.error) return { ...base, note: `${source}; снимок сейчас недоступен — повторите загрузку` };
  if (!potential.available) return { ...base, note: `${source}; снимок не загружен — добавьте его в разделе «Потенциал 2ГИС»` };
  const suggestion = potential.suggested
    ? ` Ближайший доступный диапазон снимка (${granularityLabel(potential.suggested.granularities, potential.suggested.partial)}): ${shortRange(potential.suggested)}.` : "";
  const available = `в снимке: ${shortRange(potential.availablePeriod)}`;
  if (!potential.covered) {
    return { ...base, note: `${source}; за ${shortRange(requested)} нет ни одного целого периода снимка (${available}).${suggestion}` };
  }
  const uncovered = (potential.uncovered || []).map(shortRange).join(", ");
  const partialPeriods = (potential.periods || []).filter((period) => period.partial)
    .map((period) => shortRange({ from: period.periodStart, to: period.periodEnd })).join(", ");
  const coverage = potential.complete ? `покрыт целиком, ${granularityLabel(potential.granularities, potential.partial)}`
    : `покрыто ${shortRange(potential.covered)}${uncovered ? `, не покрыто: ${uncovered}` : ""}`;
  const partial = partialPeriods ? `; неполный период снимка: ${partialPeriods}` : "";
  const missing = (potential.missingCategories || []).length
    ? `; в части периодов нет рубрик: ${potential.missingCategories.join(", ")} — итог по ним неизвестен` : "";
  const overlap = "; рубрики могут пересекаться, это не уникальные люди";
  const names = potential.unclassifiedCategories || [];
  const unclassified = names.length ? `не назначено ${names.length}: ${names.join(", ")}` : "все рубрики назначены";
  const breakdown = { all: potential.totals.all, target: potential.totals.target, nonTarget: potential.totals.nonTarget,
    unclassified: potential.totals.unclassified };
  if (potential.totals.target === null) {
    return { ...base, kind: "snapshot", date: potential.capturedAt, breakdown,
      note: `${source}; целевой спрос не считается (${unclassified}${missing ? missing.slice(1) : ""}). ` +
        `Всего по рубрикам: ${formatMetric(potential.totals.all)}; ${coverage}${partial}${overlap}. Назначьте рубрики в «Потенциал 2ГИС».${suggestion}` };
  }
  return { ...base, value: potential.totals.target, kind: "snapshot", date: potential.capturedAt, breakdown,
    note: `${source}, только целевые рубрики; всего по рубрикам: ${formatMetric(potential.totals.all)}; ${unclassified}; ${coverage}${partial}${missing}${overlap}.${suggestion}` };
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
/* Фактическая статистика 2ГИС: только загруженные в ЛК отчёты за тот же период.
   Эти события не сводятся с продажами CRM и не считаются уникальными обращениями:
   пересечение совокупностей отчётов 2ГИС между собой и с CRM не доказано. */
const renderCompanyMetricsSection = (companyMetrics, owner) => {
  const head = '<section class="analytics-section analytics-2gis"><h2>Фактическая статистика 2ГИС</h2>' +
    `<p class="crm-note">Загруженные отчёты кабинета 2ГИС за ${escapeHTML(shortRange(owner))}. ` +
    'Это не события CRM: с продажами и заявками они не складываются.</p>';
  const link = '<p><a class="plain-button" href="#platform-demand">Подробности в разделе 2ГИС</a></p></section>';
  if (!companyMetrics) return head + '<div class="crm-empty">Показатели 2ГИС не загружены за этот период.</div>' + link;
  if (companyMetrics.error) return head +
    '<div class="crm-empty">Показатели 2ГИС сейчас недоступны: состояние за период неизвестно.</div>' + link;
  const rows = (companyMetrics.metrics || []).filter((item) => item.daysWithValue > 0);
  if (!rows.length) return head +
    '<div class="crm-empty">За этот период загруженных значений нет. Это не ноль показов, а отсутствие отчётов.</div>' + link;
  /* Диапазон по дням уместен только для позиции в выдаче и только при известных min/max.
     Счётчик без сопоставимого итога показывает причину, а не «null–null». */
  const cells = rows.map((item) => {
    const range = item.aggregation === "daily_only" && item.min !== null && item.max !== null
      ? `${item.min}–${item.max} по дням` : null;
    const value = item.totalAvailable ? formatMetric(item.total) : range || "итог не сводится";
    const note = item.totalAvailable || range ? "" :
      `<span class="crm-note">${escapeHTML(item.totalNote || "Значения собраны при разных условиях.")}</span>`;
    return `<div class="crm-stat"><span>${escapeHTML(item.label)}</span><strong>${escapeHTML(value)}</strong>${note}</div>`;
  }).join("");
  const coverage = companyMetrics.coverage || {};
  return head + `<div class="crm-summary">${cells}</div>` +
    `<p class="crm-note">Дней с измерениями: ${escapeHTML(String((coverage.datesWithValue || []).length))} из ${
      escapeHTML(String(coverage.expectedDays ?? 0))}. «Звонки и просмотры телефона» — не состоявшиеся звонки. ` +
    'Категории обращений не складываются друг с другом и с действиями на странице.</p>' + link;
};
const renderAnalyticsGuide = () => `<section class="analytics-section analytics-guide">
  <details><summary><strong>Как читать сквозную аналитику — инструкция</strong></summary>
  <p>Сначала выберите компанию, затем даты «С» и «По». Для ежедневной проверки берите вчерашний полный день,
  для сравнения — две полные недели одинаковой длины. Сегодняшние данные ещё неполные.</p>
  <ol>
    <li><strong>Проверьте свежесть.</strong> В блоке «Записи и оплаты из источников» посмотрите последний успешный сбор
    отдельно для Метрики и YCLIENTS. «Не подключён», ошибка и отсутствие выгрузки означают неизвестные данные, а не ноль.</li>
    <li><strong>Посмотрите путь клиента.</strong> Визиты и посетители сайта → действия на сайте → подтверждённые записи
    → состоявшиеся посещения → оплаты с учётом возвратов. Клик на телефон или онлайн-запись ещё не подтверждает звонок или запись.</li>
    <li><strong>Читайте цели по отдельности.</strong> «Целевые визиты» — визиты с выбранным действием;
    «Достижения» — число его выполнений, включая повторы. Один посетитель может выполнить несколько целей.
    Конверсия цели = целевые визиты / все визиты × 100%. Складывать цели как клиентов нельзя.</li>
    <li><strong>Сравните источники.</strong> Источники и UTM показывают происхождение переходов.
    В YCLIENTS проверьте записи с источником и без него, а также денежные операции без связи с записью.
    Неизвестный источник нельзя автоматически приписывать рекламе. UTM 2ГИС не раскрывают поисковый запрос.</li>
    <li><strong>Проверьте деньги.</strong> Денежный итог = платежи − возвраты; это не прибыль.
    CAC = расходы на привлечение / новые платящие клиенты той же группы.
    ROMI = (маржинальный доход этой группы − расходы на маркетинг) / расходы на маркетинг × 100%.
    Без подтверждённых расходов, первых оплат, источников и себестоимости результат неизвестен.</li>
  </ol>
  <p>Даты создания записи, посещения и оплаты могут различаться. Делить итоги этих трёх событий за календарный
  период друг на друга как конверсию нельзя: для неё нужна одна и та же группа записей.</p>
  <p><strong>Каждый день, 5 минут:</strong> свежесть → визиты → подтверждённые записи → состоявшиеся посещения
  → деньги и возвраты → неизвестные источники. <strong>Раз в неделю:</strong> сравните полные недели и выберите
  одно улучшение по самому заметному месту потери клиентов. При сбое сообщите компанию, период и время последнего успеха;
  не отправляйте клиентские телефоны или ключи доступа.</p>
  <p class="crm-note">Фильтр площадок относится к воронке выше. «Записи и оплаты из источников» показывает компанию целиком.
  Ручные данные 2ГИС и серверные данные имеют отдельные даты обновления.</p>
  </details></section>`;
const renderRevenueSection = (payload) => {
  const head='<section class="analytics-section analytics-revenue"><h2>Записи и оплаты из источников</h2>';
  if (!payload || payload.error) return head+'<p class="crm-note">Серверный сбор ещё не доступен. Клики и старые отметки CRM не подтверждают визит или оплату.</p></section>';
  const num=(v)=>v===null||v===undefined?'—':escapeHTML(new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(v));
  const at=(v)=>v?escapeHTML(new Date(v).toLocaleString('ru-RU')):'ещё не было';
  const accessError=(code)=>code==='TOKEN_REAUTH_REQUIRED'?'нужно повторно подключить Метрику':code==='TOKEN_REFRESH_UNCERTAIN'?'продление доступа не подтверждено; нужна проверка подключения':code==='TOKEN_REFRESH_BUSY'?'доступ обновляется; загрузка будет повторена':'ошибка загрузки';
  const states=payload.state.providers.map(p=>'<li>'+escapeHTML(p.provider==='metrika'?'Яндекс Метрика':'YCLIENTS')+': '+
    (!p.configured?'не подключён':!p.enabled?'сбор выключен':p.running?'идёт загрузка':p.errorCode?accessError(p.errorCode):p.stale?'данные требуют обновления':'обновляется сервером')+
    '. Последний успех: '+at(p.lastSuccess)+'</li>').join('');
  const m=payload.metrika,y=payload.yclients;
  const trafficTable=(report,title)=>'<h4>'+title+'</h4><div class="crm-table-wrap"><table class="crm-table"><thead><tr><th>Источник</th><th>Визиты</th><th>Среднее время, сек.</th></tr></thead><tbody>'+report.rows.map(row=>'<tr><td>'+escapeHTML(row.dimensions.map(d=>d.name||d.id||'не определено').join(' / '))+'</td><td>'+num(row.metrics[0])+'</td><td>'+num(row.metrics[2])+'</td></tr>').join('')+'</tbody></table></div>';
  const metrika=m?'<h3>Посещения сайта</h3><p>Визиты: <strong>'+num(m.overview.totals[0])+'</strong> · посетители: '+num(m.overview.totals[1])+
    ' · среднее время: '+num(m.overview.totals[2])+' сек.</p><p class="crm-note">'+(m.current?'':'Подключение изменилось; это прежний снимок. ')+
    'Снято: '+at(m.collectedAt)+'. '+(m.overview.sampled?'Применена выборка; доля '+num(m.overview.sampleShare*100)+'%. ':'')+
    'Часовой пояс: '+escapeHTML(m.timezone)+'. Текущий день неполный.</p><div class="crm-table-wrap"><table class="crm-table"><thead><tr><th>Действие</th><th>Целевые визиты</th><th>Достижения</th><th>Конверсия</th></tr></thead><tbody>'+m.goals.map(g=>'<tr><td>'+escapeHTML(g.label)+'</td><td>'+num(g.visits)+'</td><td>'+num(g.reaches)+'</td><td>'+num(g.conversionRate)+'%</td></tr>').join('')+'</tbody></table></div>'+trafficTable(m.sources,'Откуда пришли на сайт')+trafficTable(m.utm,'Переходы по UTM')+'<p class="crm-note">Источник — последний значимый переход. Посетители и цели разных строк могут пересекаться; их нельзя складывать как клиентов. Пустая метка означает неизвестный источник.</p>':
    '<p class="crm-note">Для этого периода пока нет выгрузки Метрики.</p>';
  const yclients=y?'<h3>YCLIENTS: записи, визиты и реальные деньги</h3><p>Создано записей: <strong>'+num(y.createdBookings)+'</strong> · из них отменено: '+num(y.cancelledBookings)+
    ' · состоялось визитов: '+num(y.attendedVisits)+' · платящих клиентов: '+num(y.payingClients)+'</p><p>Платежи: '+formatMoney(y.paymentKopecks/100)+
    ' · возвраты: '+formatMoney(y.refundKopecks/100)+' · денежный итог: '+formatMoney(y.netCashKopecks/100)+'</p><p class="crm-note">'+
    (y.partialHistory?'История до '+escapeHTML(y.historyFrom)+' не загружена. ':'')+(!y.financialClassificationComplete?'Статьи денег ещё не полностью сопоставлены. ':'')+'Операций с неизвестной статьёй: '+num(y.unknownExpenseTransactions)+
    '; без связи с записью: '+num(y.unmatchedTransactions)+'. Записей с источником: '+num(y.bookingsWithSource)+'; без источника: '+num(y.bookingsWithoutSource)+
    '. Каждый показатель относится к своей дате: создание записи, посещение или платёж. Их отношение не является конверсией одной группы клиентов.</p><div class="crm-table-wrap"><table class="crm-table"><thead><tr><th>Источник / кампания</th><th>Записи</th><th>Визиты</th><th>Денежный итог</th></tr></thead><tbody>'+y.sources.map(g=>'<tr><td>'+escapeHTML(g.utm?[g.utm.source,g.utm.medium,g.utm.campaign].filter(Boolean).join(' / '):'Источник неизвестен')+'</td><td>'+num(g.bookings)+'</td><td>'+num(g.attendedVisits)+'</td><td>'+formatMoney(g.netCashKopecks/100)+'</td></tr>').join('')+'</tbody></table></div>':
    '<p class="crm-note">Записи и оплаты YCLIENTS ещё не загружены.</p>';
  const action=identity.role==='owner'?'<button type="button" class="plain-button" data-revenue-collect>Обновить данные этого периода</button><p class="crm-note" data-revenue-result></p>':'';
  return head+'<ul>'+states+'</ul><p class="crm-note">Этот блок показывает компанию целиком; фильтр площадок выше относится к прежней воронке.</p>'+metrika+yclients+
    '<p class="crm-note">'+escapeHTML(payload.economics.reason)+' UTM показывают метку перехода; поиск по названию или заслугу рекламы они сами по себе не доказывают.</p>'+action+'</section>';
};
const renderAnalytics = (dashboard, summary, expenses, potential = null, owner = analyticsState.payload?.owner, companyMetrics = analyticsState.payload?.companyMetrics ?? null, revenueData = analyticsState.payload?.revenueData ?? null) => {
  analyticsState.payload = { dashboard, summary, expenses, potential, owner, companyMetrics, revenueData };
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
  const expensesUnavailable = values.expenses === null || dashboard.expensesScope || summary.expensesScope;
  const financeExpenses = expensesUnavailable ? null : allSelected ? values.expenses : total("expenses");
  const financeRevenue = allSelected ? values.revenue : revenue;
  const financeRomi = expensesUnavailable ? null : allSelected ? values.romi :
    financeRevenue === null || financeRevenue === undefined || financeExpenses === null || !financeExpenses
      ? null : (financeRevenue - financeExpenses) / financeExpenses * 100;
  const financeUnavailable = expensesUnavailable || (!allSelected && financeExpenses === null);
  const newestCapture = platforms.map((platform) => platform.capturedAt).filter(Boolean).sort().at(-1);
  const funnel = [
    potentialStep(potential, analyticsState.range),
    { id: "views", label: "Показы", value: pageViews, kind: pageViews === null ? "none" : "snapshot",
      date: newestCapture, note: "переходы на карточку площадки" },
    { id: "clicks", label: "Клики", value: funnelClicks, kind: funnelClicks === null ? "none" :
      total("externalClicks") !== null && total("visits") !== null ? "mixed" :
        total("externalClicks") !== null ? "snapshot" : "live", date: newestCapture,
      note: `карточки: ${formatMetric(total("externalClicks"))} · сайт: ${formatMetric(total("visits"))}` },
    { id: "warmup", label: "Прогрев", value: warmup, kind: warmup === null ? "none" : "live",
      note: "Действия на сайте и заявки; это не подтверждённые записи или оплаты" },
    { id: "deal", label: "Сделка", value: sales, kind: sales === null ? "none" : "live",
      note: `выручка: ${financeRevenue === null || financeRevenue === undefined
        ? "—" : formatMoney(financeRevenue)} · повторные: нет данных` }
  ];
  const numeric = funnel.map((step) => step.value).filter((value) => value !== null);
  const maximum = Math.max(...numeric, 1);
  const funnelRows = funnel.map((step, index) => {
    const previousStep = funnel[index - 1];
    const previous = previousStep?.value;
    // Переход из ступени с noConversionFrom (потенциал → показы) процентом не выражается.
    const conversion = previousStep?.noConversionFrom ? `— (${previousStep.noConversionFrom})`
      : step.value !== null && previous > 0
        ? `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(step.value / previous * 100)}%` : "—";
    const width = step.value === null ? 28 : Math.max(28, step.value / maximum * 100);
    const details = platforms.map((platform) => {
      const key = { views: "pageViews", clicks: "funnelClicks", warmup: "clicks", deal: "sales" }[step.id];
      let value = key ? platform[key] : null;
      if (step.id === "warmup") value = optionalSum([platform.clicks, platform.leads]);
      if (step.id === "potential") {
        if (platform.platform.id !== "2gis" || !step.breakdown) return `<div><dt>${escapeHTML(platform.platform.label)}</dt><dd>—</dd></div>`;
        return `<div><dt>2ГИС: целевые рубрики</dt><dd>${formatMetric(step.breakdown.target)}</dd></div>
          <div><dt>2ГИС: нецелевые</dt><dd>${formatMetric(step.breakdown.nonTarget)}</dd></div>
          <div><dt>2ГИС: не назначено</dt><dd>${formatMetric(step.breakdown.unclassified)}</dd></div>
          <div><dt>2ГИС: все рубрики</dt><dd>${formatMetric(step.breakdown.all)}</dd></div>`;
      }
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
  byId("analytics-content").innerHTML = renderAnalyticsGuide() + `<section class="analytics-section"><h2>Воронка</h2>
    <p class="crm-note">Здесь показаны зарегистрированные события сайта и статусы CRM. Счётчики CRM и визиты Метрики имеют разные определения.
    «Прогрев» не подтверждает запись YCLIENTS, а «Сделка» и нулевая выручка CRM не подтверждают наличие или отсутствие оплат.
    Проверенные записи, посещения и деньги смотрите отдельно в блоке «Записи и оплаты из источников».</p>
    <div class="analytics-funnel">${funnelRows}</div><div class="analytics-finance">
    <div class="crm-stat"><span>Расходы</span><strong>${financeUnavailable
      ? "по компании не ведутся" : financeExpenses === null ? "—" : formatMoney(financeExpenses)}</strong></div>
    <div class="crm-stat"><span>Выручка</span><strong>${financeRevenue === null || financeRevenue === undefined
      ? "—" : formatMoney(financeRevenue)}</strong></div>
    <div class="crm-stat"><span>ROMI</span><strong>${financeUnavailable
      ? "по компании не ведутся" : formatROMI(financeRomi)}</strong></div></div></section>
    <section class="analytics-section"><h2>Площадки</h2><div class="crm-table-wrap">
    <table class="crm-table analytics-source-table"><thead><tr><th>Площадка</th><th>Показы</th><th>Клики</th>
    <th>Действия на сайте</th><th>Заявки</th><th>Продажи</th><th>Выручка</th><th>Расходы</th><th>ROMI</th>
    <th>Данные</th></tr></thead><tbody>${tableRows}</tbody></table></div></section>
    ${renderCompanyMetricsSection(companyMetrics, owner)}${renderRevenueSection(revenueData)}`;
  byId('analytics-content').querySelector('[data-revenue-collect]')?.addEventListener('click',async(event)=>{
    const button=event.currentTarget,out=button.parentElement.querySelector('[data-revenue-result]');button.disabled=true;
    out.textContent='Сервер сверяет источники…';
    try {
      const results=[];
      for(const provider of ['metrika','yclients']) {
        if(!sameScope(owner))return;
        results.push(await crmQuery('/revenue-analytics/collect',{companyCode:owner.companyCode,provider},csrfOptions('POST',provider==='metrika'?{from:owner.from,to:owner.to}:{})));
      }
      if(!sameScope(owner))return;
      if(results.some(r=>!r.collected)){out.textContent='Обновление не завершено. Сохранены предыдущие данные.';return;}
      await loadAnalytics();
    } catch {if(sameScope(owner))out.textContent='Источник не подключён или не ответил. Предыдущие данные сохранены.';}
    finally{button.disabled=false;}
  });
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
  byId("expenses-section").querySelector("h2").hidden = false;
  byId("expense-form").hidden = expensesUnavailable || !identity.permissions.includes("crm.edit");
  byId("expense-result").hidden = expensesUnavailable;
  if (expensesUnavailable) {
    byId("expenses-content").innerHTML =
      '<p class="notice">Расходы по выбранному проекту не ведутся.</p>';
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
// Каждая загрузка получает монотонный номер и снимок компании/периода. Ответ (успешный или ошибочный)
// применяется, только если он всё ещё последний и относится к текущим компании и периоду: старый ответ
// той же компании за другой период или после переключения A→B→A не перезапишет новый.
let analyticsRequestId = 0;
const sameScope = (owner) => owner && owner.companyCode === scopeParams().companyCode &&
  owner.from === analyticsState.range.from && owner.to === analyticsState.range.to;
const loadAnalytics = async () => {
  if (ctx.currentView !== "analytics-through" || !identity.permissions.includes("analytics.view")) return;
  const requestId = ++analyticsRequestId;
  analyticsState.payload = null;
  byId("analytics-content").innerHTML = '<div class="crm-empty">Загрузка аналитики…</div>';
  const range = { ...analyticsState.range };
  let owner;
  try {
    owner = { ...scopeParams(), ...range };
  } catch (error) {
    byId("analytics-content").innerHTML = `<div class="crm-error" role="alert">${escapeHTML(error.message)}</div>`;
    return;
  }
  const current = () => requestId === analyticsRequestId && sameScope(owner);
  const scope = { companyCode: owner.companyCode };
  try {
    const [dashboard, summary, expensePayload, potential, companyMetrics, revenueData] = await Promise.all([
      crmQuery("/dashboard", { period: analyticsState.period, ...range, ...scope }),
      crmQuery("/summary", { ...range, ...scope }),
      crmQuery("/expenses", { ...range, ...scope }),
      // Снимок 2ГИС не должен ломать всю аналитику: ошибка запроса показывается только в ступени «Потенциал».
      crmQuery("/platform-demand/potential", { ...range, ...scope })
        .then((result) => result?.company?.code === scope.companyCode &&
          result?.requested?.from === range.from && result?.requested?.to === range.to ? result : { error: true })
        .catch(() => ({ error: true })),
      // Фактические показатели 2ГИС тоже не ломают аналитику: ошибка видна только в своём блоке.
      crmQuery("/platform-demand/company-metrics", { ...range, ...scope })
        .then((result) => String(result?.companyCode || "").toLowerCase() === String(scope.companyCode).toLowerCase() &&
          result?.period?.from === range.from && result?.period?.to === range.to ? result : { error: true })
        .catch(() => ({ error: true })),
      crmQuery('/revenue-analytics',{...range,...scope})
        .then(result=>result?.companyCode===scope.companyCode&&result?.period?.from===range.from&&result?.period?.to===range.to?result:{error:true})
        .catch(()=>({error:true}))
    ]);
    if (!current()) return;
    renderAnalytics(dashboard, summary, expensePayload.expenses || [], potential, owner, companyMetrics, revenueData);
  } catch (error) {
    if (!current()) return;
    byId("analytics-content").innerHTML =
      `<div class="crm-error" role="alert">Не удалось загрузить: ${escapeHTML(error.message)}</div>`;
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
    // Перерисовка из кеша только если кеш принадлежит текущим компании и периоду; иначе ждём загрузку.
    if (analyticsState.payload && sameScope(analyticsState.payload.owner)) {
      renderAnalytics(
        analyticsState.payload.dashboard,
        analyticsState.payload.summary,
        analyticsState.payload.expenses,
        analyticsState.payload.potential,
        analyticsState.payload.owner,
        analyticsState.payload.companyMetrics,
        analyticsState.payload.revenueData
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
      await crmQuery("/expenses", scopeParams(), csrfOptions("POST", {
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

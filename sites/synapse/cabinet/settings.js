(() => {
"use strict";
const cabinet = window.SbCabinet = window.SbCabinet || {};
let initialized = false;
let emailInitialized = false;

const SOURCES = [
  ["subscription", "Подписка"],
  ["claude_api", "Claude API"],
  ["gpt_api", "GPT API"]
];

const initialize = async (context) => {
  if (initialized || context.identity.role !== "owner") return;
  initialized = true;
  const block = context.byId("settings-hugh");
  const form = context.byId("hugh-settings-form");
  const status = context.byId("hugh-settings-status");
  block.hidden = false;
  for (const select of form.querySelectorAll("select")) {
    for (const [value, label] of SOURCES) select.add(new Option(label, value));
  }
  const setBusy = (busy) => {
    form.querySelectorAll("select, button").forEach((control) => { control.disabled = busy; });
  };
  const load = async () => {
    setBusy(true);
    status.textContent = "Загрузка…";
    try {
      const result = await context.apiJson("/content/admin/hugh-settings");
      for (const [role, source] of Object.entries(result.settings)) form.elements[role].value = source;
      status.textContent = "";
    } catch (error) {
      status.textContent = "Не удалось загрузить: " + error.message;
    } finally {
      setBusy(false);
    }
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const settings = Object.fromEntries(new FormData(form));
    setBusy(true);
    status.textContent = "Сохранение…";
    try {
      await context.apiJson("/content/admin/hugh-settings", {
        method: "PUT",
        headers: { "X-CSRF-Token": context.identity.csrfToken },
        body: JSON.stringify({ settings })
      });
      status.textContent = "Настройки сохранены";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      setBusy(false);
    }
  });
  await load();
};

const EMAIL_FIELDS = [
  ["host", "адрес почтового сервера"], ["port", "порт почтового сервера"],
  ["user", "логин отправителя"], ["password", "пароль приложения"], ["from", "адрес отправителя"]
];
const EMAIL_ERRORS = {
  SMTP_NOT_CONFIGURED: "Настройки отправителя не заполнены",
  EMAIL_RECIPIENT_MISSING: "Получатель не задан",
  EMAIL_RECIPIENT_REJECTED: "Почтовый сервер отклонил получателя",
  SMTP_AUTH: "Не удалось войти в почтовый ящик",
  SMTP_CONNECTION: "Не удалось подключиться к почтовому серверу",
  SMTP_SENDER: "Почтовый сервер отклонил отправителя",
  SMTP_RECIPIENT: "Почтовый сервер отклонил получателя",
  SMTP_ENVELOPE: "Почтовый сервер не принял параметры отправки",
  SMTP_SEND_FAILED: "Письмо не удалось отправить"
};
const emailNode = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const emailCount = (value) => Number.isSafeInteger(value) && value >= 0 ? String(value) : "—";
const renderEmailStatus = (container, result) => {
  const nodes = [];
  const smtp = result.smtp || {};
  const missing = EMAIL_FIELDS.filter(([key]) => smtp[key] !== true).map(([, label]) => label);
  nodes.push(emailNode("h3", smtp.configured === true && !missing.length
    ? "Настройки отправителя заполнены" : "Отправитель не настроен"));
  if (missing.length) nodes.push(emailNode("p", "Не хватает: " + missing.join(", ") + "."));
  const companies = emailNode("div", undefined, "email-status-companies");
  for (const [code, label] of [["alvi", "АЛВИ"], ["avokado", "Авокадо"]]) {
    const company = (Array.isArray(result.companies) ? result.companies : []).find((item) => item?.code === code);
    const card = emailNode("section", undefined, "email-status-company");
    card.append(emailNode("h4", label));
    if (!company) {
      card.append(emailNode("p", "Сведения об отправке временно недоступны."));
      companies.append(card);
      continue;
    }
    card.append(emailNode("p", company.recipientConfigured === true ? "Получатель задан" : "Получатель не задан"));
    const counts = emailNode("dl", undefined, "email-status-counts");
    for (const [key, title] of [["queued", "Ожидают отправки"], ["sending", "Отправляются"], ["sent", "Приняты почтовым сервером"]]) {
      counts.append(emailNode("dt", title), emailNode("dd", emailCount(company[key])));
    }
    card.append(counts);
    const errors = (Array.isArray(company.errors) ? company.errors : []).filter((error) => error && Number.isSafeInteger(error.count) && error.count > 0);
    if (errors.length) {
      card.append(emailNode("p", "Ошибки отправки", "email-status-errors-title"));
      const list = emailNode("ul", undefined, "email-status-errors");
      for (const error of errors) {
        const message = Object.hasOwn(EMAIL_ERRORS, error.code) ? EMAIL_ERRORS[error.code] : "Не удалось отправить; причина не определена";
        list.append(emailNode("li", message + ": " + emailCount(error.count)));
      }
      card.append(list);
    } else card.append(emailNode("p", "Ошибки отправки не зарегистрированы.", "email-status-note"));
    companies.append(card);
  }
  nodes.push(companies, emailNode("p", "Доставка во «Входящие» здесь не проверяется.", "email-status-note"));
  const checkedAt = new Date(result.checkedAt);
  if (!Number.isNaN(checkedAt.getTime())) nodes.push(emailNode("p", "Проверено: " + new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short", timeStyle: "short"
  }).format(checkedAt), "email-status-note"));
  container.replaceChildren(...nodes);
};
const initializeEmail = async (context) => {
  if (emailInitialized || context.identity.role !== "owner") return;
  const block = context.byId("settings-email");
  const refresh = context.byId("email-status-refresh");
  const result = context.byId("email-status-result");
  if (!block || !refresh || !result) return;
  emailInitialized = true;
  block.hidden = false;
  refresh.type = "button";
  refresh.textContent = "Проверить настройки";
  let loading = false;
  const load = async () => {
    if (loading) return;
    loading = true;
    refresh.disabled = true;
    result.setAttribute("aria-busy", "true");
    result.textContent = "Проверяем настройки и состояние отправки…";
    try {
      const data = await context.apiJson("/content/crm/email-status");
      if (!data || typeof data !== "object" || !data.smtp) throw new Error("invalid email status");
      renderEmailStatus(result, data);
    } catch (_) {
      // Server error text may contain addresses or other private diagnostics.
      result.textContent = "Не удалось проверить настройки. Попробуйте ещё раз позже.";
    } finally {
      loading = false;
      refresh.disabled = false;
      result.setAttribute("aria-busy", "false");
    }
  };
  refresh.addEventListener("click", load);
  await load();
};

cabinet.registerView("settings", { title: "Настройки", render: (_, context) => Promise.all([
  initialize(context), initializeEmail(context)
]) });
})();

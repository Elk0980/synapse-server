(() => {
"use strict";
const cabinet = window.SbCabinet = window.SbCabinet || {};
let initialized = false;
let emailInitialized = false;
let emailSettingsInitialized = false;
let refreshEmailStatus = async () => {};

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
  for (const {code, name: label = code} of (result.companies || [])) {
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
  let pending = null;
  const load = () => {
    if (pending) return pending;
    pending = (async () => {
      refresh.disabled = true;
      result.setAttribute("aria-busy", "true");
      result.textContent = "Проверяем настройки и состояние отправки…";
      try {
        const data = await context.apiJson("/content/crm/email-status");
        if (!data || typeof data !== "object" || !data.smtp) throw new Error("invalid email status");
        renderEmailStatus(result, {...data, companies: []});
      } catch (_) {
        // Server error text may contain addresses or other private diagnostics.
        result.textContent = "Не удалось проверить настройки. Попробуйте ещё раз позже.";
      } finally {
        pending = null;
        refresh.disabled = false;
        result.setAttribute("aria-busy", "false");
      }
    })();
    return pending;
  };
  refreshEmailStatus = async () => {
    // Finish any older read before refreshing after a settings change.
    if (pending) await pending;
    await load();
  };
  refresh.addEventListener("click", load);
  await load();
};

const initializeEmailSettings = async (context) => {
  if (emailSettingsInitialized || context.identity.role !== "owner") return;
  const form = context.byId("email-settings-form");
  const provider = context.byId("email-provider");
  const user = context.byId("email-user");
  const password = context.byId("email-password");
  const save = context.byId("email-settings-save");
  const check = context.byId("email-settings-check");
  const status = context.byId("email-settings-status");
  if (![form, provider, user, password, save, check, status].every(Boolean)) return;
  emailSettingsInitialized = true;
  let saved = null;
  let busy = false;
  const fields = [provider, user, password];
  const current = () => ({ provider: provider.value, user: user.value.trim() });
  const needsPassword = () => !saved || saved.needsPassword || !saved.passwordConfigured
    || provider.value !== saved.provider || user.value.trim() !== saved.user.trim();
  const isDirty = () => !saved || Boolean(password.value) || Object.entries(current()).some(([key, value]) => value !== saved[key]);
  const setBusy = (value) => {
    busy = value;
    for (const control of [...fields, save, check]) control.disabled = value;
    form.setAttribute("aria-busy", String(value));
    status.setAttribute("aria-busy", String(value));
  };
  const applySettings = (data) => {
    if (!data || typeof data !== "object" || typeof data.passwordConfigured !== "boolean") throw new Error("invalid email settings");
    saved = {
      provider: ["yandex", "mailru", "gmail"].includes(data.provider) ? data.provider : "yandex",
      user: typeof data.user === "string" ? data.user : "",
      alviRecipient: typeof data.alviRecipient === "string" ? data.alviRecipient : "",
      avokadoRecipient: typeof data.avokadoRecipient === "string" ? data.avokadoRecipient : "",
      passwordConfigured: data.passwordConfigured,
      needsPassword: data.needsPassword === true,
      source: ["environment", "cabinet"].includes(data.source) ? data.source : "none"
    };
    for (const [control, key] of [[provider, "provider"], [user, "user"]]) control.value = saved[key];
    password.value = "";
    password.required = needsPassword();
  };
  const initialMessage = () => {
    if (saved.source === "cabinet" && saved.needsPassword) return "Не удалось восстановить сохранённые настройки. Введите адреса и пароль приложения заново.";
    const source = saved.source === "environment" ? "Загружены настройки сервера."
      : saved.source === "cabinet" ? "Загружены настройки, сохранённые в кабинете." : "Почта ещё не настроена.";
    return source + (saved.passwordConfigured && !saved.needsPassword
      ? " Пароль приложения уже задан; для сохранения оставьте его поле пустым."
      : " Введите пароль приложения для отправителя.");
  };
  const mutationOptions = (method, body) => ({ method,
    headers: { "X-CSRF-Token": context.identity.csrfToken },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  for (const field of fields) field.addEventListener("input", () => {
    if (busy) return;
    password.required = needsPassword();
    status.textContent = isDirty()
      ? "Изменения ещё не сохранены. Проверка подключения использует последние сохранённые настройки."
      : initialMessage();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !saved) return;
    password.required = needsPassword();
    if (password.required && !password.value) {
      status.textContent = "Введите пароль приложения. При смене почтового сервиса или отправителя нужен новый пароль.";
      password.focus();
      return;
    }
    if (!form.reportValidity()) return;
    const payload = current();
    if (password.value) payload.password = password.value;
    const options = mutationOptions("PUT", payload);
    // Keep the password only in the request, never in the form after submission.
    password.value = "";
    delete payload.password;
    setBusy(true);
    status.textContent = "Сохраняем настройки почты…";
    try {
      await context.apiJson("/content/crm/email-settings", options);
      saved = { ...saved, ...payload, passwordConfigured: true, needsPassword: false, source: "cabinet" };
      password.required = needsPassword();
      let refreshed = true;
      try { applySettings(await context.apiJson("/content/crm/email-settings")); }
      catch (_) { refreshed = false; }
      await refreshEmailStatus();
      status.textContent = refreshed
        ? "Настройки почты сохранены. Теперь можно проверить подключение."
        : "Настройки сохранены, но обновить сведения не удалось. Обновите страницу перед проверкой подключения.";
    } catch (_) {
      status.textContent = "Не удалось сохранить настройки. Пароль очищен — при повторной попытке введите его заново, если меняли.";
    } finally {
      password.value = "";
      password.required = needsPassword();
      setBusy(false);
    }
  });
  check.addEventListener("click", async () => {
    if (busy || !saved) return;
    setBusy(true);
    status.textContent = "Проверяем подключение по сохранённым настройкам…";
    try {
      const result = await context.apiJson("/content/crm/email-settings/check", mutationOptions("POST"));
      status.textContent = result?.ok === true
        ? "Подключение по сохранённым настройкам подтверждено. Эта проверка не отправляет письма."
        : (Object.hasOwn(EMAIL_ERRORS, result?.code) ? EMAIL_ERRORS[result.code] : "Не удалось подтвердить подключение")
          + ". Проверены сохранённые настройки. Эта проверка не отправляет письма.";
    } catch (_) {
      status.textContent = "Не удалось выполнить проверку подключения. Попробуйте позже. Эта проверка не отправляет письма.";
    } finally {
      if (isDirty()) status.textContent += " Изменения в форме ещё не сохранены.";
      setBusy(false);
    }
  });
  check.type = "button";
  check.textContent = "Проверить подключение";
  setBusy(true);
  status.textContent = "Загружаем настройки почты…";
  try {
    applySettings(await context.apiJson("/content/crm/email-settings"));
    status.textContent = initialMessage();
  } catch (_) {
    status.textContent = "Не удалось загрузить настройки почты. Обновите страницу и попробуйте ещё раз.";
  } finally {
    setBusy(false);
    if (!saved) for (const control of [...fields, save, check]) control.disabled = true;
  }
};

cabinet.registerView("system-settings", { title: "Настройки системы", render: (_, context) => Promise.all([
  initialize(context), initializeEmail(context), initializeEmailSettings(context)
]) });
let companyVersion=0;
cabinet.registerView('settings', {title:'Настройки компании', async render(container,context) {
  const version=++companyVersion, code=context.selectedProjectId;
  const name=context.identity.companies?.find(c=>c.id===code)?.name||code;
  const h=context.escapeHTML;
  container.innerHTML=`<div class="content-header"><h1>Настройки компании</h1></div><div class="card"><h2>${h(name)}</h2><p>Контакты, ссылки и сведения принадлежат только этой компании.</p><a href="#company-information">Информация и площадки компании →</a></div>`;
  if(context.identity.role!=='owner')return;
  const card=document.createElement('section');card.className='card settings-email';
  card.innerHTML='<h2>Получатель заявок</h2><p>На этот адрес приходят уведомления только выбранной компании. Пустое поле отключает её уведомления.</p><form class="field-stack"><label>Почта компании<input name="recipient" type="email" maxlength="254" autocomplete="off"></label><button type="submit" disabled>Сохранить получателя</button><p role="status">Загрузка…</p></form><div data-company-email-status></div><p><a href="#system-settings">Общий отправитель — настройки системы →</a></p>';
  container.append(card);
  const form=card.querySelector('form'), status=form.querySelector('[role=status]'), button=form.querySelector('button');
  const path='/content/crm/company-email?companyCode='+encodeURIComponent(code);
  const current=()=>version===companyVersion&&context.selectedProjectId===code&&card.isConnected;
  const apply=data=>{if(!current())return;form.elements.recipient.value=data.recipient||'';renderEmailStatus(card.querySelector('[data-company-email-status]'),{...data.status,companies:(data.status?.companies||[]).map(c=>({...c,name}))});};
  form.onsubmit=async event=>{event.preventDefault();if(!current()||button.disabled)return;button.disabled=true;status.textContent='Сохранение…';try{const data=await context.apiJson(path,{method:'PUT',headers:{'X-CSRF-Token':context.identity.csrfToken},body:JSON.stringify({recipient:form.elements.recipient.value.trim()})});if(!current())return;apply(data);status.textContent='Получатель сохранён для '+name+'.';}catch(error){if(current())status.textContent='Не удалось сохранить получателя.';}finally{if(current())button.disabled=false;}};
  try{const data=await context.apiJson(path);if(!current())return;apply(data);button.disabled=false;status.textContent=data.senderConfigured?'Общий отправитель подключён.':'Общий отправитель пока не подключён.';}catch(error){if(current())status.textContent='Не удалось загрузить настройки компании.';}
}});
})();

(() => {
"use strict";
const cabinet = window.SbCabinet = window.SbCabinet || {};
const STATUS = {draft: "Черновик", running: "Отправляется", paused: "Приостановлена", completed: "Завершена"};
const CONSENT = {unknown: "Согласие неизвестно", subscribed: "Подписан", unsubscribed: "Отписан"};
const COUNT_LABELS = {pending: "Ожидают отправки", sending: "Отправляются", sent: "Приняты почтовым сервером", failed: "Ошибки", skipped: "Пропущены"};
const EXCLUSIONS = {unknown: "Согласие неизвестно", unsubscribed: "Отписались", invalid: "Некорректные адреса", duplicate: "Повторные адреса"};
const ERRORS = {
  SMTP_NOT_CONFIGURED: "Настройки отправителя не заполнены или изменились. Проверьте почту перед продолжением.",
  SMTP_AUTH: "Не удалось войти в почтовый ящик. Проверьте адрес отправителя и пароль приложения.",
  SMTP_SENDER: "Почтовый сервер отклонил отправителя. Проверьте настройки почты.",
  SMTP_CONNECTION: "Не удалось подключиться к почтовому серверу. Проверьте подключение и повторите позже.",
  SMTP_RECIPIENT: "Почтовый сервер отклонил получателя.",
  EMAIL_RECIPIENT_REJECTED: "Почтовый сервер отклонил получателя.",
  EMAIL_RECIPIENT_MISSING: "Адрес получателя не задан.",
  SMTP_ENVELOPE: "Почтовый сервер не принял параметры письма.",
  SMTP_SEND_FAILED: "Письмо не удалось отправить. Проверьте подключение и статусы."
};
const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[character]));
const count = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : "—";
const localDate = value => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
let controller;

function createController(container, context) {
  let ctx = context, companyCode = "", campaign = null, campaigns = [], subscriptions = [], preview = null;
  let busy = false, epoch = 0;
  const drafts = new Map();
  const companies = (Array.isArray(ctx.identity.companies) ? ctx.identity.companies : [])
    .map(item => ({code: String(item.id || ""), name: String(item.name || item.id || "")})).filter(item => item.code);
  container.classList.add("campaigns-view");
  container.innerHTML = `
    <div class="campaigns-heading"><div><h2>Рассылки</h2><p>Письма клиентам с подтверждённым согласием. Уведомления о заявках настраиваются отдельно.</p></div>
      <a href="#settings">Настройки почты</a></div>
    <div class="campaigns-toolbar"><label for="campaign-company">Компания</label><select id="campaign-company">${companies.map(item => `<option value="${escape(item.code)}">${escape(item.name)}</option>`).join("")}</select>
      <button class="plain-button" type="button" id="campaign-refresh">Обновить статусы</button></div>
    <p id="campaign-status" role="status" aria-live="polite"></p>
    <div class="campaigns-grid">
      <section class="card campaigns-compose" aria-labelledby="campaign-draft-title">
        <h3 id="campaign-draft-title">Текст рассылки</h3>
        <label for="campaign-select">Сохранённая рассылка</label><select id="campaign-select"><option value="">Новый черновик</option></select>
        <p id="campaign-state"></p><p id="campaign-reason" role="status" hidden></p><dl id="campaign-counts" class="campaigns-counts"></dl>
        <form id="campaign-form">
          <label for="campaign-name">Название в кабинете</label><input id="campaign-name" name="name" required maxlength="120" autocomplete="off">
          <label for="campaign-subject">Тема письма</label><input id="campaign-subject" name="subject" required maxlength="180" autocomplete="off">
          <label for="campaign-text">Текст письма</label><textarea id="campaign-text" name="text" required maxlength="20000" rows="10"></textarea>
          <p class="campaigns-note">Обычный текст. Ссылка для отписки добавляется при отправке.</p>
          <button class="plain-button" type="submit" id="campaign-save">Сохранить черновик</button>
        </form>
        <div class="campaigns-actions"><button class="plain-button" type="button" id="campaign-preview">Проверить перед отправкой</button>
          <button class="plain-button" type="button" id="campaign-pause" hidden>Приостановить</button></div>
        <p class="campaigns-note">Приостановка останавливает очередь. Уже переданное почтовому серверу письмо отозвать нельзя.</p>
      </section>
      <section class="card campaigns-review" aria-labelledby="campaign-review-title">
        <h3 id="campaign-review-title">Проверка перед запуском</h3>
        <div id="campaign-review"><p>Сохраните черновик и проверьте текст и получателей. Эта проверка не отправляет письма.</p></div>
        <label class="campaigns-confirm" for="campaign-confirm"><input id="campaign-confirm" type="checkbox">Проверил текст и получателей этой рассылки</label>
        <button class="plain-button" type="button" id="campaign-launch" disabled>Запустить рассылку</button>
      </section>
    </div>
    <section class="card campaigns-subscriptions" aria-labelledby="campaign-subscriptions-title">
      <h3 id="campaign-subscriptions-title">Подписки на email</h3>
      <p>Наличие адреса в CRM не означает согласия на рассылку. Заполняйте источник и дату только по фактическому согласию клиента.</p>
      <form id="subscription-form" class="campaigns-subscription-form">
        <label>Email<input id="subscription-email" name="email" type="email" required maxlength="254" autocomplete="off"></label>
        <label>Имя<input id="subscription-name" name="name" maxlength="120" autocomplete="off"></label>
        <label>Статус<select id="subscription-state" name="status">${Object.entries(CONSENT).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>
        <label>Источник согласия или основание статуса<input id="subscription-source" name="source" required maxlength="500" placeholder="Например, форма согласия или просьба отписать" autocomplete="off"></label>
        <label>Фактическая дата согласия<input id="subscription-date" name="consentedAt" type="datetime-local"></label>
        <div class="campaigns-actions"><button class="plain-button" type="submit" id="subscription-save">Сохранить подписку</button>
          <button class="plain-button" type="button" id="subscription-clear">Очистить форму</button></div>
      </form>
      <div id="campaign-subscriptions"></div>
    </section>`;
  const byId = id => container.querySelector("#" + id);
  const form = byId("campaign-form"), subscriptionForm = byId("subscription-form");
  const fields = ["name", "subject", "text"];
  const value = () => Object.fromEntries(fields.map(key => [key, byId("campaign-" + key).value]));
  const draftKey = () => companyCode + ":" + (campaign?.id || "new");
  const stash = () => {if (companyCode && (!campaign || campaign.status === "draft")) drafts.set(draftKey(), value());};
  const dirty = () => !campaign || fields.some(key => value()[key] !== String(campaign[key] || ""));
  const message = text => {byId("campaign-status").textContent = text;};
  const endpoint = (path) => "/content/crm" + path + "?companyCode=" + encodeURIComponent(companyCode);
  const request = (path, method, body) => ctx.apiJson(endpoint(path), method ? ctx.csrfOptions(method, body) : undefined);
  const eligible = () => ["draft", "paused"].includes(campaign?.status)
    && typeof preview?.previewToken === "string" && preview.previewToken.length > 0
    && preview?.canLaunch === true && preview?.sender?.configured === true
    && Number.isSafeInteger(preview?.counts?.eligible) && preview.counts.eligible > 0;
  const updateControls = () => {
    container.setAttribute("aria-busy", String(busy));
    container.querySelectorAll("input, textarea, select, button").forEach(node => {node.disabled = busy || !companyCode;});
    byId("campaign-company").disabled = busy || !companies.length;
    const editable = !campaign || campaign.status === "draft";
    fields.forEach(key => {byId("campaign-" + key).disabled = busy || !companyCode || !editable;});
    byId("campaign-save").disabled = busy || !companyCode || !editable;
    byId("campaign-preview").disabled = busy || !campaign || dirty();
    byId("campaign-confirm").disabled = busy || !eligible() || dirty();
    byId("campaign-launch").disabled = busy || !eligible() || dirty() || !byId("campaign-confirm").checked;
    byId("campaign-launch").textContent = campaign?.status === "paused" ? "Продолжить рассылку" : "Запустить рассылку";
    byId("campaign-pause").hidden = campaign?.status !== "running";
    byId("campaign-pause").disabled = busy || campaign?.status !== "running";
    const subscribed = byId("subscription-state").value === "subscribed";
    byId("subscription-source").required = true;
    byId("subscription-date").required = subscribed;
  };
  const invalidatePreview = () => {
    preview = null;
    byId("campaign-confirm").checked = false;
    byId("campaign-review").innerHTML = "<p>Проверка не выполнена или устарела. Сохраните изменения и проверьте рассылку заново.</p>";
    updateControls();
  };
  const renderCounts = () => {
    byId("campaign-state").textContent = campaign ? STATUS[campaign.status] || "Статус неизвестен" : "Новый черновик";
    const reason = byId("campaign-reason"), code = campaign?.lastErrorCode;
    reason.hidden = !code;
    reason.innerHTML = code ? escape(Object.hasOwn(ERRORS, code) ? ERRORS[code] : "Произошла ошибка отправки. Проверьте настройки почты и обновите статусы.")
      + ' <a href="#settings">Открыть настройки почты</a>' : "";
    byId("campaign-counts").innerHTML = campaign ? Object.entries(COUNT_LABELS).map(([key, label]) => `<dt>${label}</dt><dd>${count(campaign.counts?.[key])}</dd>`).join("") : "";
  };
  const renderCampaign = () => {
    const data = drafts.get(draftKey()) || campaign || {};
    fields.forEach(key => {byId("campaign-" + key).value = String(data[key] || "");});
    renderCounts();
    invalidatePreview();
  };
  const renderList = () => {
    byId("campaign-select").innerHTML = '<option value="">Новый черновик</option>' + campaigns.map(item => `<option value="${escape(item.id)}">${escape(item.name || item.subject)} — ${escape(STATUS[item.status] || "Статус неизвестен")}</option>`).join("");
    byId("campaign-select").value = campaign ? String(campaign.id) : "";
  };
  const renderSubscriptions = () => {
    const target = byId("campaign-subscriptions");
    if (!subscriptions.length) {target.innerHTML = "<p>Подписки ещё не добавлены. Новые адреса не получают согласие автоматически.</p>"; return;}
    target.innerHTML = `<ul class="campaigns-subscription-list">${subscriptions.map((item, index) => `<li><div><strong>${escape(item.email)}</strong>${item.name ? `<span>${escape(item.name)}</span>` : ""}<span>${escape(CONSENT[item.status] || CONSENT.unknown)}</span>${item.source ? `<span class="campaigns-note">${escape(item.source)}</span>` : ""}</div><button class="plain-button" type="button" data-subscription-index="${index}">Изменить<span class="campaigns-sr-only"> ${escape(item.email)}</span></button></li>`).join("")}</ul>`;
  };
  const run = async (operation, pending, failure) => {
    if (busy || !companyCode) return;
    const version = epoch;
    busy = true; updateControls(); message(pending);
    try {await operation(() => version === epoch);}
    catch (_) {if (version === epoch) {renderList(); message(failure);}}
    finally {if (version === epoch) {busy = false; updateControls();}}
  };
  const loadCompany = async code => {
    stash(); companyCode = code; campaign = null; campaigns = []; subscriptions = [];
    const version = ++epoch;
    busy = true; byId("campaign-company").value = code;
    subscriptionForm.reset(); renderList(); renderCampaign(); renderSubscriptions(); updateControls();
    if (!companyCode) {busy = false; updateControls(); message("Нет доступных компаний."); return;}
    message("Загружаем рассылки и подписки…");
    try {
      const result = await Promise.all([request("/email-campaigns"), request("/email-subscriptions")]);
      if (version !== epoch) return;
      campaigns = Array.isArray(result[0].campaigns) ? result[0].campaigns : [];
      subscriptions = Array.isArray(result[1].subscriptions) ? result[1].subscriptions : [];
      renderList(); renderSubscriptions(); message("");
    } catch (_) {if (version === epoch) message("Не удалось загрузить рассылки. Нажмите «Обновить статусы».");}
    finally {if (version === epoch) {busy = false; updateControls();}}
  };
  byId("campaign-company").addEventListener("change", () => {void loadCompany(byId("campaign-company").value);});
  byId("campaign-select").addEventListener("change", () => {
    stash(); const id = byId("campaign-select").value;
    invalidatePreview();
    if (!id) {campaign = null; renderCampaign(); message(""); return;}
    void run(async current => {
      const result = await request("/email-campaigns/" + encodeURIComponent(id));
      if (!current()) return;
      campaign = result; renderCampaign(); message("");
    }, "Загружаем рассылку…", "Не удалось загрузить рассылку. Выберите её ещё раз.");
  });
  form.addEventListener("input", () => {stash(); invalidatePreview();});
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (busy || (campaign && campaign.status !== "draft") || !form.reportValidity()) return;
    const data = value();
    if (fields.some(key => !data[key].trim())) {message("Заполните название, тему и текст письма."); return;}
    void run(async current => {
      const key = draftKey();
      const result = await request("/email-campaigns" + (campaign ? "/" + encodeURIComponent(campaign.id) : ""), campaign ? "PATCH" : "POST", {...data, ...(!campaign ? {companyCode} : {})});
      if (!current()) return;
      drafts.delete(key); campaign = result; drafts.delete(draftKey());
      campaigns = [result, ...campaigns.filter(item => item.id !== result.id)];
      renderList(); renderCampaign(); message("Черновик сохранён. Проверьте текст и получателей перед запуском.");
    }, "Сохраняем черновик…", "Не удалось сохранить черновик. Введённый текст сохранён в форме; попробуйте ещё раз.");
  });
  byId("campaign-refresh").addEventListener("click", () => {
    invalidatePreview();
    void run(async current => {
      const result = await Promise.all([request("/email-campaigns"), request("/email-subscriptions")]);
      if (!current()) return;
      campaigns = Array.isArray(result[0].campaigns) ? result[0].campaigns : [];
      subscriptions = Array.isArray(result[1].subscriptions) ? result[1].subscriptions : [];
      if (campaign) campaign = campaigns.find(item => item.id === campaign.id) || campaign;
      renderList(); renderCounts(); renderSubscriptions(); message("Статусы обновлены. «Приняты почтовым сервером» не подтверждает попадание во «Входящие».");
    }, "Обновляем статусы…", "Не удалось обновить статусы. Показаны последние полученные сведения.");
  });
  byId("campaign-preview").addEventListener("click", () => {
    if (!campaign || dirty()) return;
    invalidatePreview();
    void run(async current => {
      const result = await request("/email-campaigns/" + encodeURIComponent(campaign.id) + "/preview");
      if (!current()) return;
      if (String(result.campaign?.id) !== String(campaign.id) || result.campaign?.companyCode !== companyCode) throw new Error("Preview mismatch");
      preview = result; campaign = result.campaign;
      byId("campaign-review").innerHTML = `<p>${result.sender?.configured === true ? "Настройки отправителя заполнены" : "Отправитель не настроен. Заполните настройки почты."}</p>
        ${result.sender?.address ? `<p>Отправитель: ${escape(result.sender.address)}</p>` : ""}
        <h4>${escape(campaign.subject)}</h4><pre class="campaigns-message">${escape(campaign.text)}</pre>
        <dl class="campaigns-counts"><dt>Могут получить письмо</dt><dd>${count(result.counts?.eligible)}</dd>${Object.entries(EXCLUSIONS).map(([key, title]) => `<dt>Исключены: ${title.toLowerCase()}</dt><dd>${count(result.counts?.[key])}</dd>`).join("")}</dl>
        ${!eligible() ? '<p class="campaigns-note">Запуск недоступен: проверьте отправителя, статус рассылки и наличие получателей с согласием.</p>' : ""}
        <details><summary>Показать получателей (до 200)</summary><ul class="campaigns-recipient-list">${(Array.isArray(result.recipients) ? result.recipients : []).slice(0, 200).map(item => `<li>${escape(item.email)}${item.name ? " — " + escape(item.name) : ""} (${escape(CONSENT[item.status] || item.status || "")})</li>`).join("")}</ul></details>`;
      renderCounts(); message("Проверка готова. Письма этой проверкой не отправляются. Для запуска подтвердите проверку ниже.");
    }, "Проверяем сохранённый текст и получателей…", "Не удалось проверить рассылку. Запуск заблокирован; попробуйте ещё раз.");
  });
  byId("campaign-confirm").addEventListener("change", updateControls);
  byId("campaign-launch").addEventListener("click", () => {
    if (!campaign || !eligible() || dirty() || !byId("campaign-confirm").checked) return;
    const token = preview.previewToken;
    void run(async current => {
      invalidatePreview();
      const result = await request("/email-campaigns/" + encodeURIComponent(campaign.id) + "/launch", "POST", {confirm: true, previewToken: token});
      if (!current()) return;
      campaign = result; invalidatePreview(); renderCounts();
      message("Рассылка запущена. Обновляйте статусы, чтобы следить за очередью.");
    }, "Запускаем проверенную рассылку…", "Не удалось подтвердить запуск. Обновите статусы перед повторной попыткой.");
  });
  byId("campaign-pause").addEventListener("click", () => {
    if (!campaign || campaign.status !== "running") return;
    void run(async current => {
      const result = await request("/email-campaigns/" + encodeURIComponent(campaign.id) + "/pause", "POST", {});
      if (!current()) return;
      campaign = result; invalidatePreview(); renderCounts(); message("Рассылка приостановлена. Письма, уже переданные серверу, могут быть доставлены.");
    }, "Приостанавливаем очередь…", "Не удалось подтвердить приостановку. Обновите статусы.");
  });
  subscriptionForm.addEventListener("input", updateControls);
  byId("subscription-state").addEventListener("change", updateControls);
  byId("subscription-clear").addEventListener("click", () => {subscriptionForm.reset(); updateControls();});
  byId("campaign-subscriptions").addEventListener("click", event => {
    const button = event.target.closest("[data-subscription-index]");
    if (!button || busy) return;
    const item = subscriptions[Number(button.dataset.subscriptionIndex)];
    if (!item) return;
    for (const key of ["email", "name", "source"]) byId("subscription-" + key).value = String(item[key] || "");
    byId("subscription-state").value = Object.hasOwn(CONSENT, item.status) ? item.status : "unknown";
    byId("subscription-date").value = localDate(item.consentedAt);
    updateControls(); byId("subscription-email").focus();
  });
  subscriptionForm.addEventListener("submit", event => {
    event.preventDefault();
    if (busy || !subscriptionForm.reportValidity()) return;
    const data = Object.fromEntries(["email", "name", "source"].map(key => [key, byId("subscription-" + key).value.trim()]));
    data.status = byId("subscription-state").value;
    if (!data.source) {message("Укажите источник согласия или основание изменения статуса."); return;}
    const date = byId("subscription-date").value;
    if (data.status === "subscribed" && (!data.source || !date)) {message("Укажите фактические источник и дату согласия."); return;}
    if (date) {
      const parsed = new Date(date);
      if (Number.isNaN(parsed.getTime()) || parsed.getTime() > Date.now()) {message("Укажите действительную дату согласия, которая уже наступила."); return;}
      data.consentedAt = parsed.toISOString();
    }
    invalidatePreview();
    void run(async current => {
      await request("/email-subscriptions", "PUT", data);
      if (!current()) return;
      const result = await request("/email-subscriptions");
      if (!current()) return;
      subscriptions = Array.isArray(result.subscriptions) ? result.subscriptions : [];
      renderSubscriptions(); subscriptionForm.reset(); message("Подписка сохранена. Перед запуском повторите проверку получателей.");
    }, "Сохраняем подписку…", "Не удалось обновить сведения о подписке. Проверьте статусы перед повторным сохранением.");
  });
  const preferred = String(ctx.selectedProjectId || "");
  const ready = loadCompany(companies.some(item => item.code === preferred) ? preferred : companies[0]?.code || "");
  return {ready, updateContext(next) {ctx = next;}, changeProject(next) {
    ctx = next;
    const code = String(ctx.selectedProjectId || "");
    if (code !== companyCode && companies.some(item => item.code === code)) return loadCompany(code);
  }};
}
cabinet.registerView("campaigns", {
  title: "Рассылки",
  render(container, context) {
    if (context.identity?.role !== "owner") {if (container) container.replaceChildren(); return;}
    if (!controller) controller = createController(container, context);
    else controller.updateContext(context);
    return controller.ready;
  },
  onProjectChange(context) {if (context.identity?.role === "owner") return controller?.changeProject(context);}
});
})();

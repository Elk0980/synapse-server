(() => {
"use strict";

const SbCabinet = window.SbCabinet = window.SbCabinet || {};
let ctx;
let identity, byId, escapeHTML, crmQuery, csrfOptions, scopeParams, formatMoney;
let initialized = false;
const api = {};
const init = (context) => {
  ctx = context;
  ({ identity, byId, escapeHTML, crmQuery, csrfOptions, scopeParams, formatMoney } = context);
  if (initialized) return;
  initialized = true;

  const CRM_STAGES = Object.freeze([
    { id: "new", label: "Новая" },
    { id: "in_progress", label: "В работе" },
    { id: "booked", label: "Записан" },
    { id: "visited", label: "Пришёл" },
    { id: "sale", label: "Продажа" },
    { id: "rejected", label: "Отказ" }
  ]);
  const crmState = { period: "today", stage: "", source: "" };
  let crmBound = false;
  const crmStageOptions = (selected) => CRM_STAGES.map((stage) =>
    `<option value="${stage.id}"${stage.id === selected ? " selected" : ""}>${stage.label}</option>`
  ).join("");
  const renderCRMData = (payload) => {
    const leads = Array.isArray(payload.leads) ? payload.leads : [];
    const summary = payload.summary || {};
    const content = byId("crm-content");
    const editable = identity.permissions.includes("crm.edit");
    content.innerHTML = `
      <div class="crm-summary">
        <div class="crm-stat"><span>Заявки</span><strong>${escapeHTML(summary.total ?? leads.length)}</strong></div>
        <div class="crm-stat"><span>Продажи</span><strong>${escapeHTML(summary.sales ?? "—")}</strong></div>
        <div class="crm-stat"><span>Выручка</span><strong>${escapeHTML(formatMoney(summary.revenue))}</strong></div>
      </div>
      ${leads.length ? `<div class="crm-table-wrap"><table class="crm-table"><thead><tr><th>Дата</th>
        <th>Имя</th><th>Контакт</th><th>Канал</th><th>Источник</th><th>Этап</th><th>Сумма</th>
        </tr></thead><tbody>${leads.map((lead) => `<tr><td>${escapeHTML(lead.date ?? "—")}</td>
        <td><button class="crm-lead-button" type="button" data-crm-lead-id="${escapeHTML(lead.id)}">
        ${escapeHTML(lead.name ?? "—")}</button></td><td>${escapeHTML(lead.contact ?? "—")}</td>
        <td>${escapeHTML(lead.channel ?? "—")}</td><td>${escapeHTML(lead.source ?? "—")}</td>
        <td><select data-crm-stage-id="${escapeHTML(lead.id)}"${editable ? "" : " disabled"}>
        ${crmStageOptions(lead.stage)}</select></td><td><input type="number" min="0"
        data-crm-amount-id="${escapeHTML(lead.id)}" value="${escapeHTML(lead.amount ?? "")}"
        ${editable ? "" : "disabled"}></td></tr>`).join("")}</tbody></table></div>` :
        '<div class="crm-empty">Заявок за период нет</div>'}<div id="crm-lead-details"></div>`;
    const sources = Array.isArray(payload.sources) ? payload.sources : [];
    const options = sources.map((source) => `<option value="${escapeHTML(source)}"
      ${source === crmState.source ? "selected" : ""}>${escapeHTML(source)}</option>`).join("");
    byId("crm-source-filter").innerHTML = '<option value="">Все источники</option>' + options;
  };
  const loadCRM = async () => {
    if (ctx.currentView !== "crm") return;
    byId("crm-content").innerHTML = '<div class="crm-empty">Загрузка CRM…</div>';
    try {
      renderCRMData(await crmQuery("/dashboard", { ...crmState, ...scopeParams() }));
    } catch (error) {
      byId("crm-content").innerHTML = '<div class="crm-error" role="alert">Не удалось загрузить текущую CRM.</div>';
    }
  };
const renderCRM = () => {
  if (crmBound) return;
  crmBound = true;
  byId("crm-stage-filter").innerHTML = '<option value="">Все этапы</option>' + crmStageOptions("");
  byId("crm-source-filter").innerHTML = '<option value="">Все источники</option>';
    byId("crm-periods").addEventListener("click", (event) => {
      const button = event.target.closest("[data-crm-period]");
      if (!button) return;
      crmState.period = button.dataset.crmPeriod;
      document.querySelectorAll("[data-crm-period]").forEach((item) =>
        item.setAttribute("aria-pressed", String(item === button)));
      loadCRM();
    });
    byId("crm-stage-filter").addEventListener("change", (event) => {
      crmState.stage = event.target.value;
      loadCRM();
    });
    byId("crm-source-filter").addEventListener("change", (event) => {
      crmState.source = event.target.value;
      loadCRM();
    });
    byId("crm-content").addEventListener("change", async (event) => {
      if (!identity.permissions.includes("crm.edit")) return;
      const stageId = event.target.dataset.crmStageId;
      const amountId = event.target.dataset.crmAmountId;
      if (!stageId && !amountId) return;
      const id = stageId || amountId;
      const body = stageId ? { stage: event.target.value } : { amount: Number(event.target.value) };
      try {
        await crmQuery(`/leads/${encodeURIComponent(id)}`, {}, csrfOptions("PATCH", body));
        await loadCRM();
      } catch (error) {
        byId("crm-content").insertAdjacentHTML("afterbegin",
          '<div class="crm-error" role="alert">Не удалось сохранить изменение CRM.</div>');
      }
    });
    byId("crm-content").addEventListener("click", async (event) => {
      const button = event.target.closest("[data-crm-lead-id]");
      if (!button) return;
      const details = byId("crm-lead-details");
      details.innerHTML = '<div class="crm-empty">Загрузка карточки…</div>';
      try {
        const lead = await crmQuery(`/leads/${encodeURIComponent(button.dataset.crmLeadId)}`);
        const fields = [
          ["utmSource", lead.utmSource],
          ["utmMedium", lead.utmMedium],
          ["utmCampaign", lead.utmCampaign],
          ["utmContent", lead.utmContent],
          ["clientId", lead.clientId],
          ["referrer", lead.referrer],
          ["landingPage", lead.landingPage]
        ].filter((field) => field[1]);
        const attribution = fields.length ? `<dl>${fields.map(([label, value]) =>
          `<dt>${label}</dt><dd>${escapeHTML(value)}</dd>`).join("")}</dl>` :
          "<p>атрибуция не передана</p>";
        details.innerHTML = `<article class="card lead-details"><h2>${escapeHTML(lead.name)}</h2>
          <h3>Атрибуция</h3>${attribution}</article>`;
      } catch (error) {
        details.innerHTML = '<div class="crm-error" role="alert">Не удалось загрузить карточку заявки.</div>';
      }
    });
  };
  Object.assign(api, { renderCRM, loadCRM });
};

SbCabinet.registerView("crm", {
  title: "Лиды",
  initialize(context) {
    init(context);
    api.renderCRM();
  },
  render(container, context) {
    init(context);
    api.renderCRM();
    api.loadCRM();
  },
  onProjectChange(context) {
    init(context);
    api.loadCRM();
  },
});
})();

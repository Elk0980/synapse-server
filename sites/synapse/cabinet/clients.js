(() => {
"use strict";

const SbCabinet = window.SbCabinet = window.SbCabinet || {};
let ctx, byId, escapeHTML, crmQuery, csrfOptions, hasPermission, navigate;
let initialized = false;
const api = {};
const init = (context) => {
ctx = context;
({ byId, escapeHTML, crmQuery, csrfOptions, hasPermission, navigate } = context);
if (initialized) return;
initialized = true;

const ENTITY_STAGES = Object.freeze({
  application: "Заявка",
  call: "Созвон",
  kit_ready: "Комплект собран",
  payment: "Оплата",
  active: "Активен"
});
const CRM_ENTITIES = Object.freeze({
  "crm-contacts": {
    path: "contacts",
    key: "contacts",
    title: "Контакты",
    required: ["name"],
    columns: ["name", "position", "phone", "email", "city", "preferredChannel"],
    labels: {
      name: "Имя",
      position: "Должность",
      phone: "Телефон",
      email: "Email",
      city: "Город",
      timezone: "Часовой пояс",
      preferredChannel: "Предпочтительный канал",
      notes: "Заметки",
      birthDate: "Дата рождения"
    },
    arrays: { messengers: "Мессенджеры", links: "Ссылки" },
    relations: [
      { key: "companies", countLabel: "Компаний", view: "crm-companies", path: "companies", flag: "isResponsible",
        flagLabel: "Ответственный" },
      { key: "legalEntities", countLabel: "Юрлиц", view: "crm-legal", path: "legal-entities", flag: "isSignatory",
        flagLabel: "Подписант", signing: true }
    ],
    companyFilter: true
  },
  "crm-companies": {
    path: "companies",
    key: "companies",
    title: "Компании",
    required: ["code", "name"],
    columns: ["code", "name", "industry", "city", "pipelineStage"],
    labels: {
      code: "Код",
      name: "Название",
      industry: "Отрасль",
      city: "Город",
      timezone: "Часовой пояс",
      phone: "Телефон",
      email: "Email",
      websiteUrl: "Сайт",
      pipelineStage: "Этап",
      startDate: "Дата начала",
      endDate: "Дата окончания",
      preferredChannel: "Предпочтительный канал",
      notes: "Заметки"
    },
    arrays: { socials: "Соцсети" },
    relations: [
      { key: "contacts", countLabel: "Контактов", view: "crm-contacts", path: "contacts", flag: "isResponsible",
        flagLabel: "Ответственный", reverse: true },
      { key: "legalEntities", countLabel: "Юрлиц", view: "crm-legal", path: "legal-entities", flag: "isPrimary",
        flagLabel: "Основное" }
    ],
    stageFilter: true
  },
  "crm-legal": {
    path: "legal-entities",
    key: "legalEntities",
    title: "Юрлица",
    required: ["legalForm", "name"],
    columns: ["legalForm", "name", "inn", "registration"],
    labels: {
      legalForm: "Форма",
      name: "Название",
      shortName: "Краткое название",
      inn: "ИНН",
      kpp: "КПП",
      ogrn: "ОГРН",
      ogrnip: "ОГРНИП",
      phone: "Телефон",
      email: "Email",
      legalAddress: "Юридический адрес",
      postalAddress: "Почтовый адрес",
      taxSystem: "Система налогообложения",
      bankName: "Банк",
      bik: "БИК",
      checkingAccount: "Расчётный счёт",
      correspondentAccount: "Корреспондентский счёт",
      recipientName: "Получатель",
      notes: "Заметки"
    },
    private: ["legalAddress", "postalAddress", "taxSystem", "bankName", "bik", "checkingAccount",
      "correspondentAccount", "recipientName"],
    relations: [
      { key: "contacts", countLabel: "Контактов", view: "crm-contacts", path: "contacts", flag: "isSignatory",
        flagLabel: "Подписант", signing: true, reverse: true },
      { key: "companies", countLabel: "Компаний", view: "crm-companies", path: "companies", flag: "isPrimary",
        flagLabel: "Основное", reverse: true }
    ],
    companyFilter: true
  }
});
const entityStates = {};
const canEditCRM = () => hasPermission("crm.edit");
const entityValue = (field, value) => {
  if (field === "legalForm") return value === "ip" ? "ИП" : value === "ooo" ? "ООО" : value;
  if (field === "pipelineStage") return ENTITY_STAGES[value] || value;
  return value;
};
const entityName = (record) => record.name || record.shortName || record.code || `#${record.id}`;
const entityState = (view) => entityStates[view] ||= {
  q: "", companyId: "", pipelineStage: "", deleted: "exclude", offset: 0, records: [], companies: [],
  projectId: null
};
const fieldStorageKey = (view) => {
  return `synapse_cabinet_client_fields:${ctx.identity.userId}:${view}`;
};
const availableFields = (config) => {
  const fields = Object.keys(config.labels);
  const arrays = Object.keys(config.arrays || {});
  const relations = config.relations.map((relation) => relation.key);
  return [...fields, ...arrays, ...relations].filter((field) => {
    return !config.private?.includes(field) || canEditCRM();
  });
};
const selectedFields = (view) => {
  const config = CRM_ENTITIES[view];
  const available = availableFields(config);
  const defaults = config.columns.flatMap((field) => {
    return field === "registration" ? ["ogrn", "ogrnip"] : [field];
  });
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem(fieldStorageKey(view)));
  } catch (error) {
    stored = null;
  }
  const selected = Array.isArray(stored) ? stored : defaults;
  return selected.filter((field) => available.includes(field));
};
const fieldLabel = (config, field) => {
  const relation = config.relations.find((item) => item.key === field);
  return config.labels[field] || config.arrays?.[field] || relation?.countLabel || "ОГРН / ОГРНИП";
};
const listFieldValue = (config, record, field) => {
  if (field === "registration") return record.ogrn || record.ogrnip;
  if (config.arrays?.[field]) {
    return (record[field] || []).map((item) => item.label || item.url || item.handle).filter(Boolean).join(", ");
  }
  const relation = config.relations.find((item) => item.key === field);
  if (relation) return String((record[field] || []).length);
  return entityValue(field, record[field]);
};
const entityHashParts = () => {
  const hash = decodeURIComponent(location.hash.slice(1));
  const [path, query = ""] = hash.split("?");
  return { parts: path.split("/"), params: new URLSearchParams(query) };
};
const loadEntityCompanies = async (state) => {
  if (state.companies.length) return;
  const data = await crmQuery("/companies", { limit: 200, deleted: "exclude" });
  state.companies = data.companies || [];
};
const setContactProjectFilter = (state) => {
  if (state.projectId === ctx.selectedProjectId) return;
  const company = state.companies.find((item) => item.code?.toLowerCase() === ctx.selectedProjectId);
  state.companyId = ctx.selectedProjectId === "synapse-business" ? "" : String(company?.id || "");
  state.projectId = ctx.selectedProjectId;
};
const applyContactProjectFilter = async () => {
  const state = entityState("crm-contacts");
  await loadEntityCompanies(state);
  setContactProjectFilter(state);
  const query = state.companyId ? `?companyId=${encodeURIComponent(state.companyId)}` : "";
  history.replaceState(null, "", `#crm-contacts${query}`);
  await renderEntityList("crm-contacts", true);
};
const renderCrmEntityRoute = async () => {
  const { parts: [view, route], params } = entityHashParts();
  const config = CRM_ENTITIES[view];
  if (!route && config.companyFilter) {
    const state = entityState(view);
    state.companyId = params.get("companyId") || "";
    if (view === "crm-contacts") {
      state.projectId = params.has("companyId") ? ctx.selectedProjectId : null;
    }
  }
  const content = byId(`${view}-content`);
  content.textContent = "Загрузка…";
  try {
    if (route === "new") await renderEntityForm(view, null);
    else if (route) await renderEntityCard(view, route);
    else await renderEntityList(view, true);
  } catch (error) {
    content.innerHTML = `<p class="crm-error" role="alert">${escapeHTML(error.message)}</p>`;
  }
};
const renderEntityList = async (view, reset = false) => {
  const config = CRM_ENTITIES[view];
  const state = entityState(view);
  const content = byId(`${view}-content`);
  if (reset) {
    state.offset = 0;
    state.records = [];
  }
  if (config.companyFilter) await loadEntityCompanies(state);
  if (view === "crm-contacts") setContactProjectFilter(state);
  const params = {
    q: state.q,
    companyId: state.companyId,
    pipelineStage: state.pipelineStage,
    deleted: state.deleted,
    limit: 50,
    offset: state.offset
  };
  const data = await crmQuery(`/${config.path}`, params);
  state.records.push(...(data[config.key] || []));
  const pageRecords = data[config.key] || [];
  const companyOptions = state.companies.map((company) => {
    const selected = String(company.id) === state.companyId ? " selected" : "";
    return `<option value="${escapeHTML(company.id)}"${selected}>${escapeHTML(entityName(company))}</option>`;
  }).join("");
  const stageOptions = Object.entries(ENTITY_STAGES).map(([id, label]) => {
    const selected = id === state.pipelineStage ? " selected" : "";
    return `<option value="${id}"${selected}>${label}</option>`;
  }).join("");
  const visibleFields = selectedFields(view);
  const fieldOptions = availableFields(config).map((field) => {
    const checked = visibleFields.includes(field) ? " checked" : "";
    return `<label><input type="checkbox" value="${escapeHTML(field)}" data-card-field${checked}>
      <span>${escapeHTML(fieldLabel(config, field))}</span></label>`;
  }).join("");
  const cards = state.records.map((record) => {
    const details = visibleFields.map((field) => {
      const shown = listFieldValue(config, record, field);
      return `<div class="client-card-field"><dt>${escapeHTML(fieldLabel(config, field))}</dt>
        <dd class="${shown ? "" : "crm-muted"}">${escapeHTML(shown || "—")}</dd></div>`;
    }).join("");
    const deleted = Boolean(record.deletedAt || record.isDeleted || record.deleted);
    return `<article class="client-card${deleted ? " is-deleted" : ""}" tabindex="0"
      data-entity-id="${escapeHTML(record.id)}"><header><h2>${escapeHTML(entityName(record))}
      ${deleted ? '<span class="crm-deleted-mark">удалено</span>' : ""}</h2>
      <div class="client-card-actions"><button class="plain-button" type="button" data-open>Открыть</button>
      ${listCardAction(record)}</div></header><dl>${details}</dl></article>`;
  }).join("");
  content.innerHTML = `<div class="client-list-layout"><details class="client-tools" open>
    <summary>Поля карточки и фильтры</summary><div class="client-tools-body">
    <fieldset class="client-field-picker"><legend>Поля карточки</legend>${fieldOptions}</fieldset>
    <button class="plain-button" type="button" data-fields-reset>Сбросить</button>
    <div class="crm-entity-toolbar">
    <input type="search" data-entity-search value="${escapeHTML(state.q)}" placeholder="Поиск" aria-label="Поиск">
    ${config.companyFilter ? `<select data-company-filter aria-label="Фильтр по компании">
      <option value="">Все компании</option>${companyOptions}</select>` : ""}
    ${config.stageFilter ? `<select data-stage-filter aria-label="Фильтр по этапу">
      <option value="">Все этапы</option>${stageOptions}</select>` : ""}
    <label class="crm-filter-check"><input type="checkbox" data-deleted-filter
      ${state.deleted === "include" ? "checked" : ""}>Показывать удалённые</label>
    ${canEditCRM() ? `<button class="plain-button" type="button" data-entity-add>Добавить</button>` : ""}
    </div></div></details><div class="client-list"><p class="crm-list-count">Показано ${state.records.length} из
    ${data.pagination?.total ?? pageRecords.length}</p>${cards}
    ${state.records.length ? "" : '<p class="crm-empty">пока пусто</p>'}
    ${state.records.length < (data.pagination?.total || 0)
      ? '<button class="plain-button" type="button" data-entity-more>Показать ещё</button>' : ""}
    </div></div>`;
  bindEntityList(view);
};
const bindEntityList = (view) => {
  const content = byId(`${view}-content`);
  const state = entityState(view);
  let timer;
  content.querySelectorAll("[data-card-field]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const fields = [...content.querySelectorAll("[data-card-field]:checked")].map((item) => item.value);
      localStorage.setItem(fieldStorageKey(view), JSON.stringify(fields));
      renderEntityList(view, true);
    });
  });
  content.querySelector("[data-fields-reset]").addEventListener("click", () => {
    localStorage.removeItem(fieldStorageKey(view));
    renderEntityList(view, true);
  });
  content.querySelector("[data-entity-search]").addEventListener("input", (event) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = event.target.value.trim();
      renderEntityList(view, true);
    }, 300);
  });
  content.querySelector("[data-company-filter]")?.addEventListener("change", (event) => {
    state.companyId = event.target.value;
    state.projectId = ctx.selectedProjectId;
    const query = state.companyId ? `?companyId=${encodeURIComponent(state.companyId)}` : "";
    history.replaceState(null, "", `#${view}${query}`);
    renderEntityList(view, true);
  });
  content.querySelector("[data-stage-filter]")?.addEventListener("change", (event) => {
    state.pipelineStage = event.target.value;
    renderEntityList(view, true);
  });
  content.querySelector("[data-deleted-filter]").addEventListener("change", (event) => {
    state.deleted = event.target.checked ? "include" : "exclude";
    renderEntityList(view, true);
  });
  content.querySelector("[data-entity-add]")?.addEventListener("click", () => navigateEntity(view, "new"));
  content.querySelector("[data-entity-more]")?.addEventListener("click", () => {
    state.offset += 50;
    renderEntityList(view);
  });
  content.querySelectorAll("[data-entity-id]").forEach((card) => {
    card.addEventListener("click", () => navigateEntity(view, card.dataset.entityId));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") navigateEntity(view, card.dataset.entityId);
    });
  });
  bindListActions(view);
};
const listCardAction = (record) => {
  if (!canEditCRM()) return "";
  const deleted = Boolean(record.deletedAt || record.isDeleted || record.deleted);
  return deleted ? '<button class="plain-button" type="button" data-list-restore>Восстановить</button>' :
    '<button class="danger" type="button" data-list-delete>Удалить</button>';
};
const bindListActions = (view) => {
  const config = CRM_ENTITIES[view];
  const content = byId(`${view}-content`);
  content.querySelectorAll("[data-open]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      navigateEntity(view, button.closest("[data-entity-id]").dataset.entityId);
    });
  });
  content.querySelectorAll("[data-list-delete], [data-list-restore]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const card = button.closest("[data-entity-id]");
      const record = entityState(view).records.find((item) => String(item.id) === card.dataset.entityId);
      if (button.matches("[data-list-delete]") &&
        prompt(`Введите название «${entityName(record)}» для удаления`) !== entityName(record)) return;
      const suffix = button.matches("[data-list-restore]") ? "/restore" : "";
      const method = suffix ? "POST" : "DELETE";
      await crmQuery(`/${config.path}/${record.id}${suffix}`, {}, csrfOptions(method));
      renderEntityList(view, true);
    });
  });
};
const navigateEntity = (view, route = "") => {
  location.hash = `${view}${route ? `/${encodeURIComponent(route)}` : ""}`;
};
const detailsMarkup = (config, record, fields) => fields.filter((field) => {
  return record[field] !== null && record[field] !== undefined && record[field] !== "";
}).map((field) => `<div><dt>${escapeHTML(config.labels[field])}</dt>
  <dd>${escapeHTML(entityValue(field, record[field]))}</dd></div>`).join("");
const entitySubtitle = (view, record) => {
  if (view === "crm-contacts") return record.phone || "";
  if (view === "crm-companies") return record.code || "";
  return [entityValue("legalForm", record.legalForm), record.inn].filter(Boolean).join(" · ");
};
const renderEntityCard = async (view, id) => {
  const config = CRM_ENTITIES[view];
  const record = await crmQuery(`/${config.path}/${encodeURIComponent(id)}`, { includeDeleted: true });
  const content = byId(`${view}-content`);
  const publicFields = Object.keys(config.labels).filter((field) => !config.private?.includes(field));
  const privateFields = config.private || [];
  const arrayDetails = Object.entries(config.arrays || {}).map(([field, label]) => {
    if (!record[field]?.length) return "";
    const values = record[field].map((item) => [item.type, item.label, item.url || item.handle]
      .filter(Boolean).join(" · ")).filter(Boolean).join(", ");
    return `<div><dt>${label}</dt><dd>${escapeHTML(values)}</dd></div>`;
  }).join("");
  content.innerHTML = `<a class="crm-card-back" href="#${view}" data-entity-back>← К списку</a>
    <header class="crm-card-header"><div><h2>${escapeHTML(entityName(record))}</h2>
    <p class="crm-card-subtitle">${escapeHTML(entitySubtitle(view, record))}</p></div>
    <div class="crm-actions">${cardActions(record)}</div></header>
    <p class="crm-card-status" data-card-status role="status"></p><dl class="crm-details">
    ${detailsMarkup(config, record, publicFields)}${arrayDetails}</dl>
    ${view === "crm-legal" && canEditCRM() && privateFields.some((field) => record[field])
      ? `<section class="card"><h3>Реквизиты</h3><dl class="crm-details">
        ${detailsMarkup(config, record, privateFields)}</dl></section>` : ""}
    ${view === "crm-companies" ? '<p data-company-leads>Заявки: загрузка…</p>' : ""}
    <section class="crm-relations"><h3>Связи</h3><div data-relations></div></section>`;
  content.querySelector("[data-entity-back]").addEventListener("click", (event) => {
    event.preventDefault();
    navigateEntity(view);
  });
  bindCardActions(view, record);
  renderRelations(view, record);
  if (view === "crm-companies") loadCompanyLeadCount(record);
};
const cardActions = (record) => {
  if (!canEditCRM()) return "";
  const deleted = Boolean(record.deletedAt || record.isDeleted || record.deleted);
  return deleted ? '<button class="plain-button" type="button" data-restore>Восстановить</button>' :
    '<button class="plain-button" type="button" data-edit>Изменить</button>' +
    '<button class="danger" type="button" data-delete>Удалить</button>';
};
const bindCardActions = (view, record) => {
  const config = CRM_ENTITIES[view];
  const content = byId(`${view}-content`);
  content.querySelector("[data-edit]")?.addEventListener("click", () => renderEntityForm(view, record));
  content.querySelector("[data-delete]")?.addEventListener("click", async () => {
    if (prompt(`Введите название «${entityName(record)}» для удаления`) !== entityName(record)) return;
    try {
      await crmQuery(`/${config.path}/${record.id}`, {}, csrfOptions("DELETE"));
      renderEntityCard(view, record.id);
    } catch (error) {
      content.querySelector("[data-card-status]").textContent = error.message;
    }
  });
  content.querySelector("[data-restore]")?.addEventListener("click", async () => {
    try {
      await crmQuery(`/${config.path}/${record.id}/restore`, {}, csrfOptions("POST"));
      renderEntityCard(view, record.id);
    } catch (error) {
      content.querySelector("[data-card-status]").textContent = error.message;
    }
  });
};
const loadCompanyLeadCount = async (company) => {
  const target = byId("crm-companies-content").querySelector("[data-company-leads]");
  try {
    const data = await crmQuery("/leads", { companyCode: company.code });
    const leads = Array.isArray(data) ? data : data.leads || [];
    target.textContent = `Заявки: ${data.total ?? leads.length}`;
  } catch (error) {
    target.textContent = `Заявки: ${error.message}`;
  }
};
const fieldInput = (config, field, value = "") => {
  const required = config.required.includes(field) ? " required" : "";
  const hint = field === "code" ? '<small>Как поддомен: alvi, palitra-love</small>' : "";
  if (field === "notes") {
    return `<label class="wide">${config.labels[field]}<textarea name="${field}"${required}>${
      escapeHTML(value)}</textarea></label>`;
  }
  if (field === "legalForm") {
    return `<label>${config.labels[field]} *<select name="${field}" required>
      <option value="">Выберите</option><option value="ip"${value === "ip" ? " selected" : ""}>ИП</option>
      <option value="ooo"${value === "ooo" ? " selected" : ""}>ООО</option></select></label>`;
  }
  if (field === "pipelineStage") {
    const options = Object.entries(ENTITY_STAGES).map(([id, label]) =>
      `<option value="${id}"${value === id ? " selected" : ""}>${label}</option>`).join("");
    return `<label>${config.labels[field]}<select name="${field}"><option value=""></option>
      ${options}</select></label>`;
  }
  const type = field.toLowerCase().includes("date") ? "date" : field === "email" ? "email" :
    field.toLowerCase().includes("url") ? "url" : "text";
  const pattern = field === "code" ? ' pattern="[A-Za-z0-9-]+"' : "";
  return `<label>${config.labels[field]}${required ? " *" : ""}<input type="${type}" name="${field}"
    value="${escapeHTML(value)}"${required}${pattern}>${hint}</label>`;
};
const repeatMarkup = (field, label, rows = []) => `<fieldset class="wide" data-repeat="${field}">
  <legend>${label}</legend><div data-repeat-rows>${rows.map((row) => repeatRow(row, field)).join("")}</div>
  <button type="button" data-repeat-add>Добавить строку</button></fieldset>`;
const repeatTypes = Object.entries({ telegram: "Telegram", max: "MAX", whatsapp: "WhatsApp", vk: "VK",
  phone: "Телефон", email: "Email", other: "Другое" });
const repeatRow = (row = {}, field = "") => `<div class="crm-repeat-row">${field === "links"
  ? '<input data-part="type" type="hidden" value="">'
  : `<select data-part="type" aria-label="Тип">
  <option value="">Тип</option>${repeatTypes.map(([value, label]) => `<option value="${value}"
    ${row.type === value ? "selected" : ""}>${label}</option>`).join("")}</select>`}
  <input data-part="label" placeholder="Подпись"
  value="${escapeHTML(row.label || "")}"><input data-part="value" placeholder="Handle или URL"
  value="${escapeHTML(row.handle || row.url || "")}"><button type="button" data-repeat-remove>Удалить</button></div>`;
const renderEntityForm = async (view, record) => {
  const config = CRM_ENTITIES[view];
  const content = byId(`${view}-content`);
  const fields = Object.keys(config.labels);
  const controls = fields.map((field) => fieldInput(config, field, record?.[field] ?? "")).join("");
  const repeats = Object.entries(config.arrays || {}).map(([field, label]) =>
    repeatMarkup(field, label, record?.[field] || [])).join("");
  content.innerHTML = `<button class="plain-button" type="button" data-form-cancel>← Отмена</button>
    <h2>${record ? "Изменить" : "Добавить"}</h2><form class="crm-form">${controls}${repeats}
    <div class="crm-actions wide"><button class="plain-button" type="submit">Сохранить</button></div>
    <p class="crm-error wide" role="alert" hidden></p></form>`;
  const form = content.querySelector("form");
  content.querySelector("[data-form-cancel]").addEventListener("click", () => {
    if (record) renderEntityCard(view, record.id);
    else navigateEntity(view);
  });
  content.querySelectorAll("[data-repeat]").forEach((fieldset) => {
    fieldset.addEventListener("click", (event) => {
      if (event.target.matches("[data-repeat-add]")) {
        const field = fieldset.dataset.repeat;
        fieldset.querySelector("[data-repeat-rows]").insertAdjacentHTML("beforeend", repeatRow({}, field));
      }
      if (event.target.matches("[data-repeat-remove]")) event.target.closest(".crm-repeat-row").remove();
    });
  });
  form.addEventListener("submit", (event) => saveEntityForm(event, view, record));
};
const formPayload = (form, config) => {
  const payload = {};
  Object.keys(config.labels).forEach((field) => {
    payload[field] = form.elements[field].value.trim() || null;
  });
  form.querySelectorAll("[data-repeat]").forEach((fieldset) => {
    const field = fieldset.dataset.repeat;
    payload[field] = [...fieldset.querySelectorAll(".crm-repeat-row")].map((row) => {
      const type = row.querySelector('[data-part="type"]').value.trim();
      const label = row.querySelector('[data-part="label"]').value.trim();
      const value = row.querySelector('[data-part="value"]').value.trim();
      const key = field === "links" || /^https?:/.test(value) ? "url" : "handle";
      return field === "links" ? { label, url: value } : { type, label, [key]: value };
    }).filter((row) => row.url || row.handle);
  });
  return payload;
};
const normalizeRepeat = (rows = []) => rows.map((row) => {
  const value = row.url || row.handle || "";
  const normalized = { ...(row.type ? { type: row.type } : {}), ...(row.label ? { label: row.label } : {}) };
  return { ...normalized, [row.url !== undefined || /^https?:/.test(value) ? "url" : "handle"]: value };
}).filter((row) => row.url || row.handle);
const saveEntityForm = async (event, view, record) => {
  event.preventDefault();
  const form = event.currentTarget;
  const config = CRM_ENTITIES[view];
  const error = form.querySelector("[role=alert]");
  try {
    const payload = formPayload(form, config);
    const body = record ? Object.fromEntries(Object.entries(payload).filter(([key, value]) => {
      const current = config.arrays?.[key] ? normalizeRepeat(record[key]) : record[key] ?? null;
      const next = config.arrays?.[key] ? normalizeRepeat(value) : value;
      return JSON.stringify(next) !== JSON.stringify(current);
    })) : payload;
    const path = record ? `/${config.path}/${record.id}` : `/${config.path}`;
    if (record && !Object.keys(body).length) {
      renderEntityCard(view, record.id);
      return;
    }
    const saved = await crmQuery(path, {}, csrfOptions(record ? "PATCH" : "POST", body));
    const id = saved?.id || record?.id;
    if (record) {
      await renderEntityCard(view, id);
      byId(`${view}-content`).querySelector("[data-card-status]").textContent = "Сохранено";
    } else {
      navigateEntity(view, id);
    }
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
  }
};
const relationEndpoint = (view, record, relation, targetId) => {
  const config = CRM_ENTITIES[view];
  if (relation.reverse) {
    return `/${relation.path}/${targetId}/${config.path}/${record.id}`;
  }
  return `/${config.path}/${record.id}/${relation.path}/${targetId}`;
};
const renderRelations = (view, record) => {
  const config = CRM_ENTITIES[view];
  const content = byId(`${view}-content`);
  const target = content.querySelector("[data-relations]");
  target.innerHTML = config.relations.map((relation, index) => {
    const linkedRecords = record[relation.key] || [];
    const rows = linkedRecords.slice(0, 20).map((linked) => {
      const details = linked.relation || {};
      const note = details.notes || "";
      const shownNote = note.length > 60 ? `${note.slice(0, 60)}…` : note;
      return `<tr><td class="crm-grow"><a href="#${relation.view}/${encodeURIComponent(linked.id)}"
        title="${escapeHTML(entityName(linked))}">${escapeHTML(entityName(linked))}</a></td>
        <td class="crm-compact${details.role ? "" : " crm-muted"}">${escapeHTML(details.role || "—")}</td>
        <td class="crm-compact">${details[relation.flag] ? escapeHTML(relation.flagLabel) : ""}</td>
        <td class="crm-grow${note ? "" : " crm-muted"}" title="${escapeHTML(note)}">
        ${escapeHTML(shownNote || "—")}</td>${canEditCRM() ? `<td class="crm-action-cell">
        <button class="danger" type="button" data-unlink="${index}"
        data-target-id="${escapeHTML(linked.id)}">Отвязать</button></td>` : ""}</tr>`;
    }).join("");
    const more = view === "crm-companies" && CRM_ENTITIES[relation.view].companyFilter;
    const moreLink = more && linkedRecords.length > 20
      ? `<a class="crm-relation-more" href="#${relation.view}?companyId=${encodeURIComponent(record.id)}">
        Показать все ${CRM_ENTITIES[relation.view].title.toLowerCase()} компании →</a>` : "";
    return `<section class="crm-relation-group"><div class="crm-relation-head">
      <h4>${relation.countLabel}: ${linkedRecords.length}</h4>${canEditCRM()
        ? `<button class="plain-button" type="button" data-link="${index}">Связать</button>` : ""}</div>
      ${rows ? `<div class="crm-table-wrap"><table class="crm-table crm-entity-table"><thead><tr>
        <th class="crm-grow">Имя</th>
        <th class="crm-compact">Роль</th><th class="crm-compact">Отметка</th>
        <th class="crm-grow">Заметка</th>${canEditCRM() ? '<th class="crm-action-cell"></th>' : ""}
        </tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="crm-muted">Связей нет</p>'}${moreLink}
      </section>`;
  }).join("");
  target.querySelectorAll("[data-link]").forEach((button) => button.addEventListener("click", () => {
    renderRelationForm(view, record, config.relations[Number(button.dataset.link)]);
  }));
  target.querySelectorAll("[data-unlink]").forEach((button) => button.addEventListener("click", async () => {
    const relation = config.relations[Number(button.dataset.unlink)];
    if (!confirm("Отвязать запись?")) return;
    try {
      const endpoint = relationEndpoint(view, record, relation, button.dataset.targetId);
      await crmQuery(endpoint, {}, csrfOptions("DELETE"));
      renderEntityCard(view, record.id);
    } catch (error) {
      content.querySelector("[data-card-status]").textContent = error.message;
    }
  }));
};
const renderRelationForm = async (view, record, relation) => {
  const data = await crmQuery(`/${relation.path}`, { limit: 200, deleted: "exclude" });
  const relatedConfig = CRM_ENTITIES[relation.view];
  const options = (data[relatedConfig.key] || []).map((item) =>
    `<option value="${escapeHTML(item.id)}">${escapeHTML(entityName(item))}</option>`).join("");
  const target = byId(`${view}-content`).querySelector("[data-relations]");
  target.insertAdjacentHTML("afterbegin", `<form class="crm-form" data-relation-form>
    <label>Запись *<select name="targetId" required><option value="">Выберите</option>${options}</select></label>
    <label>Роль *<input name="role" required></label>
    <label><span>${relation.flagLabel}</span><input name="flag" type="checkbox"></label>
    ${relation.signing ? '<label>Основание подписи<input name="signingBasis"></label>' : ""}
    <label>Действует с<input name="validFrom" type="date"></label>
    <label>Действует до<input name="validTo" type="date"></label>
    <label class="wide">Заметка<textarea name="notes"></textarea></label>
    <div class="crm-actions wide"><button type="submit">Сохранить связь</button></div>
    <p class="crm-error wide" role="alert" hidden></p></form>`);
  const form = target.querySelector("[data-relation-form]");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = new FormData(form);
    const payload = {
      role: values.get("role").trim(),
      [relation.flag]: form.elements.flag.checked,
      validFrom: values.get("validFrom") || null,
      validTo: values.get("validTo") || null,
      notes: values.get("notes").trim() || null
    };
    if (relation.signing) payload.signingBasis = values.get("signingBasis").trim() || null;
    try {
      const endpoint = relationEndpoint(view, record, relation, values.get("targetId"));
      await crmQuery(endpoint, {}, csrfOptions("PUT", payload));
      renderEntityCard(view, record.id);
    } catch (failure) {
      const error = form.querySelector("[role=alert]");
      error.textContent = failure.message;
      error.hidden = false;
    }
  });
};
Object.assign(api, { renderCrmEntityRoute, applyContactProjectFilter });
};

SbCabinet.registerView("clients", {
title: "База клиентов",
render(container, context) {
  init(context);
  navigate("crm-legal");
},
});
SbCabinet.registerView("crm-contacts", {
title: "Контрагенты",
render(container, context) {
  init(context);
  api.renderCrmEntityRoute();
},
onProjectChange(context) {
  init(context);
  api.applyContactProjectFilter();
},
});
SbCabinet.registerView("crm-companies", {
title: "Компании",
render(container, context) {
  init(context);
  api.renderCrmEntityRoute();
},
});
SbCabinet.registerView("crm-legal", {
title: "Юрлица",
render(container, context) {
  init(context);
  api.renderCrmEntityRoute();
},
});
})();

(() => {
"use strict";

const SbCabinet = window.SbCabinet = window.SbCabinet || {};
let identity, byId, escapeHTML, apiJson;
let initialized = false;
const api = {};
const init = (context) => {
  ({ identity, byId, escapeHTML, apiJson } = context);
  if (initialized) return;
  initialized = true;

  let accessOptions = null;
  let accessLoad = null;
  let creating = false;
  const createForm = byId("account-create");
  const selected = (name) => [...createForm.querySelectorAll(`input[name="${name}"]:checked`)].map(input => input.value);
  const presetSelect = byId("account-access-preset");
  const currentPreset = () => accessOptions?.presets.find(preset => preset.id === presetSelect.value);
  const accessCheckboxes = (name, options, checked, label = value => value) => options.map(value => {
    const id = typeof value === "string" ? value : value.id;
    return `<label class="account-access-option"><input type="checkbox" name="${name}" value="${escapeHTML(id)}"${checked.includes(id) ? " checked" : ""}> <span>${escapeHTML(label(value))}</span></label>`;
  }).join("");
  const applyDependencies = (form, changed) => {
    const find = value => [...form.querySelectorAll('input[name="permissions"]')].find(input => input.value === value);
    if (changed.checked) {
      for (const dependency of accessOptions.dependencies[changed.value] || []) {
        const input = find(dependency);
        if (input && !input.checked) { input.checked = true; applyDependencies(form, input); }
      }
    } else {
      for (const [permission, dependencies] of Object.entries(accessOptions.dependencies)) {
        if (!dependencies.includes(changed.value)) continue;
        const input = find(permission);
        if (input?.checked) { input.checked = false; applyDependencies(form, input); }
      }
    }
  };
  const renderAccess = (companies = [], permissions = []) => {
    const preset = currentPreset();
    byId("account-create-companies").innerHTML = accessOptions.companies.map(company =>
      `<label class="account-access-option"><input type="checkbox" name="companies" value="${escapeHTML(company.id)}"${companies.includes(company.id) ? " checked" : ""}> <span>${escapeHTML(company.name)}</span></label>`).join("");
    byId("account-create-permissions").innerHTML = "<p>Права</p>" + accessOptions.permissions.map(permission =>
      `<label class="account-access-option"><input type="checkbox" name="permissions" value="${escapeHTML(permission)}"${permissions.includes(permission) ? " checked" : ""}${preset ? " disabled" : ""}> <span>${escapeHTML(permission)}</span></label>`).join("");
    byId("account-access-status").textContent = preset
      ? "Отметьте один или несколько проектов. Набор доступа задаёт только права и не ограничивает выбор проектов."
      : "Отметьте проекты и права. Неотмеченный доступ не назначается. price.edit требует price.view, site_editor.edit требует site_editor.view.";
  };
  const loadAccess = async () => {
    if (!identity.permissions.includes("account.view") && identity.role !== "owner") return;
    accessOptions = null;
    byId("account-create-submit").disabled = true;
    byId("account-access-fields").disabled = true;
    presetSelect.disabled = true;
    byId("account-access-retry").hidden = true;
    try {
      const options = await apiJson("/content/admin/accounts/access-options");
      if (!Array.isArray(options.companies) || !Array.isArray(options.permissions) || !Array.isArray(options.presets)) {
        throw new Error("Не удалось получить список проектов и прав");
      }
      accessOptions = options;
      presetSelect.innerHTML = '<option value="custom">Выбрать вручную</option>' + options.presets.map(preset =>
        `<option value="${escapeHTML(preset.id)}">${escapeHTML(preset.name)}</option>`).join("");
      renderAccess();
      byId("account-access-fields").disabled = false;
      presetSelect.disabled = false;
      byId("account-create-submit").disabled = false;
    } catch (error) {
      byId("account-create-companies").textContent = "Не удалось загрузить: " + error.message;
      byId("account-create-permissions").textContent = "Не удалось загрузить: " + error.message;
      byId("account-access-status").textContent = "Не удалось загрузить доступ: " + error.message;
      byId("account-access-retry").hidden = false;
    }
  };
  presetSelect.addEventListener("change", () => {
    if (!accessOptions) return;
    const preset = currentPreset();
    const companies = selected("companies");
    renderAccess(companies, preset ? preset.permissions : selected("permissions"));
  });
  byId("account-create-permissions").addEventListener("change", (event) => {
    if (!accessOptions || event.target.name !== "permissions") return;
    applyDependencies(createForm, event.target);
  });
  byId("account-access-retry").addEventListener("click", async () => {
    accessLoad = loadAccess();
    await accessLoad;
    if (accessOptions) renderAccounts();
  });
  accessLoad = loadAccess();

  const renderAccounts = async () => {
    if (!identity.permissions.includes("account.view") && identity.role !== "owner") return;
    const content = byId("accounts-content");
    content.textContent = "Загрузка…";
    try {
      await accessLoad;
      if (!accessOptions) throw new Error("Не удалось получить список проектов и прав");
      const data = await apiJson("/content/admin/accounts");
      content.replaceChildren();
      for (const account of data.accounts) {
        const card = document.createElement("article");
        card.className = "card account-card";
        card.innerHTML = `<h2>${escapeHTML(account.displayName)}</h2>
          <p>@${escapeHTML(account.login)} · ${account.role}</p>
          <p>Компании: ${account.companies.map((item) => escapeHTML(item.name)).join(", ") || "не назначены"}</p>
          <p>Права: ${account.permissions.map(escapeHTML).join(", ") || "не назначены"}</p>
          ${identity.role === "owner" ? `<div class="account-card-actions">
            <button class="plain-button" type="button" data-account-edit>Изменить</button>
            <button class="danger" type="button" data-account-delete>Удалить</button></div>` : ""}`;
        card.querySelector("[data-account-edit]")?.addEventListener("click", event => {
          const existing = card.querySelector(".account-edit-form");
          if (existing) { existing.remove(); event.currentTarget.textContent = "Изменить"; return; }
          const form = document.createElement("form");
          form.className = "account-edit-form";
          form.innerHTML = `<label class="field-stack"><span>Отображаемое имя</span>
              <input name="displayName" required maxlength="120" value="${escapeHTML(account.displayName)}"></label>
            <label class="field-stack"><span>Роль</span><select name="role">
              <option value="editor"${account.role === "editor" ? " selected" : ""}>editor</option>
              <option value="owner"${account.role === "owner" ? " selected" : ""}>owner</option></select></label>
            <fieldset><legend>Компании</legend><div class="account-access-list">${accessCheckboxes("companies", accessOptions.companies,
              account.companies.map(company => company.id), company => company.name)}</div></fieldset>
            <fieldset><legend>Права</legend><div class="account-access-list">${accessCheckboxes("permissions", accessOptions.permissions,
              account.permissions)}</div></fieldset>
            <button type="submit">Сохранить</button><p role="status"></p>`;
          form.addEventListener("change", changeEvent => {
            if (changeEvent.target.name === "permissions") applyDependencies(form, changeEvent.target);
          });
          form.addEventListener("submit", async submitEvent => {
            submitEvent.preventDefault();
            const submit = form.querySelector('button[type="submit"]'), status = form.querySelector('[role="status"]');
            submit.disabled = true;
            try {
              await apiJson(`/content/admin/accounts/${account.id}`, {
                method: "PATCH", headers: { "X-CSRF-Token": identity.csrfToken },
                body: JSON.stringify({ displayName: form.elements.displayName.value, role: form.elements.role.value,
                  companies: [...form.querySelectorAll('input[name="companies"]:checked')].map(input => input.value),
                  permissions: [...form.querySelectorAll('input[name="permissions"]:checked')].map(input => input.value) })
              });
              await renderAccounts();
            } catch (error) { status.textContent = error.message; submit.disabled = false; }
          });
          card.append(form);
          event.currentTarget.textContent = "Скрыть";
        });
        card.querySelector("[data-account-delete]")?.addEventListener("click", () => {
          const dialog = document.createElement("dialog");
          dialog.className = "account-delete-confirm";
          dialog.innerHTML = `<p>Удалить учётную запись ${escapeHTML(account.login)}? Пользователь потеряет доступ в кабинет.</p>
            <p role="status"></p><menu><button type="button" data-cancel>Отмена</button>
            <button class="danger" type="button" data-confirm>Удалить</button></menu>`;
          const close = () => { dialog.close(); dialog.remove(); };
          dialog.querySelector("[data-cancel]").addEventListener("click", close);
          dialog.querySelector("[data-confirm]").addEventListener("click", async event => {
            event.currentTarget.disabled = true;
            try {
              await apiJson(`/content/admin/accounts/${account.id}`, {
                method: "DELETE", headers: { "X-CSRF-Token": identity.csrfToken }
              });
              close();
              await renderAccounts();
            } catch (error) {
              dialog.querySelector('[role="status"]').textContent = error.message;
              event.currentTarget.disabled = false;
            }
          });
          document.body.append(dialog);
          dialog.showModal();
        });
        content.append(card);
      }
    } catch (error) { content.textContent = "Не удалось загрузить: " + error.message; }
  };
  Object.assign(api, { renderAccounts });
  byId("account-create").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (creating) return;
    const form = event.currentTarget;
    const password = form.elements.password.value;
    const confirm = form.elements.confirm.value;
    try {
      if (!accessOptions) throw new Error("Сначала загрузите список проектов и прав");
      const companies = selected("companies"), permissions = selected("permissions");
      if (!companies.length) throw new Error("Отметьте хотя бы один проект");
      for (const permission of permissions) {
        const missing = (accessOptions.dependencies[permission] || []).filter(dependency => !permissions.includes(dependency));
        if (missing.length) throw new Error(`${permission} требует: ${missing.join(", ")}`);
      }
      if (password !== confirm) throw new Error("Пароли не совпадают");
      creating = true;
      byId("account-create-submit").disabled = true;
      await apiJson("/content/admin/accounts", {
        method: "POST",
        headers: { "X-CSRF-Token": identity.csrfToken },
        body: JSON.stringify({
          login: form.elements.login.value,
          displayName: form.elements.displayName.value,
          password, companies, permissions
        })
      });
      byId("account-create-result").textContent = "Учётная запись создана";
      form.reset();
      renderAccess();
      renderAccounts();
    } catch (error) {
      byId("account-create-result").textContent = error.message;
    } finally {
      creating = false;
      byId("account-create-submit").disabled = !accessOptions;
      form.elements.password.value = "";
      form.elements.confirm.value = "";
    }
  });
};

SbCabinet.registerView("account", {
  title: "Аккаунт",
  render(container, context) {
    init(context);
  },
});
SbCabinet.registerView("accounts", {
  title: "Настройка аккаунтов",
  render(container, context) {
    init(context);
  },
  initialize(context) {
    init(context);
    api.renderAccounts();
  },
});
})();

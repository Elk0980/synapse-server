(() => {
  "use strict";

  const SbCabinet = window.SbCabinet = window.SbCabinet || {};
  let ctx;
  let identity, byId, escapeHTML, apiJson;
  let initialized = false;
  const api = {};
  const init = (context) => {
    ctx = context;
    ({ identity, byId, escapeHTML, apiJson } = context);
    if (initialized) return;
    initialized = true;

    const renderAccounts = async () => {
      if (identity.role !== "owner") return;
      const content = byId("accounts-content");
      content.textContent = "Загрузка…";
      try {
        const data = await apiJson("/content/admin/accounts");
        content.replaceChildren();
        for (const account of data.accounts) {
          const card = document.createElement("article");
          card.className = "card account-card";
          card.innerHTML = `<h2>${escapeHTML(account.displayName)}</h2>
            <p>@${escapeHTML(account.login)} · ${account.role}</p>
            <p>Компании: ${account.companies.map((item) => escapeHTML(item.name)).join(", ") || "не назначены"}</p>
            <p>Права: ${account.permissions.map(escapeHTML).join(", ") || "не назначены"}</p>`;
          content.append(card);
        }
      } catch (error) { content.textContent = error.message; }
    };
    Object.assign(api, { renderAccounts });
    byId("account-create").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const password = form.elements.password.value;
      const confirm = form.elements.confirm.value;
      try {
        if (password !== confirm) throw new Error("Пароли не совпадают");
        await apiJson("/content/admin/accounts", {
          method: "POST",
          headers: { "X-CSRF-Token": identity.csrfToken },
          body: JSON.stringify({
            login: form.elements.login.value,
            displayName: form.elements.displayName.value,
            password
          })
        });
        byId("account-create-result").textContent = "Учётная запись создана";
        renderAccounts();
      } catch (error) {
        byId("account-create-result").textContent = error.message;
      } finally {
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
      api.renderAccounts();
    },
  });
})();

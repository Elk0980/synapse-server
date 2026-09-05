(() => {
"use strict";

const SbCabinet = window.SbCabinet = window.SbCabinet || {};
let ctx, identity, byId, escapeHTML, apiJson;
let initialized = false;
const api = {};
const init = (context) => {
  ctx = context;
  ({ identity, byId, escapeHTML, apiJson } = context);
  if (initialized) return;
  initialized = true;

  const renderSites = async () => {
    const content = byId("sites-content");
    if (!identity.permissions.includes("sites.view")) {
      content.textContent = "Нет доступа к каталогу сайтов";
      return;
    }
    content.textContent = "Загрузка…";
    const query = new URLSearchParams();
    if (byId("sites-company").value) query.set("companyCode", byId("sites-company").value);
    if (byId("sites-state").value) query.set("state", byId("sites-state").value);
    try {
      const data = await apiJson(`/content/sites?${query}`);
      content.replaceChildren();
      if (!data.sites.length) {
        content.textContent = "Для выбранных компаний сайты ещё не созданы";
        return;
      }
      const grid = document.createElement("div");
      grid.className = "site-grid";
      for (const site of data.sites) {
        const card = document.createElement("article");
        card.className = "card site-card";
        card.innerHTML = `<h2>${escapeHTML(site.name)}</h2><p>${escapeHTML(site.company.name)}</p>
          <p>${site.isActive ? "Активен · " : ""}
          ${site.publicationStatus === "draft" ? "Черновик" : "Опубликован"}</p>`;
        const actions = document.createElement("div");
        actions.className = "site-actions";
        for (const [label, url] of [["Редактировать сайт", site.capabilities.editSite && site.editorUrls.site],
          ["Прайс", site.capabilities.editPrice && site.editorUrls.price], ["Открыть сайт", site.publicUrl]]) {
          if (!url) continue;
          const link = document.createElement("a");
          link.href = url;
          link.target = "_blank";
          link.rel = "noopener";
          link.textContent = label;
          actions.append(link);
        }
        if (site.capabilities.delete) {
          const button = document.createElement("button"); button.type = "button"; button.className = "danger";
          button.textContent = "Удалить"; button.addEventListener("click", async () => {
            if (prompt(`Введите название сайта «${site.name}» для удаления`) !== site.name) return;
            await apiJson(`/content/sites/${encodeURIComponent(site.id)}`, {
              method: "DELETE", headers: { "X-CSRF-Token": identity.csrfToken }
            });
            renderSites();
          });
          actions.append(button);
        }
        card.append(actions); grid.append(card);
      }
      content.append(grid);
    } catch (error) {
      content.textContent = `${error.message}. Повторите попытку.`;
    }
  };
  Object.assign(api, { renderSites });
  byId("sites-company").addEventListener("change", renderSites);
  byId("sites-state").addEventListener("change", renderSites);
  byId("create-site").addEventListener("click", () => {
    byId("site-create-form").elements.companyCode.value =
      ctx.selectedProjectId || identity.companies[0]?.id || "";
    byId("site-create-dialog").showModal();
  });
  document.querySelector("[data-close-dialog]").addEventListener("click", () => {
    byId("site-create-dialog").close();
  });
  byId("site-create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const created = await apiJson("/content/sites", {
        method: "POST",
        headers: { "X-CSRF-Token": identity.csrfToken },
        body: JSON.stringify({
          name: form.elements.name.value,
          companyCode: form.elements.companyCode.value
        })
      });
      location.href = created.editorUrl;
    } catch (error) {
      form.querySelector("[role=alert]").textContent = error.message;
    }
  });
};

SbCabinet.registerView("sites", {
  title: "Сайты",
  render(container, context) {
    init(context);
  },
  initialize(context) {
    init(context);
    api.renderSites();
  },
});
})();

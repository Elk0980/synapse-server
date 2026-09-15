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
  let requestId = 0;
  const refreshButton = byId("refresh-sites");
  const refreshStatus = byId("sites-refresh-status");

  const renderSites = async ({ background = false } = {}) => {
    const request = ++requestId;
    const content = byId("sites-content");
    if (!identity.permissions.includes("sites.view")) {
      content.textContent = "Нет доступа к каталогу сайтов";
      return;
    }
    if (!background) content.textContent = "Загрузка…";
    content.setAttribute("aria-busy", "true");
    if (refreshButton) refreshButton.disabled = true;
    if (refreshStatus) refreshStatus.textContent = "";
    const query = new URLSearchParams();
    query.set("companyCode", ctx.selectedProjectId);
    if (byId("sites-state").value) query.set("state", byId("sites-state").value);
    try {
      const data = await apiJson(`/content/sites?${query}`);
      if (request !== requestId) return;
      content.replaceChildren();
      if (!data.sites.length) {
        content.textContent = "Для выбранных компаний сайты ещё не созданы";
        return;
      }
      const groups = [
        { title: "Чистовые сайты", published: true },
        { title: "Черновики", published: false }
      ];
      for (const group of groups) {
        const sites = data.sites.filter(site => (site.publicationStatus === "published") === group.published);
        if (!sites.length) continue;
        const section = document.createElement("section");
        section.className = "site-group";
        const heading = document.createElement("h2");
        heading.className = "site-group__title";
        heading.textContent = group.title;
        const grid = document.createElement("div");
        grid.className = `site-grid${group.published ? " site-grid--published" : ""}`;
        section.append(heading, grid);
        for (const site of sites) {
        const card = document.createElement("article");
        card.className = `card site-card${group.published ? " site-card--published" : ""}`;
        card.innerHTML = `<span class="site-badge${group.published ? " site-badge--published" : ""}">${group.published ? "Чистовой · Опубликован" : "Черновик"}</span>
          <h3>${escapeHTML(site.name)}</h3><p class="site-card__company">${escapeHTML(site.company.name)}${site.isActive ? "" : " · Неактивен"}</p>`;
        if (group.published && site.publicUrl) {
          const address = document.createElement("p");
          address.className = "site-card__address";
          try { address.textContent = new URL(site.publicUrl).host; }
          catch (_) { address.textContent = site.publicUrl; }
          card.append(address);
        }
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
          link.className = label === "Открыть сайт" ? "site-action site-action--open" : "site-action";
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
        content.append(section);
      }
    } catch (error) {
      if (request !== requestId) return;
      if (background && refreshStatus) refreshStatus.textContent = `Не удалось обновить список: ${error.message}`;
      else content.textContent = `Не удалось загрузить: ${error.message}`;
    } finally {
      if (request === requestId) {
        content.setAttribute("aria-busy", "false");
        if (refreshButton) refreshButton.disabled = false;
      }
    }
  };
  Object.assign(api, { renderSites });
  byId("sites-company").addEventListener("change", () => ctx.chooseProject(byId("sites-company").value));
  byId("sites-state").addEventListener("change", renderSites);
  refreshButton?.addEventListener("click", () => renderSites({ background: true }));
  const refreshVisible = () => {
    if (!document.hidden && ctx.currentView === "sites" && !byId("site-create-dialog").open) {
      renderSites({ background: true });
    }
  };
  document.addEventListener("visibilitychange", refreshVisible);
  window.addEventListener("pageshow", event => { if (event.persisted) refreshVisible(); });
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
    byId("sites-company").value = ctx.selectedProjectId;
    return api.renderSites();
  },
  initialize(context) {
    init(context);
  },
});
})();

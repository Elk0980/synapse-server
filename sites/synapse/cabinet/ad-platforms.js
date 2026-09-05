(() => {
  "use strict";

  const SbCabinet = window.SbCabinet = window.SbCabinet || {};
  let ctx;
  let identity, currentView, byId, escapeHTML, crmQuery, scopeParams, periodDates;
  let initialized = false;
  const api = {};
  const init = (context) => {
    ctx = context;
    ({ identity, currentView, byId, escapeHTML, crmQuery, scopeParams, periodDates } = context);
    if (initialized) return;
    initialized = true;

    const ANALYTICS_PLATFORMS = SbCabinet.ANALYTICS_PLATFORMS;
    const renderAdPlatforms = (dashboard = null) => {
      const stats = Array.isArray(dashboard?.sourceStats) ? dashboard.sourceStats : [];
      const has2gisExternal = stats.some((source) => {
        const external = source.external;
        const hasNumbers = external && typeof external === "object" &&
          Object.values(external).some((value) => typeof value === "number");
        return String(source.source || "").toLowerCase() === "2gis" && hasNumbers;
      });
      let currentGroup = null;
      const groups = [];
      for (const platform of ANALYTICS_PLATFORMS) {
        if (platform.group !== currentGroup) {
          currentGroup = platform.group;
          groups.push({ label: currentGroup, platforms: [] });
        }
        groups.at(-1).platforms.push(platform);
      }
      byId("ad-platforms-content").innerHTML = `<div class="platform-status-list">${groups.map((group) => {
        const heading = group.label ? `<h2>${escapeHTML(group.label)}</h2>` : "";
        const rows = group.platforms.map((platform) => {
          const connected = platform.id === "2gis" && has2gisExternal;
          return `<div class="platform-status-row"><span>${escapeHTML(platform.label)}${platform.note
            ? `<small>${escapeHTML(platform.note)}</small>` : ""}</span>
            <span class="platform-status${connected ? " is-connected" : ""}">
            ${connected ? "подключено" : "не подключено"}</span></div>`;
        }).join("");
        return `<section class="platform-status-group">${heading}${rows}</section>`;
      }).join("")}</div>`;
    };
    const loadAdPlatforms = async () => {
      if (currentView !== "ad-platforms" || !identity.permissions.includes("analytics.view")) return;
      renderAdPlatforms();
      try {
        const dashboard = await crmQuery("/dashboard", { ...periodDates("30d"), ...scopeParams() });
        if (currentView === "ad-platforms") renderAdPlatforms(dashboard);
      } catch (error) {
        // Connection statuses remain conservative when dashboard data is unavailable.
      }
    };
    Object.assign(api, { loadAdPlatforms });
  };

  SbCabinet.registerView("ad-platforms", {
    title: "Рекламные площадки",
    render(container, context) {
      init(context);
      api.loadAdPlatforms();
    },
    onProjectChange(context) {
      init(context);
      api.loadAdPlatforms();
    },
  });
})();

(() => {
  "use strict";

  const SbCabinet = window.SbCabinet = window.SbCabinet || {};
  let ctx;
  let identity, byId;
  let initialized = false;
  const api = {};
  const init = (context) => {
    ctx = context;
    ({ identity, byId } = context);
    if (initialized) return;
    initialized = true;

    const HOME_WIDGETS = Object.freeze([
      ["leads", "Заявки за период"],
      ["tasks", "Задачи в работе"],
      ["revenue", "Выручка"],
      ["romi", "ROMI"],
      ["dialogs", "Последние диалоги"]
    ]);
    const homeWidgetsStorageKey = () => `synapse_cabinet_home_widgets:${identity.userId}`;
    const readHomeWidgets = () => {
      try {
        const saved = JSON.parse(localStorage.getItem(homeWidgetsStorageKey()));
        return saved && typeof saved === "object" ? saved : {};
      } catch (error) {
        return {};
      }
    };
    const saveHomeWidgets = (settings) => {
      try {
        localStorage.setItem(homeWidgetsStorageKey(), JSON.stringify(settings));
      } catch (error) {
        // The widget choices remain available until this page is closed.
      }
    };
    const renderHomeWidgetSettings = () => {
      const settings = readHomeWidgets();
      const content = byId("home-widget-options");
      content.innerHTML = HOME_WIDGETS.map(([id, label]) => `<label class="widget-option">
        <input type="checkbox" value="${id}" ${settings[id] !== false ? "checked" : ""}>
        <span>${label} <span title="Что показывает виджет «${label}»">?</span></span></label>`).join("");
      content.addEventListener("change", () => {
        const next = {};
        content.querySelectorAll("input").forEach((input) => {
          next[input.value] = input.checked;
        });
        saveHomeWidgets(next);
      });
    };
    Object.assign(api, { renderHomeWidgetSettings });
  };

  SbCabinet.registerView("home", {
    title: "Главная",
    render(container, context) {
      init(context);
      api.renderHomeWidgetSettings();
    },
  });
})();

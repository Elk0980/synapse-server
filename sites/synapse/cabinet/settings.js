(() => {
"use strict";
const cabinet = window.SbCabinet = window.SbCabinet || {};
let initialized = false;

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
      status.textContent = error.message;
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

cabinet.registerView("settings", { title: "Настройки", render: (_, context) => initialize(context) });
})();

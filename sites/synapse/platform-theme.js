/* Тема интерфейса платформы Synapse: «Как в системе», «Светлая» или «Тёмная».
   Подключается обычным (не defer) скриптом в <head>, чтобы data-theme был выставлен до первой
   отрисовки и неверная тема не мелькала. Перекрашивает только интерфейс платформы: сайты клиентов,
   медиа и брендовые изображения сюда не подключаются. */
(() => {
  "use strict";
  if (window.SbTheme) return;
  const STORAGE_KEY = "sb-theme";
  const PREFERENCES = ["system", "light", "dark"];
  const root = document.documentElement;
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  const schemeMeta = document.querySelector('meta[name="color-scheme"]');
  const THEME_COLORS = { dark: themeColorMeta?.content || "#0d1117", light: "#f3f5f8" };
  const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const listeners = new Set();
  // Если хранилище запрещено, выбор действует до перезагрузки страницы и не ломает интерфейс.
  let pagePreference = null;

  const valid = (value) => PREFERENCES.includes(value) ? value : "system";
  const readPreference = () => {
    try {
      return valid(window.localStorage.getItem(STORAGE_KEY));
    } catch {
      return pagePreference || "system";
    }
  };
  // Без matchMedia остаётся прежний тёмный вид платформы.
  let hostSystemTheme = null;
  const systemTheme = () => {
    const host = hostSystemTheme?.();
    return host === "dark" || host === "light" ? host : media ? (media.matches ? "dark" : "light") : "dark";
  };
  let preference = readPreference();
  const resolved = () => preference === "system" ? systemTheme() : preference;

  const syncControls = () => {
    document.querySelectorAll("select[data-sb-theme-select]").forEach((select) => {
      if (select.value !== preference) select.value = preference;
      select.dataset.resolvedTheme = resolved();
    });
  };
  const apply = () => {
    const theme = resolved();
    root.dataset.theme = theme;
    root.dataset.themePreference = preference;
    if (schemeMeta) schemeMeta.content = theme;
    if (themeColorMeta) themeColorMeta.content = THEME_COLORS[theme];
    syncControls();
    const state = { preference, theme };
    listeners.forEach((listener) => {
      try { listener(state); } catch { /* подписчик не должен мешать смене темы */ }
    });
  };
  const set = (value) => {
    preference = valid(value);
    pagePreference = preference;
    try {
      if (preference === "system") window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, preference);
    } catch { /* выбор остаётся в текущей странице */ }
    apply();
  };

  const onSystemChange = () => { if (preference === "system") apply(); };
  if (media?.addEventListener) media.addEventListener("change", onSystemChange);
  else if (media?.addListener) media.addListener(onSystemChange);
  // Выбор, сделанный в другой вкладке кабинета, применяется без перезагрузки.
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    preference = readPreference();
    apply();
  });
  document.addEventListener("change", (event) => {
    const select = event.target?.closest?.("select[data-sb-theme-select]");
    if (select) set(select.value);
  });
  const mountControls = () => {
    document.querySelectorAll('[data-sb-theme-host]').forEach((host) => {
      if (host.querySelector('[data-sb-theme-select]')) return;
      const label = document.createElement('label');
      label.className = 'sb-theme-picker';
      label.innerHTML = '<span>Тема</span><select data-sb-theme-select><option value="system">Как в системе</option><option value="light">Светлая</option><option value="dark">Тёмная</option></select>';
      host.append(label);
    });
    syncControls();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountControls, { once: true });
  else mountControls();

  window.SbTheme = Object.freeze({
    STORAGE_KEY,
    get preference() { return preference; },
    get theme() { return resolved(); },
    set,
    useSystemTheme(resolver) { hostSystemTheme = typeof resolver === 'function' ? resolver : null; apply(); },
    refresh() { apply(); },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  });
  apply();
})();

'use strict';
/* Реестр модулей ЛК (контракт А, задача №98): specs/098-content-shell/contracts/module-registry.md.
   Модуль регистрируется window.SynapseModules.register(id, {title, mount(el, ctx), unmount}).
   Оболочка кабинета подключает реестр через attachShell и сама монтирует модули в экраны,
   а также в плавающую панель личного чата с Хью (id «hugh-chat»). */
(() => {
  const previous = window.SynapseModules;
  if (previous && previous.version) return;
  const ID = /^[a-z][a-z0-9-]{1,47}$/;
  const PATH = /^[a-z0-9][a-z0-9/_.-]{0,159}$/i;
  const definitions = new Map();
  const listeners = new Set();
  let shell = null;

  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const currentUser = () => shell?.identity() || null;
  const currentCompany = () => shell?.company() || null;
  const can = (permission) => {
    const user = currentUser();
    return !!user && (user.role === 'owner' || (user.permissions || []).includes(permission));
  };

  function apiClient(companyCode, signal) {
    const url = (path, params = {}) => {
      if (typeof path !== 'string' || !PATH.test(path) || path.includes('..')) throw new Error('Некорректный адрес API модуля');
      const query = new URLSearchParams();
      Object.entries({ companyCode, ...params }).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
      });
      return `/content/${path}?${query}`;
    };
    const write = (method) => (path, body, params, options = {}) => shell.apiJson(url(path, params), {
      method, signal, headers: { 'X-CSRF-Token': Object.hasOwn(options, 'csrfToken') ? options.csrfToken : currentUser()?.csrfToken || '' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    // Сырые байты (загрузка частями): Response как есть, CSRF добавляется для записи, cookie same-origin.
    const raw = (method, path, body, { headers = {}, params } = {}) => {
      const verb = String(method || 'GET').toUpperCase();
      const extra = verb === 'GET' || verb === 'HEAD' ? {} : { 'X-CSRF-Token': currentUser()?.csrfToken || '' };
      return fetch(url(path, params), { method: verb, credentials: 'same-origin', cache: 'no-store', signal,
        headers: { ...headers, ...extra }, ...(body === undefined || body === null ? {} : { body }) });
    };
    return {
      url, raw,
      get: (path, params) => shell.apiJson(url(path, params), { signal }),
      post: write('POST'), put: write('PUT'), patch: write('PATCH'),
      del: (path, params) => write('DELETE')(path, undefined, params)
    };
  }

  function contentSettings(companyCode, signal) {
    const api = apiClient(companyCode, signal);
    return {
      get: () => api.get('content-settings'),
      save: (settings, version) => api.put('content-settings', { version, settings })
    };
  }

  function createContext(moduleId, route, signal) {
    if (!shell) throw new Error('Оболочка кабинета ещё не готова');
    const user = currentUser(), company = currentCompany();
    const companyCode = company?.id || '';
    return Object.freeze({
      projectPreferences:shell.projectPreferences?.() || null,
      moduleId, companyCode, companyName: company?.name || '',
      user: Object.freeze({ id: user?.userId ?? null, login: user?.login || '', name: user?.displayName || user?.login || '', role: user?.role || '' }),
      permissions: Object.freeze([...(user?.permissions || [])]),
      viewAs: user?.viewAs || null,
      can, signal,
      get csrfToken() { return currentUser()?.csrfToken || ''; },
      route: Object.freeze({ path: route?.path || '', params: new URLSearchParams(route?.query || '') }),
      api: Object.freeze(apiClient(companyCode, signal)),
      crm: (path, params, options = {}) => shell.crmQuery(path, params, { ...options, signal }),
      settings: Object.freeze({ content: Object.freeze(contentSettings(companyCode, signal)) }),
      navigate: (target) => shell.navigate(String(target || '').replace(/^#/, '')),
      openHughChat: () => dock.open(),
      escapeHTML: shell.escapeHTML
    });
  }

  function renderStub(element, stub = {}) {
    const card = node('section', 'sb-module-stub card');
    const head = node('div', 'sb-module-stub__head');
    head.append(node('h1', '', stub.title || 'Раздел'), node('span', 'sb-soon-badge', 'Скоро'));
    card.append(head, node('p', 'sb-module-stub__lead', 'Раздел в разработке · готовим к утру'));
    if (stub.text) card.append(node('p', 'muted', stub.text));
    const links = (stub.links || []).filter((link) => link && /^#[a-z0-9/_-]+$/i.test(link.href));
    if (links.length) {
      const list = node('div', 'sb-module-stub__links');
      list.append(node('span', 'muted', 'Пока можно:'));
      links.forEach((link) => { const anchor = node('a', 'plain-button', link.label); anchor.href = link.href; list.append(anchor); });
      card.append(list);
    }
    element.replaceChildren(card);
  }

  function renderError(element, error) {
    const card = node('section', 'sb-module-stub card');
    card.append(node('h2', '', 'Модуль не открылся'),
      node('p', 'muted', 'Остальной кабинет работает. Обновите страницу; если ошибка повторится — сообщите в чат.'));
    if (error?.message) card.append(node('p', 'sb-module-error', error.message));
    element.replaceChildren(card);
  }

  // Монтирует модуль в host и возвращает контроллер. Ошибка модуля не выходит за его контейнер.
  function mount(host, moduleId, options = {}) {
    const element = node('div', 'sb-module-root');
    element.dataset.module = moduleId;
    host.replaceChildren(element);
    const definition = definitions.get(moduleId);
    if (!definition) {
      renderStub(element, options.stub);
      return { id: moduleId, registered: false, unmount() { element.remove(); } };
    }
    const abort = new AbortController();
    let context = null, closed = false;
    const fail = (error) => {
      if (closed || abort.signal.aborted) return;
      console.error(`Модуль ${moduleId}:`, error);
      renderError(element, error);
    };
    try {
      context = createContext(moduleId, options.route, abort.signal);
      const result = definition.mount(element, context);
      if (result && typeof result.then === 'function') result.catch(fail);
    } catch (error) { fail(error); }
    return {
      id: moduleId, registered: true, definition,
      unmount() {
        if (closed) return;
        closed = true;
        abort.abort();
        try { definition.unmount?.(element, context); } catch (error) { console.error(`Модуль ${moduleId}:`, error); }
        element.replaceChildren();
        element.remove();
      }
    };
  }

  /* Плавающая кнопка и панель личного чата с Хью. Логику чата даёт модуль «hugh-chat». */
  const dock = (() => {
    let fab = null, panel = null, body = null, controller = null;
    const build = () => {
      if (fab) return;
      fab = node('button', 'sb-chat-fab');
      fab.type = 'button';
      fab.id = 'hugh-chat-fab';
      fab.setAttribute('aria-controls', 'hugh-chat-panel');
      fab.setAttribute('aria-expanded', 'false');
      fab.setAttribute('aria-label', 'Открыть личный чат с Хью');
      fab.title = 'Личный чат с Хью';
      fab.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm3 6.5a1.5 1.5 0 1 0 0 .01Zm5 0a1.5 1.5 0 1 0 0 .01Zm5 0a1.5 1.5 0 1 0 0 .01Z"/></svg>';
      panel = node('aside', 'sb-chat-panel');
      panel.id = 'hugh-chat-panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-labelledby', 'hugh-chat-title');
      panel.hidden = true;
      const header = node('header', 'sb-chat-panel__head');
      const titles = node('div', 'sb-chat-panel__titles');
      const title = node('strong', '', 'Хью · личный чат');
      title.id = 'hugh-chat-title';
      const company = node('span', 'muted');
      company.id = 'hugh-chat-company';
      titles.append(title, company);
      const close = node('button', 'sb-chat-panel__close', '×');
      close.type = 'button';
      close.setAttribute('aria-label', 'Закрыть чат');
      header.append(titles, close);
      body = node('div', 'sb-chat-panel__body');
      body.id = 'hugh-chat-mount';
      panel.append(header, body);
      document.body.append(fab, panel);
      fab.addEventListener('click', () => (panel.hidden ? open() : closePanel(true)));
      close.addEventListener('click', () => closePanel(true));
      panel.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); closePanel(true); } });
    };
    const mountChat = () => {
      controller?.unmount();
      panel.querySelector('#hugh-chat-company').textContent = currentCompany()?.name || '';
      controller = mount(body, 'hugh-chat', { stub: { title: 'Личный чат с Хью',
        text: 'Здесь будет ваш личный чат с Хью по выбранной компании: просьбы, правки и журнал ответов.',
        links: [{ href: '#chats', label: 'Открыть «Чаты»' }] } });
    };
    function open() {
      if (!shell) return;
      build();
      panel.hidden = false;
      fab.setAttribute('aria-expanded', 'true');
      document.body.classList.add('sb-chat-open');
      mountChat();
      (panel.querySelector('textarea, input, button:not(.sb-chat-panel__close), a[href]') || panel.querySelector('.sb-chat-panel__close')).focus();
    }
    function closePanel(restoreFocus = false) {
      if (!panel || panel.hidden) return;
      panel.hidden = true;
      fab.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('sb-chat-open');
      controller?.unmount();
      controller = null;
      if (restoreFocus) fab.focus();
    }
    return {
      init() { build(); fab.hidden = false; },
      open, close: closePanel,
      isOpen: () => !!panel && !panel.hidden,
      companyChanged() { if (panel && !panel.hidden) mountChat(); },
      remount(id) { if (id === 'hugh-chat' && panel && !panel.hidden) mountChat(); }
    };
  })();

  /* Модули и версия оболочки без правки cabinet.html (автовыпуск обновляет cabinet/**, но не cabinet.html).
     /cabinet/shell-modules.json {"assets": [...], "styles": [...]} — список модулей (лежит в git).
     /cabinet/shell-version.json {"commit": "<sha>"} — версия; пишет автовыпуск после успешной выкладки.
     Оба читаются с cache: 'no-store'. Нет списка — запасной shellAssets/shellStyles из cabinet.html;
     нет версии — прежняя ?v. Грузятся только имена ^[a-z][a-z0-9-]{1,47}$ из /cabinet/ того же origin.
     Уже загруженный файл с той же версией не грузится второй раз; сам реестр не перезагружается. */
  const COMMIT = /^[0-9a-f]{7,40}$/;
  const MAX_SHELL_FILES = 64;
  const names = (list) => (Array.isArray(list) ? [...new Set(list.filter((name) => typeof name === 'string' && ID.test(name)))] : [])
    .filter((name) => name !== 'module-registry').slice(0, MAX_SHELL_FILES);
  function fallbackLists() {
    /* global shellAssets, shellStyles — списки cabinet.html (классический скрипт, общая область) */
    let assets = null, styles = null;
    try { assets = typeof shellAssets === 'undefined' ? null : shellAssets; } catch { assets = null; }
    try { styles = typeof shellStyles === 'undefined' ? null : shellStyles; } catch { styles = null; }
    return Array.isArray(assets) || Array.isArray(styles) ? { assets: names(assets), styles: names(styles) } : null;
  }
  async function readJson(path) {
    try {
      const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) return null;
      const data = await response.json();
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch { return null; }
  }
  function shellUrl(name, extension, version) {
    const url = new URL(`/cabinet/${name}.${extension}`, location.href);
    url.searchParams.set('v', version);
    return url.origin === location.origin && url.pathname === `/cabinet/${name}.${extension}` ? url : null;
  }
  const sameFile = (href, name, extension) => {
    try { const url = new URL(href, location.href); return url.origin === location.origin && url.pathname === `/cabinet/${name}.${extension}`; } catch { return false; }
  };
  async function refreshShellAssets() {
    const fallbackVersion = String(window.SB_CABINET_ASSET_VERSION || '');
    const fallback = fallbackLists();
    if (!fallback) return { version: fallbackVersion, source: 'none', loaded: [] };   // не кабинет (стенды тестов)
    const [modules, versionFile] = await Promise.all([readJson('/cabinet/shell-modules.json'), readJson('/cabinet/shell-version.json')]);
    const fromJson = modules && (Array.isArray(modules.assets) || Array.isArray(modules.styles));
    const lists = fromJson ? { assets: names(modules.assets), styles: names(modules.styles) } : fallback;
    const commit = typeof versionFile?.commit === 'string' && COMMIT.test(versionFile.commit) ? versionFile.commit : '';
    const version = commit || fallbackVersion;
    if (document.readyState === 'loading') await new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    const loaded = [];
    lists.styles.forEach((name) => {
      const url = shellUrl(name, 'css', version);
      if (!url) return;
      const links = [...document.querySelectorAll('link[rel="stylesheet"]')].filter((link) => sameFile(link.getAttribute('href') || '', name, 'css'));
      if (links.some((link) => new URL(link.getAttribute('href'), location.href).href === url.href)) return;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url.pathname + url.search;
      link.addEventListener('load', () => links.forEach((old) => old.remove()), { once: true });   // при ошибке прежний стиль остаётся
      if (links.length) links[links.length - 1].after(link); else document.head.append(link);
      loaded.push(`${name}.css`);
    });
    lists.assets.forEach((name) => {
      const url = shellUrl(name, 'js', version);
      if (!url) return;
      if ([...document.querySelectorAll('script[src]')].some((script) => new URL(script.getAttribute('src'), location.href).href === url.href)) return;
      const script = document.createElement('script');
      script.src = url.pathname + url.search;
      script.async = false;                                               // порядок списка сохраняется
      document.body.append(script);
      loaded.push(`${name}.js`);
    });
    return { version, source: fromJson ? 'shell-modules.json' : 'cabinet.html', loaded };
  }

  const registry = {
    version: 1,
    register(id, definition) {
      if (typeof id !== 'string' || !ID.test(id)) throw new Error(`SynapseModules: некорректный id «${id}»`);
      if (!definition || typeof definition.mount !== 'function') throw new Error(`SynapseModules: модулю «${id}» нужна функция mount`);
      if (definition.unmount !== undefined && typeof definition.unmount !== 'function') throw new Error(`SynapseModules: unmount модуля «${id}» должен быть функцией`);
      definitions.set(id, Object.freeze({ title: String(definition.title || id), mount: definition.mount,
        unmount: definition.unmount, onRoute: typeof definition.onRoute === 'function' ? definition.onRoute : undefined }));
      dock.remount(id);
      listeners.forEach((listener) => { try { listener(id); } catch (error) { console.error(error); } });
      return true;
    },
    has: (id) => definitions.has(id),
    get: (id) => definitions.get(id) || null,
    list: () => [...definitions.keys()],
    onRegister(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    attachShell(api) { shell = api; dock.init(); },
    mount,
    createContext,
    contentSettings: (companyCode) => contentSettings(companyCode || currentCompany()?.id || ''),
    chat: dock
  };
  window.SynapseModules = registry;
  // Новые модули из shell-modules.json и свежие версии прежних: повторная загрузка = повторная регистрация.
  registry.shellVersion = refreshShellAssets().catch((error) => { console.error(error); return { version: String(window.SB_CABINET_ASSET_VERSION || ''), source: 'error', loaded: [] }; });
  // Модуль, загруженный раньше реестра, может оставить очередь: window.SynapseModulesQueue = [[id, def], …].
  (Array.isArray(window.SynapseModulesQueue) ? window.SynapseModulesQueue : []).forEach(([id, definition]) => {
    try { registry.register(id, definition); } catch (error) { console.error(error); }
  });
  window.SynapseModulesQueue = { push: ([id, definition]) => registry.register(id, definition) };
})();

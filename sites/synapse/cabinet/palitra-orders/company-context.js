/* Shared company context for the existing application. Identity is supplied by whoami;
   this client-side module never grants server access or persists personal data. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.defineProperty(root, 'SynapseCompanies', { value: api });
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const profiles = Object.freeze([
    Object.freeze({ code: 'palitra-love', site: 'palitra', name: 'Палитра', mark: 'П', origin: 'https://palitra-love.ru' }),
    Object.freeze({ code: 'avokado', site: 'avokado', name: 'Авокадо', mark: 'А', origin: 'https://avokado38.ru' }),
    Object.freeze({ code: 'alvi', site: 'alvi', name: 'Алви', mark: 'А', origin: 'https://spaalvi-38.ru' }),
  ]);
  const profile = code => profiles.find(item => item.code === code) || null;
  function actor(identity) {
    if (!identity || !['owner', 'editor'].includes(identity.role) || !['string', 'number'].includes(typeof identity.userId) || !/^[A-Za-z0-9_-]{1,128}$/.test(String(identity.userId))) return '';
    if (typeof identity.userId === 'number' && (!Number.isSafeInteger(identity.userId) || identity.userId < 1)) return '';
    return String(identity.userId);
  }
  function available(identity) {
    if (!actor(identity) || !Array.isArray(identity.companies)) return [];
    const codes = new Set(identity.companies.map(c => typeof c === 'string' ? c : c && typeof c.id === 'string' ? c.id : null));
    // Owners receive their server-provided list too; a role string alone grants nothing.
    return profiles.filter(p => codes.has(p.code));
  }
  function denied(message, code = 'COMPANY_FORBIDDEN') { return Object.assign(new Error(message), { code, status: 403 }); }
  function create({ verifyIdentity, beforeSwitch = () => [], activate, changed = () => {} } = {}) {
    if (typeof verifyIdentity !== 'function' || typeof activate !== 'function') throw new TypeError('Нужны проверка сессии и переключение контекста');
    let revision = 0, identity = null, selected = null, switching = false, disposed = false;
    const drafts = new Map();
    const key = code => `${actor(identity)}#${code}`;
    const snapshot = () => Object.freeze({ company: selected, companies: Object.freeze(available(identity)), switching, revision, actor: actor(identity) });
    const publish = () => { changed(snapshot()); };
    function reconcile(fresh) {
      const oldActor = actor(identity), nextActor = actor(fresh), allowed = available(fresh);
      if (!nextActor) throw denied('Сессия не подтверждена', 'SESSION_ENDED');
      if (oldActor && oldActor !== nextActor) { drafts.clear(); selected = null; }
      identity = Object.freeze({ userId: nextActor, role: fresh.role, companies: Object.freeze(allowed.map(p => p.code)) });
      const codes = new Set(allowed.map(p => p.code));
      for (const draftKey of drafts.keys()) if (!codes.has(draftKey.slice(draftKey.indexOf('#') + 1))) drafts.delete(draftKey);
      if (selected && !codes.has(selected.code)) { selected = null; drafts.clear(); }
      return allowed;
    }
    async function choose(code, { initial = false } = {}) {
      if (disposed) throw denied('Контекст закрыт', 'DISPOSED');
      if (switching) throw denied('Проверяем доступ к компании', 'SWITCH_BUSY');
      if (code !== undefined && !profile(code)) throw denied('Компания недоступна');
      const blockers = beforeSwitch();
      if (!initial && (!Array.isArray(blockers) || blockers.length)) throw denied('Завершите текущую отправку или сохраните изменения перед сменой компании', 'SWITCH_BLOCKED');
      switching = true; const ticket = ++revision; publish();
      let verified = false;
      try {
        const fresh = await verifyIdentity();
        if (disposed || ticket !== revision) return false;
        verified = true;
        const previousActor = actor(identity), previousCode = selected && selected.code;
        const choices = reconcile(fresh);
        if (previousActor && previousActor !== actor(fresh) || previousCode && !choices.some(p => p.code === previousCode)) {
          await activate(null, fresh, { revision: ticket, revoked: true });
        }
        const wanted = code === undefined ? (selected || choices[0]) : choices.find(p => p.code === code);
        if (!wanted) {
          // A removed selection must be cleared by the host immediately, including cached views.
          if (!selected) await activate(null, fresh, { revision: ticket, revoked: true });
          throw denied('Нет доступа к выбранной компании');
        }
        // Inputs could change during the whoami request. Recheck before disposing any view.
        const latestBlockers = beforeSwitch();
        if (!initial && (!Array.isArray(latestBlockers) || latestBlockers.length)) throw denied('Появились несохранённые изменения. Переключение отменено.', 'SWITCH_BLOCKED');
        const changedActor = previousActor && previousActor !== actor(fresh);
        if (!initial && !changedActor && previousCode === wanted.code && selected) return true;
        const old = selected;
        try { await activate(wanted, fresh, { revision: ticket, revoked: Boolean(changedActor) }); }
        catch (error) { selected = old && available(identity).some(p => p.code === old.code) ? old : null; throw error; }
        if (disposed || ticket !== revision) return false;
        selected = wanted; return true;
      } catch (error) {
        if (!verified && !disposed && ticket === revision && [401, 403].includes(error && error.status)) {
          identity = null; selected = null; drafts.clear();
          await activate(null, null, { revision: ticket, revoked: true });
        }
        throw error;
      } finally { if (!disposed && ticket === revision) { switching = false; publish(); } }
    }
    return Object.freeze({
      choose, snapshot,
      // Only the host calls this with the response of its initial whoami request.
      initialize(fresh, preferred) {
        if (disposed || switching) throw denied('Контекст занят', 'SWITCH_BUSY');
        const choices = reconcile(fresh);
        selected = choices.find(p => p.code === preferred) || choices[0] || null;
        ++revision; publish(); return selected;
      },
      saveDraft(value) { if (selected && actor(identity)) drafts.set(key(selected.code), value); },
      draft() { return selected ? drafts.get(key(selected.code)) : undefined; },
      ticket() { return Object.freeze({ revision, actor: actor(identity), company: selected && selected.code }); },
      current(ticket) { return !disposed && Boolean(ticket && ticket.revision === revision && ticket.actor === actor(identity) && ticket.company === (selected && selected.code)); },
      revoke() { ++revision; identity = null; selected = null; switching = false; drafts.clear(); publish(); },
      dispose() { ++revision; disposed = true; identity = null; selected = null; switching = false; drafts.clear(); },
    });
  }
  let navId = 0;
  const navDocuments = new WeakSet();
  function closeNav(nav, restoreFocus = false) {
    const trigger = nav.querySelector('.company-nav__trigger'), menu = nav.querySelector('.company-nav__menu');
    if (!trigger || !menu) return;
    menu.hidden = true; trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !trigger.disabled) trigger.focus();
  }
  function navEvents(doc) {
    if (navDocuments.has(doc)) return;
    navDocuments.add(doc);
    doc.addEventListener('click', event => {
      for (const nav of doc.querySelectorAll('[data-company-nav]')) if (!nav.contains(event.target)) closeNav(nav);
    });
    doc.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      const nav = event.target.closest && event.target.closest('[data-company-nav]');
      if (!nav || nav.querySelector('.company-nav__menu')?.hidden !== false) return;
      event.preventDefault(); event.stopPropagation(); closeNav(nav, true);
    }, true);
  }
  function renderNav({ document: doc, parent, state, select } = {}) {
    if (!doc || !parent || !state || typeof select !== 'function') throw new TypeError('Нужен контекст меню');
    let nav = parent.querySelector('[data-company-nav]');
    if (!nav) { nav = doc.createElement('nav'); nav.dataset.companyNav = ''; nav.className = 'company-nav'; nav.setAttribute('aria-label', 'Выбор компании'); parent.append(nav); }
    nav.hidden = !state.companies.length;
    nav.setAttribute('aria-busy', String(state.switching));
    closeNav(nav); nav.replaceChildren();
    if (nav.hidden) return nav;
    navEvents(doc);
    const label = doc.createElement('p'); label.className = 'company-nav__label'; label.textContent = 'Компания';
    const trigger = doc.createElement('button'); trigger.type = 'button'; trigger.className = 'company-nav__trigger';
    trigger.disabled = state.switching; trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false');
    const current = state.companies.find(item => state.company && item.code === state.company.code) || state.companies[0];
    const mark = doc.createElement('span'); mark.className = 'company-nav__mark'; mark.setAttribute('aria-hidden', 'true'); mark.textContent = current.mark;
    const name = doc.createElement('span'); name.className = 'company-nav__name'; name.textContent = current.name;
    const arrow = doc.createElement('span'); arrow.className = 'company-nav__arrow'; arrow.setAttribute('aria-hidden', 'true'); arrow.textContent = '⌄';
    trigger.append(mark, name, arrow);
    const menu = doc.createElement('div'); menu.className = 'company-nav__menu'; menu.hidden = true;
    menu.id = 'company-menu-' + ++navId; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Выбор компании');
    trigger.setAttribute('aria-controls', menu.id);
    const buttons = state.companies.map(item => {
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'company-nav__item';
      button.dataset.company = item.code; button.disabled = state.switching;
      button.setAttribute('role', 'menuitemradio'); button.setAttribute('aria-checked', String(item.code === current.code));
      const icon = doc.createElement('span'); icon.className = 'company-nav__mark'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = item.mark;
      const text = doc.createElement('span'); text.className = 'company-nav__name'; text.textContent = item.name;
      button.append(icon, text);
      button.addEventListener('click', () => { closeNav(nav, true); select(item.code); });
      return button;
    });
    menu.append(...buttons);
    function show(index = buttons.findIndex(button => button.getAttribute('aria-checked') === 'true')) {
      if (trigger.disabled) return;
      for (const other of doc.querySelectorAll('[data-company-nav]')) if (other !== nav) closeNav(other);
      menu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); buttons[Math.max(0, index)]?.focus();
    }
    trigger.addEventListener('click', () => { if (menu.hidden) show(); else closeNav(nav, true); });
    trigger.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); show(event.key === 'ArrowUp' || event.key === 'End' ? buttons.length - 1 : 0);
    });
    menu.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = buttons.indexOf(doc.activeElement);
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    });
    menu.addEventListener('focusout', event => { if (event.relatedTarget && !nav.contains(event.relatedTarget)) closeNav(nav); });
    nav.append(label, trigger, menu);
    return nav;
  }
  // Ссылка в уже открытой странице проходит тот же начальный вход после
  // безопасного обновления. Черновики, файлы и неизвестные отправки не выгружаем.
  function createReportNavigation({ parse, initialHash = '', readBlockers, replaceHash, reload, onBlocked = () => {} } = {}) {
    if ([parse, readBlockers, replaceHash, reload, onBlocked].some(fn => typeof fn !== 'function')) throw new TypeError('Нужны проверка ссылки и безопасный переход');
    let stableHash = initialHash, reloading = false, disposed = false;
    function blocked(message) {
      try { replaceHash(stableHash); } catch (_) { /* Содержимое страницы всё равно сохраняется. */ }
      try { onBlocked(message); } catch (_) { /* Ошибка уведомления не разрешает обновление. */ }
      return false;
    }
    return Object.freeze({
      remember(hash) { if (!disposed && typeof hash === 'string') stableHash = hash; },
      observe(hash) {
        if (disposed || reloading || typeof hash !== 'string' || hash === stableHash) return false;
        let entry;
        try { entry = parse(hash); } catch (_) { return blocked('Некорректная ссылка на отчёт. Текущая страница сохранена.'); }
        if (!entry) return false;
        let blockers;
        try { blockers = readBlockers(); } catch (_) { blockers = null; }
        if (!Array.isArray(blockers) || blockers.length) return blocked('Завершите текущий ввод или отправку и откройте ссылку ещё раз. Черновик и файл сохранены.');
        reloading = true;
        try { reload(); return true; }
        catch (_) { reloading = false; return blocked('Не удалось открыть отчёт. Текущая страница сохранена.'); }
      },
      dispose() { disposed = true; },
    });
  }
  return Object.freeze({ profiles, profile, available, actor, create, renderNav, createReportNavigation });
});

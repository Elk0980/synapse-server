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
  function renderNav({ document: doc, parent, state, select } = {}) {
    if (!doc || !parent || !state || typeof select !== 'function') throw new TypeError('Нужен контекст меню');
    let nav = parent.querySelector('[data-company-nav]');
    if (!nav) { nav = doc.createElement('nav'); nav.dataset.companyNav = ''; nav.className = 'company-nav'; nav.setAttribute('aria-label', 'Выбор компании'); parent.append(nav); }
    nav.hidden = !state.companies.length;
    nav.setAttribute('aria-busy', String(state.switching));
    nav.replaceChildren(...state.companies.map(item => {
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'company-nav__item';
      button.dataset.company = item.code; button.textContent = item.name; button.disabled = state.switching;
      button.setAttribute('aria-pressed', String(Boolean(state.company && state.company.code === item.code)));
      button.addEventListener('click', () => select(item.code)); return button;
    }));
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

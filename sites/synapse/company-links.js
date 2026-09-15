/* Public business links come from the current company's saved CRM profile. */
(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (host && host.document) {
    const run = () => { host.SynapseCompanyLinks = api.start(host, host.document); };
    if (host.document.readyState === 'loading') host.document.addEventListener('DOMContentLoaded', run, {once: true});
    else run();
  }
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const keys = new Set(['website', 'two_gis', 'yandex_maps', 'max', 'telegram', 'telegram_channel', 'whatsapp', 'vk', 'booking']);
  const tracking = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'yclid', 'entry_point'];
  const instances = new WeakMap();
  function safeUrl(value) {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value) || !/^https?:\/\//i.test(value.trim())) return null;
    try {
      const url = new URL(value.trim());
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null;
    } catch (_) { return null; }
  }
  function bookingAccount(url) {
    const match = /^\/company\/(\d+)\/personal\//.exec(url.pathname);
    return /(^|\.)yclients\.com$/i.test(url.hostname) && match ? url.origin + '/company/' + match[1] : null;
  }
  function destination(value, previous, detail = false) {
    const saved = safeUrl(value), current = safeUrl(previous);
    if (!saved) return null;
    let result = saved;
    // A named offer retains its service selection only within the same booking account.
    if (detail && current?.searchParams.has('o') && /\/personal\/menu\/?$/.test(saved.pathname) && bookingAccount(saved) && bookingAccount(saved) === bookingAccount(current)) {
      result = new URL(saved.href);
      result.pathname = current.pathname;
      if (!result.searchParams.has('o')) result.searchParams.set('o', current.searchParams.get('o'));
    }
    if (current) for (const key of tracking) {
      const value = current.searchParams.get(key);
      if (value && value.length <= 512) result.searchParams.set(key, value);
    }
    return result.href;
  }
  function protectedLink(anchor, base) {
    if (anchor.hasAttribute('data-contact-route')) return true;
    const value = anchor.getAttribute('href') || '';
    if (/^(?:tel:|mailto:)/i.test(value)) return true;
    const label = String(anchor.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (['помочь с выбором', 'оформить сертификат', 'выбрать сертификат', 'обсудить сертификат', 'связаться с нами', 'узнать про абонемент'].includes(label)) return true;
    try {
      const url = new URL(value, base), here = new URL(base);
      return url.origin === here.origin && (/(^|\/)contacts\.html$/.test(url.pathname) || ['#contacts', '#callback', '#callback-form'].includes(url.hash));
    } catch (_) { return true; }
  }
  function sameDestination(value, fallback, base) {
    try {
      const current = new URL(value, base), target = new URL(fallback, base);
      // Attribution may make a relative link absolute and add campaign parameters.
      // Keep those parameters instead of making the two href observers fight.
      return !current.username && !current.password && current.origin === target.origin &&
        current.pathname === target.pathname && current.hash === target.hash;
    } catch (_) { return false; }
  }
  function start(win, doc) {
    if (new URLSearchParams(win.location.search).get('edit') === '1' || !doc.body || !win.fetch) return null;
    if (instances.has(doc)) return instances.get(doc);
    const companyCode = doc.body.getAttribute('data-company-code');
    if (!companyCode) return null;
    let links = {}, loaded = false, observing = false, pending = null;
    const original = new WeakMap();
    const guarded = new WeakSet();
    let styleGuard = null;
    function remember(anchor) {
      if (!original.has(anchor)) original.set(anchor, {
        href: anchor.getAttribute('href'), target: anchor.getAttribute('target'),
        tabindex: anchor.getAttribute('tabindex'), ariaHidden: anchor.getAttribute('aria-hidden'),
        hidden: anchor.hidden, inert: anchor.inert,
        display: anchor.style.getPropertyValue('display'), priority: anchor.style.getPropertyPriority('display'),
      });
      // CMS layout updates can remove our inline display rule. Observe only affected
      // links, not every animated style change elsewhere on these landing pages.
      if (win.MutationObserver && !guarded.has(anchor)) {
        styleGuard ||= new win.MutationObserver(records => records.forEach(record => {
          if (original.has(record.target)) update(record.target);
        }));
        styleGuard.observe(anchor, {attributes: true, attributeFilter: ['style']});
        guarded.add(anchor);
      }
      return original.get(anchor);
    }
    function restore(anchor) {
      const state = original.get(anchor);
      if (!state) return;
      for (const [key, value] of [['target', state.target], ['tabindex', state.tabindex], ['aria-hidden', state.ariaHidden]]) {
        if (value === null) anchor.removeAttribute(key);
        else anchor.setAttribute(key, value);
      }
      anchor.hidden = state.hidden; anchor.inert = state.inert;
      if (state.display) anchor.style.setProperty('display', state.display, state.priority);
      else anchor.style.removeProperty('display');
      original.delete(anchor);
    }
    function update(anchor) {
      const key = anchor.getAttribute('data-company-link');
      if (!keys.has(key) || (!original.has(anchor) && protectedLink(anchor, win.location.href))) return;
      if (!links[key]) {
        remember(anchor);
        if (key === 'booking') {
          const fallback = doc.getElementById('contacts') ? '#contacts' : 'index.html#contacts';
          if (!sameDestination(anchor.getAttribute('href'), fallback, win.location.href)) anchor.setAttribute('href', fallback);
          anchor.removeAttribute('target');
        } else {
          anchor.hidden = true; anchor.inert = true;
          anchor.setAttribute('aria-hidden', 'true'); anchor.setAttribute('tabindex', '-1');
          if (anchor.style.getPropertyValue('display') !== 'none' || anchor.style.getPropertyPriority('display') !== 'important') {
            anchor.style.setProperty('display', 'none', 'important');
          }
          anchor.removeAttribute('href');
        }
        return;
      }
      const previous = original.get(anchor)?.href || anchor.getAttribute('href');
      const next = destination(links[key], previous, key === 'booking' && anchor.hasAttribute('data-company-booking-detail'));
      restore(anchor);
      if (next && next !== anchor.getAttribute('href')) anchor.setAttribute('href', next);
    }
    function scan(node) {
      if (node.matches?.('a[data-company-link]')) update(node);
      node.querySelectorAll?.('a[data-company-link]').forEach(update);
    }
    const api = {get: key => keys.has(key) ? (links[key] || (loaded ? null : undefined)) : undefined};
    instances.set(doc, api);
    async function load() {
      const controller = win.AbortController ? new win.AbortController() : null;
      const timeout = controller ? win.setTimeout(() => controller.abort(), 8000) : null;
      try {
        const response = await win.fetch('/api/company-links', {credentials: 'omit', cache: 'no-store', ...(controller ? {signal: controller.signal} : {})});
        if (!response.ok) return false;
        const data = await response.json();
        if (data?.companyCode !== companyCode || !data.links || typeof data.links !== 'object' || Array.isArray(data.links)) return false;
        const next = {};
        for (const key of keys) {
          const url = safeUrl(data.links[key]);
          if (url) next[key] = url.href;
        }
        links = next; loaded = true;
        scan(doc);
        if (!observing && win.MutationObserver) new win.MutationObserver(records => records.forEach(record => {
          if (record.type === 'attributes') update(record.target);
          else record.addedNodes.forEach(scan);
        })).observe(doc.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['href', 'data-company-link']});
        // A just-inserted link can be clicked before its mutation callback runs.
        if (!observing) for (const type of ['click', 'auxclick']) doc.addEventListener(type, event => {
          const anchor = event.target?.closest?.('a[data-company-link]');
          if (anchor) update(anchor);
        }, true);
        observing = true;
        doc.dispatchEvent?.(new win.Event('synapse:company-links-ready'));
        return true;
      } catch (_) { return false; }
      finally { if (timeout !== null) win.clearTimeout(timeout); }
    }
    api.refresh = () => {
      if (!pending) pending = load().finally(() => { pending = null; });
      return pending;
    };
    api.ready = api.refresh();
    return api;
  }
  return {safeUrl, destination, protectedLink, start};
});

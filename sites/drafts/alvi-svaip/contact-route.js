/* Help and certificate actions open contact choices; named channels remain direct. */
(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (host && host.document) host.AlviContacts = api.start(host.document, host.location, host);
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  function isSocial(value, base) {
    try {
      const url = new URL(value, base);
      if (['whatsapp:', 'tg:', 'viber:'].includes(url.protocol)) return true;
      if (!['https:', 'http:'].includes(url.protocol)) return false;
      return /(^|\.)(wa\.me|whatsapp\.com|t\.me|telegram\.me|telegram\.org|vk\.com|vk\.me|vkontakte\.ru|instagram\.com|facebook\.com|fb\.com|messenger\.com|m\.me|ok\.ru|max\.ru)$/.test(url.hostname);
    } catch (_) { return false; }
  }
  const navigators = new WeakMap();
  const destinations = new Set(['#contacts', '#callback-form']);
  const helpLabels = new Set(['помочь с выбором', 'оформить сертификат', 'связаться с нами', 'узнать про абонемент']);
  const inactive = Object.freeze({navigate: () => false, cancel() {}});
  function isEditor(win, location) {
    try { return new URL(location.href).searchParams.get('edit') === '1' && Boolean(win?.parent) && win.parent !== win; }
    catch (_) { return false; }
  }
  function isHelpLink(anchor, location) {
    if (anchor.closest('#contacts,#faq,[data-contact-choices],[data-contact-direct]')) return false;
    const label = String(anchor.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!helpLabels.has(label)) return false;
    // An explicit channel label remains a channel choice even if its visible caption is generic.
    const accessible = [anchor.getAttribute('aria-label'), anchor.getAttribute('title')].filter(Boolean).join(' ');
    if (/telegram|телеграм|whatsapp|ватсап|\bmax\b|\bvk\b|вконтакте|instagram|facebook|viber/i.test(accessible)) return false;
    const href = anchor.getAttribute('href');
    return href === '#' || isSocial(href, location.href);
  }
  function createNavigation(win, doc) {
    if (!win || isEditor(win, win.location) || !doc.getElementById('contacts')) return inactive;
    if (navigators.has(doc)) return navigators.get(doc);
    let active = false, destination = '#contacts', layoutTimer = 0, firstFrame = 0, secondFrame = 0, restoredHash = null, focusOnAlign = false;
    let resizeObserver, contentObserver;
    function clearPending() {
      win.clearTimeout(layoutTimer);
      win.cancelAnimationFrame(firstFrame);
      win.cancelAnimationFrame(secondFrame);
      layoutTimer = firstFrame = secondFrame = 0;
    }
    function cancel() {
      active = false;
      focusOnAlign = false;
      clearPending();
      resizeObserver?.disconnect();
      contentObserver?.disconnect();
    }
    function align() {
      if (!active || win.location.hash !== destination) return;
      const target = doc.getElementById(destination.slice(1));
      if (!target) return;
      const margin = Number.parseFloat(win.getComputedStyle(target).scrollMarginTop) || 0;
      if (Math.abs(target.getBoundingClientRect().top - margin) > 1) {
        target.scrollIntoView({ block: 'start', behavior: 'instant' });
      }
      if (focusOnAlign) {
        focusOnAlign = false;
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }
    }
    function schedule() {
      if (!active) return;
      clearPending();
      // Let price insertion, hydrated text and font-driven measurements finish together.
      layoutTimer = win.setTimeout(() => {
        firstFrame = win.requestAnimationFrame(() => {
          secondFrame = win.requestAnimationFrame(align);
        });
      }, 120);
    }
    function begin(hash, focus = false) {
      cancel();
      destination = hash;
      active = true;
      focusOnAlign = focus;
      if (typeof win.ResizeObserver === 'function') {
        resizeObserver ||= new win.ResizeObserver(schedule);
        [doc.body, ...doc.querySelectorAll('section')].filter(Boolean).forEach(element => resizeObserver.observe(element));
      }
      if (typeof win.MutationObserver === 'function') {
        contentObserver ||= new win.MutationObserver(schedule);
        // Text hydration changes layout; animation style updates must not perpetually delay the anchor.
        contentObserver.observe(doc.body, { subtree: true, childList: true, characterData: true });
      }
      schedule();
    }
    function navigate(hash = '#contacts') {
      if (!destinations.has(hash)) return false;
      const target = doc.getElementById(hash.slice(1));
      if (!target) return false;
      restoredHash = null;
      if (win.location.hash !== hash) {
        const url = new URL(win.location.href);
        url.hash = hash;
        win.history.pushState(win.history.state, '', url.pathname + url.search + url.hash);
      }
      begin(hash, true);
      return true;
    }
    function clicked(event) {
      if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target?.closest?.('a[href]');
      if (!anchor || anchor.hasAttribute('download') || !['', '_self'].includes(anchor.getAttribute('target') || '')) return;
      let url;
      try { url = new URL(anchor.getAttribute('href'), win.location.href); } catch (_) { return; }
      const page = pathname => pathname.replace(/index\.html$/, '');
      if (url.origin !== win.location.origin || page(url.pathname) !== page(win.location.pathname) ||
          url.search !== win.location.search || !destinations.has(url.hash)) return;
      event.preventDefault();
      navigate(url.hash);
    }
    function interactiveTarget(target) {
      return Boolean(target?.closest?.('input,textarea,select,button,[contenteditable]:not([contenteditable="false"])'));
    }
    ['wheel', 'touchstart', 'pointerdown'].forEach(type => win.addEventListener(type, cancel, { passive: true, capture: true }));
    // Autofill and assistive tools can focus a field without a pointer or navigation key.
    doc.addEventListener('focusin', event => { if (interactiveTarget(event.target)) cancel(); }, true);
    win.addEventListener('keydown', event => {
      if (interactiveTarget(event.target) || ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Tab', 'Escape'].includes(event.key)) cancel();
    }, true);
    win.addEventListener('popstate', () => { restoredHash = win.location.hash; cancel(); });
    win.addEventListener('pageshow', event => { if (event.persisted) { restoredHash = win.location.hash; cancel(); } });
    win.addEventListener('pagehide', cancel);
    win.addEventListener('hashchange', () => {
      const restoring = restoredHash === win.location.hash;
      restoredHash = null;
      if (destinations.has(win.location.hash) && !restoring) begin(win.location.hash);
      else cancel();
    });
    win.addEventListener('resize', schedule, { passive: true });
    win.addEventListener('load', schedule);
    doc.addEventListener('click', clicked);
    doc.addEventListener('DOMContentLoaded', schedule);
    doc.addEventListener('alvi:price-ready', schedule);
    doc.addEventListener('load', schedule, true);
    doc.addEventListener('error', schedule, true);
    if (doc.fonts) {
      doc.fonts.ready.then(schedule, () => {});
      doc.fonts.addEventListener?.('loadingdone', schedule);
    }
    const api = { navigate, cancel };
    navigators.set(doc, api);
    const navigation = win.performance?.getEntriesByType?.('navigation')[0];
    if (destinations.has(win.location.hash) && navigation?.type !== 'back_forward') begin(win.location.hash);
    return api;
  }
  function start(doc, location, win = doc.defaultView) {
    if (isEditor(win, location)) return inactive;
    const destination = doc.getElementById('contacts') ? '#contacts' : 'index.html#contacts';
    function rewrite(anchor) {
      if (!isHelpLink(anchor, location)) return;
      anchor.setAttribute('href', destination);
      anchor.removeAttribute('target');
      anchor.setAttribute('data-contact-route', '');
    }
    function scan(node) {
      if (!node) return;
      const enclosing = node.closest?.('a[href]') || node.parentElement?.closest?.('a[href]');
      if (enclosing) rewrite(enclosing);
      if (node.matches && node.matches('a[href]')) rewrite(node);
      if (node.querySelectorAll) node.querySelectorAll('a[href]').forEach(rewrite);
    }
    scan(doc);
    // Price loading and site-editor hydration can add or replace links after first render.
    const Observer = win?.MutationObserver || (typeof MutationObserver === 'function' ? MutationObserver : null);
    if (Observer) new Observer(records => records.forEach(record => {
      if (record.type === 'attributes') rewrite(record.target);
      else if (record.type === 'characterData') {
        const anchor = record.target.parentElement?.closest?.('a[href]');
        if (anchor) rewrite(anchor);
      } else {
        // A CMS update may replace just the caption inside an existing anchor.
        scan(record.target);
        record.addedNodes.forEach(scan);
      }
    })).observe(doc.body, {subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['href']});
    return createNavigation(win, doc);
  }
  return {isSocial,isHelpLink,isEditor,start,createNavigation};
});

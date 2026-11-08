/* Keep a requested price anchor aligned while its catalogue, fonts and images load. */
(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (host && host.document) api.start(host, host.document);
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  function anchorId(hash) {
    if (typeof hash !== 'string' || hash[0] !== '#' || hash.length < 2) return null;
    try { return decodeURIComponent(hash.slice(1)); } catch (_) { return null; }
  }
  function start(win, doc) {
    if (win.AlviPriceNavigation) return win.AlviPriceNavigation;
    const content = doc.querySelector('.price-content');
    if (!content) return null;
    const header = doc.querySelector('.price-header');
    const embedded = doc.documentElement.classList.contains('alvi-price-embedded');
    let activeHash = '', focusedTarget = null, frame = 0, restoredHash = null;
    function validHash(hash) {
      const id = anchorId(hash);
      if (!id) return false;
      const target = doc.getElementById(id);
      // A standard catalogue anchor can arrive before its API-rendered target.
      return target ? content.contains(target) : /^(?:s\d+(?:-\d+)?|promo(?:-\d+)?)$/.test(id);
    }
    function offset() {
      let value = 24;
      if (header) {
        const css = win.getComputedStyle(header), bounds = header.getBoundingClientRect();
        if (css.display !== 'none' && css.visibility !== 'hidden' && bounds.height > 0 &&
            (css.position === 'sticky' || css.position === 'fixed')) {
          value = bounds.height + Math.max(0, parseFloat(css.top) || 0) + 16;
        }
      }
      const property = '--alvi-price-anchor-offset', next = Math.ceil(value) + 'px';
      if (doc.documentElement.style.getPropertyValue(property) !== next) doc.documentElement.style.setProperty(property, next);
      return Math.ceil(value);
    }
    function align() {
      frame = 0;
      const gap = offset();
      if (!activeHash) return;
      const target = doc.getElementById(anchorId(activeHash));
      if (!target || !content.contains(target)) return;
      if (focusedTarget !== target) {
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus({preventScroll: true});
        focusedTarget = target;
      }
      const maximum = Math.max(0, doc.documentElement.scrollHeight - win.innerHeight);
      const top = Math.max(0, Math.min(maximum, Math.round(win.scrollY + target.getBoundingClientRect().top - gap)));
      if (Math.abs(win.scrollY - top) > 1) win.scrollTo({top, behavior: 'instant'});
    }
    function refresh() { if (!frame) frame = win.requestAnimationFrame(align); }
    function cancel() {
      activeHash = ''; focusedTarget = null;
      if (frame) win.cancelAnimationFrame(frame);
      frame = 0;
    }
    function navigate(hash, options = {}) {
      if (!validHash(hash)) return false;
      restoredHash = null;
      if (options.history !== false && win.location.hash !== hash) {
        const method = (options.replace === undefined ? embedded : options.replace) ? 'replaceState' : 'pushState';
        win.history[method](win.history.state, '', hash);
      }
      activeHash = hash;
      focusedTarget = null;
      refresh();
      return true;
    }
    doc.addEventListener('click', event => {
      const link = event.target.closest && event.target.closest('a[href]');
      if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey ||
          event.shiftKey || event.altKey || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
      let url;
      try { url = new URL(link.href, win.location.href); } catch (_) { return; }
      const current = new URL(win.location.href);
      if (url.origin !== current.origin || url.pathname !== current.pathname || url.search !== current.search || !validHash(url.hash)) return;
      event.preventDefault();
      navigate(url.hash);
    });
    // User movement cancels alignment: late content must not pull a visitor back.
    for (const event of ['wheel', 'touchstart', 'pointerdown']) win.addEventListener(event, cancel, {passive: true, capture: true});
    const interactiveTarget = target => Boolean(target?.closest?.('input,textarea,select,button,[contenteditable]:not([contenteditable="false"])'));
    doc.addEventListener('focusin', event => { if (interactiveTarget(event.target)) cancel(); }, true);
    win.addEventListener('keydown', event => {
      if (interactiveTarget(event.target) || ['Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancel();
    }, true);
    win.addEventListener('popstate', () => { restoredHash = win.location.hash; cancel(); });
    win.addEventListener('pagehide', cancel);
    win.addEventListener('pageshow', event => {
      if (event.persisted) { restoredHash = win.location.hash; cancel(); }
      refresh();
    });
    win.addEventListener('hashchange', () => {
      const restoring = restoredHash === win.location.hash;
      restoredHash = null;
      if (restoring || !navigate(win.location.hash, {history: false})) cancel();
    });
    for (const event of ['resize', 'load']) win.addEventListener(event, refresh);
    doc.addEventListener('alvi:price-ready', refresh);
    for (const event of ['load', 'error']) doc.addEventListener(event, event => {
      if (event.target?.tagName === 'IMG') refresh();
    }, true);
    if (doc.fonts) {
      doc.fonts.ready.then(refresh).catch(() => {});
      doc.fonts.addEventListener?.('loadingdone', refresh);
    }
    if (win.ResizeObserver) {
      const observer = new win.ResizeObserver(refresh);
      for (const element of [content, header, doc.body]) if (element) observer.observe(element);
    }
    if (win.MutationObserver) new win.MutationObserver(refresh).observe(content, {childList: true, subtree: true});
    win.AlviPriceNavigation = {navigate, refresh, cancel};
    const navigation = win.performance?.getEntriesByType?.('navigation')[0];
    if (navigation?.type === 'back_forward') { restoredHash = win.location.hash; refresh(); }
    else if (!navigate(win.location.hash, {history: false})) refresh();
    return win.AlviPriceNavigation;
  }
  return {start, anchorId};
});

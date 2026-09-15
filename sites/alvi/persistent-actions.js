/* Keep booking actions available after the opening scene, with no duplicate in view. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) api.start(root, root.document);
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  function start(win, doc) {
    if (!doc.body || new URLSearchParams(win.location.search).get('edit') === '1') return null;
    const existing = doc.querySelector('.alvi-persistent-actions');
    if (existing) return existing;
    const source = doc.querySelector('.hero-scene[data-scene="0"] .floating-cta');
    if (!source) return null;

    const panel = doc.createElement('nav');
    panel.className = 'alvi-persistent-actions';
    panel.setAttribute('aria-label', 'Быстрая запись в ALVI');
    panel.setAttribute('aria-hidden', 'true');
    panel.inert = true;
    function cloneContent() {
      const clone = source.cloneNode(true);
      clone.className = 'alvi-persistent-actions__content';
      for (const element of [clone, ...clone.querySelectorAll('*')]) {
        element.removeAttribute('id');
        element.removeAttribute('data-edit');
      }
      // The source may already be hidden by the opening scene or its old footer rule.
      for (const attribute of ['style', 'hidden', 'inert', 'aria-hidden']) clone.removeAttribute(attribute);
      return clone;
    }
    let content = cloneContent(), contentPending = false;
    panel.append(content);
    doc.body.append(panel);

    let moving = false, idleTimer = 0, lastY = win.scrollY;
    const blockedFocus = 'input,textarea,select,[contenteditable]:not([contenteditable="false"])';
    function focusedInside() { return Boolean(doc.activeElement && panel.contains(doc.activeElement)); }
    function sourceVisible() {
      const bounds = source.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0 || bounds.bottom <= 0 || bounds.top >= win.innerHeight ||
          bounds.right <= 0 || bounds.left >= win.innerWidth) return false;
      for (let element = source; element && element !== doc.body; element = element.parentElement) {
        if (element.hidden || element.inert) return false;
        const css = win.getComputedStyle(element);
        if (css.display === 'none' || css.visibility === 'hidden' || css.visibility === 'collapse' ||
            Number.parseFloat(css.opacity) === 0 || (element === source && css.pointerEvents === 'none')) return false;
      }
      return true;
    }
    function blocked() {
      return Boolean(doc.querySelector('dialog[open],.promo.is-open,.cookie-notice:not(.hidden):not([hidden])') ||
        doc.documentElement.classList.contains('promo-open') ||
        (doc.activeElement && doc.activeElement.closest(blockedFocus)));
    }
    function render() {
      const focused = focusedInside();
      const visible = !blocked() && (focused || (!moving && !sourceVisible()));
      panel.classList.toggle('is-visible', visible);
      panel.classList.toggle('is-scrolling', moving && !focused);
      if (panel.inert === visible) panel.inert = !visible;
      const hidden = String(!visible);
      if (panel.getAttribute('aria-hidden') !== hidden) panel.setAttribute('aria-hidden', hidden);
    }
    function measure() {
      const height = Math.ceil(panel.getBoundingClientRect().height);
      const name = '--alvi-persistent-actions-height';
      if (height > 0 && doc.documentElement.style.getPropertyValue(name) !== height + 'px') {
        // Reserve a stable footer space; hiding during scroll must not change page height.
        doc.documentElement.style.setProperty(name, height + 'px');
      }
    }
    function syncContent() {
      // Site content can arrive after this script; never replace a focused link.
      if (focusedInside()) { contentPending = true; return; }
      const next = cloneContent();
      content.replaceWith(next);
      content = next;
      contentPending = false;
      measure();
      render();
    }
    function scroll() {
      if (Math.abs(win.scrollY - lastY) < 1) return;
      lastY = win.scrollY;
      moving = true;
      win.clearTimeout(idleTimer);
      render();
      idleTimer = win.setTimeout(() => { moving = false; render(); }, 220);
    }
    function resize() { measure(); render(); }
    win.addEventListener('scroll', scroll, { passive: true });
    win.addEventListener('resize', resize, { passive: true });
    doc.addEventListener('focusin', render);
    doc.addEventListener('focusout', () => win.setTimeout(() => {
      if (contentPending) syncContent();
      else render();
    }, 0));
    doc.addEventListener('toggle', render, true);
    doc.addEventListener('close', render, true);
    if (win.visualViewport) win.visualViewport.addEventListener('resize', resize, { passive: true });

    if (typeof win.IntersectionObserver === 'function') {
      const observer = new win.IntersectionObserver(render, { threshold: 0 });
      observer.observe(source);
    }
    if (typeof win.MutationObserver === 'function') {
      const observer = new win.MutationObserver(render);
      const targets = new Set(doc.querySelectorAll('dialog,.promo,.cookie-notice'));
      for (let element = source; element; element = element.parentElement) targets.add(element);
      targets.forEach(element => observer.observe(element, {
        attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert', 'open'],
      }));
      const contentObserver = new win.MutationObserver(syncContent);
      contentObserver.observe(source, {
        subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['href', 'target', 'rel', 'aria-label'],
      });
    }
    if (typeof win.ResizeObserver === 'function') {
      const observer = new win.ResizeObserver(resize);
      observer.observe(panel);
      observer.observe(source);
    }
    render();
    measure();
    return panel;
  }
  return { start };
});

/* Keep the existing compact hero media attached to the viewport, outside clipping ancestors. */
(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (host && host.document) {
    const boot = () => api.start(host, host.document);
    if (host.document.readyState === 'loading') host.document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
  }
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  function clipForBounds(bounds, height, viewportHeight = height) {
    const limit = Math.max(0, height);
    const clamp = value => Math.max(0, Math.min(limit, value));
    return {
      top: clamp(bounds.top),
      bottom: clamp(limit - bounds.bottom),
      visible: limit > 0 && bounds.bottom > 0 && bounds.top < viewportHeight
    };
  }

  function start(win, doc) {
    const hero = doc.getElementById('hero');
    const media = hero && hero.querySelector('.hero__media');
    if (!hero || !media || !doc.body) return null;
    const originalParent = media.parentNode;
    const placeholder = doc.createComment('ALVI hero media');
    let portal = null;
    let scheduled = 0;
    let destroyed = false;
    const setClass = (element, name, enabled) => {
      if (element.classList.contains(name) !== enabled) element.classList.toggle(name, enabled);
    };
    const isEditor = () => new URLSearchParams(win.location.search).get('edit') === '1'
      || doc.documentElement.classList.contains('edit-full');
    const restore = () => {
      if (portal) {
        if (placeholder.parentNode) placeholder.parentNode.replaceChild(media, placeholder);
        else originalParent.appendChild(media);
        portal.remove();
        portal = null;
      }
      setClass(hero, 'has-fixed-background', false);
    };
    const mount = () => {
      if (portal) return;
      media.parentNode.insertBefore(placeholder, media);
      portal = doc.createElement('div');
      portal.className = 'hero is-compact-mode alvi-hero-backdrop';
      portal.setAttribute('aria-hidden', 'true');
      portal.appendChild(media);
      doc.body.appendChild(portal);
      setClass(hero, 'has-fixed-background', true);
    };
    const sync = () => {
      if (destroyed) return;
      if (!hero.classList.contains('is-compact-mode') || isEditor()) {
        restore();
        return;
      }
      mount();
      for (const name of ['is-compact-final', 'is-reduced-motion']) setClass(portal, name, hero.classList.contains(name));
      const height = portal.clientHeight || win.innerHeight;
      const clip = clipForBounds(hero.getBoundingClientRect(), height, win.innerHeight);
      setClass(portal, 'is-visible', clip.visible);
      for (const [name, value] of [['top', clip.top], ['bottom', clip.bottom]]) {
        const key = '--alvi-hero-clip-' + name;
        const next = Math.round(value * 100) / 100 + 'px';
        if (portal.style.getPropertyValue(key) !== next) portal.style.setProperty(key, next);
      }
    };
    const schedule = () => {
      if (scheduled || destroyed) return;
      scheduled = win.requestAnimationFrame(() => {
        scheduled = 0;
        sync();
      });
    };
    const observer = new win.MutationObserver(schedule);
    observer.observe(hero, { attributes: true, attributeFilter: ['class'] });
    observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] });
    for (const event of ['scroll', 'resize', 'pageshow']) win.addEventListener(event, schedule, { passive: true });
    if (win.visualViewport) win.visualViewport.addEventListener('resize', schedule, { passive: true });
    sync();
    return {
      sync,
      destroy() {
        destroyed = true;
        observer.disconnect();
        if (scheduled) win.cancelAnimationFrame(scheduled);
        for (const event of ['scroll', 'resize', 'pageshow']) win.removeEventListener(event, schedule);
        if (win.visualViewport) win.visualViewport.removeEventListener('resize', schedule);
        restore();
      }
    };
  }
  return { clipForBounds, start };
});

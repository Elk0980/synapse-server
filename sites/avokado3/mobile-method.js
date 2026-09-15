/* Give long mobile slides enough scroll distance to read every card. */
(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (host && host.document) host.AvokadoMobileSlides = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const clamp = n => Math.max(0, Math.min(1, n));
  function weightFor(overflow, unit) { return 1 + Math.max(0, overflow) / Math.max(1, unit); }
  function panFor(progress, overflow) {
    const p = clamp((progress - .15) / .7);
    return Math.max(0, overflow) * p * p * (3 - 2 * p);
  }
  function create(root, scenes) {
    const entries = scenes.flatMap((scene, index) => {
      if (!['method-0', 'method-1', 'method-2', 'method-4'].includes(scene.id)) return [];
      const viewport = document.createElement('div');
      viewport.className = 'mobile-method-viewport';
      const track = document.createElement('div');
      track.className = 'mobile-method-track';
      Array.from(scene.children).filter(el => !el.classList.contains('section-backdrop')).forEach(el => track.append(el));
      viewport.append(track);
      scene.append(viewport);
      return [{ scene, index, viewport, track, overflow: 0 }];
    });
    let enabled = false;
    return {
      measure(unit) {
        enabled = getComputedStyle(root).getPropertyValue('--mobile-method-scroll').trim() === '1';
        const weights = [];
        entries.forEach(entry => {
          entry.overflow = enabled ? Math.max(0, entry.track.scrollHeight - entry.viewport.clientHeight) : 0;
          weights[entry.index] = weightFor(entry.overflow, unit);
        });
        return weights;
      },
      update(frame) {
        entries.forEach(entry => {
          const progress = frame.index < entry.index ? 0 : frame.index > entry.index ? 1 : frame.slideProgress;
          const pan = enabled ? panFor(progress, entry.overflow) : 0;
          entry.track.style.setProperty('--mobile-method-pan', (-pan).toFixed(2) + 'px');
        });
      }
    };
  }
  return { create, weightFor, panFor };
});

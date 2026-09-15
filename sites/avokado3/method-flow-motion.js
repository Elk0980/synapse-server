/* Scroll-driven motion for natural-height layouts, without a clipped inner scroller. */
(function (host, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (host && host.document) host.AvokadoFlowMotion = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const clamp = n => Math.max(0, Math.min(1, n));
  function revealAt(top, height, bottom) {
    const distance = Math.min(120, Math.max(48, height * .6));
    return clamp((bottom - top) / distance);
  }
  function workPlan(viewport, header, content, count, reduced) {
    const available = Math.max(0, viewport - header - 112);
    const enabled = !reduced && content > 0 && content <= available;
    return { enabled, travel: enabled ? available * Math.max(0, count - 1) * 1.15 : 0 };
  }
  function create(root, work) {
    const scene = root.querySelector('#method-5');
    const copy = scene && scene.querySelector('.work-copy');
    const pairs = scene ? Array.from(scene.querySelectorAll('.work-pair')) : [];
    const items = Array.from(root.querySelectorAll('.paper-questions, .paper-answer h3, .paper-argument, .apparatus-grid figure'));
    let enabled = false;
    function reset() {
      root.classList.remove('flow-motion');
      if (scene) {
        scene.classList.remove('flow-work-measure', 'flow-work-slider');
        scene.style.removeProperty('height');
      }
      enabled = false;
    }
    function update(reduced) {
      root.classList.add('flow-motion');
      const header = (document.getElementById('hdr')?.getBoundingClientRect().height || 64) + 12;
      // Use the stable small viewport on mobile so browser toolbar changes don't shift slides.
      const viewport = Math.min(window.innerHeight, root.querySelector('.flow-height-probe')?.clientHeight || window.innerHeight);
      if (copy && work) {
        scene.classList.add('flow-work-measure');
        scene.style.setProperty('--flow-work-top', header + 'px');
        const content = copy.scrollHeight;
        const plan = workPlan(viewport, header, content, pairs.length, reduced);
        scene.classList.toggle('flow-work-slider', plan.enabled);
        if (plan.enabled) {
          scene.style.height = Math.ceil(content + plan.travel + 48) + 'px';
          const offset = header - scene.getBoundingClientRect().top - 24;
          const phase = clamp(offset / Math.max(1, plan.travel)) * (pairs.length - 1) + .35;
          work.update(phase, true, reduced);
        } else {
          scene.classList.remove('flow-work-measure');
          scene.style.removeProperty('height');
          pairs.forEach(pair => { pair.inert = false; pair.setAttribute('aria-hidden', 'false'); });
          const next = scene.querySelector('.flow-next');
          if (next) { next.style.removeProperty('visibility'); next.inert = false; }
        }
        enabled = plan.enabled;
      }
      const bottom = viewport - 108;
      [...items, ...(enabled ? [] : pairs)].forEach(element => {
        element.classList.add('flow-reveal');
        const rect = element.getBoundingClientRect();
        const progress = reduced ? 1 : revealAt(rect.top, rect.height, bottom);
        element.style.setProperty('--flow-reveal', progress.toFixed(4));
      });
    }
    const probe = document.createElement('div');
    probe.className = 'flow-height-probe';
    probe.setAttribute('aria-hidden', 'true');
    root.append(probe);
    return { update, reset };
  }
  return { revealAt, workPlan, create };
});

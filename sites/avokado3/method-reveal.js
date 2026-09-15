/* Scroll-only sequencing for the existing objection slide. No timer/autoplay. */
(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (host && host.document) host.AvokadoMethod = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const settle = value => 1 - Math.pow(1 - clamp(value, 0, 1), 3);

  // Normal slides keep their former scroll distance. Only the target is extended.
  function frameAt(offset, unit, count, target, beats) {
    const safeUnit = Math.max(1, unit);
    const targetWeight = (beats + 0.8) / 1.36;
    const total = count - 1 + targetWeight;
    let cursor = clamp(offset / safeUnit, 0, total - 0.00001);
    let index = 0;
    for (; index < count - 1; index++) {
      const weight = index === target ? targetWeight : 1;
      if (cursor < weight) break;
      cursor -= weight;
    }
    const phase = index < target ? 0 : index > target ? beats + 0.8 : cursor * 1.36;
    const reveals = Array.from({ length: beats }, (_, i) => settle((phase - i) / 0.55));
    return { index, phase, reveals, totalUnits: total };
  }

  // On a short screen keep the newly revealed text above the booking button.
  // Previous text remains in the same layout; the whole layout moves smoothly.
  function panAt(frame, bottoms, available, height) {
    const max = Math.max(0, height - available);
    let pan = 0;
    for (let i = 0; i < frame.reveals.length; i++) {
      const target = clamp((bottoms[i] || 0) - available + 10, 0, max);
      pan += (Math.max(pan, target) - pan) * frame.reveals[i];
    }
    return pan;
  }

  const states = new WeakMap();
  function createState(root, scenes) {
    const scene = root.querySelector('#method-3');
    const copy = scene && scene.querySelector('.scene-two');
    const panels = copy && Array.from(copy.children);
    const paragraphs = panels && panels[1] && Array.from(panels[1].children).filter(el => el.tagName === 'P');
    if (!copy || panels.length !== 2 || paragraphs.length !== 4) return null;
    if (getComputedStyle(root).getPropertyValue('--paper-style-ready').trim() !== '1') return null;
    const heading = panels[1].querySelector('h3');
    const sticky = root.querySelector('.method-sticky');
    if (!heading || !sticky) return null;
    const viewport = document.createElement('div');
    viewport.className = 'paper-viewport';
    copy.before(viewport);
    viewport.append(copy);
    copy.classList.add('paper-layout');
    panels[0].classList.add('paper-questions', 'paper-sheet');
    panels[1].classList.add('paper-answer', 'paper-sheet');
    const arguments_ = paragraphs.map(p => {
      const wrapper = document.createElement('div');
      wrapper.className = 'paper-argument paper-sheet';
      p.before(wrapper);
      wrapper.append(p);
      return wrapper;
    });
    const state = {
      root, scenes, scene, copy, panels, viewport, sticky,
      elements: [panels[0], panels[1], ...arguments_],
      focus: [panels[0], heading, ...arguments_],
      target: scenes.indexOf(scene), lastIndex: -1, measured: false,
      reduced: matchMedia('(prefers-reduced-motion: reduce)'),
      editor: new URLSearchParams(location.search).get('edit') === '1'
    };
    if (state.target < 0) return null;
    states.set(root, state);
    root.classList.add('method-paper-ready');
    state.reduced.addEventListener('change', () => update(root, scenes));
    if (typeof ResizeObserver !== 'undefined') {
      let pending = false;
      state.observer = new ResizeObserver(() => {
        state.measured = false;
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; update(root, scenes); });
      });
      state.observer.observe(copy);
      state.observer.observe(viewport);
    }
    return state;
  }

  function relativeBottom(el, ancestor) {
    let bottom = el.offsetHeight;
    for (let node = el; node && node !== ancestor; node = node.offsetParent) bottom += node.offsetTop;
    return bottom;
  }

  function update(root, scenes) {
    const state = states.get(root) || createState(root, scenes);
    if (!state) return false;
    const height = state.sticky.clientHeight;
    if (!height) return false;
    const unit = height * 5 / 6;
    const plan = frameAt(0, unit, scenes.length, state.target, state.elements.length);
    const desiredHeight = Math.ceil(height + unit * plan.totalUnits);
    if (root.style.height !== desiredHeight + 'px') root.style.height = desiredHeight + 'px';
    const frame = frameAt(-root.getBoundingClientRect().top, unit, scenes.length, state.target, state.elements.length);
    if (state.lastIndex !== frame.index) {
      scenes.forEach((scene, i) => {
        scene.classList.toggle('active', i === frame.index);
        scene.setAttribute('aria-hidden', String(i !== frame.index));
        scene.inert = i !== frame.index;
      });
      state.lastIndex = frame.index;
    }
    state.scene.dataset.paperPhase = frame.phase.toFixed(3);
    state.elements.forEach((el, i) => {
      const progress = state.editor ? 1 : frame.reveals[i];
      const visible = state.reduced.matches ? (progress > 0.1 ? 1 : 0) : progress;
      el.style.setProperty('--paper-opacity', visible.toFixed(4));
      el.style.setProperty('--paper-y', (-26 * (1 - progress)).toFixed(2) + 'px');
      el.style.setProperty('--paper-x-tilt', (9 * (1 - progress)).toFixed(2) + 'deg');
      el.style.setProperty('--paper-z-tilt', (-0.7 * (1 - progress)).toFixed(2) + 'deg');
      el.style.setProperty('--paper-scale', (0.985 + 0.015 * progress).toFixed(4));
      el.style.setProperty('--paper-shadow', (18 * (1 - progress)).toFixed(2) + 'px');
      el.setAttribute('aria-hidden', String(progress < 0.1));
    });
    if (!state.measured) {
      state.bottoms = state.focus.map(el => relativeBottom(el, state.copy));
      state.copyHeight = state.copy.offsetHeight;
      state.available = state.viewport.clientHeight;
      state.measured = true;
    }
    const pan = panAt(frame, state.bottoms, state.available, state.copyHeight);
    state.copy.style.setProperty('--paper-pan', -pan.toFixed(2) + 'px');
    return true;
  }
  return { frameAt, panAt, update };
});

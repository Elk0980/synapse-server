/* One existing visit step and its photograph per scroll beat. */
(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (host && host.document) host.AvokadoWorkSteps = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const clamp = value => Math.max(0, Math.min(1, value));
  const smooth = value => { const x = clamp(value); return x * x * (3 - 2 * x); };
  const MEDIA = [
    { src: 'assets/work-introduction-20260915.webp', alt: 'Специалист беседует с клиенткой перед процедурой.', focus: '50% 26%', width: 1365, height: 2048 },
    { src: 'assets/work-assessment-20260915.webp', alt: 'Руки специалиста на животе клиентки во время осмотра.', focus: '50% 47%', width: 1365, height: 2048 },
    { src: 'assets/work-treatment-20260915.webp', alt: 'Специалист проводит аппаратную процедуру в области живота.', focus: '50% 48%', width: 1365, height: 2048 },
    { src: 'assets/work-decision-20260915.webp', alt: 'Женщина в чёрном платье у открытой двери студии.', focus: '35% 50%', width: 1672, height: 941 }
  ];

  function framesAt(phase, count, reduced) {
    const active = Math.max(0, Math.min(count - 1, Math.floor(phase + .04)));
    return Array.from({ length: count }, (_, i) => {
      if (reduced) return { opacity: i === active ? 1 : 0, y: 0, scale: 1, active: i === active };
      const enter = i === 0 ? 1 : smooth((phase - i + .06) / .28);
      const leave = i === count - 1 ? 0 : smooth((phase - i - .72) / .28);
      return {
        opacity: enter * (1 - leave),
        y: 32 * (1 - enter) - 24 * leave,
        scale: 1.012 - .012 * enter - .008 * leave,
        active: i === active
      };
    });
  }

  function create(root, scenes) {
    const scene = root.querySelector('#method-5');
    const grid = scene && scene.querySelector('.method-steps');
    const copy = scene && scene.querySelector('.scene-copy');
    const heading = scene && scene.querySelector('h2');
    const cards = grid && Array.from(grid.children);
    if (!cards || cards.length !== MEDIA.length || MEDIA.some(photo => !photo)) return null;
    if (getComputedStyle(root).getPropertyValue('--work-steps-style-ready').trim() !== '1') return null;
    const target = scenes.indexOf(scene);
    if (target < 0 || !copy || !heading) return null;
    const pairs = cards.map((card, index) => {
      const photo = MEDIA[index];
      const pair = document.createElement('article');
      pair.className = 'work-pair';
      pair.dataset.step = String(index + 1);
      const figure = document.createElement('figure');
      figure.className = 'work-pair__photo';
      const img = document.createElement('img');
      img.src = photo.src;
      img.alt = photo.alt;
      img.width = photo.width;
      img.height = photo.height;
      img.decoding = 'async';
      img.loading = 'lazy';
      img.style.objectPosition = photo.focus;
      figure.append(img);
      card.before(pair);
      pair.append(figure, card);
      card.classList.add('work-pair__copy');
      return pair;
    });
    grid.classList.add('work-pairs');
    copy.classList.add('work-copy');
    const counter = document.createElement('span');
    counter.className = 'work-counter';
    counter.setAttribute('aria-hidden', 'true');
    const headingRow = document.createElement('div');
    headingRow.className = 'work-heading';
    heading.before(headingRow);
    headingRow.append(heading, counter);
    scene.classList.add('work-steps-ready');
    const nextLink = scene.querySelector('.flow-next');
    let previous = -1;
    return {
      target,
      count: pairs.length,
      unitSpan: 1.15,
      update(phase, visible, reduced) {
        const frames = framesAt(phase, pairs.length, reduced);
        const overflow = pairs.map(pair => Math.max(0, pair.scrollHeight - grid.clientHeight));
        frames.forEach((frame, index) => {
          const pair = pairs[index];
          const pan = overflow[index] * smooth((phase - index - .22) / .42);
          pair.style.setProperty('--work-opacity', frame.opacity.toFixed(4));
          pair.style.setProperty('--work-y', (frame.y - pan).toFixed(2) + 'px');
          pair.style.setProperty('--work-pan', -pan.toFixed(2) + 'px');
          pair.style.setProperty('--work-scale', frame.scale.toFixed(4));
          pair.setAttribute('aria-hidden', String(!visible || !frame.active));
          pair.inert = !visible || !frame.active;
          pair.classList.toggle('is-current', visible && frame.active);
          if (visible && frame.active && previous !== index) {
            counter.textContent = String(index + 1).padStart(2, '0') + ' / ' + String(pairs.length).padStart(2, '0');
            // Warm the current and next image when this slide becomes relevant.
            pairs.slice(index, index + 2).forEach(next => { next.querySelector('img').loading = 'eager'; });
            previous = index;
          }
        });
        if (nextLink) {
          const lastReady = visible && frames[frames.length - 1].opacity > .99;
          nextLink.style.visibility = lastReady ? 'visible' : 'hidden';
          nextLink.inert = !lastReady;
        }
      }
    };
  }

  return { framesAt, create };
});

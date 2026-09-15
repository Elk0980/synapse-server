(function () {
  'use strict';
  const header = document.querySelector('.av-shell-header');
  const nav = document.querySelector('.av-price-navigation');
  const menu = nav && nav.querySelector('details');
  const content = document.getElementById('av-catalog-content');
  if (!header || !nav || !menu || !content) return;
  const compact = matchMedia('(max-width:980px)');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const video = document.querySelector('.av-page-backdrop video');
  let anchors = [];
  let sections = [];
  const measure = () => {
    const h = header.getBoundingClientRect().height;
    document.body.style.setProperty('--av-shell-height', h + 'px');
    document.body.style.setProperty('--av-anchor-offset', (h + (compact.matches ? 68 : 24)) + 'px');
  };
  function markCurrent() {
    if (!sections.length) return;
    const offset = parseFloat(getComputedStyle(document.body).getPropertyValue('--av-anchor-offset')) || 100;
    const current = sections.reduce((chosen, el) => el.getBoundingClientRect().top <= offset + 20 ? el : chosen, sections[0]);
    anchors.forEach(a => {
      if (a.hash === '#' + current.id) a.setAttribute('aria-current', 'location');
      else a.removeAttribute('aria-current');
    });
  }
  function connect() {
    if (!content.querySelector('.av-direction')) return;
    nav.querySelectorAll('.av-price-subnav').forEach(el => el.remove());
    nav.querySelectorAll('[data-price-group]').forEach(li => {
      const group = document.getElementById(li.dataset.priceGroup);
      li.hidden = !group;
      if (!group) return;
      if (li.dataset.priceGroup === 'subscriptions') li.querySelector('a').textContent = group.querySelector('h2').textContent;
      const categories = group.querySelectorAll('.av-category');
      if (!categories.length) return;
      const list = document.createElement('ul');
      list.className = 'av-price-subnav';
      categories.forEach(section => {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = '#' + section.id;
        link.textContent = section.querySelector('.av-category-title').textContent;
        item.append(link);list.append(item);
      });
      li.append(list);
    });
    anchors = Array.from(nav.querySelectorAll('a[href^="#"]'));
    sections = Array.from(content.querySelectorAll('.av-direction,.av-category'));
    markCurrent();
  }
  const fitMenu = () => { menu.open = !compact.matches; measure(); };
  compact.addEventListener('change', fitMenu);
  fitMenu();
  nav.addEventListener('click', event => { if (event.target.closest('a') && compact.matches) menu.open = false; });
  let queued = false;
  addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; markCurrent(); }); } }, { passive: true });
  addEventListener('resize', measure, { passive: true });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measure).observe(header);
  document.addEventListener('avokado:catalog-ready', connect);
  connect();
  function syncVideo() {
    if (!video) return;
    if (document.hidden || reduced.matches) video.pause();
    else video.play().catch(() => {});
  }
  document.addEventListener('visibilitychange', syncVideo);
  reduced.addEventListener('change', syncVideo);
  syncVideo();
})();

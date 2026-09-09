/* Progressive mobile navigation. Native links and desktop initNav remain in place. */
(() => {
  'use strict';
  const nav = document.querySelector('.price-page .pnav');
  const list = nav && nav.querySelector(':scope > ul');
  if (!nav || !list || !window.matchMedia) return;

  const mobile = window.matchMedia('(max-width: 56.24rem)');
  const header = document.querySelector('.price-page .price-header');
  const home = document.createComment('price navigation desktop position');
  nav.before(home);
  let toggle;
  let nextId = 0;

  function measureHeader() {
    if (mobile.matches && header) {
      document.documentElement.style.setProperty('--price-header-height', `${Math.ceil(header.getBoundingClientRect().height)}px`);
    }
  }

  function setOpen(open, returnFocus = false) {
    nav.classList.toggle('is-mobile-open', open);
    if (toggle) toggle.setAttribute('aria-expanded', String(open));
    if (!open) {
      list.querySelectorAll('.is-mobile-expanded').forEach((item) => {
        item.classList.remove('is-mobile-expanded');
        item.querySelector('.pnav__expand').setAttribute('aria-expanded', 'false');
      });
    }
    if (returnFocus && toggle) toggle.focus({ preventScroll: true });
  }

  function enhance() {
    if (!mobile.matches) return;
    if (header && nav.parentElement !== header) {
      header.append(nav);
      header.classList.add('has-mobile-nav');
    }
    if (!toggle) {
      if (!list.id) list.id = 'price-mobile-sections';
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'pnav__mobile-toggle';
      toggle.textContent = 'Выбрать ритуал';
      toggle.setAttribute('aria-controls', list.id);
      toggle.setAttribute('aria-expanded', 'false');
      toggle.addEventListener('click', () => setOpen(!nav.classList.contains('is-mobile-open')));
      nav.insertBefore(toggle, list);
      nav.classList.add('is-mobile-enhanced');
    }
    list.querySelectorAll(':scope > li.has-sub').forEach((item) => {
      const top = item.querySelector(':scope > .pnav__top');
      const sub = item.querySelector(':scope > .pnav__sub');
      if (!top || !sub || item.querySelector(':scope > .pnav__expand')) return;
      if (!sub.id) sub.id = `price-mobile-services-${++nextId}`;
      const expand = document.createElement('button');
      expand.type = 'button';
      expand.className = 'pnav__expand';
      expand.setAttribute('aria-label', `Услуги: ${top.textContent.trim()}`);
      expand.setAttribute('aria-controls', sub.id);
      expand.setAttribute('aria-expanded', 'false');
      item.insertBefore(expand, sub);
    });
    measureHeader();
  }

  nav.addEventListener('click', (event) => {
    if (!mobile.matches) return;
    const expand = event.target.closest('.pnav__expand');
    if (expand && nav.contains(expand)) {
      const item = expand.parentElement;
      const open = !item.classList.contains('is-mobile-expanded');
      list.querySelectorAll('.is-mobile-expanded').forEach((other) => {
        other.classList.remove('is-mobile-expanded');
        other.querySelector('.pnav__expand').setAttribute('aria-expanded', 'false');
      });
      item.classList.toggle('is-mobile-expanded', open);
      expand.setAttribute('aria-expanded', String(open));
      return;
    }
    const link = event.target.closest('a[href^="#"]');
    if (!link || !nav.contains(link)) return;
    setOpen(false);
    // Move keyboard focus out of the now-collapsed list; the native anchor scrolls.
    const destination = document.getElementById(link.hash.slice(1));
    if (destination) {
      if (!destination.hasAttribute('tabindex')) destination.setAttribute('tabindex', '-1');
      destination.focus({ preventScroll: true });
    }
  });

  nav.addEventListener('keydown', (event) => {
    if (!mobile.matches || event.key !== 'Escape' || !nav.classList.contains('is-mobile-open')) return;
    event.preventDefault();
    setOpen(false, true);
  });

  const onViewportChange = () => {
    if (mobile.matches) enhance();
    else if (toggle) {
      const active = document.activeElement;
      // A control disappearing at the breakpoint must not retain invisible focus.
      const restoreFocus = active && (active === toggle || active.classList.contains('pnav__expand'));
      setOpen(false);
      home.parentNode.insertBefore(nav, home.nextSibling);
      if (header) header.classList.remove('has-mobile-nav');
      document.documentElement.style.removeProperty('--price-header-height');
      if (restoreFocus) {
        const link = active === toggle ? list.querySelector('a') : active.parentElement.querySelector('a');
        if (link) link.focus({ preventScroll: true });
      }
    }
  };
  if (mobile.addEventListener) mobile.addEventListener('change', onViewportChange);
  else mobile.addListener(onViewportChange);

  document.addEventListener('click', (event) => {
    if (mobile.matches && !nav.contains(event.target)) setOpen(false);
  });
  if (header && window.ResizeObserver) new ResizeObserver(measureHeader).observe(header);

  // hydratePrice replaces the list asynchronously; delegated clicks and new controls survive it.
  new MutationObserver(enhance).observe(list, { childList: true, subtree: true });
  enhance();
})();

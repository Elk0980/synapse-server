/* Two-brand banner: one suggestion after reviews, with an explicit reopen link. */
(function () {
  'use strict';
  const promo = document.getElementById('promo');
  if (!promo) return;
  const site = promo.dataset.promoSite;
  const trigger = document.querySelector(promo.dataset.promoTrigger);
  const edit = new URLSearchParams(location.search).get('edit') === '1';
  const key = site + '_subscription_promo_shown';
  const closeButton = promo.querySelector('.promo__close');
  const body = promo.querySelector('.promo__body');
  let shown = false, previousFocus = null, timer = 0;
  try { shown = sessionStorage.getItem(key) === '1'; } catch (_) {}
  function close({ restoreFocus = true } = {}) {
    if (!promo.classList.contains('is-open')) return;
    promo.classList.remove('is-open');
    document.documentElement.classList.remove('promo-open');
    if (promo.open) promo.close();
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    else closeButton.blur();
  }
  function open() {
    clearTimeout(timer);
    if (promo.hidden || promo.classList.contains('is-open') || document.querySelector('dialog[open]')) return;
    if (typeof promo.showModal !== 'function' && !edit) return;
    previousFocus = document.activeElement;
    if (body) body.scrollTop = 0;
    promo.classList.add('is-open');
    if (!edit) {
      promo.showModal();
      document.documentElement.classList.add('promo-open');
      shown = true;
      try { sessionStorage.setItem(key, '1'); } catch (_) {}
    }
    closeButton.focus({ preventScroll: true });
  }
  closeButton.addEventListener('click', () => close());
  promo.addEventListener('cancel', event => { event.preventDefault(); close(); });
  promo.addEventListener('click', event => {
    if (event.target === promo) { close(); return; }
    const link = event.target.closest('a[href]');
    if (edit || !link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    let url;
    try { url = new URL(link.href, location.href); } catch (_) { return; }
    close({ restoreFocus: false });
    const home = new URL('index.html', location.href);
    const ownHome = url.origin === home.origin && [home.pathname, home.pathname.replace(/index\.html$/, '')].includes(url.pathname);
    if (ownHome && !url.hash) {
      event.preventDefault();
      const target = document.querySelector('header') || document.body;
      if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);
      target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
    // Same-origin price clicks continue to the existing price-overlay listener,
    // so the home document and its music remain alive.
  });
  document.querySelectorAll('[data-promo-open]').forEach(button => {
    button.hidden = false;
    button.addEventListener('click', event => { event.preventDefault(); open(); });
  });
  promo.querySelectorAll('.promo__portrait').forEach(img => {
    img.addEventListener('error', () => { img.hidden = true; });
    img.addEventListener('load', () => { img.hidden = false; });
  });
  // Legacy editor/price-overlay entry points are kept for both brands.
  window.alviPromoOpen = open;
  window.alviPromoClose = close;
  window.SubscriptionPromo = { open, close };
  if (edit || shown || !trigger) return;
  function visible() {
    const rect = trigger.getBoundingClientRect(), style = getComputedStyle(trigger);
    return rect.top < innerHeight * .8 && rect.bottom > innerHeight * .2 && Number(style.opacity) > .5 && style.visibility !== 'hidden';
  }
  function check() {
    clearTimeout(timer);
    if (shown || !visible()) return;
    timer = setTimeout(() => { if (!shown && visible() && !document.hidden) open(); }, 350);
  }
  window.addEventListener('scroll', check, { passive: true });
  window.addEventListener('resize', check, { passive: true });
  if ('IntersectionObserver' in window) new IntersectionObserver(check, { threshold: [0, .35] }).observe(trigger);
  check();
})();

/* Keep the home document and its audio alive while visitors browse the full price. */
(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (host && host.document) api.start(host, host.document);
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  function priceUrl(value, base) {
    try {
      const url = new URL(value, base), here = new URL(base);
      return url.origin === here.origin && url.pathname === new URL('price.html', here).pathname ? url : null;
    } catch (_) { return null; }
  }
  function ordinaryClick(event, anchor) {
    return anchor && !event.defaultPrevented && event.button === 0 && !event.ctrlKey && !event.metaKey &&
      !event.shiftKey && !event.altKey && !anchor.hasAttribute('download') &&
      (!anchor.target || anchor.target === '_self');
  }
  function start(win, doc) {
    if (doc.body.hasAttribute('data-full-price') || new URLSearchParams(win.location.search).get('edit') === '1') return;
    const dialog = doc.createElement('dialog');
    if (typeof dialog.showModal !== 'function') return;
    dialog.className = 'av-price-dialog';
    dialog.setAttribute('aria-label', 'Полный прайс АВОКАДО');
    dialog.innerHTML = '<div class="av-price-dialog__bar"><button type="button" class="av-price-dialog__close">← На сайт</button><span class="av-price-dialog__title">Прайс АВОКАДО</span></div><iframe class="av-price-dialog__frame" title="Процедуры и сертификаты АВОКАДО"></iframe>';
    doc.body.append(dialog);
    const frame = dialog.querySelector('iframe'), bar = dialog.querySelector('.av-price-dialog__bar');
    const closeButton = dialog.querySelector('button');
    const sourceMusic = doc.getElementById('music-toggle');
    let opener = null, pendingDestination = '', ownedEntry = false;
    const stateKey = 'avokadoPriceOverlay';
    if (sourceMusic) {
      const music = sourceMusic.cloneNode(true);
      music.removeAttribute('id'); music.removeAttribute('aria-controls'); music.hidden = false;
      bar.append(music);
      const sync = () => {
        for (const attr of ['aria-pressed', 'aria-busy', 'title']) {
          const value = sourceMusic.getAttribute(attr);
          if (value !== null) music.setAttribute(attr, value);
        }
        music.dataset.state = sourceMusic.dataset.state;
      };
      music.addEventListener('click', () => sourceMusic.click());
      new win.MutationObserver(sync).observe(sourceMusic, { attributes: true });
      sync();
    }
    function open(url, push) {
      const checked = priceUrl(url, win.location.href);
      if (!checked) return;
      if (win.AvokadoContacts) win.AvokadoContacts.cancel();
      if (push) {
        win.history.pushState({ [stateKey]: checked.href }, '', win.location.href);
        ownedEntry = true;
      }
      checked.searchParams.set('embedded', '1');
      // Replacing child navigation keeps one history entry for the entire price view.
      frame.contentWindow.location.replace(checked.href);
      doc.documentElement.classList.add('av-price-open');
      if (!dialog.open) dialog.showModal();
      closeButton.focus({ preventScroll: true });
    }
    function hide() {
      if (dialog.open) dialog.close();
      doc.documentElement.classList.remove('av-price-open');
      try { frame.contentDocument.querySelectorAll('video').forEach(video => video.pause()); } catch (_) {}
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
      if (pendingDestination) {
        const destination = pendingDestination;
        pendingDestination = '';
        if (win.AvokadoContacts) win.AvokadoContacts.navigate(destination);
        else win.location.hash = destination;
      }
    }
    function close(destination) {
      pendingDestination = ['#contacts', '#callback'].includes(destination) ? destination : '';
      if (ownedEntry && win.history.state && win.history.state[stateKey]) {
        ownedEntry = false;
        win.history.back();
      } else hide();
    }
    closeButton.addEventListener('click', () => close(false));
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(false); });
    win.addEventListener('popstate', event => {
      if (event.state && event.state[stateKey]) { ownedEntry = true; open(event.state[stateKey], false); }
      else { ownedEntry = false; if (dialog.open) hide(); }
    });
    // Same-origin frame links back to the home page keep audio and land at Contacts.
    frame.addEventListener('load', () => {
      let inner;
      try { inner = frame.contentDocument; } catch (_) { return; }
      if (!inner) return;
      inner.addEventListener('click', event => {
        const anchor = event.target.closest && event.target.closest('a[href]');
        if (!ordinaryClick(event, anchor)) return;
        let url;
        try { url = new URL(anchor.href, inner.location.href); } catch (_) { return; }
        const home = new URL('index.html', win.location.href);
        if (url.origin !== home.origin) return;
        if (url.pathname === new URL('price.html', home).pathname && url.hash) {
          let target;
          try { target = inner.getElementById(decodeURIComponent(url.hash.slice(1))); } catch (_) { return; }
          event.preventDefault();
          url.searchParams.set('embedded', '1');
          frame.contentWindow.history.replaceState(null, '', url.href);
          if (target) target.scrollIntoView({ block: 'start', behavior: 'instant' });
          return;
        }
        if (![home.pathname, home.pathname.replace(/index\.html$/, '')].includes(url.pathname)) {
          event.preventDefault();
          frame.contentWindow.location.replace(url.href);
          return;
        }
        event.preventDefault();
        close(['#contacts', '#callback'].includes(url.hash) ? url.hash : anchor.hasAttribute('data-contact-route') ? '#contacts' : '');
      });
    });
    doc.addEventListener('click', event => {
      const anchor = event.target.closest && event.target.closest('a[href]');
      if (!ordinaryClick(event, anchor)) return;
      const url = priceUrl(anchor.href, win.location.href);
      if (!url) return;
      event.preventDefault(); opener = anchor; open(url.href, true);
    });
    // A BFCache return must not leave a stale closed dialog marked as open.
    win.addEventListener('pageshow', () => {
      if (!dialog.open) doc.documentElement.classList.remove('av-price-open');
    });
    if (win.history.state && priceUrl(win.history.state[stateKey], win.location.href)) {
      ownedEntry = true;
      open(win.history.state[stateKey], false);
    }
    return { dialog, open, close };
  }
  return { start, priceUrl, ordinaryClick };
});

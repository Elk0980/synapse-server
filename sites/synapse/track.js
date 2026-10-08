(function () {
  'use strict';

  try {
    if (navigator.doNotTrack === '1' || window.__synapseTrackLoaded) return;
    window.__synapseTrackLoaded = true;

    // Во фрейме визит не считается: его считает родительская
    // страница. Встроенный прайс (?embedded=1 в iframe того же сайта) передаёт только клики; любой
    // другой фрейм (предпросмотр кабинета, чужая страница) не передаёт ничего.
    var framed = true;
    try { framed = window.top !== window; } catch (_) { framed = true; }
    var embeddedPrice = false;
    if (framed) {
      try {
        embeddedPrice = new URLSearchParams(location.search).get('embedded') === '1' &&
          window.parent.location.origin === location.origin;
      } catch (_) { embeddedPrice = false; }
      if (!embeddedPrice) return;
    }
    var LIMIT = 500; // CRM /events отклоняет строки длиннее 500 символов (локальный контракт 06.09)
    function clip(value) { return String(value || '').slice(0, LIMIT); }

    var script = document.currentScript;
    var companyCode = script && script.getAttribute('data-company');
    if (companyCode !== 'alvi' && companyCode !== 'avokado') return;

    var DAY = 86400000;
    var UTM_KEYS = ['source', 'medium', 'campaign', 'content', 'term'];
    var params = new URLSearchParams(location.search);

    function uuid() {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (char) {
        var value = Math.random() * 16 | 0;
        return (char === 'x' ? value : value & 3 | 8).toString(16);
      });
    }

    function stored(key) {
      try {
        return localStorage.getItem(key);
      } catch (_) {
        return null;
      }
    }

    function save(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch (_) {}
    }

    function hostOf(value) {
      try {
        return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
      } catch (_) {
        return '';
      }
    }

    function sourceFrom(referrer, utmSource) {
      if (utmSource) return utmSource.toLowerCase();
      var host = hostOf(referrer);
      if (!host) return 'direct';
      if (host === 'org.telegram.messenger') return 'telegram';
      if (host === 'com.whatsapp') return 'whatsapp';
      if (host === 'com.vkontakte.android') return 'vk';
      if (/(^|\.)2gis\./.test(host)) return '2gis';
      if (/(^|\.)yandex\./.test(host)) return 'yandex';
      if (/(^|\.)google\./.test(host)) return 'google';
      if (/(^|\.)instagram\.com$/.test(host)) return 'instagram';
      if (/(^|\.)vk\.com$/.test(host)) return 'vk';
      if (host === 't.me' || /(^|\.)telegram\.org$/.test(host)) return 'telegram';
      if (host.indexOf('whatsapp') !== -1 || host === 'wa.me') return 'whatsapp';
      return host;
    }

    // Same-origin прайс использует идентификатор родительской страницы даже без localStorage.
    var parentClientId;
    var parentTouch;
    if (embeddedPrice) {
      try {
        parentClientId = window.parent.__synapseClientId;
        parentTouch = window.parent.__synapseFirstTouch;
      } catch (_) {}
    }
    var clientId = parentClientId || stored('synapse_cid');
    if (!clientId) {
      clientId = uuid();
      save('synapse_cid', clientId);
    }
    // CID в памяти страницы — для формы заявки, когда localStorage недоступен
    // (иначе визит и заявка получили бы разные или пустые идентификаторы). Только идентификатор, без данных.
    try { window.__synapseClientId = clientId; } catch (_) {}

    var now = Date.now();
    var firstTouch;
    try {
      firstTouch = JSON.parse(stored('synapse_ft'));
    } catch (_) {}
    var hasUtm = UTM_KEYS.some(function (key) {
      return params.has('utm_' + key);
    });
    // Во встроенном прайсе первое касание не создаётся и не перезаписывается: адрес фрейма и его
    // referrer (родительская страница) — не источник посетителя.
    if (framed) firstTouch = parentTouch && typeof parentTouch === 'object' ? parentTouch :
      (firstTouch && typeof firstTouch === 'object' ? firstTouch : {});
    else if (!firstTouch || now - Number(firstTouch.ts) >= 30 * DAY || hasUtm) {
      firstTouch = {
        source: clip(sourceFrom(document.referrer, params.get('utm_source'))),
        referrer: clip(document.referrer),
        landingPage: clip(location.pathname + location.hash),
        ts: now
      };
      UTM_KEYS.forEach(function (key) {
        firstTouch['utm' + key.charAt(0).toUpperCase() + key.slice(1)] =
          clip(params.get('utm_' + key));
      });
      save('synapse_ft', JSON.stringify(firstTouch));
    }
    // Только в памяти того же origin: встроенный прайс наследует настоящее касание, не свой URL.
    try { window.__synapseFirstTouch = firstTouch; } catch (_) {}

    function send(type, target, label) {
      try {
        var safeLabel = target === 'phone' ? 'Телефон' : (label || '').replace(/\d{6,}/g, '');
        var event = {
          type: type,
          companyCode: companyCode,
          clientId: clientId,
          page: clip(location.pathname + location.hash),
          landingPage: clip(firstTouch.landingPage),
          referrer: clip(firstTouch.referrer),
          utmSource: clip(firstTouch.utmSource),
          utmMedium: clip(firstTouch.utmMedium),
          utmCampaign: clip(firstTouch.utmCampaign),
          utmContent: clip(firstTouch.utmContent),
          utmTerm: clip(firstTouch.utmTerm),
          source: clip(firstTouch.source) || 'direct',
          target: target || '',
          label: safeLabel.replace(/\s+/g, ' ').trim().slice(0, 60),
          ts: new Date().toISOString()
        };
        var body = JSON.stringify(event);
        if (navigator.sendBeacon && navigator.sendBeacon('/track', new Blob([body], {
          type: 'application/json'
        }))) return;
        fetch('/track', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true
        }).catch(function () {});
      } catch (_) {}
    }

    function pathOf(value) {
      try {
        return new URL(value, location.href).pathname;
      } catch (_) {
        return '';
      }
    }

    function clickTarget(link) {
      if (link.matches('.price-all__button') || link.hash === '#price') return 'price';
      var href = link.getAttribute('href') || '';
      var lower = href.toLowerCase();
      if (lower.indexOf('tel:') === 0) return 'phone';
      if (lower.indexOf('tg:') === 0) return 'telegram';
      if (lower.indexOf('whatsapp:') === 0) return 'whatsapp';
      if (lower.indexOf('viber:') === 0) return 'viber';
      var host = hostOf(href);
      // Онлайн-запись: это КЛИК по кнопке записи, а не запись. Запись подтверждает только Yclients.
      if (host === 'yclients.com' || /\.yclients\.com$/.test(host)) return 'booking';
      if (host === 'max.ru') return 'max';
      if (host === 'vk.me' || ((host === 'vk.com' || host === 'vk.ru') &&
          /^\/(im|write-?\d+)\/?$/.test(pathOf(href)))) return 'vk';
      if (host === 't.me' || /(^|\.)telegram\.org$/.test(host)) return 'telegram';
      if (host === 'wa.me' || host.indexOf('whatsapp') !== -1) return 'whatsapp';
      if (/(^|\.)2gis\.ru$/.test(host)) return '2gis';
      try {
        if (/(^|\.)yandex\.ru$/.test(host) && new URL(href, location.href).pathname.indexOf('/maps') === 0) {
          return 'yandex';
        }
      } catch (_) {}
      return '';
    }

    document.addEventListener('click', function (event) {
      try {
        var priceButton = event.target.closest('.price-all__button');
        if (priceButton) {
          send('click', 'price', priceButton.textContent || priceButton.getAttribute('aria-label'));
          return;
        }
        var link = event.target.closest('a[href]');
        if (!link) return;
        var target = clickTarget(link);
        if (target) send('click', target, link.textContent || link.getAttribute('aria-label'));
      } catch (_) {}
    }, true);

    document.addEventListener('submit', function (event) {
      try {
        var form = event.target;
        if (form && (form.id === 'spa-quiz' || /quiz/i.test(form.id) || form.matches('.quiz-form'))) {
          send('click', 'quiz', form.getAttribute('aria-label') || 'Квиз');
        }
      } catch (_) {}
    }, true);

    if (!framed) send('visit');
  } catch (_) {}
})();

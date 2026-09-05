(function () {
  'use strict';

  try {
    if (navigator.doNotTrack === '1' || window.__synapseTrackLoaded) return;
    window.__synapseTrackLoaded = true;

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

    var clientId = stored('synapse_cid');
    if (!clientId) {
      clientId = uuid();
      save('synapse_cid', clientId);
    }

    var now = Date.now();
    var firstTouch;
    try {
      firstTouch = JSON.parse(stored('synapse_ft'));
    } catch (_) {}
    var hasUtm = UTM_KEYS.some(function (key) {
      return params.has('utm_' + key);
    });
    if (!firstTouch || now - Number(firstTouch.ts) >= 30 * DAY || hasUtm) {
      firstTouch = {
        source: sourceFrom(document.referrer, params.get('utm_source')),
        referrer: document.referrer || '',
        landingPage: location.pathname + location.hash,
        ts: now
      };
      UTM_KEYS.forEach(function (key) {
        firstTouch['utm' + key.charAt(0).toUpperCase() + key.slice(1)] =
          params.get('utm_' + key) || '';
      });
      save('synapse_ft', JSON.stringify(firstTouch));
    }

    function send(type, target, label) {
      try {
        var safeLabel = target === 'phone' ? 'Телефон' : (label || '').replace(/\d{6,}/g, '');
        var event = {
          type: type,
          companyCode: companyCode,
          clientId: clientId,
          page: location.pathname + location.hash,
          landingPage: firstTouch.landingPage || '',
          referrer: firstTouch.referrer || '',
          utmSource: firstTouch.utmSource || '',
          utmMedium: firstTouch.utmMedium || '',
          utmCampaign: firstTouch.utmCampaign || '',
          utmContent: firstTouch.utmContent || '',
          utmTerm: firstTouch.utmTerm || '',
          source: firstTouch.source || 'direct',
          target: target || '',
          label: safeLabel.replace(/\s+/g, ' ').trim().slice(0, 60),
          ts: Date.now()
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

    function clickTarget(link) {
      if (link.matches('.price-all__button') || link.hash === '#price') return 'price';
      var href = link.getAttribute('href') || '';
      var lower = href.toLowerCase();
      if (lower.indexOf('tel:') === 0) return 'phone';
      if (lower.indexOf('tg://') === 0) return 'telegram';
      var host = hostOf(href);
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

    send('visit');
  } catch (_) {}
})();

/* Яндекс Метрика для сайта ALVI. Номер счётчика задаётся здесь и только здесь. */
(function () {
  // Встроенный прайс в рабочем кабинете не является посещением сайта клиентом.
  if (window.parent !== window && new URLSearchParams(window.location.search).get('embedded') === '1') return;
  var COUNTER_ID = 112777602;
  window.ALVI_METRIKA_ID = COUNTER_ID;

  (function (m, e, t, r, i, k, a) {
    m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
    m[i].l = 1 * new Date();
    for (var j = 0; j < e.scripts.length; j++) { if (e.scripts[j].src === r) { return; } }
    k = e.createElement(t); a = e.getElementsByTagName(t)[0];
    k.async = 1; k.src = r; a.parentNode.insertBefore(k, a);
  })(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js', 'ym');

  try {
    ym(COUNTER_ID, 'init', {
      clickmap: true,
      trackLinks: true,
      accurateTrackBounce: true,
      webvisor: true
    });
  } catch (e) {}

  function goal(name) {
    try { if (window.ym) { ym(COUNTER_ID, 'reachGoal', name); } } catch (e) {}
  }
  window.alviGoal = goal;

  var fired = {};
  function once(name) {
    if (fired[name]) { return; }
    fired[name] = true;
    setTimeout(function () { fired[name] = false; }, 1500);
    goal(name);
  }

  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
    if (!a || !a.href) { return; }
    var h = String(a.href);
    if (h.indexOf('tel:') === 0) { once('click_phone'); }
    else if (h.indexOf('t.me') > -1) { once('click_telegram'); }
    else if (h.indexOf('max.ru') > -1) { once('click_max'); }
    else if (h.indexOf('wa.me') > -1 || h.indexOf('whatsapp') > -1) { once('click_whatsapp'); }
  }, true);

  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function () {
      var args = arguments;
      var url = '';
      try { url = String((args[0] && args[0].url) || args[0] || ''); } catch (e) {}
      return nativeFetch.apply(this, args).then(function (res) {
        try { if (url.indexOf('/api/leads') > -1 && res && res.ok) { once('callback_submit'); } } catch (e) {}
        return res;
      });
    };
  }
})();

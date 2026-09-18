(() => {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const constrainedData = Boolean(connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType || ''));

  document.querySelectorAll('img:not([fetchpriority="high"]):not([loading])').forEach((image) => {
    image.loading = 'lazy';
    image.decoding = 'async';
  });

  if (!matchMedia('(max-width: 56.24rem)').matches || (!reducedMotion && !constrainedData)) return;
  document.documentElement.classList.add('mobile-media-paused');
  // Decorative water owns its media/fallback lifecycle and respects the same preferences.
  document.querySelectorAll('video:not(.water-surface__video)').forEach((video) => {
    video.pause();
    video.autoplay = false;
    video.preload = 'none';
    video.removeAttribute('src');
    video.querySelectorAll('source').forEach((source) => source.removeAttribute('src'));
    video.load();
  });
})();

/* ---- Яндекс Метрика (ALVI) · счётчик 112777602. Добавлено 18.09.2026.
   Подключено здесь, потому что этот файл уже есть на всех страницах сайта.
   Вебвизор выключен: запись действий посетителей не ведётся. ---- */
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__metrikaReady) return;
  window.__metrikaReady = true;
  (function (m, e, t, r, i, k, a) {
    m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
    m[i].l = 1 * new Date();
    for (var j = 0; j < e.scripts.length; j++) { if (e.scripts[j].src === r) return; }
    k = e.createElement(t); a = e.getElementsByTagName(t)[0];
    k.async = 1; k.src = r; a.parentNode.insertBefore(k, a);
  })(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js', 'ym');
  ym(112777602, 'init', { clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: false });
})();

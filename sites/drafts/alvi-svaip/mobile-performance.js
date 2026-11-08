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

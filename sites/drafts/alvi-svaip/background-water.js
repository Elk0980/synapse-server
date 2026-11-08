/* A denied background autoplay is decoration, never a customer-facing player. */
(() => {
  'use strict';
  const layers = Array.from(document.querySelectorAll('.water-surface'));
  if (!layers.length) return;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const hero = document.querySelector('.hero');
  const saveData = () => Boolean(connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType || ''));

  const controllers = layers.map((layer) => {
    const video = layer.querySelector('.water-surface__video');
    if (!video) return null;
    let attempted = false;
    let pending = false;
    let requestId = 0;
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.controls = false;
    video.disablePictureInPicture = true;

    const visible = () => {
      if (layer.classList.contains('page-water')) {
        const on = !hero || window.scrollY > hero.offsetHeight - window.innerHeight * 1.2;
        if (hero) layer.classList.toggle('is-on', on);
        return on;
      }
      const rect = layer.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    };
    const active = () => visible() && !document.hidden && !reducedMotion.matches;
    const hideVideo = () => layer.classList.remove('is-playing');
    const stop = () => {
      requestId += 1;
      pending = false;
      attempted = false;
      hideVideo();
      if (!video.paused) video.pause();
    };

    video.addEventListener('playing', () => {
      if (!active() || saveData()) { stop(); return; }
      layer.classList.add('is-playing');
    });
    ['pause', 'waiting', 'ended', 'error', 'emptied'].forEach((name) => video.addEventListener(name, hideVideo));

    return (gesture = false) => {
      const on = active();
      layer.classList.toggle('is-active', on);
      if (!on || saveData()) { stop(); return; }
      if (!video.paused || pending || (attempted && !gesture)) return;
      attempted = true;
      pending = true;
      const id = ++requestId;
      video.preload = 'auto';
      let result;
      try { result = video.play(); }
      catch (_) { pending = false; hideVideo(); return; }
      Promise.resolve(result).catch(() => {
        if (id === requestId) hideVideo();
      }).finally(() => {
        if (id === requestId) pending = false;
      });
    };
  }).filter(Boolean);

  const update = (gesture = false) => controllers.forEach((controller) => controller(gesture));
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => { scheduled = false; update(); });
  };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  window.addEventListener('pageshow', () => update());
  document.addEventListener('visibilitychange', () => update());
  // Keep play() directly inside the real gesture: do not defer it to a timer.
  ['touchend', 'click', 'keydown'].forEach((name) => {
    document.addEventListener(name, (event) => { if (!event.repeat) update(true); }, { passive: true });
  });
  if (reducedMotion.addEventListener) reducedMotion.addEventListener('change', () => update());
  else reducedMotion.addListener(() => update());
  if (connection?.addEventListener) connection.addEventListener('change', () => update());
  update();
})();

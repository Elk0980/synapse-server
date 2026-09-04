(() => {
  const hero = document.querySelector('.hero');
  const video = document.getElementById('hero-video');
  const scrollHint = document.getElementById('hero-scroll');
  if (!hero || !video || !scrollHint) return;

  const root = document.documentElement;
  const body = document.body;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const timedOverlays = [...hero.querySelectorAll('[data-hero-time]')];
  let phase = 'story';
  let unlocked = false;
  let loadTimer;

  const updateOverlays = () => {
    timedOverlays.forEach((overlay) => {
      const visible = video.currentTime >= Number(overlay.dataset.heroTime || 0);
      overlay.classList.toggle('is-visible', visible);
      overlay.setAttribute('aria-hidden', String(!visible));
    });
  };

  const unlock = () => {
    if (unlocked) return;
    unlocked = true;
    clearTimeout(loadTimer);
    root.classList.remove('hero-story-locked');
    body.classList.remove('hero-story-locked');
    scrollHint.classList.add('is-visible');
  };

  const showFallback = () => {
    video.pause();
    video.style.display = 'none';
    unlock();
  };

  const startLoop = () => {
    if (phase !== 'story') return;
    phase = 'loop';
    unlock();
    video.loop = true;
    video.src = '/assets/video/hero-loop.mp4';
    video.load();
    const playback = video.play();
    if (playback && playback.catch) playback.catch(showFallback);
  };

  video.addEventListener('timeupdate', updateOverlays);
  video.addEventListener('ended', startLoop);
  video.addEventListener('error', showFallback);

  if (reduceMotion) {
    showFallback();
    return;
  }

  root.classList.add('hero-story-locked');
  body.classList.add('hero-story-locked');
  loadTimer = window.setTimeout(showFallback, 4000);

  const playback = video.play();
  if (playback && playback.catch) playback.catch(showFallback);
  video.addEventListener('playing', () => clearTimeout(loadTimer), {once: true});
})();

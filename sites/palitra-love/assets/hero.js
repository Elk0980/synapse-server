(() => {
  const hero = document.querySelector('.hero');
  const video = document.getElementById('hero-video');
  const scrollHint = document.getElementById('hero-scroll');
  if (!hero || !video || !scrollHint) return;

  const root = document.documentElement;
  const body = document.body;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const timedOverlays = [...hero.querySelectorAll('[data-hero-start]')];
  let phase = 'story';
  let unlocked = false;
  let metadataTimer;
  let playbackTimer;

  const updateOverlays = () => {
    const currentTime = video.currentTime;

    timedOverlays.forEach((overlay) => {
      if (phase === 'loop') {
        const visible = overlay.id === 'hero-brand' || overlay.id === 'hero-scroll';
        overlay.classList.toggle('is-visible', visible);
        overlay.setAttribute('aria-hidden', String(!visible));
        return;
      }

      const start = Number(overlay.dataset.heroStart);
      const end = overlay.dataset.heroEnd ? Number(overlay.dataset.heroEnd) : Infinity;
      const visible = currentTime >= start && currentTime < end;
      overlay.classList.toggle('is-visible', visible);
      overlay.setAttribute('aria-hidden', String(!visible));
    });
  };

  const unlock = () => {
    if (unlocked) return;
    unlocked = true;
    clearTimeout(metadataTimer);
    clearTimeout(playbackTimer);
    root.classList.remove('hero-story-locked');
    body.classList.remove('hero-story-locked');
  };

  const revealFinalFrame = () => {
    const brand = hero.querySelector('#hero-brand');
    brand?.classList.add('is-visible');
    brand?.setAttribute('aria-hidden', 'false');
    scrollHint.classList.add('is-visible');
    scrollHint.setAttribute('aria-hidden', 'false');
  };

  const showFallback = () => {
    video.pause();
    video.style.display = 'none';
    revealFinalFrame();
    unlock();
  };

  const startLoop = () => {
    if (phase !== 'story') return;
    phase = 'loop';
    revealFinalFrame();
    unlock();
    video.loop = true;
    video.src = '/assets/video/hero-loop.mp4';
    video.load();
    const playback = video.play();
    if (playback && playback.catch) playback.catch(showFallback);
  };

  video.addEventListener('timeupdate', updateOverlays);
  video.addEventListener('seeked', updateOverlays);
  video.addEventListener('ended', startLoop);
  video.addEventListener('error', showFallback);

  if (reduceMotion) {
    showFallback();
    return;
  }

  root.classList.add('hero-story-locked');
  body.classList.add('hero-story-locked');
  const startPlaybackTimer = () => {
    if (document.hidden || playbackTimer) return;
    playbackTimer = window.setTimeout(showFallback, 6000);
  };

  const metadataLoaded = () => {
    clearTimeout(metadataTimer);
    if (document.hidden) {
      document.addEventListener('visibilitychange', startPlaybackTimer, {once: true});
    } else {
      startPlaybackTimer();
    }
  };

  metadataTimer = window.setTimeout(showFallback, 8000);
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    metadataLoaded();
  } else {
    video.addEventListener('loadedmetadata', metadataLoaded, {once: true});
  }

  const playback = video.play();
  if (playback && playback.catch) playback.catch(showFallback);
  video.addEventListener('playing', () => {
    clearTimeout(playbackTimer);
    document.removeEventListener('visibilitychange', startPlaybackTimer);
  }, {once: true});
})();

(() => {
  const hero = document.querySelector('.hero');
  if (!hero) return;

  // Layout depends on the actual header/banner, never on media playback.
  const root = document.documentElement;
  const header = document.querySelector('header');
  const cookie = document.querySelector('.cookie');
  const content = hero.querySelector('.hero-main');
  const updateLayout = () => {
    root.style.setProperty('--header-height', `${header?.getBoundingClientRect().height || 0}px`);
    root.style.setProperty('--hero-content-height', `${Math.ceil(content?.getBoundingClientRect().height || 0) + 32}px`);
    const cookieHeight = cookie?.isConnected ? cookie.getBoundingClientRect().height : 0;
    const bottom = cookieHeight ? parseFloat(getComputedStyle(cookie).bottom) || 0 : 0;
    root.style.setProperty('--cookie-space', `${cookieHeight ? cookieHeight + bottom + 16 : 0}px`);
  };
  updateLayout();
  window.addEventListener('resize', updateLayout);
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(updateLayout);
    if (header) observer.observe(header);
    if (cookie) observer.observe(cookie);
    if (content) observer.observe(content);
  }

  const video = document.getElementById('hero-video');
  const replay = document.getElementById('hero-replay');
  const pause = document.getElementById('hero-pause');
  const status = document.getElementById('hero-video-status');
  if (!video) return;

  const storySource = video.querySelector('source')?.getAttribute('src');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const timedOverlays = [...hero.querySelectorAll('[data-hero-start]')];
  let phase = 'story';
  let playbackTimer;
  let attempt = 0;

  const updateOverlays = () => {
    timedOverlays.forEach((overlay) => {
      const start = Number(overlay.dataset.heroStart);
      const end = overlay.dataset.heroEnd ? Number(overlay.dataset.heroEnd) : Infinity;
      const visible = phase === 'story'
        ? video.currentTime >= start && video.currentTime < end
        : overlay.id === 'hero-brand' || overlay.id === 'hero-scroll';
      overlay.classList.toggle('is-visible', visible);
      overlay.setAttribute('aria-hidden', String(!visible));
      if (overlay.id === 'hero-scroll') overlay.tabIndex = visible ? 0 : -1;
    });
  };

  const showPoster = (failed = false) => {
    ++attempt;
    clearTimeout(playbackTimer);
    video.pause();
    video.hidden = true;
    if (pause) pause.hidden = true;
    if (status) {
      status.textContent = failed ? 'Видео недоступно. Можно написать в Telegram или оставить заявку.' : '';
      status.hidden = !failed;
    }
    phase = 'poster';
    updateOverlays();
  };

  const play = () => {
    const currentAttempt = ++attempt;
    clearTimeout(playbackTimer);
    video.hidden = false;
    if (status) status.hidden = true;
    // A rejected autoplay, unavailable file or pending download leaves a usable poster.
    const failed = () => { if (currentAttempt === attempt) showPoster(true); };
    playbackTimer = window.setTimeout(failed, 8000);
    try {
      const playback = video.play();
      if (playback?.catch) playback.catch(failed);
    } catch {
      failed();
    }
  };

  const startLoop = () => {
    if (phase !== 'story') return;
    phase = 'loop';
    updateOverlays();
    video.loop = true;
    video.src = '/assets/video/hero-loop.mp4';
    video.load();
    play();
  };

  video.addEventListener('timeupdate', updateOverlays);
  video.addEventListener('seeked', updateOverlays);
  video.addEventListener('ended', startLoop);
  video.addEventListener('error', () => showPoster(true));
  video.addEventListener('playing', () => {
    clearTimeout(playbackTimer);
    if (pause) {
      pause.hidden = false;
      pause.textContent = 'Пауза';
    }
  });
  video.addEventListener('pause', () => {
    clearTimeout(playbackTimer);
    if (pause) pause.textContent = 'Продолжить';
  });
  pause?.addEventListener('click', () => {
    if (video.paused) play();
    else video.pause();
  });
  replay?.addEventListener('click', () => {
    phase = 'story';
    video.loop = false;
    if (storySource) video.src = storySource;
    video.load();
    video.currentTime = 0;
    updateOverlays();
    play();
  });

  if (reduceMotion) showPoster();
  else play();
})();

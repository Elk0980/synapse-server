/* Avokado-only presentation; editing, authorization and saving stay with the existing editor. */
(function () {
  'use strict';
  const site = new URLSearchParams(location.search).get('site');
  if (!['avokado', 'avokado2', 'avokado3'].includes(site)) return;
  const bar = document.querySelector('.ed-bar');
  const title = bar && bar.querySelector('.ed-bar__title');
  const save = document.getElementById('ed-save');
  const status = document.getElementById('ed-status');
  if (!bar || !title || !save || !status) return;
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';stylesheet.href = 'avokado-editor-theme.css?v=20260915-brand';document.head.append(stylesheet);
  const fonts = document.createElement('link');
  fonts.rel = 'stylesheet';fonts.href = 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=Cormorant:wght@500;600&display=swap';document.head.append(fonts);
  document.body.classList.add('avokado-editor');
  const main = 'https://avokado3.synapsebusiness.ru/';
  const mark = '<path d="M25.5 8 C26.5 5 25 2.5 23 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M24 9.5 C20.4 9.5 15.6 15.6 14.1 22.3 C12.6 29.1 17.3 38 24 38 C30.7 38 35.4 29.1 33.9 22.3 C32.4 15.6 27.6 9.5 24 9.5 Z" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"/><circle cx="24" cy="27" r="4.6" fill="currentColor"/>';
  const brand = document.createElement('a');brand.className = 'av-editor-brand';brand.href = main;brand.setAttribute('aria-label', 'Авокадо — на главную');
  brand.innerHTML = '<span class="av-editor-brand__word">АВ<svg viewBox="0 0 48 54" aria-hidden="true">' + mark + '</svg>КАДО</span><span class="av-editor-brand__sub">студия дизайна тела</span>';
  const heading = document.createElement('div');heading.className = 'av-editor-heading';
  const actions = document.createElement('div');actions.className = 'av-editor-actions';
  const controls = Array.from(bar.children).filter(el => el !== title && el !== save && el !== status && !el.classList.contains('sb-brand'));
  heading.append(brand, title);controls.forEach(el => actions.append(el));
  const back = document.createElement('a');back.className = 'ed-btn ed-btn--ghost av-editor-back';back.href = main;back.textContent = '← Вернуться на сайт';
  bar.prepend(heading);bar.append(back, save, actions, status);
  const video = document.querySelector('.page-water__video');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  if (video) {
    video.pause();video.removeAttribute('autoplay');video.replaceChildren();
    video.poster = main + 'assets/hero-intro-poster.jpg';
    video.src = main + 'assets/hero-intro-loop.mp4';video.preload = 'metadata';video.muted = true;video.loop = true;video.playsInline = true;video.load();
    const play = () => { if (document.hidden || reduced.matches) video.pause();else video.play().catch(() => {}); };
    document.addEventListener('visibilitychange', play);reduced.addEventListener('change', play);play();
  }
  let previousHeight = 0;
  const measure = () => {
    const height = Math.ceil(bar.getBoundingClientRect().height);
    if (height === previousHeight) return;
    previousHeight = height;document.body.style.setProperty('--av-editor-bar-height', height + 'px');
    requestAnimationFrame(() => dispatchEvent(new Event('resize')));
  };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measure).observe(bar);
  stylesheet.addEventListener('load', measure);measure();
})();

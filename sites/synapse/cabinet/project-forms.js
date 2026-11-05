'use strict';
(() => {
  const api = window.SbCabinet;
  if (!api?.registerView) return;
  let root = null, frame = null, toggle = null, fullscreen = false;
  let inertBefore = [];
  const resize = () => {
    if (fullscreen) {
      inertBefore.forEach(([element]) => { element.inert = true; });
      return;
    }
    if (frame && !fullscreen) {
      frame.style.height = Math.max(240, window.innerHeight - frame.getBoundingClientRect().top - 16) + 'px';
    }
  };
  function restoreBackground() {
    inertBefore.forEach(([element, value]) => {
      element.inert = element.id === 'sidebar'
        ? window.matchMedia('(max-width: 760px)').matches && !element.classList.contains('is-open')
        : value;
    });
    inertBefore = [];
  }
  function setFullscreen(value) {
    if (!root || !frame) return;
    fullscreen = value;
    root.classList.toggle('pf-fullscreen', value);
    document.body.classList.toggle('project-forms-fullscreen', value);
    restoreBackground();
    if (value) {
      const background = new Set([
        ...document.querySelectorAll('#sidebar, .mobile-bar, #mobile-shortcuts, #backdrop'),
        ...Array.from(root.parentElement?.children || []).filter(element => element !== root)
      ]);
      background.forEach(element => { inertBefore.push([element, element.inert]); element.inert = true; });
    }
    toggle.textContent = value ? '← Меню кабинета' : 'На весь экран';
    toggle.setAttribute('aria-expanded', String(value));
    resize();
  }
  function leave() {
    restoreBackground();
    document.body.classList.remove('project-forms-fullscreen');
    window.removeEventListener('resize', resize);
    root?.classList.remove('pf-workspace', 'pf-fullscreen');
    root?.replaceChildren();
    root = null; frame = null; toggle = null; fullscreen = false;
  }
  function render(container, context) {
    leave(); root = container; container.replaceChildren();
    if (context.identity?.role !== 'owner' || context.selectedProjectId !== 'palitra-love') {
      const title = document.createElement('h1'); title.textContent = 'Формы проектов'; container.append(title);
      const note = document.createElement('p');
      note.textContent = context.identity?.role !== 'owner'
        ? 'Раздел доступен владельцу проекта.'
        : 'Для этого проекта формы пока не перенесены. Выберите Palitra Love.';
      container.append(note); return;
    }
    const style = document.createElement('style');
    style.textContent = `
      body.project-forms-fullscreen { overflow: hidden; }
      .pf-workspace:not([hidden]) { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
      .pf-workspace.pf-fullscreen:not([hidden]) {
        position: fixed; inset: 0; z-index: 60; height: 100vh; height: 100dvh;
        width: auto; max-width: none; margin: 0; padding: 0; background: #fff; overflow: hidden;
      }
      .pf-toolbar {
        display: flex; align-items: center; gap: 12px; flex: 0 0 auto; min-width: 0;
        padding: max(4px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) 4px max(8px, env(safe-area-inset-left));
        color: #282a23; background: #fff; border-bottom: 1px solid #e7e2d8;
      }
      .pf-toolbar button {
        flex: 0 0 auto; min-height: 36px; padding: 5px 12px; border: 1px solid #ded8cc;
        border-radius: 9px; background: #f5f3ee; color: #343b25; font: inherit; cursor: pointer;
      }
      .pf-toolbar h1 { margin: 0; min-width: 0; font: 600 15px/1.3 'Segoe UI', Arial, sans-serif; }
      .pf-toolbar p { margin: 0 0 0 auto; font: 13px/1.3 'Segoe UI', Arial, sans-serif; color: #6e7167; }
      .pf-editor-frame { display: block; flex: 0 0 auto; width: 100%; min-width: 0; min-height: 0; border: 0; border-radius: 0; background: #fff; }
      .pf-fullscreen .pf-editor-frame { flex: 1 1 0%; height: 0 !important; padding-bottom: env(safe-area-inset-bottom); }
      @media (max-width: 760px) {
        .pf-toolbar { gap: 8px; }
        .pf-toolbar button { min-height: 44px; }
        .pf-toolbar h1 { font-size: 13px; }
        .pf-toolbar p { display: none; }
      }
    `;
    container.classList.add('pf-workspace'); container.append(style);
    const toolbar = document.createElement('div'); toolbar.className = 'pf-toolbar';
    toggle = document.createElement('button'); toggle.type = 'button';
    toggle.setAttribute('aria-controls', 'project-forms-editor');
    toggle.addEventListener('click', () => { setFullscreen(!fullscreen); toggle.focus(); });
    const title = document.createElement('h1'); title.textContent = 'Формы проектов';
    const note = document.createElement('p'); note.textContent = 'Palitra Love → Palitra Love Заказы';
    toolbar.append(toggle, title, note); container.append(toolbar);
    frame = document.createElement('iframe'); frame.id = 'project-forms-editor'; frame.className = 'pf-editor-frame';
    frame.title = 'Редактор форм Palitra Love Заказы';
    frame.src = '/cabinet/project-forms/index.html?company=palitra-love&board=palitra-orders';
    frame.referrerPolicy = 'same-origin'; container.append(frame);
    window.addEventListener('resize', resize);
    setFullscreen(true);
  }
  api.registerView('project-forms', { render, onLeave: leave, onProjectChange(context) { if (root) render(root, context); } });
})();

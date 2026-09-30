(() => {
  'use strict';
  const cabinet = window.SbCabinet = window.SbCabinet || {};
  const VIEW = 'telegram-sources';
  let host = null, mounted = null, controller = null;

  function destroy() {
    mounted?.destroy();
    controller?.abort();
    host?.replaceChildren();
    host = mounted = controller = null;
  }

  function render(container, context) {
    destroy();
    if (!container || context.currentView !== VIEW) return;
    host = container;
    const code = context.selectedProjectId;
    const identity = context.identity;
    const permitted = identity?.role === 'owner' || identity?.permissions?.includes('autoposting.view');
    const company = typeof code === 'string' && /^[a-z0-9_-]{1,64}$/.test(code) &&
      identity?.companies?.some(item => item.id === code);
    const panel = container.ownerDocument.createElement('div');
    panel.className = 'card';
    panel.setAttribute('aria-live', 'polite');
    container.append(panel);
    if (!permitted || !company) {
      panel.textContent = 'Для просмотра исходников выберите доступную компанию и получите доступ к материалам.';
      return;
    }
    if (typeof context.apiJson !== 'function' || typeof cabinet.telegramSources?.mount !== 'function') {
      panel.textContent = 'Не удалось открыть исходники. Обновите страницу и повторите.';
      return;
    }
    const requestController = controller = new AbortController();
    // Scope замкнут на компанию этого mount; destroy подавляет поздний ответ.
    mounted = cabinet.telegramSources.mount({element: panel, companyCode: code,
      request: url => context.apiJson(url, {signal: requestController.signal})});
  }

  cabinet.registerView(VIEW, {
    title: 'Исходники из Telegram', render, onLeave: destroy,
    onProjectChange(context) {
      render(document.querySelector('[data-view="telegram-sources"]'), context);
    }
  });
})();

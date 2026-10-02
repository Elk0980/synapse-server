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
    const editor = identity?.role === 'owner' || identity?.permissions?.includes('autoposting.edit');
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
    const own = url => url === `/content/telegram-sources/${code}` || url.startsWith(`/content/telegram-sources/${code}/`) || url.startsWith(`/content/telegram-sources/${code}?`);
    const postsUrl = `/content/crm/autoposting/posts?companyCode=${encodeURIComponent(code)}`;
    const scopeError = () => Object.assign(new Error('Запрос вне выбранной компании'), {status: 403});
    // CF13: запись только в свою компанию и только с правом правки; CSRF добавляется здесь, а не в модуле.
    const send = async (url, method, body) => {
      if (!editor || !own(url) || !['PATCH', 'POST'].includes(method)) throw scopeError();
      let response;
      try {
        response = await fetch(url, {method, credentials: 'same-origin', cache: 'no-store', signal: requestController.signal,
          headers: {'content-type': 'application/json', 'X-CSRF-Token': identity.csrfToken}, body: JSON.stringify(body)});
      } catch (error) { throw Object.assign(new Error(error?.name === 'AbortError' ? 'Запрос отменён' : 'Нет связи с сервером'), {status: 0}); }
      const result = await response.json().catch(() => null);
      if (!response.ok) throw Object.assign(new Error(typeof result?.error === 'string' ? result.error : 'Сервер не сообщил причину'), {status: response.status, code: result?.code || result?.details?.code});
      return result;
    };
    // Один файл за запрос; XHR даёт честный байтовый прогресс, если браузер знает объём.
    const uploadFile = (url, body, {onProgress} = {}) => new Promise((resolve, reject) => {
      if (!editor || url !== `/content/telegram-sources/${code}/upload`) { reject(scopeError()); return; }
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      requestController.signal.addEventListener('abort', abort, {once: true});
      xhr.open('POST', url);
      xhr.withCredentials = true;
      xhr.setRequestHeader('X-CSRF-Token', identity.csrfToken);
      xhr.upload.onprogress = event => onProgress?.(event.loaded, event.lengthComputable ? event.total : 0);
      xhr.onload = () => {
        requestController.signal.removeEventListener('abort', abort);
        let parsed = null; try { parsed = JSON.parse(xhr.responseText); } catch {}
        resolve({status: xhr.status, body: parsed});
      };
      xhr.onerror = xhr.ontimeout = xhr.onabort = () => {
        requestController.signal.removeEventListener('abort', abort);
        reject(Object.assign(new Error('Нет связи с сервером'), {status: 0}));
      };
      xhr.send(body);
    });
    // Свежая карточка — тем же событием, что и из статистики: вкладка Контент-плана делает GET /posts/:id.
    const openPost = postId => {
      if (!Number.isSafeInteger(postId) || postId < 1) return;
      const detail = {companyCode: code, postId, source: 'sources'};
      cabinet.pendingMaterialOpen = detail;
      context.navigate?.('content-factory/plan');
      setTimeout(() => window.dispatchEvent(new window.CustomEvent('sb:content-factory-open-draft', {detail: {...detail}})), 0);
    };
    // Scope замкнут на компанию этого mount; destroy подавляет поздний ответ.
    mounted = cabinet.telegramSources.mount({element: panel, companyCode: code,
      request: url => (own(url) || url === postsUrl ? context.apiJson(url, {signal: requestController.signal}) : Promise.reject(scopeError())),
      send: editor ? send : undefined,
      uploadFile: editor ? uploadFile : undefined,
      openPost,
      upload: async (url,body)=>{
        if(identity.role!=='owner'||url!==`/content/telegram-sources/${code}/manual-upload`)throw new Error('Нет доступа к ручному импорту');
        // Для FormData браузер сам добавляет multipart boundary; apiJson задаёт JSON Content-Type.
        const response=await fetch(url,{method:'POST',credentials:'same-origin',cache:'no-store',
          headers:{'X-CSRF-Token':identity.csrfToken},body,signal:requestController.signal});
        const result=await response.json();if(!response.ok)throw new Error(result.error||'Не удалось загрузить файл');return result;
      }});
  }

  cabinet.registerView(VIEW, {
    title: 'Исходники', render, onLeave: destroy,
    onProjectChange(context) {
      render(document.querySelector('[data-view="telegram-sources"]'), context);
    }
  });
})();

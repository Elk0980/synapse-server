'use strict';
(() => {
  const local = ['localhost','127.0.0.1','[::1]'].includes(location.hostname) && ['http:','https:'].includes(location.protocol);
  const base = '/content/project-forms/palitra-love/palitra-orders';
  const native = !local;
  let actor = null, csrf = '', epoch = 0, active = true, timer = 0, verifying = null, locked = false;
  const error = (message, status = 403) => Object.assign(new Error(message), { status });
  const announce = (changed, restored = false) => window.dispatchEvent(new CustomEvent('projectforms-authchange', { detail: { changed, restored } }));
  function revoke(changed = false) { csrf = ''; epoch++; locked = true; if (changed) { active = false; clearInterval(timer); timer = 0; } announce(changed); }
  async function session() {
    if (!native) return null;
    if (verifying) return verifying;
    verifying = (async () => {
      const ticket = epoch;
      const response = await fetch(base + '/session', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!active || ticket !== epoch) throw error('Сессия изменилась');
      if (!response.ok) { revoke(response.status === 403); throw error('Войдите в кабинет снова. Несохранённые правки остаются здесь.', response.status); }
      const data = await response.json();
      if (!active || ticket !== epoch) throw error('Сессия изменилась');
      if (data.role !== 'owner' || data.company !== 'palitra-love' || data.board !== 'palitra-orders' || !data.identity?.id || !data.csrfToken) {
        revoke(true); throw error('Нет доступа к формам проекта');
      }
      const key = JSON.stringify([data.identity.id, data.identity.version]);
      if (actor && key !== actor) { revoke(true); throw error('Пользователь изменился. Откройте редактор заново.'); }
      actor = key; csrf = data.csrfToken; if (locked) { locked = false; announce(false, true); } return key;
    })();
    try { return await verifying; } finally { verifying = null; }
  }
  async function request(resource = 'project', options = {}) {
    if (!/^(?:project|history|restore|version\/[1-9][0-9]*)$/.test(resource)) throw error('Недопустимая операция');
    if (!active) throw error('Редактор закрыт');
    if (local) {
      if (resource !== 'project') throw error('История доступна после переноса на сервер');
      return fetch('/api/project', { ...options, credentials: 'same-origin', cache: 'no-store' });
    }
    await session();
    const ticket = epoch, method = options.method || 'GET';
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (method !== 'GET') {
      headers['X-CSRF-Token'] = csrf;
      let data; try { data = JSON.parse(options.body); } catch { throw error('Неверное сохранение'); }
      headers['If-Match'] = `"${data.revision}"`;
    }
    const response = await fetch(base + '/' + resource, { ...options, method, headers, credentials: 'same-origin', cache: 'no-store' });
    if (!active || ticket !== epoch) throw error('Ответ прежней сессии отклонён');
    if (response.status === 401) { revoke(); throw error('Войдите в кабинет снова. Правки остаются на странице.', response.status); }
    if (response.status === 403) {
      // CSRF can rotate without actor replacement. Only a fresh native session
      // proving lost/changed ownership may purge the previous private model.
      await session();
      if (!active || ticket !== epoch) throw error('Доступ изменился');
      throw error('Сохранение отклонено. Правки остались на странице; повторите после проверки входа.', 403);
    }
    // Session replacement can happen while PUT/GET is pending. A late payload is
    // never accepted into this editor before a fresh native identity check.
    await session();
    if (!active || ticket !== epoch) throw error('Ответ прежней сессии отклонён');
    return { ok: response.ok, status: response.status, headers: response.headers, async json() {
      const payload = await response.json();
      if (!active || ticket !== epoch) throw error('Поздний ответ прежней сессии отклонён');
      await session();
      if (!active || ticket !== epoch) throw error('Поздний ответ прежней сессии отклонён');
      return payload;
    } };
  }
  function stop() { active = false; clearInterval(timer); timer = 0; epoch++; csrf = ''; }
  if (native) timer = setInterval(() => { if (!document.hidden && active) session().catch(() => {}); }, 15000);
  window.addEventListener('pagehide', stop);
  window.ProjectFormsAPI = Object.freeze({ native, request, stop });
})();

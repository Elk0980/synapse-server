/* Подписка на Web Push: существующая сессия, её CSRF и внедрённый host. Не создаёт auth или новую БД. */
'use strict';
(() => {
  const host = window.PalitraShellHost;
  if (!host || host.mode !== 'native' || !host.push || typeof host.push.request !== 'function') return;
  const explicitPaths = host.push.scopePath !== undefined || host.push.workerPath !== undefined;
  const legacyPaths = host.verified === true && host.origin === location.origin && host.push.scopePath === '/love-app/' && host.push.workerPath === '/love-app/palitra-sw.js';
  if (explicitPaths && !legacyPaths) return;
  const scopeUrl = () => new URL(legacyPaths ? '/love-app/' : './', location.href);
  const workerUrl = () => new URL(legacyPaths ? '/love-app/palitra-sw.js' : './palitra-sw.js', location.href);
  let capability = null, cached = null, busy = false, epoch = 0, lastError = null, checking = false;
  const supported = () => window.isSecureContext === true && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const changed = () => window.dispatchEvent(new Event('palitra:push-ready'));
  const getRegistration = () => navigator.serviceWorker.getRegistration(scopeUrl().href);
  function publicKey(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{80,150}$/.test(value)) throw new Error('Ключ уведомлений не распознан.');
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }
  async function refresh() {
    const current = ++epoch; capability = null; cached = null; lastError = null; checking = true;
    try {
      if (!supported()) return;
      const result = await host.push.request('capability', { method: 'GET' }); if (current !== epoch) return;
      if (result && result.ok === true && result.configured === true && result.deliveryReady === true && typeof result.publicKey === 'string') { publicKey(result.publicKey); capability = result; }
      if (capability) await getStatus();
    } catch (error) { if (current === epoch) { lastError = error; cached = null; } }
    finally { if (current === epoch) { checking = false; changed(); } }
  }
  async function getStatus() {
    const current = epoch;
    if (!capability || !supported()) return { subscribed: false, serverSaved: false };
    const registration = await getRegistration();
    const subscription = registration && await registration.pushManager.getSubscription();
    if (current !== epoch) return { subscribed: false, serverSaved: false };
    if (!subscription) { cached = { subscribed: false, serverSaved: false }; return cached; }
    const status = await host.push.request('subscription/status', { method: 'POST', body: { endpoint: subscription.endpoint } });
    if (current !== epoch) return { subscribed: false, serverSaved: false };
    cached = { subscribed: Boolean(status && status.ok === true && status.subscribed === true && status.serverSaved === true && Notification.permission === 'granted'), serverSaved: Boolean(status && status.ok === true && status.serverSaved === true) };
    return cached;
  }
  async function subscribe() {
    if (busy) throw new Error('Подключение уведомлений уже выполняется.');
    if (!supported() || !capability) throw new Error('Доставка push сейчас не подключена.');
    if (navigator.userActivation && !navigator.userActivation.isActive) throw new Error('Нажмите кнопку подключения уведомлений.');
    if (Notification.permission === 'denied') throw new Error('Разрешите уведомления в настройках этого сайта.');
    const current = epoch;
    // Обязательно ДО первого await: браузер должен видеть непосредственное нажатие пользователя.
    const permission = Notification.permission === 'granted' ? Promise.resolve('granted') : Notification.requestPermission();
    busy = true;
    try {
      if (await permission !== 'granted') throw new Error('Уведомления не разрешены. Можно продолжить без них.');
      if (current !== epoch) throw new Error('Сессия изменилась. Откройте приложение заново.');
      const registration = await navigator.serviceWorker.register(workerUrl().href, { scope: scopeUrl().pathname });
      // ready относится ко всему origin: используем именно свою registration.
      if (!registration.active) await new Promise((resolve, reject) => {
        const worker = registration.installing || registration.waiting;
        if (!worker) { reject(new Error('Обработчик уведомлений ещё не запущен. Повторите подключение позже.')); return; }
        const timeout = setTimeout(() => reject(new Error('Обработчик уведомлений не запустился.')), 10000);
        worker.addEventListener('statechange', () => { if (worker.state === 'activated') { clearTimeout(timeout); resolve(); } else if (worker.state === 'redundant') { clearTimeout(timeout); reject(new Error('Обработчик уведомлений не активирован.')); } });
      });
      if (current !== epoch) throw new Error('Сессия изменилась.');
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey(capability.publicKey) });
      if (current !== epoch) throw new Error('Сессия изменилась.');
      const result = await host.push.request('subscription', { method: 'POST', body: { subscription: subscription.toJSON() } });
      if (current !== epoch || !result || result.ok !== true || result.serverSaved !== true || result.subscribed !== true) throw new Error('Сервер не подтвердил подписку.');
      // Saving succeeded. A failed follow-up read does not undo that receipt.
      try {
        const status = await getStatus();
        if (current !== epoch) throw new Error('Сессия изменилась.');
        lastError = null; changed();
        return { saved: true, serverSaved: status.serverSaved === true && status.subscribed === true, subscribed: status.subscribed === true };
      } catch (error) {
        if (current !== epoch) throw new Error('Сессия изменилась.');
        lastError = error; cached = { subscribed: false, serverSaved: false, savedButUnconfirmed: true }; changed();
        return { saved: true, serverSaved: false, subscribed: false, statusError: error };
      }
    } finally { busy = false; }
  }
  async function unsubscribe() {
    if (busy) throw new Error('Подождите завершения предыдущего действия.');
    busy = true; const current = epoch;
    try { const registration = await getRegistration(), subscription = registration && await registration.pushManager.getSubscription();
      if (current !== epoch) throw new Error('Сессия изменилась.');
      if (subscription) { const receipt = await host.push.request('subscription', { method: 'DELETE', body: { endpoint: subscription.endpoint } });
        if (current !== epoch || !receipt || receipt.ok !== true || receipt.subscribed !== false || receipt.serverSaved !== true) throw new Error('Сервер не подтвердил отключение уведомлений.');
        await subscription.unsubscribe();
        if (current !== epoch) throw new Error('Сессия изменилась.'); }
      if (current !== epoch) throw new Error('Сессия изменилась.');
      cached = { subscribed: false, serverSaved: true }; changed(); return cached;
    } finally { busy = false; }
  }
  Object.defineProperty(window, 'PalitraPushService', { value: Object.freeze({ get deliveryReady() { return Boolean(capability); }, get state() { return cached; }, get checking() { return checking; }, get lastError() { return lastError; }, getStatus, subscribe, unsubscribe, refresh }), writable: false });
  window.addEventListener('palitra:push-auth-ready', refresh);
  window.addEventListener('palitra:session-ended', () => { epoch++; capability = null; cached = null; lastError = null; checking = false; changed(); });
  if (host.push.authenticated === true) void refresh();
})();

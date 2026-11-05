/* PALITRA_CONTENT_DAY_BUILD:20261021-r5; no automatic page reload. */
/* Только уведомления. Не кэширует страницы, сессии, API, фото или ответы клиентов. */
'use strict';
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });
function targetUrl(value) {
  const fallback = new URL('./' + (self.registration.scope.includes('/cabinet/') ? 'cabinet.html' : 'shop.html#K04'), self.registration.scope);
  try { const target = new URL(typeof value === 'string' ? value : '', self.registration.scope);
    if (target.origin !== fallback.origin || target.username || target.password || !target.pathname.startsWith(new URL(self.registration.scope).pathname) || !/\/(shop|cabinet)\.html$/.test(target.pathname)) return fallback.href;
    target.search = ''; return target.href;
  } catch (_) { return fallback.href; }
}
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_) { /* показываем общее уведомление */ }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
  // Короткий текст сотруднику — только в рабочем scope; клиентские уведомления остаются общими.
  const scope = new URL(self.registration.scope), staffScope = scope.origin === 'https://synapse.synapsebusiness.ru' && scope.pathname === '/cabinet/palitra-orders/';
  const clean = (value, max) => typeof value === 'string' ? Array.from(value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, max).join('') : '';
  const title = staffScope ? clean(payload.title, 160) || 'Palitra Love' : 'Palitra Love';
  const body = staffScope ? clean(payload.body, 500) || 'В приложении есть обновление заказа или новое сообщение.' : 'В приложении есть обновление заказа или новое сообщение.';
  event.waitUntil(self.registration.showNotification(title, { body, tag: typeof payload.tag === 'string' ? payload.tag.slice(0, 80) : 'palitra-update', icon: new URL('./assets/palitra-app-192.png', self.registration.scope).href, data: { url: targetUrl(payload.url) } }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = targetUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
    const own = clients.find((client) => client.url === url);
    if (own) return own.focus();
    return self.clients.openWindow(url);
  }));
});

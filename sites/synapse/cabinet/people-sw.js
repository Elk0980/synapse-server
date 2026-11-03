'use strict';

// Только уведомления. Страницы, авторизация и ответы API никогда не кешируются.
const GENERIC = {title:'Synapse Business',body:'Откройте кабинет, чтобы посмотреть уведомление.'};
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data?.json() || {}; } catch {}
    let trusted = false;
    try {
      const response = await fetch('/content/people/context', {credentials:'include',cache:'no-store',redirect:'error'});
      if (response.ok) {
        const context = await response.json();
        trusted = Number.isSafeInteger(data.audienceUserId) && context.user?.id === data.audienceUserId &&
          Array.isArray(context.companies) && context.companies.some(company => company.id === data.companyCode);
      }
    } catch {}
    const title = trusted && typeof data.title === 'string' ? data.title.slice(0,150) : GENERIC.title;
    const body = trusted && typeof data.body === 'string' ? data.body.slice(0,1000) : GENERIC.body;
    await self.registration.showNotification(title, {body,icon:'/brand/hugh-icon-192.png',
      tag:typeof data.eventKey === 'string' ? data.eventKey.slice(0,180) : undefined,
      data:{url:'/cabinet/people.html'}});
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  // URL из пришедшего payload не используется: только собственная точка входа.
  const target = new URL('/cabinet/people.html', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for (const client of windows) {
      if (client.url === target && typeof client.focus === 'function') return client.focus();
    }
    return self.clients.openWindow(target);
  })());
});

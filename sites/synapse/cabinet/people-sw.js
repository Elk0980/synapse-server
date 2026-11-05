'use strict';

// Только уведомления. Страницы, авторизация и ответы API никогда не кешируются.
function taskTarget(value) {
  try {
    const u=new URL(value,self.location.origin);
    if(u.origin===self.location.origin && u.pathname==='/cabinet/people.html' &&
      /^[a-z0-9][a-z0-9_-]{0,63}$/.test(u.searchParams.get('company')||'') && /^[1-9][0-9]{0,9}$/.test(u.searchParams.get('task')||''))
      return '/cabinet/people.html?company='+encodeURIComponent(u.searchParams.get('company'))+'&task='+u.searchParams.get('task');
  }catch{}
  return '/cabinet/people.html';
}
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
      data:{url:trusted?taskTarget(data.url):'/cabinet/people.html'}});
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  // Только проверенный маршрут карточки на собственном origin.
  const target = new URL(taskTarget(event.notification.data?.url), self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for (const client of windows) {
      const current=new URL(client.url);
      if (current.origin===self.location.origin && current.pathname==='/cabinet/people.html' && typeof client.navigate==='function') {
        await client.navigate(target);return client.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});

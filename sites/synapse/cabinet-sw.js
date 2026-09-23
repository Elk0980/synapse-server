/* No fetch handler: private cabinet pages and API responses must not be cached. */
self.addEventListener('push', event => {
  let data={}; try {data=event.data?.json() || {};} catch {}
  const title=typeof data.title==='string'?data.title.slice(0,80):'Synapse Business';
  event.waitUntil(self.registration.showNotification(title,{
    body:typeof data.body==='string'?data.body.slice(0,180):'Откройте личный кабинет, чтобы посмотреть обновления.',
    icon:'/brand/hugh-icon-192.png',badge:'/brand/hugh-icon-192.png',tag:'synapse-cabinet',
    data:{url:'/cabinet.html'}
  }));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(windows=>{
    const existing=windows.find(w=>new URL(w.url).origin===self.location.origin && new URL(w.url).pathname==='/cabinet.html');
    return existing?existing.focus():clients.openWindow('/cabinet.html');
  }));

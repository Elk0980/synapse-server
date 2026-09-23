'use strict';
// Only the signed-in user's device can be subscribed or tested. Payloads contain no client data.
function createWebPush({db, requireSession, requireCsrf, readJson, sendJson, transport,
  publicKey = process.env.WEB_PUSH_PUBLIC_KEY || '', privateKey = process.env.WEB_PUSH_PRIVATE_KEY || '',
  subject = process.env.WEB_PUSH_SUBJECT || 'https://synapse.synapsebusiness.ru/', now = () => Date.now()}) {
  const fail = (status, message) => {throw Object.assign(new Error(message), {status});};
  const ready = Boolean(publicKey && privateKey);
  db.exec(`CREATE TABLE IF NOT EXISTS web_push_devices (
    endpoint TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    subscription_json TEXT NOT NULL, updated_at TEXT NOT NULL, last_test_at INTEGER NOT NULL DEFAULT 0)`);
  function subscription(value) {
    let url;
    try {url = new URL(value?.endpoint);} catch {fail(400, 'Некорректная подписка устройства');}
    const hosts = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !(hosts.includes(url.hostname) || url.hostname.endsWith('.notify.windows.com')) || value.endpoint.length > 2048) {
      fail(400, 'Этот сервис уведомлений пока не поддерживается');
    }
    const validKey = (key, length) => typeof key === 'string' && /^[A-Za-z0-9_-]+={0,2}$/.test(key) && Buffer.from(key,'base64url').length === length;
    if (!validKey(value.keys?.p256dh,65) || !validKey(value.keys?.auth,16)) fail(400,'Некорректные ключи устройства');
    return {endpoint:url.href, keys:{p256dh:value.keys.p256dh,auth:value.keys.auth}};
  }
  async function notify(userId, endpoint) {
    const row=db.prepare('SELECT * FROM web_push_devices WHERE user_id=? AND endpoint=?').get(userId,endpoint);
    if (!row) fail(404,'Сначала включите уведомления на этом устройстве');
    if (!ready) fail(503,'Доставка уведомлений ещё не подключена');
    if (row.last_test_at && now()-row.last_test_at<60000) fail(429,'Повторить проверку можно через минуту');
    db.prepare('UPDATE web_push_devices SET last_test_at=? WHERE endpoint=? AND user_id=?').run(now(),endpoint,userId);
    try {
      await transport.sendNotification(JSON.parse(row.subscription_json), JSON.stringify({title:'Synapse Business',body:'Уведомления работают. Откройте личный кабинет.',url:'/cabinet.html',tag:'synapse-test'}),
        {TTL:60,timeout:10000,vapidDetails:{subject,publicKey,privateKey}});
    } catch(error) {
      if ([404,410].includes(error.statusCode)) db.prepare('DELETE FROM web_push_devices WHERE endpoint=? AND user_id=?').run(endpoint,userId);
      fail(503,'Не удалось доставить проверочное уведомление. Попробуйте включить уведомления заново.');
    }
  }
  return {async handle(request,response,url) {
    if (!url.pathname.startsWith('/content/push/')) return false;
    const session=requireSession(request), userId=session.user.id;
    if (request.method==='GET' && url.pathname==='/content/push/config') {
      sendJson(response,200,{ready,publicKey:ready?publicKey:null});return true;
    }
    if (request.method!=='POST') fail(405,'Метод не поддерживается');
    requireCsrf(request,session);
    const body=await readJson(request);
    if (url.pathname==='/content/push/subscribe') {
      if (!ready) fail(503,'Доставка уведомлений ещё не подключена');
      const sub=subscription(body.subscription);
      const owner=db.prepare('SELECT user_id FROM web_push_devices WHERE endpoint=?').get(sub.endpoint);
      if(owner && owner.user_id!==userId) fail(409,'Переподключите уведомления для текущего аккаунта');
      const count=db.prepare('SELECT COUNT(*) AS n FROM web_push_devices WHERE user_id=?').get(userId).n;
      if(!owner && count>=10) fail(400,'Достигнут лимит устройств');
      db.prepare(`INSERT INTO web_push_devices(endpoint,user_id,subscription_json,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(endpoint) DO UPDATE SET subscription_json=excluded.subscription_json,updated_at=excluded.updated_at`)
        .run(sub.endpoint,userId,JSON.stringify(sub),new Date(now()).toISOString());
      sendJson(response,200,{subscribed:true});return true;
    }
    if (url.pathname==='/content/push/unsubscribe') {
      if(typeof body.endpoint!=='string') fail(400,'Не указано устройство');
      db.prepare('DELETE FROM web_push_devices WHERE endpoint=? AND user_id=?').run(body.endpoint,userId);
      sendJson(response,200,{subscribed:false});return true;
    }
    if (url.pathname==='/content/push/test') {
      if(typeof body.endpoint!=='string') fail(400,'Не указано устройство');
      await notify(userId,body.endpoint);sendJson(response,200,{accepted:true});return true;
    }
    fail(404,'Маршрут не найден');
  }};
}
module.exports={createWebPush};

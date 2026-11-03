'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createPeopleNotificationTransport}=require('./people-notification-transport');
test('официальная web-push библиотека действительно шифрует payload/VAPID; запрос перехвачен до сети',
  {skip:process.env.PEOPLE_TEST_REAL_WEB_PUSH!=='1'},async()=>{
    const webPush=require('web-push'),keys=webPush.generateVAPIDKeys(),ecdh=crypto.createECDH('prime256v1');
    const subscription={endpoint:'https://fcm.googleapis.com/send/synthetic-offline-35',keys:{p256dh:ecdh.generateKeys().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')}};
    let captured;
    const transport=createPeopleNotificationTransport({vapidSubject:'mailto:offline@example.invalid',vapidPublicKey:keys.publicKey,vapidPrivateKey:keys.privateKey,
      fetchImpl:async(url,options)=>{captured={url,options};return new Response(null,{status:201});}});
    const payload={audienceUserId:2,companyCode:'alvi',title:'Синтетический тест',body:'Уникальный тестовый текст без отправки'};
    assert.deepEqual(await transport.sendPush({subscription,payload}),{ok:true});
    assert.equal(captured.options.redirect,'error');assert.equal(captured.options.headers['Content-Encoding'],'aes128gcm');
    assert.match(captured.options.headers.Authorization,/^vapid /);assert.ok(Buffer.isBuffer(captured.options.body));
    assert.ok(!captured.options.body.includes(Buffer.from(payload.body)));assert.ok(captured.options.body.length>100);
  });

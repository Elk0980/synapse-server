'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createPeopleNotificationTransport} = require('./people-notification-transport');
const subscription={endpoint:'https://fcm.googleapis.com/send/synthetic',keys:{auth:Buffer.alloc(16,1).toString('base64url'),p256dh:Buffer.concat([Buffer.from([4]),Buffer.alloc(64,2)]).toString('base64url')}};
const payload={audienceUserId:1,companyCode:'alvi',title:'План',body:'Нужно ≥7',url:'/people.html'};
const configured={vapidSubject:'mailto:operator@example.invalid',vapidPublicKey:'synthetic-public',vapidPrivateKey:'synthetic-private'};
const requestDetails={headers:{'content-encoding':'aes128gcm'},body:Buffer.from('encrypted')};
test('не настроенный push не делает запроса и не выводит секреты',async () => {
  let calls=0;
  const transport=createPeopleNotificationTransport({fetchImpl:async()=>{calls++;}});
  assert.equal(transport.configured,false);assert.equal(transport.publicKey,'');
  await assert.rejects(transport.sendPush({subscription,payload}),{statusCode:503});assert.equal(calls,0);
});
test('push использует официальный encryptor и fetch без redirect',async () => {
  let encrypted=0,calls=0;
  const transport=createPeopleNotificationTransport({...configured,webPush:{generateRequestDetails(sub,body,options){
    encrypted++;assert.equal(sub.endpoint,subscription.endpoint);assert.equal(JSON.parse(body).audienceUserId,1);
    assert.equal(options.contentEncoding,'aes128gcm');assert.equal(options.TTL,300);return requestDetails;
  }},fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,subscription.endpoint);assert.equal(options.redirect,'error');assert.deepEqual(options.body,requestDetails.body);
    return new Response(null,{status:201});
  }});
  assert.deepEqual(await transport.sendPush({subscription,payload}),{ok:true});assert.equal(encrypted,1);assert.equal(calls,1);
});
test('push validation не допускает SSRF даже при прямом вызове транспорта',async () => {
  let calls=0;
  const transport=createPeopleNotificationTransport({...configured,fetchImpl:async()=>{calls++;}});
  await assert.rejects(transport.sendPush({subscription:{...subscription,endpoint:'https://127.0.0.1/'},payload}),{status:400});assert.equal(calls,0);
});
test('HTTP отказ известен, network timeout неизвестен; провайдерские детали не сохраняются',async () => {
  for (const status of [302,404,410,429,503]) {
    const transport=createPeopleNotificationTransport({...configured,webPush:{generateRequestDetails:()=>requestDetails},fetchImpl:async()=>new Response('private provider body',{status})});
    await assert.rejects(transport.sendPush({subscription,payload}),e=>e.statusCode===status&&!e.message.includes('private'));
  }
  const transport=createPeopleNotificationTransport({...configured,webPush:{generateRequestDetails:()=>requestDetails},fetchImpl:async()=>{throw Error(subscription.endpoint+' '+configured.vapidPrivateKey);}});
  await assert.rejects(transport.sendPush({subscription,payload}),e=>e.uncertain===true&&!e.message.includes('synthetic'));
});
test('Telegram использует только указанный проектный bot и private chatId',async () => {
  const recipient={userId:1,companyCode:'alvi',chatId:'123',botToken:'111:synthetic_token_012345678901234'};
  let calls=0;
  const transport=createPeopleNotificationTransport({fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,`https://api.telegram.org/bot${recipient.botToken}/sendMessage`);assert.equal(options.redirect,'error');
    const body=JSON.parse(options.body);assert.equal(body.chat_id,'123');assert.equal(body.text,'План\nНужно ≥7');
    return Response.json({ok:true,result:{message_id:7}});
  }});
  assert.deepEqual(await transport.sendTelegram({recipient,payload}),{ok:true});assert.equal(calls,1);
  await assert.rejects(transport.sendTelegram({recipient:{...recipient,chatId:'-123'},payload}),{statusCode:400});assert.equal(calls,1);
});
test('Telegram unknown/invalid response не превращается в подтверждённую доставку',async () => {
  const recipient={chatId:'123',botToken:'111:synthetic_token_012345678901234'};
  for (const answer of [{ok:true,result:{}},{unexpected:'data'}]) {
    const transport=createPeopleNotificationTransport({fetchImpl:async()=>Response.json(answer)});
    await assert.rejects(transport.sendTelegram({recipient,payload}),{uncertain:true});
  }
  const transport=createPeopleNotificationTransport({fetchImpl:async()=>Response.json({ok:false,error_code:403,description:'private details'})});
  await assert.rejects(transport.sendTelegram({recipient,payload}),e=>e.statusCode===403&&!e.message.includes('private'));
});

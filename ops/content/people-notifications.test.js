'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createPeopleNotifications,validatePushSubscription} = require('./people-notifications');

const subscription = (suffix = 'one', host = 'fcm.googleapis.com') => ({endpoint:`https://${host}/send/${suffix}`,expirationTime:null,
  keys:{auth:Buffer.alloc(16,1).toString('base64url'),p256dh:Buffer.concat([Buffer.from([4]),Buffer.alloc(64,2)]).toString('base64url')}});
function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE auth_users(id INTEGER PRIMARY KEY); INSERT INTO auth_users VALUES(1),(2),(3)');
  t.after(() => db.close());
  const users = new Map([[1,{id:1,role:'editor',companyCodes:['alvi','avokado']}],[2,{id:2,role:'editor',companyCodes:['alvi']}],[3,{id:3,role:'owner',companyCodes:['alvi','avokado']}] ]);
  const sent = [], authStore = {getById:id => users.get(id)};
  const config = {db,authStore,now:() => Date.parse('2026-11-06T01:00:00Z'),sendPush:async item => {sent.push(item);return {ok:true};},...options};
  const service = createPeopleNotifications(config);
  const consent = (id = 1, code = 'alvi', flags = {}) => service.setPreferences(id,code,{enabled:true,push:true,telegram:false,...flags});
  const event = (extra = {}) => service.enqueue({userId:1,companyCode:'alvi',eventKey:'friday:2026-11-06:morning',title:'План',body:'На согласовании 6, нужно ≥7',url:'/people.html#tasks',...extra});
  return {db,users,sent,service,consent,event,config};
}
test('уведомления исходно выключены; подписка не является согласием', async t => {
  const f = fixture(t);
  assert.deepEqual(f.service.getPreferences(1,'alvi'),{enabled:false,push:false,telegram:false,subscriptionCount:0,deliveryEnabled:false});
  f.service.subscribe(1,'alvi',subscription());
  assert.equal(f.event().queued,0);
  f.consent(); assert.equal(f.event().queued,1);
  assert.deepEqual(await f.service.runOnce(),{enabled:false,processed:0});
  assert.equal(f.sent.length,0);
  assert.equal(f.service.preview(1,'alvi').items[0].status,'pending');
});
test('дедупликация события по человеку/компании/устройству; безопасные публичные ответы', async t => {
  const f = fixture(t,{enabled:true}); f.consent();
  f.service.subscribe(1,'alvi',subscription()); f.service.subscribe(1,'alvi',subscription('two'));
  assert.equal(f.event().queued,2); assert.equal(f.event().queued,0);
  await f.service.runOnce(); await f.service.runOnce();
  assert.equal(f.sent.length,2);
  assert.equal(f.sent[0].payload.audienceUserId,1); assert.equal(f.sent[0].payload.companyCode,'alvi');
  assert.deepEqual(f.service.preview(1,'alvi').items.map(item => item.status),['sent','sent']);
  const publicResponse = JSON.stringify({preferences:f.service.getPreferences(1,'alvi'),preview:f.service.preview(1,'alvi')});
  assert.ok(!publicResponse.includes('fcm.googleapis')); assert.ok(!publicResponse.includes(subscription().keys.auth)); assert.ok(!publicResponse.includes('endpoint_hash'));
});
test('изоляция компаний и людей, повторное использование чужого endpoint запрещено', t => {
  const f = fixture(t);
  f.service.subscribe(1,'alvi',subscription());
  assert.throws(() => f.service.subscribe(2,'alvi',subscription()),{status:409});
  f.service.subscribe(1,'avokado',subscription());
  assert.throws(() => f.service.getPreferences(2,'avokado'),{status:403});
  assert.throws(() => f.service.subscribe(2,'avokado',subscription('two')),{status:403});
  assert.throws(() => f.service.preview(0,'alvi'),{status:400});
  f.consent(); f.consent(1,'avokado');
  assert.equal(f.event().queued,1); assert.equal(f.event({companyCode:'avokado'}).queued,1);
});
test('отзыв согласия отменяет pending и повторный opt-in не восстанавливает старую отправку', async t => {
  const f = fixture(t,{enabled:true}); f.consent(); f.service.subscribe(1,'alvi',subscription());f.event();
  f.service.setPreferences(1,'alvi',{enabled:false,push:true,telegram:false});
  await f.service.runOnce();assert.equal(f.sent.length,0);
  assert.equal(f.service.preview(1,'alvi').items[0].status,'cancelled');
  f.consent(); assert.equal(f.event().queued,0); await f.service.runOnce(); assert.equal(f.sent.length,0);
});
test('уже поставленное уведомление не уходит после отзыва доступа к проекту', async t => {
  const f = fixture(t,{enabled:true});f.consent();f.service.subscribe(1,'alvi',subscription());f.event();
  f.users.get(1).companyCodes=['avokado'];await f.service.runOnce();assert.equal(f.sent.length,0);
  assert.equal(f.db.prepare('SELECT status FROM people_notification_outbox').get().status,'cancelled');
});
test('удаление только своей подписки отменяет её pending и не затрагивает чужую', async t => {
  const f = fixture(t,{enabled:true});f.consent();f.service.subscribe(1,'alvi',subscription());f.event();
  f.service.unsubscribe(2,'alvi',{endpoint:subscription().endpoint});
  assert.equal(f.service.getPreferences(1,'alvi').subscriptionCount,1);
  f.service.unsubscribe(1,'alvi',{endpoint:subscription().endpoint});
  assert.equal(f.service.getPreferences(1,'alvi').subscriptionCount,0);await f.service.runOnce();assert.equal(f.sent.length,0);
});
test('неизвестный результат не повторяется после нового тика и перезапуска', async t => {
  let calls=0;
  const f = fixture(t,{enabled:true,sendPush:async () => {calls++;throw new Error('secret endpoint and token must not be persisted');}});
  f.consent();f.service.subscribe(1,'alvi',subscription());f.event();await f.service.runOnce();
  const second=createPeopleNotifications(f.config);await second.runOnce();assert.equal(calls,1);
  const result=second.preview(1,'alvi').items[0];assert.equal(result.status,'uncertain');assert.equal(result.errorCode,'SEND_OUTCOME_UNKNOWN');
  assert.ok(!JSON.stringify(result).includes('secret'));
});
test('рестарт после claim оставляет uncertain без попытки повторной доставки', async t => {
  const f=fixture(t,{enabled:true});f.consent();f.service.subscribe(1,'alvi',subscription());f.event();
  f.db.exec("UPDATE people_notification_outbox SET status='sending',attempts=1");
  const second=createPeopleNotifications(f.config);await second.runOnce();
  assert.equal(f.sent.length,0);assert.equal(second.preview(1,'alvi').items[0].status,'uncertain');
});
test('push404/410 удаляет просроченную подписку и не повторяет отказы', async t => {
  const f=fixture(t,{enabled:true,sendPush:async () => {throw Object.assign(new Error('provider details'),{statusCode:410});}});
  f.consent();f.service.subscribe(1,'alvi',subscription());f.event();f.event({eventKey:'another'});await f.service.runOnce();
  assert.equal(f.service.getPreferences(1,'alvi').subscriptionCount,0);
  const items=f.service.preview(1,'alvi').items;assert.equal(items.find(row => row.eventKey==='another').status,'cancelled');
  assert.equal(items.find(row => row.eventKey!=='another').errorCode,'SUBSCRIPTION_EXPIRED');
});
test('Telegram разрешается только для точного человека и проекта, без fallback владельцу', async t => {
  let sends=0;
  const f=fixture(t,{enabled:true,resolveTelegram:async () => ({userId:3,companyCode:'alvi',chatId:'123',botToken:'synthetic'}),sendTelegram:async () => {sends++;return {ok:true};}});
  f.consent(1,'alvi',{push:false,telegram:true});f.event();await f.service.runOnce();
  assert.equal(sends,0);assert.equal(f.service.preview(1,'alvi').items[0].errorCode,'TELEGRAM_NOT_LINKED');
});
test('отзыв доступа или согласия во время async Telegram lookup останавливает отправку', async t => {
  let sends=0, service;
  const f=fixture(t,{enabled:true,resolveTelegram:async () => {
    service.setPreferences(1,'alvi',{enabled:false,push:false,telegram:true});
    return {userId:1,companyCode:'alvi',chatId:'123',botToken:'synthetic'};
  },sendTelegram:async () => {sends++;return {ok:true};}});service=f.service;
  f.consent(1,'alvi',{push:false,telegram:true});f.event();await service.runOnce();assert.equal(sends,0);
  assert.equal(service.preview(1,'alvi').items[0].status,'cancelled');
});
test('двойной одновременный тик не отправляет событие дважды', async t => {
  const f=fixture(t,{enabled:true});f.consent();f.service.subscribe(1,'alvi',subscription());f.event();
  await Promise.all([f.service.runOnce(),f.service.runOnce()]);assert.equal(f.sent.length,1);
});
test('subscription validation закрывает SSRF, credentials, порты и подмену provider suffix', () => {
  for (const endpoint of ['http://fcm.googleapis.com/send/x','https://localhost/','https://127.0.0.1/','https://[::1]/',
    'https://169.254.169.254/','https://fcm.googleapis.com.evil.test/send/x','https://user:pass@fcm.googleapis.com/send/x',
    'https://fcm.googleapis.com:444/send/x','https://fcm.googleapis.com/send/x#hash','https://sub.push.services.mozilla.com/send/x',
    'https://evilnotify.windows.com/x','https://fcm.googleapis.com\\@evil.test/x']) {
    assert.throws(() => validatePushSubscription({...subscription(),endpoint}),{status:400},endpoint);
  }
  for (const host of ['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com','wns.notify.windows.com']) assert.equal(new URL(validatePushSubscription(subscription('x',host)).endpoint).hostname,host);
  assert.throws(() => validatePushSubscription({...subscription(),keys:{...subscription().keys,auth:'short'}}),{status:400});
  assert.throws(() => validatePushSubscription({...subscription(),expirationTime:1}),{status:400});
});
test('очередь отклоняет внешние ссылки и лишние поля настройки', t => {
  const f=fixture(t);f.consent();
  for (const url of ['https://evil.test','//evil.test','/\\evil.test','/people.html\n']) assert.throws(() => f.event({url}),{status:400});
  assert.throws(() => f.service.setPreferences(1,'alvi',{enabled:true,push:true,telegram:true,userId:3}),{status:400});
  assert.throws(() => f.event({body:'Я'.repeat(2000)}),{status:400});
});
test('отзыв права без удаления компании блокирует enqueue/preview и отменяет pending', async t => {
  let permitted = true;
  const f = fixture(t,{enabled:true,canReceive:(userId,code) => permitted && userId===1 && code==='alvi'});
  f.consent();f.service.subscribe(1,'alvi',subscription());f.event();
  permitted = false;
  assert.deepEqual(f.users.get(1).companyCodes,['alvi','avokado']);
  assert.throws(() => f.event({eventKey:'later'}),{status:403});
  assert.throws(() => f.service.preview(1,'alvi'),{status:403});
  assert.throws(() => f.service.getPreferences(1,'alvi'),{status:403});
  await f.service.runOnce();assert.equal(f.sent.length,0);
  assert.deepEqual({...f.db.prepare('SELECT status,error_code FROM people_notification_outbox').get()},
    {status:'cancelled',error_code:'ACCESS_OR_CONSENT_REVOKED'});
});
test('проверка источника получает точные user/company/event/payload и отменяет старый текст', async t => {
  let checked=0;
  const f=fixture(t,{enabled:true,validateEvent:async event => {
    checked++;assert.equal(event.userId,1);assert.equal(event.companyCode,'alvi');
    assert.equal(event.eventKey,'friday:2026-11-06:morning');assert.equal(event.payload.body,'На согласовании 6, нужно ≥7');
    assert.equal(event.payload.audienceUserId,1);return false;
  }});
  f.consent();f.service.subscribe(1,'alvi',subscription());f.event();await f.service.runOnce();
  assert.equal(checked,1);assert.equal(f.sent.length,0);
  assert.equal(f.service.preview(1,'alvi').items[0].status,'cancelled');
  assert.equal(f.service.preview(1,'alvi').items[0].errorCode,'SOURCE_CHANGED');
  const restarted=createPeopleNotifications({...f.config,validateEvent:async()=>true});await restarted.runOnce();
  assert.equal(f.sent.length,0);assert.equal(restarted.preview(1,'alvi').items[0].errorCode,'SOURCE_CHANGED');
});
test('ошибка чтения источника не вызывает транспорт и не сохраняет приватную ошибку', async t => {
  const f=fixture(t,{enabled:true,validateEvent:async()=>{throw new Error('secret source details');}});
  f.consent();f.service.subscribe(1,'alvi',subscription());f.event();await f.service.runOnce();
  assert.equal(f.sent.length,0);const item=f.service.preview(1,'alvi').items[0];
  assert.equal(item.status,'error');assert.equal(item.errorCode,'SOURCE_UNAVAILABLE');assert.ok(!JSON.stringify(item).includes('secret'));
});
test('отзыв права во время async проверки источника останавливает отправку', async t => {
  let permitted=true;
  const f=fixture(t,{enabled:true,canReceive:()=>permitted,validateEvent:async()=>{await Promise.resolve();permitted=false;return true;}});
  f.consent();f.service.subscribe(1,'alvi',subscription());f.event();await f.service.runOnce();assert.equal(f.sent.length,0);
  assert.equal(f.db.prepare('SELECT error_code FROM people_notification_outbox').get().error_code,'ACCESS_OR_CONSENT_REVOKED');
});
test('переназначение во время поиска Telegram-получателя отменяет текст до отправки', async t => {
  let current=true,lookups=0,sends=0,checks=0;
  const f=fixture(t,{enabled:true,validateEvent:async()=>{checks++;return current;},resolveTelegram:async()=>{
    lookups++;current=false;return {userId:1,companyCode:'alvi',chatId:'123',botToken:'synthetic'};
  },sendTelegram:async()=>{sends++;return {ok:true};}});
  f.consent(1,'alvi',{push:false,telegram:true});f.event();await f.service.runOnce();
  assert.equal(lookups,1);assert.equal(checks,2);assert.equal(sends,0);assert.equal(f.service.preview(1,'alvi').items[0].errorCode,'SOURCE_CHANGED');
});
test('неактуальное событие не вызывает даже поиск Telegram-получателя', async t => {
  let lookups=0;
  const f=fixture(t,{enabled:true,validateEvent:async()=>false,resolveTelegram:async()=>{lookups++;},sendTelegram:async()=>{throw new Error('не должен вызываться');}});
  f.consent(1,'alvi',{push:false,telegram:true});f.event();await f.service.runOnce();assert.equal(lookups,0);
});
test('изменившийся счётчик обновляет безопасно отменённый payload того же слота и доставляется один раз', async t => {
  let currentBody='На согласовании 7, нужно ≥7';
  const f=fixture(t,{enabled:true,validateEvent:async ({payload})=>payload.body===currentBody});
  f.consent();f.service.subscribe(1,'alvi',subscription());f.event();await f.service.runOnce();
  const before=f.service.preview(1,'alvi').items[0];assert.equal(before.errorCode,'SOURCE_CHANGED');assert.equal(f.sent.length,0);
  assert.equal(f.event({body:currentBody}).queued,1);assert.equal(f.event({body:currentBody}).queued,0);
  await f.service.runOnce();await f.service.runOnce();
  const after=f.service.preview(1,'alvi').items[0];assert.equal(after.id,before.id);assert.equal(after.status,'sent');assert.equal(after.attempts,2);
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].payload.body,currentBody);
});
test('временный отказ источника до отправки восстанавливается только свежим enqueue', async t => {
  let available=false;
  const f=fixture(t,{enabled:true,validateEvent:async()=>{if(!available)throw new Error('temporary private source error');return true;}});
  f.consent();f.service.subscribe(1,'alvi',subscription());f.event();await f.service.runOnce();
  assert.equal(f.sent.length,0);assert.equal(f.service.preview(1,'alvi').items[0].errorCode,'SOURCE_UNAVAILABLE');
  available=true;await f.service.runOnce();assert.equal(f.sent.length,0);
  assert.equal(f.event().queued,1);await f.service.runOnce();assert.equal(f.sent.length,1);
  assert.equal(f.event().queued,0);assert.equal(f.service.preview(1,'alvi').items.length,1);
});
test('свежий enqueue не восстанавливает неизвестный результат отправки даже с другим текстом', async t => {
  let calls=0;
  const f=fixture(t,{enabled:true,sendPush:async()=>{calls++;throw Error('network outcome unknown');}});
  f.consent();f.service.subscribe(1,'alvi',subscription());f.event();await f.service.runOnce();
  assert.equal(f.service.preview(1,'alvi').items[0].status,'uncertain');
  assert.equal(f.event({body:'На согласовании 7, нужно ≥7'}).queued,0);
  const restarted=createPeopleNotifications(f.config);await restarted.runOnce();assert.equal(calls,1);
  assert.equal(restarted.preview(1,'alvi').items[0].status,'uncertain');
});
test('свежий enqueue не повторяет уже доставленный слот даже при изменении счётчика', async t => {
  const f=fixture(t,{enabled:true});f.consent();f.service.subscribe(1,'alvi',subscription());f.event();await f.service.runOnce();
  assert.equal(f.event({body:'На согласовании 7, нужно ≥7'}).queued,0);await f.service.runOnce();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].payload.body,'На согласовании 6, нужно ≥7');
  assert.equal(f.service.preview(1,'alvi').items[0].status,'sent');
});

test('owner decision push-only, eventKey persisted, restart and repeated tick do not duplicate',async t=>{
 const f=fixture(t,{enabled:true});f.consent(3,'alvi',{telegram:true});f.service.subscribe(3,'alvi',subscription('owner'));
 const event={userId:3,companyCode:'alvi',eventKey:'owner-decision:106:created',title:'Нужно ваше решение: №106 Выбор',body:'Выбор',url:'/cabinet/people.html?company=alvi&task=106',pushOnly:true};
 assert.equal(f.service.enqueue(event).queued,1);assert.equal(f.service.enqueue(event).queued,0);
 await f.service.runOnce();assert.equal(f.sent.length,1);assert.equal(f.sent[0].payload.eventKey,event.eventKey);
 const restarted=createPeopleNotifications(f.config);assert.equal(restarted.enqueue(event).queued,0);await restarted.runOnce();assert.equal(f.sent.length,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM people_notification_outbox WHERE channel='telegram'").get().n,0);
});

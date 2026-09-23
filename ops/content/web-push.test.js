const test=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createWebPush}=require('./web-push');
function fixture(options={}) {
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE auth_users(id INTEGER PRIMARY KEY); INSERT INTO auth_users VALUES(1),(2)');
  const sent=[];
  const api=createWebPush({db,publicKey:'public-test',privateKey:'private-test',
    requireSession:r=>{if(!r.user)throw Object.assign(new Error('login'),{status:401});return {user:{id:r.user}};},
    requireCsrf:r=>{if(!r.csrf)throw Object.assign(new Error('csrf'),{status:403});},
    readJson:async r=>r.body,sendJson:(r,status,body)=>Object.assign(r,{status,body}),
    transport:{sendNotification:async(...args)=>sent.push(args)},...options});
  const sub={endpoint:'https://fcm.googleapis.com/example',keys:{p256dh:Buffer.alloc(65,4).toString('base64url'),auth:Buffer.alloc(16,1).toString('base64url')}};
  async function call(path,body={},user=1,csrf=true,method='POST') {const res={};await api.handle({user,csrf,method,body},res,new URL('https://test/content/push/'+path));return res.body;}
  return {db,sub,call,sent};
}
test('authentication and CSRF protect device mutations',async()=>{
  const f=fixture();
  await assert.rejects(f.call('subscribe',{},null),{status:401});
  await assert.rejects(f.call('subscribe',{},1,false),{status:403});
  f.db.close();
});
test('config exposes only public key and disables missing credentials',async()=>{
  const f=fixture({privateKey:''});
  assert.deepEqual(await f.call('config',{},1,false,'GET'),{ready:false,publicKey:null});
  await assert.rejects(f.call('subscribe',{subscription:f.sub}),{status:503});f.db.close();
});
test('rejects arbitrary endpoints before outbound delivery',async()=>{
  const f=fixture();
  for(const endpoint of ['https://127.0.0.1/internal','http://fcm.googleapis.com/a','https://fcm.googleapis.com.evil.test/a','https://user@fcm.googleapis.com/a'])
    await assert.rejects(f.call('subscribe',{subscription:{...f.sub,endpoint}}),{status:400});
  assert.equal(f.sent.length,0);f.db.close();
});
test('devices are private; repeated tests are rate limited',async()=>{
  const f=fixture();await f.call('subscribe',{subscription:f.sub});
  await assert.rejects(f.call('subscribe',{subscription:f.sub},2),{status:409});
  await assert.rejects(f.call('test',{endpoint:f.sub.endpoint},2),{status:404});
  await f.call('unsubscribe',{endpoint:f.sub.endpoint},2);
  await f.call('test',{endpoint:f.sub.endpoint});
  assert.equal(f.sent.length,1);
  await assert.rejects(f.call('test',{endpoint:f.sub.endpoint}),{status:429});
  await f.call('unsubscribe',{endpoint:f.sub.endpoint});
  assert.equal(f.db.prepare('SELECT count(*) n FROM web_push_devices').get().n,0);f.db.close();
});
test('expired subscription is removed',async()=>{
  const f=fixture({transport:{sendNotification:async()=>{throw {statusCode:410};}}});
  await f.call('subscribe',{subscription:f.sub});
  await assert.rejects(f.call('test',{endpoint:f.sub.endpoint}),{status:503});
  assert.equal(f.db.prepare('SELECT count(*) n FROM web_push_devices').get().n,0);f.db.close();
});

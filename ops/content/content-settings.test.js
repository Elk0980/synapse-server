'use strict';
// №98: Настройки → Контент — хранение по компании, права, версии, изоляция компаний.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createAuthStore}=require('./auth-store');
const {hashPassword}=require('./passwords');
const {createContentSettings}=require('./content-settings');
const hash=hashPassword('Example-Only-Password-42');

function setup(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const auth=createAuthStore(db,`root:owner:${hash}`),owner=auth.getByLogin('root');
  const mk=(login,companies,permissions)=>auth.create(owner.id,{login,displayName:login,password:'x',companies,permissions},hash);
  const lena=mk('lena',['avokado'],['content-plan.approve','autoposting.view']);
  const smm=mk('smm',['avokado'],['autoposting.view','autoposting.edit']);
  const tuner=mk('tuner',['avokado'],['settings.edit']);
  const alien=mk('alien',['alvi'],['content-plan.approve','settings.edit']);
  const sent=[];
  const sessions=new Map([owner,lena,smm,tuner,alien].map(u=>[u.login,{user:auth.getById(u.id),csrf:'t-'+u.login}]));
  const settings=createContentSettings({db,authStore:auth,
    requireSession:r=>{const s=sessions.get(r.headers.user);if(!s)throw Object.assign(new Error('Требуется вход'),{status:401});return s;},
    requireCsrf:(r,s)=>{if(r.headers['x-csrf-token']!==s.csrf)throw Object.assign(new Error('CSRF'),{status:403});},
    readJson:async r=>r.body,sendJson:(res,status,payload)=>sent.push({status,payload})});
  const call=async(user,method,code,body,csrf=true)=>{
    sent.length=0;
    const url=new URL('https://cabinet.test/content/content-settings'+(code?`?companyCode=${code}`:''));
    try{await settings.handle({method,headers:{user,...(csrf?{'x-csrf-token':'t-'+user}:{})},body},{},url);return sent[0];}
    catch(error){return {status:error.status,payload:{error:error.message,code:error.details?.code}};}
  };
  return {db,auth,owner,lena,smm,tuner,alien,settings,call};
}
const valid=(over={})=>({approverUserIds:[],shootingWeekdays:[2,4],deadlineDays:3,platforms:['vk','instagram'],
  caption:{font:'Montserrat',size:'l',color:'#FFCC00',uppercase:true},...over});

test('значения по умолчанию, кандидаты — только люди компании с правом согласования и владелец',async t=>{
  const f=setup(t),r=await f.call('smm','GET','avokado');
  assert.equal(r.status,200);assert.equal(r.payload.version,0);assert.equal(r.payload.canEdit,false);
  assert.deepEqual(r.payload.settings.shootingWeekdays,[]);assert.equal(r.payload.settings.caption.font,'Inter');
  assert.deepEqual(r.payload.candidates.map(c=>c.name).sort(),['lena','root']);
  assert.ok(!JSON.stringify(r.payload).includes(hash),'хеши паролей не уходят наружу');
});

test('настройщик сохраняет, значения нормализуются, версия растёт; чужая версия — 409',async t=>{
  const f=setup(t);
  const saved=await f.call('tuner','PUT','avokado',{version:0,settings:valid({approverUserIds:[f.lena.id,f.owner.id]})});
  assert.equal(saved.status,200);assert.equal(saved.payload.version,1);assert.equal(saved.payload.updatedBy,'tuner');
  assert.deepEqual(saved.payload.settings.platforms,['instagram','vk'],'порядок площадок канонический');
  assert.equal(saved.payload.settings.caption.color,'#ffcc00');
  assert.deepEqual(saved.payload.settings.approverUserIds,[f.owner.id,f.lena.id].sort((a,b)=>a-b));
  const stale=await f.call('root','PUT','avokado',{version:0,settings:valid()});
  assert.equal(stale.status,409);assert.equal(stale.payload.code,'VERSION_CONFLICT');
  const read=await f.call('lena','GET','avokado');assert.equal(read.payload.version,1);assert.equal(read.payload.settings.deadlineDays,3);
});

test('без settings.edit, без CSRF, без доступа к компании и с чужим согласующим — отказ',async t=>{
  const f=setup(t);
  assert.equal((await f.call('smm','PUT','avokado',{version:0,settings:valid()})).status,403);
  assert.equal((await f.call('lena','PUT','avokado',{version:0,settings:valid()})).status,403);
  assert.equal((await f.call('tuner','PUT','avokado',{version:0,settings:valid()},false)).status,403);
  assert.equal((await f.call('alien','GET','avokado')).status,403,'другая компания не читается');
  assert.equal((await f.call('alien','PUT','avokado',{version:0,settings:valid()})).status,403);
  assert.equal((await f.call('tuner','GET','')).status,400);
  assert.equal((await f.call('nobody','GET','avokado')).status,401);
  const foreign=await f.call('tuner','PUT','avokado',{version:0,settings:valid({approverUserIds:[f.alien.id]})});
  assert.equal(foreign.status,400,'человек другой компании не может согласовывать');
  assert.equal((await f.call('tuner','DELETE','avokado')).status,405);
});

test('строгая проверка полей',async t=>{
  const f=setup(t);
  for(const bad of [valid({extra:1}),valid({shootingWeekdays:[0]}),valid({shootingWeekdays:[1,1]}),valid({deadlineDays:61}),
    valid({deadlineDays:1.5}),valid({platforms:['facebook']}),valid({caption:{font:'Comic Sans',size:'m',color:'#ffffff',uppercase:false}}),
    valid({caption:{font:'Inter',size:'xl',color:'#ffffff',uppercase:false}}),valid({caption:{font:'Inter',size:'m',color:'red',uppercase:false}}),
    valid({caption:{font:'Inter',size:'m',color:'#ffffff'}})]){
    assert.equal((await f.call('tuner','PUT','avokado',{version:0,settings:bad})).status,400,JSON.stringify(bad));
  }
  assert.equal((await f.call('tuner','PUT','avokado',{settings:valid()})).status,400);
  assert.equal((await f.call('tuner','PUT','avokado',{version:0,settings:valid(),more:1})).status,400);
});

test('компании изолированы; отозванное право согласующего убирает его из выдачи',async t=>{
  const f=setup(t);
  await f.call('root','PUT','avokado',{version:0,settings:valid({approverUserIds:[f.lena.id]})});
  const alvi=await f.call('root','GET','alvi');assert.equal(alvi.payload.version,0);assert.deepEqual(alvi.payload.settings.platforms,[]);
  f.auth.updateAccess(f.owner.id,f.lena.id,['avokado'],['autoposting.view']);
  const after=await f.call('root','GET','avokado');assert.deepEqual(after.payload.settings.approverUserIds,[]);
  assert.ok(!after.payload.candidates.some(c=>c.id===f.lena.id));
  // Права перечитываются из базы на каждом запросе, а не из сохранённой сессии.
  f.auth.updateAccess(f.owner.id,f.tuner.id,['avokado'],['settings.view']);
  assert.equal((await f.call('tuner','PUT','avokado',{version:1,settings:valid()})).status,403);
});

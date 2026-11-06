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

test('№181: ссылка сохраняется, изолирована, старый PUT сохраняет новое поле; опасные ссылки отклоняются',async t=>{
  const f=setup(t),url='https://docs.google.com/spreadsheets/d/sample/edit';
  const saved=await f.call('root','PUT','avokado',{version:0,settings:valid({contentPlanSheetUrl:url})});
  assert.equal(saved.status,200);assert.equal(saved.payload.settings.contentPlanSheetUrl,url);
  const old=await f.call('root','PUT','avokado',{version:1,settings:valid()});
  assert.equal(old.status,200);assert.equal(old.payload.settings.contentPlanSheetUrl,url);
  const other=await f.call('root','GET','alvi');assert.ok(!other.payload.settings.contentPlanSheetUrl);
  for(const bad of ['javascript:alert(1)','http://docs.google.com/spreadsheets/d/test','https://docs.google.com.evil.test/spreadsheets/d/test','https://user:pass@docs.google.com/spreadsheets/d/test']){
    const r=await f.call('root','PUT','avokado',{version:2,settings:valid({contentPlanSheetUrl:bad})});assert.equal(r.status,400);
  }
  const cleared=await f.call('root','PUT','avokado',{version:2,settings:valid({contentPlanSheetUrl:''})});assert.equal(cleared.payload.settings.contentPlanSheetUrl,'');
});

// №208: Настройки → Контент-план → Уведомления — матрица «этап × роль». Только хранение; отправки здесь нет.
const STAGES=['script_review','script_rework','planned','shot','edit_review','edit_rework','ready','published','publish_error'];
const ROLES=['owner','approver','content','shooting','editor'];
const matrix=(over={})=>({script_review:['owner','approver'],script_rework:['content'],planned:['content','shooting'],shot:['content','editor'],
  edit_review:['approver','content'],edit_rework:['editor'],ready:['content'],published:[...ROLES],publish_error:['owner','content'],...over});

test('№208: матрица уведомлений — значения по умолчанию, этапы и роли в ответе',async t=>{
  const f=setup(t),r=await f.call('lena','GET','avokado');
  assert.equal(r.status,200);
  assert.deepEqual(r.payload.settings.notificationMatrix,matrix());
  assert.deepEqual(r.payload.options.notifications,{stages:STAGES,roles:ROLES});
  assert.deepEqual(r.payload.settings.notificationMatrix.script_review,['owner','approver'],'согласующему и владельцу — сценарий на согласовании');
  assert.deepEqual(r.payload.settings.notificationMatrix.edit_rework,['editor'],'монтажёру — монтаж на доработке');
  assert.deepEqual(r.payload.settings.notificationMatrix.published,ROLES,'всем — опубликовано');
});

test('№208: матрица сохраняется и нормализуется, изолирована по компании; старый PUT её не стирает',async t=>{
  const f=setup(t);
  const saved=await f.call('tuner','PUT','avokado',{version:0,settings:valid({notificationMatrix:matrix({ready:['editor','owner'],shot:[]})})});
  assert.equal(saved.status,200);assert.equal(saved.payload.version,1);
  assert.deepEqual(saved.payload.settings.notificationMatrix.ready,['owner','editor'],'порядок ролей канонический');
  assert.deepEqual(saved.payload.settings.notificationMatrix.shot,[],'пустой этап — допустим');
  const old=await f.call('tuner','PUT','avokado',{version:1,settings:valid({deadlineDays:5})});
  assert.equal(old.status,200);assert.deepEqual(old.payload.settings.notificationMatrix.ready,['owner','editor']);
  const sheet=await f.call('tuner','PUT','avokado',{version:2,settings:valid({contentPlanSheetUrl:'https://docs.google.com/spreadsheets/d/sample/edit',notificationMatrix:matrix()})});
  assert.equal(sheet.status,200);assert.deepEqual(sheet.payload.settings.notificationMatrix,matrix());
  assert.equal(sheet.payload.settings.contentPlanSheetUrl,'https://docs.google.com/spreadsheets/d/sample/edit');
  const alvi=await f.call('root','GET','alvi');assert.deepEqual(alvi.payload.settings.notificationMatrix,matrix(),'у другой компании — свои значения');
  assert.equal((await f.call('smm','PUT','avokado',{version:3,settings:valid({notificationMatrix:matrix()})})).status,403,'без settings.edit — отказ');
});

test('№208: строгая проверка формы матрицы',async t=>{
  const f=setup(t);
  const {publish_error,...missing}=matrix();
  for(const bad of [null,[],'all',{},missing,matrix({unpublished:[]}),matrix({ready:'content'}),matrix({ready:['content','content']}),
    matrix({ready:['smm']}),matrix({ready:[1]}),matrix({ready:null}),matrix({ready:[...ROLES,'owner']})]){
    const r=await f.call('tuner','PUT','avokado',{version:0,settings:valid({notificationMatrix:bad})});
    assert.equal(r.status,400,JSON.stringify(bad));
  }
  assert.equal((await f.call('tuner','GET','avokado')).payload.version,0,'отклонённое не сохраняется');
  // Повреждённая запись в базе не ломает чтение — показываются значения по умолчанию.
  f.db.prepare('INSERT INTO content_settings(company_code,body,version,updated_at,updated_by) VALUES(?,?,?,?,?)')
    .run('avokado',JSON.stringify({...valid(),notificationMatrix:{ready:['x']}}),1,new Date().toISOString(),f.owner.id);
  assert.deepEqual((await f.call('tuner','GET','avokado')).payload.settings.notificationMatrix,matrix());
});

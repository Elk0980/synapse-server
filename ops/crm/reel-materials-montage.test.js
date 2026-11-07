'use strict';
// Автомонтаж (specs/214-auto-montage): служебные вызовы CRM по идее плана. node --test ops/crm/reel-materials-montage.test.js
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createReelMaterials}=require('./reel-materials');
const {createReelMaterialsHandler}=require('./reel-materials-http');
const asset=(code,n='a')=>`https://synapse.synapsebusiness.ru/content/publishing-assets/${code}/${n.repeat(32)}.mp4`;

function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,is_deleted INTEGER DEFAULT 0,timezone TEXT);
    INSERT INTO companies(id,code) VALUES(1,'avokado'),(2,'alvi');
    CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT,updated_at TEXT,is_deleted INTEGER DEFAULT 0,title TEXT,description TEXT,company_code TEXT,
      assignee_role TEXT,assignee_name TEXT,status TEXT,priority TEXT DEFAULT 'normal',due_date TEXT DEFAULT '',source TEXT,source_ref TEXT,source_author TEXT,created_by TEXT);
    CREATE TABLE media_mentor_plans(company_id INTEGER PRIMARY KEY,revision INTEGER,brief_revision INTEGER,plan TEXT,updated_at TEXT);`);
  const plan=days=>JSON.stringify({days});
  db.prepare('INSERT INTO media_mentor_plans VALUES(?,?,?,?,?)').run(1,1,1,plan([{ideaId:'r-1',date:'2026-11-10',platform:'instagram',topic:'Рилс о студии',hook:'Хук',
    script:'0–2 с | Лена | Привет | крупно | — | Титр один',variants:{instagram:{},tiktok:{}}}]),'x');
  db.prepare('INSERT INTO media_mentor_plans VALUES(?,?,?,?,?)').run(2,1,1,plan([{ideaId:'alvi-1',topic:'Чужая идея',script:'секрет'}]),'x');
  const materials=createReelMaterials(db,{autoposting:{list:()=>({posts:[]})},information:{get:()=>({revision:1})}});
  return {db,materials};
}

test('Идея: сценарий и площадки только своей компании; черновик создаёт ролик идеи, повтор — v2',()=>{
  const {materials}=fixture();
  const info=materials.ideaInfo('avokado','r-1');
  assert.equal(info.idea.script,'0–2 с | Лена | Привет | крупно | — | Титр один');
  assert.deepEqual(info.idea.platforms,['instagram','tiktok']);
  assert.equal(info.reel,null);
  assert.throws(()=>materials.ideaInfo('avokado','alvi-1'),{status:404},'идея другой компании не читается');
  const first=materials.addIdeaVersion('avokado','r-1',{mediaUrl:asset('avokado'),sha256:'b'.repeat(64),durationMs:4000,note:'Автомонтаж'},'hugh-automontage');
  assert.equal(first.created,true);assert.equal(first.version.version,1);assert.equal(first.reel.ideaId,'r-1');
  assert.equal(first.reel.title,'Рилс о студии');assert.equal(first.reel.releaseDate,'2026-11-10');
  const second=materials.addIdeaVersion('avokado','r-1',{mediaUrl:asset('avokado','c'),durationMs:3000,note:'Автомонтаж 2'},'hugh-automontage');
  assert.equal(second.reel.id,first.reel.id);assert.equal(second.version.version,2);
  assert.equal(materials.ideaInfo('avokado','r-1').reel.id,first.reel.id);
  assert.throws(()=>materials.addIdeaVersion('avokado','r-1',{mediaUrl:asset('alvi')}),{status:403},'файл другой компании не принимается');
  assert.throws(()=>materials.addIdeaVersion('avokado','r-1',{mediaUrl:asset('avokado').replace('synapse.synapsebusiness.ru','evil.example')}),{status:400});
  assert.throws(()=>materials.addIdeaVersion('avokado','r-1',{mediaUrl:asset('avokado'),extra:1}),{status:400});
});

test('Маршрут идей: только ключ сервиса без личности, GET и POST versions',async()=>{
  const {materials}=fixture();
  const sent=[];
  const handle=createReelMaterialsHandler({materials,companyModuleContext:()=>{throw Error('не нужен');},readJson:async request=>request.body,
    send:(response,status,body)=>sent.push({status,body}),trustedService:request=>!request.headers['x-synapse-crm-identity']});
  const url=path=>new URL('http://crm'+path);
  await assert.rejects(handle({method:'GET',headers:{'x-synapse-crm-identity':'x'}},{},url('/internal/reel-materials/ideas/r-1?companyCode=avokado')),{status:403});
  await handle({method:'GET',headers:{}},{},url('/internal/reel-materials/ideas/r-1?companyCode=avokado'));
  assert.equal(sent.at(-1).body.idea.ideaId,'r-1');
  await handle({method:'POST',headers:{'x-agent-name':'hugh-automontage'},body:{mediaUrl:asset('avokado'),durationMs:2000}},{},url('/internal/reel-materials/ideas/r-1/versions?companyCode=avokado'));
  assert.equal(sent.at(-1).body.version.version,1);
  await assert.rejects(handle({method:'POST',headers:{}},{},url('/internal/reel-materials/ideas/r-1?companyCode=avokado')),{status:405});
});

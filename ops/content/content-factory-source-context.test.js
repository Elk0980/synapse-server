'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createSourceContext}=require('./content-factory-source-context');
const {validateSourceLibrary}=require('../crm/content-plan-jobs');
const {createHash}=require('node:crypto');
function rehash(value){
 const ordered=item=>Array.isArray(item)?item.map(ordered):item&&typeof item==='object'?Object.fromEntries(Object.keys(item).sort().map(k=>[k,ordered(item[k])])):item;
 const {hash,...payload}=value;return {...value,hash:createHash('sha256').update(JSON.stringify(ordered(payload))).digest('hex')};
}
const metadata=()=>({platforms:['telegram'],formats:['post'],occasion:'Праздник',eventDate:'2026-10-02',usageRestrictions:'Проверить разрешение',materialState:'source'});
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE telegram_source_items(id INTEGER PRIMARY KEY,company_code TEXT,revision INTEGER,sha256 TEXT,
    name TEXT,mime TEXT,size INTEGER,declared_size INTEGER,status TEXT,caption TEXT,metadata TEXT,
    disk_name TEXT,chat_id TEXT,file_id TEXT,imported_by INTEGER)`);
  const insert=db.prepare('INSERT INTO telegram_source_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const add=(id,{code='alpha',status='stored',caption='Подпись',meta=metadata()}={})=>insert.run(id,code,2,status==='stored'?'a'.repeat(64):null,
    status==='stored'?'Фото.jpg':'',status==='stored'?'image/jpeg':'',status==='stored'?100:null,null,status,caption,JSON.stringify(meta),'private/disk','private/chat','private/file',999);
  return {db,add,api:createSourceContext({db})};
}
test('снимок своей компании сохраняет подпись/metadata, исключает приватные поля и недоступные статусы',t=>{
  const f=fixture(t);f.add(1);f.add(2,{status:'text'});f.add(3,{code:'beta'});f.add(4,{status:'manual_import'});
  const manifest=f.api.capture('alpha');assert.equal(manifest.total,2);assert.equal(manifest.truncated,false);
  assert.deepEqual(manifest.assets.map(a=>a.id),[2,1]);assert.equal(manifest.assets[0].sha256,null);
  assert.deepEqual(validateSourceLibrary(manifest,'alpha'),manifest);
  assert.equal(JSON.stringify(manifest).includes('private'),false);assert.equal(JSON.stringify(manifest).includes('999'),false);
  assert.deepEqual(manifest.assets[0].metadata,metadata());
  assert.throws(()=>validateSourceLibrary(manifest,'beta'),e=>e.details.code==='INVALID_SOURCE_CONTEXT');
});
test('последние100 записей, явный total и детерминированный hash после пересоздания helper',t=>{
  const f=fixture(t);for(let id=1;id<=105;id++)f.add(id);
  const first=f.api.capture('alpha');assert.equal(first.total,105);assert.equal(first.assets.length,100);assert.equal(first.truncated,true);
  assert.equal(first.assets[0].id,105);assert.equal(first.assets.at(-1).id,6);
  assert.deepEqual(createSourceContext({db:f.db}).capture('alpha'),first);
  f.db.prepare('UPDATE telegram_source_items SET metadata=? WHERE id=105').run(JSON.stringify(Object.fromEntries(Object.entries(metadata()).reverse())));
  assert.equal(f.api.capture('alpha').hash,first.hash);
  f.db.prepare('UPDATE telegram_source_items SET caption=?,revision=revision+1 WHERE id=105').run('Правка');
  assert.notEqual(f.api.capture('alpha').hash,first.hash);
});
test('64КиБ считаются в UTF-8, целые подписи сохраняются, общий размер включает hash',t=>{
  const f=fixture(t),caption='🙂'.repeat(6000);for(let id=1;id<=5;id++)f.add(id,{caption});
  const manifest=f.api.capture('alpha');assert.equal(manifest.total,5);assert.equal(manifest.truncated,true);
  assert.ok(manifest.assets.length>0&&manifest.assets.length<5);assert.ok(Buffer.byteLength(JSON.stringify(manifest))<=65536);
  for(const asset of manifest.assets)assert.equal(asset.caption,caption);
  assert.deepEqual(validateSourceLibrary(manifest,'alpha'),manifest);
});
test('отсутствующая библиотека даёт валидный пустой снимок без создания таблиц',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const empty=createSourceContext({db}).capture('alpha');assert.equal(empty.total,0);assert.equal(empty.truncated,false);assert.deepEqual(empty.assets,[]);
  assert.deepEqual(validateSourceLibrary(empty,'alpha'),empty);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n,0);
});
test('CRM строго отклоняет подмену manifest, полей, порядка, версии, metadata и размера',t=>{
  const f=fixture(t);f.add(1);f.add(2);const valid=f.api.capture('alpha');
  const rejected=patch=>{const value=structuredClone(valid);patch(value);assert.throws(()=>validateSourceLibrary(value,'alpha'),e=>e.status===400);};
  for(const patch of [v=>v.hash='b'.repeat(64),v=>v.schemaVersion=2,v=>v.fileUrl='/private',v=>v.truncated=true,
    v=>v.assets[0].id=0,v=>v.assets[0].id=v.assets[1].id,v=>v.assets.reverse(),v=>v.assets[0].revision=0,
    v=>v.assets[0].sha256='bad',v=>v.assets[0].url='https://example.test',v=>v.assets[0].metadata.fileId='private',
    v=>v.assets[0].metadata.platforms=['unknown'],v=>v.assets[0].metadata.eventDate='2026-02-30',
    v=>v.assets[0].caption='a'.repeat(12001),v=>v.assets=Array.from({length:101},()=>v.assets[0])])rejected(patch);
});
test('валидный hash не разрешает context свыше64КиБ или metadata вне контракта',t=>{
 const f=fixture(t);f.add(1);const first=f.api.capture('alpha');
 const large=rehash({...first,total:4,assets:Array.from({length:4},(_,i)=>({...first.assets[0],id:4-i,caption:'🙂'.repeat(6000)}))});
 assert.ok(Buffer.byteLength(JSON.stringify(large))>65536);
 assert.throws(()=>validateSourceLibrary(large,'alpha'),e=>e.details.code==='INVALID_SOURCE_CONTEXT');
 const privateField=structuredClone(first);privateField.assets[0].metadata.url='https://example.test';
 assert.throws(()=>validateSourceLibrary(rehash(privateField),'alpha'),e=>e.details.code==='INVALID_SOURCE_CONTEXT');
});

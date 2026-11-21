'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {createReelMaterials}=require('./reel-materials');
const user={userId:7,userName:'SAMPLE редактор',role:'editor'},other={...user,userId:8};
const asset=n=>'https://synapse.synapsebusiness.ru/content/publishing-assets/alpha/'+n.repeat(32)+'.mp4';
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,is_deleted INTEGER DEFAULT 0);INSERT INTO companies VALUES(1,'alpha',0),(2,'beta',0);
 CREATE TABLE tasks(id INTEGER PRIMARY KEY,created_at TEXT,updated_at TEXT,title TEXT,description TEXT,company_code TEXT,assignee_role TEXT,assignee_name TEXT,status TEXT,source TEXT,source_ref TEXT,source_author TEXT,created_by TEXT);`);
 const materials=createReelMaterials(db,{notificationsEnabled:true}),reel=materials.create('alpha',{title:'SAMPLE ролик',mediaUrl:asset('a'),durationMs:5000},user);
 const made=materials.createRequest('alpha',reel.id,{clientRequestId:'one',kind:'redo',text:'SAMPLE короче',version:1},user);
 return {db,materials,reel,edit:made.request.editId};
}
test('старый ролик: claim/done сохраняют события в своей транзакции, повтор claim не дублирует; Hugh использует тот же ключ',t=>{
 const f=fixture(t);assert.equal(f.materials.notificationFeed().events.length,0);
 f.materials.claim('alpha',f.edit);f.materials.claim('alpha',f.edit);
 let feed=f.materials.notificationFeed();assert.equal(feed.events.length,1);assert.equal(feed.events[0].authorId,'7');assert.equal(feed.events[0].kind,'in_progress');
 assert.equal(f.materials.hughLog('alpha',7).entries.filter(e=>e.key.endsWith(':in_progress')).length,1);
 f.materials.addVersion('alpha',f.reel.id,{mediaUrl:asset('b'),durationMs:4000,editId:f.edit},'SAMPLE agent');
 feed=f.materials.notificationFeed();assert.deepEqual(feed.events.map(e=>e.kind),['in_progress','done']);
 f.materials.get('alpha',f.reel.id);assert.equal(f.materials.notificationFeed().events.length,2,'refresh связанной просьбы не дублирует событие правки');
 assert.equal(f.materials.unreadNotifications('alpha',user).count,2);assert.equal(f.materials.unreadNotifications('alpha',other).count,0);
 assert.equal(f.materials.unreadNotifications('beta',user).count,0);
});
test('mark-read не съедает конкурентную версию и не читает чужие события/компании; cursor монотонный',t=>{
 const f=fixture(t);f.materials.claim('alpha',f.edit);const first=f.materials.notificationFeed().events[0];
 f.materials.addVersion('alpha',f.reel.id,{mediaUrl:asset('b'),durationMs:4000,editId:f.edit});
 assert.throws(()=>f.materials.readNotifications('alpha',f.reel.id,{throughId:first.id},other),{status:404});
 assert.throws(()=>f.materials.readNotifications('beta',f.reel.id,{throughId:first.id},user),{status:404});
 const left=f.materials.readNotifications('alpha',f.reel.id,{throughId:first.id},user);assert.equal(left.count,1);assert.equal(left.reels[0].newVersion,1);
 const last=f.materials.notificationFeed().events.at(-1);f.materials.readNotifications('alpha',f.reel.id,{throughId:last.id},user);
 assert.equal(f.materials.readNotifications('alpha',f.reel.id,{throughId:first.id},user).count,0);
});
test('явный ответ и ожидание владельца адресованы только автору; rollback статуса откатывает событие',t=>{
 const f=fixture(t),rq=f.materials.createRequest('alpha',f.reel.id,{clientRequestId:'message',kind:'message',text:'SAMPLE вопрос'},other).request;
 f.materials.replyRequest('alpha',rq.id,{status:'waiting_owner',reply:'SAMPLE нужно решение'},'SAMPLE agent');
 assert.equal(f.materials.unreadNotifications('alpha',other).count,1);assert.equal(f.materials.unreadNotifications('alpha',user).count,0);
 const count=f.materials.notificationFeed().events.length;f.db.exec('BEGIN');f.materials.claim('alpha',f.edit);f.db.exec('ROLLBACK');
 assert.equal(f.materials.notificationFeed().events.length,count);
 assert.throws(()=>f.materials.notificationFeed(-1),{status:400});assert.throws(()=>f.materials.notificationFeed(0,201),{status:400});
});
test('OFF не записывает переходы и не рассылает историю при включении; старые правки продолжают получать новые события',t=>{
 const f=fixture(t),disabled=createReelMaterials(f.db,{notificationsEnabled:false});
 disabled.claim('alpha',f.edit);assert.equal(disabled.notificationFeed().events.length,0);
 assert.equal(disabled.unreadNotifications('alpha',user).enabled,false);
 assert.ok(!disabled.hughLog('alpha',7).entries.some(e=>e.key.endsWith(':in_progress')));
 const enabled=createReelMaterials(f.db,{notificationsEnabled:true});assert.equal(enabled.notificationFeed().events.length,0);
 enabled.addVersion('alpha',f.reel.id,{mediaUrl:asset('b'),durationMs:4000,editId:f.edit});
 assert.deepEqual(enabled.notificationFeed().events.map(e=>e.kind),['done']);
});
test('архив не оставляет недоступный счётчик; восстановление возвращает прежнее непрочитанное без потери событий',t=>{
 const f=fixture(t);f.materials.claim('alpha',f.edit);
 f.materials.addVersion('alpha',f.reel.id,{mediaUrl:asset('b'),durationMs:4000,editId:f.edit});
 assert.equal(f.materials.unreadNotifications('alpha',user).count,2);
 f.materials.archive('alpha',f.reel.id,{reason:'SAMPLE архив'},user);
 assert.equal(f.materials.unreadNotifications('alpha',user).count,0);assert.equal(f.materials.notificationFeed().events.length,2);
 f.materials.restore('alpha',f.reel.id,{},user);assert.equal(f.materials.unreadNotifications('alpha',user).count,2);
});

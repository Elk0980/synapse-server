'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createCompanyInformation}=require('./company-information');
const {createAutoposting}=require('./autoposting');
const hash='a'.repeat(64),delivery=(code='qa',name='1')=>`https://example.test/content/publishing-assets/${code}/${name.repeat(32)}.mp4`;
const source=(patch={})=>({id:1,revision:1,sha256:hash,url:delivery(),...patch});
const createBody=(clientRequestId='attach-create-1',patch={})=>({clientRequestId,source:source(),newPost:{title:'Материал',text:'Описание',format:'reel',ovpRole:'reach'},...patch});
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
 INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'qa','QA','UTC','[]'),(2,'other','Other','UTC','[]');`);
 const information=createCompanyInformation(db),transport={getSettings:()=>({channels:[]}),publish:()=>{throw Error('Недопустимый внешний вызов')}};
 const api=createAutoposting(db,{information,transport}),actor={userId:7,userName:'Редактор'};
 const draft=(body={})=>api.create('qa',{title:'Прежняя карточка',text:'Прежний текст',platformIds:['telegram'],mediaUrls:['https://example.test/old.png'],scheduledAt:null,...body},7);
 return {db,api,information,transport,actor,draft};
}
const count=(db,table)=>db.prepare(`SELECT count(*) n FROM ${table}`).get().n;

test('CF18: lookup возвращает первоначальную квитанцию после ручной правки/архивации, без get/invalidate/transaction/write',t=>{
 const {db,api,information,actor,draft}=fixture(t),body=createBody('lookup-original-1'),first=api.attachSource('qa',body,actor);
 const edited=api.update(first.post.id,'qa',{revision:first.post.revision,title:'После ручной правки',text:'Другой текст'},actor);
 api.archive(first.post.id,'qa',{revision:edited.revision},actor);
 const unrelated=draft();db.prepare("UPDATE autoposting_posts SET status='scheduled',profile_revision=-1 WHERE id=?").run(unrelated.id);
 const beforePosts=db.prepare('SELECT * FROM autoposting_posts ORDER BY id').all(),beforeLinks=db.prepare('SELECT * FROM autoposting_source_links ORDER BY id').all();
 db.exec('PRAGMA query_only=ON');const beforeChanges=db.prepare('SELECT total_changes() n').get().n;
 information.get=()=>{throw Error('lookup не должен вызывать get/invalidate');};
 db.exec=()=>{throw Error('lookup не должен начинать транзакцию');};
 const receipt=api.lookupSourceAttachment('QA',body);
 assert.deepEqual(receipt,{...first,duplicate:true});assert.equal(receipt.post.archive.archivedAt,null);
 assert.equal(api.lookupSourceAttachment('qa',{...body,clientRequestId:'lookup-missing-1'}),null);
 assert.equal(db.prepare('SELECT total_changes() n').get().n,beforeChanges);assert.equal(db.isTransaction,false);
 assert.deepEqual(db.prepare('SELECT * FROM autoposting_posts ORDER BY id').all(),beforePosts);
 assert.deepEqual(db.prepare('SELECT * FROM autoposting_source_links ORDER BY id').all(),beforeLinks);
});

test('CF18: lookup использует прежний canonical payload, повтор не доверяет свежему revision или изменённой цели',t=>{
 const {db,api,actor}=fixture(t),body=createBody('lookup-canonical-1'),first=api.attachSource('qa',body,actor);
 const normalized={newPost:{ovpRole:'reach',format:'reel',text:' Описание ',title:' Материал '},
   source:{url:delivery().replace('example.test','EXAMPLE.TEST'),sha256:hash.toUpperCase(),revision:1,id:1},clientRequestId:body.clientRequestId};
 assert.deepEqual(api.lookupSourceAttachment('qa',normalized),{...first,duplicate:true});
 for(const patch of [{source:source({revision:2})},{source:source({id:2})},{source:source({sha256:'b'.repeat(64)})},
   {source:source({url:delivery('qa','2')})},{newPost:{title:'Иная цель'}},{newPost:{title:'Материал',text:'Другой текст',format:'reel',ovpRole:'reach'}}])
   assert.throws(()=>api.lookupSourceAttachment('qa',{...body,...patch}),e=>e.status===409&&e.details.code==='REQUEST_CONFLICT');
 assert.throws(()=>api.lookupSourceAttachment('qa',{clientRequestId:body.clientRequestId,source:source(),postId:first.post.id,revision:first.post.revision}),e=>e.status===409&&e.details.code==='REQUEST_CONFLICT');
 assert.equal(count(db,'autoposting_posts'),1);assert.equal(count(db,'autoposting_source_links'),1);
});

test('CF18: lookup company/key изоляция, строгий body и отсутствующая квитанция не создают прикрепление',t=>{
 const {db,api,actor}=fixture(t),body=createBody('lookup-company-1'),first=api.attachSource('qa',body,actor);
 const otherBody={...body,source:source({url:delivery('other')})};assert.equal(api.lookupSourceAttachment('other',otherBody),null);
 const other=api.attachSource('other',otherBody,actor);assert.deepEqual(api.lookupSourceAttachment('other',otherBody),{...other,duplicate:true});
 assert.notEqual(other.post.id,first.post.id);assert.deepEqual(api.lookupSourceAttachment('qa',body),{...first,duplicate:true});
 const before=db.prepare('SELECT total_changes() n').get().n;
 for(const malformed of [null,[],{},createBody('x'),{...body,actor:{role:'owner'}},{...body,source:{...source(),companyCode:'other'}},
   {...body,source:source({id:0})},{...body,source:source({revision:0})},{...body,source:source({sha256:'invalid'})},
   {...body,source:source({url:delivery('other')})},{...body,postId:1,revision:1},{...body,newPost:{scheduledAt:'2026-11-01T00:00:00Z'}}])
   assert.throws(()=>api.lookupSourceAttachment('qa',malformed),e=>e.status===400);
 assert.throws(()=>api.lookupSourceAttachment('missing',body),e=>e.status===404);
 assert.equal(api.lookupSourceAttachment('qa',createBody('lookup-no-receipt')),null);
 assert.equal(db.prepare('SELECT total_changes() n').get().n,before);assert.equal(count(db,'autoposting_posts'),2);assert.equal(count(db,'autoposting_source_links'),2);
});

test('CF10: новый черновик и связь создаются вместе, без расписания/согласования/вызова транспорта',t=>{
 const {db,api,actor}=fixture(t),result=api.attachSource('qa',createBody(),actor);
 assert.equal(result.duplicate,false);assert.equal(result.companyCode,'qa');assert.equal(result.post.status,'draft');
 assert.equal(result.post.scheduledAt,null);assert.equal(result.post.approval.approved,false);assert.deepEqual(result.post.mediaUrls,[delivery()]);
 assert.equal(result.post.meta.format,'reel');assert.equal(result.post.meta.role,'reach');assert.equal(result.post.text,'Описание');
 assert.equal(result.link.sourceId,1);assert.equal(result.link.sourceRevision,1);assert.equal(result.link.sha256,hash);
 assert.equal(result.link.postId,result.post.id);assert.equal(result.link.contentRevision,result.post.contentRevision);
 assert.equal(count(db,'autoposting_posts'),1);assert.equal(count(db,'autoposting_source_links'),1);assert.equal(count(db,'autoposting_deliveries'),0);
 const usage=api.sourceUsage('qa',1).usages[0];assert.equal(usage.current,true);assert.equal(usage.post.archivedAt,null);
});

test('CF10: прикрепление дополняет медиа своей карточки и снимает прежнее согласование',t=>{
 const {api,actor,draft}=fixture(t);let post=draft();post=api.approve(post.id,'qa',{revision:post.revision,approved:true},actor);
 assert.equal(post.approval.approved,true);
 const other=draft({title:'Не менять'}),result=api.attachSource('qa',{clientRequestId:'attach-existing-1',source:source(),postId:post.id,revision:post.revision},actor);
 assert.deepEqual(result.post.mediaUrls,['https://example.test/old.png',delivery()]);assert.equal(result.post.text,'Прежний текст');
 assert.equal(result.post.approval.approved,false);assert.equal(result.post.contentRevision,post.contentRevision+1);
 assert.equal(result.post.revision,post.revision+1);assert.ok(result.post.platformApprovals.every(p=>!p.approved));
 assert.equal(result.post.mediaSha256,'');assert.ok(result.post.history.some(h=>h.action==='edited'));
 assert.deepEqual(api.get(other.id,'qa').mediaUrls,other.mediaUrls);assert.equal(api.get(other.id,'qa').revision,other.revision);
});

test('CF10: связь и квитанция откатываются вместе с новой или изменённой карточкой',t=>{
 const {db,api,actor,draft}=fixture(t);let post=draft();post=api.approve(post.id,'qa',{revision:post.revision,approved:true},actor);
 const before=JSON.parse(JSON.stringify(api.get(post.id,'qa'))),reviews=count(db,'autoposting_reviews');
 db.exec("CREATE TRIGGER fail_source_link BEFORE INSERT ON autoposting_source_links BEGIN SELECT RAISE(ABORT,'link write refused'); END;");
 assert.throws(()=>api.attachSource('qa',{clientRequestId:'rollback-edit-1',source:source(),postId:post.id,revision:post.revision},actor),/link write refused/);
 assert.deepEqual(JSON.parse(JSON.stringify(api.get(post.id,'qa'))),before);assert.equal(count(db,'autoposting_reviews'),reviews);
 assert.throws(()=>api.attachSource('qa',createBody('rollback-create-1'),actor),/link write refused/);
 assert.equal(count(db,'autoposting_posts'),1);assert.equal(count(db,'autoposting_source_links'),0);
});

test('CF10: потерянный результат повторяется из сохранённого commit после ручной правки и пересоздания API',t=>{
 const {db,api,information,transport,actor}=fixture(t),body=createBody(),first=api.attachSource('qa',body,actor);
 const changed=api.update(first.post.id,'qa',{revision:first.post.revision,title:'Ручная версия',text:'Новый текст',mediaUrls:['https://example.test/replaced.png']},actor);
 const recreated=createAutoposting(db,{information,transport}),again=recreated.attachSource('QA',body,{userId:8,userName:'Другой редактор'});
 assert.equal(again.duplicate,true);assert.deepEqual(again.post,first.post);assert.deepEqual(again.link,first.link);
 assert.equal(count(db,'autoposting_posts'),1);assert.equal(count(db,'autoposting_source_links'),1);
 assert.equal(api.get(first.post.id,'qa').title,changed.title);
 const use=recreated.sourceUsage('qa',1).usages[0];assert.equal(use.current,false);assert.equal(use.contentRevision,first.post.contentRevision);
 assert.equal(use.post.contentRevision,changed.contentRevision);assert.equal(use.post.title,'Ручная версия');
 for(const patch of [{source:source({revision:2})},{source:source({id:2})},{source:source({sha256:'b'.repeat(64)})},
   {source:source({url:delivery('qa','2')})},{newPost:{title:'Другая цель'}}])
   assert.throws(()=>recreated.attachSource('qa',{...body,...patch},actor),e=>e.status===409&&e.details.code==='REQUEST_CONFLICT');
});

test('CF10: запрос существующей карточки идемпотентен после изменения revision и архивации',t=>{
 const {api,actor,draft}=fixture(t),p=draft(),body={clientRequestId:'replay-existing-1',source:source(),postId:p.id,revision:p.revision};
 const first=api.attachSource('qa',body,actor),archived=api.archive(p.id,'qa',{revision:first.post.revision},actor);
 const again=api.attachSource('qa',body,actor);assert.equal(again.duplicate,true);assert.deepEqual(again.post,first.post);
 assert.equal(api.sourceUsage('qa',1).usages[0].post.archivedAt,archived.archive.archivedAt);
 assert.equal(api.sourceUsage('qa',1).usages[0].current,true);
 assert.throws(()=>api.attachSource('qa',{...body,revision:first.post.revision},actor),e=>e.details.code==='REQUEST_CONFLICT');
});

test('CF10: company/revision/archive и guards неопределённой или начавшейся отправки сохраняются',t=>{
 const {db,api,actor,draft}=fixture(t),p=draft();let n=0;
 const attach=(code='qa',patch={})=>api.attachSource(code,{clientRequestId:`guard-request-${++n}`,source:source({url:delivery(code)}),postId:p.id,revision:p.revision,...patch},actor);
 assert.throws(()=>attach('other'),e=>e.status===404);assert.throws(()=>attach('qa',{revision:p.revision+1}),e=>e.details.code==='REVISION_CONFLICT');
 for(const status of ['publishing','published']){db.prepare('UPDATE autoposting_posts SET status=? WHERE id=?').run(status,p.id);assert.throws(()=>attach(),e=>e.details.code==='POST_STATE');}
 db.prepare("UPDATE autoposting_posts SET status='draft' WHERE id=?").run(p.id);
 db.prepare("INSERT INTO autoposting_deliveries(post_id,channel_id,channel_revision,status) VALUES(?,'telegram',1,'needs_review')").run(p.id);
 assert.throws(()=>attach(),e=>e.details.code==='PUBLICATION_REVIEW_REQUIRED');
 db.prepare('DELETE FROM autoposting_deliveries WHERE post_id=?').run(p.id);
 const archived=api.archive(p.id,'qa',{revision:p.revision},actor);
 assert.throws(()=>attach('qa',{revision:archived.revision}),e=>e.details.code==='POST_ARCHIVED');assert.equal(count(db,'autoposting_source_links'),0);
});

test('CF10: usage и request keys изолированы по компании, историческое использование сохраняется',t=>{
 const {api,actor}=fixture(t),a=api.attachSource('qa',createBody(),actor);
 const b=api.attachSource('other',createBody('attach-create-1',{source:source({url:delivery('other')})}),actor);
 assert.notEqual(a.post.id,b.post.id);assert.equal(api.sourceUsage('qa',1).usages.length,1);assert.equal(api.sourceUsage('other',1).usages.length,1);
 assert.equal(api.sourceUsage('other',1).usages[0].post.id,b.post.id);
 const second=api.attachSource('qa',createBody('attach-second-1',{source:source({url:delivery('qa','2')})}),actor);
 assert.equal(api.sourceUsage('qa',1).usages.length,2);assert.equal(api.sourceUsage('qa',1).usages[0].post.id,second.post.id);
 assert.deepEqual(api.sourceUsage('qa',999).usages,[]);
});

test('CF10: неверный provenance, цель и URL отклоняются без записи',t=>{
 const {db,api}=fixture(t),bad=[
  {source:source({id:0})},{source:source({id:'1'})},{source:source({id:Number.MAX_SAFE_INTEGER+1})},
  {source:source({revision:0})},{source:source({sha256:''})},{source:source({sha256:'x'.repeat(64)})},
  {source:source({url:delivery('other')})},{source:source({url:delivery().replace('https:','http:')})},
  {source:source({url:delivery().replace('example.test','localhost')})},{source:source({url:delivery()+'?token=x'})},
  {source:source({url:delivery()+'#secret'})},{source:source({url:'https://example.test/private.mp4'})},
  {source:{...source(),companyCode:'other'}},{postId:1,revision:1},{newPost:{format:'unknown'}},{newPost:{ovpRole:'unknown'}},
  {newPost:{scheduledAt:'2026-11-01T00:00:00Z'}},{revision:1}
 ];
 for(const patch of bad)assert.throws(()=>api.attachSource('qa',{...createBody(),...patch}),e=>e.status===400);
 assert.throws(()=>api.attachSource('qa',{clientRequestId:'missing-target',source:source()}),e=>e.status===400);
 assert.throws(()=>api.attachSource('qa',createBody('x')),e=>e.status===400);
 assert.throws(()=>api.sourceUsage('qa','1'),e=>e.status===400);assert.throws(()=>api.sourceUsage('qa',0),e=>e.status===400);
 assert.equal(count(db,'autoposting_posts'),0);assert.equal(count(db,'autoposting_source_links'),0);
});

test('CF10: предел10 материалов атомарен; уже включённая ссылка не добавляется дважды',t=>{
 const {db,api,draft}=fixture(t),urls=Array.from({length:10},(_,i)=>`https://example.test/${i}.png`),p=draft({mediaUrls:urls});
 assert.throws(()=>api.attachSource('qa',{clientRequestId:'limit-request-1',source:source(),postId:p.id,revision:p.revision}),e=>e.status===400);
 assert.equal(api.get(p.id,'qa').revision,p.revision);assert.deepEqual(api.get(p.id,'qa').mediaUrls,urls);assert.equal(count(db,'autoposting_source_links'),0);
 const a=api.attachSource('qa',createBody()),b=api.attachSource('qa',{clientRequestId:'already-present-1',source:source(),postId:a.post.id,revision:a.post.revision});
 assert.deepEqual(b.post.mediaUrls,[delivery()]);assert.equal(b.post.contentRevision,a.post.contentRevision);
});

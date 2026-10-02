'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createSocialStats}=require('./social-stats');
const {createCompanyInformation}=require('./company-information');
const {createAutoposting}=require('./autoposting');
function fixture(t,{metaColumn=true,posting=true,postRevisionColumn=true,receiptRevisionColumn=true}={}){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,timezone TEXT,is_deleted INTEGER DEFAULT 0);
 INSERT INTO companies VALUES(1,'alpha','A','UTC',0),(2,'beta','B','UTC',0);
 CREATE TABLE leads(id INTEGER PRIMARY KEY,company_code TEXT,created_at TEXT,stage TEXT,sale_amount REAL,source TEXT,utm_source TEXT,utm_content TEXT,utm_campaign TEXT,referrer TEXT,landing_page TEXT);`);
 if(posting)db.exec(`CREATE TABLE autoposting_posts(id INTEGER PRIMARY KEY,company_id INTEGER,external_id TEXT${metaColumn?',meta TEXT':''}${postRevisionColumn?',content_revision INTEGER':''});
 CREATE TABLE autoposting_publication_receipts(id INTEGER PRIMARY KEY,company_id INTEGER,post_id INTEGER,platform TEXT,url TEXT,published_at TEXT${receiptRevisionColumn?',content_revision INTEGER':''});`);
 const stats=createSocialStats(db,{adapters:{},logger:{warn(){}}});
 const card=(id,owner,meta={},revision=1)=>{
  const values=[id,owner,`D${id}`,...(metaColumn?[typeof meta==='string'?meta:JSON.stringify(meta)]:[]),...(postRevisionColumn?[revision]:[])];
  return db.prepare(`INSERT INTO autoposting_posts VALUES(${values.map(()=>'?').join(',')})`).run(...values);
 };
 const receipt=(id,owner,postId,url=`https://t.me/demo_channel/${id}`,revision=1)=>{
  const values=[id,owner,postId,'telegram',url,'2026-10-01T12:00:00Z',...(receiptRevisionColumn?[revision]:[])];
  return db.prepare(`INSERT INTO autoposting_publication_receipts VALUES(${values.map(()=>'?').join(',')})`).run(...values);
 };
 const read=()=>stats.attribution('alpha','2026-10-01','2026-10-01').posts;
 return {db,stats,card,receipt,read};
}

test('CF27: после receipt правка post/reach на reel/sale не меняет метки прежней публикации',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
 INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'alpha','A','UTC','[]');
 CREATE TABLE leads(id INTEGER PRIMARY KEY,company_code TEXT,created_at TEXT,stage TEXT,sale_amount REAL,source TEXT,utm_source TEXT,utm_content TEXT,utm_campaign TEXT,referrer TEXT,landing_page TEXT);`);
 const now=()=>Date.parse('2026-10-02T00:00:00Z'),information=createCompanyInformation(db,{now});
 const transport={getSettings:()=>({channels:[]}),publish:async()=>{assert.fail('публикация в этой проверке запрещена');}};
 const posting=createAutoposting(db,{information,transport,now,logger:{warn(){}}});
 const stats=createSocialStats(db,{now,adapters:{},logger:{warn(){}}});
 const original=posting.create('alpha',{title:'Материал',text:'Текст',mediaUrls:[],platformIds:['telegram'],
  timezone:'UTC',profileRevision:information.get('alpha').revision,format:'post',role:'reach'},7);
 const marked=posting.recordReceipt(original.id,'alpha',{platform:'telegram',url:'https://t.me/demo_channel/1',
  publishedAt:'2026-10-01T12:00:00Z',contentRevision:original.contentRevision},{userId:7,userName:'Владелец'}).post;
 const read=()=>stats.attribution('alpha','2026-10-01','2026-10-01').posts;
 assert.deepEqual(read().map(p=>[p.autopostingId,p.format,p.ovpRole]),[[original.id,'post','reach']]);
 const edited=posting.update(marked.id,'alpha',{revision:marked.revision,format:'reel',role:'sale'});
 assert.equal(edited.contentRevision,original.contentRevision+1);
 assert.equal(edited.externalReceipts[0].contentRevision,original.contentRevision);
 assert.equal(edited.externalReceipts[0].stale,true);
 const changes=db.prepare('SELECT total_changes() n').get().n;
 assert.deepEqual(read().map(p=>[p.autopostingId,p.format,p.ovpRole]),[[original.id,null,null]],'текущие метки не доказаны для прежнего выхода');
 assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
});
test('метки доказанной карточки, whitelist и readonly; приватные meta не выходят',t=>{
 const f=fixture(t);f.card(1,1,{format:'reel',role:'sale',publisherName:'private',hook:'private'});f.receipt(1,1,1);
 const changes=f.db.prepare('SELECT total_changes() n').get().n;
 const [post]=f.read();assert.deepEqual([post.autopostingId,post.format,post.ovpRole],[1,'reel','sale']);
 assert.equal(Object.hasOwn(post,'meta'),false);assert.equal(JSON.stringify(post).includes('private'),false);
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
});
test('неизвестная/повреждённая метка остаётся null, известные поля читаются независимо',t=>{
 const f=fixture(t);f.card(1,1,{format:'video',role:'reach'});f.card(2,1,'{bad');f.card(3,1,{format:'story',role:'sell'});
 for(let i=1;i<=3;i++)f.receipt(i,1,i);
 const posts=new Map(f.read().map(p=>[p.autopostingId,p]));
 assert.deepEqual([posts.get(1).format,posts.get(1).ovpRole],[null,'reach']);
 assert.deepEqual([posts.get(2).format,posts.get(2).ovpRole],[null,null]);
 assert.deepEqual([posts.get(3).format,posts.get(3).ovpRole],['story',null]);
});
test('чужая компания, подделанный owner receipt и спор одного адреса не раскрывают метки',t=>{
 const f=fixture(t);f.card(1,1,{format:'reel',role:'sale'});f.card(2,1,{format:'post',role:'reach'});f.card(3,2,{format:'carousel',role:'affection'});
 f.receipt(1,1,1,'https://t.me/demo_channel/10');f.receipt(2,1,2,'https://t.me/demo_channel/10');f.receipt(3,1,3);f.receipt(4,2,3);
 const posts=f.read();assert.equal(posts.length,1);assert.deepEqual([posts[0].autopostingId,posts[0].format,posts[0].ovpRole],[null,null,null]);
});
test('номер или текст social_posts без receipt не доказывает метки, старые базы совместимы',t=>{
 const f=fixture(t,{posting:false});f.stats.writePosts('alpha','telegram',[{platformPostId:'1',url:'https://t.me/demo_channel/1',contentId:'D1',publishedAt:'2026-10-01T12:00:00Z',metrics:[]}],{provider:'manual'});
 assert.deepEqual(f.read().map(p=>[p.autopostingId,p.format,p.ovpRole]),[[null,null,null]]);
 const old=fixture(t,{metaColumn:false});old.card(1,1);old.receipt(1,1,1);
 assert.deepEqual(old.read().map(p=>[p.autopostingId,p.format,p.ovpRole]),[[1,null,null]]);
});
test('усечённые receipts не позволяют назначить метки, даже если все карточки известны',t=>{
 const f=fixture(t);for(let i=1;i<=201;i++){f.card(i,1,{format:'reel',role:'sale'});f.receipt(i,1,i);}
 const posts=f.read();assert.equal(posts.length,200);assert.ok(posts.every(p=>p.autopostingId===null&&p.format===null&&p.ovpRole===null));
});

test('CF27: одинаковая опубликованная версия подтверждается дублями, смешанная или неизвестная — нет',t=>{
 for(const revisions of [[2,2],[1,2],[2,null],[null,null],[0,0],[-1,-1],['unknown','unknown'],[2,9007199254740992],[2,1.5]]){
  const f=fixture(t);f.card(1,1,{format:'carousel',role:'affection'},2);
  revisions.forEach((revision,index)=>f.receipt(index+1,1,1,'https://t.me/demo_channel/10',revision));
  const [post]=f.read(),expected=revisions.every(revision=>revision===2)?['carousel','affection']:[null,null];
  assert.deepEqual([post.autopostingId,post.format,post.ovpRole],[1,...expected],JSON.stringify(revisions));
  assert.equal(post.receipts.length,2);
  assert.ok(post.receipts.every(receipt=>!Object.hasOwn(receipt,'contentRevision')),'публичный DTO receipts прежний');
  assert.equal(Object.hasOwn(post,'publishedVersions'),false);
  assert.equal(Object.hasOwn(post,'contentRevision'),false);
 }
});

test('CF27: разные выходы одной карточки имеют независимые версии, включая объединение social_posts',t=>{
 const f=fixture(t);f.card(1,1,{format:'reel',role:'sale'},2);
 f.receipt(1,1,1,'https://t.me/demo_channel/10',1);f.receipt(2,1,1,'https://t.me/demo_channel/20',2);
 f.stats.writePosts('alpha','telegram',[{platformPostId:'native-20',url:'https://t.me/demo_channel/20',contentId:'D1',publishedAt:'2026-10-01T12:00:00Z',metrics:[]}],{provider:'manual'});
 const posts=new Map(f.read().map(post=>[post.url,post]));
 assert.deepEqual([posts.get('https://t.me/demo_channel/10').format,posts.get('https://t.me/demo_channel/10').ovpRole],[null,null]);
 const current=posts.get('https://t.me/demo_channel/20');assert.equal(current.provenance,'stored_with_receipt');
 assert.deepEqual([current.format,current.ovpRole],['reel','sale']);
});

test('CF27: неизвестная текущая версия и legacy колонки не доказывают метки и не ломают связь',t=>{
 for(const revision of [null,0,-1,'unknown',9007199254740992,1.5]){
  const f=fixture(t);f.card(1,1,{format:'reel',role:'sale'},revision);f.receipt(1,1,1,undefined,revision);
  assert.deepEqual(f.read().map(p=>[p.autopostingId,p.format,p.ovpRole]),[[1,null,null]]);
 }
 for(const options of [{postRevisionColumn:false},{receiptRevisionColumn:false},{postRevisionColumn:false,receiptRevisionColumn:false}]){
  const f=fixture(t,options);f.card(1,1,{format:'reel',role:'sale'});f.receipt(1,1,1);
  assert.deepEqual(f.read().map(p=>[p.autopostingId,p.format,p.ovpRole]),[[1,null,null]]);
 }
});

test('CF27: fake IDs, внешние метки и чужие квитанции не подменяют доказанную версию своей компании',t=>{
 const f=fixture(t);f.card(1,1,{format:'post',role:'reach'},1);f.card(2,2,{format:'reel',role:'sale'},2);
 f.receipt(1,1,1,'https://t.me/demo_channel/10',1);
 f.receipt(2,1,2,'https://t.me/demo_channel/10',2); // Подделана компания receipt, карточка чужая.
 f.receipt(3,2,2,'https://t.me/demo_channel/10',2);
 f.receipt(4,1,999,'https://t.me/demo_channel/99',1); // Несуществующая карточка.
 f.stats.writePosts('alpha','telegram',[
  {platformPostId:'1',url:'https://t.me/demo_channel/30',contentId:'D1',publishedAt:'2026-10-01T12:00:00Z',metrics:[]},
  {platformPostId:'unknown',url:'https://t.me/demo_channel/40',contentId:'external-unknown',publishedAt:'2026-10-01T12:00:00Z',metrics:[]},
  {platformPostId:'forged',url:'https://t.me/demo_channel/50',contentId:'D2',publishedAt:'2026-10-01T12:00:00Z',metrics:[]}
 ],{provider:'manual'});
 const posts=new Map(f.read().map(post=>[post.url,post]));assert.equal(posts.size,4);
 assert.deepEqual([posts.get('https://t.me/demo_channel/10').autopostingId,posts.get('https://t.me/demo_channel/10').format,posts.get('https://t.me/demo_channel/10').ovpRole],[1,'post','reach']);
 for(const id of [30,40,50]){const post=posts.get(`https://t.me/demo_channel/${id}`);assert.deepEqual([post.autopostingId,post.format,post.ovpRole],[null,null,null]);}
 assert.equal(posts.has('https://t.me/demo_channel/99'),false);
 f.stats.writePosts('alpha','telegram',[{platformPostId:'conflict',url:'https://t.me/demo_channel/10',contentId:'external-conflict',publishedAt:'2026-10-01T12:00:00Z',metrics:[]}],{provider:'manual'});
 const conflict=f.read().find(post=>post.url==='https://t.me/demo_channel/10');
 assert.deepEqual([conflict.autopostingId,conflict.format,conflict.ovpRole],[null,null,null]);
});

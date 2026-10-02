'use strict';
// Корзина материалов автопостинга: обратимое удаление карточки из обычного ЛК,
// без публикации, без потери данных и без выхода удалённой карточки на площадку.
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createCompanyInformation}=require('./company-information');
const {createAutoposting}=require('./autoposting');

function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'palitra-love','Palitra','Europe/Moscow','[]'),(2,'alvi','ALVI','Asia/Irkutsk','[]');`);
  let time=Date.parse('2026-10-02T00:00:00Z');
  const calls=[],channels=[{id:'telegram',enabled:true,connected:true,revision:1}];
  const information=createCompanyInformation(db,{now:()=>time});
  const transport={getSettings:()=>({channels:structuredClone(channels)}),publish:async input=>{calls.push(input);return {externalId:'qa-1',url:'https://example.test/post'};}};
  const api=createAutoposting(db,{information,transport,now:()=>time,logger:{warn(){}}});
  const actor={userId:7,userName:'Влад'};
  // Карточка как цветочные пробные: черновик без даты, с видео, отклонённая владельцем.
  const flower=(title,code='palitra-love')=>{
    const p=api.create(code,{title,text:'Букеты и цветы',mediaUrls:['https://example.test/44becc3b5271a3fd4fdf915aaf530ad2.mp4'],platformIds:['telegram'],
      scheduledAt:null,timezone:'Europe/Moscow',profileRevision:information.get(code).revision},7);
    return code==='palitra-love'?api.reject(p.id,code,{revision:p.revision,comment:'Только шары'},actor):p;
  };
  const row=id=>db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(id);
  const rows=()=>db.prepare('SELECT * FROM autoposting_posts ORDER BY id').all();
  return {db,api,information,calls,channels,actor,flower,row,rows,advance:ms=>time+=ms,now:()=>time};
}
const keep=(row)=>{const {deleted_at,deleted_by,deleted_by_name,deleted_comment,revision,updated_at,...rest}=row;return rest;};

test('удаление в корзину убирает именно эти карточки из списка, календаря, напоминаний и карточки; данные не стираются',async t=>{
  const f=fixture(t);
  const targets=[f.flower('Пробный · День1'),f.flower('Пробный · День2'),f.flower('Пробный · День3')];
  const kept=f.api.create('palitra-love',{title:'Шары · материал',text:'Шары',mediaUrls:[],platformIds:['telegram'],scheduledAt:null,timezone:'Europe/Moscow',profileRevision:f.information.get('palitra-love').revision},7);
  const keptBefore=f.row(kept.id),targetsBefore=targets.map(p=>f.row(p.id));
  const reviewsBefore=f.db.prepare('SELECT * FROM autoposting_reviews ORDER BY id').all();
  const platformReviewsBefore=f.db.prepare('SELECT * FROM autoposting_platform_reviews ORDER BY post_id,platform_id').all();
  for(const p of targets){
    const result=f.api.remove(p.id,'palitra-love',{revision:p.revision,comment:'Удалено по поручению: цветы'},f.actor);
    assert.equal(result.revision,p.revision+1);assert.equal(result.deleted.byName,'Влад');assert.match(result.deleted.comment,/цветы/);
    assert.equal(result.trashHistory[0].action,'deleted');
  }
  assert.deepEqual(f.api.list('palitra-love').posts.map(p=>p.id),[kept.id],'в обычном списке осталась только чужая карточка');
  for(const p of targets)assert.throws(()=>f.api.get(p.id,'palitra-love'),e=>e.status===404);
  const calendar=await f.api.calendar('palitra-love',{from:'2026-10-01',to:'2026-10-07'});
  assert.deepEqual(calendar.undated.map(p=>p.id),[kept.id]);assert.equal(calendar.undatedTotal,1);assert.deepEqual(calendar.posts,[]);
  // Пробные карточки остаются нетронутыми по содержанию: медиа, текст, отклонение, статус, порядок.
  targets.forEach((p,index)=>{const after=f.row(p.id);assert.deepEqual(keep(after),keep(targetsBefore[index]));assert.ok(after.deleted_at);});
  assert.deepEqual(f.row(kept.id),keptBefore,'соседняя карточка не изменилась даже по времени');
  assert.deepEqual(f.db.prepare('SELECT * FROM autoposting_reviews ORDER BY id').all(),reviewsBefore,'история согласования не тронута');
  assert.deepEqual(f.db.prepare('SELECT * FROM autoposting_platform_reviews ORDER BY post_id,platform_id').all(),platformReviewsBefore);
  const trash=f.api.trash('palitra-love');
  assert.deepEqual(trash.posts.map(p=>p.id).sort((a,b)=>a-b),targets.map(p=>p.id));
  assert.ok(trash.posts.every(p=>p.review.state==='rejected'&&p.mediaUrls[0].endsWith('44becc3b5271a3fd4fdf915aaf530ad2.mp4')));
  assert.equal(f.calls.length,0,'ничего не отправлено');
});

test('восстановление возвращает карточку в прежнем виде; повтор и чужая компания не проходят',t=>{
  const f=fixture(t),p=f.flower('Пробный · День1'),before=f.row(p.id);
  const removed=f.api.remove(p.id,'palitra-love',{revision:p.revision},f.actor);
  assert.throws(()=>f.api.restore(p.id,'alvi',{revision:removed.revision},f.actor),e=>e.status===404);
  assert.throws(()=>f.api.restore(p.id,'palitra-love',{revision:p.revision},f.actor),e=>e.details?.code==='REVISION_CONFLICT');
  const restored=f.api.restore(p.id,'palitra-love',{revision:removed.revision},f.actor);
  assert.equal(restored.deleted,null);assert.equal(restored.revision,removed.revision+1);
  const after=f.row(p.id);
  assert.deepEqual(keep(after),keep(before));assert.equal(after.deleted_at,null);assert.equal(after.deleted_comment,'');
  assert.equal(restored.status,'draft');assert.equal(restored.review.state,'rejected');assert.equal(restored.approval.approved,false);
  assert.deepEqual(f.api.list('palitra-love').posts.map(item=>item.id),[p.id]);assert.deepEqual(f.api.trash('palitra-love').posts,[]);
  assert.throws(()=>f.api.restore(p.id,'palitra-love',{revision:restored.revision},f.actor),e=>e.status===404,'не в корзине');
  assert.deepEqual(f.db.prepare('SELECT action,revision,actor_name FROM autoposting_post_trash_events WHERE post_id=? ORDER BY id').all(p.id).map(e=>({...e})),
    [{action:'deleted',revision:removed.revision,actor_name:'Влад'},{action:'restored',revision:restored.revision,actor_name:'Влад'}]);
});

test('изоляция компаний: чужой код не видит, не удаляет и не восстанавливает карточку',t=>{
  const f=fixture(t),own=f.flower('Пробный · День1'),other=f.flower('ALVI материал','alvi');
  const before=f.rows();
  assert.throws(()=>f.api.remove(own.id,'alvi',{revision:own.revision},f.actor),e=>e.status===404);
  assert.throws(()=>f.api.remove(other.id,'palitra-love',{revision:other.revision},f.actor),e=>e.status===404);
  assert.deepEqual(f.rows(),before);
  f.api.remove(own.id,'palitra-love',{revision:own.revision},f.actor);
  assert.deepEqual(f.api.trash('alvi').posts,[]);
  assert.deepEqual(f.api.list('alvi').posts.map(p=>p.id),[other.id]);
  assert.deepEqual(f.row(other.id),before.find(r=>r.id===other.id));
});

test('удалить нельзя то, что стоит в плане, уходит или уже ушло на площадку, и связанное с другими модулями',async t=>{
  const f=fixture(t);
  const scheduled=f.api.create('alvi',{title:'В плане',text:'Текст',mediaUrls:[],platformIds:['telegram'],scheduledAt:new Date(f.now()+60000).toISOString(),timezone:'UTC',profileRevision:f.information.get('alvi').revision},7);
  const queued=await f.api.schedule(scheduled.id,'alvi',{revision:scheduled.revision});
  assert.throws(()=>f.api.remove(queued.id,'alvi',{revision:queued.revision},f.actor),e=>e.details?.code==='POST_STATE');
  for(const status of ['publishing','published']){
    const p=f.flower('Статус '+status);f.db.prepare('UPDATE autoposting_posts SET status=? WHERE id=?').run(status,p.id);
    assert.throws(()=>f.api.remove(p.id,'palitra-love',{revision:p.revision},f.actor),e=>e.details?.code==='POST_STATE');
  }
  const uncertain=f.flower('Неясная отправка');
  f.db.prepare("INSERT INTO autoposting_deliveries(post_id,channel_id,channel_revision,status) VALUES(?,?,1,'needs_review')").run(uncertain.id,'telegram');
  assert.throws(()=>f.api.remove(uncertain.id,'palitra-love',{revision:uncertain.revision},f.actor),e=>e.details?.code==='PUBLICATION_EXISTS');
  const accepted=f.flower('Принято сервисом');
  f.db.prepare("INSERT INTO autoposting_deliveries(post_id,channel_id,channel_revision,status,provider_post_id) VALUES(?,?,1,'failed','job-1')").run(accepted.id,'telegram');
  assert.throws(()=>f.api.remove(accepted.id,'palitra-love',{revision:accepted.revision},f.actor),e=>e.details?.code==='PUBLICATION_EXISTS');
  const outside=f.flower('Опубликовано вне ЛК');
  f.db.prepare("INSERT INTO autoposting_publication_receipts(company_id,post_id,platform,url,published_at,content_revision,recorded_at) VALUES(1,?,'telegram','https://t.me/c/1/2','2026-10-01T00:00:00Z',1,'2026-10-01T00:00:00Z')").run(outside.id);
  assert.throws(()=>f.api.remove(outside.id,'palitra-love',{revision:outside.revision},f.actor),e=>e.details?.code==='PUBLICATION_RECORDED');
  const source=f.flower('Исходник'),child=f.flower('Продолжение');
  f.db.prepare("INSERT INTO autoposting_split_links(source_post_id,platform_id,child_post_id,company_id,source_content_revision,created_at) VALUES(?,'telegram',?,1,1,'2026-10-01')").run(source.id,child.id);
  for(const p of [source,child])assert.throws(()=>f.api.remove(p.id,'palitra-love',{revision:p.revision},f.actor),e=>e.details?.code==='POST_LINKED');
  const planned=f.flower('Из плана');
  f.db.exec('CREATE TABLE media_mentor_plan_transfer_items(post_id INTEGER UNIQUE)');f.db.prepare('INSERT INTO media_mentor_plan_transfer_items VALUES(?)').run(planned.id);
  assert.throws(()=>f.api.remove(planned.id,'palitra-love',{revision:planned.revision},f.actor),e=>e.details?.code==='POST_LINKED');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM autoposting_posts WHERE deleted_at IS NOT NULL').get().n,0,'ни одна запрещённая карточка не удалена');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM autoposting_post_trash_events').get().n,0);
});

test('конкуренция: устаревшая версия проигрывает, одно удаление из двух, удалённую нельзя править, согласовать или поставить в план',async t=>{
  const f=fixture(t),p=f.flower('Пробный · День1');
  const edited=f.api.update(p.id,'palitra-love',{revision:p.revision,text:'Новая версия'},f.actor);
  assert.throws(()=>f.api.remove(p.id,'palitra-love',{revision:p.revision},f.actor),e=>e.details?.code==='REVISION_CONFLICT','правка победила устаревшее удаление');
  assert.equal(f.row(p.id).deleted_at,null);
  const first=f.api.remove(p.id,'palitra-love',{revision:edited.revision},f.actor);
  assert.throws(()=>f.api.remove(p.id,'palitra-love',{revision:edited.revision},f.actor),e=>e.status===404,'второе удаление той же версии не проходит');
  const snapshot=f.row(p.id);
  assert.throws(()=>f.api.update(p.id,'palitra-love',{revision:first.revision,text:'x'},f.actor),e=>e.status===404);
  assert.throws(()=>f.api.approve(p.id,'palitra-love',{revision:first.revision,approved:true},f.actor),e=>e.status===404);
  assert.throws(()=>f.api.reject(p.id,'palitra-love',{revision:first.revision,comment:'x'},f.actor),e=>e.status===404);
  assert.throws(()=>f.api.submitReview(p.id,'palitra-love',{revision:first.revision},f.actor),e=>e.status===404);
  assert.throws(()=>f.api.split(p.id,'palitra-love',{revision:first.revision,platformIds:['telegram']},f.actor),e=>e.status===404);
  assert.throws(()=>f.api.cancel(p.id,'palitra-love',{revision:first.revision}),e=>e.status===404);
  await assert.rejects(f.api.schedule(p.id,'palitra-love',{revision:first.revision}),e=>e.status===404);
  await assert.rejects(f.api.approveAndSchedule(p.id,'palitra-love',{revision:first.revision,approved:true,schedule:true},f.actor),e=>e.status===404);
  assert.deepEqual(f.row(p.id),snapshot,'ни одна попытка не изменила удалённую карточку');
  assert.throws(()=>f.api.reorder('palitra-love',{ids:[p.id]},f.actor),e=>e.status===404,'удалённую нельзя упорядочить');
});

test('фоновая отправка не трогает удалённую карточку, даже если она оказалась в статусе очереди',async t=>{
  const f=fixture(t);
  const p=f.api.create('alvi',{title:'Был в плане',text:'Текст',mediaUrls:[],platformIds:['telegram'],scheduledAt:new Date(f.now()+60000).toISOString(),timezone:'UTC',profileRevision:f.information.get('alvi').revision},7);
  const removed=f.api.remove(p.id,'alvi',{revision:p.revision},f.actor);
  // Защита в глубину: строку принудительно переводим в очередь с доставкой, как при старых данных.
  f.db.prepare("UPDATE autoposting_posts SET status='scheduled' WHERE id=?").run(p.id);
  f.db.prepare("INSERT INTO autoposting_deliveries(post_id,channel_id,channel_revision,status) VALUES(?,?,1,'pending')").run(p.id,'telegram');
  const before=f.row(p.id),deliveries=f.db.prepare('SELECT * FROM autoposting_deliveries WHERE post_id=?').all(p.id);
  f.advance(120000);await f.api.drain();await f.api.drain();
  assert.equal(f.calls.length,0,'площадка не вызвана');
  assert.deepEqual(f.row(p.id),before);assert.deepEqual(f.db.prepare('SELECT * FROM autoposting_deliveries WHERE post_id=?').all(p.id),deliveries);
  // Смена данных компании не переводит удалённую карточку в проверку.
  f.information.save('alvi',{revision:f.information.get('alvi').revision,profile:{city:'Иркутск'}},7);f.api.invalidate('alvi');
  assert.deepEqual(f.row(p.id),before);assert.equal(removed.deleted.byName,'Влад');
});

test('повтор пакета не воскрешает удалённую карточку и не создаёт её копию',t=>{
  const f=fixture(t),items=[{dayKey:'D1',title:'Пробный · День1 · Палитра',text:'Букеты',mediaUrls:[],platformIds:['telegram']}];
  const first=f.api.importPackage('palitra-love',{items},7);const card=first.created[0];
  f.api.remove(card.id,'palitra-love',{revision:card.revision},f.actor);
  const repeat=f.api.importPackage('palitra-love',{items},7);
  assert.equal(repeat.created.length,0);assert.equal(repeat.skipped[0].id,card.id);assert.equal(repeat.skipped[0].reason,'deleted');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM autoposting_posts').get().n,1);assert.deepEqual(f.api.list('palitra-love').posts,[]);
});

test('напоминание о согласовании не зовёт согласовывать удалённый материал с датой',t=>{
  const f=fixture(t);
  const dated=(title)=>f.api.create('palitra-love',{title,text:'Букеты',mediaUrls:['https://example.test/clip.mp4'],platformIds:['telegram'],
    scheduledAt:'2026-10-03T09:00:00Z',timezone:'Europe/Moscow',profileRevision:f.information.get('palitra-love').revision},7);
  const removed=dated('Пробный · с датой'),kept=dated('Шары · с датой');
  assert.deepEqual(f.api.reviewReminderSummary('palitra-love','2026-10-03').items.map(item=>item.id),[removed.id,kept.id]);
  f.api.remove(removed.id,'palitra-love',{revision:removed.revision},f.actor);
  assert.deepEqual(f.api.reviewReminderSummary('palitra-love','2026-10-03').items.map(item=>item.id),[kept.id]);
});

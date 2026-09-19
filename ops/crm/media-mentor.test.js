'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createMediaMentor,EMPTY_BRIEF}=require('./media-mentor');

const BRIEF={goal:'Записи на курс массажа из соцсетей',product:'Курс из 10 сеансов',
  audience:'Женщины 30–45 лет, Иркутск, сидячая работа',
  pains:['Боль в спине после офиса','Нет времени на длинный курс'],
  confirmedFacts:[{id:'price',statement:'Сеанс стоит 3 500 ₽',source:'Прайс владельца от 01.09.2026'}],
  assets:[{id:'cabinet',title:'Фото кабинета',kind:'photo',note:'Снято на телефон'},
    {id:'process',title:'Видео процесса',kind:'video',note:''}],
  shootingComfort:{level:'hands_only',notes:'В кадр не готова, руки и процесс — да'},
  platforms:['vk','telegram']};
const ACTOR={userId:7,userName:'Влад'};

const dayAt=(start,index,extra={})=>({
  date:new Date(Date.parse(`${start}T00:00:00Z`)+index*86400000).toISOString().slice(0,10),
  platform:index%2?'telegram':'vk',format:'post',role:'reach',topic:`Тема дня ${index+1}`,
  hook:'',assetId:index%2?'':'cabinet',mentorNote:'',...extra});
const daysFor=(count=7,start='2026-09-21')=>Array.from({length:count},(_,index)=>dayAt(start,index));

function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,timezone,socials) VALUES
      (1,'alvi','ALVI','Asia/Irkutsk','[]'),(2,'avokado','Авокадо','Asia/Irkutsk','[]');`);
  let clock=Date.parse('2026-09-19T05:00:00Z');
  const now=()=>clock,api=createMediaMentor(db,{now});
  const ready=(code='alvi',days=daysFor())=>{
    const brief=api.saveBrief(code,{revision:0,brief:BRIEF},ACTOR);
    return api.savePlan(code,{planRevision:0,briefRevision:brief.brief.revision,days},ACTOR);
  };
  return {db,api,now,ready,tick:ms=>{clock+=ms;}};
}

test('пустое состояние, сохранение брифа и версии не зависят от ответа предыдущего чтения',t=>{
  const f=fixture(t),empty=f.api.get('ALVI');
  assert.equal(empty.companyCode,'alvi');assert.equal(empty.brief.revision,0);assert.equal(empty.plan,null);
  assert.deepEqual(empty.brief.fields,EMPTY_BRIEF);assert.deepEqual(empty.brief.history,[]);
  assert.equal(empty.approval.status,'absent');assert.equal(empty.approval.requiresReapproval,false);
  assert.deepEqual(empty.capabilities,{publishing:false,modelSuggestions:false,httpApi:false,cabinetUi:false});
  assert.match(empty.notice,/Публикация не выполняется/);
  assert.ok(empty.vocabulary.platforms.some(item=>item.id==='vk'&&item.label==='ВКонтакте'));
  assert.deepEqual(empty.vocabulary.formats.map(item=>item.id),['post','story','reel','carousel']);

  const saved=f.api.saveBrief('alvi',{revision:0,brief:BRIEF,reason:'Первый разговор с владельцем'},ACTOR);
  assert.equal(saved.brief.revision,1);assert.deepEqual(saved.brief.fields,BRIEF);
  assert.equal(saved.brief.updatedAt,'2026-09-19T05:00:00.000Z');
  assert.deepEqual(saved.brief.history,[{revision:1,createdAt:'2026-09-19T05:00:00.000Z',actorId:7,actorName:'Влад',reason:'Первый разговор с владельцем'}]);

  f.tick(60000);
  const patched=f.api.saveBrief('alvi',{revision:1,brief:{goal:'Записи через личные сообщения'}},ACTOR);
  assert.equal(patched.brief.revision,2);assert.equal(patched.brief.fields.goal,'Записи через личные сообщения');
  assert.deepEqual(patched.brief.fields.pains,BRIEF.pains,'частичное сохранение не стирает остальные поля');
  assert.equal(f.api.briefVersion('alvi',1).fields.goal,BRIEF.goal,'прежняя версия читается целиком');

  patched.brief.fields.pains.push('Подмена ответа');patched.brief.fields.goal='Подмена ответа';
  assert.deepEqual(f.api.get('alvi').brief.fields.pains,BRIEF.pains);
  assert.equal(f.api.get('alvi').brief.fields.goal,'Записи через личные сообщения');
});

test('план строится по брифу, согласуется поимённо и ничего не публикует',t=>{
  const f=fixture(t);
  assert.throws(()=>f.api.savePlan('alvi',{planRevision:0,briefRevision:0,days:daysFor()}),
    e=>e.status===409&&e.details.code==='BRIEF_REQUIRED');
  const planned=f.ready();
  assert.equal(planned.plan.revision,1);assert.equal(planned.plan.briefRevision,1);
  assert.equal(planned.plan.startDate,'2026-09-21');assert.equal(planned.plan.endDate,'2026-09-27');
  assert.equal(planned.plan.windowDays,7);assert.equal(planned.plan.days.length,7);
  assert.equal(planned.approval.status,'pending');assert.equal(planned.approval.requiresReapproval,true);
  assert.equal(planned.approval.decision,null);assert.deepEqual(planned.approvals,[]);

  f.tick(3600000);
  const decided=f.api.decide('alvi',{planRevision:1,briefRevision:1,decision:'approved',comment:'Снимаем по плану'},ACTOR);
  assert.equal(decided.approval.status,'approved');assert.equal(decided.approval.requiresReapproval,false);
  assert.equal(decided.approval.planRevision,1);assert.equal(decided.approval.briefRevision,1);
  assert.equal(decided.approval.actorName,'Влад');assert.equal(decided.approval.actorId,7);
  assert.equal(decided.approval.decidedAt,'2026-09-19T06:00:00.000Z');assert.equal(decided.approval.comment,'Снимаем по плану');
  assert.equal(decided.approvals.length,1);
  assert.deepEqual(f.api.planVersion('alvi',1).decision.decision,'approved');

  // Повтор того же решения идемпотентен, обратное решение фиксируется отдельной записью.
  assert.equal(f.api.decide('alvi',{planRevision:1,briefRevision:1,decision:'approved',comment:'Снимаем по плану'},ACTOR).approvals.length,1);
  const reversed=f.api.decide('alvi',{planRevision:1,briefRevision:1,decision:'rejected',comment:'Передумали, нужен другой продукт'},{userName:'Ольга'});
  assert.equal(reversed.approval.status,'rejected');assert.equal(reversed.approval.actorName,'Ольга');
  assert.equal(reversed.approval.actorId,null);assert.equal(reversed.approvals.length,2);

  const tables=f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
  assert.deepEqual(tables,['companies','media_mentor_brief_versions','media_mentor_briefs',
    'media_mentor_plan_approvals','media_mentor_plan_versions','media_mentor_plans'],'модуль не создаёт таблиц публикации');
});

test('изменение брифа возвращает согласованный план на пересогласование',t=>{
  const f=fixture(t);f.ready();
  f.api.decide('alvi',{planRevision:1,briefRevision:1,decision:'approved',comment:''},ACTOR);
  assert.equal(f.api.get('alvi').approval.status,'approved');

  const changed=f.api.saveBrief('alvi',{revision:1,brief:{confirmedFacts:[{id:'price',statement:'Сеанс стоит 4 000 ₽',source:'Прайс от 19.09.2026'}]}},ACTOR);
  assert.equal(changed.brief.revision,2);
  assert.equal(changed.approval.status,'needs_reapproval');assert.equal(changed.approval.requiresReapproval,true);
  assert.match(changed.approval.reason,/версии 2.*версии 1|Обновите план/s);
  assert.equal(changed.plan.revision,1,'план остаётся, но перестаёт быть согласованным');

  assert.throws(()=>f.api.decide('alvi',{planRevision:1,briefRevision:2,decision:'approved',comment:''},ACTOR),
    e=>e.status===409&&e.details.code==='BRIEF_CHANGED','пересогласовать нельзя без обновления плана');
  assert.throws(()=>f.api.savePlan('alvi',{planRevision:1,briefRevision:1,days:daysFor(8)},ACTOR),
    e=>e.status===409&&e.details.code==='BRIEF_CHANGED');

  const replanned=f.api.savePlan('alvi',{planRevision:1,briefRevision:2,days:daysFor(8)},ACTOR);
  assert.equal(replanned.plan.revision,2);assert.equal(replanned.plan.briefRevision,2);
  assert.equal(replanned.approval.status,'pending');
  const approved=f.api.decide('alvi',{planRevision:2,briefRevision:2,decision:'approved',comment:''},ACTOR);
  assert.equal(approved.approval.status,'approved');assert.equal(approved.approval.planRevision,2);
  assert.equal(f.api.planVersion('alvi',1).decision.decision,'approved','старое решение остаётся в истории своей версии');
  assert.equal(f.api.get('alvi').approvals.length,2);
});

test('данные, версии и согласования одной компании недоступны другой',t=>{
  const f=fixture(t);
  f.ready('alvi');f.api.savePlan('alvi',{planRevision:1,briefRevision:1,days:daysFor(9)},ACTOR);
  f.api.decide('alvi',{planRevision:2,briefRevision:1,decision:'approved',comment:''},ACTOR);
  f.api.saveBrief('avokado',{revision:0,brief:{...BRIEF,goal:'Заявки на доставку',platforms:['telegram']}},{userName:'Мария'});
  const other=f.api.savePlan('avokado',{planRevision:0,briefRevision:1,days:daysFor(7).map(day=>({...day,platform:'telegram'}))},{userName:'Мария'});

  assert.equal(other.approval.status,'pending','согласование ALVI не переносится на Авокадо');
  assert.equal(other.plan.revision,1);assert.deepEqual(other.approvals,[]);
  assert.equal(f.api.get('alvi').brief.fields.goal,BRIEF.goal);
  assert.equal(f.api.get('avokado').brief.fields.goal,'Заявки на доставку');
  assert.equal(f.api.get('alvi').approval.status,'approved');
  assert.throws(()=>f.api.planVersion('avokado',2),e=>e.status===404&&e.details.code==='NOT_FOUND');
  assert.equal(f.api.planVersion('alvi',2).days.length,9);
  assert.throws(()=>f.api.decide('avokado',{planRevision:2,briefRevision:1,decision:'approved',comment:''},ACTOR),
    e=>e.status===409&&e.details.code==='STALE_PLAN');
  const counts=f.db.prepare('SELECT company_id id,count(*) count FROM media_mentor_plan_approvals GROUP BY company_id').all();
  assert.equal(counts.length,1);assert.equal(counts[0].id,1);assert.equal(counts[0].count,1);

  for(const code of ['missing','alvi/avokado',null,''])assert.throws(()=>f.api.get(code),e=>e.status===404||e.status===400);
  f.db.exec('UPDATE companies SET is_deleted=1 WHERE id=1');
  assert.throws(()=>f.api.get('alvi'),e=>e.status===404);
  assert.throws(()=>f.api.saveBrief('alvi',{revision:1,brief:{goal:'После удаления'}},ACTOR),e=>e.status===404);
  assert.equal(f.api.get('avokado').plan.revision,1);
});

test('устаревшая версия брифа или плана не перезаписывает чужую правку',t=>{
  const f=fixture(t);f.ready();
  assert.throws(()=>f.api.saveBrief('alvi',{revision:0,brief:{goal:'Из старой вкладки'}},ACTOR),
    e=>e.status===409&&e.details.code==='REVISION_CONFLICT');
  assert.throws(()=>f.api.savePlan('alvi',{planRevision:0,briefRevision:1,days:daysFor(8)},ACTOR),
    e=>e.status===409&&e.details.code==='REVISION_CONFLICT');
  assert.equal(f.api.get('alvi').brief.fields.goal,BRIEF.goal);
  assert.equal(f.api.get('alvi').plan.days.length,7);

  f.api.savePlan('alvi',{planRevision:1,briefRevision:1,days:daysFor(8)},ACTOR);
  assert.throws(()=>f.api.decide('alvi',{planRevision:1,briefRevision:1,decision:'approved',comment:''},ACTOR),
    e=>e.status===409&&e.details.code==='STALE_PLAN');
  assert.equal(f.api.get('alvi').approval.status,'pending');
  assert.equal(f.db.prepare('SELECT count(*) count FROM media_mentor_plan_approvals').get().count,0);
  assert.equal(f.db.prepare('SELECT count(*) count FROM media_mentor_plan_versions').get().count,2);
});

test('согласование без имени, без решения и без плана отклоняется',t=>{
  const f=fixture(t);
  assert.throws(()=>f.api.decide('alvi',{planRevision:0,briefRevision:0,decision:'approved',comment:''},ACTOR),
    e=>e.status===404&&e.details.code==='NOT_FOUND');
  f.ready();
  const valid={planRevision:1,briefRevision:1,decision:'approved',comment:''};
  for(const [body,actor] of [
    [{...valid,decision:'maybe'},ACTOR],
    [{...valid,decision:true},ACTOR],
    [{...valid,decision:'rejected'},ACTOR],
    [{...valid,decision:'rejected',comment:'   '},ACTOR],
    [{...valid,comment:'x'.repeat(2001)},ACTOR],
    [{...valid,planRevision:'1'},ACTOR],
    [{...valid,planRevision:-1},ACTOR],
    [{...valid,published:true},ACTOR],
    [valid,{}],[valid,{userName:'   '}],[valid,{userName:'Влад',role:'owner'}],
    [valid,{userId:0,userName:'Влад'}],[valid,{userId:'7',userName:'Влад'}],[valid,'Влад'],
    [null,ACTOR]]) {
    assert.throws(()=>f.api.decide('alvi',body,actor),e=>e.status===400,JSON.stringify({body,actor}));
  }
  assert.equal(f.db.prepare('SELECT count(*) count FROM media_mentor_plan_approvals').get().count,0);
  assert.equal(f.api.get('alvi').approval.status,'pending');
  assert.equal(f.api.decide('alvi',valid,{userName:'Влад'}).approval.status,'approved');
});

test('строгая проверка брифа и состава плана',t=>{
  const f=fixture(t);
  for(const brief of [{unknown:'поле'},{},{goal:42},{pains:'Боль'},{pains:['Боль','Боль']},
    {confirmedFacts:[{id:'a',statement:'Факт'}]},{confirmedFacts:[{id:'a',statement:'Факт',source:'Прайс',extra:1}]},
    {confirmedFacts:[{id:'a',statement:'Факт',source:'Прайс'},{id:'a',statement:'Другой',source:'Прайс'}]},
    {assets:[{id:'a',title:'Фото',kind:'gif',note:''}]},{assets:[{id:'a',title:'',kind:'photo',note:''}]},
    {shootingComfort:{level:'maybe',notes:''}},{shootingComfort:'on_camera'},
    {platforms:['facebook']},{platforms:['vk','vk']}]) {
    assert.throws(()=>f.api.saveBrief('alvi',{revision:0,brief},ACTOR),e=>e.status===400,JSON.stringify(brief));
  }
  assert.equal(f.api.get('alvi').brief.revision,0);

  f.api.saveBrief('alvi',{revision:0,brief:BRIEF},ACTOR);
  const base={planRevision:0,briefRevision:1};
  for(const days of [daysFor(6),daysFor(15),[],
    Array.from({length:9},(_,index)=>dayAt('2026-09-21',index%3)),
    [...daysFor(7),dayAt('2026-09-21',0),dayAt('2026-09-21',0),dayAt('2026-09-21',0)],
    daysFor(7).map(day=>({...day,platform:'instagram'})),
    daysFor(7).map(day=>({...day,format:'video'})),
    daysFor(7).map(day=>({...day,role:'unknown'})),
    daysFor(7).map(day=>({...day,assetId:'missing'})),
    daysFor(7).map(day=>({...day,topic:'  '})),
    daysFor(7).map(day=>({...day,scheduledAt:'2026-09-21T09:00:00Z'})),
    daysFor(7).reverse(),
    daysFor(7).map((day,index)=>index?day:{...day,date:'2026-02-30'}),
    daysFor(7).map((day,index)=>index?day:{...day,date:'21.09.2026'})]) {
    assert.throws(()=>f.api.savePlan('alvi',{...base,days},ACTOR),e=>e.status===400,JSON.stringify(days.slice(0,1)));
  }
  assert.equal(f.api.get('alvi').plan,null);

  // Граничные значения окна и до трёх материалов в один день принимаются.
  assert.equal(f.api.savePlan('alvi',{...base,days:daysFor(7)},ACTOR).plan.windowDays,7);
  assert.equal(f.api.savePlan('alvi',{planRevision:1,briefRevision:1,days:daysFor(14)},ACTOR).plan.windowDays,14);
  const dense=[...daysFor(7),dayAt('2026-09-21',0),dayAt('2026-09-21',0)].sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:0);
  assert.equal(f.api.savePlan('alvi',{planRevision:2,briefRevision:1,days:dense},ACTOR).plan.days.length,9);
});

test('сохранение без фактических изменений не создаёт версию и не сбрасывает согласование',t=>{
  const f=fixture(t);f.ready();
  f.api.decide('alvi',{planRevision:1,briefRevision:1,decision:'approved',comment:''},ACTOR);
  const repeatedBrief=f.api.saveBrief('alvi',{revision:1,brief:{goal:BRIEF.goal,platforms:['vk','telegram']}},ACTOR);
  assert.equal(repeatedBrief.brief.revision,1);assert.equal(repeatedBrief.approval.status,'approved');
  const repeatedPlan=f.api.savePlan('alvi',{planRevision:1,briefRevision:1,days:daysFor()},ACTOR);
  assert.equal(repeatedPlan.plan.revision,1);assert.equal(repeatedPlan.approval.status,'approved');
  assert.equal(f.db.prepare('SELECT count(*) count FROM media_mentor_brief_versions').get().count,1);
  assert.equal(f.db.prepare('SELECT count(*) count FROM media_mentor_plan_versions').get().count,1);
});

test('перезапуск сервиса восстанавливает бриф, план, согласование и историю',t=>{
  const f=fixture(t);f.ready();
  f.api.saveBrief('alvi',{revision:1,brief:{goal:'Записи на курс'},reason:'Уточнили цель'},ACTOR);
  f.api.savePlan('alvi',{planRevision:1,briefRevision:2,days:daysFor(10)},ACTOR);
  f.api.decide('alvi',{planRevision:2,briefRevision:2,decision:'approved',comment:'Готово к съёмке'},{userId:7,userName:'Влад'});
  const before=f.api.get('alvi');

  const reopened=createMediaMentor(f.db,{now:f.now}).get('alvi');
  assert.deepEqual(reopened,before);
  assert.equal(reopened.brief.revision,2);assert.equal(reopened.plan.revision,2);
  assert.equal(reopened.plan.days.length,10);assert.equal(reopened.approval.status,'approved');
  assert.equal(reopened.approval.actorName,'Влад');assert.equal(reopened.approval.comment,'Готово к съёмке');
  assert.equal(reopened.brief.history.length,2);assert.equal(reopened.plan.history.length,2);
  assert.deepEqual(reopened.brief.history.map(item=>item.revision),[2,1]);
});

test('версии и решения неизменяемы, сбой записи откатывает весь план целиком',t=>{
  const f=fixture(t);f.ready();
  f.api.decide('alvi',{planRevision:1,briefRevision:1,decision:'approved',comment:''},ACTOR);
  for(const statement of ["UPDATE media_mentor_brief_versions SET brief='{}'","DELETE FROM media_mentor_brief_versions",
    "UPDATE media_mentor_plan_versions SET plan='{}'","DELETE FROM media_mentor_plan_versions",
    "UPDATE media_mentor_plan_approvals SET decision='rejected'","DELETE FROM media_mentor_plan_approvals"]) {
    assert.throws(()=>f.db.exec(statement),/Immutable media mentor/,statement);
  }

  f.db.exec(`CREATE TRIGGER fail_second_plan BEFORE INSERT ON media_mentor_plan_versions
    WHEN NEW.revision>=2 BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END;`);
  assert.throws(()=>f.api.savePlan('alvi',{planRevision:1,briefRevision:1,days:daysFor(11)},ACTOR),/simulated disk failure/);
  const kept=f.api.get('alvi');
  assert.equal(kept.plan.revision,1);assert.equal(kept.plan.days.length,7);assert.equal(kept.approval.status,'approved');
  assert.equal(f.db.prepare('SELECT count(*) count FROM media_mentor_plan_versions').get().count,1);

  f.db.exec('DROP TRIGGER fail_second_plan');
  const retried=f.api.savePlan('alvi',{planRevision:1,briefRevision:1,days:daysFor(11)},ACTOR);
  assert.equal(retried.plan.revision,2);assert.equal(retried.plan.days.length,11);
  assert.equal(retried.approval.status,'pending','новая версия плана согласовывается заново');
});

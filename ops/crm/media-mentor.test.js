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
  // CF1: рядом с брифом живут вводные контент-завода — это не таблицы публикации.
  assert.deepEqual(tables,['companies','content_factory_month_versions','content_factory_months',
    'content_factory_profile_versions','content_factory_profiles','media_mentor_brief_versions','media_mentor_briefs',
    'media_mentor_plan_approvals','media_mentor_plan_feedback','media_mentor_plan_versions','media_mentor_plans',
    'media_mentor_variant_approvals','media_mentor_variant_revisions'],
    'модуль не создаёт таблиц публикации');
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

test('предложения к строке плана сохраняются отдельно, не меняют план и согласование',t=>{
  const f=fixture(t);f.ready();
  f.api.decide('alvi',{planRevision:1,briefRevision:1,decision:'approved',comment:''},ACTOR);
  const before=f.api.get('alvi');
  f.tick(60000);
  const saved=f.api.addFeedback('alvi',{planRevision:1,dayIndex:2,
    message:'Может, сделать это темой для продающего рилса?'},ACTOR);
  assert.deepEqual(saved.plan,before.plan);
  assert.deepEqual(saved.approval,before.approval);
  assert.deepEqual(saved.feedback,[{id:1,planRevision:1,dayIndex:2,
    message:'Может, сделать это темой для продающего рилса?',
    createdAt:'2026-09-19T05:01:00.000Z',actorId:7,actorName:'Влад'}]);
  assert.deepEqual(createMediaMentor(f.db,{now:f.now}).get('alvi').feedback,saved.feedback,
    'замечание остаётся после повторного открытия хранилища');
  assert.deepEqual(f.api.planVersion('alvi',1).feedback,saved.feedback);

  const newer=f.api.savePlan('alvi',{planRevision:1,briefRevision:1,days:daysFor(8)},ACTOR);
  assert.equal(newer.plan.revision,2);
  assert.deepEqual(newer.feedback,[],'замечания старой версии не переносятся на новый план');
  assert.deepEqual(f.api.planVersion('alvi',1).feedback,saved.feedback,'история старой версии доступна');
});

test('предложения ограничены текущей версией, конкретной строкой и своей компанией',t=>{
  const f=fixture(t);
  const body={planRevision:1,dayIndex:0,message:'Уточнить зацепку'};
  assert.throws(()=>f.api.addFeedback('alvi',body,ACTOR),e=>e.status===404);
  f.ready();
  for(const invalid of [{...body,planRevision:0},{...body,planRevision:2}])
    assert.throws(()=>f.api.addFeedback('alvi',invalid,ACTOR),e=>e.status===409&&e.details.code==='STALE_PLAN');
  for(const invalid of [{...body,dayIndex:-1},{...body,dayIndex:7},{...body,dayIndex:0.5},
    {...body,message:' '},{...body,message:'x'.repeat(1001)},{...body,actorName:'Подставной автор'}])
    assert.throws(()=>f.api.addFeedback('alvi',invalid,ACTOR),e=>e.status===400);
  assert.throws(()=>f.api.addFeedback('alvi',body,{}),e=>e.status===400);
  assert.deepEqual(f.api.get('alvi').feedback,[]);

  f.api.addFeedback('alvi',body,ACTOR);
  f.ready('avokado');
  assert.deepEqual(f.api.get('avokado').feedback,[]);
  assert.deepEqual(f.api.planVersion('avokado',1).feedback,[]);
  const other=f.api.addFeedback('avokado',{...body,message:'Другая компания'},
    {userId:8,userName:'Редактор Авокадо'});
  assert.equal(other.feedback.length,1);
  assert.equal(f.api.get('alvi').feedback.length,1);
  assert.throws(()=>f.api.planVersion('avokado',2),e=>e.status===404);
  assert.throws(()=>f.db.exec("UPDATE media_mentor_plan_feedback SET message='Подмена'"),/Immutable media mentor feedback/);
});

/* ---------- Версии площадок ----------
   Одна идея — до семи независимых текстов. Решение адресное: весь план, идея или выбранные
   версии. Правка снимает решение только по своей версии. Перестановка идей связей не рвёт. */

const variantsOf=(patch={})=>({vk:{text:'ВК: текст'},telegram:{text:'ТГ: текст'},...patch});

test('старый план читается как одна версия, новые площадки появляются только явно',t=>{
  const f=fixture(t),state=f.ready();
  const idea=state.plan.days[0];
  assert.ok(idea.ideaId,'идее выдан устойчивый идентификатор');
  assert.deepEqual(Object.keys(idea.variants),[idea.platform],
    'за остальные площадки автоматического согласия никто не даёт');
  assert.equal(idea.variants[idea.platform].text,'','текст версии не выдумывается');
  assert.equal(idea.variants[idea.platform].contentRevision,1);
  assert.equal(state.variants.length,7);
  assert.ok(state.variants.every(item=>item.status==='empty'),'пустая версия согласованной не считается');
});

test('семь текстов одной идеи независимы, три материала в день считаются по идеям',t=>{
  const f=fixture(t);
  f.api.saveBrief('alvi',{revision:0,brief:BRIEF},ACTOR);
  const days=daysFor().map(day=>({...day,variants:variantsOf()}));
  const state=f.api.savePlan('alvi',{planRevision:0,briefRevision:1,days},ACTOR);
  assert.deepEqual(Object.keys(state.plan.days[0].variants).sort(),['telegram','vk']);
  assert.equal(state.plan.days[0].variants.vk.text,'ВК: текст');
  assert.equal(state.plan.days[0].variants.telegram.text,'ТГ: текст');
  assert.equal(state.variants.length,14,'у каждой идеи своё состояние по каждой площадке');
  // Три идеи в один день с двумя версиями каждая — это три материала, а не шесть.
  const crowded=[...daysFor(2),...Array.from({length:3},(_,index)=>dayAt('2026-09-27',0,
    {topic:`Плотный день ${index+1}`,assetId:''})),...daysFor(4,'2026-09-28')]
    .map(day=>({...day,variants:variantsOf()}));
  const packed=f.api.savePlan('alvi',{planRevision:1,briefRevision:1,days:crowded},ACTOR);
  assert.equal(packed.plan.days.length,9);
  const tooMany=[...crowded.slice(0,5),{...crowded[4],topic:'Четвёртый материал'},...crowded.slice(5)];
  assert.throws(()=>f.api.savePlan('alvi',{planRevision:2,briefRevision:1,days:tooMany},ACTOR),
    e=>e.status===400&&/не больше/.test(e.message));
  // Версия для площадки, которой нет в брифе, не принимается.
  assert.throws(()=>f.api.savePlan('alvi',{planRevision:2,briefRevision:1,
    days:daysFor().map(day=>({...day,variants:variantsOf({instagram:{text:'Нельзя'}})}))},ACTOR),
  e=>e.status===400);
});

test('решение адресное: план, идея и выбранные версии — разные утверждения',t=>{
  const f=fixture(t);
  f.api.saveBrief('alvi',{revision:0,brief:BRIEF},ACTOR);
  const days=daysFor().map(day=>({...day,variants:variantsOf()}));
  let state=f.api.savePlan('alvi',{planRevision:0,briefRevision:1,days},ACTOR);
  const first=state.plan.days[0].ideaId,second=state.plan.days[1].ideaId;
  state=f.api.decideVariants('alvi',{planRevision:1,briefRevision:1,scope:'variants',
    ideaId:first,platforms:['vk'],decision:'approved',comment:''},ACTOR);
  let map=new Map(state.variants.map(item=>[`${item.ideaId}|${item.platform}`,item]));
  assert.equal(map.get(`${first}|vk`).status,'approved');
  assert.equal(map.get(`${first}|vk`).scope,'variants');
  assert.equal(map.get(`${first}|telegram`).status,'pending','соседняя версия согласия не получила');
  assert.equal(state.applied.length,1);
  state=f.api.decideVariants('alvi',{planRevision:1,briefRevision:1,scope:'idea',
    ideaId:second,decision:'approved',comment:''},ACTOR);
  map=new Map(state.variants.map(item=>[`${item.ideaId}|${item.platform}`,item]));
  assert.equal(map.get(`${second}|vk`).status,'approved');
  assert.equal(map.get(`${second}|telegram`).status,'approved');
  state=f.api.decideVariants('alvi',{planRevision:1,briefRevision:1,scope:'plan',
    decision:'approved',comment:''},ACTOR);
  assert.ok(state.variants.every(item=>item.status==='approved'),'план целиком закрывает остальные');
  assert.equal(state.applied.length,11,'уже согласованные повторно не переписываются');
  // Область обязана быть названа и не смешиваться с чужими полями.
  for(const invalid of [{scope:'plan',ideaId:first},{scope:'idea'},{scope:'variants',ideaId:first},
    {scope:'variants',ideaId:first,platforms:[]},{scope:'everything'}])
    assert.throws(()=>f.api.decideVariants('alvi',{planRevision:1,briefRevision:1,
      decision:'approved',comment:'',...invalid},ACTOR),e=>e.status===400||e.status===404);
});

test('возврат одной версии не трогает остальные и требует причины',t=>{
  const f=fixture(t);
  f.api.saveBrief('alvi',{revision:0,brief:BRIEF},ACTOR);
  const days=daysFor().map(day=>({...day,variants:variantsOf()}));
  let state=f.api.savePlan('alvi',{planRevision:0,briefRevision:1,days},ACTOR);
  const first=state.plan.days[0].ideaId;
  state=f.api.decideVariants('alvi',{planRevision:1,briefRevision:1,scope:'plan',
    decision:'approved',comment:''},ACTOR);
  assert.throws(()=>f.api.decideVariants('alvi',{planRevision:1,briefRevision:1,scope:'variants',
    ideaId:first,platforms:['vk'],decision:'rejected',comment:''},ACTOR),
  e=>e.status===400&&/что исправить/.test(e.message));
  state=f.api.decideVariants('alvi',{planRevision:1,briefRevision:1,scope:'variants',
    ideaId:first,platforms:['vk'],decision:'rejected',comment:'Слишком длинно'},ACTOR);
  let map=new Map(state.variants.map(item=>[`${item.ideaId}|${item.platform}`,item]));
  assert.equal(map.get(`${first}|vk`).status,'rejected');
  assert.equal(map.get(`${first}|vk`).reason,'Слишком длинно');
  assert.equal(map.get(`${first}|telegram`).status,'approved','возврат одной версии соседнюю не трогает');
  // Отзыв снимает согласование и возвращает версию в ожидание.
  state=f.api.decideVariants('alvi',{planRevision:1,briefRevision:1,scope:'variants',
    ideaId:first,platforms:['telegram'],decision:'withdrawn',comment:''},ACTOR);
  map=new Map(state.variants.map(item=>[`${item.ideaId}|${item.platform}`,item]));
  assert.equal(map.get(`${first}|telegram`).status,'pending');
  assert.equal(map.get(`${first}|telegram`).reason,'Согласование отозвано');
  // Отзывать нечего, если согласования не было.
  assert.throws(()=>f.api.decideVariants('alvi',{planRevision:1,briefRevision:1,scope:'variants',
    ideaId:first,platforms:['vk'],decision:'withdrawn',comment:''},ACTOR),e=>e.status===409);
});

test('правка версии снимает её решение и не трогает соседние; смена брифа требует пересогласования',t=>{
  const f=fixture(t);
  f.api.saveBrief('alvi',{revision:0,brief:BRIEF},ACTOR);
  const days=daysFor().map(day=>({...day,variants:variantsOf()}));
  let state=f.api.savePlan('alvi',{planRevision:0,briefRevision:1,days},ACTOR);
  const first=state.plan.days[0].ideaId;
  state=f.api.decideVariants('alvi',{planRevision:1,briefRevision:1,scope:'plan',
    decision:'approved',comment:''},ACTOR);
  const edited=state.plan.days.map((day,index)=>index===0
    ? {...day,variants:{...day.variants,vk:{...day.variants.vk,text:'ВК: переписали'}}} : day);
  state=f.api.savePlan('alvi',{planRevision:state.plan.revision,briefRevision:1,days:edited},ACTOR);
  assert.equal(state.plan.days[0].variants.vk.contentRevision,2);
  assert.equal(state.plan.days[0].variants.telegram.contentRevision,1,'соседняя версия не переоценивается');
  let map=new Map(state.variants.map(item=>[`${item.ideaId}|${item.platform}`,item]));
  assert.equal(map.get(`${first}|vk`).status,'pending','правка сняла решение по своей версии');
  assert.equal(map.get(`${first}|telegram`).status,'approved','и только по своей');
  // Правка поля самой идеи касается всех её версий: задание изменилось целиком.
  const retopic=state.plan.days.map((day,index)=>index===0?{...day,topic:'Новая тема'}:day);
  state=f.api.savePlan('alvi',{planRevision:state.plan.revision,briefRevision:1,days:retopic},ACTOR);
  map=new Map(state.variants.map(item=>[`${item.ideaId}|${item.platform}`,item]));
  assert.equal(map.get(`${first}|telegram`).status,'pending','смена темы сняла решение по всем версиям идеи');
  // Смена брифа возвращает на пересогласование все версии.
  f.api.saveBrief('alvi',{revision:1,brief:{...BRIEF,goal:'Новая цель'}},ACTOR);
  const after=f.api.savePlan('alvi',{planRevision:state.plan.revision,briefRevision:2,
    days:state.plan.days},ACTOR);
  assert.ok(after.variants.every(item=>item.status!=='approved'),'после смены брифа согласий нет');
});

test('перестановка идей не перепривязывает историю решений',t=>{
  const f=fixture(t);
  f.api.saveBrief('alvi',{revision:0,brief:BRIEF},ACTOR);
  // Две идеи в один день: их порядок можно поменять, не трогая ни одной даты.
  const days=[dayAt('2026-09-21',0,{topic:'Первая'}),dayAt('2026-09-21',0,{topic:'Вторая'}),
    ...daysFor(6,'2026-09-22')].map(day=>({...day,variants:variantsOf()}));
  let state=f.api.savePlan('alvi',{planRevision:0,briefRevision:1,days},ACTOR);
  const first=state.plan.days[0].ideaId,second=state.plan.days[1].ideaId;
  state=f.api.decideVariants('alvi',{planRevision:1,briefRevision:1,scope:'idea',
    ideaId:first,decision:'approved',comment:''},ACTOR);
  const moved=[state.plan.days[1],state.plan.days[0],...state.plan.days.slice(2)];
  state=f.api.savePlan('alvi',{planRevision:state.plan.revision,briefRevision:1,days:moved},ACTOR);
  assert.equal(state.plan.days[0].ideaId,second,'идентификаторы пережили перестановку');
  assert.equal(state.plan.days[1].ideaId,first);
  const map=new Map(state.variants.map(item=>[`${item.ideaId}|${item.platform}`,item]));
  assert.equal(map.get(`${first}|vk`).status,'approved','решение осталось у своей идеи');
  assert.equal(map.get(`${first}|vk`).contentRevision,1,'ревизия не менялась: содержимое прежнее');
  assert.equal(map.get(`${second}|vk`).status,'pending','и не переехало на соседнюю');
});

/* Блокеры приёмки 1 и 5: ревизия содержимого монотонна по сохранённой истории,
   а считается по ДЕЙСТВУЮЩЕМУ содержимому — с учётом значений, унаследованных от идеи. */
test('удаление версии и возврат прежнего текста не воскрешают старое согласование',t=>{
  const f=fixture(t);
  f.api.saveBrief('alvi',{revision:0,brief:BRIEF},ACTOR);
  const days=daysFor().map(day=>({...day,variants:variantsOf()}));
  let state=f.api.savePlan('alvi',{planRevision:0,briefRevision:1,days},ACTOR);
  const first=state.plan.days[0].ideaId;
  state=f.api.decideVariants('alvi',{planRevision:1,briefRevision:1,scope:'variants',
    ideaId:first,platforms:['vk'],decision:'approved',comment:''},ACTOR);
  assert.equal(state.plan.days[0].variants.vk.contentRevision,1);
  // Версия удалена целиком: основной площадкой идеи становится telegram.
  const without=state.plan.days.map((day,index)=>index===0
    ? {...day,platform:'telegram',variants:{telegram:day.variants.telegram}}:day);
  state=f.api.savePlan('alvi',{planRevision:state.plan.revision,briefRevision:1,days:without},ACTOR);
  assert.equal(state.plan.days[0].variants.vk,undefined);
  // И возвращена ровно тем же текстом.
  const back=state.plan.days.map((day,index)=>index===0
    ? {...day,variants:{...day.variants,vk:{text:'ВК: текст'}}}:day);
  state=f.api.savePlan('alvi',{planRevision:state.plan.revision,briefRevision:1,days:back},ACTOR);
  assert.equal(state.plan.days[0].variants.vk.contentRevision,2,'выдана новая ревизия, а не прежняя');
  const map=new Map(state.variants.map(item=>[`${item.ideaId}|${item.platform}`,item]));
  assert.equal(map.get(`${first}|vk`).status,'pending','старое согласование не ожило');
});

test('A→B→A даёт три разные ревизии, история переживает удаление идеи',t=>{
  const f=fixture(t);
  f.api.saveBrief('alvi',{revision:0,brief:BRIEF},ACTOR);
  const days=daysFor().map(day=>({...day,variants:variantsOf()}));
  let state=f.api.savePlan('alvi',{planRevision:0,briefRevision:1,days},ACTOR);
  const first=state.plan.days[0].ideaId;
  const withText=(value)=>state.plan.days.map((day,index)=>index===0
    ? {...day,variants:{...day.variants,vk:{...day.variants.vk,text:value}}}:day);
  state=f.api.savePlan('alvi',{planRevision:state.plan.revision,briefRevision:1,days:withText('Б')},ACTOR);
  assert.equal(state.plan.days[0].variants.vk.contentRevision,2);
  state=f.api.savePlan('alvi',{planRevision:state.plan.revision,briefRevision:1,days:withText('ВК: текст')},ACTOR);
  assert.equal(state.plan.days[0].variants.vk.contentRevision,3,'возврат к прежнему тексту — новая ревизия');
  const kept={...state.plan.days[0]};
  // Идея удалена: на её месте другая, окно плана сохраняется.
  const dropped=[dayAt('2026-09-21',0,{topic:'Замена',assetId:'',ideaId:'zamena-1'}),...state.plan.days.slice(1)]
    .map(day=>({...day,variants:day.variants||variantsOf()}));
  state=f.api.savePlan('alvi',{planRevision:state.plan.revision,briefRevision:1,days:dropped},ACTOR);
  assert.equal(state.plan.days.some(day=>day.ideaId===first),false,'идея действительно удалена');
  // И заведена заново под тем же идентификатором с прежним текстом.
  const restored=[{...kept,variants:variantsOf()},...state.plan.days.slice(1)];
  state=f.api.savePlan('alvi',{planRevision:state.plan.revision,briefRevision:1,days:restored},ACTOR);
  const revived=state.plan.days.find(day=>day.ideaId===first);
  assert.ok(revived.variants.vk.contentRevision>3,'повторное использование ID не сбрасывает историю ревизий');
  assert.ok(revived.variants.telegram.contentRevision>1);
});

test('правка поля идеи меняет ревизию наследующей версии и не трогает версию со своим значением',t=>{
  const f=fixture(t);
  f.api.saveBrief('alvi',{revision:0,brief:BRIEF},ACTOR);
  // vk наследует формат идеи, telegram задаёт свой.
  const days=daysFor().map((day,index)=>index===0
    ? {...day,platform:'vk',format:'post',variants:{vk:{text:'ВК'},telegram:{text:'ТГ',format:'reel'}}}
    : {...day,variants:variantsOf()});
  let state=f.api.savePlan('alvi',{planRevision:0,briefRevision:1,days},ACTOR);
  const first=state.plan.days[0].ideaId;
  state=f.api.decideVariants('alvi',{planRevision:1,briefRevision:1,scope:'idea',
    ideaId:first,decision:'approved',comment:''},ACTOR);
  const changed=state.plan.days.map((day,index)=>index===0?{...day,format:'carousel'}:day);
  state=f.api.savePlan('alvi',{planRevision:state.plan.revision,briefRevision:1,days:changed},ACTOR);
  const map=new Map(state.variants.map(item=>[`${item.ideaId}|${item.platform}`,item]));
  assert.equal(map.get(`${first}|vk`).status,'pending','наследующая версия изменилась и требует решения');
  assert.equal(map.get(`${first}|telegram`).status,'approved','версия со своим форматом согласование не теряет');
  assert.equal(state.plan.days[0].variants.telegram.contentRevision,1);
});

test('пустая и исключённая версии не согласуются; ревизии и чужая компания проверяются',t=>{
  const f=fixture(t);
  f.api.saveBrief('alvi',{revision:0,brief:BRIEF},ACTOR);
  const days=daysFor().map((day,index)=>index===0
    ? {...day,variants:{vk:{text:'ВК: текст'},telegram:{text:''}}}
    : {...day,variants:variantsOf({telegram:{text:'ТГ',excluded:true}})});
  let state=f.api.savePlan('alvi',{planRevision:0,briefRevision:1,days},ACTOR);
  const first=state.plan.days[0].ideaId,other=state.plan.days[1].ideaId;
  state=f.api.decideVariants('alvi',{planRevision:1,briefRevision:1,scope:'plan',
    decision:'approved',comment:''},ACTOR);
  const map=new Map(state.variants.map(item=>[`${item.ideaId}|${item.platform}`,item]));
  assert.equal(map.get(`${first}|telegram`).status,'empty');
  assert.equal(map.get(`${first}|telegram`).decision,null,'пустая версия одобренной не становится');
  assert.equal(map.get(`${other}|telegram`).status,'excluded');
  assert.equal(map.get(`${first}|vk`).status,'approved');
  // Явный выбор пустой версии — ошибка, а не молчаливый пропуск.
  assert.throws(()=>f.api.decideVariants('alvi',{planRevision:state.plan.revision,briefRevision:1,
    scope:'variants',ideaId:first,platforms:['telegram'],decision:'approved',comment:''},ACTOR),
  e=>e.status===409&&e.details.code==='VARIANT_NOT_APPROVABLE');
  // Устаревшие ревизии и чужая идея отклоняются.
  assert.throws(()=>f.api.decideVariants('alvi',{planRevision:99,briefRevision:1,scope:'plan',
    decision:'approved',comment:''},ACTOR),e=>e.details.code==='REVISION_CONFLICT');
  assert.throws(()=>f.api.decideVariants('alvi',{planRevision:state.plan.revision,briefRevision:1,
    scope:'idea',ideaId:'idea-чужая',decision:'approved',comment:''},ACTOR),e=>e.status===400||e.status===404);
  f.ready('avokado');
  assert.deepEqual(f.api.get('avokado').variants.filter(item=>item.status==='approved'),[],
    'решения одной компании другой не видны');
  assert.throws(()=>f.db.exec("UPDATE media_mentor_variant_approvals SET decision='rejected'"),
    /Immutable media mentor variant approval/);
});

test('лимит текста площадки и план выхода версии проверяются, очередью публикации не становятся',t=>{
  const f=fixture(t);
  f.api.saveBrief('alvi',{revision:0,brief:BRIEF},ACTOR);
  const limit=f.api.get('alvi').vocabulary.captionLimits.telegram;
  assert.ok(limit>0,'лимит площадки известен из существующего словаря');
  const tooLong=daysFor().map((day,index)=>index===0
    ? {...day,variants:variantsOf({telegram:{text:'я'.repeat(limit+1)}})}:{...day,variants:variantsOf()});
  assert.throws(()=>f.api.savePlan('alvi',{planRevision:0,briefRevision:1,days:tooLong},ACTOR),
    e=>e.status===400&&/длиннее/.test(e.message));
  const planned=daysFor().map((day,index)=>index===0
    ? {...day,variants:variantsOf({vk:{text:'ВК: текст',plannedDate:'2026-09-21',
      plannedTime:'09:30',timezone:'Asia/Irkutsk'}})}:{...day,variants:variantsOf()});
  const state=f.api.savePlan('alvi',{planRevision:0,briefRevision:1,days:planned},ACTOR);
  const vk=state.plan.days[0].variants.vk;
  assert.deepEqual([vk.plannedDate,vk.plannedTime,vk.timezone],['2026-09-21','09:30','Asia/Irkutsk']);
  assert.equal(state.capabilities.publishing,false,'план выхода очередью публикации не становится');
  for(const bad of [{plannedTime:'25:00'},{plannedTime:'9:30'},{timezone:'Марс/Олимп'},
    {plannedDate:'2026-02-30'},{format:'видео'}])
    assert.throws(()=>f.api.savePlan('alvi',{planRevision:state.plan.revision,briefRevision:1,
      days:daysFor().map((day,index)=>index===0
        ? {...day,variants:variantsOf({vk:{text:'ВК: текст',...bad}})}:{...day,variants:variantsOf()})},ACTOR),
    e=>e.status===400);
});

test('обмен датами между материалами принимается сервером и сохраняет привязки',t=>{
  const f=fixture(t);
  f.api.saveBrief('alvi',{revision:0,brief:BRIEF},ACTOR);
  const days=daysFor().map(day=>({...day,variants:variantsOf()}));
  let state=f.api.savePlan('alvi',{planRevision:0,briefRevision:1,days},ACTOR);
  const first=state.plan.days[0].ideaId,second=state.plan.days[1].ideaId;
  const before={start:state.plan.startDate,end:state.plan.endDate,window:state.plan.windowDays};
  /* Ровно то, что делает кнопка «ниже» в кабинете: соседи меняются календарными датами,
     а сами материалы едут вместе со своими версиями. Набор дат не меняется. */
  const swapped=[{...state.plan.days[1],date:state.plan.days[0].date},
    {...state.plan.days[0],date:state.plan.days[1].date},...state.plan.days.slice(2)];
  state=f.api.savePlan('alvi',{planRevision:state.plan.revision,briefRevision:1,days:swapped},ACTOR);
  assert.deepEqual(state.plan.days.slice(0,2).map(day=>day.ideaId),[second,first],
    'материалы поменялись местами');
  assert.deepEqual(state.plan.days.slice(0,2).map(day=>day.date),['2026-09-21','2026-09-22']);
  assert.deepEqual([state.plan.startDate,state.plan.endDate,state.plan.windowDays],
    [before.start,before.end,before.window],'окно плана не расширилось и не сузилось');
  assert.equal(state.plan.days[1].variants.vk.text,'ВК: текст','версии переехали со своей идеей');
  // Плановая дата версии наследуется от идеи, поэтому переезд требует нового решения.
  const map=new Map(state.variants.map(item=>[`${item.ideaId}|${item.platform}`,item]));
  assert.ok(map.get(`${first}|vk`).contentRevision>1,'смена даты меняет действующее содержимое');
});

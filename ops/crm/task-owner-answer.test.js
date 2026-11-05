'use strict';
// №135: ответ Влада на доске сразу снимает «Ждут Влада»; ответ не-владельца — нет.
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createTaskCoordination,migrateTasksMcp}=require('./task-coordination');
const {createTaskWatchdog}=require('./task-watchdog');
const {ownerAnswerText}=require('./task-owner-answer');
const vlad={role:'owner',userId:1,userName:'Влад',companyCodes:new Set(['alpha']),trusted:{kind:'vlad',id:1,key:'person:1',name:'Влад'}};
const agent={role:'owner',userId:1,userName:'Codex',companyCodes:new Set(['alpha']),trusted:{kind:'agent',id:5,key:'agent:5',name:'Codex'}};
const plain={role:'owner',userId:1,userName:'Влад',companyCodes:new Set(['alpha'])};
function fixture(t) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE companies(code TEXT PRIMARY KEY,is_deleted INTEGER NOT NULL DEFAULT 0);INSERT INTO companies VALUES('alpha',0);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0,deleted_at TEXT,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',
      company_code TEXT NOT NULL DEFAULT '',assignee_name TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'inbox',
      priority TEXT NOT NULL DEFAULT 'normal',due_date TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','chat','pipeline')),created_by TEXT NOT NULL DEFAULT '');`);
  createTaskCoordination(db);
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');try{migrateTasksMcp(db);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  const now=()=>Date.parse('2026-11-05T03:00:00Z');
  const watchdog=createTaskWatchdog(db,{now,principal:a=>a?.trusted||null,mode:'observe'});
  const api=createTaskCoordination(db,{now,watchdog});
  const call=(name,args,actor=vlad)=>api.tool(name,args,actor);
  let n=0;const waiting=extra=>{
    const task=call('task_create',{project:'alpha',title:`Вопрос ${++n}`,executor:'Codex',client_ref:`owner-answer:${n}`}).task;
    call('task_update',{task_id:task.id,blocker:'ждёт Влада: выбрать вариант',next_step:'ждёт Влада — ответ кнопкой',owner_question:'Берём вариант А?',if_yes:'Делаем А',if_no:'Делаем Б',owner_minutes:2,...extra},plain);
    return task.id;};
  const coord=id=>call('task_get',{task_id:id}).coordination;
  return {db,call,waiting,coord};
}
test('ответ Влада кнопкой «ОТВЕТ: да» в той же транзакции снимает blocker и вопрос, ход — исполнителю',t=>{
  const f=fixture(t),id=f.waiting();
  const before=f.coord(id);assert.equal(before.owner_question,'Берём вариант А?');
  f.call('task_comment',{task_id:id,author:'Влад',text:'ОТВЕТ: да'});
  const c=f.coord(id);
  assert.equal(c.blocker,'');assert.equal(c.owner_question,'');assert.equal(c.if_yes,'');assert.equal(c.if_no,'');assert.equal(c.owner_minutes,null);
  assert.equal(c.nextAction,'Влад ответил: да — ход исполнителя');
  assert.equal(c.executorName,'Codex','исполнитель не меняется');
  assert.equal(c.revision,before.revision+1);
  const history=f.db.prepare('SELECT revision,data FROM task_coordination_history WHERE task_id=? ORDER BY revision DESC LIMIT 1').get(id);
  assert.equal(history.revision,c.revision);assert.equal(JSON.parse(history.data).owner_question,'');
  // Агенты видят ответ в task_get: комментарий и новый next_step.
  const full=f.call('task_get',{task_id:id});assert.ok(full.comments.some(m=>m.text==='ОТВЕТ: да'));
});
test('«готово» от Влада тоже снимает ожидание; чужой blocker остаётся',t=>{
  const f=fixture(t),id=f.waiting({blocker:'ждёт ревьюера'});
  f.call('task_comment',{task_id:id,author:'Влад',text:'Готово, проверил'});
  const c=f.coord(id);assert.equal(c.blocker,'ждёт ревьюера');assert.equal(c.owner_question,'');assert.match(c.nextAction,/^Влад ответил: Готово, проверил/);
});
test('ответ не-владельца или без подписи сервера ничего не снимает',t=>{
  const f=fixture(t),id=f.waiting();
  f.call('task_comment',{task_id:id,author:'Влад',text:'ОТВЕТ: да'},agent);
  f.call('task_comment',{task_id:id,author:'Влад',text:'готово'},plain);
  const c=f.coord(id);assert.equal(c.blocker,'ждёт Влада: выбрать вариант');assert.equal(c.owner_question,'Берём вариант А?');
  // Обычный комментарий Влада без ответа тоже не снимает.
  f.call('task_comment',{task_id:id,author:'Влад',text:'Подумаю до вечера'});
  assert.equal(f.coord(id).owner_question,'Берём вариант А?');
  // Задача без ожидания не трогается.
  const free=f.call('task_create',{project:'alpha',title:'Без вопроса',executor:'Codex',client_ref:'owner-answer:free'}).task.id;
  const rev=f.coord(free).revision;f.call('task_comment',{task_id:free,author:'Влад',text:'готово'});assert.equal(f.coord(free).revision,rev);
});
test('разбор текста ответа',()=>{
  assert.equal(ownerAnswerText('ОТВЕТ: нет'),'нет');assert.equal(ownerAnswerText('  ответ:  да,  но позже '),'да, но позже');
  assert.equal(ownerAnswerText('сделал'),'сделал');assert.equal(ownerAnswerText('Сделано.'),'Сделано.');
  for(const v of ['ОТВЕТ → Влад: да','Не готово','готовой версии нет','ОТВЕТ:','', 'Сделаем завтра'])assert.equal(ownerAnswerText(v),'',v);
});

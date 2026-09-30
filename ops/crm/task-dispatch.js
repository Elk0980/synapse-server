'use strict';
const {randomUUID}=require('node:crypto');
const DEPARTMENTS=['coordination','engineering','design','marketing','analytics','support'];
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const clean=(v,max=4000)=>{if(typeof v!=='string'||v.length>max)fail(400,'Некорректное поле задачи');return v.trim();};
const owner=a=>{if(a?.role!=='owner'||!Number.isSafeInteger(a.userId)||a.userId<1)fail(403,'Диспетчер доступен владельцу');};
function createTaskDispatch(db,{now=()=>Date.now()}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS task_dispatch(task_id INTEGER PRIMARY KEY REFERENCES tasks(id),company_code TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,cycle INTEGER NOT NULL DEFAULT 1,state TEXT NOT NULL,department TEXT NOT NULL DEFAULT 'coordination',
 question TEXT NOT NULL DEFAULT '',answer TEXT NOT NULL DEFAULT '',result TEXT NOT NULL DEFAULT '',provider TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',
 usage TEXT NOT NULL DEFAULT '{}',attempts INTEGER NOT NULL DEFAULT 0,lease_token TEXT NOT NULL DEFAULT '',lease_until INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS task_dispatch_history(id INTEGER PRIMARY KEY,task_id INTEGER NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS task_dispatch_alerts(id INTEGER PRIMARY KEY,task_id INTEGER NOT NULL,company_code TEXT NOT NULL,event_key TEXT NOT NULL UNIQUE,text TEXT NOT NULL,handed_off INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS task_dispatch_mirrors(room TEXT NOT NULL,source_id INTEGER NOT NULL,task_id INTEGER NOT NULL,source_version INTEGER NOT NULL DEFAULT 0,source_note TEXT NOT NULL DEFAULT '',PRIMARY KEY(room,source_id));
 CREATE TRIGGER IF NOT EXISTS dispatch_history_no_update BEFORE UPDATE ON task_dispatch_history BEGIN SELECT RAISE(ABORT,'Immutable dispatch history'); END;
 CREATE TRIGGER IF NOT EXISTS dispatch_history_no_delete BEFORE DELETE ON task_dispatch_history BEGIN SELECT RAISE(ABORT,'Immutable dispatch history'); END;`);
 const stamp=()=>new Date(now()).toISOString();
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const task=id=>{if(!Number.isSafeInteger(id)||id<1)fail(400,'Некорректная задача');const r=db.prepare('SELECT * FROM tasks WHERE id=? AND is_deleted=0').get(id);if(!r)fail(404,'Задача не найдена');return r;};
 const row=id=>db.prepare('SELECT * FROM task_dispatch WHERE task_id=?').get(id);
 const history=(id,note)=>{const r=row(id);db.prepare('INSERT INTO task_dispatch_history(task_id,revision,state,note,created_at) VALUES(?,?,?,?,?)').run(id,r.revision,r.state,note,stamp());};
 const change=(id,fields,note)=>{db.prepare(`UPDATE task_dispatch SET ${Object.keys(fields).map(k=>`${k}=?`).join(',')},revision=revision+1,updated_at=? WHERE task_id=?`).run(...Object.values(fields),stamp(),id);history(id,note);};
 const alert=(r,label)=>db.prepare('INSERT OR IGNORE INTO task_dispatch_alerts(task_id,company_code,event_key,text) VALUES(?,?,?,?)').run(r.task_id,r.company_code,`dispatch:${r.task_id}:${r.cycle}:${r.state}`,`Задача #${r.task_id} · ${r.company_code}\n${label}\n${r.question||r.result||'Требуется проверка владельца'}\nЛК → Задачи → Доска проектов.`.slice(0,3000));
 function reconcile(){
  for(const r of db.prepare("SELECT d.* FROM task_dispatch d LEFT JOIN tasks t ON t.id=d.task_id WHERE d.state NOT IN ('done','cancelled') AND (t.id IS NULL OR t.is_deleted=1 OR t.company_code<>d.company_code OR t.status IN ('done','cancelled'))").all()) change(r.task_id,{state:'cancelled',lease_token:'',lease_until:0},'Работа остановлена: исходная задача закрыта, удалена или перенесена');
  for(const r of db.prepare("SELECT * FROM task_dispatch WHERE state='running' AND lease_until<=?").all(now())){
   change(r.task_id,{state:r.attempts<2?'queued':'blocked',lease_token:'',lease_until:0,result:r.attempts<2?'Повтор после прерывания обработки':'Обработчик не завершил две попытки. Требуется проверка владельца.'},'Истекла аренда обработки');
   if(r.attempts>=2)alert(row(r.task_id),'Обработка остановилась');
  }
 }
 function view(r){if(!r)return null;return {taskId:r.task_id,companyCode:r.company_code,revision:r.revision,state:r.state,department:r.department,question:r.question,answer:r.answer,result:r.result,provider:r.provider,model:r.model,attempts:r.attempts,updatedAt:r.updated_at,usage:JSON.parse(r.usage),
 limits:{attemptsPerCycle:2,maxOutputTokens:1200},executor:r.state==='running'?'Серверный API':r.state==='awaiting_executor'?'Не подключён':r.model?`${r.provider} · ${r.model}`:'Не назначен'};}
 function get(id,a){owner(a);task(id);reconcile();return {...(view(row(id))||{taskId:id,revision:0,state:'manual'}),history:db.prepare('SELECT revision,state,note,created_at AS createdAt FROM task_dispatch_history WHERE task_id=? ORDER BY id DESC LIMIT 30').all(id)};}
 function put(id,revision){const t=task(id);if(['done','cancelled'].includes(t.status))fail(409,'Задача уже закрыта');if(!t.company_code)fail(400,'Выберите проект задачи');const old=row(id);if((old?.revision||0)!==revision)fail(409,'Карточка изменилась. Обновите её');if(old)fail(409,'Задача уже передана диспетчеру');
  db.prepare("INSERT INTO task_dispatch(task_id,company_code,state,updated_at,created_at) VALUES(?,?,'queued',?,?)").run(id,t.company_code,stamp(),stamp());history(id,'Поручение принято сервером. Ожидает разбора недорогой моделью.');
 }
 function enqueue(id,b,a){owner(a);tx(()=>put(id,b.revision));return get(id,a);}
 function act(id,b,a){owner(a);reconcile();tx(()=>{task(id);const r=row(id);if(!r||r.revision!==b.revision)fail(409,'Карточка изменилась. Обновите её');
  if(b.action==='cancel'){change(id,{state:'cancelled',lease_token:'',lease_until:0},'Владелец остановил обработку');return;}
  if(b.action==='accept'){if(r.state!=='review')fail(409,'Нет результата на проверке');change(id,{state:'done'},'Владелец принял результат');db.prepare("UPDATE tasks SET status='done',updated_at=? WHERE id=?").run(stamp(),id);return;}
  if(!['answer','revise','retry'].includes(b.action)||!['needs_input','review','blocked','awaiting_executor'].includes(r.state))fail(409,'Действие недоступно');
  if(b.action==='answer'&&r.state!=='needs_input')fail(409,'Нет вопроса');if(b.action==='revise'&&r.state!=='review')fail(409,'Нет результата');
  const answer=clean(b.text||'',2000);if(!answer)fail(400,'Укажите ответ или следующий шаг');
  change(id,{state:'queued',answer:[r.answer,answer].filter(Boolean).join('\n').slice(-4000),question:'',result:'',cycle:r.cycle+1,attempts:0,next_at:0,lease_token:'',lease_until:0},`Уточнение владельца: ${answer}`);
 });return get(id,a);}
 function claim(){return tx(()=>{reconcile();const r=db.prepare("SELECT d.*,t.title,t.description FROM task_dispatch d JOIN tasks t ON t.id=d.task_id WHERE d.state='queued' AND d.next_at<=? ORDER BY d.task_id LIMIT 1").get(now());if(!r)return null;
  const token=randomUUID();change(r.task_id,{state:'running',attempts:r.attempts+1,lease_token:token,lease_until:now()+180000},'Серверный API начал разбор; файловые исполнители не запущены');
  return {taskId:r.task_id,companyCode:r.company_code,leaseToken:token,title:r.title,description:(r.description+'\n'+(db.prepare('SELECT source_note FROM task_dispatch_mirrors WHERE task_id=?').get(r.task_id)?.source_note||'')).slice(-7000),answer:r.answer,maxOutputTokens:1200};});}
 function check(job){const r=row(job.taskId);if(!r||r.state!=='running'||r.company_code!==job.companyCode||r.lease_token!==job.leaseToken||r.lease_until<=now())fail(409,'Аренда недействительна');return r;}
 function renew(job){reconcile();return tx(()=>{check(job);db.prepare('UPDATE task_dispatch SET lease_until=? WHERE task_id=?').run(now()+180000,job.taskId);return {ok:true};});}
 function complete(job,b){reconcile();return tx(()=>{check(job);if(!['needs_input','review','awaiting_executor'].includes(b.state)||!DEPARTMENTS.includes(b.department))fail(400,'Некорректное решение');
  const usage={};for(const key of ['promptTokens','completionTokens']){const v=b.usage?.[key];if(v!=null&&(!Number.isSafeInteger(v)||v<0))fail(400,'Некорректный расход');usage[key]=v??null;}
  const provider=clean(b.provider||'',100),model=clean(b.model||'',150),question=clean(b.question||'',1500),result=clean(b.result||'',6000);
  if(!provider||!model||(b.state==='needs_input'?!question:!result))fail(400,'Нужны результат и проверенная модель');
  change(job.taskId,{state:b.state,department:b.department,question,result,provider,model,usage:JSON.stringify(usage),lease_token:'',lease_until:0},b.state==='review'?'Черновик подготовлен. Ожидает проверки владельца.':b.state==='needs_input'?'Нужно уточнение владельца.':'Подходящий исполнитель пока не подключён. Время начала не назначено.');
  alert(row(job.taskId),{review:'Результат готов к проверке',needs_input:'Нужен ваш ответ',awaiting_executor:'Нужно назначить исполнителя'}[b.state]);return {ok:true};});}
 function error(job){reconcile();return tx(()=>{const r=check(job);const state=r.attempts<2?'queued':'blocked';change(job.taskId,{state,next_at:now()+60000,lease_token:'',lease_until:0,result:'API не завершил обработку. Запрос сохранён; время выполнения пока не назначено.'},'Не удалось получить проверяемый ответ');alert({...row(job.taskId),state:'error'},'Задержка обработки задачи');return {ok:true};});}
 function mirror(b){if(!/^[a-z0-9_-]{1,64}$/.test(b.room||'')||!Number.isSafeInteger(b.sourceId)||b.sourceId<1)fail(400,'Некорректный источник');
  if(!db.prepare('SELECT 1 FROM companies WHERE code=? AND is_deleted=0').get(b.companyCode))fail(400,'Компания не найдена');
  const title=clean(b.title,300),note=clean(b.note||'',6000);if(!title)fail(400,'Нужно название');
  return tx(()=>{const version=Number.isSafeInteger(b.sourceVersion)&&b.sourceVersion>=0?b.sourceVersion:0;
   const old=db.prepare('SELECT * FROM task_dispatch_mirrors WHERE room=? AND source_id=?').get(b.room,b.sourceId);
   if(old){const current=task(old.task_id),dispatch=row(old.task_id);if(current.company_code!==b.companyCode)fail(409,'Задача перенесена в другую компанию');
    if(version>old.source_version){db.prepare('UPDATE task_dispatch_mirrors SET source_note=?,source_version=? WHERE room=? AND source_id=?').run(note,version,b.room,b.sourceId);
     if(!['done','cancelled'].includes(current.status)&&!['done','cancelled'].includes(dispatch.state))change(old.task_id,{state:'queued',cycle:dispatch.cycle+1,attempts:0,next_at:0,lease_token:'',lease_until:0,result:''},'Получено новое уточнение из переписки; прошлый результат требует повторной проверки');
    }return {taskId:old.task_id,state:row(old.task_id)?.state};}

   const id=Number(db.prepare("INSERT INTO tasks(title,description,company_code,created_at,updated_at,source,source_ref,source_author,created_by) VALUES(?,?,?,?,?,'chat',?,'Хью','Серверный помощник')").run(title,note,b.companyCode,stamp(),stamp(),`project-chat:${b.room}:${b.sourceId}`).lastInsertRowid);
   db.prepare('INSERT INTO task_dispatch_mirrors VALUES(?,?,?,?,?)').run(b.room,b.sourceId,id,version,note);put(id,0);return {taskId:id,state:'queued'};});}
 const alerts=()=>db.prepare('SELECT id,company_code AS companyCode,event_key AS eventKey,text FROM task_dispatch_alerts WHERE handed_off=0 ORDER BY id LIMIT 30').all();
 const ackAlert=id=>{db.prepare('UPDATE task_dispatch_alerts SET handed_off=1 WHERE id=?').run(id);return {ok:true};};
 return {get,enqueue,act,claim,renew,complete,error,mirror,alerts,ackAlert};
}
module.exports={createTaskDispatch,DEPARTMENTS};

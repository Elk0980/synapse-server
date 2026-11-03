'use strict';
const {randomInt} = require('node:crypto');
const MINUTE=60000, stages=['code','connected','verified','accepted'];
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const key=s=>String(s||'').trim().toLocaleLowerCase('ru');
const table=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

// Отчёт считается относящимся к задаче только при явном #id и совпадении исполнителя.
function activity(db,row) {
  let last=Date.parse(row.created_at)||0;
  if(table(db,'task_comments')) for(const c of db.prepare('SELECT author,created_at FROM task_comments WHERE task_id=?').all(row.id)) {
    if(key(c.author)===key(row.assignee_name)) last=Math.max(last,Date.parse(c.created_at)||0);
  }
  if(table(db,'task_watchdog_activity')) last=Math.max(last,db.prepare('SELECT at FROM task_watchdog_activity WHERE task_id=?').get(row.id)?.at||0);
  return last;
}
function silence(db,row,now) {
  const last=activity(db,row), age=Math.max(0,now-last);
  return {no_report:row.status==='in_progress'&&age>=45*MINUTE,
    silence_minutes:Math.floor(age/MINUTE),last_report_at:new Date(last).toISOString()};
}

// Только GitHub API фиксированного репозитория. Пользовательские URL не загружаются.
function createEvidenceVerifier({fetchImpl=fetch,repo='Elk0980/synapse-server',healthUrl='',token=''}={}) {
  const json=async path=>{
    const r=await fetchImpl(`https://api.github.com/repos/${repo}/${path}`,{redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{Accept:'application/vnd.github+json',...(token?{Authorization:`Bearer ${token}`}:{})}});
    if(!r.ok) fail(422,'GitHub не подтвердил доказательство'); return r.json();
  };
  async function code(evidence,{merged=false}={}) {
    const escaped=repo.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const m=String(evidence).match(new RegExp(`^https://github\\.com/${escaped}/(pull/[1-9][0-9]*|commit/[a-f0-9]{40})$`));
    if(!m)fail(422,'Нужна ссылка на PR или полный коммит рабочего репозитория');
    let sha;
    if(m[1].startsWith('pull/')) {
      const pr=await json(m[1].replace('pull/','pulls/'));
      if((pr.state!=='open'&&!pr.merged)||merged&&!pr.merged)fail(422,'PR не открыт и не слит либо ещё не слит');
      sha=pr.head?.sha;
    } else {const c=await json(m[1].replace('commit/','commits/'));sha=c.sha;}
    if(!/^[a-f0-9]{40}$/.test(sha||''))fail(422,'GitHub не вернул полный коммит');
    const [checks,status]=await Promise.all([json(`commits/${sha}/check-runs?per_page=100`),json(`commits/${sha}/status?per_page=100`)]);
    const runs=checks.check_runs||[], statuses=status.statuses||[];
    if((checks.total_count||0)>100||(status.total_count||0)>100||(!runs.length&&!statuses.length)||
      runs.some(c=>c.head_sha!==sha||c.status!=='completed'||c.conclusion!=='success')||
      statuses.some(c=>c.state!=='success'))fail(422,'CI точного коммита не подтверждён зелёным');
    return {sha,url:evidence};
  }
  async function connected(evidence) {
    const sha=String(evidence).trim();
    if(!/^[a-f0-9]{40}$/.test(sha)||!healthUrl)fail(422,'Нужны полный боевой коммит и настроенный health');
    const u=new URL(healthUrl);if(u.protocol!=='https:'||u.username||u.password)fail(503,'Некорректная настройка health');
    const r=await fetchImpl(u,{redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!r.ok)fail(422,'Боевой health недоступен');
    const body=await r.json();if(body.version!==sha)fail(422,'Версия на боевом не совпадает');return {sha};
  }
  return {code,connected};
}

function createTaskWatchdog(db,{now=()=>Date.now(),principal=()=>null,verifier=createEvidenceVerifier(),random=randomInt}={}) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_watchdog_activity(task_id INTEGER PRIMARY KEY,at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS task_watchdog_audits(day TEXT NOT NULL,task_id INTEGER NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(day,task_id));
    CREATE TABLE IF NOT EXISTS task_watchdog_digests(slot TEXT PRIMARY KEY,data TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS watchdog_audit_no_update BEFORE UPDATE ON task_watchdog_audits BEGIN SELECT RAISE(ABORT,'Immutable watchdog audit'); END;
    CREATE TRIGGER IF NOT EXISTS watchdog_audit_no_delete BEFORE DELETE ON task_watchdog_audits BEGIN SELECT RAISE(ABORT,'Immutable watchdog audit'); END;`);
  // Включается после создания coordination. Не меняет старые done-записи.
  function installGuards() {
    for(const name of ['task_coordination_history','task_comments','task_watchdog_audits']) {
      if(!table(db,name))continue;
      const collision=name==='task_coordination_history'?'task_id=NEW.task_id AND revision=NEW.revision':name==='task_watchdog_audits'?'day=NEW.day AND task_id=NEW.task_id':'id=NEW.id';
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${name}_watchdog_no_replace BEFORE INSERT ON ${name}
        WHEN EXISTS(SELECT 1 FROM ${name} WHERE ${collision}) BEGIN SELECT RAISE(ABORT,'Immutable watchdog history'); END;`);
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS watchdog_done_insert BEFORE INSERT ON tasks WHEN NEW.status='done'
      BEGIN SELECT RAISE(ABORT,'WATCHDOG_ACCEPTANCE_REQUIRED'); END;
      CREATE TRIGGER IF NOT EXISTS watchdog_done_update BEFORE UPDATE OF status ON tasks WHEN NEW.status='done' AND OLD.status<>'done'
      AND NOT EXISTS(SELECT 1 FROM task_coordination WHERE task_id=NEW.id AND json_extract(data,'$.milestones.accepted.state')='confirmed')
      BEGIN SELECT RAISE(ABORT,'WATCHDOG_ACCEPTANCE_REQUIRED'); END;`);
    if(db.prepare('PRAGMA table_info(tasks)').all().some(c=>c.name==='updated_at'))db.exec(`
      CREATE TRIGGER IF NOT EXISTS watchdog_start AFTER UPDATE OF status ON tasks
      WHEN NEW.status='in_progress' AND OLD.status<>'in_progress'
      BEGIN INSERT INTO task_watchdog_activity(task_id,at) VALUES(NEW.id,CAST(unixepoch(NEW.updated_at,'subsec')*1000 AS INTEGER))
      ON CONFLICT(task_id) DO UPDATE SET at=excluded.at; END;`);
  }
  const permits=new WeakMap();
  const row=id=>db.prepare('SELECT * FROM tasks WHERE id=? AND is_deleted=0').get(id);
  const old=id=>JSON.parse(db.prepare('SELECT data FROM task_coordination WHERE task_id=?').get(id)?.data||'{}');
  const changed=(before,after)=>stages.filter(s=>JSON.stringify(before.milestones?.[s])!==JSON.stringify(after.milestones?.[s])&&after.milestones?.[s]?.state!=='pending');
  // Вызывается до SQLite-транзакции. Principal поступает только от будущего trusted issuer.
  async function authorize(id,data,actor) {
    const t=row(id);if(!t)fail(404,'Задача не найдена');
    const baseline=JSON.stringify(old(id));
    const p=principal(actor), changes=changed(old(id),data);
    if(!changes.length)return;
    if(!p)fail(403,'Подтверждение этапа ждёт доверенной идентификации исполнителя');
    const proofs={};
    for(const s of changes) {
      const item=data.milestones[s];
      if(item.state!=='confirmed')fail(403,'Исключение этапа требует отдельного решения Влада');
      if(s==='code') {if(p.kind!=='executor'||key(p.name)!==key(t.assignee_name))fail(403,'Код подтверждает исполнитель');proofs[s]=await verifier.code(item.evidence);}
      if(s==='connected') {if(!['release','claude'].includes(p.kind))fail(403,'Подключение подтверждает выпускающий агент');proofs[s]=await verifier.connected(item.evidence);}
      if(s==='verified') {if(p.kind!=='reviewer'||key(p.name)!==key(t.reviewer_name)||key(p.name)===key(t.assignee_name))fail(403,'Нужен независимый проверяющий');
        if(!/^https:\/\/[^\s]+$/.test(item.evidence))fail(422,'Нужна ссылка на доказательство проверки');proofs[s]={url:item.evidence};}
      if(s==='accepted'&&p.kind!=='vlad')fail(403,'Принимает только Влад');
    }
    permits.set(actor,{id,data:JSON.stringify(data),baseline,assignee:t.assignee_name,reviewer:t.reviewer_name,at:now(),principal:p,proofs});
  }
  function guard(id,data,actor) {
    const before=old(id);
    if(stages.some(s=>before.milestones?.[s]?.state==='confirmed'&&data.milestones?.[s]?.state!=='confirmed'))fail(403,'Нельзя удалить подтверждённый этап');
    const changes=changed(old(id),data);if(!changes.length)return;
    const permit=permits.get(actor);permits.delete(actor);
    const t=row(id);
    if(!permit||permit.id!==id||permit.data!==JSON.stringify(data)||permit.baseline!==JSON.stringify(before)||
      permit.assignee!==t?.assignee_name||permit.reviewer!==t?.reviewer_name||
      data.executorName&&data.executorName!==t?.assignee_name||now()-permit.at>30000)fail(403,'Этап не подтверждён серверной проверкой');
  }
  function report(name,event,codes) {
    for(const match of String(event).matchAll(/(?:#|№)\s*(\d+)\b/g)) {
      const t=row(Number(match[1]));
      if(t&&key(t.assignee_name)===key(name)&&codes.has(key(t.company_code)))
        db.prepare('INSERT INTO task_watchdog_activity VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET at=excluded.at').run(t.id,now());
    }
  }
  function snapshot() {
    const tasks=db.prepare('SELECT * FROM tasks WHERE is_deleted=0').all(), alerts=[];
    for(const t of tasks) {
      const s=silence(db,t,now());if(s.no_report)alerts.push({task_id:t.id,kind:'silence',waiting_for:'Claude',minutes:s.silence_minutes,blocker:old(t.id).blocker||'Причина не указана'});
      if(!table(db,'task_comments')||['done','cancelled'].includes(t.status))continue;
      const comments=db.prepare('SELECT * FROM task_comments WHERE task_id=? ORDER BY id').all(t.id);
      const q=comments.filter(c=>/^ВОПРОС\s*→/.test(c.text)).at(-1);
      const recipient=q?.text.match(/^ВОПРОС\s*→\s*([^:\n]+)/)?.[1]?.trim()||'Claude';
      if(q&&now()-Date.parse(q.created_at)>=30*MINUTE&&!comments.some(c=>c.id>q.id&&key(c.author)===key(recipient)&&/^ОТВЕТ\s*→/.test(c.text)))
        alerts.push({task_id:t.id,kind:'question',waiting_for:q.text.match(/^ВОПРОС\s*→\s*([^:\n]+)/)?.[1]?.trim()||'Claude',comment_id:q.id});
    }
    const since=new Date(now()-24*60*MINUTE).toISOString(), events=[];
    // Изменение каждого этапа, а не повторение уже подтверждённого в новой ревизии.
    for(const t of tasks) {let previous={};for(const h of db.prepare('SELECT * FROM task_coordination_history WHERE task_id=? ORDER BY revision').all(t.id)) {
      const data=JSON.parse(h.data);for(const stage of stages) {
        const item=data.milestones?.[stage];
        if(h.updated_at>=since&&item?.state==='confirmed'&&JSON.stringify(item)!==JSON.stringify(previous.milestones?.[stage]))events.push({task_id:t.id,stage,evidence:item.evidence,at:h.updated_at,actor:h.updated_by});
      }previous=data;
    }}
    return {at:new Date(now()).toISOString(),delivery_enabled:false,total:tasks.length,events,alerts,
      stalled:alerts.filter(a=>a.kind==='silence'&&a.minutes>=180),
      waiting_vlad:tasks.filter(t=>!['done','cancelled'].includes(t.status)&&/жд[её]т.*влад|ожида.*влад/i.test(old(t.id).blocker||'')).map(t=>({task_id:t.id,blocker:old(t.id).blocker})),
      audits:db.prepare('SELECT * FROM task_watchdog_audits ORDER BY created_at DESC LIMIT 20').all()};
  }
  function digest() {
    const s=snapshot(),lines=[`Сводка доски · ${new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Bangkok',dateStyle:'short',timeStyle:'short'}).format(now())} (Бангкок)`,
      `Задач в базе: ${s.total}. Изменений подтверждённых этапов за сутки: ${s.events.length}.`,
      ...s.events.map(e=>`№${e.task_id} · ${e.stage}: ${e.evidence}`),
      `На боевой: ${s.events.filter(e=>e.stage==='connected').length}.`,
      `Тишина от 3 часов: ${s.stalled.length}.`,...s.stalled.map(a=>`№${a.task_id} · ${a.minutes} мин · ${a.blocker}`),
      `Ждут Влада: ${s.waiting_vlad.length}.`,...s.waiting_vlad.map(t=>`№${t.task_id} · ${t.blocker}`),
      'Исторические подтверждения — записи базы; их внешняя перепроверка указана отдельно. Рассылка выключена.'];
    return {...s,text:lines.join('\n')};
  }
  let running=false;
  // Только сохранение в кабинет. Ни Telegram transport, ни флага его включения здесь нет.
  function prepareScheduledDigest() {
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(now()).map(p=>[p.type,p.value]));
    const hour=Number(parts.hour);if(hour<8)return;
    const slot=`${parts.year}-${parts.month}-${parts.day}/${hour<20?'08':'20'}`;
    if(!db.prepare('SELECT 1 FROM task_watchdog_digests WHERE slot=?').get(slot))
      db.prepare('INSERT OR IGNORE INTO task_watchdog_digests VALUES(?,?,?)').run(slot,JSON.stringify(digest()),new Date(now()).toISOString());
    return slot;
  }
  async function audit() {
    if(running)return;running=true;
    try {
      const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok'}).format(now());
      if(db.prepare('SELECT 1 FROM task_watchdog_audits WHERE day=? LIMIT 1').get(day))return;
      const candidates=db.prepare('SELECT c.task_id,c.data FROM task_coordination c JOIN tasks t ON t.id=c.task_id WHERE t.is_deleted=0').all().filter(r=>['verified','accepted'].some(s=>JSON.parse(r.data).milestones?.[s]?.state==='confirmed'));
      for(let n=0;n<2&&candidates.length;n++) {
        const r=candidates.splice(random(candidates.length),1)[0], data=JSON.parse(r.data);let result='ok';
        try {if(data.milestones?.code?.state!=='confirmed'||data.milestones?.connected?.state!=='confirmed')throw Error();
          await verifier.code(data.milestones.code.evidence,{merged:true});await verifier.connected(data.milestones.connected.evidence);
        }catch {result='Тревога: доказательство или боевой коммит не подтверждены';}
        db.prepare('INSERT OR IGNORE INTO task_watchdog_audits VALUES(?,?,?,?)').run(day,r.task_id,result,new Date(now()).toISOString());
      }
    } finally {running=false;}
  }
  return {authorize,guard,report,snapshot,digest,audit,installGuards,prepareScheduledDigest,silence:t=>silence(db,t,now())};
}
module.exports={createTaskWatchdog,createEvidenceVerifier,silence,activity};

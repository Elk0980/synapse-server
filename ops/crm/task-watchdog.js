'use strict';
const {randomInt} = require('node:crypto');
const MINUTE=60000, stages=['code','connected','verified','accepted'];
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const key=s=>String(s||'').trim().toLocaleLowerCase('ru');
const table=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

// Отчёт считается относящимся к задаче только при явном #id и совпадении исполнителя.
function activity(db,row) {
  let last=Date.parse(row.created_at)||0;
  if(table(db,'task_watchdog_starts')) last=Math.max(last,db.prepare('SELECT at FROM task_watchdog_starts WHERE task_id=?').get(row.id)?.at||0);
  const executor=executorKey(db,row.assignee_name);
  if(executor&&table(db,'task_watchdog_reports'))last=Math.max(last,db.prepare('SELECT at FROM task_watchdog_reports WHERE task_id=? AND executor=?').get(row.id,executor)?.at||0);
  return last;
}
function executorKey(db,name) {
  if(/^person:[1-9][0-9]*$/.test(name||''))return name;
  if(!table(db,'agents'))return null;
  const r=db.prepare('SELECT id,name FROM agents').all().find(a=>key(a.name)===key(name));
  return r?`agent:${r.id}`:null;
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
    if(!healthUrl)return {status:'not_configured'};
    if(!/^[a-f0-9]{40}$/.test(sha))fail(422,'Нужен полный боевой коммит');
    const u=new URL(healthUrl);if(u.protocol!=='https:'||u.username||u.password)fail(503,'Некорректная настройка health');
    const r=await fetchImpl(u,{redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!r.ok)fail(422,'Боевой health недоступен');
    const body=await r.json();if(body.version!==sha)fail(422,'Версия на боевом не совпадает');return {sha};
  }
  return {code,connected,healthConfigured:!!healthUrl};
}

function createTaskWatchdog(db,{now=()=>Date.now(),principal=()=>null,verifier=createEvidenceVerifier(),random=randomInt,mode='observe'}={}) {
  if(!['observe','enforce'].includes(mode))fail(503,'Некорректный режим сторожа');
  db.exec(`CREATE TABLE IF NOT EXISTS task_watchdog_activity(task_id INTEGER PRIMARY KEY,at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS task_watchdog_audits(day TEXT NOT NULL,task_id INTEGER NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(day,task_id));
    CREATE TABLE IF NOT EXISTS task_watchdog_digests(slot TEXT PRIMARY KEY,data TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS watchdog_audit_no_update BEFORE UPDATE ON task_watchdog_audits BEGIN SELECT RAISE(ABORT,'Immutable watchdog audit'); END;
    CREATE TRIGGER IF NOT EXISTS watchdog_audit_no_delete BEFORE DELETE ON task_watchdog_audits BEGIN SELECT RAISE(ABORT,'Immutable watchdog audit'); END;`);
  db.exec(`CREATE TABLE IF NOT EXISTS task_watchdog_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_watchdog_reports(task_id INTEGER,executor TEXT,at INTEGER NOT NULL,PRIMARY KEY(task_id,executor));
    CREATE TABLE IF NOT EXISTS task_watchdog_starts(task_id INTEGER PRIMARY KEY,at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS task_watchdog_comment_auth(comment_id INTEGER PRIMARY KEY,task_id INTEGER,principal TEXT,kind TEXT,created_at TEXT);
    CREATE TABLE IF NOT EXISTS task_watchdog_proofs(task_id INTEGER,revision INTEGER,principal TEXT,data TEXT,created_at TEXT,PRIMARY KEY(task_id,revision));
    CREATE TABLE IF NOT EXISTS task_watchdog_acceptance(task_id INTEGER PRIMARY KEY,evidence TEXT,checked_at TEXT,principal TEXT);
    CREATE TABLE IF NOT EXISTS task_watchdog_no_code(task_id INTEGER PRIMARY KEY,principal TEXT);
    CREATE TABLE IF NOT EXISTS task_watchdog_observations(id INTEGER PRIMARY KEY,task_id INTEGER,reason TEXT,created_at TEXT);`);
  db.prepare("INSERT INTO task_watchdog_settings VALUES('mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(mode);
  // Включается после создания coordination. Не меняет старые done-записи.
  function installGuards() {
    for(const name of ['task_coordination_history','task_comments','task_watchdog_audits','task_watchdog_proofs','task_watchdog_comment_auth']) {
      if(!table(db,name))continue;
      const collision=['task_coordination_history','task_watchdog_proofs'].includes(name)?'task_id=NEW.task_id AND revision=NEW.revision':name==='task_watchdog_audits'?'day=NEW.day AND task_id=NEW.task_id':name==='task_watchdog_comment_auth'?'comment_id=NEW.comment_id':'id=NEW.id';
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${name}_watchdog_no_replace BEFORE INSERT ON ${name}
        WHEN EXISTS(SELECT 1 FROM ${name} WHERE ${collision}) BEGIN SELECT RAISE(ABORT,'Immutable watchdog history'); END;`);
    }
    for(const name of ['task_watchdog_proofs','task_watchdog_comment_auth'])for(const action of ['UPDATE','DELETE'])
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${name}_no_${action.toLowerCase()} BEFORE ${action} ON ${name} BEGIN SELECT RAISE(ABORT,'Immutable watchdog identity'); END;`);
    const allowedDone=`EXISTS(SELECT 1 FROM task_coordination c JOIN task_watchdog_acceptance a ON a.task_id=c.task_id WHERE c.task_id=NEW.id
      AND json_extract(c.data,'$.milestones.accepted.state')='confirmed' AND a.evidence=json_extract(c.data,'$.milestones.accepted.evidence') AND a.checked_at=json_extract(c.data,'$.milestones.accepted.checkedAt'))
      OR EXISTS(SELECT 1 FROM task_coordination c JOIN task_watchdog_no_code n ON n.task_id=c.task_id WHERE c.task_id=NEW.id
      AND json_extract(c.data,'$.codeRequired')=0 AND json_extract(c.data,'$.milestones.verified.state')='confirmed'
      AND EXISTS(SELECT 1 FROM task_watchdog_proofs v WHERE v.task_id=c.task_id AND json_extract(v.data,'$.verified.url')=json_extract(c.data,'$.milestones.verified.evidence'))
      AND EXISTS(SELECT 1 FROM task_watchdog_comment_auth a JOIN task_comments m ON m.id=a.comment_id WHERE a.task_id=NEW.id AND a.kind='vlad' AND length(trim(m.text))>0))`;
    db.exec(`DROP TRIGGER IF EXISTS watchdog_done_insert; DROP TRIGGER IF EXISTS watchdog_done_update;
      CREATE TRIGGER watchdog_done_insert BEFORE INSERT ON tasks WHEN NEW.status='done' AND (SELECT value FROM task_watchdog_settings WHERE key='mode')='enforce' AND NOT (${allowedDone})
      BEGIN SELECT RAISE(ABORT,'WATCHDOG_ACCEPTANCE_REQUIRED'); END;
      CREATE TRIGGER watchdog_done_update BEFORE UPDATE OF status ON tasks WHEN NEW.status='done' AND OLD.status<>'done' AND (SELECT value FROM task_watchdog_settings WHERE key='mode')='enforce' AND NOT (${allowedDone})
      BEGIN SELECT RAISE(ABORT,'WATCHDOG_ACCEPTANCE_REQUIRED'); END;`);
    if(db.prepare('PRAGMA table_info(tasks)').all().some(c=>c.name==='updated_at'))db.exec(`
      DROP TRIGGER IF EXISTS watchdog_start; CREATE TRIGGER watchdog_start AFTER UPDATE OF status ON tasks
      WHEN NEW.status='in_progress' AND OLD.status<>'in_progress'
      BEGIN INSERT INTO task_watchdog_starts(task_id,at) VALUES(NEW.id,CAST(unixepoch(NEW.updated_at,'subsec')*1000 AS INTEGER))
      ON CONFLICT(task_id) DO UPDATE SET at=excluded.at; END;`);
  }
  const permits=new WeakMap();
  const row=id=>db.prepare('SELECT * FROM tasks WHERE id=? AND is_deleted=0').get(id);
  const old=id=>JSON.parse(db.prepare('SELECT data FROM task_coordination WHERE task_id=?').get(id)?.data||'{}');
  const changed=(before,after)=>stages.filter(s=>JSON.stringify(before.milestones?.[s])!==JSON.stringify(after.milestones?.[s])&&after.milestones?.[s]?.state!=='pending');
  // Вызывается до SQLite-транзакции; principal проверен внутренним сервисным issuer.
  async function authorize(id,data,actor) {
    const t=row(id);if(!t)fail(404,'Задача не найдена');
    const baseline=JSON.stringify(old(id));
    const p=principal(actor), changes=changed(old(id),data);
    const noCodeChange=data.codeRequired===false&&old(id).codeRequired!==false;
    if(!changes.length&&!noCodeChange)return;
    if(!p)fail(403,'Подтверждение этапа ждёт доверенной идентификации исполнителя');
    if(noCodeChange&&p.kind!=='vlad')fail(403,'Задачу без кода объявляет Влад');
    const proofs={};
    for(const s of changes) {
      const item=data.milestones[s];
      if(item.state==='not_required'&&s==='code'&&data.codeRequired===false&&p.kind==='vlad'){proofs[s]={notRequired:true};continue;}
      if(item.state!=='confirmed')fail(403,'Исключение этапа требует отдельного решения Влада');
      if(s==='code') {if(!['agent','claude','release'].includes(p.kind)||p.key!==executorKey(db,t.assignee_name))fail(403,'Код подтверждает исполнитель');proofs[s]=await verifier.code(item.evidence);}
      if(s==='connected') {if(!['release','claude'].includes(p.kind))fail(403,'Подключение подтверждает выпускающий агент');proofs[s]=await verifier.connected(item.evidence);if(proofs[s].status==='not_configured')fail(503,'Боевой health не настроен');}
      if(s==='verified') {if(!((executorKey(db,t.reviewer_name)===p.key)||(key(t.reviewer_name)==='claude'&&p.kind==='claude')||(key(t.reviewer_name)==='влад'&&p.kind==='vlad'))||p.key===executorKey(db,t.assignee_name))fail(403,'Нужен независимый проверяющий');
        let proofUrl;try{proofUrl=new URL(item.evidence);}catch{}
        if(proofUrl?.protocol!=='https:'||proofUrl.username||proofUrl.password)fail(422,'Нужна HTTPS-ссылка на доказательство без учётных данных');proofs[s]={url:item.evidence};}
      if(s==='accepted'){if(p.kind!=='vlad')fail(403,'Принимает только Влад');proofs[s]={decision:true};}
    }
    permits.set(actor,{id,data:JSON.stringify(data),baseline,assignee:t.assignee_name,reviewer:t.reviewer_name,at:now(),principal:p,proofs});
  }
  function guard(id,data,actor) {
    const before=old(id);
    if(stages.some(s=>before.milestones?.[s]?.state==='confirmed'&&data.milestones?.[s]?.state!=='confirmed'))fail(403,'Нельзя удалить подтверждённый этап');
    const changes=changed(old(id),data);if(!changes.length&&!(data.codeRequired===false&&before.codeRequired!==false))return;
    const permit=permits.get(actor);permits.delete(actor);
    const t=row(id),current=principal(actor);
    if(!current||!permit||current.key!==permit.principal.key||permit.id!==id||permit.data!==JSON.stringify(data)||permit.baseline!==JSON.stringify(before)||
      permit.assignee!==t?.assignee_name||permit.reviewer!==t?.reviewer_name||
      data.executorName&&data.executorName!==t?.assignee_name||now()-permit.at>30000)fail(403,'Этап не подтверждён серверной проверкой');
    return permit;
  }
  function observe(id,error) {
    db.prepare('INSERT INTO task_watchdog_observations(task_id,reason,created_at) VALUES(?,?,?)').run(id,String(error.message).slice(0,500),new Date(now()).toISOString());
  }
  async function prepare(id,data,actor) {
    try{await authorize(id,data,actor);}catch(error){if(mode==='enforce')throw error;observe(id,error);}
  }
  const enforceGuard=guard;
  function check(id,data,actor) {
    try{return enforceGuard(id,data,actor);}catch(error){if(mode==='enforce')throw error;observe(id,error);return null;}
  }
  function record(id,revision,data,permit) {
    // Это производные разрешения, не журнал: отмена решения инвалидирует кеш.
    if(data.codeRequired!==false)db.prepare('DELETE FROM task_watchdog_no_code WHERE task_id=?').run(id);
    if(data.milestones.accepted?.state!=='confirmed')db.prepare('DELETE FROM task_watchdog_acceptance WHERE task_id=?').run(id);
    if(!permit)return;
    const p=permit.principal;
    db.prepare('INSERT INTO task_watchdog_proofs VALUES(?,?,?,?,?)').run(id,revision,p.key,JSON.stringify(permit.proofs),new Date(now()).toISOString());
    if(data.milestones.accepted?.state==='confirmed'&&p.kind==='vlad'&&permit.proofs.accepted)db.prepare('INSERT INTO task_watchdog_acceptance VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET evidence=excluded.evidence,checked_at=excluded.checked_at,principal=excluded.principal').run(id,data.milestones.accepted.evidence,data.milestones.accepted.checkedAt,p.key);
    if(data.codeRequired===false&&p.kind==='vlad')db.prepare('INSERT INTO task_watchdog_no_code VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET principal=excluded.principal').run(id,p.key);
  }
  function comment(id,commentId,actor) {
    const p=principal(actor);if(!p)return;
    db.prepare('INSERT INTO task_watchdog_comment_auth VALUES(?,?,?,?,?)').run(commentId,id,p.key,p.kind,new Date(now()).toISOString());
    if(p.key===executorKey(db,row(id).assignee_name))db.prepare('INSERT INTO task_watchdog_reports VALUES(?,?,?) ON CONFLICT(task_id,executor) DO UPDATE SET at=excluded.at').run(id,p.key,now());
  }
  function author(actor,fallback) {const p=principal(actor);return p?.name||fallback;}
  function report(name,event,codes,actor) {
    const p=principal(actor);const requested=executorKey(db,name);
    if(mode==='enforce'&&p?.kind!=='vlad'&&(!p||p.key!==requested))fail(403,'Отчёт может подавать только сам исполнитель');
    if(!p||p.key!==requested)return;
    for(const match of String(event).matchAll(/(?:#|№)\s*(\d+)\b/g)) {
      const t=row(Number(match[1]));if(t&&p.key===executorKey(db,t.assignee_name)&&codes.has(key(t.company_code)))
        db.prepare('INSERT INTO task_watchdog_reports VALUES(?,?,?) ON CONFLICT(task_id,executor) DO UPDATE SET at=excluded.at').run(t.id,p.key,now());
    }
  }
  function accept(id,data,actor) {
    const p=principal(actor);if(!p||p.kind!=='vlad'){if(mode==='enforce')fail(403,'Принимает только Влад');return;}
    permits.set(actor,{id,data:JSON.stringify(data),baseline:JSON.stringify(old(id)),assignee:row(id).assignee_name,reviewer:row(id).reviewer_name,at:now(),principal:p,proofs:{accepted:{decision:true}}});
  }
  function snapshot() {
    const tasks=db.prepare('SELECT * FROM tasks WHERE is_deleted=0').all(), alerts=[];
    for(const t of tasks) {
      const s=silence(db,t,now());if(s.no_report)alerts.push({task_id:t.id,kind:'silence',waiting_for:`ждёт исполнителя ${t.assignee_name||'не назначен'}`,minutes:s.silence_minutes,blocker:old(t.id).blocker||'Причина не указана'});
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
      const data=JSON.parse(h.data),attested=db.prepare('SELECT principal,data FROM task_watchdog_proofs WHERE task_id=? AND revision=?').get(t.id,h.revision);for(const stage of stages) {
        const item=data.milestones?.[stage];
        if(h.updated_at>=since&&item?.state==='confirmed'&&JSON.stringify(item)!==JSON.stringify(previous.milestones?.[stage]))events.push({task_id:t.id,stage,evidence:item.evidence,at:h.updated_at,actor:h.updated_by,trusted:!!JSON.parse(attested?.data||'{}')[stage],principal:attested?.principal||''});
      }previous=data;
    }}
    return {at:new Date(now()).toISOString(),delivery_enabled:false,mode,total:tasks.length,events,alerts,
      stalled:alerts.filter(a=>a.kind==='silence'&&a.minutes>=180),
      waiting_vlad:tasks.filter(t=>!['done','cancelled'].includes(t.status)&&/жд[её]т.*влад|ожида.*влад/i.test(old(t.id).blocker||'')).map(t=>({task_id:t.id,blocker:old(t.id).blocker})),
      observations:db.prepare('SELECT * FROM task_watchdog_observations ORDER BY id DESC LIMIT 20').all(),
      audits:db.prepare('SELECT * FROM task_watchdog_audits ORDER BY created_at DESC LIMIT 20').all()};
  }
  function digest() {
    const s=snapshot(),lines=[`Сводка доски · ${new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Bangkok',dateStyle:'short',timeStyle:'short'}).format(now())} (Бангкок)`,
      `Задач в базе: ${s.total}. Отметок этапов за сутки: ${s.events.length}; удостоверены сторожем: ${s.events.filter(e=>e.trusted).length}.`,
      ...s.events.map(e=>`№${e.task_id} · ${e.stage} (${e.trusted?'подтверждено сторожем':'историческая/не удостоверенная запись'}): ${e.evidence}`),
      `Подключений, удостоверенных сторожем: ${s.events.filter(e=>e.stage==='connected'&&e.trusted).length}; прежних/не удостоверенных отметок: ${s.events.filter(e=>e.stage==='connected'&&!e.trusted).length}.`,
      `Тишина от 3 часов: ${s.stalled.length}.`,...s.stalled.map(a=>`№${a.task_id} · ${a.minutes} мин · ${a.waiting_for} · ${a.blocker}`),
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
        try {if(verifier.healthConfigured===false){result='Пропуск: health не настроено';}else {if(data.milestones?.code?.state!=='confirmed'||data.milestones?.connected?.state!=='confirmed')throw Error();
          await verifier.code(data.milestones.code.evidence,{merged:true});await verifier.connected(data.milestones.connected.evidence);}
        }catch {result='Тревога: доказательство или боевой коммит не подтверждены';}
        db.prepare('INSERT OR IGNORE INTO task_watchdog_audits VALUES(?,?,?,?)').run(day,r.task_id,result,new Date(now()).toISOString());
      }
    } finally {running=false;}
  }
  return {authorize,prepare,guard:check,record,comment,author,accept,report,canGrant:actor=>principal(actor)?.kind==='vlad',mode,snapshot,digest,audit,installGuards,prepareScheduledDigest,silence:t=>silence(db,t,now())};
}
module.exports={createTaskWatchdog,createEvidenceVerifier,silence,activity};

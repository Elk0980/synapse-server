'use strict';
// №142: правила доски как механизм сервера. Три проверки: якорь «Сэр · правила · код»,
// «проверено» только с доказательством от другого, поля постановки при создании задачи.
// Режим наследуется от сторожа: observe — считать, сколько было бы отклонено; enforce — отклонять.
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const key=s=>String(s||'').trim().toLocaleLowerCase('ru');
const table=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const ANCHOR=/^\s*сэр\s*[·•:\-–—]?\s*правила\s*([0-9a-zа-я.\-_]+)\s*[·•:\-–—]?\s*код\s*([0-9a-f]{8})(?![0-9a-f])/iu;
const CODE_LENGTH=8;
const STRUCTURAL=/^\s*(цель|модуль)\s*[·•:]/iu;

function parseAnchor(text) {
  const m=ANCHOR.exec(String(text||'').split('\n')[0]||'');
  return m?{version:m[1],code:m[2].toLowerCase()}:null;
}
function currentRules(db) {
  if(!table(db,'task_watchdog_settings'))return null;
  const rows=Object.fromEntries(db.prepare("SELECT key,value FROM task_watchdog_settings WHERE key IN ('rules_revision','rules_version','rules_at')").all().map(r=>[r.key,r.value]));
  return rows.rules_revision?{revision:rows.rules_revision,code:rows.rules_revision.slice(0,CODE_LENGTH),version:rows.rules_version||'',at:rows.rules_at||''}:null;
}
function executorKey(db,name) {
  if(/^person:[1-9][0-9]*$/.test(name||''))return name;
  if(!table(db,'agents'))return null;
  const r=db.prepare('SELECT id,name FROM agents').all().find(a=>key(a.name)===key(name));
  return r?`agent:${r.id}`:null;
}
// Якорь считается якорем исполнителя, если его написал исполнитель задачи (по имени автора
// либо по удостоверенной личности комментария). Проверяется только первая строка комментария.
function anchorStatus(db,row) {
  const rules=currentRules(db);
  if(!table(db,'task_comments'))return {state:rules?'missing':'unknown',code:'',version:'',current:rules?.code||''};
  const executor=executorKey(db,row.assignee_name);
  const comments=db.prepare('SELECT id,author,text FROM task_comments WHERE task_id=? ORDER BY id').all(row.id);
  let found=null;
  for(const c of comments) {
    const a=parseAnchor(c.text);if(!a)continue;
    const auth=table(db,'task_watchdog_comment_auth')?db.prepare('SELECT principal FROM task_watchdog_comment_auth WHERE comment_id=? AND task_id=?').get(c.id,row.id):null;
    const byExecutor=key(c.author)===key(row.assignee_name)||(!!executor&&auth?.principal===executor);
    if(!byExecutor)continue;
    found={...a,comment_id:c.id};
    if(rules&&a.code===rules.code)break;
  }
  if(!rules)return {state:'unknown',code:found?.code||'',version:found?.version||'',current:''};
  if(!found)return {state:'missing',code:'',version:'',current:rules.code};
  return {state:found.code===rules.code?'ok':'stale',code:found.code,version:found.version,current:rules.code,comment_id:found.comment_id};
}
function anchorText(a) {
  if(a.state==='ok')return 'по правилам';
  if(a.state==='stale')return `код устарел (${a.code} → ${a.current})`;
  if(a.state==='unknown')return 'правила ещё не зарегистрированы сервером';
  return 'нет якоря «Сэр · правила · код»';
}
const urls=text=>String(text||'').split(/[\s,;()<>«»"']+/).filter(t=>/^https?:\/\/\S+$/i.test(t));
const paths=text=>String(text||'').split(/[\s,;()<>«»"']+/).filter(t=>/^https?:\/\/\S+$/i.test(t)||/[\\/]/.test(t)&&/\.(png|jpe?g|webp|gif|mp4|webm|pdf)$/i.test(t));
// Доказательство «проверено»: ссылка на живой экран (http) и два снимка с пометками 390 и 1440
// (ссылки либо пути к файлам). Возвращает список недостающего.
function verifiedEvidenceProblems(evidence) {
  const problems=[];
  if(!urls(evidence).length)problems.push('ссылку на живой экран (http…)');
  const shots=paths(evidence);
  if(!shots.some(p=>/390/.test(p)))problems.push('снимок экрана 390 (ссылка или путь с «390»)');
  if(!shots.some(p=>/1440/.test(p)))problems.push('снимок экрана 1440 (ссылка или путь с «1440»)');
  return problems;
}
function descriptionProblems(title,description) {
  if(STRUCTURAL.test(title||''))return [];
  const text=String(description||'');
  const problems=[];
  if(!/(^|\n)\s*точка\s*б\s*[:：]/iu.test(text))problems.push('«Точка Б: …» — как будет для человека');
  if(!/(^|\n)\s*шаги(\s+приёмки|\s+приемки)?\s*[:：]/iu.test(text))problems.push('«Шаги приёмки:» — 3–7 проверяемых шагов «[ ] …»');
  return problems;
}

function createTaskRules(db,{now=()=>Date.now(),principal=()=>null,mode='observe'}={}) {
  if(!['observe','enforce'].includes(mode))fail(503,'Некорректный режим правил');
  db.exec(`CREATE TABLE IF NOT EXISTS task_watchdog_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_watchdog_rules_log(id INTEGER PRIMARY KEY,task_id INTEGER,tool TEXT NOT NULL,rule TEXT NOT NULL,reason TEXT NOT NULL,mode TEXT NOT NULL,created_at TEXT NOT NULL);`);
  const stamp=()=>new Date(now()).toISOString();
  const exempt=actor=>principal(actor)?.kind==='vlad';
  // Версия правил приходит только из session_start сервиса tasks-mcp вместе с текстом правил.
  function seen(args) {
    const revision=String(args?.rules_revision||'').toLowerCase(), version=String(args?.rules_version||'').trim();
    if(!/^[0-9a-f]{64}$/.test(revision)||version.length>200)return null;
    const upsert=db.prepare('INSERT INTO task_watchdog_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    upsert.run('rules_revision',revision);upsert.run('rules_version',version);upsert.run('rules_at',stamp());
    return currentRules(db);
  }
  function reject(taskId,tool,rule,status,message) {
    db.prepare('INSERT INTO task_watchdog_rules_log(task_id,tool,rule,reason,mode,created_at) VALUES(?,?,?,?,?,?)').run(taskId,tool,rule,message.slice(0,500),mode,stamp());
    if(mode==='enforce')fail(status,message);
  }
  // Проверка 3: постановка задачи. Вызывается до вставки строки.
  function beforeCreate(args,actor) {
    if(exempt(actor))return;
    const problems=descriptionProblems(args.title,args.description);
    if(!problems.length)return;
    reject(null,'task_create','fields',422,`Задача не поставлена: в описании нет ${problems.join(' и ')}. Добавьте эти строки и повторите task_create.`);
  }
  // Проверки 1 и 2: стадии и статус. row — строка задачи, before/after — карточки координации.
  function beforeUpdate(row,{before,after,status},actor) {
    if(exempt(actor))return;
    const p=principal(actor);
    const changes=['code','connected','verified','accepted'].filter(s=>after?.milestones?.[s]?.state==='confirmed'&&before?.milestones?.[s]?.state!=='confirmed');
    if(changes.some(s=>['code','connected','verified'].includes(s))) {
      const a=anchorStatus(db,row);
      if(a.state==='unknown')reject(row.id,'task_update','anchor',409,'Сервер ещё не получил текущую версию правил: выполните session_start, затем повторите.');
      else if(a.state!=='ok')reject(row.id,'task_update','anchor',409,`Стадия не принята: в задаче №${row.id} ${anchorText(a)}. Исполнитель пишет первым комментарием «Сэр · правила <версия> · код ${a.current}» (код выдаёт session_start) и повторяет запрос.`);
    }
    if(changes.includes('verified')) {
      const executor=executorKey(db,row.assignee_name);
      if(p&&executor&&p.key===executor||key(row.reviewer_name)&&key(row.reviewer_name)===key(row.assignee_name))
        reject(row.id,'task_update','verified_by',409,'«Проверено» ставит другой агент, не исполнитель.');
      const problems=verifiedEvidenceProblems(after.milestones.verified.evidence);
      if(problems.length)reject(row.id,'task_update','verified_evidence',409,`«Проверено» без доказательства: в evidence нужны ${problems.join(', ')}.`);
    }
    if(status==='done'&&after?.codeRequired!==false&&after?.milestones?.verified?.state!=='confirmed')
      reject(row.id,'task_update','done',409,`Готово без «проверено»: сначала другой агент ставит стадию verified с доказательством (задача №${row.id}).`);
  }
  function summary(sinceMs) {
    const since=new Date(sinceMs).toISOString();
    const log=db.prepare('SELECT * FROM task_watchdog_rules_log WHERE created_at>=? ORDER BY id DESC LIMIT 50').all(since);
    const rules=currentRules(db);
    const open=table(db,'tasks')?db.prepare("SELECT * FROM tasks WHERE is_deleted=0 AND status='in_progress'").all():[];
    const anchors=open.map(t=>({task_id:t.id,executor:t.assignee_name,...anchorStatus(db,t)}));
    return {mode,current:rules?{version:rules.version,code:rules.code,at:rules.at}:null,
      compliant:anchors.filter(a=>a.state==='ok'),non_compliant:anchors.filter(a=>a.state!=='ok').map(a=>({...a,text:anchorText(a)})),
      rejected:log.filter(r=>r.mode==='enforce'),would_reject:log.filter(r=>r.mode==='observe')};
  }
  function lines(s) {
    return [`Правила ${s.current?`${s.current.version||'?'} · код ${s.current.code}`:'не зарегистрированы (нужен session_start)'} · режим ${s.mode==='enforce'?'отказы включены':'наблюдение'}.`,
      `По правилам: ${s.compliant.length}. Не по правилам: ${s.non_compliant.length}.`,
      ...s.non_compliant.map(a=>`№${a.task_id} · ${a.text} · ${a.executor||'исполнитель не назначен'}`),
      `Отклонено бы (наблюдение, за сутки): ${s.would_reject.length}. Отклонено (отказы): ${s.rejected.length}.`,
      ...[...s.would_reject,...s.rejected].slice(0,20).map(r=>`${r.task_id?`№${r.task_id}`:'новая задача'} · ${r.tool} · ${r.reason}`)];
  }
  return {mode,seen,beforeCreate,beforeUpdate,summary,lines,current:()=>currentRules(db),anchor:row=>anchorStatus(db,row)};
}
module.exports={createTaskRules,parseAnchor,anchorStatus,currentRules,verifiedEvidenceProblems,descriptionProblems,anchorText};

'use strict';

// The existing dispatch queue remains canonical. Runs hold process identity and
// leases; an expired lease never proves that a local process has stopped.
const {randomUUID} = require('node:crypto');
const {validateAllowedPaths} = require('./agent-launch-scope');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEASE_MS = 120000;
const LIVE = new Set(['running', 'unknown']);
const METHODS = new Set(['agent_launch', 'agent_status', 'agent_message', 'agent_stop',
  'agent_worker_claim', 'agent_worker_update']);
const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
const clean = (value, max, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, 'Некорректное поле запуска');
  return value.trim();
};
const uuid = value => { if (!UUID.test(value || '')) fail(400, 'Некорректный идентификатор запуска'); return value; };
// Conservative code-only gate: production work needs a separately reviewed path.
function codeOnly(task) {
  // Strip only closed, familiar prohibitions/reports, never a whole sentence.
  // Thus "без merge; сделай deploy" still retains and rejects "deploy".
  const text = `${task.title}\n${task.description || ''}`
    .replace(/без\s+(?:merge|deploy)(?:\s*\/\s*(?:merge|deploy))?(?![\p{L}\p{N}_])/giu,'')
    .replace(/(?:merge|deploy)(?:\s*\/\s*(?:merge|deploy))?\s+запрещ[её]н(?:ы)?(?![\p{L}\p{N}_])/giu,'')
    .replace(/не\s+(?:делать|делай|делал|выполнять|выполняй|выполнял)\s+(?:merge|deploy)(?![\p{L}\p{N}_])/giu,'')
    .replace(/не\s+(?:трогать|трогай|трогал|трогали|менять|меняй|менял|меняли|изменять|изменяй|изменял|изменяли|обновлять|обновляй|обновлял|обновляли)\s+(?:боев[а-яё]*(?:\s+сервер)?|production|prod)(?![\p{L}\p{N}_])/giu,'')
    .replace(/(?:боев[а-яё]*(?:\s+сервер)?|production|prod)\s+не\s+(?:трогать|трогай|трогал|трогали|менять|меняй|менял|меняли|изменять|изменяй|изменял|изменяли|обновлять|обновляй|обновлял|обновляли)(?![\p{L}\p{N}_])/giu,'');
  return !/(?:production|(?<![\p{L}\p{N}_])[pр][rг][oо0][dд](?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])прод(?:акш[её]?[нм][а-яё]*|уктив[а-яё]*|ов[а-яё]*)?(?![\p{L}\p{N}_])|боев[а-яё]*|депло[йя][а-яё]*|разв[её]ртыван[а-яё]*|\bdeploy\b|\bmerge\b|слияние\s+(?:в|с)\s+main|\bgit\s+push\s+(?:[^\r\n;]*?\s)?(?:origin\s+)?(?:main|master|HEAD:main|HEAD:master|HEAD:refs\/heads\/(?:main|master))\b|(?:выкат[а-яё]*|выкач[а-яё]*|зал(?:ей|ить|ива[а-яё]*)|загруз[а-яё]*|установ[а-яё]*|постав[а-яё]*|обнов[а-яё]*)\s+(?:(?:на|в)\s+)?(?:сервер|server)|\b(?:roll\s*out|release|ship|upload|install|update)\s+(?:to\s+)?(?:the\s+)?server\b)/iu.test(text);
}
function safeLog(value) {
  return value.replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/\b(?:Bearer\s+|sk-(?:proj-)?)[A-Za-z0-9_./+=-]+/gi, '[REDACTED]')
    .replace(/((?:token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function createAgentLaunch(db, {coordination, now = Date.now} = {}) {
  if (!coordination) throw new Error('Нужна существующая координация задач');
  db.exec(`CREATE TABLE IF NOT EXISTS task_dispatch_agent_runs (
    run_id TEXT PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), company_code TEXT NOT NULL,
    owner_id INTEGER NOT NULL, executor_profile TEXT NOT NULL, branch TEXT NOT NULL,
    state TEXT NOT NULL, stop_requested INTEGER NOT NULL DEFAULT 0,
    worker_id TEXT NOT NULL DEFAULT '', lease_token TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0,
    session_id TEXT NOT NULL DEFAULT '', message_id INTEGER, log_tail TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '', exit_code INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS task_dispatch_agent_active_task ON task_dispatch_agent_runs(task_id)
      WHERE state IN ('queued','running','unknown','waiting');
    CREATE TABLE IF NOT EXISTS task_dispatch_agent_requests (
      owner_id INTEGER NOT NULL, client_ref TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES task_dispatch_agent_runs(run_id),
      action TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', PRIMARY KEY(owner_id,client_ref));
    CREATE TABLE IF NOT EXISTS task_dispatch_agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES task_dispatch_agent_runs(run_id),
      text TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS task_dispatch_agent_message_immutable_update BEFORE UPDATE ON task_dispatch_agent_messages
      BEGIN SELECT RAISE(ABORT,'Immutable agent message'); END;
    CREATE TRIGGER IF NOT EXISTS task_dispatch_agent_message_immutable_delete BEFORE DELETE ON task_dispatch_agent_messages
      BEGIN SELECT RAISE(ABORT,'Immutable agent message'); END;`);
  // Old runs were created without explicit code-only or file-scope consent.
  // Additions must never authorize them by inferring intent from their text.
  const columns = new Set(db.prepare('PRAGMA table_info(task_dispatch_agent_runs)').all().map(column => column.name));
  if (!columns.has('code_only')) db.exec('ALTER TABLE task_dispatch_agent_runs ADD COLUMN code_only INTEGER NOT NULL DEFAULT 0 CHECK(code_only IN (0,1))');
  if (!columns.has('allowed_paths')) db.exec("ALTER TABLE task_dispatch_agent_runs ADD COLUMN allowed_paths TEXT NOT NULL DEFAULT '[]'");
  db.exec(`CREATE TRIGGER IF NOT EXISTS task_dispatch_agent_scope_immutable BEFORE UPDATE OF code_only,allowed_paths ON task_dispatch_agent_runs
    WHEN NEW.code_only<>OLD.code_only OR NEW.allowed_paths<>OLD.allowed_paths
    BEGIN SELECT RAISE(ABORT,'Immutable agent scope'); END;`);
  const stamp = () => new Date(now()).toISOString();
  const tx = fn => {
    const own = !db.isTransaction;
    if (own) db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); if (own) db.exec('COMMIT'); return value; }
    catch (error) { if (own) db.exec('ROLLBACK'); throw error; }
  };
  const scope = actor => {
    if (actor?.role !== 'owner' || !Number.isSafeInteger(actor.userId) || actor.userId < 1) fail(403, 'Запуск доступен владельцу');
    return new Set([...((actor.companyCodes instanceof Set || Array.isArray(actor.companyCodes)) ? actor.companyCodes : [])]
      .map(code => String(code).trim().toLowerCase()));
  };
  const task = (id, actor) => {
    const codes = scope(actor);
    if (!Number.isSafeInteger(id) || id < 1) fail(400, 'Некорректная задача');
    const row = db.prepare('SELECT * FROM tasks WHERE id=? AND is_deleted=0').get(id);
    if (!row || !codes.has(row.company_code.toLowerCase())) fail(404, 'Задача не найдена');
    return row;
  };
  const raw = id => db.prepare('SELECT * FROM task_dispatch_agent_runs WHERE run_id=?').get(id);
  const approvedScope = row => {
    if (row.code_only !== 1) return null;
    try { return validateAllowedPaths(JSON.parse(row.allowed_paths)); } catch { return null; }
  };
  const safeTask = row => codeOnly({title:row.title,description:[row.description || '',
    db.prepare('SELECT source_note FROM task_dispatch_mirrors WHERE task_id=?').get(row.id)?.source_note || '',
    ...db.prepare('SELECT text FROM task_comments WHERE task_id=? ORDER BY id').all(row.id).map(comment => comment.text)].join('\n')});
  const run = (id, actor) => {
    scope(actor); uuid(id);
    const row = raw(id);
    if (!row || row.owner_id !== actor.userId) fail(404, 'Запуск не найден');
    task(row.task_id, actor);
    return row;
  };
  const view = row => ({run_id:row.run_id, task_id:row.task_id, company_code:row.company_code,
    code_only:row.code_only === 1,allowed_paths:approvedScope(row) || [],
    executor_profile:row.executor_profile, branch:row.branch, state:row.state,
    stop_requested:Boolean(row.stop_requested), session_id:row.session_id,
    chat:row.session_id ? `codex://threads/${row.session_id}` : `synapse-agent:${row.run_id}`,
    log_tail:row.log_tail, summary:row.summary, exit_code:row.exit_code,
    created_at:row.created_at, updated_at:row.updated_at});
  const patch = (id, data) => db.prepare(`UPDATE task_dispatch_agent_runs SET ${Object.keys(data).map(key => `${key}=?`).join(',')},updated_at=? WHERE run_id=?`)
    .run(...Object.values(data),stamp(),id);
  const agentName = row => `Codex — задача #${row.task_id}`;
  const currentRun = row => db.prepare('SELECT run_id FROM task_dispatch_agent_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(row.task_id)?.run_id === row.run_id;
  const ownsDispatch = (row, dispatch = db.prepare('SELECT * FROM task_dispatch WHERE task_id=?').get(row.task_id)) =>
    currentRun(row) && dispatch?.company_code === row.company_code && dispatch.state.startsWith('agent_');
  function report(row, actor, message) {
    coordination.tool('agent_report', {agent:agentName(row),kind:'codex',mode:'once',
      function:'Локальная работа в git worktree; PR без merge/deploy',
      chat:row.session_id ? `codex://threads/${row.session_id}` : `synapse-agent:${row.run_id}`,
      state:row.state === 'running' ? 'work' : row.state === 'unknown' ? 'unknown' : row.state === 'failed' ? 'error' : row.state === 'stopped' ? 'idle' : 'wait',
      last_event:message},actor);
  }
  function audit(row, actor, note) {
    const dispatch = db.prepare('SELECT * FROM task_dispatch WHERE task_id=?').get(row.task_id);
    const owned = ownsDispatch(row,dispatch);
    const message = `[agent ${row.run_id}] ${note}${owned ? '' : ' Внешний этап диспетчера сохранён; запуск не владеет этой очередью.'}`;
    coordination.tool('task_comment', {task_id:row.task_id,author:'Система запуска агентов',text:message},actor);
    if (owned) {
      db.prepare(`UPDATE task_dispatch SET state=?,revision=revision+1,updated_at=? WHERE task_id=?`)
        .run(`agent_${row.state}`,stamp(),row.task_id);
      db.prepare(`INSERT INTO task_dispatch_history(task_id,revision,state,note,created_at)
        VALUES(?,?,?,?,?)`).run(row.task_id,dispatch.revision+1,`agent_${row.state}`,message,stamp());
    }
    if (currentRun(row)) report(row,actor,note);
  }
  function reconcile(actor) {
    const codes = scope(actor);
    for (const row of db.prepare("SELECT * FROM task_dispatch_agent_runs WHERE owner_id=? AND state IN ('queued','running','unknown','waiting')").all(actor.userId)) {
      if (!codes.has(row.company_code.toLowerCase())) continue;
      const current = db.prepare('SELECT * FROM tasks WHERE id=?').get(row.task_id);
      if (!current || current.is_deleted || current.company_code !== row.company_code || ['done','cancelled'].includes(current.status)) {
        // Do not report into another company's moved/deleted task. Preserve the
        // process reservation until its original worker confirms termination.
        patch(row.run_id, LIVE.has(row.state) ? {stop_requested:1} : {state:'stopped',stop_requested:1});
      } else if (!ownsDispatch(row)) {
        if (!row.stop_requested) {
          patch(row.run_id,LIVE.has(row.state) ? {stop_requested:1} : {state:'stopped',stop_requested:1});
          audit(raw(row.run_id),actor,'Очередь перешла другому этапу. Запрошена остановка локального запуска.');
        }
      } else if (!approvedScope(row) || !safeTask(current)) {
        const data = LIVE.has(row.state) ? {stop_requested:1} : {state:'failed',summary:'Исходная задача больше не проходит ограничение локального кода'};
        if (!row.stop_requested && row.state !== 'failed') {
          patch(row.run_id,data);
          audit(raw(row.run_id),actor,!approvedScope(row) ? 'Запуск без явного разрешения локального кода и области файлов остановлен.' : 'Изменённая задача остановлена ограничением локального кода.');
        }
      }
      // Stop requests and changed tasks do not prove process termination. A
      // disconnected stopping process becomes unknown while retaining its slot.
      const latest = raw(row.run_id);
      if (latest.state === 'running' && latest.lease_until <= now()) {
        patch(row.run_id,{state:'unknown'});
        const note = 'Связь с процессом потеряна. Автоповтор запрещён; слот сохранён до подтверждения остановки.';
        const visibleTask = current && !current.is_deleted && current.company_code === row.company_code && !['done','cancelled'].includes(current.status);
        if (visibleTask) audit(raw(row.run_id),actor,note);
        else report(raw(row.run_id),actor,note);
      }
    }
  }
  function request(args, actor, action, target, message = '') {
    if (args.client_ref === undefined) return null;
    const ref = clean(args.client_ref,200,true);
    const old = db.prepare('SELECT * FROM task_dispatch_agent_requests WHERE owner_id=? AND client_ref=?').get(actor.userId,ref);
    if (old && (old.action !== action || old.run_id !== target || old.text !== message)) fail(409,'client_ref уже использован для другого действия');
    return {ref,old};
  }
  function remember(req, actor, action, id, message = '') {
    if (req && !req.old) db.prepare('INSERT INTO task_dispatch_agent_requests VALUES(?,?,?,?,?)')
      .run(actor.userId,req.ref,id,action,message);
  }
  function launch(args, actor) {
    if (args.code_only !== true) fail(403,'Нужно явное code_only:true от оркестратора');
    const allowedPaths = validateAllowedPaths(args.allowed_paths), encodedPaths = JSON.stringify(allowedPaths);
    const t = task(args.task_id,actor);
    if ((args.executor_profile || 'codex-code') !== 'codex-code') fail(400,'Поддерживается только codex-code');
    const ref = args.client_ref === undefined ? null : clean(args.client_ref,200,true);
    const previous = ref && db.prepare('SELECT * FROM task_dispatch_agent_requests WHERE owner_id=? AND client_ref=?').get(actor.userId,ref);
    if (previous) {
      const old = run(previous.run_id,actor);
      if (previous.action !== 'launch' || old.task_id !== t.id) fail(409,'client_ref уже использован для другого действия');
      if (!approvedScope(old)) fail(403,'Старый запуск не имеет явного разрешения локального кода и области файлов');
      if (old.allowed_paths !== encodedPaths) fail(409,'Область файлов существующего запуска неизменяема');
      return {run:view(old),created:false};
    }
    if (['done','cancelled'].includes(t.status)) fail(409,'Задача закрыта');
    if (!safeTask(t)) fail(403,'Автоматически разрешён только локальный код. Указания о production/merge/deploy требуют отдельного проверенного пути.');
    const existing = db.prepare("SELECT * FROM task_dispatch_agent_runs WHERE task_id=? AND state IN ('queued','running','unknown','waiting')").get(t.id);
    if (existing) {
      const allowed = run(existing.run_id,actor);
      if (!approvedScope(allowed)) fail(403,'Старый запуск не имеет явного разрешения локального кода и области файлов');
      if (allowed.allowed_paths !== encodedPaths) fail(409,'Область файлов существующего запуска неизменяема');
      if (ref) remember({ref},actor,'launch',allowed.run_id);
      return {run:view(allowed),created:false};
    }
    const dispatch = db.prepare('SELECT * FROM task_dispatch WHERE task_id=?').get(t.id);
    if (dispatch) {
      const priorLocal = ['agent_failed','agent_stopped'].includes(dispatch.state) && db.prepare("SELECT 1 FROM task_dispatch_agent_runs WHERE task_id=? AND owner_id=? AND company_code=? AND state IN ('failed','stopped')").get(t.id,actor.userId,t.company_code);
      if (dispatch.state !== 'awaiting_executor' && !priorLocal) fail(409,'Существующий этап диспетчера нельзя заменять запуском агента');
    }
    if (!dispatch) db.prepare("INSERT INTO task_dispatch(task_id,company_code,state,created_at,updated_at) VALUES(?,?,'agent_queued',?,?)")
      .run(t.id,t.company_code,stamp(),stamp());
    const id = randomUUID(), branch = `codex/agent-task-${t.id}-${id.slice(0,8)}`;
    db.prepare(`INSERT INTO task_dispatch_agent_runs(run_id,task_id,company_code,owner_id,executor_profile,branch,state,created_at,updated_at,code_only,allowed_paths)
      VALUES(?,?,?,?,'codex-code',?,'queued',?,?,1,?)`).run(id,t.id,t.company_code,actor.userId,branch,stamp(),stamp(),encodedPaths);
    // The explicit, checked awaiting_executor transition is the only point at
    // which this run may acquire an existing non-agent queue row.
    db.prepare("UPDATE task_dispatch SET state='agent_queued' WHERE task_id=? AND state='awaiting_executor'").run(t.id);
    if (ref) remember({ref},actor,'launch',id);
    coordination.tool('task_update',{task_id:t.id,executor:agentName(raw(id))},actor);
    audit(raw(id),actor,'Запуск поставлен в существующую очередь dispatch; локальный процесс ещё не запущен.');
    return {run:view(raw(id)),created:true};
  }
  function message(args, actor) {
    const r = run(args.run_id,actor), text = clean(args.text,10000,true);
    if (!approvedScope(r)) fail(403,'Продолжение старого запуска без явного code_only и области файлов запрещено');
    if (!ownsDispatch(r)) fail(409,'Продолжение не владеет текущей очередью задачи');
    const req = request(args,actor,'message',r.run_id,text);
    if (req?.old) return {run:view(r),queued:false};
    if (!['waiting','failed'].includes(r.state) || !r.session_id || r.stop_requested) fail(409,'Продолжение доступно после завершения turn с сохранённым session_id');
    const t = task(r.task_id,actor);
    if (['done','cancelled'].includes(t.status) || !safeTask(t) || !codeOnly({title:text})) fail(403,'Продолжение выходит за разрешённый локальный код');
    const id = Number(db.prepare('INSERT INTO task_dispatch_agent_messages(run_id,text,created_at) VALUES(?,?,?)').run(r.run_id,text,stamp()).lastInsertRowid);
    patch(r.run_id,{state:'queued',message_id:id,worker_id:'',lease_token:'',lease_until:0,exit_code:null});
    remember(req,actor,'message',r.run_id,text);
    audit(raw(r.run_id),actor,`Продолжение ${id} поставлено в очередь для прежних session_id и worktree.`);
    return {run:view(raw(r.run_id)),queued:true,message_id:id};
  }
  function stop(args, actor) {
    const r = run(args.run_id,actor);
    if (r.stop_requested || r.state === 'stopped') return {run:view(r)};
    patch(r.run_id, LIVE.has(r.state) ? {stop_requested:1} : {stop_requested:1,state:'stopped'});
    audit(raw(r.run_id),actor,LIVE.has(r.state) ? 'Запрошена остановка. Слот сохраняется до подтверждения завершения процесса.' : 'Остановлен запуск без живого процесса.');
    return {run:view(raw(r.run_id))};
  }
  function claim(args, actor) {
    uuid(args.worker_id);
    const codes = [...scope(actor)];
    if (!codes.length) return {job:null};
    const live = db.prepare("SELECT count(*) n FROM task_dispatch_agent_runs WHERE state IN ('running','unknown')").get().n;
    if (live >= 3) return {job:null};
    const r = db.prepare(`SELECT r.* FROM task_dispatch_agent_runs r JOIN tasks t ON t.id=r.task_id
      WHERE r.owner_id=? AND r.state='queued' AND r.code_only=1 AND r.stop_requested=0 AND t.is_deleted=0
      AND t.status NOT IN ('done','cancelled') AND t.company_code=r.company_code
      AND lower(r.company_code) IN (${codes.map(()=>'?').join(',')}) ORDER BY r.created_at,r.run_id LIMIT 1`).get(actor.userId,...codes);
    if (!r) return {job:null};
    const allowedPaths = approvedScope(r);
    if (!allowedPaths) { patch(r.run_id,{state:'failed',summary:'Нет явного разрешения локального кода и области файлов'});audit(raw(r.run_id),actor,'Запуск без разрешённой области файлов отклонён.');return {job:null}; }
    const t = task(r.task_id,actor);
    if (!safeTask(t)) { patch(r.run_id,{state:'failed',summary:'Изменённая задача не проходит ограничение локального кода'});audit(raw(r.run_id),actor,'Запуск отклонён после изменения исходной задачи.');return {job:null}; }
    const token = randomUUID(), until = now()+LEASE_MS;
    patch(r.run_id,{state:'running',worker_id:args.worker_id,lease_token:token,lease_until:until});
    audit(raw(r.run_id),actor,'Локальный обработчик забрал запуск. Ожидается подтверждение запуска codex exec.');
    const m = r.message_id ? db.prepare('SELECT * FROM task_dispatch_agent_messages WHERE id=? AND run_id=?').get(r.message_id,r.run_id) : null;
    const description = [t.description || '',db.prepare('SELECT source_note FROM task_dispatch_mirrors WHERE task_id=?').get(t.id)?.source_note || '']
      .filter(Boolean).join('\n').slice(0,20000);
    return {job:{run_id:r.run_id,task_id:r.task_id,company_code:r.company_code,executor_profile:r.executor_profile,
      code_only:true,allowed_paths:allowedPaths,
      branch:r.branch,title:t.title,description,lease_token:token,lease_until:new Date(until).toISOString(),
      session_id:r.session_id,...(m ? {message_id:m.id,message:m.text} : {})}};
  }
  function update(args, actor) {
    // Worker acknowledgements remain possible after task closure/deletion/move,
    // but only within the ORIGINAL scope and with the original process lease.
    const codes = scope(actor), r = raw(uuid(args.run_id));
    uuid(args.worker_id); uuid(args.lease_token);
    if (!r || r.owner_id !== actor.userId || !codes.has(r.company_code.toLowerCase()) ||
      r.worker_id !== args.worker_id || r.lease_token !== args.lease_token) fail(409,'Аренда запуска недействительна');
    const events = ['heartbeat','started','complete','failed','stopped'];
    if (!events.includes(args.event)) fail(400,'Неизвестное событие запуска');
    if (args.session_id !== undefined) uuid(args.session_id);
    if (r.session_id && args.session_id && r.session_id !== args.session_id) fail(409,'Нельзя заменить контекст запуска');
    const terminal = {complete:'waiting',failed:'failed',stopped:'stopped'}[args.event];
    if (!LIVE.has(r.state)) {
      if (r.state === terminal || args.event === 'heartbeat') return {run:view(r)};
      fail(409,'Turn запуска уже завершён');
    }
    const fields = {};
    if (args.session_id) fields.session_id=args.session_id;
    if (args.log_tail !== undefined) fields.log_tail=safeLog(clean(args.log_tail,8000));
    if (args.summary !== undefined) fields.summary=safeLog(clean(args.summary,4000));
    if (args.exit_code !== undefined) {
      if (!Number.isSafeInteger(args.exit_code) || args.exit_code < -2147483648 || args.exit_code > 2147483647) fail(400,'Некорректный код процесса');
      fields.exit_code=args.exit_code;
    }
    const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(r.task_id);
    const validTask = t && !t.is_deleted && t.company_code === r.company_code && !['done','cancelled'].includes(t.status);
    if (!validTask) fields.stop_requested=1;
    if (terminal) {
      fields.state = r.stop_requested || !validTask ? 'stopped' : terminal;
      fields.lease_until=0;
      if (args.event === 'stopped') fields.stop_requested=1;
    } else {
      fields.state='running'; fields.lease_until=now()+LEASE_MS;
    }
    patch(r.run_id,fields);
    const next = raw(r.run_id);
    if (validTask && (terminal || (args.event === 'started' && (!r.session_id || r.state === 'unknown')))) {
      if (args.event === 'started' && !next.stop_requested && ownsDispatch(next)) coordination.tool('task_update',{task_id:r.task_id,status:'in_progress'},actor);
      audit(next,actor,terminal ? `Turn завершён: ${next.state}; ${next.summary || 'результат ожидает проверки'}` : 'codex exec запущен; контекст зарегистрирован.');
    } else if (validTask) report(next,actor,r.stop_requested ? 'Ожидается подтверждение остановки процесса.' : 'Heartbeat локального процесса получен.');
    return {run:view(next)};
  }
  function tool(name, args, actor) {
    scope(actor);
    if (!METHODS.has(name)) fail(404,'Инструмент запуска не найден');
    if (!args || typeof args !== 'object' || Array.isArray(args)) fail(400,'Нужен объект параметров');
    return tx(() => {
      reconcile(actor);
      if (name === 'agent_launch') return launch(args,actor);
      if (name === 'agent_message') return message(args,actor);
      if (name === 'agent_stop') return stop(args,actor);
      if (name === 'agent_worker_claim') return claim(args,actor);
      if (name === 'agent_worker_update') return update(args,actor);
      return {run:view(run(args.run_id,actor))};
    });
  }
  return {tool};
}

module.exports = {createAgentLaunch,AGENT_LAUNCH_METHODS:METHODS,codeOnly};

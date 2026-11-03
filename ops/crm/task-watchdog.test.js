'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createTaskWatchdog,createEvidenceVerifier,silence}=require('./task-watchdog');
const {createTaskCoordination}=require('./task-coordination');
const sha='a'.repeat(40), url='https://github.com/Elk0980/synapse-server/pull/12';
function fixture(t,{trusted=false,verifier}={}) {
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const clock={value:Date.parse('2026-11-03T17:00:00Z')};
 db.exec(`CREATE TABLE tasks(id INTEGER PRIMARY KEY,title TEXT,company_code TEXT,status TEXT,assignee_name TEXT,reviewer_name TEXT,created_at TEXT,is_deleted INTEGER DEFAULT 0);
 INSERT INTO tasks VALUES(1,'Old','synapse-business','in_progress','Codex','Reviewer','2026-11-03T17:00:00Z',0);
 CREATE TABLE task_comments(id INTEGER PRIMARY KEY,task_id INTEGER,author TEXT,text TEXT,created_at TEXT);`);
 const watchdog=createTaskWatchdog(db,{now:()=>clock.value,principal:a=>trusted?a.trusted:null,verifier,random:()=>0});
 const api=createTaskCoordination(db,{now:()=>clock.value,watchdog});watchdog.installGuards();
 // Tiny fixture is deliberately not MCP-schema complete; test policy below directly.
 return {db,clock,watchdog,api};
}
const proof=(stage='code',evidence=url)=>({milestones:{[stage]:{state:'confirmed',evidence,checkedAt:'2026-11-03T17:00:00Z'}}});
test('45 minute threshold, restart and 3h digest use actual reports, not metadata',t=>{
 const {db,clock,watchdog}=fixture(t);let row=db.prepare('SELECT * FROM tasks').get();
 clock.value+=45*60000-1;assert.equal(watchdog.silence(row).no_report,false);
 clock.value++;assert.equal(watchdog.silence(row).no_report,true);
 clock.value+=135*60000;assert.equal(watchdog.digest().stalled.length,1);
 db.prepare('INSERT INTO task_comments VALUES(1,1,?,?,?)').run('Claude','Статус',new Date(clock.value).toISOString());
 assert.equal(watchdog.silence(row).no_report,true);
 db.prepare('INSERT INTO task_comments VALUES(2,1,?,?,?)').run('Codex','Результат теста',new Date(clock.value).toISOString());
 assert.equal(watchdog.silence(row).no_report,false);
 assert.equal(createTaskWatchdog(db,{now:()=>clock.value}).snapshot().alerts.length,0);
});
test('report explicitly references task and scope; heartbeat cannot refresh unrelated work',t=>{
 const {db,clock,watchdog}=fixture(t);clock.value+=60*60000;
 watchdog.report('Codex','Работаю',new Set(['synapse-business']));assert.equal(watchdog.snapshot().alerts.length,1);
 watchdog.report('Codex','#1 проверено',new Set(['other']));assert.equal(watchdog.snapshot().alerts.length,1);
 watchdog.report('Other','#1 проверено',new Set(['synapse-business']));assert.equal(watchdog.snapshot().alerts.length,1);
 watchdog.report('Codex','№1 тест выполнен',new Set(['synapse-business']));assert.equal(watchdog.snapshot().alerts.length,0);
});
test('shared Owner identity and arbitrary author cannot authorize stages',async t=>{
 const {watchdog}=fixture(t);
 await assert.rejects(watchdog.authorize(1,proof(),{role:'owner',userId:1,userName:'Влад',trusted:{kind:'vlad'}}),/идентификации/);
 assert.throws(()=>watchdog.guard(1,proof(),{}),/серверной/);
});
test('roles, one-use permit, body binding and stale permit',async t=>{
 const verifier={code:async()=>({sha}),connected:async()=>({sha})};
 const {watchdog,clock}=fixture(t,{trusted:true,verifier});
 const a={trusted:{kind:'executor',name:'Codex'}},data=proof();
 await assert.rejects(watchdog.authorize(1,proof('connected',sha),a),/выпускающий/);
 await assert.rejects(watchdog.authorize(1,proof('accepted','yes'),a),/Влад/);
 await assert.rejects(watchdog.authorize(1,proof('verified','https://test.example/proof'),a),/независимый/);
 await watchdog.authorize(1,data,a);watchdog.guard(1,data,a);assert.throws(()=>watchdog.guard(1,data,a));
 await watchdog.authorize(1,data,a);assert.throws(()=>watchdog.guard(1,proof('code','fake'),a));
 await watchdog.authorize(1,data,a);clock.value+=30001;assert.throws(()=>watchdog.guard(1,data,a));
});
test('done rejected in legacy SQL and inserts, old rows/history preserved, REPLACE rejected',t=>{
 const {db}=fixture(t);
 assert.throws(()=>db.exec("UPDATE tasks SET status='done' WHERE id=1"),/ACCEPTANCE/);
 assert.throws(()=>db.exec("INSERT INTO tasks(id,status) VALUES(2,'done')"),/ACCEPTANCE/);
 db.exec("INSERT INTO task_coordination_history VALUES(1,1,'{}','now',1)");
 assert.throws(()=>db.exec("INSERT OR REPLACE INTO task_coordination_history VALUES(1,1,'{}','later',2)"),/Immutable/);
 assert.throws(()=>db.exec("DELETE FROM task_coordination_history"),/Immutable/);
 assert.throws(()=>db.exec("UPDATE task_coordination_history SET data='{}'"),/Immutable/);
 assert.equal(db.prepare('SELECT updated_at FROM task_coordination_history').get().updated_at,'now');
});
test('30 minute unanswered question creates reminder data; explicit reply clears it',t=>{
 const {db,clock,watchdog}=fixture(t);
 db.exec("INSERT INTO task_comments VALUES(1,1,'Codex','ВОПРОС → Claude: решение?','2026-11-03T17:00:00Z')");
 clock.value+=30*60000;assert.equal(watchdog.snapshot().alerts[0].kind,'question');
 db.exec("INSERT INTO task_comments VALUES(2,1,'Claude','ОТВЕТ → Codex: решение','2026-11-03T17:30:00Z')");
 assert.equal(watchdog.snapshot().alerts.length,0);
});
test('digest counts stage transitions, not repeated snapshots',t=>{
 const {db,watchdog}=fixture(t);
 const data=JSON.stringify(proof());db.prepare('INSERT INTO task_coordination_history VALUES(1,1,?,?,1)').run(data,'2026-11-03T16:00:00Z');
 db.prepare('INSERT INTO task_coordination_history VALUES(1,2,?,?,1)').run(data,'2026-11-03T17:00:00Z');
 assert.equal(watchdog.digest().events.length,1);assert.equal(watchdog.digest().delivery_enabled,false);
});
test('daily sample persisted, outage creates alert, no blind repeats after restart',async t=>{
 let checks=0;const verifier={code:async()=>{checks++;throw Error('offline');}};
 const {db,clock,watchdog}=fixture(t,{verifier});
 const data={milestones:{code:{state:'confirmed',evidence:url},connected:{state:'confirmed',evidence:sha},verified:{state:'confirmed'}}};
 db.prepare('INSERT INTO task_coordination VALUES(1,1,?,?,1)').run(JSON.stringify(data),'now');
 await watchdog.audit();await watchdog.audit();assert.equal(checks,1);assert.match(watchdog.snapshot().audits[0].result,/Тревога/);
 await createTaskWatchdog(db,{now:()=>clock.value,verifier}).audit();assert.equal(checks,1);
});
function fakeApi({badCI=false,missing=false}={}) {
 const calls=[];return {calls,fetchImpl:async u=>{calls.push(String(u));return {ok:!missing,json:async()=>String(u).includes('/pulls/')?{state:'open',head:{sha}}:String(u).includes('/check-runs')?{total_count:1,check_runs:[{head_sha:sha,status:'completed',conclusion:badCI?'failure':'success'}]}:{total_count:0,statuses:[]}};}};
}
test('GitHub existence and exact-head CI checked; invented URLs, missing PR and red CI rejected',async()=>{
 const f=fakeApi(),v=createEvidenceVerifier(f);assert.equal((await v.code(url)).sha,sha);assert.equal(f.calls.length,3);
 await assert.rejects(v.code('https://evil.example/pr/1'),/ссылка/);
 await assert.rejects(createEvidenceVerifier(fakeApi({missing:true})).code(url),/GitHub/);
 await assert.rejects(createEvidenceVerifier(fakeApi({badCI:true})).code(url),/CI/);
 await assert.rejects(v.code(url,{merged:true}),/слит/);
});
test('health fetch uses configured URL only, exact version and no redirects',async()=>{
 const v=createEvidenceVerifier({healthUrl:'https://prod.example/health',fetchImpl:async(u,o)=>{assert.equal(String(u),'https://prod.example/health');assert.equal(o.redirect,'error');return {ok:true,json:async()=>({version:sha})};}});
 await v.connected(sha);await assert.rejects(v.connected('https://evil.example'),/коммит/);
 await assert.rejects(createEvidenceVerifier().connected(sha),/health/);
});

test('Bangkok schedule stores only one snapshot per morning/evening, no transport',t=>{
 const {db,clock,watchdog}=fixture(t);
 clock.value=Date.parse('2026-11-04T00:59:00Z');assert.equal(watchdog.prepareScheduledDigest(),undefined);
 clock.value+=60000;assert.equal(watchdog.prepareScheduledDigest(),'2026-11-04/08');
 watchdog.prepareScheduledDigest();assert.equal(db.prepare('SELECT count(*) n FROM task_watchdog_digests').get().n,1);
 clock.value=Date.parse('2026-11-04T13:00:00Z');assert.equal(watchdog.prepareScheduledDigest(),'2026-11-04/20');
 assert.equal(db.prepare('SELECT count(*) n FROM task_watchdog_digests').get().n,2);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve,relative}=require('node:path');
const {createSocialStats}=require('./social-stats');
const AT=Date.parse('2026-10-13T18:00:00Z'); // 11:00 Pacific, предыдущие сутки завершены.
const YESTERDAY='2026-10-12';
function setup(t,{filename=':memory:',closedStatus='partial',retryable=true}={}) {
  const h={time:AT,calls:[],closedStatus,retryable,revision:1};
  h.db=new DatabaseSync(filename);
  h.db.exec("CREATE TABLE IF NOT EXISTS companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,timezone TEXT,is_deleted INTEGER DEFAULT 0);INSERT OR IGNORE INTO companies VALUES(1,'demo-a','Тестовая компания','America/Los_Angeles',0)");
  h.adapter={connectionRevision:()=>({revision:h.revision}),revisesHistory:({platform})=>platform==='youtube',
    collect:async({platform,date,closed})=>{
      h.calls.push({platform,date,closed});
      return {status:closed?h.closedStatus:'ok',retryable:closed?h.retryable:false,
        missing:closed&&h.closedStatus!=='ok'?['суточные данные ещё не готовы']:['число подписчиков округлено источником'],
        snapshots:closed&&h.closedStatus!=='ok'?[{date,metric:'followers',period:'lifetime',value:136,sourceField:'synthetic.subscribers',completeness:'complete'}]:
          [{date,metric:'views',value:25,sourceField:'synthetic.views',completeness:'complete'}]};
    }};
  h.make=()=>createSocialStats(h.db,{now:()=>h.time,adapters:{direct:h.adapter},logger:{warn(){}}});
  h.stats=h.make();
  h.stats.saveAccounts('demo-a',{accounts:[{platform:'youtube',provider:'direct',accountRef:'UCabcdefghijklmnopqrstuv',timezone:'America/Los_Angeles',collectHour:6,revision:0}]});
  t.after(()=>{if(h.db)h.db.close();});
  h.yesterdayCalls=()=>h.calls.filter(c=>c.date===YESTERDAY);
  return h;
}

for(const [instant,yesterday] of [['2025-03-10T07:30:00Z','2025-03-09'],['2025-11-03T08:30:00Z','2025-11-02']])test('Pacific вчера по календарю после смены DST: '+instant,async t=>{
 const h=setup(t,{closedStatus:'ok',retryable:false});h.time=Date.parse(instant);
 h.stats.saveAccounts('demo-a',{accounts:[{platform:'youtube',provider:'direct',accountRef:'UCabcdefghijklmnopqrstuv',timezone:'America/Los_Angeles',collectHour:0,revision:1}]});
 await h.stats.collectDue();assert.equal(h.calls.find(c=>c.closed).date,yesterday);
});

test('неготовая вчерашняя статистика с lifetime аудитории соблюдает backoff, неизвестные views не становятся нулём',async t=>{
  const h=setup(t,{closedStatus:'failed'});await h.stats.collectDue();
  assert.equal(h.yesterdayCalls().length,1);
  const queue=h.stats.queuedDates('demo-a','youtube','UCabcdefghijklmnopqrstuv').find(q=>q.date===YESTERDAY);
  assert.equal(queue.attempts,1);assert.equal(Date.parse(queue.nextAttemptAt),AT+15*60000);
  for(let n=0;n<5;n++){h.time+=60000;await h.stats.collectDue();}
  assert.equal(h.yesterdayCalls().length,1);
  assert.equal(h.db.prepare("SELECT count(*) n FROM social_snapshots WHERE date=? AND metric='views'").get(YESTERDAY).n,0);
  h.time=AT+15*60000;await h.stats.collectDue();assert.equal(h.yesterdayCalls().length,2);
});

test('полный закрытый день с retryable:false не ставится в очередь из-за постоянного пояснения источника',async t=>{
  const h=setup(t,{closedStatus:'ok',retryable:false});await h.stats.collectDue();
  assert.equal(h.stats.queuedDates('demo-a','youtube','UCabcdefghijklmnopqrstuv').length,0);
  h.time+=20*60000;await h.stats.collectDue();assert.equal(h.yesterdayCalls().length,1);
  assert.equal(h.db.prepare("SELECT value FROM social_snapshots WHERE date=? AND metric='views'").get(YESTERDAY).value,25);
});

test('capability функции выбирает только YouTube для пересмотра истории и не меняет ВК',async t=>{
  const h=setup(t,{closedStatus:'ok',retryable:false});
  h.stats.saveAccounts('demo-a',{accounts:[{platform:'vk',provider:'direct',accountRef:'club123',timezone:'America/Los_Angeles',collectHour:6,revision:0}]});
  await h.stats.collect('demo-a','youtube',{date:'2026-10-10'});await h.stats.collect('demo-a','vk',{date:'2026-10-10'});
  h.time+=86400001;h.calls=[];await h.stats.collectDue();
  assert.equal(h.calls.filter(c=>c.platform==='youtube'&&c.date==='2026-10-10').length,1);
  assert.equal(h.calls.filter(c=>c.platform==='vk'&&c.date==='2026-10-10').length,0);
});

test('новая ревизия подключения не ждёт старого backoff',async t=>{
  const h=setup(t,{closedStatus:'failed'});await h.stats.collectDue();
  h.revision++;h.time+=60000;h.closedStatus='ok';h.retryable=false;
  await h.stats.collectDue();assert.equal(h.yesterdayCalls().length,2);
  assert.equal(h.stats.queuedDates('demo-a','youtube','UCabcdefghijklmnopqrstuv').find(q=>q.date===YESTERDAY),undefined);
});

test('исчерпанная очередь не запускает бесконечный новый цикл на каждом тике',async t=>{
  const h=setup(t,{closedStatus:'failed'});await h.stats.collectDue();
  h.db.prepare('UPDATE social_collect_queue SET attempts=6,next_attempt_at=? WHERE date=?').run(new Date(h.time).toISOString(),YESTERDAY);
  await h.stats.collectDue();const count=h.yesterdayCalls().length;
  assert.equal(count,2);assert.equal(h.stats.queuedDates('demo-a','youtube','UCabcdefghijklmnopqrstuv').some(q=>q.date===YESTERDAY),false);
  h.time+=60000;await h.stats.collectDue();assert.equal(h.yesterdayCalls().length,count);
});

test('ошибка транспорта тоже получает сохраняемый backoff, вместо запросов каждый тик',async t=>{
  const h=setup(t);h.adapter.collect=async ctx=>{h.calls.push(ctx);throw new Error('synthetic failure');};
  await h.stats.collectDue();assert.equal(h.yesterdayCalls().length,1);
  assert.equal(h.stats.queuedDates('demo-a','youtube','UCabcdefghijklmnopqrstuv').find(q=>q.date===YESTERDAY).attempts,1);
  h.time+=60000;await h.stats.collectDue();assert.equal(h.yesterdayCalls().length,1);
});

test('срок повторного сбора переживает закрытие и повторное открытие SQLite',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'synapse-youtube-queue-'));
  const h=setup(t,{filename:join(dir,'queue.sqlite'),closedStatus:'failed'});await h.stats.collectDue();
  t.after(()=>{const parent=resolve(tmpdir()),target=resolve(dir),rel=relative(parent,target);assert.ok(rel&&!rel.startsWith('..')&&!rel.includes(':')&&rel.startsWith('synapse-youtube-queue-'));rmSync(target,{recursive:true,force:true});});
  const before=h.stats.queuedDates('demo-a','youtube','UCabcdefghijklmnopqrstuv').find(q=>q.date===YESTERDAY);
  h.db.close();h.db=new DatabaseSync(join(dir,'queue.sqlite'));h.stats=h.make();
  h.time+=5*60000;await h.stats.collectDue();assert.equal(h.yesterdayCalls().length,1);
  assert.equal(h.stats.queuedDates('demo-a','youtube','UCabcdefghijklmnopqrstuv').find(q=>q.date===YESTERDAY).nextAttemptAt,before.nextAttemptAt);
  h.time=Date.parse(before.nextAttemptAt);await h.stats.collectDue();assert.equal(h.yesterdayCalls().length,2);
});

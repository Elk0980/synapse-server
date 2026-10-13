'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {createRevenueDirectSpendFacts}=require('./revenue-direct-spend-facts');
const {createDirectAdapter,directReportName,ENDPOINT,REPORT_TYPE}=require('./revenue-direct-adapter');

test('пробел внутри периода не отбрасывает валидные расходы других покрытых отрезков',()=>{
 const db=fixture({reports:[
  {payload:report({from:'2026-10-01',to:'2026-10-03',rows:[row('2026-10-02','111',7)]})},
  {payload:report({from:'2026-10-07',to:'2026-10-09',rows:[row('2026-10-08','111',11)]})}
 ]});try{
  const out=snapshot(db,reader(db));
  assert.deepEqual(cells(out),[['2026-10-02','111',7],['2026-10-08','111',11]]);
  assert.deepEqual(out.spend.coveredRanges,[{from:'2026-10-01',to:'2026-10-03'},{from:'2026-10-07',to:'2026-10-09'}]);
  assert.equal(out.spend.complete,false);
 }finally{db.close();}
});

// Вымышленные компании, логины и суммы. Сеть не используется.
const NOW=Date.parse('2026-10-10T09:30:00.000Z');
const CHECKED='2026-10-10T09:00:00.000Z',COLLECTED='2026-10-10T09:00:01.000Z',LAST='2026-10-10T09:00:02.000Z';
const LATER={checkedAt:'2026-10-10T09:10:00.000Z',collectedAt:'2026-10-10T09:10:01.000Z',lastSuccess:'2026-10-10T09:10:02.000Z'};
const CONFIG={externalLogin:'acme-direct',campaignIds:['111','222'],currency:'RUB',timezone:'Europe/Moscow',includeVAT:true,includeDiscount:true};
const SECRET='never-leak-secret-value';
const ACCESS_SQL='CREATE TABLE revenue_access (company TEXT NOT NULL, provider TEXT NOT NULL, config TEXT NOT NULL, secret TEXT NOT NULL, revision INTEGER NOT NULL, enabled INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(company,provider));';
const DIRECT_SQL='CREATE TABLE revenue_direct(company TEXT NOT NULL,from_day TEXT NOT NULL,to_day TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,collected_at TEXT NOT NULL,PRIMARY KEY(company,from_day,to_day));';
const FACT_KEYS=['accountScope','allocations','amountMicros','campaignId','companyCode','currency','evidence','id','kind','provider','serviceFrom','serviceTo','timezone','vatMode'];

const ask=(over={})=>({companyCode:'acme',period:{from:'2026-10-01',to:'2026-10-09'},observationTo:'2026-10-09',timezone:'Asia/Irkutsk',...over});
const row=(date,campaignId,costMicros,impressions=100,clicks=5)=>({date,campaignId,impressions,clicks,costMicros});
const clone=v=>JSON.parse(JSON.stringify(v));
const hourName=(company,from,to,checkedAt,config=CONFIG)=>directReportName(company,config,{from,to},'refresh-'+Math.floor(Date.parse(checkedAt)/3600000));
// Тот же объект, что createDirectAdapter().collect() возвращает и revenue-analytics.js сохраняет в revenue_direct.payload.
function report({company='acme',config=CONFIG,from='2026-10-01',to='2026-10-09',periodClosed=true,checkedAt=CHECKED,rows=[]}={}) {
  const sum=k=>rows.reduce((s,r)=>s+r[k],0);
  return {companyCode:company,provider:'direct',externalLogin:config.externalLogin,campaignIds:[...config.campaignIds],period:{from,to},periodClosed,
    currency:config.currency,includeVAT:config.includeVAT,includeDiscount:true,includeSubscriptionDiscount:true,timezone:'Europe/Moscow',moneyUnit:'micros',
    rows,rowCount:rows.length,totalCostMicros:sum('costMicros'),totalClicks:sum('clicks'),totalImpressions:sum('impressions'),
    provenance:{checkedAt,endpoint:ENDPOINT,method:'POST',reportType:REPORT_TYPE,reportName:hourName(company,from,to,checkedAt,config),
      requestId:'req-secret-1',processingMode:'auto',polls:1}};
}
function populate(db,{reports=[],revision=3,access=[['acme',CONFIG,revision]],tables=ACCESS_SQL+DIRECT_SQL}={}) {
  db.exec(tables);
  if(tables.includes('revenue_access')) {
    const add=db.prepare('INSERT INTO revenue_access VALUES(?,?,?,?,?,?,?)');
    for(const [c,cfg,rev] of access)add.run(c,'direct',JSON.stringify({...cfg,historyFrom:'2026-01-01'}),SECRET,rev,1,LAST);
  }
  for(const r of reports) {
    const p=r.payload;
    db.prepare('INSERT INTO revenue_direct VALUES(?,?,?,?,?,?)').run(r.company??p.companyCode,r.from??p.period.from,r.to??p.period.to,r.revision??revision,
      typeof p==='string'?p:JSON.stringify(p),r.collectedAt??COLLECTED);
  }
  return db;
}
const fixture=options=>populate(new DatabaseSync(':memory:'),options);
const stateOf=(over={})=>({companyCode:'acme',provider:'direct',configured:true,enabled:true,revision:3,config:{...CONFIG,historyFrom:'2026-01-01'},updatedAt:LAST,
  lastAttempt:LAST,lastSuccess:LAST,nextCheckAt:null,running:false,errorCode:null,current:true,stale:false,...over});
const reader=(db,over={},calls=[])=>createRevenueDirectSpendFacts(db,{providerState:(c,p)=>{calls.push([c,p]);return typeof over==='function'?over():stateOf(over);},now:()=>NOW});
const changes=db=>db.prepare('SELECT total_changes() AS n').get().n;
// Вызывающий открывает снимок; reader ничего не пишет; вызывающий откатывает транзакцию.
function snapshot(db,r,input=ask()) {
  const before=changes(db);db.exec('BEGIN');
  try{return r.read(input);}finally{assert.equal(changes(db),before);db.exec('ROLLBACK');}
}
const cells=out=>out.spend.facts.map(f=>[f.serviceFrom,f.campaignId,f.amountMicros]);

test('текущий канонический снимок: точные micros, строгий whitelist, без логина и секретов',()=>{
  const db=fixture({reports:[{payload:report({rows:[row('2026-10-05','222',2500001),row('2026-10-03','111',1234567890),row('2026-10-08','222',0,40,0)]})}]});
  const calls=[],out=snapshot(db,reader(db,{},calls));
  assert.deepEqual(calls,[['acme','direct']]);
  assert.deepEqual(Object.keys(out).sort(),['companyCode','leadBindings','paymentHistory','recordCosts','spend','vatMode']);
  assert.deepEqual([out.companyCode,out.vatMode,out.paymentHistory,out.leadBindings,out.recordCosts],['acme','unknown',null,null,null]);
  const s=out.spend;
  assert.deepEqual(Object.keys(s).sort(),['campaigns','companyCode','complete','coveredRanges','evidence','facts','from','providers','to']);
  assert.deepEqual([s.companyCode,s.from,s.to,s.providers,s.complete,s.campaigns],['acme','2026-10-01','2026-10-09',['yandex_direct'],false,[]]);
  assert.deepEqual(Object.keys(s.evidence).sort(),['confirmedAt','kind','reference']);
  assert.equal(s.evidence.kind,'native_report_range');assert.equal(s.evidence.confirmedAt,COLLECTED);
  assert.match(s.evidence.reference,/^[A-Za-z0-9._\/-]{1,128}$/);
  // Доли копейки сохраняются: 1234567890 micros = 1234,56789 ₽, без построчного округления.
  assert.deepEqual(cells(out),[['2026-10-03','111',1234567890],['2026-10-05','222',2500001],['2026-10-08','222',0]]);
  for(const f of s.facts) {
    assert.deepEqual(Object.keys(f).sort(),FACT_KEYS);
    assert.deepEqual([f.companyCode,f.provider,f.accountScope,f.kind,f.serviceFrom,f.currency,f.vatMode,f.timezone,f.allocations],
      ['acme','yandex_direct','company','spend',f.serviceTo,'RUB','vat_included','Europe/Moscow',null]);
    assert.ok(Number.isSafeInteger(f.amountMicros));assert.match(f.id,/^[A-Za-z0-9._\/-]{1,128}$/);
    assert.deepEqual(Object.keys(f.evidence).sort(),['confirmedAt','kind','reference']);
    assert.deepEqual([f.evidence.kind,f.evidence.confirmedAt],['direct_reports_api',COLLECTED]);
  }
  assert.equal(new Set(s.facts.map(f=>f.id)).size,s.facts.length);
  const text=JSON.stringify(out);
  for(const leak of ['acme-direct',SECRET,'req-secret-1','synapse-direct-',ENDPOINT,'api.direct','Impressions','impressions','clicks','Bearer','reportName'])
    assert.ok(!text.includes(leak),leak);
  // Режим НДС расхода берётся из привязки; НДС выручки остаётся неизвестным.
  const NOVAT={...CONFIG,includeVAT:false};
  const plain=fixture({access:[['acme',NOVAT,3]],reports:[{payload:report({config:NOVAT,rows:[row('2026-10-02','111',10)]})}]});
  const ex=snapshot(plain,reader(plain,{config:{...NOVAT,historyFrom:'2026-01-01'}}));
  assert.equal(ex.spend.facts[0].vatMode,'vat_excluded');assert.equal(ex.vatMode,'unknown');
});

test('чтение только внутри транзакции вызывающего; readonly файл; откат без изменений БД',()=>{
  const db=fixture({reports:[{payload:report({rows:[row('2026-10-02','111',7)]})}]});
  const r=reader(db);
  assert.equal(db.isTransaction,false);
  assert.throws(()=>r.read(ask()),{code:'SNAPSHOT_REQUIRED'});
  assert.equal(snapshot(db,r).spend.facts.length,1);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'direct-spend-ro-'));const file=path.join(dir,'revenue.sqlite');
  try {
    const w=populate(new DatabaseSync(file),{reports:[{payload:report({rows:[row('2026-10-02','111',7)]})}]});w.close();
    const ro=new DatabaseSync(file,{readOnly:true});
    try {
      ro.exec('BEGIN');const out=reader(ro).read(ask());ro.exec('COMMIT');
      assert.deepEqual(cells(out),[['2026-10-02','111',7]]);
      assert.equal(changes(ro),0);
    } finally {ro.close();}
  } finally {cleanup(dir);}
});

test('полный пустой отчёт — известный ноль только Директа; текущий московский день и пробел не покрыты',()=>{
  const zero=fixture({reports:[{payload:report()}]});
  const out=snapshot(zero,reader(zero));
  assert.deepEqual([out.spend.from,out.spend.to,out.spend.facts,out.spend.complete,out.spend.providers],['2026-10-01','2026-10-09',[],false,['yandex_direct']]);
  // Отчёт по сегодняшний (незакрытый) московский день: последний день не покрыт, его строка не выдаётся.
  const open=fixture({reports:[{payload:report({to:'2026-10-10',periodClosed:false,rows:[row('2026-10-09','111',5),row('2026-10-10','111',9)]})}]});
  const o=snapshot(open,reader(open),ask({period:{from:'2026-10-01',to:'2026-10-10'},observationTo:'2026-10-10'}));
  assert.deepEqual([o.spend.from,o.spend.to],['2026-10-01','2026-10-10']);
  assert.deepEqual(o.spend.coveredRanges,[{from:'2026-10-01',to:'2026-10-09'}]);assert.deepEqual(cells(o),[['2026-10-09','111',5]]);
  // Отчёт целиком по незакрытому дню не даёт покрытия.
  const today=fixture({reports:[{payload:report({from:'2026-10-10',to:'2026-10-10',periodClosed:false,rows:[row('2026-10-10','111',9)]})}]});
  assert.equal(snapshot(today,reader(today),ask({period:{from:'2026-10-10',to:'2026-10-10'},observationTo:'2026-10-10'})),null);
  // Пробел 04–05: оба покрытых отрезка остаются, отсутствующие дни не превращаются в нули.
  const gap=fixture({reports:[{payload:report({to:'2026-10-03',rows:[row('2026-10-02','111',11)]})},{payload:report({from:'2026-10-06',rows:[row('2026-10-07','222',13)]})}]});
  const g=snapshot(gap,reader(gap));
  assert.deepEqual([g.spend.from,g.spend.to],['2026-10-01','2026-10-09']);
  assert.deepEqual(g.spend.coveredRanges,[{from:'2026-10-01',to:'2026-10-03'},{from:'2026-10-06',to:'2026-10-09'}]);
  assert.deepEqual(cells(g),[['2026-10-02','111',11],['2026-10-07','222',13]]);
  // Нет ни одного отчёта по периоду — не ноль, а отсутствие снимка.
  assert.equal(snapshot(gap,reader(gap),ask({period:{from:'2026-09-01',to:'2026-09-02'},observationTo:'2026-09-02'})),null);
});

test('поздний полный отчёт обнуляет исчезнувшую строку; перекрытие не удваивает; ничья с разными значениями — неизвестно',()=>{
  const old=report({rows:[row('2026-10-03','111',7),row('2026-10-05','111',5000000),row('2026-10-05','222',2500001)]});
  const newer=report({from:'2026-10-04',to:'2026-10-06',checkedAt:LATER.checkedAt,rows:[row('2026-10-05','222',3000000)]});
  const db=fixture({reports:[{payload:old},{payload:newer,collectedAt:LATER.collectedAt}]});
  const out=snapshot(db,reader(db,{lastSuccess:LATER.lastSuccess}));
  assert.deepEqual(cells(out),[['2026-10-03','111',7],['2026-10-05','222',3000000]]);
  assert.deepEqual([out.spend.from,out.spend.to,out.spend.evidence.confirmedAt],['2026-10-01','2026-10-09',LATER.collectedAt]);
  assert.deepEqual(out.spend.facts.map(f=>f.evidence.confirmedAt),[COLLECTED,LATER.collectedAt]);
  // Порядок вставки не важен: выбирается самый поздний отчёт, а не последняя строка таблицы.
  const reversed=fixture({reports:[{payload:newer,collectedAt:LATER.collectedAt},{payload:old}]});
  assert.deepEqual(cells(snapshot(reversed,reader(reversed,{lastSuccess:LATER.lastSuccess}))),cells(out));
  // Одинаковый момент и одинаковые значения в двух отчётах: один факт, без суммирования.
  const same=report({from:'2026-10-04',to:'2026-10-06',rows:[row('2026-10-05','111',5000000),row('2026-10-05','222',2500001)]});
  const tie=fixture({reports:[{payload:old},{payload:same}]});
  assert.deepEqual(cells(snapshot(tie,reader(tie))),[['2026-10-03','111',7],['2026-10-05','111',5000000],['2026-10-05','222',2500001]]);
  // Одинаковый момент, разные значения (в том числе строка против её отсутствия) — противоречие, весь расход неизвестен.
  for(const rows of [[row('2026-10-05','111',5000000),row('2026-10-05','222',2500002)],[row('2026-10-05','222',2500001)]]) {
    const conflict=fixture({reports:[{payload:old},{payload:report({from:'2026-10-04',to:'2026-10-06',rows})}]});
    assert.equal(snapshot(conflict,reader(conflict)),null);
  }
});

test('чужой, непонятный или переполненный новый отчёт не заменяется старым удобным',()=>{
  const old=report({rows:[row('2026-10-03','111',7)]});
  const base=()=>report({from:'2026-10-04',to:'2026-10-06',checkedAt:LATER.checkedAt,rows:[row('2026-10-05','222',3000000)]});
  const insert=payload=>({payload,company:'acme',from:'2026-10-04',to:'2026-10-06',collectedAt:LATER.collectedAt});
  const control=fixture({reports:[{payload:old},insert(base())]});
  assert.deepEqual(cells(snapshot(control,reader(control,{lastSuccess:LATER.lastSuccess}))),[['2026-10-03','111',7],['2026-10-05','222',3000000]]);
  const mutations={
    company:p=>{p.companyCode='beta';},login:p=>{p.externalLogin='other-login';},campaigns:p=>{p.campaignIds=['111','222','333'];},
    currency:p=>{p.currency='USD';},vat:p=>{p.includeVAT=false;},discount:p=>{p.includeSubscriptionDiscount=false;},timezone:p=>{p.timezone='Asia/Irkutsk';},
    unit:p=>{p.moneyUnit='kopecks';},period:p=>{p.period.to='2026-10-07';},rawKey:p=>{p.rawBody='Date\tCampaignId';},
    endpoint:p=>{p.provenance.endpoint='https://example.test/json/v501/reports';},method:p=>{p.provenance.method='GET';},
    reportType:p=>{p.provenance.reportType='CUSTOM_REPORT';},
    reportName:p=>{p.provenance.reportName=hourName('beta','2026-10-04','2026-10-06',LATER.checkedAt);},
    staleName:p=>{p.provenance.reportName=hourName('acme','2026-10-04','2026-10-06','2026-10-10T04:00:00.000Z');},
    headerProvenance:p=>{p.provenance.authorization='Bearer x';},
    // Отчёт помечен закрытым, но получен в тот же московский день, которым заканчивается.
    closedSameDay:p=>{p.provenance.checkedAt='2026-10-06T10:00:00.000Z';p.provenance.reportName=hourName('acme','2026-10-04','2026-10-06','2026-10-06T10:00:00.000Z');},
    foreignCampaign:p=>{p.rows=[row('2026-10-05','333',1)];p.rowCount=1;p.totalCostMicros=1;p.totalClicks=5;p.totalImpressions=100;},
    numericCampaign:p=>{p.rows[0].campaignId=222;},outsideDate:p=>{p.rows[0].date='2026-10-08';},badDate:p=>{p.rows[0].date='2026-02-30';},
    duplicate:p=>{p.rows.push({...p.rows[0]});p.rowCount=2;p.totalCostMicros*=2;p.totalClicks*=2;p.totalImpressions*=2;},
    total:p=>{p.totalCostMicros+=1;},rowCount:p=>{p.rowCount=2;},fraction:p=>{p.rows[0].costMicros=1.5;p.totalCostMicros=1.5;},
    negative:p=>{p.rows[0].costMicros=-1;p.totalCostMicros=-1;},string:p=>{p.rows[0].costMicros='3000000';},
    extraRowKey:p=>{p.rows[0].clientLogin='x';},
    overflow:p=>{p.rows=[row('2026-10-04','111',9007199254740000),row('2026-10-05','111',9007199254740000)];p.rowCount=2;p.totalCostMicros=Number.MAX_SAFE_INTEGER;}
  };
  for(const [name,mutate] of Object.entries(mutations)) {
    const p=clone(base());mutate(p);
    const db=fixture({reports:[{payload:old},insert(p)]});
    assert.equal(snapshot(db,reader(db,{lastSuccess:LATER.lastSuccess})),null,name);
  }
  // Сырые JSON-значения: целое вне безопасного диапазона, непарсируемое тело, HTML.
  const unsafe=JSON.stringify(base()).replace('"costMicros":3000000','"costMicros":9007199254740993').replace('"totalCostMicros":3000000','"totalCostMicros":9007199254740993');
  assert.ok(unsafe.includes('9007199254740993'));
  for(const payload of [unsafe,'{bad json','<html>error</html>']) {
    const db=fixture({reports:[{payload:old},insert(payload)]});
    assert.equal(snapshot(db,reader(db,{lastSuccess:LATER.lastSuccess})),null);
  }
  // Время: строка записана после последнего успеха, либо успех в будущем относительно часов сервера.
  const late=fixture({reports:[{payload:old,collectedAt:'2026-10-10T09:00:03.000Z'}]});
  assert.equal(snapshot(late,reader(late)),null);
  const future=fixture({reports:[{payload:old}]});
  assert.equal(snapshot(future,reader(future,{lastSuccess:'2026-10-10T10:00:00.000Z'})),null);
});

test('состояние источника, ревизия и неизменяемая привязка',()=>{
  const good={payload:report({rows:[row('2026-10-03','111',7)]})};
  const H='2026-01-01';
  for(const over of [{current:false},{stale:true},{enabled:false},{configured:false},{errorCode:'ACCESS_DENIED'},{lastSuccess:null},{revision:4},
    {revision:'3'},{config:null},{config:{...CONFIG,currency:'USD',historyFrom:H}},{config:{...CONFIG,campaignIds:['111'],historyFrom:H}},
    {config:{...CONFIG,historyFrom:'2026-02-01'}},{config:{...CONFIG,campaignIds:[111,222],historyFrom:H}},{config:{...CONFIG,token:'x',historyFrom:H}}]) {
    const db=fixture({reports:[good]});
    assert.equal(snapshot(db,reader(db,over)),null,JSON.stringify(over));
  }
  // Строки другой ревизии: прежняя не принимается, будущая означает противоречие.
  const older=fixture({reports:[{...good,revision:2}]});assert.equal(snapshot(older,reader(older)),null);
  const newer=fixture({reports:[good,{payload:report({from:'2026-10-05',to:'2026-10-06'}),revision:4}]});assert.equal(snapshot(newer,reader(newer)),null);
  const mixed=fixture({reports:[good,{payload:report({from:'2026-10-02',to:'2026-10-04',checkedAt:LATER.checkedAt,rows:[row('2026-10-03','111',999)]}),revision:2,collectedAt:LATER.collectedAt}]});
  assert.deepEqual(cells(snapshot(mixed,reader(mixed))),[['2026-10-03','111',7]]);
  // Ревизия и включение в revenue_access должны совпадать с состоянием того же снимка.
  const disabled=fixture({reports:[good]});disabled.exec('UPDATE revenue_access SET enabled=0');
  assert.equal(snapshot(disabled,reader(disabled)),null);
  const bumped=fixture({reports:[good]});bumped.exec('UPDATE revenue_access SET revision=4');
  assert.equal(snapshot(bumped,reader(bumped)),null);
  // Состояние чужой компании или асинхронный ответ — нарушение контракта Root, а не «нет данных».
  const db=fixture({reports:[good]});
  db.exec('BEGIN');
  try {
    assert.throws(()=>reader(db,{companyCode:'beta'}).read(ask()),{code:'FOREIGN_COMPANY'});
    assert.throws(()=>reader(db,{provider:'metrika'}).read(ask()),{code:'FOREIGN_COMPANY'});
    assert.throws(()=>reader(db,()=>Promise.resolve(stateOf())).read(ask()),{code:'DIRECT_STATE_INVALID'});
  } finally {db.exec('ROLLBACK');}
});

test('изоляция компаний и общий кабинет',()=>{
  const BETA={...CONFIG,externalLogin:'beta-direct',campaignIds:['333']};
  const reports=[{payload:report({rows:[row('2026-10-03','111',7)]})},{payload:report({company:'beta',config:BETA,rows:[row('2026-10-03','333',555)]})}];
  const db=fixture({reports,access:[['acme',CONFIG,3],['beta',BETA,3]]});
  const calls=[],out=snapshot(db,reader(db,{},calls));
  assert.deepEqual(calls,[['acme','direct']]);
  assert.deepEqual(cells(out),[['2026-10-03','111',7]]);
  assert.ok(!JSON.stringify(out).includes('beta'));
  // Чужое тело, сохранённое под кодом acme, не принимается.
  const forged=fixture({reports:[reports[0],{payload:report({company:'beta',from:'2026-10-02',to:'2026-10-04',checkedAt:LATER.checkedAt}),company:'acme',collectedAt:LATER.collectedAt}]});
  assert.equal(snapshot(forged,reader(forged,{lastSuccess:LATER.lastSuccess})),null);
  // Та же кампания у другой компании (в том числе выключенной) — общий кабинет: расход не назначается компании.
  const shared=fixture({reports:[reports[0]],access:[['acme',CONFIG,3],['beta',{...BETA,campaignIds:['222']},1]]});
  shared.exec("UPDATE revenue_access SET enabled=0 WHERE company='beta'");
  assert.equal(snapshot(shared,reader(shared)),null);
});

test('схема и строгий вход',()=>{
  const noDirect=fixture({tables:ACCESS_SQL});
  assert.equal(snapshot(noDirect,reader(noDirect)),null);
  const noAccess=fixture({tables:DIRECT_SQL});
  assert.equal(snapshot(noAccess,reader(noAccess)),null);
  const altered=fixture({tables:ACCESS_SQL+DIRECT_SQL.replace('collected_at TEXT NOT NULL,','collected_at TEXT NOT NULL,raw_body TEXT,')});
  assert.equal(snapshot(altered,reader(altered)),null);
  const db=fixture({reports:[{payload:report()}]}),r=reader(db);
  db.exec('BEGIN');
  try {
    for(const bad of [{...ask(),extra:1},ask({period:{from:'2026-10-01',to:'2026-10-09',timezone:'UTC'}}),ask({period:{from:'2026-02-30',to:'2026-03-01'},observationTo:'2026-03-01'}),
      ask({period:{from:'2026-10-09',to:'2026-10-01'}}),ask({observationTo:'2026-10-08'}),ask({observationTo:'2026-10-9'}),ask({timezone:'Europe/London'}),
      ask({companyCode:'ACME'}),ask({companyCode:undefined}),ask({period:{from:'2000-01-01',to:'2026-10-09'}}),null,[]])
      assert.throws(()=>r.read(bad),e=>['VALIDATION_ERROR','BAD_PERIOD','BAD_TIMEZONE'].includes(e.code));
  } finally {db.exec('ROLLBACK');}
  for(const options of [{},{providerState:()=>null,extra:1},{providerState:()=>null,now:1}])
    assert.throws(()=>createRevenueDirectSpendFacts(db,options),{code:'DIRECT_READER_INVALID'});
  assert.throws(()=>createRevenueDirectSpendFacts(null,{providerState:()=>null}),{code:'DIRECT_READER_INVALID'});
});

test('настоящий путь адаптер→revenue_direct: перезапуск и поздняя корректировка без сети',async()=>{
  const {createRevenueAnalytics}=require('./revenue-analytics');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'direct-spend-'));const file=path.join(dir,'revenue.sqlite');
  let clock=Date.parse('2026-10-10T09:00:00.000Z');
  const native=new Map([['2026-10-03/111',1234567890],['2026-10-05/111',5000000],['2026-10-05/222',2500001]]);
  // Подставной fetch вместо сети: полный TSV с заголовком отчёта, столбцами и итогом строк.
  const fetchImpl=async(url,init)=>{
    const {params}=JSON.parse(init.body),{DateFrom:from,DateTo:to,Filter:[{Values:ids}]}=params.SelectionCriteria;
    const lines=[...native].map(([k,v])=>[...k.split('/'),v]).filter(([d,c])=>d>=from&&d<=to&&ids.includes(c)).map(([d,c,v])=>[d,c,'100','5',String(v)].join('\t'));
    return new Response([`${params.ReportName} (${from} - ${to})`,'Date\tCampaignId\tImpressions\tClicks\tCost',...lines,'Total rows: '+lines.length,''].join('\n'),
      {status:200,headers:{'content-type':'text/tab-separated-values; charset=utf-8'}});
  };
  const direct=createDirectAdapter({fetchImpl,now:()=>clock,wait:async()=>{}});
  const adapters={direct:(b,r)=>{const {historyFrom,...config}=b.config;return direct.collect({companyCode:b.companyCode,config,credential:b.credential},r);},stop(){}};
  const open=()=>{
    const db=new DatabaseSync(file),analytics=createRevenueAnalytics(db,{apiKey:'test-api-key-'.repeat(3),now:()=>clock,adapters});
    return {db,analytics,reader:createRevenueDirectSpendFacts(db,{providerState:(c,p)=>analytics.status(c,p),now:()=>clock})};
  };
  let s=open();
  try {
    s.analytics.save('acme','direct',{revision:0,enabled:true,config:{...CONFIG,historyFrom:'2026-09-01'},credential:{token:'test-token-value'}});
    assert.equal((await s.analytics.collect('acme','direct',{from:'2026-10-01',to:'2026-10-09'})).collected,true);
    const first=snapshot(s.db,s.reader);
    assert.deepEqual(cells(first),[['2026-10-03','111',1234567890],['2026-10-05','111',5000000],['2026-10-05','222',2500001]]);
    for(const leak of ['test-token-value','acme-direct','synapse-direct-'])assert.ok(!JSON.stringify(first).includes(leak),leak);
    // Перезапуск процесса: тот же снимок даёт тот же результат.
    s.db.close();s=open();
    assert.deepEqual(snapshot(s.db,s.reader),first);
    // Корректировка задним числом: строка 05/111 исчезла, 05/222 изменилась. Новый частичный отчёт перекрывает прежний.
    native.delete('2026-10-05/111');native.set('2026-10-05/222',3000000);clock+=3600000;
    assert.equal((await s.analytics.collect('acme','direct',{from:'2026-10-04',to:'2026-10-06'})).collected,true);
    const second=snapshot(s.db,s.reader);
    assert.deepEqual(cells(second),[['2026-10-03','111',1234567890],['2026-10-05','222',3000000]]);
    assert.deepEqual([second.spend.from,second.spend.to],['2026-10-01','2026-10-09']);
    // Сохранённая ошибка источника: прежние числа не выдаются как текущие.
    s.db.prepare("UPDATE revenue_jobs SET error_code='UPSTREAM_ERROR' WHERE company='acme' AND provider='direct'").run();
    assert.equal(snapshot(s.db,s.reader),null);
  } finally {s.db.close();cleanup(dir);}
});

function cleanup(dir){
 const resolved=fs.realpathSync(dir),parent=fs.realpathSync(os.tmpdir());
 assert.equal(path.dirname(resolved),parent);assert.ok(/^direct-spend-(?:ro-)?/.test(path.basename(resolved)));
 assert.equal(fs.lstatSync(dir).isSymbolicLink(),false);fs.rmSync(dir,{recursive:true});
}

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createDirectAdapter,parseDirectReport,directReportName,assertDisjointDirectBindings}=require('./revenue-direct-adapter');
// Синтетические данные: ни настоящего токена, ни сетевых запросов. Адрес указан литералом, а не взят из модуля.
const URL_REPORTS='https://api.direct.yandex.com/json/v501/reports';
const TOKEN='synthetic-direct-token-SECRET';
const NOW=Date.parse('2026-10-13T06:00:00Z'); // 14:00 13.10 по Иркутску
const P={from:'2026-10-01',to:'2026-10-07'};
const config=(v={})=>({externalLogin:'alvi-client',campaignIds:['7001','7002'],currency:'RUB',timezone:'Europe/Moscow',includeVAT:false,includeDiscount:true,...v});
const binding=(v={})=>({companyCode:'alvi',config:config(),credential:{token:TOKEN},...v});
const ROWS=[['2026-10-02','7002','1200','34','5120000000'],['2026-10-01','7001','1000','25','1234567890'],['2026-10-01','7002','15','0','0']];
const COLUMNS=['Date','CampaignId','Impressions','Clicks','Cost'];
const enc=s=>new TextEncoder().encode(s);
const tsv=(name,rows,{from=P.from,to=P.to,columns=COLUMNS,total=rows.length,quoted=true}={})=>{
  const title=name+' ('+from+' - '+to+')';
  return [quoted?'"'+title+'"':title,columns.join('\t'),...rows.map(r=>r.join('\t')),'Total rows: '+total].join('\n')+'\n';
};
const reportOf=init=>JSON.parse(init.body).params.ReportName;
const ready=(rows,opts)=>init=>new Response(tsv(reportOf(init),rows,opts),{status:200,headers:{'Content-Type':'text/tab-separated-values; charset=utf-8',RequestId:'8695244274068608439'}});
const pending=(status,retry)=>()=>new Response(null,{status,headers:retry===undefined?{RequestId:'77'}:{retryIn:String(retry),RequestId:'77'}});
const raw=(status,body,type)=>()=>new Response(body,{status,headers:type?{'Content-Type':type}:{}});
const errorJson=code=>JSON.stringify({error:{request_id:'42',error_code:code,error_string:'echo Bearer '+TOKEN,error_detail:'PRIVATE DETAIL'}});
function harness(responders,{adapter={},onWait}={}) {
  const h={calls:[],waits:[],time:NOW};
  const fetchImpl=async(url,init)=>{
    h.calls.push({url,method:init.method,redirect:init.redirect,headers:{...init.headers},body:init.body,signal:init.signal});
    return responders[Math.min(h.calls.length-1,responders.length-1)](init,h.calls.length);
  };
  h.adapter=createDirectAdapter({fetchImpl,now:()=>h.time,wait:async(ms,signal)=>{h.waits.push(ms);h.time+=ms;if(onWait)await onWait(ms,signal,h);},...adapter});
  return h;
}
const onlyReports=calls=>{for(const c of calls){assert.equal(c.url,URL_REPORTS);assert.equal(c.method,'POST');assert.equal(c.redirect,'error');}};
async function rejectsCode(promise,code) {
  await assert.rejects(promise,e=>{
    assert.equal(e.code,code);
    assert.doesNotMatch(String(e.message)+String(e.stack)+JSON.stringify(e),/SECRET|PRIVATE/);
    return true;
  });
}

test('один POST отчёта с точными заголовками и телом; расходы только объявленных кампаний в целых микроединицах',async()=>{
  const h=harness([ready(ROWS)]);
  const result=await h.adapter.collect(binding({config:config({campaignIds:['7002','7001']})}),P);
  assert.equal(h.calls.length,1);onlyReports(h.calls);
  const [call]=h.calls;
  assert.deepEqual(call.headers,{Authorization:'Bearer '+TOKEN,'Client-Login':'alvi-client','Accept-Language':'en',processingMode:'auto','Content-Type':'application/json; charset=utf-8'});
  assert.ok(call.signal instanceof AbortSignal);
  const body=JSON.parse(call.body),name=body.params.ReportName;
  assert.match(name,/^synapse-direct-[0-9a-f]{32}$/);
  assert.deepEqual(body,{params:{SelectionCriteria:{DateFrom:'2026-10-01',DateTo:'2026-10-07',Filter:[{Field:'CampaignId',Operator:'IN',Values:['7001','7002']}]},
    FieldNames:['Date','CampaignId','Impressions','Clicks','Cost'],ReportName:name,ReportType:'CAMPAIGN_PERFORMANCE_REPORT',DateRangeType:'CUSTOM_DATE',Format:'TSV',IncludeVAT:'NO',IncludeDiscount:'YES',IncludeSubscriptionDiscount:'YES'}});
  assert.deepEqual(result.rows,[
    {date:'2026-10-01',campaignId:'7001',impressions:1000,clicks:25,costMicros:1234567890},
    {date:'2026-10-01',campaignId:'7002',impressions:15,clicks:0,costMicros:0},
    {date:'2026-10-02',campaignId:'7002',impressions:1200,clicks:34,costMicros:5120000000}]);
  assert.equal(result.totalCostMicros,6354567890);assert.equal(result.totalClicks,59);assert.equal(result.totalImpressions,2215);assert.equal(result.rowCount,3);
  assert.equal(result.companyCode,'alvi');assert.deepEqual(result.period,P);assert.equal(result.periodClosed,true);
  assert.deepEqual([result.currency,result.includeVAT,result.includeDiscount,result.timezone,result.moneyUnit],['RUB',false,true,'Europe/Moscow','micros']);
  assert.deepEqual(result.provenance,{checkedAt:'2026-10-13T06:00:00.000Z',endpoint:URL_REPORTS,method:'POST',reportType:'CAMPAIGN_PERFORMANCE_REPORT',
    reportName:name,requestId:'8695244274068608439',processingMode:'auto',polls:1});
  assert.doesNotMatch(JSON.stringify(result),/SECRET/);
  assert.deepEqual(Object.keys(h.adapter).sort(),['collect','stop']);
});

test('НДС берётся только из явной настройки и меняет запрос и имя отчёта',async()=>{
  const h=harness([ready([])]);
  const withVat=await h.adapter.collect(binding({config:config({includeVAT:true})}),P);
  const without=await h.adapter.collect(binding(),P);
  assert.equal(JSON.parse(h.calls[0].body).params.IncludeVAT,'YES');assert.equal(JSON.parse(h.calls[1].body).params.IncludeVAT,'NO');
  assert.equal(withVat.includeVAT,true);assert.equal(without.includeVAT,false);
  assert.notEqual(withVat.provenance.reportName,without.provenance.reportName);
});

test('201 и 202 повторяют точно тот же запрос после retryIn и не дают снимка до 200',async()=>{
  const h=harness([pending(201,3),pending(202,7),ready(ROWS)]);
  const result=await h.adapter.collect(binding(),P);
  assert.equal(h.calls.length,3);onlyReports(h.calls);
  for(const c of h.calls.slice(1)){assert.equal(c.body,h.calls[0].body);assert.deepEqual(c.headers,h.calls[0].headers);}
  assert.deepEqual(h.waits,[3000,7000]);
  assert.equal(result.provenance.polls,3);assert.equal(result.totalCostMicros,6354567890);
  assert.equal(result.provenance.checkedAt,new Date(NOW+10000).toISOString());
  const fallback=harness([pending(202),ready([])]);await fallback.adapter.collect(binding(),P);
  assert.deepEqual(fallback.waits,[10000]);
});

test('ожидание ограничено числом опросов, сроком и максимальным retryIn: DELAYED, а не вечный сон',async()=>{
  const polls=harness([pending(202,1)],{adapter:{maxPolls:3}});
  await rejectsCode(polls.adapter.collect(binding(),P),'DELAYED');
  assert.equal(polls.calls.length,3);assert.equal(polls.waits.length,2);
  const deadline=harness([pending(201,30)],{adapter:{deadlineMs:60000}});
  await rejectsCode(deadline.adapter.collect(binding(),P),'DELAYED');
  assert.deepEqual(deadline.waits,[30000,30000]);assert.equal(deadline.calls.length,2);
  const tooLong=harness([pending(202,301),ready(ROWS)]);
  await rejectsCode(tooLong.adapter.collect(binding(),P),'DELAYED');
  assert.equal(tooLong.calls.length,1);assert.deepEqual(tooLong.waits,[]);
});

test('отмена во время ожидания, stop() и обрыв чтения тела дают CANCELLED без новых запросов',async()=>{
  const call=new AbortController();
  const h=harness([pending(202,5),ready(ROWS)],{onWait:()=>call.abort()});
  await rejectsCode(h.adapter.collect(binding(),P,{signal:call.signal}),'CANCELLED');
  assert.equal(h.calls.length,1);
  const owner=new AbortController();
  const shared=harness([pending(202,5),ready(ROWS)],{adapter:{signal:owner.signal},onWait:()=>owner.abort()});
  await rejectsCode(shared.adapter.collect(binding(),P),'CANCELLED');assert.equal(shared.calls.length,1);
  const stopped=harness([pending(202,5),ready(ROWS)],{onWait:(ms,signal,s)=>s.adapter.stop()});
  await rejectsCode(stopped.adapter.collect(binding(),P),'CANCELLED');
  await rejectsCode(stopped.adapter.collect(binding(),P),'CANCELLED');
  assert.equal(stopped.calls.length,1);
  const mid=new AbortController();
  const body=harness([init=>new Response(new ReadableStream({start(c){
    c.enqueue(enc('"'+reportOf(init)+' (2026-10-01 - 2026-10-07)"\n'));
    init.signal.addEventListener('abort',()=>c.error(init.signal.reason),{once:true});
    setTimeout(()=>mid.abort(),5);
  }}),{status:200,headers:{'Content-Type':'text/tab-separated-values'}})]);
  await rejectsCode(body.adapter.collect(binding(),P,{signal:mid.signal}),'CANCELLED');
});

test('сетевой сбой не раскрывает токен и не повторяется вслепую',async()=>{
  const h=harness([()=>{throw new Error('connect failed Authorization: Bearer '+TOKEN);}]);
  await rejectsCode(h.adapter.collect(binding(),P),'CONNECTION_UNCERTAIN');
  assert.equal(h.calls.length,1);
});

test('тело ответа ограничено 8 МиБ потоково; заявленная длина сверх лимита отклоняется до чтения',async()=>{
  let pulled=0,cancelled=false;
  const h=harness([()=>new Response(new ReadableStream({pull(c){pulled++;c.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}}),
    {status:200,headers:{'Content-Type':'text/tab-separated-values'}})]);
  await rejectsCode(h.adapter.collect(binding(),P),'RESPONSE_TOO_LARGE');
  assert.equal(cancelled,true);assert.ok(pulled>=9 && pulled<=12,'прочитано '+pulled+' МиБ');
  const declared=harness([()=>new Response('x',{status:200,headers:{'Content-Type':'text/tab-separated-values','Content-Length':'5000'}})],{adapter:{maxBytes:4096}});
  await rejectsCode(declared.adapter.collect(binding(),P),'RESPONSE_TOO_LARGE');
  assert.throws(()=>createDirectAdapter({maxBytes:9*1024*1024}),{code:'BAD_ADAPTER_OPTIONS'});
  assert.throws(()=>createDirectAdapter({maxPolls:0}),{code:'BAD_ADAPTER_OPTIONS'});
});

test('недоступная загрузка, HTML, JSON ошибки, 203 и перенаправления не принимаются за пустой отчёт',async()=>{
  const cases=[
    [raw(203,tsv('x',[])),'RESPONSE_UNCERTAIN'],
    [raw(204,null),'RESPONSE_UNCERTAIN'],
    [raw(302,null),'RESPONSE_UNCERTAIN'],
    [raw(404,'<html>not found</html>','text/html'),'RESPONSE_UNCERTAIN'],
    [raw(200,'<html><body>Captcha</body></html>','text/html; charset=utf-8'),'RESPONSE_UNCERTAIN'],
    [raw(200,'<html><body>Captcha</body></html>','text/plain'),'RESPONSE_UNCERTAIN'],
    [raw(200,errorJson(53),'application/json'),'RESPONSE_UNCERTAIN'],
    [raw(200,'','text/tab-separated-values'),'INCOMPLETE'],
    [raw(400,errorJson(53),'application/json'),'UPSTREAM_ERROR'],
    [raw(400,errorJson('513'),'application/json'),'UPSTREAM_ERROR'],
    [raw(403,'<html>Forbidden</html>','text/html'),'ACCESS_DENIED'],
    [raw(401,null),'ACCESS_DENIED'],
    [raw(400,errorJson(9000),'application/json'),'UPSTREAM_ERROR'],
    [raw(400,errorJson(152),'application/json'),'UPSTREAM_ERROR'],
    [raw(429,'Too Many Requests','text/plain'),'RATE_LIMITED'],
    [raw(400,errorJson(8800),'application/json'),'UPSTREAM_ERROR'],
    [raw(400,errorJson(4000),'application/json'),'UPSTREAM_ERROR'],
    [raw(500,errorJson(1000),'application/json'),'UPSTREAM_ERROR'],
    [raw(502,'<html>Bad Gateway</html>','text/html'),'UPSTREAM_ERROR'],
  ];
  for(const [responder,code] of cases) {
    const h=harness([responder,ready(ROWS)]);
    await rejectsCode(h.adapter.collect(binding(),P),code);
    assert.equal(h.calls.length,1,code);onlyReports(h.calls);
  }
  const moved=harness([init=>Object.defineProperty(ready(ROWS)(init),'redirected',{value:true})]);
  await rejectsCode(moved.adapter.collect(binding(),P),'RESPONSE_UNCERTAIN');
  const elsewhere=harness([init=>Object.defineProperty(ready(ROWS)(init),'url',{value:'https://attacker.example/reports'})]);
  await rejectsCode(elsewhere.adapter.collect(binding(),P),'RESPONSE_UNCERTAIN');
  const failed=harness([raw(400,errorJson(53),'application/json')]);
  await assert.rejects(failed.adapter.collect(binding(),P),e=>e.code==='UPSTREAM_ERROR' && !('error_string' in e) && !/echo/.test(JSON.stringify(e)));
});

test('проверенный пустой отчёт даёт ноль только при полном TSV с итогом Total rows: 0',async()=>{
  const h=harness([ready([])]);
  const empty=await h.adapter.collect(binding(),P);
  assert.deepEqual(empty.rows,[]);assert.equal(empty.totalCostMicros,0);assert.equal(empty.rowCount,0);
  const name='synapse-direct-'+'a'.repeat(32),expected={reportName:name,...P,campaignIds:['7001']};
  const noSummary=tsv(name,[]).split('\n').slice(0,2).join('\n')+'\n';
  assert.throws(()=>parseDirectReport(noSummary,expected),{code:'INCOMPLETE'});
  assert.throws(()=>parseDirectReport('"'+name+' (2026-10-01 - 2026-10-07)"\n',expected),{code:'INCOMPLETE'});
  assert.throws(()=>parseDirectReport(tsv(name,[],{total:1}),expected),{code:'INCOMPLETE'});
  assert.throws(()=>parseDirectReport('',expected),{code:'INCOMPLETE'});
  assert.equal(parseDirectReport(tsv(name,[],{quoted:false}),expected).totalCostMicros,0);
});

test('разбор отказывает на чужой кампании, дубле, дате вне периода, неполном периоде и неверных столбцах',()=>{
  const name='synapse-direct-'+'b'.repeat(32),expected={reportName:name,...P,campaignIds:['7001','7002']};
  const ok=['2026-10-03','7001','10','1','1000000'];
  assert.equal(parseDirectReport(tsv(name,[ok]),expected).totalCostMicros,1000000);
  const bad=[
    [tsv(name,[ok,['2026-10-03','8001','5','1','2000000']]),'PROFILE_CHANGED'],
    [tsv(name,[ok,['2026-10-03','7001','1','0','0']]),'RESPONSE_UNCERTAIN'],
    [tsv(name,[['2026-10-08','7001','1','1','1']]),'RESPONSE_UNCERTAIN'],
    [tsv(name,[['2026-09-30','7001','1','1','1']]),'RESPONSE_UNCERTAIN'],
    [tsv(name,[['2026-02-30','7001','1','1','1']]),'RESPONSE_UNCERTAIN'],
    [tsv(name,[ok],{from:'2026-10-02'}),'INCOMPLETE'],
    [tsv(name,[ok],{to:'2026-10-06'}),'INCOMPLETE'],
    [tsv('synapse-direct-'+'c'.repeat(32),[ok]),'RESPONSE_UNCERTAIN'],
    [tsv(name,[ok.slice(0,4)],{columns:COLUMNS.slice(0,4)}),'RESPONSE_UNCERTAIN'],
    [tsv(name,[[...ok,'x']],{columns:[...COLUMNS,'CampaignName']}),'RESPONSE_UNCERTAIN'],
    [tsv(name,[ok],{columns:['Date','CampaignId','Clicks','Clicks','Cost']}),'RESPONSE_UNCERTAIN'],
    [tsv(name,[ok.slice(0,4)]),'RESPONSE_UNCERTAIN'],
    [tsv(name,[ok],{total:2}),'INCOMPLETE'],
    [tsv(name,[ok])+'2026-10-04\t7001\t1\t1\t1\n','INCOMPLETE'],
    [tsv(name,[ok]).replace('Total rows: 1','Всего строк: 1'),'INCOMPLETE'],
  ];
  for(const [text,code] of bad)assert.throws(()=>parseDirectReport(text,expected),{code},text);
  // Столбцы читаются по названию, а не по позиции.
  const swapped=parseDirectReport(tsv(name,[['7001','2026-10-03','10','2500000','1']],{columns:['CampaignId','Date','Impressions','Cost','Clicks']}),expected);
  assert.deepEqual(swapped.rows,[{date:'2026-10-03',campaignId:'7001',impressions:10,clicks:1,costMicros:2500000}]);
});

test('микросуммы: только целые безопасные числа, точная сумма, без дробей и переполнения',()=>{
  const name='synapse-direct-'+'d'.repeat(32),expected={reportName:name,...P,campaignIds:['7001']};
  const exact=parseDirectReport(tsv(name,[['2026-10-01','7001','1','1','4503599627370495'],['2026-10-02','7001','1','1','4503599627370496']]),expected);
  assert.equal(exact.totalCostMicros,Number.MAX_SAFE_INTEGER);
  for(const cost of ['12.5','1,5','-1','--','','1e9','9007199254740993','01'])
    assert.throws(()=>parseDirectReport(tsv(name,[['2026-10-01','7001','1','1',cost]]),expected),{code:'RESPONSE_UNCERTAIN'},cost);
  for(const clicks of ['--','1.0','-2'])
    assert.throws(()=>parseDirectReport(tsv(name,[['2026-10-01','7001','1',clicks,'1']]),expected),{code:'RESPONSE_UNCERTAIN'},clicks);
  const huge=Array.from({length:7},(_,i)=>['2026-10-0'+(i+1),'7001','1','1','2000000000000000']);
  assert.throws(()=>parseDirectReport(tsv(name,huge),expected),{code:'RESPONSE_UNCERTAIN'});
});

test('общий аккаунт: каждая компания получает только свои кампании, без суммирования общего расхода',async()=>{
  const ACCOUNT=[['2026-10-01','7001','100','10','1000000'],['2026-10-01','7002','50','5','2000000'],['2026-10-01','8001','70','7','4000000'],['2026-10-02','8001','30','3','8000000']];
  const server=init=>{const ids=new Set(JSON.parse(init.body).params.SelectionCriteria.Filter[0].Values);return ready(ACCOUNT.filter(r=>ids.has(r[1])))(init);};
  const alvi=binding({config:config({externalLogin:'shared-login'})});
  const avocado=binding({companyCode:'avocado',config:config({externalLogin:'shared-login',campaignIds:['8001']})});
  assert.equal(assertDisjointDirectBindings([alvi,avocado]),true);
  const h=harness([server]);
  const a=await h.adapter.collect(alvi,P),b=await h.adapter.collect(avocado,P);
  assert.equal(a.totalCostMicros,3000000);assert.equal(b.totalCostMicros,12000000);
  assert.deepEqual(a.rows.map(r=>r.campaignId),['7001','7002']);assert.deepEqual(b.rows.map(r=>r.campaignId),['8001','8001']);
  assert.deepEqual(JSON.parse(h.calls[1].body).params.SelectionCriteria.Filter[0].Values,['8001']);
  assert.equal(h.calls[1].headers['Client-Login'],'shared-login');
  assert.notEqual(a.provenance.reportName,b.provenance.reportName);assert.equal(b.companyCode,'avocado');
  // Сервер проигнорировал фильтр и вернул весь аккаунт: снимок не создаётся.
  const leaky=harness([ready(ACCOUNT)]);
  await rejectsCode(leaky.adapter.collect(alvi,P),'PROFILE_CHANGED');
  for(const overlap of [['8001','7002'],['7001']])
    assert.throws(()=>assertDisjointDirectBindings([alvi,binding({companyCode:'avocado',config:config({externalLogin:'other-login',campaignIds:overlap})})]),{code:'BINDING_OVERLAP'});
  assert.throws(()=>assertDisjointDirectBindings([alvi,binding({config:config({campaignIds:['9001']})})]),{code:'BINDING_OVERLAP'});
});

test('привязка без явного логина, кампаний, валюты, пояса или режима НДС и опасный токен отклоняются до сети',async()=>{
  const without=key=>{const c=config();delete c[key];return c;};
  const bad=[
    [binding({config:without('externalLogin')}),'VALIDATION_ERROR'],
    [binding({config:config({externalLogin:''})}),'VALIDATION_ERROR'],
    [binding({config:config({externalLogin:'Alvi-Client'})}),'VALIDATION_ERROR'],
    [binding({config:config({externalLogin:'alvi\r\nX-Evil: 1'})}),'VALIDATION_ERROR'],
    [binding({config:config({campaignIds:[]})}),'VALIDATION_ERROR'],
    [binding({config:config({campaignIds:['7001','7001']})}),'VALIDATION_ERROR'],
    [binding({config:config({campaignIds:['abc']})}),'VALIDATION_ERROR'],
    [binding({config:config({campaignIds:Array.from({length:101},(_,i)=>String(1000+i))})}),'VALIDATION_ERROR'],
    [binding({config:without('currency')}),'VALIDATION_ERROR'],
    [binding({config:config({currency:'rub'})}),'BAD_CURRENCY'],
    [binding({config:without('timezone')}),'VALIDATION_ERROR'],
    [binding({config:config({timezone:'Asia/Novosibirsk'})}),'BAD_TIMEZONE'],
    [binding({config:without('includeVAT')}),'VALIDATION_ERROR'],
    [binding({config:config({includeVAT:'YES'})}),'VALIDATION_ERROR'],
    [binding({config:config({includeDiscount:false})}),'VALIDATION_ERROR'],
    [binding({config:config({endpoint:'https://attacker.example/'})}),'VALIDATION_ERROR'],
    [binding({credential:{token:'abc\r\nX-Evil: 1'}}),'VALIDATION_ERROR'],
    [binding({credential:{token:'two words'}}),'VALIDATION_ERROR'],
    [binding({credential:{token:TOKEN,url:'https://attacker.example/'}}),'VALIDATION_ERROR'],
    [binding({credential:{}}),'VALIDATION_ERROR'],
    [binding({companyCode:'ALVI'}),'VALIDATION_ERROR'],
    [null,'VALIDATION_ERROR'],
  ];
  const h=harness([ready(ROWS)]);
  for(const [b,code] of bad)await rejectsCode(h.adapter.collect(b,P),code);
  assert.equal(h.calls.length,0);
});

test('период: будущее и неверные даты отклоняются до сети, «сегодня» считается в явном поясе привязки',async()=>{
  const h=harness([ready([],{from:'2026-10-07',to:'2026-10-13'})]);
  for(const r of [{from:'2026-10-07',to:'2026-10-14'},{from:'2026-10-07',to:'2026-10-06'},{from:'2026-02-30',to:'2026-03-01'},{from:'2023-01-01',to:'2026-10-07'},{},undefined])
    await rejectsCode(h.adapter.collect(binding(),r),'BAD_PERIOD');
  assert.equal(h.calls.length,0);
  const open=await h.adapter.collect(binding(),{from:'2026-10-07',to:'2026-10-13'});
  assert.equal(open.periodClosed,false);
  // 20:00 UTC 12.10: в Иркутске уже 13.10, но отчёт Директа всегда по Москве.
  h.time=Date.parse('2026-10-12T20:00:00Z');
  const week={from:'2026-10-07',to:'2026-10-13'};
  await rejectsCode(h.adapter.collect(binding(),week),'BAD_PERIOD');
  await rejectsCode(h.adapter.collect(binding({config:config({timezone:'Asia/Irkutsk'})}),P),'BAD_TIMEZONE');
  assert.equal(h.calls.length,1);
});

test('имя отчёта детерминировано по компании, логину, кампаниям, периоду и настройкам',()=>{
  const c=config(),name=directReportName('alvi',c,P);
  assert.equal(directReportName('alvi',config({campaignIds:['7002','7001']}),P),name);
  for(const other of [directReportName('avocado',c,P),directReportName('alvi',config({externalLogin:'other'}),P),
    directReportName('alvi',config({campaignIds:['7001']}),P),directReportName('alvi',c,{from:'2026-10-01',to:'2026-10-06'}),
    directReportName('alvi',config({includeVAT:true}),P),directReportName('alvi',config({currency:'KZT'}),P),
    directReportName('alvi',c,P,'open-1'),directReportName('alvi',c,P,'open-2')])
    assert.notEqual(other,name);
  assert.equal(directReportName('alvi',c,P,'open-7'),directReportName('alvi',c,P,'open-7'));
});

test('незакрытый период: внутри одного сбора имя постоянно, в следующем часе — новый отчёт',async()=>{
  const today={from:'2026-10-13',to:'2026-10-13'};
  const h=harness([pending(202,30),ready([],{from:'2026-10-13',to:'2026-10-13'})]);
  h.time=NOW+3600000-10000; // опрос переходит через границу часа
  await h.adapter.collect(binding(),today);
  assert.equal(h.calls[0].body,h.calls[1].body);
  await h.adapter.collect(binding(),today);
  assert.notEqual(reportOf(h.calls[2]),reportOf(h.calls[0]));
});

test('закрытый период тоже обновляется новым отчётом после смены часа, исправления расходов не замораживаются',async()=>{
  const h=harness([ready(ROWS)]);
  await h.adapter.collect(binding(),P);
  h.time+=3600000;
  await h.adapter.collect(binding(),P);
  assert.notEqual(reportOf(h.calls[0]),reportOf(h.calls[1]));
  assert.equal(JSON.parse(h.calls[1].body).params.IncludeSubscriptionDiscount,'YES');
  assert.equal(h.calls[1].headers.returnMoneyInMicros,undefined);
});

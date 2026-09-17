'use strict';
const {createHash}=require('node:crypto');
const ERRORS=Object.freeze({VALIDATION_ERROR:'Проверьте поля, периоды и показатели отчёта.',
  REVISION_CONFLICT:'Настройки изменились. Обновите данные перед сохранением.',
  ORG_MISMATCH:'Организация или город отчёта не совпадают с настройками выбранной компании.',
  CONFIGURATION_REQUIRED:'Сначала сохраните организацию 2ГИС для выбранной компании.',
  NOT_FOUND:'Снимок не найден для текущей компании и организации.'});
const fail=(code='VALIDATION_ERROR',status=400)=>{throw Object.assign(Error(ERRORS[code]),{code,status});};
const text=(value,max,required=true)=>{if(typeof value!=='string'||value.length>max||/[\u0000-\u001f\u007f]/.test(value))fail();const out=value.trim();if(required&&!out)fail();return out;};
const object=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))fail();};
const revision=value=>{if(!Number.isSafeInteger(value)||value<0)fail();return value;};
const organization=value=>{if(typeof value!=='string'||!/^([1-9]\d{0,19})$/.test(value))fail();return value;};
const norm=value=>value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
const aggregate=value=>norm(value)==='все рубрики';
function date(value) {if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))fail();const parsed=new Date(value);if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value)fail();return value;}
function timestamp(value) {if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))fail();const parsed=new Date(value);if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value.slice(0,10))fail();return parsed.toISOString();}
function sourceUrl(value,org) {
  const raw=text(value,2000);let url;try{url=new URL(raw);}catch{fail();}
  if(url.protocol!=='https:'||url.hostname!=='account.2gis.com'||url.port||url.username||url.password||/[\\\s]/.test(raw)||
    !url.pathname.startsWith('/orgs/'+org+'/')||!/^\/orgs\/\d+\/[A-Za-z0-9_/-]*$/.test(url.pathname))fail('ORG_MISMATCH',409);
  const allowed=new Set(['period','dateFrom','dateTo','from','to','sectionId','subsectionId','id','tab','demandPeriod','demandGroup','demandRubrics']);
  for(const [key,value]of url.searchParams)if(!allowed.has(key)||value.length>100||/[\u0000-\u001f]/.test(value))fail();
  if(url.hash)fail();return url.href;
}
function createPlatformDemand(db,{now=()=>Date.now()}={}) {
  db.exec(`CREATE TABLE IF NOT EXISTS platform_demand_settings (
    company_code TEXT PRIMARY KEY,organization_id TEXT NOT NULL,organization_name TEXT NOT NULL,city TEXT NOT NULL,
    cabinet_url TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS platform_demand_datasets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,company_code TEXT NOT NULL,organization_id TEXT NOT NULL,organization_name TEXT NOT NULL,
      city TEXT NOT NULL,source_url TEXT NOT NULL,report_kind TEXT NOT NULL,period_start TEXT NOT NULL,period_end TEXT NOT NULL,
      granularity TEXT NOT NULL,captured_at TEXT NOT NULL,imported_at TEXT NOT NULL,original_filename TEXT,
      source_hash TEXT NOT NULL,rows_json TEXT NOT NULL,actor_id INTEGER,actor_name TEXT,UNIQUE(company_code,source_hash));
    CREATE INDEX IF NOT EXISTS platform_demand_scope ON platform_demand_datasets(company_code,organization_id,report_kind,captured_at);
    CREATE TABLE IF NOT EXISTS platform_demand_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,dataset_id INTEGER NOT NULL,company_code TEXT NOT NULL,captured_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,original_filename TEXT,actor_id INTEGER,actor_name TEXT);
    CREATE INDEX IF NOT EXISTS platform_demand_checks_latest ON platform_demand_checks(dataset_id,company_code,captured_at);
    CREATE TABLE IF NOT EXISTS platform_demand_category_state(company_code TEXT PRIMARY KEY,revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS platform_demand_categories (
      company_code TEXT NOT NULL,category_key TEXT NOT NULL,category TEXT NOT NULL,classification TEXT NOT NULL,reason TEXT NOT NULL,
      PRIMARY KEY(company_code,category_key));
    CREATE TABLE IF NOT EXISTS platform_demand_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,company_code TEXT NOT NULL,action TEXT NOT NULL,payload TEXT NOT NULL,
      actor_id INTEGER,actor_name TEXT,created_at TEXT NOT NULL);`);
  const stamp=()=>new Date(now()).toISOString();
  const transact=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}};
  const audit=(code,action,body,actor)=>db.prepare('INSERT INTO platform_demand_audit(company_code,action,payload,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?)').run(code,action,JSON.stringify(body),actor?.userId??null,actor?.userName??null,stamp());
  function company(code) {
    if(typeof code!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code))fail();
    const row=db.prepare('SELECT code,name FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get(code);
    if(!row)fail('NOT_FOUND',404);return row;
  }
  const settingsRow=code=>db.prepare('SELECT * FROM platform_demand_settings WHERE company_code=?').get(code);
  const settingsDto=row=>({revision:row?.revision??0,configured:Boolean(row),organizationId:row?.organization_id??'',
    organizationName:row?.organization_name??'',city:row?.city??'',cabinetUrl:row?.cabinet_url??'',collectionMode:'manual',canSync:false});
  function identity(settings,row) {return settings&&row.organization_id===settings.organization_id&&row.organization_name===settings.organization_name&&row.city===settings.city;}
  function rawRows(code,settings) {
    return settings?db.prepare(`SELECT * FROM platform_demand_datasets WHERE company_code=? AND organization_id=? AND organization_name=? AND city=?
      ORDER BY (SELECT MAX(captured_at) FROM platform_demand_checks WHERE dataset_id=platform_demand_datasets.id AND company_code=platform_demand_datasets.company_code) DESC,captured_at DESC,id DESC`)
      .all(code,settings.organization_id,settings.organization_name,settings.city):[];
  }
  function classes(code) {return db.prepare('SELECT category_key,category,classification,reason FROM platform_demand_categories WHERE company_code=? ORDER BY category').all(code);}
  function categoryDto(code,datasets=[]) {
    const rows=classes(code),known=new Set(rows.map(row=>row.category_key));
    for(const dataset of datasets)for(const row of JSON.parse(dataset.rows_json))if(!aggregate(row.category)&&!known.has(norm(row.category))){
      rows.push({category_key:norm(row.category),category:row.category,classification:'unclassified',reason:''});known.add(norm(row.category));}
    return {revision:db.prepare('SELECT revision FROM platform_demand_category_state WHERE company_code=?').get(code)?.revision??0,
      items:rows.map(({category,classification,reason})=>({category,classification,reason})).sort((a,b)=>a.category.localeCompare(b.category,'ru'))};
  }
  function datasetDto(row,withRows=true) {
    const out={id:row.id,companyCode:row.company_code,organizationId:row.organization_id,organizationName:row.organization_name,city:row.city,
      sourceUrl:row.source_url,reportKind:row.report_kind,periodStart:row.period_start,periodEnd:row.period_end,granularity:row.granularity,
      capturedAt:row.captured_at,importedAt:row.imported_at,originalFilename:row.original_filename,sourceHash:row.source_hash,
      sourceHashKind:'structured-report-sha256',importedBy:row.actor_id?{userId:row.actor_id,name:row.actor_name}:null,
      lastCheckedAt:db.prepare('SELECT MAX(captured_at) AS latest FROM platform_demand_checks WHERE dataset_id=? AND company_code=?').get(row.id,row.company_code).latest||row.captured_at};
    if(withRows){const mapping=new Map(classes(row.company_code).map(item=>[item.category_key,item.classification]));
      out.rows=JSON.parse(row.rows_json).map(item=>({...item,isAggregate:aggregate(item.category),classification:aggregate(item.category)?'unclassified':mapping.get(norm(item.category))||'unclassified'}));}
    return out;
  }
  function summary(datasets) {
    const periods=[];
    for(const dataset of datasets){const groups=new Map();for(const row of dataset.rows){const key=[row.periodStart,row.periodEnd,row.metric].join('|');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
      for(const rows of groups.values()){
        const first=rows[0],all=rows.find(row=>row.isAggregate),sum=classification=>{const selected=rows.filter(row=>!row.isAggregate&&row.classification===classification);return first.metric==='searches'&&selected.length?selected.reduce((n,row)=>n+row.value,0):null;};
        periods.push({datasetId:dataset.id,reportKind:dataset.reportKind,periodStart:first.periodStart,periodEnd:first.periodEnd,metric:first.metric,
          total:all?.value??null,target:sum('target'),nonTarget:sum('non_target'),unclassified:sum('unclassified'),partial:rows.some(row=>row.partial)});
      }
    }
    return {available:Boolean(datasets.length),latestCapturedAt:datasets.map(row=>row.lastCheckedAt).sort().at(-1)||null,periods,
      note:'Это показатели спроса 2ГИС, а не заявки и не число уникальных людей. Суммы рубрик могут включать пересечения. Проценты не суммируются; неполные периоды отмечены отдельно.'};
  }
  function get(code) {
    const current=company(code),settings=settingsRow(current.code),history=rawRows(current.code,settings),seen=new Set(),latest=[];
    for(const row of history)if(!seen.has(row.report_kind)){seen.add(row.report_kind);latest.push(row);}
    const datasets=latest.map(row=>datasetDto(row));
    return {company:{code:current.code,name:current.name},settings:settingsDto(settings),datasets,categories:categoryDto(current.code,latest),
      summary:summary(datasets),history:history.slice(0,20).map(row=>datasetDto(row,false)),historyTotal:history.length};
  }
  function getDataset(code,id) {
    const current=company(code);if(!Number.isSafeInteger(Number(id))||Number(id)<1)fail();
    const row=db.prepare('SELECT * FROM platform_demand_datasets WHERE company_code=? AND id=?').get(current.code,Number(id));
    if(!row||!identity(settingsRow(current.code),row))fail('NOT_FOUND',404);return {dataset:datasetDto(row)};
  }
  function saveSettings(code,body,actor) {
    const current=company(code);object(body,['revision','organizationId','organizationName','city','cabinetUrl']);revision(body.revision);
    const org=organization(body.organizationId),name=text(body.organizationName,300),city=text(body.city,150),url=sourceUrl(body.cabinetUrl,org);
    return transact(()=>{const previous=settingsRow(current.code);if((previous?.revision??0)!==body.revision)fail('REVISION_CONFLICT',409);
      db.prepare(`INSERT INTO platform_demand_settings(company_code,organization_id,organization_name,city,cabinet_url,revision,updated_at) VALUES(?,?,?,?,?,1,?)
        ON CONFLICT(company_code) DO UPDATE SET organization_id=excluded.organization_id,organization_name=excluded.organization_name,city=excluded.city,cabinet_url=excluded.cabinet_url,revision=platform_demand_settings.revision+1,updated_at=excluded.updated_at`).run(current.code,org,name,city,url,stamp());
      audit(current.code,'settings',body,actor);return {settings:settingsDto(settingsRow(current.code))};});
  }
  function importDataset(code,body,actor) {
    const current=company(code);object(body,['organizationId','organizationName','city','sourceUrl','reportKind','periodStart','periodEnd','granularity','capturedAt','originalFilename','rows']);
    const org=organization(body.organizationId),name=text(body.organizationName,300),city=text(body.city,150),url=sourceUrl(body.sourceUrl,org);
    const kinds={rubric_demand:'searches',search_share:'share_percent'};if(typeof body.reportKind!=='string'||!Object.hasOwn(kinds,body.reportKind)||!['month','day','week','period'].includes(body.granularity))fail();
    const start=date(body.periodStart),end=date(body.periodEnd),captured=timestamp(body.capturedAt);if(start>end||Date.parse(captured)>now()+300000)fail();
    const filename=body.originalFilename===undefined?null:text(body.originalFilename,255,false)||null;if(filename&&/[\\/]/.test(filename))fail();
    if(!Array.isArray(body.rows)||!body.rows.length||body.rows.length>2000)fail();
    const seen=new Set(),rows=body.rows.map(row=>{
      object(row,['periodStart','periodEnd','category','metric','value','partial']);
      const rowStart=date(row.periodStart),rowEnd=date(row.periodEnd),category=text(row.category,200),metric=row.metric;
      if(rowStart>rowEnd||rowStart<start||rowEnd>end||metric!==kinds[body.reportKind]||typeof row.partial!=='boolean')fail();
      const length=(Date.parse(rowEnd)-Date.parse(rowStart))/86400000;
      if((body.granularity==='day'&&length!==0)||(body.granularity==='week'&&length>6)||(body.granularity==='month'&&rowStart.slice(0,7)!==rowEnd.slice(0,7)))fail();
      if(typeof row.value!=='number'||!Number.isFinite(row.value)||row.value<0||row.value>(metric==='searches'?1e12:100)||(metric==='searches'&&!Number.isSafeInteger(row.value)))fail();
      if(rowEnd>captured.slice(0,10)&&!row.partial)fail();
      const key=[rowStart,rowEnd,norm(category),metric].join('|');if(seen.has(key))fail();seen.add(key);
      return {periodStart:rowStart,periodEnd:rowEnd,category,metric,value:row.value,partial:row.partial};
    }).sort((a,b)=>JSON.stringify([a.periodStart,a.periodEnd,norm(a.category),a.metric]).localeCompare(JSON.stringify([b.periodStart,b.periodEnd,norm(b.category),b.metric])));
    // Capture date and filename are observations of a report, not new demand.
    const fingerprint=createHash('sha256').update(JSON.stringify({companyCode:current.code,org,name,city,reportKind:body.reportKind,start,end,granularity:body.granularity,
      rows:rows.map(row=>({...row,category:norm(row.category)}))})).digest('hex');
    return transact(()=>{
      const config=settingsRow(current.code);if(!config)fail('CONFIGURATION_REQUIRED',409);
      if(config.organization_id!==org||config.organization_name!==name||config.city!==city)fail('ORG_MISMATCH',409);
      const at=stamp(),inserted=db.prepare(`INSERT INTO platform_demand_datasets(company_code,organization_id,organization_name,city,source_url,report_kind,period_start,period_end,granularity,captured_at,imported_at,original_filename,source_hash,rows_json,actor_id,actor_name)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(company_code,source_hash) DO NOTHING`).run(current.code,org,name,city,url,body.reportKind,start,end,body.granularity,captured,at,filename,fingerprint,JSON.stringify(rows),actor?.userId??null,actor?.userName??null).changes;
      const row=db.prepare('SELECT * FROM platform_demand_datasets WHERE company_code=? AND source_hash=?').get(current.code,fingerprint);
      db.prepare('INSERT INTO platform_demand_checks(dataset_id,company_code,captured_at,recorded_at,original_filename,actor_id,actor_name) VALUES(?,?,?,?,?,?,?)').run(row.id,current.code,captured,at,filename,actor?.userId??null,actor?.userName??null);
      audit(current.code,inserted?'import':'duplicate_checked',{datasetId:row.id,sourceHash:fingerprint,capturedAt:captured,sourceUrl:url},actor);
      return {dataset:datasetDto(row),duplicate:!inserted};
    });
  }
  function saveCategories(code,body,actor) {
    const current=company(code);object(body,['revision','items']);revision(body.revision);
    if(!Array.isArray(body.items)||body.items.length>500)fail();const seen=new Set(),items=body.items.map(row=>{
      object(row,['category','classification','reason']);const category=text(row.category,200),key=norm(category);
      if(aggregate(category)||seen.has(key)||!['target','non_target','unclassified'].includes(row.classification))fail();seen.add(key);
      return {category,key,classification:row.classification,reason:text(row.reason??'',2000,false)};
    });
    return transact(()=>{
      const old=db.prepare('SELECT revision FROM platform_demand_category_state WHERE company_code=?').get(current.code)?.revision??0;if(old!==body.revision)fail('REVISION_CONFLICT',409);
      for(const row of items)db.prepare(`INSERT INTO platform_demand_categories(company_code,category_key,category,classification,reason) VALUES(?,?,?,?,?)
        ON CONFLICT(company_code,category_key) DO UPDATE SET category=excluded.category,classification=excluded.classification,reason=excluded.reason`).run(current.code,row.key,row.category,row.classification,row.reason);
      db.prepare('INSERT INTO platform_demand_category_state(company_code,revision) VALUES(?,1) ON CONFLICT(company_code) DO UPDATE SET revision=revision+1').run(current.code);
      audit(current.code,'classifications',{revision:body.revision+1,items},actor);
      return {categories:get(current.code).categories};
    });
  }
  function potential(code,from,to) {
    // Спрос 2ГИС для ступени «Потенциал» сквозной аналитики. Берутся строки «Спрос по рубрикам» из ВСЕЙ
    // истории снимков организации: для каждого периода побеждает последняя проверенная выгрузка (исправления
    // не удваивают числа, старые периоды не пропадают после новой выгрузки). Учитываются только периоды,
    // целиком лежащие внутри [from,to]; перекрывающиеся периоды разной детализации не суммируются.
    // Отсутствующая рубрика в периоде не превращается в ноль — итог за период становится неизвестным.
    const current=company(code),requestedFrom=date(from),requestedTo=date(to);if(requestedFrom>requestedTo)fail();
    const settings=settingsRow(current.code),history=rawRows(current.code,settings).filter(row=>row.report_kind==='rubric_demand');
    const base={company:{code:current.code,name:current.name},organization:settings?{id:settings.organization_id,name:settings.organization_name,city:settings.city}:null,
      requested:{from:requestedFrom,to:requestedTo},metric:'searches',unit:'поиски по рубрикам 2ГИС',kind:'snapshot',
      note:'Поиски по рубрикам 2ГИС показывают интерес к услугам в городе, а не заявки и записи. Одна и та же сессия может попасть в несколько рубрик, поэтому суммы рубрик — не число уникальных людей. Целевой спрос считается только по рубрикам, отмеченным как целевые.'};
    const empty={available:false,datasetIds:[],capturedAt:null,granularities:[],availablePeriod:null,covered:null,uncovered:[{from:requestedFrom,to:requestedTo}],complete:false,partial:false,
      suggested:null,totals:{all:null,target:null,nonTarget:null,unclassified:null},unclassifiedCategories:[],missingCategories:[],excluded:[],periods:[]};
    if(!history.length)return {...base,...empty};
    const datasets=history.map(row=>datasetDto(row));// rawRows: самая свежая проверка первой
    const byPeriod=new Map();// период → строки из самого свежего снимка, где этот период есть
    for(const dataset of datasets)for(const row of dataset.rows){if(row.metric!=='searches')continue;const key=row.periodStart+'|'+row.periodEnd;
      if(!byPeriod.has(key))byPeriod.set(key,{periodStart:row.periodStart,periodEnd:row.periodEnd,datasetId:dataset.id,capturedAt:dataset.lastCheckedAt,granularity:dataset.granularity,rows:[]});
      const bucket=byPeriod.get(key);if(bucket.datasetId===dataset.id)bucket.rows.push(row);}
    const all=[...byPeriod.values()].sort((a,b)=>a.periodStart.localeCompare(b.periodStart)||b.periodEnd.localeCompare(a.periodEnd));
    const span=item=>Date.parse(item.periodEnd)-Date.parse(item.periodStart);
    const overlaps=(a,b)=>a.periodStart<=b.periodEnd&&b.periodStart<=a.periodEnd;
    const inside=all.filter(item=>item.periodStart>=requestedFrom&&item.periodEnd<=requestedTo);
    // Перекрытия: остаётся более широкий период (месяц важнее недели внутри него), остальное — в excluded с происхождением.
    const chosen=[],excluded=[];
    for(const item of [...inside].sort((a,b)=>span(b)-span(a)||b.capturedAt.localeCompare(a.capturedAt))){
      const clash=chosen.find(other=>overlaps(other,item));
      if(clash)excluded.push({periodStart:item.periodStart,periodEnd:item.periodEnd,granularity:item.granularity,datasetId:item.datasetId,reason:'перекрывается с периодом '+clash.periodStart+' — '+clash.periodEnd});
      else chosen.push(item);}
    chosen.sort((a,b)=>a.periodStart.localeCompare(b.periodStart));
    // Ожидаемый состав рубрик — сохранённая классификация компании ПЛЮС рубрики из выбранных строк.
    // Каждая ожидаемая рубрика проверяется в каждом периоде: настроенная целевая рубрика без строки
    // делает целевой итог периода неизвестным, а не нулём.
    const names=new Map(),expected={target:new Set(),nonTarget:new Set(),unclassified:new Set()};
    const bucketOf=classification=>classification==='target'?expected.target:classification==='non_target'?expected.nonTarget:expected.unclassified;
    for(const saved of classes(current.code)){names.set(saved.category_key,saved.category);bucketOf(saved.classification).add(saved.category_key);}
    for(const item of chosen)for(const row of item.rows)if(!row.isAggregate){const key=norm(row.category);if(!names.has(key))names.set(key,row.category);bucketOf(row.classification).add(key);}
    const periods=chosen.map(item=>{
      const present=new Set(item.rows.filter(row=>!row.isAggregate).map(row=>norm(row.category)));
      const missing=[...new Set([...expected.target,...expected.nonTarget,...expected.unclassified].filter(key=>!present.has(key)))];
      const sum=(keys,classification)=>{if(!keys.size)return null;if([...keys].some(key=>!present.has(key)))return null;return item.rows.filter(row=>!row.isAggregate&&row.classification===classification).reduce((n,row)=>n+row.value,0);};
      return {periodStart:item.periodStart,periodEnd:item.periodEnd,granularity:item.granularity,datasetId:item.datasetId,capturedAt:item.capturedAt,partial:item.rows.some(row=>row.partial),
        missingCategories:missing.map(key=>names.get(key)||key).sort((a,b)=>a.localeCompare(b,'ru')),
        all:item.rows.find(row=>row.isAggregate)?.value??null,target:sum(expected.target,'target'),nonTarget:sum(expected.nonTarget,'non_target'),unclassified:sum(expected.unclassified,'unclassified')};});
    const totals=key=>periods.length&&periods.every(period=>period[key]!==null)?periods.reduce((n,period)=>n+period[key],0):null;
    const nextDay=value=>new Date(Date.parse(value)+86400000).toISOString().slice(0,10),prevDay=value=>new Date(Date.parse(value)-86400000).toISOString().slice(0,10);
    const uncovered=[];let cursor=requestedFrom;
    for(const period of periods){if(period.periodStart>cursor)uncovered.push({from:cursor,to:prevDay(period.periodStart)});cursor=nextDay(period.periodEnd);}
    if(cursor<=requestedTo)uncovered.push({from:cursor,to:requestedTo});
    const covered=periods.length?{from:periods[0].periodStart,to:periods.at(-1).periodEnd}:null;
    const missingCategories=[...new Set(periods.flatMap(period=>period.missingCategories))];
    const complete=periods.length>0&&uncovered.length===0&&missingCategories.length===0;
    const unclassifiedCategories=[...new Set(chosen.flatMap(item=>item.rows.filter(row=>!row.isAggregate&&row.classification==='unclassified').map(row=>row.category)))].sort((a,b)=>a.localeCompare(b,'ru'));
    const overlapping=all.filter(item=>overlaps(item,{periodStart:requestedFrom,periodEnd:requestedTo}));
    const suggested=overlapping.length&&!complete?{from:overlapping.map(item=>item.periodStart).sort()[0],to:overlapping.map(item=>item.periodEnd).sort().at(-1),
      granularities:[...new Set(overlapping.map(item=>item.granularity))],partial:overlapping.some(item=>item.rows.some(row=>row.partial))}:null;
    return {...base,available:true,datasetIds:[...new Set(periods.map(period=>period.datasetId))],capturedAt:periods.map(period=>period.capturedAt).sort().at(-1)||datasets[0].lastCheckedAt,
      granularities:[...new Set(periods.map(period=>period.granularity))],availablePeriod:{from:all[0].periodStart,to:all.map(item=>item.periodEnd).sort().at(-1)},
      covered,uncovered,complete,partial:periods.some(period=>period.partial),suggested,
      totals:{all:totals('all'),target:totals('target'),nonTarget:totals('nonTarget'),unclassified:totals('unclassified')},unclassifiedCategories,missingCategories,excluded,periods};
  }
  return {get,getDataset,saveSettings,importDataset,saveCategories,potential};
}
module.exports={createPlatformDemand,PLATFORM_DEMAND_ERRORS:ERRORS};

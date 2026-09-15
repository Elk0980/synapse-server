'use strict';
const {randomUUID,createHash}=require('node:crypto');
const STAGES = [
  {code:'new',label:'Новая',steps:['Найти контакт, принимающий решение','Связаться и подтвердить запрос','Назначить разговор о задаче'],done:'Есть ответственный контакт и дата разговора'},
  {code:'brief',label:'Бриф',steps:['Заполнить цель, аудиторию и ограничения','Зафиксировать исходные показатели и желаемый результат','Согласовать критерии приёмки и срок'],done:'Клиент подтвердил задачу и измеримый результат'},
  {code:'proposal',label:'Предложение',steps:['Подобрать модули под задачу','Составить смету и календарный план','Обсудить предложение с клиентом'],done:'Состав работ, цена и срок согласованы'},
  {code:'contract',label:'Договор и оплата',steps:['Проверить реквизиты и согласовать документы','Подготовить счёт и зафиксировать условия оплаты','Подтвердить оплату и дату старта'],done:'Есть согласованные документы и основание начать работы'},
  {code:'implementation',label:'Внедрение',steps:['Получить доступы и материалы','Настроить приобретённые модули','Проверить сценарии с клиентом и устранить замечания'],done:'Согласованные сценарии работают, клиент готов к запуску'},
  {code:'active',label:'Сопровождение',steps:['Провести запуск и обучить команду','Сверять фактические показатели с брифом','Зафиксировать следующий контакт и улучшения'],done:'Результат подтверждён или согласован следующий период'},
  {code:'completed',label:'Завершена',steps:['Сверить результат с критериями приёмки','Передать материалы и закрывающие документы','Получить обратную связь и согласовать дальнейшую работу'],done:'Клиент принял результат, документы и расчёты закрыты'},
  {code:'lost',label:'Отказ',steps:['Записать причину отказа','Уточнить, возможен ли возврат к задаче','Согласовать допустимую дату следующего контакта'],done:'Причина и дальнейшие действия зафиксированы'}
];
const MODULE_STAGES=['not_started','access','configuration','testing','launched','support'];
const esc = value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function createDealOrders({db,fail,getStages,getPipelines,setStages,getCatalog}) {
  db.exec(`CREATE TABLE IF NOT EXISTS deal_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL REFERENCES companies(id),
    owner_scope TEXT NOT NULL, title TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'new',
    data TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1,
    request_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(owner_scope,request_id)
  ); CREATE INDEX IF NOT EXISTS deal_orders_scope ON deal_orders(owner_scope,updated_at);
  CREATE TABLE IF NOT EXISTS deal_stage_rules (owner_scope TEXT NOT NULL,pipeline TEXT NOT NULL,stage TEXT NOT NULL,rules TEXT NOT NULL,PRIMARY KEY(owner_scope,pipeline,stage));
  CREATE TABLE IF NOT EXISTS deal_order_events (id INTEGER PRIMARY KEY,deal_id INTEGER NOT NULL REFERENCES deal_orders(id),created_at TEXT NOT NULL,event TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS deal_order_files (id TEXT PRIMARY KEY,deal_id INTEGER NOT NULL REFERENCES deal_orders(id),kind TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,bytes BLOB NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS deal_participants (deal_id INTEGER NOT NULL REFERENCES deal_orders(id),contact_id INTEGER NOT NULL REFERENCES contacts(id),role TEXT NOT NULL,side TEXT NOT NULL DEFAULT 'client',PRIMARY KEY(deal_id,contact_id));
  CREATE TABLE IF NOT EXISTS deal_company_pipelines (owner_scope TEXT NOT NULL,pipeline TEXT NOT NULL,label TEXT NOT NULL,stages TEXT NOT NULL,PRIMARY KEY(owner_scope,pipeline));
  CREATE TABLE IF NOT EXISTS deal_orders_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  if(!db.prepare("SELECT 1 FROM deal_orders_meta WHERE key='company-migration'").get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const companies=db.prepare('SELECT DISTINCT c.id,c.name,c.owner_scope FROM companies c JOIN company_pipeline_state s ON s.company_id=c.id WHERE c.is_deleted=0').all();
      const now=new Date().toISOString();
      for(const c of companies){
        const pipelineStates=Object.fromEntries(db.prepare('SELECT p.code,s.stage_code FROM company_pipeline_state s JOIN pipelines p ON p.id=s.pipeline_id WHERE s.company_id=?').all(c.id).map(s=>[s.code,s.stage_code]));
        db.prepare('INSERT OR IGNORE INTO deal_orders (company_id,owner_scope,title,stage,data,request_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(c.id,c.owner_scope,`Основная сделка — ${c.name}`,pipelineStates.sale||'new',JSON.stringify({pipelineStates}),`company-migration-${c.id}`,now,now);
      }
      db.prepare("INSERT INTO deal_orders_meta VALUES ('company-migration','1')").run();db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  const bad=message=>fail(400,message,{code:'VALIDATION_ERROR'});
  const text=(value,max=4000)=>{if(typeof value!=='string'||value.length>max)bad('Проверьте текстовые поля');return value.trim();};
  const num=(v,max=1e9)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>max)bad('Проверьте сумму и количество');return v;};
  const day=v=>{if(!v)return ''; const s=text(v,10),d=new Date(s+'T00:00:00Z');if(!/^\d{4}-\d\d-\d\d$/.test(s)||!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==s)bad('Некорректная дата');return s;};
  const url=v=>{if(!v)return '';const s=text(v,2000);let parsed;try{parsed=new URL(s);}catch{bad('Некорректная ссылка документа');}if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)bad('Нужна HTTP(S)-ссылка без пароля');return s;};
  const list=(v,max,fn)=>{if(!Array.isArray(v)||v.length>max)bad('Слишком много строк');return v.map(fn);};
  const stringFields=(value,fields)=>{
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!fields.includes(k)))bad('Неизвестное поле');
    return Object.fromEntries(fields.map(k=>[k,text(value[k]??'')]));
  };
  const normalize=body=>{
    if(!body||typeof body!=='object'||Array.isArray(body))bad('Нужен объект сделки');
    const allowed=['description','nextAction','nextDate','brief','metrics','estimate','modules','documents','invoices','stageNotes','checks'];
    if(Object.keys(body).some(k=>!allowed.includes(k)))bad('Неизвестное поле сделки');
    const out={};
    for(const k of ['description','nextAction'])if(k in body)out[k]=text(body[k]);
    if('nextDate'in body)out.nextDate=day(body.nextDate);
    if('stageNotes'in body){out.stageNotes={};for(const [k,v]of Object.entries(body.stageNotes||{})){if(!/^[a-z0-9_-]+:[a-z0-9_-]+$/i.test(k))bad('Неизвестный этап');out.stageNotes[k]=text(v);}}
    if('checks'in body){out.checks={};for(const[k,v]of Object.entries(body.checks||{})){if(!/^manual-[a-f0-9]{16}$/.test(k)||typeof v!=='boolean')bad('Неизвестный критерий');out.checks[k]=v;}}
    if('brief'in body)out.brief=stringFields(body.brief,['goal','audience','problem','scope','constraints','acceptance','owner','deadline']);
    if('metrics'in body)out.metrics=list(body.metrics,30,v=>({...stringFields(v,['name','baseline','target','current','unit','due','source']),due:day(v.due)}));
    if('estimate'in body)out.estimate=list(body.estimate,100,v=>({name:text(v.name,300),quantity:num(v.quantity,1e6),price:num(v.price),billing:v.billing==='monthly'?'monthly':'once'}));
    if('modules'in body)out.modules=list(body.modules,40,v=>{
      if(!MODULE_STAGES.includes(v.stage)||!['planned','purchased'].includes(v.purchase))bad('Неизвестный статус модуля');
      return {productId:text(v.productId||'',100),name:text(v.name,150),purchase:v.purchase,stage:v.stage,owner:text(v.owner||'',200),due:day(v.due),notes:text(v.notes||'')};
    });
    if('documents'in body)out.documents=list(body.documents,50,v=>({title:text(v.title,300),url:url(v.url),status:text(v.status||'Черновик',100)}));
    if('invoices'in body)out.invoices=list(body.invoices,50,v=>{
      if(!['draft','issued','paid','cancelled'].includes(v.status))bad('Неизвестный статус счёта');
      return {id:text(v.id,100),number:text(v.number,100),amount:num(v.amount),date:day(v.date),due:day(v.due),status:v.status,
        seller:text(v.seller||''),buyer:text(v.buyer||''),purpose:text(v.purpose||''),notes:text(v.notes||'')};
    });
    return out;
  };
  const total=(data,billing='once')=>Math.round((data.estimate||[]).filter(r=>(r.billing||'once')===billing).reduce((sum,row)=>sum+Math.round(row.price*100)*row.quantity,0))/100;
  const criterionLabels={contact:'Назначен участник сделки со стороны клиента',brief:'Заполнены цель и критерии приёмки',estimate:'Есть смета с суммой',contract:'Прикреплён договор',receipt:'Прикреплён чек',modules_ready:'Приобретённые модули проверены и запущены'};
  const baseStages=(scope,pipeline='sale')=>{
    const stored=db.prepare('SELECT stages FROM deal_company_pipelines WHERE owner_scope=? AND pipeline=?').get(scope||'synapse-business',pipeline);
    return stored?JSON.parse(stored.stages):getStages(pipeline);
  };
  const pipelines=scope=>getPipelines().map(p=>({...p,label:db.prepare('SELECT label FROM deal_company_pipelines WHERE owner_scope=? AND pipeline=?').get(scope||'synapse-business',p.code)?.label||p.label}));
  const pipelineStages=(scope,pipeline='sale')=>baseStages(scope,pipeline).map(s=>{
    const stored=db.prepare('SELECT rules FROM deal_stage_rules WHERE owner_scope=? AND pipeline=? AND stage=?').get(scope||'synapse-business',pipeline,s.code);
    const defaults=({contact:['contact'],meeting:['contact','brief'],pilot:['brief','estimate'],paid:['contract','receipt'],active:['contract','receipt','modules_ready'],renewal:['brief'],upsell:['brief','estimate']})[s.code]||[];
    const rules=stored?JSON.parse(stored.rules):{required:defaults,manual:[]};
    if(s.kind==='won'||(pipeline==='sale'&&s.code==='paid'))rules.required=[...new Set([...rules.required,'contract','receipt'])];
    const guide=STAGES.find(g=>g.code===s.code)||STAGES.find(g=>g.code===({meeting:'brief',pilot:'implementation',paid:'contract',onboarding:'implementation',renewal:'active',upsell:'proposal',risk:'active',rejected:'lost',churned:'lost'})[s.code]);
    return {...s,color:rules.color||'#8ab4f8',steps:rules.steps||guide?.steps||['Уточнить задачу клиента','Выполнить обязательные критерии этапа','Согласовать следующий шаг'],done:rules.done||guide?.done||'Выполнены обязательные критерии',rules,
      criteria:[...rules.required.map(type=>({id:type,type,label:criterionLabels[type]})),...rules.manual.map(label=>({id:'manual-'+createHash('sha256').update(pipeline+':'+s.code+':'+label).digest('hex').slice(0,16),type:'manual',label}))]};
  });
  const serialize=(row,pipeline='sale')=>{const data=JSON.parse(row.data);return {id:row.id,companyId:row.company_id,companyName:row.company_name,title:row.title,...data,pipeline,stage:data.pipelineStates?.[pipeline]||(pipeline==='sale'?row.stage:null),total:total(data),monthlyTotal:total(data,'monthly'),version:row.version,createdAt:row.created_at,updatedAt:row.updated_at};};
  const company=(id,scope)=>{
    const row=db.prepare('SELECT * FROM companies WHERE id=? AND is_deleted=0').get(id);
    if(!row || (scope && row.code.toLowerCase()!==scope.toLowerCase() && row.owner_scope.toLowerCase()!==scope.toLowerCase()))fail(404,'Компания недоступна');
    return row;
  };
  const row=(id,scope)=>{
    const result=db.prepare('SELECT d.*,c.name company_name FROM deal_orders d JOIN companies c ON c.id=d.company_id WHERE d.id=?').get(id);
    if(!result || scope && result.owner_scope.toLowerCase()!==scope.toLowerCase())fail(404,'Сделка не найдена');
    company(result.company_id,scope); return result;
  };
  const contacts=(id,scope,q='',offset=0)=>{
    const deal=row(id,scope),pattern=`%${text(q,200)}%`;
    const where='FROM contacts c JOIN deal_participants r ON r.contact_id=c.id WHERE r.deal_id=? AND c.is_deleted=0 AND (c.name LIKE ? OR c.phone LIKE ?)';
    const args=[deal.id,pattern,pattern];
    const items=db.prepare(`SELECT c.id,c.name,c.phone,c.email,c.messengers,c.links,r.role,r.side ${where} ORDER BY c.name,c.id LIMIT 30 OFFSET ?`).all(...args,offset).map(c=>({...c,messengers:JSON.parse(c.messengers||'[]'),links:JSON.parse(c.links||'[]')}));
    return {contacts:items,total:db.prepare(`SELECT COUNT(*) count ${where}`).get(...args).count};
  };
  const participantCandidate=(contactId,scope)=>{
    const found=db.prepare(`SELECT c.id FROM contacts c JOIN contact_companies r ON r.contact_id=c.id JOIN companies base ON base.id=r.company_id WHERE c.id=? AND c.is_deleted=0 AND r.is_deleted=0 AND base.code=? COLLATE NOCASE AND base.is_deleted=0`).get(Number(contactId),scope||'synapse-business');
    if(!found)fail(404,'Контакт не найден в клиентской базе выбранной компании');
    return found.id;
  };
  const addParticipant=(id,scope,body)=>{
    row(id,scope);
    const contactId=participantCandidate(body.contactId,scope),role=text(body.role||'Представитель клиента',120),side=body.side||'client';
    if(!role||!['client','team'].includes(side))bad('Укажите роль и сторону участника');
    db.prepare('INSERT INTO deal_participants VALUES (?,?,?,?) ON CONFLICT(deal_id,contact_id) DO UPDATE SET role=excluded.role,side=excluded.side').run(id,contactId,role,side);
    return contacts(id,scope);
  };
  const removeParticipant=(id,scope,contactId)=>{row(id,scope);db.prepare('DELETE FROM deal_participants WHERE deal_id=? AND contact_id=?').run(id,contactId);return contacts(id,scope);};
  const criterionState=(value,scope,pipeline)=>{
    const data=JSON.parse(value.data),files=db.prepare('SELECT kind FROM deal_order_files WHERE deal_id=?').all(value.id);
    const checks={contact:!!db.prepare("SELECT 1 FROM deal_participants r JOIN contacts c ON c.id=r.contact_id WHERE r.deal_id=? AND r.side='client' AND c.is_deleted=0 LIMIT 1").get(value.id),
      brief:!!(data.brief?.goal?.trim()&&data.brief?.acceptance?.trim()),estimate:total(data)>0||total(data,'monthly')>0,
      contract:files.some(f=>f.kind==='contract'),receipt:files.some(f=>f.kind==='receipt'),
      modules_ready:(data.modules||[]).some(m=>m.purchase==='purchased')&&(data.modules||[]).filter(m=>m.purchase==='purchased').every(m=>['launched','support'].includes(m.stage))};
    return pipelineStages(scope,pipeline).map(s=>({...s,criteria:s.criteria.map(c=>({...c,met:c.type==='manual'?data.checks?.[c.id]===true:checks[c.type]===true}))}));
  };
  const detail=(id,scope,pipeline='sale')=>{
    const value=row(id,scope),c=company(value.company_id,scope);
    const people=contacts(id,scope);
    return {...serialize(value,pipeline),company:{id:c.id,name:c.name,code:c.code,city:c.city},contacts:people.contacts,totalContacts:people.total,stages:criterionState(value,scope,pipeline),pipelines:pipelines(scope),
      files:db.prepare('SELECT id,kind,name,mime,created_at createdAt FROM deal_order_files WHERE deal_id=? ORDER BY created_at DESC').all(id),history:db.prepare('SELECT created_at createdAt,event FROM deal_order_events WHERE deal_id=? ORDER BY id DESC LIMIT 50').all(id).map(e=>({...JSON.parse(e.event),createdAt:e.createdAt}))};
  };
  const listDeals=(scope,{q='',companyId='',offset=0,pipeline='sale'}={})=>{
    const conditions=[],args=[];
    if(scope){conditions.push('d.owner_scope=? COLLATE NOCASE');args.push(scope);}
    if(companyId){conditions.push('d.company_id=?');args.push(Number(companyId));}
    if(q){conditions.push('(d.title LIKE ? OR c.name LIKE ?)');args.push(`%${text(q,200)}%`,`%${text(q,200)}%`);}
    const where=`FROM deal_orders d JOIN companies c ON c.id=d.company_id WHERE c.is_deleted=0 ${conditions.length?'AND '+conditions.join(' AND '):''}`;
    return {deals:db.prepare(`SELECT d.*,c.name company_name ${where} ORDER BY d.updated_at DESC,d.id DESC LIMIT 50 OFFSET ?`).all(...args,offset).map(r=>serialize(r,pipeline)),total:db.prepare(`SELECT COUNT(*) count ${where}`).get(...args).count,stages:pipelineStages(scope,pipeline),pipelines:pipelines(scope)};
  };
  const create=(body,scope)=>{
    if(!body||Object.keys(body).some(k=>!['companyId','title','requestId','contactId'].includes(k)))bad('Неизвестное поле новой сделки');
    const title=text(body.title,300);if(!title)bad('Укажите название сделки');
    const c=company(Number(body.companyId),scope);
    const owner=scope||c.owner_scope||'synapse-business';
    const requestId=text(body.requestId||randomUUID(),100);
    const old=db.prepare('SELECT id FROM deal_orders WHERE owner_scope=? AND request_id=?').get(owner,requestId);
    if(old)return detail(old.id,scope);
    if(body.contactId)participantCandidate(body.contactId,scope);
    const now=new Date().toISOString();
    const first=baseStages(scope,'sale')[0]?.code||'new';
    const result=db.prepare('INSERT INTO deal_orders (company_id,owner_scope,title,stage,request_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(c.id,owner,title,first,requestId,now,now);
    if(body.contactId)addParticipant(Number(result.lastInsertRowid),scope,{contactId:body.contactId});
    return detail(Number(result.lastInsertRowid),scope);
  };
  const update=(id,body,scope,actor,pipeline='sale',trustedData={})=>{
    const old=row(id,scope);
    if(!body||Object.keys(body).some(k=>!['version','title','stage','data','override'].includes(k)))bad('Неизвестное поле изменения сделки');
    if(body.version!==old.version)fail(409,'Сделка уже изменена. Обновите карточку перед сохранением.',{code:'CONFLICT'});
    const title=body.title===undefined?old.title:text(body.title,300);if(!title)bad('Укажите название');
    const before=serialize(old,pipeline).stage;
    const stage=body.stage??before;if(stage!==null&&!baseStages(scope,pipeline).some(s=>s.code===stage))bad('Неизвестный этап');
    const data={...JSON.parse(old.data),...normalize(body.data||{}),...trustedData};
    let event;
    if(stage!==before){
      const missing=criterionState({...old,data:JSON.stringify(data)},scope,pipeline).find(s=>s.code===stage).criteria.filter(c=>!c.met);
      if(body.override?.accepted){if(actor?.role!=='owner')fail(403,'Переход под ответственность доступен только владельцу');if(text(body.override.reason||'').length<3)bad('Укажите причину перехода под вашу ответственность');}
      if(missing.length&&!body.override?.accepted)fail(409,'Не выполнены критерии: '+missing.map(c=>c.label).join('; '),{code:'STAGE_CRITERIA',missing});
      data.pipelineStates={...data.pipelineStates,[pipeline]:stage};
      event={pipeline,from:before,to:stage,actor:actor?.userName||'API',actorId:actor?.userId||null,override:!!body.override?.accepted,reason:body.override?.accepted?body.override.reason:'',missing:missing.map(c=>c.label)};
    }
    db.exec('BEGIN IMMEDIATE');try{
      const changed=db.prepare('UPDATE deal_orders SET title=?,stage=?,data=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(title,pipeline==='sale'?stage:old.stage,JSON.stringify(data),new Date().toISOString(),id,body.version);
      if(!changed.changes)fail(409,'Сделка уже изменена');
      if(event)db.prepare('INSERT INTO deal_order_events (deal_id,created_at,event) VALUES (?,?,?)').run(id,new Date().toISOString(),JSON.stringify(event));
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    return detail(id,scope,pipeline);
  };
  const offer=(id,scope,body,actor,pipeline)=>{
    const current=detail(id,scope,pipeline),catalog=getCatalog();let products,estimate,label,terms;
    if(body.type==='package'){
      const pack=catalog.packages.find(p=>p.id===body.itemId);if(!pack||pack.status!=='available')bad('Пакет не готов к предложению');
      products=pack.lines.map(l=>catalog.products.find(p=>p.id===l.productId));label=pack.name;terms=pack.terms;
      estimate=[{name:label+' — разовая часть',quantity:1,price:pack.priceOnce,billing:'once'},{name:label+' — ежемесячная часть',quantity:1,price:pack.priceMonthly,billing:'monthly'}].filter(r=>r.price>0);
    }else if(body.type==='product'){
      const product=catalog.products.find(p=>p.id===body.itemId);if(!product||product.status!=='available'||product.price===null)bad('Модуль пока не готов к предложению');products=[product];label=product.name;terms=product.term+'; '+product.support;estimate=[{name:product.name,quantity:1,price:product.price,billing:product.billing}];
    }else bad('Выберите модуль или пакет');
    const available=new Set([...products.map(p=>p.id),...(current.modules||[]).filter(m=>m.purchase==='purchased').map(m=>m.productId||catalog.products.find(p=>p.name===m.name)?.id)]);
    const missing=products.flatMap(p=>p.dependencies).filter(key=>!available.has(key));if(missing.length)bad('Сначала добавьте обязательные модули: '+[...new Set(missing)].map(key=>catalog.products.find(p=>p.id===key)?.name||key).join(', '));
    const modules=[...(current.modules||[])];for(const p of products)if(!modules.some(m=>m.productId===p.id||m.name===p.name))modules.push({productId:p.id,name:p.name,purchase:'planned',stage:'not_started',owner:'',due:'',notes:p.delivery+'\n'+p.steps.map((step,i)=>(i+1)+'. '+step).join('\n')});
    return update(id,{version:body.version,data:{estimate,modules}},scope,actor,pipeline,{offer:{type:body.type,itemId:body.itemId,label,terms,catalogVersion:catalog.version,createdAt:new Date().toISOString()}});
  };
  const saveRules=(scope,pipeline,body,actor)=>{
    if(actor?.role!=='owner')fail(403,'Критерии настраивает владелец');
    if(!Array.isArray(body.stages))bad('Нужны критерии этапов');
    if(body.stages.length<1||body.stages.length>30)bad('Нужно от 1 до 30 этапов');
    const rows=body.stages.map(s=>{
      if(!Array.isArray(s.required)||s.required.some(k=>!Object.hasOwn(criterionLabels,k)))bad('Неизвестный критерий');
      if(!/^#[0-9a-f]{6}$/i.test(s.color||''))bad('Неверный цвет этапа');
      return {...s,required:[...new Set(s.required)],manual:list(s.manual||[],15,v=>text(v,300)).filter(Boolean),steps:list(s.steps||[],20,v=>text(v,500)).filter(Boolean),done:text(s.done||'',500)};
    });
    db.exec('BEGIN IMMEDIATE');try{
      const old=baseStages(scope,pipeline), codes=new Set();
      const configured=rows.map((s,index)=>{
        const code=s.code||'stage_'+randomUUID().replaceAll('-','').slice(0,12);
        const label=text(s.label,80);
        if(!/^[a-z0-9_-]{1,64}$/.test(code)||codes.has(code)||!label||!['open','won','lost'].includes(s.kind))bad('Проверьте название, код и тип этапа');
        codes.add(code);return {code,label,kind:s.kind,attention:!!s.attention,position:index};
      });
      const removed=old.filter(stage=>!codes.has(stage.code));
      const deals=db.prepare('SELECT stage,data FROM deal_orders WHERE owner_scope=?').all(scope||'synapse-business');
      for(const stage of removed)if(deals.some(d=>(JSON.parse(d.data).pipelineStates?.[pipeline]||(pipeline==='sale'?d.stage:null))===stage.code))fail(409,'Нельзя удалить этап, пока в нём есть сделки');
      const label=body.label===undefined?pipelines(scope).find(p=>p.code===pipeline)?.label:text(body.label,40);
      if(!label)bad('Укажите название воронки');
      db.prepare('INSERT INTO deal_company_pipelines VALUES (?,?,?,?) ON CONFLICT(owner_scope,pipeline) DO UPDATE SET label=excluded.label,stages=excluded.stages').run(scope||'synapse-business',pipeline,label,JSON.stringify(configured));
      for(let i=0;i<rows.length;i++)db.prepare('INSERT INTO deal_stage_rules VALUES (?,?,?,?) ON CONFLICT(owner_scope,pipeline,stage) DO UPDATE SET rules=excluded.rules').run(scope||'synapse-business',pipeline,configured[i].code,JSON.stringify(rows[i]));
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    return {stages:pipelineStages(scope,pipeline),criterionLabels};
  };
  const upload=(id,scope,body)=>{
    row(id,scope);if(!['contract','receipt','other'].includes(body.kind))bad('Выберите тип файла');
    const name=text(body.name,200);if(!name)bad('Нужно название файла');
    const mime=text(body.mime,100);if(!['application/pdf','image/png','image/jpeg','application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(mime))bad('Допустимы PDF, PNG, JPG и DOCX');
    if(typeof body.base64!=='string'||body.base64.length>8*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(body.base64))bad('Файл не должен превышать 6 МБ');
    const bytes=Buffer.from(body.base64,'base64');if(!bytes.length||bytes.length>6*1024*1024)bad('Файл пустой или больше 6 МБ');
    const valid=mime==='application/pdf'?bytes.subarray(0,5).toString()==='%PDF-':mime==='image/png'?bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a':mime==='image/jpeg'?bytes.subarray(0,3).toString('hex')==='ffd8ff':bytes.subarray(0,4).toString('hex')==='504b0304';if(!valid)bad('Содержимое файла не соответствует его формату');
    const fileId=randomUUID();db.prepare('INSERT INTO deal_order_files VALUES (?,?,?,?,?,?,?)').run(fileId,id,body.kind,name,mime,bytes,new Date().toISOString());
    return {id:fileId,name,kind:body.kind};
  };
  const file=(id,scope,fileId)=>{row(id,scope);const value=db.prepare('SELECT * FROM deal_order_files WHERE id=? AND deal_id=?').get(fileId,id);if(!value)fail(404,'Файл не найден');return value;};
  const print=(id,scope,kind,invoiceId)=>{
    const deal=detail(id,scope),money=v=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB'}).format(v||0);
    let title,content;
    const rows=(deal.estimate||[]).map(r=>`<tr><td>${esc(r.name)}</td><td>${r.quantity}</td><td>${money(r.price)}</td><td>${money(r.price*r.quantity)}${r.billing==='monthly'?' / мес':''}</td></tr>`).join('');
    if(kind==='estimate'){title='Смета';content=`<table><tr><th>Работы / услуги</th><th>Кол-во</th><th>Цена</th><th>Сумма</th></tr>${rows}</table><h2>Разово: ${money(deal.total)} · Ежемесячно: ${money(deal.monthlyTotal)}</h2><p>Налоги и условия оплаты согласуются отдельно.</p>`;}
    else if(kind==='brief'){title='Бриф';content=Object.entries(deal.brief||{}).map(([k,v])=>`<h3>${esc(({goal:'Цель',audience:'Аудитория',problem:'Задача',scope:'Состав работ',constraints:'Ограничения',acceptance:'Критерии приёмки',owner:'Ответственный',deadline:'Срок'})[k]||k)}</h3><p>${esc(v)}</p>`).join('');}
    else if(kind==='invoice'){
      const inv=(deal.invoices||[]).find(v=>v.id===invoiceId);if(!inv)fail(404,'Счёт не найден');
      title=`Счёт ${inv.number||'без номера'}`;
      content=`<p><b>Дата:</b> ${esc(inv.date)}</p><h3>Исполнитель и платёжные реквизиты</h3><p>${esc(inv.seller||'Не заполнено')}</p><h3>Заказчик</h3><p>${esc(inv.buyer||'Не заполнено')}</p><h3>Назначение платежа</h3><p>${esc(inv.purpose)}</p><h2>К оплате: ${money(inv.amount)}</h2><p>Оплатить до: ${esc(inv.due||'не указано')}</p><p>${esc(inv.notes)}</p><p><b>${inv.status==='draft'||!inv.seller||!inv.buyer?'ЧЕРНОВИК — проверьте реквизиты и условия перед отправкой.':'Проверьте реквизиты перед оплатой.'}</b></p>`;
    } else bad('Неизвестный документ');
    return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)} — ${esc(deal.title)}</title><style>body{font:16px/1.5 Arial,sans-serif;max-width:900px;margin:40px auto;padding:20px;color:#17202b}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #ccc;padding:12px;text-align:left}p{white-space:pre-wrap}button{padding:12px 20px}@media print{button{display:none}body{margin:0}}</style><button onclick="window.print()">Печать / сохранить PDF</button><h1>${esc(title)}</h1><p>Сделка №${deal.id}: ${esc(deal.title)}<br>Компания: ${esc(deal.company.name)}</p>${content}</html>`;
  };
  return {list:listDeals,detail,contacts,addParticipant,removeParticipant,create,update,offer,print,saveRules,upload,file,rules:(scope,pipeline)=>({label:pipelines(scope).find(p=>p.code===pipeline)?.label,stages:pipelineStages(scope,pipeline),criterionLabels})};
}
module.exports={createDealOrders,STAGES};

'use strict';
/* specs/217-reel-attribution — «Аналитика до денег» для Контент-завода, первый срез.
   1) Метка публикации: utm_source=площадка, utm_medium=social, utm_campaign=cf, utm_content=post-<номер карточки>.
      Ссылка на сайт компании дописывается к подписи ТОЛЬКО в момент отправки и ТОЛЬКО если владелец включил метки
      для своей компании, у компании в подтверждённых данных есть сайт и решение по карточке (согласование, а без
      согласования — создание) принято после включения. Сохранённые подписи не переписываются; уже вышедшие и уже
      согласованные до включения публикации ссылку не получают.
   2) Связь заявки с публикацией: заявка (и визит сайта) той же компании с utm_campaign=cf и utm_content=post-<N>,
      где карточка N принадлежит этой компании. Ничего не угадывается: другие метки сюда не относятся.
   3) Отчёт «рилс → переходы → заявки → продажи → выручка → ROMI» по карточке и по теме (исходная идея карточки).
      Все числа — строки CRM (LIVE). ROMI считается только при внесённом расходе с источником cf-post-<N>;
      без него — null с причиной, не ноль. */
const {company,fail,object,text,revision}=require('./company-information');

const CAMPAIGN='cf';
const MEDIUM='social';
const TAG=/^post-([1-9]\d{0,15})$/;
// Площадка плана/канала → значение utm_source (совпадает со словарём площадок аналитики соцсетей).
const UTM_SOURCE=Object.freeze({instagram:'instagram',tiktok:'tiktok',youtube_shorts:'youtube',youtube:'youtube',vk:'vk',telegram:'telegram',max:'max'});
const LABEL_LIMIT=60;
const DEFAULT_LABEL='Подробнее:';
const tagOf=postId=>`post-${postId}`;
const expenseSourceOf=postId=>`cf-post-${postId}`;
const day=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value+'T00:00:00Z')))fail(400,'Дата периода — ГГГГ-ММ-ДД');return value;};

/* Ссылка с меткой. Чужие utm_* в адресе сайта заменяются нашими, остальные параметры и якорь сохраняются.
   Только http(s); иначе null — ссылка не ставится. */
function trackedUrl(siteUrl,platform,postId) {
  const source=UTM_SOURCE[platform];
  if(!source||!Number.isSafeInteger(postId)||postId<1||typeof siteUrl!=='string'||!siteUrl)return null;
  let target;try{target=new URL(siteUrl);}catch{return null;}
  if(!['https:','http:'].includes(target.protocol)||target.username||target.password)return null;
  for(const key of [...target.searchParams.keys()])if(/^utm_/i.test(key))target.searchParams.delete(key);
  target.searchParams.set('utm_source',source);target.searchParams.set('utm_medium',MEDIUM);
  target.searchParams.set('utm_campaign',CAMPAIGN);target.searchParams.set('utm_content',tagOf(postId));
  return target.toString();
}
const postIdOfTag=value=>{const match=TAG.exec(String(value||'').trim().toLowerCase());if(!match)return null;const id=Number(match[1]);return Number.isSafeInteger(id)?id:null;};

function createReelAttribution(db,{information,now=Date.now,logger=console}={}) {
  if(!information)throw Error('Reel attribution requires company information');
  db.exec(`CREATE TABLE IF NOT EXISTS reel_attribution_settings (
    company_id INTEGER PRIMARY KEY REFERENCES companies(id),enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    label TEXT NOT NULL DEFAULT '',enabled_at TEXT,revision INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,updated_by INTEGER);
    CREATE TABLE IF NOT EXISTS reel_attribution_links (
    post_id INTEGER NOT NULL REFERENCES autoposting_posts(id),channel_id TEXT NOT NULL,company_id INTEGER NOT NULL REFERENCES companies(id),
    platform TEXT NOT NULL,utm_content TEXT NOT NULL,url TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('added','present','skipped_limit','skipped_empty')),
    content_revision INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(post_id,channel_id));
    CREATE INDEX IF NOT EXISTS reel_attribution_links_company_idx ON reel_attribution_links(company_id,post_id);`);
  const iso=()=>new Date(now()).toISOString();
  const hasTable=name=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

  /* Сайт — из последней подтверждённой версии данных компании (эталон собственника), а не из внешних источников. */
  function siteOf(code) {
    try{const value=information.get(code)?.profile?.websiteUrl;return typeof value==='string'&&/^https?:\/\//i.test(value)?value:'';}
    catch{return '';}
  }
  function settingsRow(owner){return db.prepare('SELECT * FROM reel_attribution_settings WHERE company_id=?').get(owner.id);}
  function settingsDto(owner,row=settingsRow(owner)) {
    const siteUrl=siteOf(owner.code),enabled=Boolean(row?.enabled);
    const reason=!enabled?'Метки выключены: подписи уходят как есть.':!siteUrl?'Метки включены, но в данных компании нет сайта: ссылка не ставится.':'';
    return {companyCode:owner.code.toLowerCase(),enabled,label:row?row.label:DEFAULT_LABEL,enabledAt:row?.enabled_at||null,revision:row?.revision||0,
      siteUrl:siteUrl||null,active:enabled&&Boolean(siteUrl),reason,
      tag:{utm_source:'площадка',utm_medium:MEDIUM,utm_campaign:CAMPAIGN,utm_content:'post-<номер карточки>'},
      expenseSource:'cf-post-<номер карточки>',
      note:'Ссылка дописывается к подписи при отправке. Уже вышедшие и согласованные до включения публикации не меняются. В подписях Instagram и TikTok ссылка не кликабельна — переходов оттуда будет мало.'};
  }
  function getSettings(code){return settingsDto(company(db,code));}
  /* Включает и выключает только владелец (проверка прав — в HTTP). Каждое включение ставит новую отметку времени:
     ссылку получат только решения, принятые после неё. Ревизия защищает от одновременной правки. */
  function saveSettings(code,body,actor={}) {
    object(body,['revision','enabled','label']);revision(body.revision);
    if(typeof body.enabled!=='boolean')fail(400,'enabled — true или false');
    const label=body.label===undefined?undefined:text(body.label,LABEL_LIMIT);
    const owner=company(db,code);
    db.exec('BEGIN IMMEDIATE');
    try{
      const row=settingsRow(owner),current=row?.revision||0;
      if(body.revision!==current)fail(409,'Настройки меток изменились. Обновите страницу.','CONFLICT');
      const time=iso(),nextLabel=label===undefined?(row?row.label:DEFAULT_LABEL):label;
      const enabledAt=body.enabled?(row?.enabled?row.enabled_at:time):(row?.enabled_at||null);
      if(row)db.prepare('UPDATE reel_attribution_settings SET enabled=?,label=?,enabled_at=?,revision=revision+1,updated_at=?,updated_by=? WHERE company_id=?')
        .run(body.enabled?1:0,nextLabel,enabledAt,time,actor.userId??null,owner.id);
      else db.prepare('INSERT INTO reel_attribution_settings(company_id,enabled,label,enabled_at,revision,updated_at,updated_by) VALUES(?,?,?,?,1,?,?)')
        .run(owner.id,body.enabled?1:0,nextLabel,enabledAt,time,actor.userId??null);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    return getSettings(owner.code);
  }

  /* Время решения по карточке: последнее согласование (общее или по площадке), а без согласования — создание. */
  function decisionAt(post) {
    const times=[post.approved_at,post.created_at].filter(Boolean);
    if(hasTable('autoposting_platform_reviews')){
      const row=db.prepare("SELECT MAX(created_at) at FROM autoposting_platform_reviews WHERE post_id=? AND state='approved'").get(post.id);
      if(row?.at)times.push(row.at);
    }
    return times.sort().pop()||'';
  }
  /* Вызывается автопостингом прямо перед передачей подписи транспорту. Возвращает подпись для отправки.
     Любая ошибка здесь не мешает публикации: подпись уходит как была, а в журнал пишется только код. */
  function decorate({code,post,channelId,platform,caption,limits=[]}) {
    try{
      const owner=company(db,code);
      if(!post||post.company_id!==owner.id)return caption;
      const row=settingsRow(owner);
      if(!row?.enabled||!row.enabled_at)return caption;
      const siteUrl=siteOf(owner.code),link=trackedUrl(siteUrl,platform,post.id);
      if(!link)return caption;
      if(decisionAt(post)<row.enabled_at)return caption;
      const base=String(caption||''),time=iso();
      let status='added',result=base;
      if(!base.trim())status='skipped_empty';
      else if(base.includes(link))status='present';
      else{
        const next=`${base}\n\n${row.label?`${row.label} `:''}${link}`;
        const limit=limits.filter(value=>Number.isFinite(value)&&value>0).reduce((a,b)=>Math.min(a,b),Infinity);
        if(next.length>limit)status='skipped_limit';else result=next;
      }
      db.prepare(`INSERT INTO reel_attribution_links(post_id,channel_id,company_id,platform,utm_content,url,status,content_revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(post_id,channel_id) DO UPDATE SET platform=excluded.platform,utm_content=excluded.utm_content,
        url=excluded.url,status=excluded.status,content_revision=excluded.content_revision,updated_at=excluded.updated_at`)
        .run(post.id,String(channelId),owner.id,platform,tagOf(post.id),link,status,Number.isSafeInteger(post.content_revision)?post.content_revision:null,time,time);
      return result;
    }catch(error){logger.warn?.(`[crm] reel-attribution decorate code=${error?.details?.code||'skip'}`);return caption;}
  }

  /* Тема — исходная идея: вверх по связям «адаптация площадки» и «продолжение по площадкам», не глубже 8 шагов. */
  function themeOf(postId,ownerId) {
    let current=postId;
    for(let step=0;step<8;step+=1){
      const variant=hasTable('autoposting_variant_links')?db.prepare('SELECT root_post_id id FROM autoposting_variant_links WHERE post_id=? AND company_id=?').get(current,ownerId):null;
      if(variant?.id&&variant.id!==current){current=variant.id;continue;}
      const split=hasTable('autoposting_split_links')?db.prepare('SELECT source_post_id id FROM autoposting_split_links WHERE child_post_id=? AND company_id=?').get(current,ownerId):null;
      if(split?.id&&split.id!==current){current=split.id;continue;}
      break;
    }
    return current;
  }
  const blank=()=>({visits:0,leads:0,sales:0,revenue:0,salesWithoutAmount:0});
  const add=(target,lead)=>{target.leads+=1;if(lead.stage==='продажа'){target.sales+=1;if(typeof lead.sale_amount==='number')target.revenue+=lead.sale_amount;else target.salesWithoutAmount+=1;}};
  const romiOf=(revenue,cost,salesWithoutAmount)=>{
    if(cost===null)return {romi:null,romiReason:'Расход на рилс не внесён (Расходы, источник cf-post-<номер>).'};
    if(cost===0)return {romi:null,romiReason:'Расход внесён как 0 — ROMI не считается.'};
    return {romi:Math.round((revenue-cost)/cost*1000)/10,romiReason:salesWithoutAmount?'Есть продажи без суммы: ROMI занижен.':''};
  };

  /* Отчёт за период (сутки UTC, как в остальной статистике CRM). ROMI — за всё время метки: выручка всех заявок
     с меткой рилса против всех расходов cf-post-<N>, чтобы ролик прошлого месяца не выглядел убыточным в этом. */
  function report(code,from,to) {
    const owner=company(db,code);day(from);day(to);if(from>to)fail(400,'Начало периода позже конца');
    const start=from+'T00:00:00',end=to+'T23:59:59.999';
    const settings=settingsDto(owner);
    const posts=new Map();
    const postRow=id=>{
      if(posts.has(id))return posts.get(id);
      const row=hasTable('autoposting_posts')?db.prepare('SELECT id,company_id,title,status,meta,deleted_at FROM autoposting_posts WHERE id=?').get(id):null;
      const value=row&&row.company_id===owner.id?row:null;posts.set(id,value);return value;
    };
    const reels=new Map();
    const reelOf=id=>{
      if(!reels.has(id)){const row=postRow(id);
        reels.set(id,{postId:id,title:row.title||`Материал №${id}`,status:row.status,deleted:Boolean(row.deleted_at),themeId:themeOf(id,owner.id),
          tag:tagOf(id),platforms:new Map(),...blank(),lifetime:{revenue:0,salesWithoutAmount:0,cost:null}});}
      return reels.get(id);
    };
    const platformOf=(reel,platform)=>{
      const key=platform||'unknown';
      if(!reel.platforms.has(key))reel.platforms.set(key,{platform:key,link:null,linkStatus:null,publishedUrl:null,deliveryStatus:null,...blank()});
      return reel.platforms.get(key);
    };
    // Метки, поставленные при отправке (любая дата: публикация могла выйти раньше периода, а заявки прийти сейчас).
    for(const link of db.prepare('SELECT * FROM reel_attribution_links WHERE company_id=? ORDER BY post_id,channel_id').all(owner.id)){
      if(!postRow(link.post_id))continue;
      const item=platformOf(reelOf(link.post_id),UTM_SOURCE[link.platform]||link.platform);
      item.link=link.url;item.linkStatus=link.status;
      const delivery=hasTable('autoposting_deliveries')?db.prepare('SELECT status,url FROM autoposting_deliveries WHERE post_id=? AND channel_id=?').get(link.post_id,link.channel_id):null;
      if(delivery){item.deliveryStatus=delivery.status;item.publishedUrl=delivery.url||item.publishedUrl;}
    }
    const expensesScoped=hasTable('expenses')&&Boolean(db.prepare("SELECT 1 FROM pragma_table_info('expenses') WHERE name='company_code'").get());
    const unmatched={visits:0,leads:0};
    const tagged=(table,extra,where='')=>db.prepare(`SELECT ${extra} FROM ${table} WHERE company_code=? COLLATE NOCASE ${where} AND lower(COALESCE(utm_campaign,''))=?
      AND lower(COALESCE(utm_content,'')) LIKE 'post-%' AND created_at>=? AND created_at<?`);
    const visitors=new Map();
    for(const visit of tagged('events',"id,utm_source,utm_content,client_id","AND type='visit'").all(owner.code,CAMPAIGN,start,end)){
      const id=postIdOfTag(visit.utm_content);
      if(!id||!postRow(id)){unmatched.visits+=1;continue;}
      // Визиты читаются только с type='visit'; клики по кнопкам — не переходы.
      // Переход — уникальный посетитель (client_id) на рилс и площадку; визит без client_id считается отдельно.
      const source=String(visit.utm_source||'').toLowerCase(),key=`${id}|${source}|${visit.client_id||`visit:${visit.id}`}`;
      if(visitors.has(key))continue;visitors.set(key,true);
      const reel=reelOf(id);reel.visits+=1;platformOf(reel,source).visits+=1;
    }
    for(const lead of tagged('leads',"id,stage,sale_amount,utm_source,utm_content").all(owner.code,CAMPAIGN,start,end)){
      const id=postIdOfTag(lead.utm_content);
      if(!id||!postRow(id)){unmatched.leads+=1;continue;}
      const reel=reelOf(id);add(reel,lead);add(platformOf(reel,String(lead.utm_source||'').toLowerCase()),lead);
    }
    for(const reel of reels.values()){
      const life=db.prepare(`SELECT stage,sale_amount FROM leads WHERE company_code=? COLLATE NOCASE AND lower(COALESCE(utm_campaign,''))=? AND lower(COALESCE(utm_content,''))=? AND stage='продажа'`)
        .all(owner.code,CAMPAIGN,reel.tag);
      for(const lead of life){if(typeof lead.sale_amount==='number')reel.lifetime.revenue+=lead.sale_amount;else reel.lifetime.salesWithoutAmount+=1;}
      // Расход относится к рилсу только внутри своей компании: общие расходы без компании (до spec 111) сюда не попадают.
      const cost=expensesScoped?db.prepare("SELECT COUNT(*) n,SUM(amount) total FROM expenses WHERE company_code=? COLLATE NOCASE AND source=?").get(owner.code,expenseSourceOf(reel.postId)):{n:0};
      reel.lifetime.cost=cost.n?cost.total:null;
      Object.assign(reel.lifetime,romiOf(reel.lifetime.revenue,reel.lifetime.cost,reel.lifetime.salesWithoutAmount));
    }
    // Темы: сумма карточек одной исходной идеи. Визиты разных карточек одного человека здесь не схлопываются.
    const themes=new Map();
    for(const reel of reels.values()){
      if(!themes.has(reel.themeId)){const root=postRow(reel.themeId);
        themes.set(reel.themeId,{themeId:reel.themeId,title:root?.title||`Материал №${reel.themeId}`,postIds:[],...blank(),lifetime:{revenue:0,salesWithoutAmount:0,cost:null}});}
      const theme=themes.get(reel.themeId);theme.postIds.push(reel.postId);
      for(const key of Object.keys(blank()))theme[key]+=reel[key];
      theme.lifetime.revenue+=reel.lifetime.revenue;theme.lifetime.salesWithoutAmount+=reel.lifetime.salesWithoutAmount;
      if(reel.lifetime.cost!==null)theme.lifetime.cost=(theme.lifetime.cost||0)+reel.lifetime.cost;
    }
    for(const theme of themes.values())Object.assign(theme.lifetime,romiOf(theme.lifetime.revenue,theme.lifetime.cost,theme.lifetime.salesWithoutAmount));
    const list=[...reels.values()].sort((a,b)=>b.leads-a.leads||b.visits-a.visits||b.postId-a.postId)
      .map(reel=>({...reel,platforms:[...reel.platforms.values()]}));
    const totals=blank();for(const reel of list)for(const key of Object.keys(totals))totals[key]+=reel[key];
    const any=list.length>0||unmatched.leads>0||unmatched.visits>0;
    return {companyCode:owner.code.toLowerCase(),from,to,period:{basis:'utc',startInclusive:start,endInclusive:end},
      mode:any?'LIVE':'NO_DATA',settings,reels:list,themes:[...themes.values()].sort((a,b)=>b.leads-a.leads||b.themeId-a.themeId),totals,unmatched,
      note:'Все числа — строки CRM этой компании. Переход — уникальный посетитель сайта с меткой рилса; заявка — заявка с меткой cf/post-<N> (в том числе сшитая с визитом); продажа — этап «продажа», выручка — её сумма. Заявки и визиты — сутки UTC. ROMI — за всё время метки и только при внесённом расходе cf-post-<N>.'};
  }
  return {getSettings,saveSettings,decorate,report,trackedUrl};
}
module.exports={createReelAttribution,trackedUrl,postIdOfTag,tagOf,expenseSourceOf,UTM_SOURCE,CAMPAIGN,MEDIUM,DEFAULT_LABEL};

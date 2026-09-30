'use strict';
const {createHughOwnerAlerts}=require('./hugh-owner-alerts');
const BALANCE_URL='https://api.deepseek.com/user/balance';
const CACHE_MS=600000,STALE_MS=1800000;
function parseBalance(data){
  if(typeof data?.is_available!=='boolean'||!Array.isArray(data.balance_infos)||!data.balance_infos.length||data.balance_infos.length>2)throw new Error('balance format');
  const seen=new Set();
  const balances=data.balance_infos.map(r=>{
    if(!['USD','CNY'].includes(r.currency)||seen.has(r.currency))throw new Error('currency');seen.add(r.currency);
    const amount=v=>{if(typeof v!=='string'||!/^\d+(?:\.\d{1,12})?$/.test(v)||Number(v)>1e9)throw new Error('amount');return Number(v);};
    return {currency:r.currency,total:amount(r.total_balance),granted:amount(r.granted_balance),toppedUp:amount(r.topped_up_balance)};
  });return {available:data.is_available,balances};
}
function forecast(remaining,rate){return Number.isFinite(remaining)&&remaining===0?0:
  Number.isFinite(remaining)&&remaining>0&&Number.isFinite(rate?.usdPerDay)&&rate.usdPerDay>0?remaining/rate.usdPerDay:null;}
function createHughEconomy({db,account,now=()=>Date.now(),fetchImpl=globalThis.fetch}){
  db.exec(`CREATE TABLE IF NOT EXISTS ai_balance_snapshots(provider TEXT PRIMARY KEY,revision INTEGER NOT NULL,
    checked_at INTEGER NOT NULL,attempt_at INTEGER NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,error TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_economy_alert_state(key TEXT PRIMARY KEY,active INTEGER NOT NULL,episode INTEGER NOT NULL)`);
  let inFlight=null;
  const current=()=>db.prepare("SELECT * FROM ai_balance_snapshots WHERE provider='deepseek'").get();
  function view(name,revision){
    if(name!=='deepseek')return {supported:false,status:'unsupported',balances:[],message:'Автоматический источник API-баланса не подключён. Проверьте кабинет провайдера.'};
    const r=current();
    if(!r||r.revision!==revision)return {supported:true,status:'unknown',balances:[],message:'Баланс этой настройки ещё не получен'};
    const data=JSON.parse(r.data),stale=now()-r.checked_at>STALE_MS;
    return {supported:true,status:r.status,checkedAt:r.checked_at?new Date(r.checked_at).toISOString():null,
      attemptedAt:new Date(r.attempt_at).toISOString(),stale,message:r.error,...data};
  }
  async function refresh(){
    if(inFlight)return inFlight;
    const a=account();if(!a)return view('deepseek',-1);
    const old=current();if(old?.revision===a.revision&&now()-old.attempt_at<CACHE_MS)return view('deepseek',a.revision);
    inFlight=(async()=>{
      let data=null,error='';
      try{
        const r=await fetchImpl(BALANCE_URL,{method:'GET',redirect:'error',headers:{authorization:`Bearer ${a.secret}`},signal:AbortSignal.timeout(10000)});
        if(!r.ok||r.redirected)throw new Error('http');
        data=parseBalance(await r.json());
      }catch{error='Не удалось обновить баланс. Проверьте кабинет провайдера; прежний снимок не является текущим балансом.';}
      // Не применять ответ старого ключа к новой конфигурации.
      if(account()?.revision!==a.revision)return view('deepseek',-1);
      const same=old?.revision===a.revision;
      db.prepare(`INSERT INTO ai_balance_snapshots VALUES('deepseek',?,?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET
        revision=excluded.revision,checked_at=excluded.checked_at,attempt_at=excluded.attempt_at,status=excluded.status,data=excluded.data,error=excluded.error`)
        .run(a.revision,data?now():same?old.checked_at:0,now(),data?'ok':'error',JSON.stringify(data||(same?JSON.parse(old.data):{balances:[]})),error);
      return view('deepseek',a.revision);
    })();try{return await inFlight;}finally{inFlight=null;}
  }
  const alerts=createHughOwnerAlerts({db,now});
  function warn(key,active,text){
    const prev=db.prepare('SELECT * FROM ai_economy_alert_state WHERE key=?').get(key);
    if(!!prev?.active===!!active)return;
    const episode=(prev?.episode||0)+(active?1:0);
    db.prepare('INSERT INTO ai_economy_alert_state VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET active=excluded.active,episode=excluded.episode').run(key,active?1:0,episode);
    if(active)alerts.add('synapse-business',`economy:${key}:${episode}`,`${text}\nЛК → Настройки системы → Экономика ИИ.`);
  }
  function warnings(status,runtime){
    for(const p of status.providers){
      warn(`limit:${p.name}`,p.enabled&&p.spend.limitUsd!==null&&p.spend.remainingUsd<=p.spend.limitUsd*0.1,`ИИ ${p.title}: осталось не более 10% установленного лимита расходов.`);
      const b=p.wallet;
      warn(`wallet:${p.name}`,p.enabled&&b?.status==='ok'&&!b.stale&&b.available===false,`API-баланс ${p.title} недостаточен для работы. Проверьте пополнение в кабинете провайдера.`);
    }
    const enabled=status.providers.filter(p=>p.enabled).length;
    const ready=(runtime?.providers||[]).filter(p=>!p.cooling&&!p.ownLimitReached&&!runtime.budget?.stopped).length;
    warn('reserve',enabled>0&&ready<2,ready===0?'Все API-модели временно недоступны. Задания сохраняются, требуется проверка владельца.':'Доступна только одна API-модель: автоматический резерв временно отсутствует.');
    warn('global-limit',status.budget.remainingUsd!==null&&status.budget.remainingUsd<=status.budget.limitUsd*0.1,'Общий лимит расходов ИИ: осталось не более 10%.');
    warn('request-limit',Number.isFinite(status.budget.remainingRequests)&&status.budget.remainingRequests<=status.budget.maxRequests*0.1,'Общий лимит обращений ИИ: осталось не более 10%.');
  }
  return {view,refresh,warnings};
}
module.exports={createHughEconomy,parseBalance,forecast,BALANCE_URL};

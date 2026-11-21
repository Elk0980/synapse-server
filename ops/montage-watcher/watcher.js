'use strict';
const {createHash}=require('node:crypto');
const replyHash=value=>createHash('sha256').update(String(value||'')).digest('hex');
const CODE=/^[a-z0-9][a-z0-9_-]{0,63}$/;
const id=value=>Number.isSafeInteger(value)&&value>0;
const keyOf=item=>`${item.companyCode}:${item.type}:${item.id}`;
const linkOf=item=>`https://synapse.synapsebusiness.ru/cabinet.html?companyCode=${encodeURIComponent(item.companyCode)}#content/materials/reel/${item.reelId}`;
const REASONS=new Set(['NOT_PICKED_UP','PROCESSING_FAILED','DISPATCH_UNCONFIRMED','REPLY_UNCONFIRMED','EXECUTOR_UNAVAILABLE','QUEUE_UNAVAILABLE','RECOVERED_UNKNOWN']);
function snapshot(requests,edits){
  if(!Array.isArray(requests?.requests)||!Array.isArray(edits?.edits)||requests.requests.length+edits.edits.length>10000)throw Error('INVALID_QUEUE');
  const out=[],seen=new Set();
  for(const [type,rows] of [['request',requests.requests],['edit',edits.edits]])for(const row of rows){
    if(!row||!CODE.test(row.companyCode)||!id(row.id)||!id(row.reelId)||!Number.isFinite(Date.parse(row.createdAt))
      ||(type==='request'?!['accepted','in_progress','waiting_owner'].includes(row.status):!['pending','in_progress'].includes(row.status)))throw Error('INVALID_QUEUE');
    const item={...row,type},key=keyOf(item);if(seen.has(key))throw Error('INVALID_QUEUE');seen.add(key);out.push(item);
  }
  // Связанный redo обслуживается одной правкой; несоответствие компании/ролика не превращаем в чужой dispatch.
  const byEdit=new Map(out.filter(r=>r.type==='edit').map(r=>[`${r.companyCode}:${r.id}`,r]));
  for(const r of out.filter(r=>r.type==='request'&&r.editId!=null)){
    if(!id(r.editId))throw Error('INVALID_QUEUE');
    const edit=byEdit.get(`${r.companyCode}:${r.editId}`);if(edit&&edit.reelId!==r.reelId)throw Error('INVALID_QUEUE');
  }
  return out.filter(r=>!(r.type==='request'&&r.editId!=null));
}
function createWatcher({store,crm,classify,executor,now=Date.now,log=()=>{},intervalMs=150000,maxPerTick=20}){
  if(!Number.isSafeInteger(intervalMs)||intervalMs<120000||intervalMs>180000)throw Error('INVALID_INTERVAL');
  let active=null,timer=null,stopping=false;
  const emit=(code,count=1)=>log({code,count});
  async function escalate(item,reason){
    const key=keyOf(item),was=store.row(key);if(was?.task_id)return;
    if(!was)store.claim(key,item);
    const safeReason=REASONS.has(reason)?reason:'PROCESSING_FAILED';
    store.save(key,'escalating',{reason:safeReason});
    try{
      const task=await crm.task({companyCode:item.companyCode,sourceRef:`montage-watcher:v1:${key}`,title:item.type==='system'?'Монтаж: сторож не читает очередь':`Монтаж: требуется помощь — ролик №${item.reelId}`,
        description:`Точка А: ${safeReason}. ${item.type==='system'?'Очередь временно недоступна.':`Не подтверждена обработка ${item.type==='edit'?'правки':'просьбы'} №${item.id}, компания ${item.companyCode}.`}\nТочка Б: Claude проверяет сбой и восстанавливает обработку без повторной неизвестной отправки.\nШаги приёмки:\n[ ] Проверить исходную очередь и факт выполнения.\n[ ] Ответить в карточке или передать правку действующему монтажёру.\n[ ] Проверить результат и закрыть задачу.\n${item.reelId?linkOf(item):'https://synapse.synapsebusiness.ru/cabinet.html#content/materials'}`});
      if(!id(task.id))throw Error('INVALID_TASK');store.save(key,'escalated',{taskId:task.id,reason:safeReason});emit('ESCALATED');
    }catch{emit('ESCALATION_PENDING');} // sourceRef позволяет безопасно повторить создание задачи после потери ответа.
  }
  async function processItem(item){
    const key=keyOf(item),was=store.row(key);
    if(item.status==='waiting_owner'||item.status==='in_progress')return;
    if(was?.task_id)return;
    if(was){
      if(was.phase==='done')return;
      if(was.phase==='replying'||was.phase==='reply_uncertain'){
        if(item.type==='request'&&replyHash(item.reply)===was.reply_hash&&item.status===was.reply_status){store.save(key,'done');return;}
        return escalate(item,'REPLY_UNCONFIRMED');
      }
      if(was.phase==='escalating')return escalate(item,was.reason);
      if(was.phase!=='dispatched')return escalate(item,was.phase==='dispatching'?'DISPATCH_UNCONFIRMED':'RECOVERED_UNKNOWN');
    }
    if(now()-Date.parse(item.createdAt)>=600000)return escalate(item,'NOT_PICKED_UP');
    if(was)return;
    if(!store.claim(key,item))return;
    try{
      const decision=item.type==='edit'||item.kind!=='message'?{action:'montage'}:await classify(item);
      if(decision.action==='reply'&&item.type==='request'&&item.kind==='message'){
        // Сначала сохраняем результат; после неизвестного HTTP-исхода повторный reply не отправляем.
        store.save(key,'replying',{replyHash:replyHash(decision.reply),status:decision.status});
        try{await crm.reply(item,{status:decision.status,reply:decision.reply});store.save(key,'done');emit('REPLIED');}
        catch{store.save(key,'reply_uncertain',{replyHash:replyHash(decision.reply),status:decision.status});await escalate(item,'REPLY_UNCONFIRMED');}
      }else if(decision.action==='escalate')await escalate(item,'PROCESSING_FAILED');
      else{
        if(!executor)return escalate(item,'EXECUTOR_UNAVAILABLE');
        store.save(key,'dispatching');
        try{
          const result=await executor(item,{idempotencyKey:`montage-watcher:v1:${key}`});
          if(result?.accepted!==true||result.companyCode!==item.companyCode||result.id!==item.id||result.type!==item.type)throw Error('INVALID_DISPATCH');
          store.save(key,'dispatched');emit('DISPATCHED');
          // Не делаем CRM claim: его делает фактический исполнитель, когда действительно начал монтаж.
        }catch{await escalate(item,'DISPATCH_UNCONFIRMED');}
      }
    }catch{await escalate(item,'PROCESSING_FAILED');}
  }
  async function run(){
    if(stopping||!store.lock())return;
    try{
      let items;
      try{const [requests,edits]=await Promise.all([crm.requests(),crm.queue()]);items=snapshot(requests,edits);}
      catch{emit('QUEUE_UNAVAILABLE');await escalate({companyCode:'synapse-business',type:'system',id:store.queueIncident(),reelId:null},'QUEUE_UNAVAILABLE');return;}
      store.queueRecovered();store.healthy();const tickStarted=now();
      const byKey=new Map(items.map(item=>[keyOf(item),item]));
      for(const row of store.unfinished()){
        if(stopping)break;store.renew();if(byKey.has(row.key))continue;
        if(row.phase==='escalating')await escalate(JSON.parse(row.metadata),row.reason);
        else await escalate(JSON.parse(row.metadata),'RECOVERED_UNKNOWN');
      }
      if(!items.length){emit('EMPTY',0);return;}
      // Сначала сторож проверяет просроченные записи всей очереди; модель вызывается лишь для новых.
      let processed=0;
      for(const item of items){
        if(stopping)break;if(!store.renew())throw Error('LEASE_LOST');
        if(now()-tickStarted>=60000)break; // не держим весь tick на длинной очереди вместо следующего poll.
        const pending=item.status==='pending'||item.status==='accepted';
        if(pending&&now()-Date.parse(item.createdAt)>=600000){await escalate(item,'NOT_PICKED_UP');continue;}
        const fresh=pending&&!store.row(keyOf(item));
        if(!fresh||processed<maxPerTick){await processItem(item);if(fresh)processed++;}
      }
    }finally{store.unlock();}
  }
  function tick(){if(active||stopping)return active||Promise.resolve();active=run().catch(()=>emit('TICK_FAILED')).finally(()=>{active=null;});return active;}
  function start(){if(timer||stopping)return;void tick();timer=setInterval(()=>void tick(),intervalMs);timer.unref();}
  async function stop(){stopping=true;clearInterval(timer);timer=null;if(active)await active;}
  return {tick,start,stop};
}
module.exports={createWatcher,snapshot,keyOf,linkOf};

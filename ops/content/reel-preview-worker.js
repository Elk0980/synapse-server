'use strict';
// specs/238: сохранённая версия запускает подготовку без первого зрителя. БД — восстанавливаемый источник работ.
function createReelPreviewWorker({crmUrl,apiKey,previews,allowedCompany=()=>true,fetchImpl=fetch,intervalMs=2000}={}){
 let cursor=0,timer=null,inflight=null,closed=false,running=false;
 async function tick(){
  if(closed||running||!apiKey)return;running=true;inflight=new AbortController();
  const timeout=setTimeout(()=>inflight?.abort(),5000);
  try{
   const response=await fetchImpl(crmUrl.replace(/\/$/,'')+'/internal/reel-materials/previews?after='+cursor,
    {headers:{'x-api-key':apiKey},signal:inflight.signal,redirect:'error',cache:'no-store'});
   if(!response.ok)throw Error('PREVIEW_FEED_UNAVAILABLE');
   const body=await response.json();
   if(!Array.isArray(body.items)||body.items.length>25)throw Error('PREVIEW_FEED_INVALID');
   let previous=cursor;
   // Проверяем весь пакет до побочных эффектов; никакие URL из CRM не запрашиваются.
   for(const item of body.items){
    if(!Number.isSafeInteger(item.cursor)||item.cursor<=previous||!/^[a-z0-9_-]{1,64}$/.test(item.companyCode)
      ||item.fileName!==null&&!/^[a-f0-9]{32}\.mp4$/.test(item.fileName))throw Error('PREVIEW_FEED_INVALID');
    previous=item.cursor;
   }
   for(const item of body.items){
    if(closed)return;
    if(item.fileName&&allowedCompany(item.companyCode)){
     let state;try{state=previews.inspect(item.companyCode,item.fileName).state;}catch{state='missing';}
     // Полная очередь не теряет версию: повторяем её на следующем проходе.
     if(state==='busy')return;
    }
    cursor=item.cursor;
   }
   if(body.items.length<25)cursor=0;
  }catch{/* Не пишем в журнал ключи, адреса файлов и пользовательские данные. Следующий tick перечитает БД. */}
  finally{clearTimeout(timeout);inflight=null;running=false;}
 }
 function start(){if(timer||closed||!apiKey)return;void tick();timer=setInterval(()=>void tick(),intervalMs);timer.unref?.();}
 function close(){closed=true;clearInterval(timer);timer=null;inflight?.abort();}
 return {start,tick,close};
}
module.exports={createReelPreviewWorker};

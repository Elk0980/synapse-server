#!/usr/bin/env python3
"""Только чтение: какие посты Onlypult видит по профилям Палитры и в каком виде отвечает.
Ничего не создаёт и не меняет: любой запрос, кроме GET, блокируется до отправки.
Ключи не печатаются: они расшифровываются внутри контейнера тем же кодом CRM и уходят только в Onlypult.
Запуск на сервере: python3 probe.py            — vk и youtube_shorts
                   python3 probe.py tiktok vk  — выбранные площадки
"""
import subprocess, sys

CONTAINER = "synapse-crm-1"
CHANNELS = [a for a in sys.argv[1:] if a.replace("_", "").isalpha()] or ["vk", "youtube_shorts"]

JS = r"""
const {DatabaseSync}=require('node:sqlite');
const {createAutopostingTransport}=require('/app/autoposting-transport.js');
const db=new DatabaseSync('/data/crm.sqlite',{readOnly:true});
const channels=(process.env.CHANNELS||'').split(',').filter(Boolean);
let current=null;
const short=(v,n)=>typeof v==='string'?v.replace(/\s+/g,' ').slice(0,n):v;
async function fetchImpl(url,init={}){
  if((init.method||'GET')!=='GET')throw Error('probe: only GET');
  const u=new URL(url);
  if(u.pathname.endsWith('/posts/__probe__')){u.pathname=u.pathname.replace('/__probe__','');u.search='?profile_id='+encodeURIComponent(current.target)+'&limit=6';}
  const response=await fetch(u.href,{...init,method:'GET'});
  const text=await response.clone().text();
  let data;try{data=JSON.parse(text);}catch{console.log(current.id,'HTTP',response.status,'не JSON');return response;}
  console.log('==',current.id,'HTTP',response.status,'верхние ключи:',Object.keys(data||{}).join(','),
    data&&data.meta?'meta='+JSON.stringify(data.meta).slice(0,160):'');
  const items=Array.isArray(data?.data)?data.data:data?.data?[data.data]:[];
  for(const p of items){
    const links=Object.entries(p).filter(([k,v])=>/url|link|permalink|external/i.test(k)&&k!=='media').map(([k,v])=>k+'='+short(JSON.stringify(v),160));
    console.log(' id',p.id,'status',p.status,'platform',p.platform,'profile',JSON.stringify(p.profile_id??p.profile_ids),
      'publish_at',p.publish_at,'published_at',p.published_at,'created',p.created_at,
      'shorts',p.is_shorts,'err',short(p.error,120),'text',JSON.stringify(short(p.content,30)));
    console.log('   ключи:',Object.keys(p).join(','));
    if(links.length)console.log('   ссылки:',links.join(' | '));
  }
  return response;
}
(async()=>{
  const t=createAutopostingTransport(db,{apiKey:process.env.API_KEY,fetchImpl});
  for(const id of channels){
    current=db.prepare("SELECT id,target,revision FROM autoposting_channels WHERE company_code='palitra-love' COLLATE NOCASE AND id=?").get(id);
    if(!current){console.log(id,'нет канала');continue;}
    try{await t.reconcile({companyCode:'palitra-love',channelId:id,channelRevision:current.revision,providerPostId:'__probe__'});}
    catch(e){console.log('  (ожидаемо после списка) код',e.code||e.message);}
  }
  db.close();
})();
"""


def main():
    r = subprocess.run(["docker", "exec", "-i", "-e", "CHANNELS=" + ",".join(CHANNELS), CONTAINER, "node", "-"],
                       input=JS.encode(), capture_output=True, timeout=120)
    sys.stdout.write(r.stdout.decode("utf-8", "replace"))
    if r.returncode:
        print("ОШИБКА", r.stderr.decode("utf-8", "replace")[-400:])


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Только чтение: platform_id наших профилей Onlypult и что видно на публичных страницах по ним.
Запросы к Onlypult — только GET, ключи не печатаются; к площадкам — без ключей."""
import subprocess, sys

JS = r"""
const {DatabaseSync}=require('node:sqlite');
const {createAutopostingTransport}=require('/app/autoposting-transport.js');
const db=new DatabaseSync('/data/crm.sqlite',{readOnly:true});
const short=(v,n)=>typeof v==='string'?v.replace(/\s+/g,' ').slice(0,n):v;
let nextPath=null,lastJson=null;
async function fetchImpl(url,init={}){
  if((init.method||'GET')!=='GET')throw Error('probe: only GET');
  const u=new URL(url);
  if(u.pathname.endsWith('/__probe__')&&nextPath){u.pathname=u.pathname.replace(/\/posts\/__probe__$/,nextPath);u.search='';}
  const response=await fetch(u.href,{...init,method:'GET'});
  try{lastJson=JSON.parse(await response.clone().text());}catch{lastJson=null;}
  return response;
}
const t=createAutopostingTransport(db,{apiKey:process.env.API_KEY,fetchImpl});
const ch=id=>db.prepare("SELECT id,target,revision FROM autoposting_channels WHERE company_code='palitra-love' COLLATE NOCASE AND id=?").get(id);
async function raw(path){nextPath=path;lastJson=null;const c=ch('vk');
  try{await t.reconcile({companyCode:'palitra-love',channelId:'vk',channelRevision:c.revision,providerPostId:'__probe__'});}catch{}
  nextPath=null;return lastJson;}
const UA='Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';
async function page(url){try{const r=await fetch(url,{redirect:'follow',signal:AbortSignal.timeout(15000),headers:{'user-agent':UA,'accept-language':'ru'}});const s=await r.text();return {status:r.status,url:r.url,s};}catch(e){return {status:'ERR '+String(e.cause?.code||e.message).slice(0,40),s:''};}}
(async()=>{
  const ids={};
  for(const id of ['telegram','vk','youtube_shorts','instagram','tiktok']){
    const p=(await raw('/profiles/'+encodeURIComponent(ch(id).target)))?.data||{};
    ids[id]=p.platform_id;
    console.log(id,p.platform,'platform_id',JSON.stringify(p.platform_id),'username',JSON.stringify(p.username),'type',p.type_name,'status',p.status,'msg',JSON.stringify(p.status_message));
  }
  const gid=String(ids.vk||'').replace(/^-/,'');
  for(const u of ['https://m.vk.com/wall-'+gid,'https://m.vk.com/club'+gid,'https://vk.com/wall-'+gid]){
    const r=await page(u);const posts=[...new Set([...r.s.matchAll(new RegExp('wall-'+gid+'_(\\d+)','g'))].map(m=>+m[1]))].sort((a,b)=>b-a);
    const i=r.s.indexOf('Тест');
    console.log('vk',r.status,r.s.length,u,'->',r.url.slice(0,60),'posts',posts.slice(0,6).join(','),'Тест@',i);
    if(i>0)console.log('   ...',short(r.s.slice(Math.max(0,i-700),i+80).replace(/<[^>]+>/g,' '),400));
  }
  if(ids.youtube_shorts){const r=await page('https://www.youtube.com/feeds/videos.xml?channel_id='+ids.youtube_shorts);
    const e=[...r.s.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0,4).map(m=>(m[1].match(/<yt:videoId>([^<]+)/)||[])[1]+' '+(m[1].match(/<published>([^<]+)/)||[])[1]+' '+short((m[1].match(/<title>([^<]*)/)||[])[1],30));
    console.log('yt rss',r.status,e.join(' | '));}
  {const r=await page('https://www.tiktok.com/@palitralove');const v=[...new Set([...r.s.matchAll(/\/video\/(\d{15,20})/g)].map(m=>m[1]))];const c=[...r.s.matchAll(/"createTime":"?(\d+)/g)].length;
    console.log('tiktok',r.status,r.s.length,'videos',v.slice(0,4).join(','),'createTime',c,'itemList',r.s.includes('itemList'));}
  {const r=await page('https://www.tiktok.com/oembed?url=https://www.tiktok.com/@palitralove');console.log('tiktok oembed',r.status,short(r.s,160));}
  db.close();
})();
"""

r = subprocess.run(["docker", "exec", "-i", "synapse-crm-1", "node", "-"], input=JS.encode(), capture_output=True, timeout=240)
sys.stdout.write(r.stdout.decode("utf-8", "replace"))
if r.returncode:
    print("ОШИБКА", r.stderr.decode("utf-8", "replace")[-400:])

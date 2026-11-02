#!/usr/bin/env python3
"""Только чтение: откуда сервер может взять ссылки на вышедшие посты Палитры.
1) профили Onlypult по пяти площадкам (имя, username) — тем же кодом CRM;
2) профили аналитики Onlypult и последние публикации с url (Instagram/TikTok);
3) доступность публичных страниц: t.me/s, YouTube, m.vk.com — без ключей.
Любой запрос к Onlypult, кроме GET, блокируется. Ключи не печатаются.
"""
import subprocess, sys

CONTAINER = "synapse-crm-1"

JS = r"""
const {DatabaseSync}=require('node:sqlite');
const {createAutopostingTransport}=require('/app/autoposting-transport.js');
const db=new DatabaseSync('/data/crm.sqlite',{readOnly:true});
const short=(v,n)=>typeof v==='string'?v.replace(/\s+/g,' ').slice(0,n):v;
let nextPath=null,lastJson=null;
async function fetchImpl(url,init={}){
  if((init.method||'GET')!=='GET')throw Error('probe: only GET');
  const u=new URL(url);
  if(u.pathname.endsWith('/__probe__')&&nextPath){const p=new URL('https://x'+nextPath);u.pathname=u.pathname.replace(/\/posts\/__probe__$/,p.pathname);u.search=p.search;}
  const response=await fetch(u.href,{...init,method:'GET'});
  const text=await response.clone().text();
  try{lastJson={status:response.status,data:JSON.parse(text)};}catch{lastJson={status:response.status,data:null};}
  return response;
}
const t=createAutopostingTransport(db,{apiKey:process.env.API_KEY,fetchImpl});
const ch=id=>db.prepare("SELECT id,target,revision FROM autoposting_channels WHERE company_code='palitra-love' COLLATE NOCASE AND id=?").get(id);
async function raw(path,via='vk'){
  nextPath=path;lastJson=null;const c=ch(via);
  try{await t.reconcile({companyCode:'palitra-love',channelId:via,channelRevision:c.revision,providerPostId:'__probe__'});}catch{}
  nextPath=null;return lastJson;
}
async function page(url){
  try{const r=await fetch(url,{redirect:'follow',signal:AbortSignal.timeout(15000),headers:{'user-agent':'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36','accept-language':'ru'}});
    const s=await r.text();return {status:r.status,url:r.url,len:s.length,s};}catch(e){return {status:'ERR '+String(e.cause?.code||e.message).slice(0,40),s:''};}
}
(async()=>{
  const names={};
  console.log('== ПРОФИЛИ ПУБЛИКАЦИИ');
  for(const id of ['telegram','vk','youtube_shorts','instagram','tiktok']){
    try{const r=await t.listProfiles('palitra-love',id);const c=ch(id);
      for(const p of r.profiles){const mine=p.id===c.target;if(mine)names[id]=p.username||p.name;
        console.log(' ',id,mine?'НАШ':'   ',p.id,p.status,JSON.stringify(short(p.name,40)),'username',JSON.stringify(p.username));}}
    catch(e){console.log(' ',id,'ошибка',e.code||e.message);}
  }
  console.log('== ПРОФИЛИ АНАЛИТИКИ');
  const an=await raw('/analytics/profiles');
  console.log('  HTTP',an?.status,an?.data?.error?JSON.stringify(an.data.error).slice(0,120):'');
  const today=new Date(Date.now()+7*3600e3).toISOString().slice(0,10),from=new Date(Date.now()-3*86400e3).toISOString().slice(0,10);
  for(const p of (Array.isArray(an?.data?.data)?an.data.data:[])){
    console.log(' ',p.id,p.platform,p.status,'username',JSON.stringify(p.username),'publish',JSON.stringify(p.linked_publish_profile));
    if(!['instagram','tiktok'].includes(p.platform))continue;
    const top=await raw(`/analytics/${encodeURIComponent(p.id)}/top-posts?date_from=${from}&date_to=${today}&sort_by=published_at&sort_dir=desc&limit=5`);
    console.log('    top-posts HTTP',top?.status,top?.data?.error?JSON.stringify(top.data.error).slice(0,160):'');
    for(const i of (top?.data?.data?.items||[]))console.log('     ',new Date(i.published_at).toISOString(),i.url,JSON.stringify(short(i.caption||i.title||'',30)));
  }
  console.log('== ПУБЛИЧНЫЕ СТРАНИЦЫ');
  const tg=names.telegram;
  if(tg){const r=await page('https://t.me/s/'+encodeURIComponent(tg.replace(/^@/,'')));
    const posts=[...r.s.matchAll(/data-post="([^"]+)"/g)].map(m=>m[1]),times=[...r.s.matchAll(/<time[^>]*datetime="([^"]+)"/g)].map(m=>m[1]);
    console.log('  t.me/s',r.status,r.len,'постов',posts.length,'последние',posts.slice(-2).join(' '),times.slice(-2).join(' '));}
  const yt=names.youtube_shorts;
  for(const u of ['https://www.youtube.com/feeds/videos.xml?channel_id=UCBR8-60-B28hp2BmDPdntcQ',yt?'https://www.youtube.com/@'+encodeURIComponent(yt.replace(/^@/,''))+'/shorts':null].filter(Boolean)){
    const r=await page(u);const cid=(r.s.match(/"(?:channelId|externalId)":"(UC[\w-]{22})"/)||[])[1];
    console.log('  youtube',r.status,r.len,u.slice(0,70),'channelId',cid||'-');}
  const vk=names.vk;
  for(const u of ['https://m.vk.com/'+encodeURIComponent(String(vk||'').replace(/^@/,'')),'https://vk.com/'+encodeURIComponent(String(vk||'').replace(/^@/,''))]){
    const r=await page(u);const walls=[...new Set([...r.s.matchAll(/wall(-\d+_\d+)/g)].map(m=>m[1]))];
    console.log('  vk',r.status,r.len,u,'wall',walls.length,walls.slice(0,3).join(' '));}
  for(const u of ['https://www.instagram.com/palitra.love/','https://www.tiktok.com/@palitralove']){const r=await page(u);console.log('  ',r.status,r.len,u);}
  db.close();
})();
"""


def main():
    r = subprocess.run(["docker", "exec", "-i", CONTAINER, "node", "-"], input=JS.encode(), capture_output=True, timeout=240)
    sys.stdout.write(r.stdout.decode("utf-8", "replace"))
    if r.returncode:
        print("ОШИБКА", r.stderr.decode("utf-8", "replace")[-400:])


if __name__ == "__main__":
    main()

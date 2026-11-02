#!/usr/bin/env python3
"""Только чтение: автопостинг по компаниям — каналы, провайдер, профиль Onlypult, проверка доступа,
счётчики публикаций. Ключи не печатаются; запросы к Onlypult только GET (список профилей)."""
import subprocess, sys

JS = r"""
const {DatabaseSync}=require('node:sqlite');
const {createAutopostingTransport}=require('/app/autoposting-transport.js');
const db=new DatabaseSync('/data/crm.sqlite',{readOnly:true});
const fetchImpl=async(url,init={})=>{if((init.method||'GET')!=='GET')throw Error('only GET');return fetch(url,init);};
const t=createAutopostingTransport(db,{apiKey:process.env.API_KEY,fetchImpl});
(async()=>{
  for(const code of (process.env.CODES||'alvi,avokado,palitra-love').split(',')){
    const c=db.prepare('SELECT id,code,name,timezone FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get(code);
    if(!c){console.log('== '+code+': нет компании');continue;}
    const st=db.prepare('SELECT status,count(*) n FROM autoposting_posts WHERE company_id=? AND deleted_at IS NULL GROUP BY status').all(c.id).map(r=>r.status+'='+r.n).join(' ');
    console.log('== '+c.code+' «'+c.name+'» '+c.timezone+' | публикации: '+(st||'нет'));
    const rows=db.prepare('SELECT id,provider,enabled,status,target,revision,checked_revision FROM autoposting_channels WHERE company_code=? COLLATE NOCASE ORDER BY id').all(c.code);
    if(!rows.length)console.log('   каналов нет');
    for(const r of rows){
      let name='-';
      if(r.provider==='onlypult'){try{const p=(await t.listProfiles(c.code,r.id)).profiles.find(p=>p.id===r.target);name=p?('«'+p.name.slice(0,40)+'» '+p.status):'ПРОФИЛЬ НЕ НАЙДЕН';}catch(e){name='ошибка '+(e.code||e.message);}}
      console.log('   '+r.id.padEnd(15)+(r.provider||'direct').padEnd(9)+(r.enabled?'вкл ':'выкл')+' '+String(r.status).padEnd(10)+' проверка '+(r.checked_revision===r.revision?'да ':'НЕТ')+' '+name);
    }
  }
  db.close();
})();
"""
codes = sys.argv[1] if len(sys.argv) > 1 else "alvi,avokado,palitra-love"
r = subprocess.run(["docker", "exec", "-i", "-e", "CODES=" + codes, "synapse-crm-1", "node", "-"], input=JS.encode(), capture_output=True, timeout=180)
sys.stdout.write(r.stdout.decode("utf-8", "replace"))
if r.returncode:
    print("ОШИБКА", r.stderr.decode("utf-8", "replace")[-400:])

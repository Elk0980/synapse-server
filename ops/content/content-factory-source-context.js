'use strict';

// Только проекция существующей Content БД; не читает медиа, пути, чат или конфигурацию.
const {createHash}=require('node:crypto');
const MAX_BYTES=65536,MAX_ASSETS=100;
const EMPTY_METADATA={platforms:[],formats:[],occasion:'',eventDate:'',usageRestrictions:'',materialState:'source'};
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
function seal(value){return {...value,hash:createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')};}
function createSourceContext({db}){
  function capture(code){
    if(typeof code!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(code))throw Object.assign(Error('Выберите компанию'),{status:400});
    const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='telegram_source_items'").get();
    // Один SELECT фиксирует и количество, и порядок в одном снимке чтения SQLite.
    const rows=exists?db.prepare(`SELECT id,revision,sha256,name,mime,COALESCE(size,declared_size) size,status,caption,metadata,
      COUNT(*) OVER() total FROM telegram_source_items WHERE company_code=? AND status IN ('stored','text')
      ORDER BY id DESC LIMIT ?`).all(code,MAX_ASSETS):[];
    const total=rows[0]?.total||0,assets=[];
    for(const row of rows){
      const raw=JSON.parse(row.metadata),metadata=Object.fromEntries(Object.keys(EMPTY_METADATA).map(key=>[key,raw[key]??EMPTY_METADATA[key]]));
      const asset={id:row.id,revision:row.revision,sha256:row.sha256,name:row.name,mime:row.mime,size:row.size,
        status:row.status,caption:row.caption,metadata};
      const candidate=seal({schemaVersion:1,companyCode:code,total,truncated:total>assets.length+1,assets:[...assets,asset]});
      if(Buffer.byteLength(JSON.stringify(candidate))>MAX_BYTES)break;
      assets.push(asset);
    }
    return seal({schemaVersion:1,companyCode:code,total,truncated:total>assets.length,assets});
  }
  return {capture};
}
module.exports={createSourceContext};

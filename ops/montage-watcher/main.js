'use strict';
const fs=require('node:fs'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');
const {createStore}=require('./store'),{createWatcher}=require('./watcher'),{createRuntimeClassifier}=require('./classifier');
const {createCrm,createRuntime,createExecutor}=require('./transport');
const CODES=new Set(['ESCALATED','ESCALATION_PENDING','REPLIED','DISPATCHED','QUEUE_UNAVAILABLE','EMPTY','TICK_FAILED']);
function safeLogger(write=line=>process.stdout.write(line+'\n')){return ({code,count=1})=>{
  if(CODES.has(code))write(JSON.stringify({at:new Date().toISOString(),code,count:Number.isSafeInteger(count)&&count>=0?count:0}));
};}
function configure(env=process.env){
  const definitions=env.MONTAGE_RUNTIMES_JSON?JSON.parse(env.MONTAGE_RUNTIMES_JSON)
    :env.HUGH_RUNTIME_URL?[{name:'hugh',url:env.HUGH_RUNTIME_URL,keyEnv:'CHAT_API_KEY'}]:[];
  if(!Array.isArray(definitions)||definitions.length>10)throw Error('INVALID_RUNTIMES');
  const runtimes=definitions.map(item=>{
    if(!item||typeof item.name!=='string'||!/^[a-z0-9_-]{1,50}$/.test(item.name)||!/^([A-Z][A-Z0-9_]{1,70})$/.test(item.keyEnv||''))throw Error('INVALID_RUNTIME');
    return createRuntime({...item,key:env[item.keyEnv]});
  });
  if(new Set(definitions.map(r=>r.name)).size!==definitions.length)throw Error('DUPLICATE_RUNTIME');
  return {dbPath:env.MONTAGE_WATCHER_DB||'/data/montage-watcher.sqlite',crm:createCrm({url:env.CRM_URL||'http://crm:8080',key:env.CRM_API_KEY}),
    classify:createRuntimeClassifier(runtimes),executor:env.MONTAGE_EXECUTOR_URL?createExecutor({url:env.MONTAGE_EXECUTOR_URL,key:env.MONTAGE_EXECUTOR_KEY||env.CRM_API_KEY}):null};
}
async function main(){
  let config;try{config=configure();}catch{process.stderr.write('montage-watcher: CONFIGURATION_ERROR\n');process.exitCode=1;return;}
  fs.mkdirSync(path.dirname(config.dbPath),{recursive:true,mode:0o700});
  const db=new DatabaseSync(config.dbPath);db.exec('PRAGMA journal_mode=WAL');
  const watcher=createWatcher({...config,store:createStore(db),log:safeLogger()});let closing=false;
  const stop=async()=>{if(closing)return;closing=true;await watcher.stop();db.close();};
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>void stop());
  // Основной таймер удерживает самостоятельный процесс; внутри библиотеки он unref для встраивания.
  const keepAlive=setInterval(()=>{},60000);
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>clearInterval(keepAlive));
  watcher.start();
}
if(require.main===module)void main().catch(()=>{process.stderr.write('montage-watcher: STARTUP_ERROR\n');process.exitCode=1;});
module.exports={configure,safeLogger};

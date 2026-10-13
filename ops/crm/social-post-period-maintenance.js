'use strict';
// Offline-инструмент оператора. Окно одного писателя и остановка CRM проверяются
// до запуска; флаг offline сам по себе этого не доказывает. Без mode только чтение.
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync,backup}=require('node:sqlite');
const fail=code=>{throw Object.assign(new Error(code),{code});};

function inspectPostPeriodSchema(db){
 const columns=db.prepare('PRAGMA table_info(social_post_metrics)').all();
 if(!columns.length)fail('POST_PERIOD_TABLE_MISSING');
 const key=columns.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
 const count=db.prepare('SELECT count(*) n FROM social_post_metrics').get().n;
 return {schema:key.includes('period')?'period':'legacy',key,rows:count};
}

async function maintainPostPeriods({dbPath,mode='inspect',backupPath,offline=false}={}){
 if(!['inspect','rollback','upgrade'].includes(mode))fail('POST_PERIOD_MODE');
 if(typeof dbPath!=='string'||!path.isAbsolute(dbPath))fail('POST_PERIOD_DB_PATH');
 const source=fs.lstatSync(dbPath);
 if(!source.isFile()||source.isSymbolicLink())fail('POST_PERIOD_DB_FILE');
 if(mode!=='inspect'){
  if(offline!==true)fail('POST_PERIOD_OFFLINE_REQUIRED');
  if(typeof backupPath!=='string'||!path.isAbsolute(backupPath))fail('POST_PERIOD_BACKUP_PATH');
  if(path.resolve(backupPath)===path.resolve(dbPath))fail('POST_PERIOD_BACKUP_PATH');
 }
 const db=new DatabaseSync(dbPath,{readOnly:mode==='inspect'});
 try{
  // SQLite удерживает exclusive locking-mode до закрытия этого соединения.
  // Если другой writer уже работает, выходим до создания backup и миграции.
  if(mode!=='inspect')db.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
  const before=inspectPostPeriodSchema(db);
  if(mode==='inspect')return {mode,before,changed:false};
  // backup() учитывает WAL; простое копирование основного файла этого не делает.
  // wx исключает перезапись любой существующей копии/ссылки. Источник не меняется,
  // пока backup и его integrity_check не завершены.
  const reserved=fs.openSync(backupPath,'wx',0o600);fs.closeSync(reserved);
  await backup(db,backupPath);
  const saved=new DatabaseSync(backupPath,{readOnly:true});
  try{
   if(saved.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')fail('POST_PERIOD_BACKUP_INVALID');
   const backupSchema=inspectPostPeriodSchema(saved);
   if(JSON.stringify(before)!==JSON.stringify(backupSchema))fail('POST_PERIOD_BACKUP_CHANGED');
  }finally{saved.close();}
  const schema=require('./social-post-period-schema');
  if(mode==='rollback')schema.rollbackSocialPostPeriodSchema(db);
  else schema.ensureSocialPostPeriodSchema(db);
  return {mode,before,after:inspectPostPeriodSchema(db),backupCreated:true};
 }finally{db.close();}
}

async function main(argv){
 const options={};
 for(let i=0;i<argv.length;i++){
  const arg=argv[i];
  if(arg==='--offline'){options.offline=true;continue;}
  const key={'--db':'dbPath','--backup':'backupPath','--mode':'mode'}[arg];
  if(!key||!argv[i+1]||argv[i+1].startsWith('--')||options[key]!==undefined)fail('POST_PERIOD_ARGUMENTS');
  options[key]=argv[++i];
 }
 const result=await maintainPostPeriods(options);
 process.stdout.write(JSON.stringify(result)+'\n');
}
if(require.main===module)main(process.argv.slice(2)).catch(error=>{
 process.stderr.write((/^POST_PERIOD_[A-Z_]+$/.test(error.code||'')?error.code:'POST_PERIOD_MAINTENANCE_FAILED')+'\n');
 process.exitCode=1;
});
module.exports={maintainPostPeriods,inspectPostPeriodSchema};

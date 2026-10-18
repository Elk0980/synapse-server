'use strict';
const path=require('node:path');
const fs=require('node:fs');
const {DatabaseSync}=require('node:sqlite');
const {createCache}=require('./customer-report-cache.cjs');
const reports=require('./customer-reports-http.cjs');
const imports=require('./customer-report-import-http.cjs');
const app=require('./company-app-http.cjs');

// Mounted by the reviewed native host. Separate storage never rewrites the
// existing chat, order, account or price tables. Opening it is an installation
// action and must be covered by the release backup/rollback.
function create({databasePath,db,clock=()=>new Date().toISOString()}={}){
 if(!db){
  if(typeof databasePath!=='string'||!path.isAbsolute(databasePath))throw new TypeError('Нужен абсолютный путь приватной базы отчётов');
  fs.mkdirSync(path.dirname(databasePath),{recursive:true,mode:0o700});
  try{const fd=fs.openSync(databasePath,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY,0o600);fs.closeSync(fd);}catch(error){if(error.code!=='EEXIST')throw error;}
  const stat=fs.lstatSync(databasePath);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new TypeError('Нужен отдельный обычный файл базы отчётов');
  if(process.platform!=='win32')fs.chmodSync(databasePath,0o600);
  db=new DatabaseSync(databasePath);db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
 }
 const cache=createCache(db,{clock});
 return Object.freeze({
  cache,
  async handle(context){
   if(await imports.handle({...context,cache,readJson:imports.readSourceJson}))return true;
   if(await reports.handle({...context,now:clock,readSnapshot:(company,query,at)=>cache.readForPeriod(company,query,at),readTraffic:async()=>null}))return true;
   return app.handle(context);
  },
  close(){db.close();}
 });
}
module.exports={create};

'use strict';
// A consistent local backup only; no rows, credentials or content are printed.
const fs=require('node:fs');
const {DatabaseSync,backup}=require('node:sqlite');
const target='/data/palitra-production-before-20261013.sqlite';
if(fs.existsSync(target))throw new Error('Backup already exists; inspect the previous result before repeating');
const db=new DatabaseSync(process.env.DATABASE_PATH||'/data/content.sqlite',{readOnly:true});
(async()=>{try{
  const pages=await backup(db,target);
  fs.chmodSync(target,0o600);
  console.log(JSON.stringify({backup:'complete',pages}));
}finally{db.close();}})().catch(e=>{console.error(e.message);process.exitCode=1;});

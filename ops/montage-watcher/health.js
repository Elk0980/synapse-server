'use strict';
const {DatabaseSync}=require('node:sqlite');
function isHealthy(db,now=Date.now()){
  const row=db.prepare('SELECT last_success_ms FROM montage_watcher_health WHERE id=1').get();
  return Boolean(row&&now>=row.last_success_ms&&now-row.last_success_ms<=360000);
}
if(require.main===module){let db;try{
  db=new DatabaseSync(process.env.MONTAGE_WATCHER_DB||'/data/montage-watcher.sqlite',{readOnly:true});process.exitCode=isHealthy(db)?0:1;
}catch{process.exitCode=1;}finally{db?.close();}}
module.exports={isHealthy};

'use strict';
const {randomUUID}=require('node:crypto');
function createStore(db,{now=Date.now}={}){
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS montage_watcher_work (
      key TEXT PRIMARY KEY,phase TEXT NOT NULL,metadata TEXT NOT NULL,reply_hash TEXT,reply_status TEXT,task_id INTEGER,
      reason TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS montage_watcher_lock(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT,until_ms INTEGER NOT NULL);`);
  db.exec('CREATE TABLE IF NOT EXISTS montage_watcher_health(id INTEGER PRIMARY KEY CHECK(id=1),last_success_ms INTEGER NOT NULL)');
  const owner=randomUUID(),leaseMs=300000;
  const row=key=>db.prepare('SELECT * FROM montage_watcher_work WHERE key=?').get(key);
  function lock(){
    return db.prepare(`INSERT INTO montage_watcher_lock VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,until_ms=excluded.until_ms
      WHERE montage_watcher_lock.until_ms<? OR montage_watcher_lock.owner=?`).run(owner,now()+leaseMs,now(),owner).changes>0;
  }
  const renew=()=>db.prepare('UPDATE montage_watcher_lock SET until_ms=? WHERE id=1 AND owner=?').run(now()+leaseMs,owner).changes>0;
  const unlock=()=>db.prepare('UPDATE montage_watcher_lock SET until_ms=0 WHERE id=1 AND owner=?').run(owner);
  function claim(key,item){return db.prepare("INSERT OR IGNORE INTO montage_watcher_work(key,phase,metadata,created_at,updated_at) VALUES(?,'processing',?,?,?)")
    .run(key,JSON.stringify({companyCode:item.companyCode,id:item.id,reelId:item.reelId,type:item.type,createdAt:item.createdAt}),now(),now()).changes>0;}
  function save(key,phase,{replyHash=null,status=null,reason=null,taskId=null}={}){
    db.prepare('UPDATE montage_watcher_work SET phase=?,reply_hash=?,reply_status=?,reason=?,task_id=COALESCE(?,task_id),updated_at=? WHERE key=?')
      .run(phase,replyHash,status,reason,taskId,now(),key);return row(key);
  }
  const unfinished=()=>db.prepare("SELECT * FROM montage_watcher_work WHERE phase IN ('processing','replying','reply_uncertain','dispatching','escalating')").all();
  const healthy=()=>db.prepare('INSERT INTO montage_watcher_health VALUES(1,?) ON CONFLICT(id) DO UPDATE SET last_success_ms=excluded.last_success_ms').run(now());
  return {row,claim,save,lock,renew,unlock,unfinished,healthy};
}
module.exports={createStore};

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');
const {build,OUTPUT}=require('./build-content-bundle');
test('runtime bundle точно совпадает с исходниками; content использует прежний fallback без нового ledger',async()=>{
  assert.equal(fs.readFileSync(OUTPUT,'utf8').replace(/\r\n/g,'\n'),build());
  const {createContentWatcher}=require('../content/montage-watcher-bundle'),db=new DatabaseSync(':memory:');
  try{
    const watcher=createContentWatcher({db,crmApiKey:'',env:{}});watcher.start();await watcher.stop();
    const disabled=createContentWatcher({db,crmApiKey:'secret',env:{MONTAGE_WATCHER_ENABLED:'0'}});disabled.start();await disabled.stop();
    const live=createContentWatcher({db,crmUrl:'http://crm:8080',crmApiKey:'secret',fallback:{},env:{}});await live.stop();
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
    assert.ok(tables.includes('montage_watcher_work'));assert.ok(!tables.some(n=>n.startsWith('project_chat_budget')||n.startsWith('reply_jobs')));
  }finally{db.close();}
});

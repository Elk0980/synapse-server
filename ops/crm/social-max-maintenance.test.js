'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createSocialStats} = require('./social-stats');

test('при отключении MAX прежние пять источников собираются, сохранённый MAX и его очередь остаются', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,timezone TEXT,is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies VALUES(1,'maintenance','Fixture','UTC',0);
    CREATE TABLE leads(id INTEGER PRIMARY KEY,company_code TEXT,created_at TEXT,stage TEXT,sale_amount REAL,source TEXT,utm_source TEXT,utm_content TEXT,utm_campaign TEXT,referrer TEXT,landing_page TEXT);`);
  const calls=[];
  const stats=createSocialStats(db,{now:()=>Date.parse('2026-10-13T12:00:00Z'),maxEnabled:false,
    adapters:{direct:{connectionRevision:()=>({provider:'fixture',revision:1}),collect:async input=>{
      calls.push(input.platform);
      return {status:'ok',snapshots:[{metric:'views',value:1,date:input.date,period:'day',sourceField:'fixture',completeness:'complete'}],posts:[],missing:[]};
    }}},logger:{warn(){}}});
  stats.saveAccounts('maintenance',{accounts:['telegram','instagram','tiktok','vk','youtube','max'].map(platform=>({
    platform,accountRef:platform==='max'?'-1':'fixture-'+platform,provider:'direct',timezone:'UTC',enabled:true,revision:0
  }))});
  const accountBefore={...db.prepare("SELECT * FROM social_accounts WHERE platform='max'").get()};
  await stats.collectDue();
  assert.deepEqual([...new Set(calls)].sort(),['instagram','telegram','tiktok','vk','youtube']);
  assert.deepEqual({...db.prepare("SELECT * FROM social_accounts WHERE platform='max'").get()},accountBefore);
  assert.equal(db.prepare("SELECT count(*) n FROM social_collect_runs WHERE platform='max'").get().n,0);
  assert.equal(db.prepare("SELECT count(*) n FROM social_collect_queue WHERE platform='max'").get().n,0);
  await assert.rejects(stats.collect('maintenance','max'),{code:'MAX_ANALYTICS_PAUSED'});
  assert.equal(db.prepare("SELECT count(*) n FROM social_collect_runs WHERE platform='max'").get().n,0);
  await stats.stop();
});

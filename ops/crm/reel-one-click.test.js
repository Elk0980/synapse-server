'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {createReelChatApproval}=require('./reel-chat-approval');
function fixture(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec("CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,name TEXT,is_deleted INTEGER DEFAULT 0);INSERT INTO companies VALUES(1,'avokado','Авокадо',0);CREATE TABLE reel_materials(id INTEGER PRIMARY KEY);INSERT INTO reel_materials VALUES(1);");
 let post={id:4,status:'draft',contentRevision:1,revision:3,profileRevision:2,timezone:'Asia/Bangkok',text:'Согласованная подпись',mediaUrls:['https://example.test/a.mp4'],platformIds:['vk'],platformApprovals:[{platformId:'vk',approved:true}],approval:{approved:true},deliveries:[]};let calls=[];
 const api=createReelChatApproval(db,{materials:{get:()=>({})},autoposting:{get:()=>post,schedule:async(id,code,body)=>{calls.push({id,code,body});post={...post,status:'scheduled',scheduledAt:body.scheduledAt};}}});
 db.prepare(`INSERT INTO reel_chat_approvals(id,company_id,reel_id,version,post_id,content_revision,platform_ids,title,caption,media_url,requested_by_id,requested_at,client_request_id,updated_at) VALUES(1,1,1,1,4,1,'["vk"]','Рилс','Подпись','https://example.test/a.mp4',1,'2026-01-01','x','2026-01-01')`).run();
 return {api,calls,set:p=>post={...post,...p}};
}
test('№168: штатное schedule, согласованные площадки, повтор не создаёт новую отправку',async t=>{const f=fixture(t);const a=await f.api.publish('avokado',1,1,{},{});assert.equal(a.approval.status,'scheduled');await f.api.publish('avokado',1,1,{},{});assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body.platformIds,['vk']);assert.equal(f.calls[0].body.profileRevision,2);});
test('№168: устаревшая версия, несогласованная версия и лишние поля отклоняются',async t=>{const f=fixture(t);f.set({contentRevision:2});await assert.rejects(f.api.publish('avokado',1,1,{},{}),/изменилась/);f.set({contentRevision:1,approval:{approved:false},platformApprovals:[]});await assert.rejects(f.api.publish('avokado',1,1,{},{}),/Сначала согласуйте/);await assert.rejects(f.api.publish('avokado',1,1,{text:'подмена'},{}));assert.equal(f.calls.length,0);});

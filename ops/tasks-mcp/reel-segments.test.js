'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {startFixture}=require('./test-fixture');
const asset=n=>'https://synapse.synapsebusiness.ru/content/publishing-assets/palitra-love/'+n.repeat(32)+'.mp4';
const segments=[{startMs:0,endMs:4000,label:'Начало'},{startMs:4000,endMs:10000,label:'Конец',enabled:false,sound:false}];

test('№320 MCP → CRM: разметить прежнюю версию, повторить, обнаружить конфликт; файл/соседние версии/статусы целы',async t=>{
 const f=await startFixture();t.after(f.stop);
 const created=await f.crm('/autoposting/reels?companyCode=palitra-love','POST',{title:'SAMPLE монтаж',mediaUrl:asset('a'),durationMs:10000});
 assert.equal(created.status,201,JSON.stringify(created.body));
 const args={project:'palitra-love',reel_id:created.body.id,version:1};
 const before=(await f.call('reel_segments_get',args));assert.equal(before.isError,false,JSON.stringify(before));
 assert.deepEqual(before.data.segments,[]);assert.equal(before.data.durationMs,10000);assert.match(before.data.revision,/^[a-f0-9]{64}$/);
 const edit=await f.crm(`/autoposting/reels/${args.reel_id}/edits?companyCode=palitra-love`,'POST',
  {clientRequestId:'sample320',baseVersion:1,kind:'request',startMs:0,endMs:10000,comment:'SAMPLE правка'});
 assert.equal(edit.status,201,JSON.stringify(edit.body));
 const invalid=await f.crm(`/internal/reel-materials/reels/${args.reel_id}/versions?companyCode=palitra-love`,'POST',
  {mediaUrl:asset('b'),durationMs:10000,editId:edit.body.edit.id,segments:[{startMs:0,endMs:4000}]},null);
 assert.equal(invalid.status,400,'неполный ролик не становится версией');
 assert.equal((await f.crm(`/autoposting/reels/${args.reel_id}?companyCode=palitra-love`)).body.edits[0].status,'pending');
 const added=await f.crm(`/internal/reel-materials/reels/${args.reel_id}/versions?companyCode=palitra-love`,'POST',
  {mediaUrl:asset('b'),durationMs:10000,editId:edit.body.edit.id,segments},null);
 assert.equal(added.status,200,JSON.stringify(added.body));assert.equal(added.body.version.version,2);assert.deepEqual(added.body.version.segments,segments);
 const original=(await f.crm(`/autoposting/reels/${args.reel_id}?companyCode=palitra-love`)).body;
 const input={...args,expected_revision:before.data.revision,segments};
 const saved=await f.call('reel_segments_set',input);assert.equal(saved.isError,false,JSON.stringify(saved));
 assert.notEqual(saved.data.revision,before.data.revision);assert.deepEqual(saved.data.segments,segments);
 assert.deepEqual((await f.call('reel_segments_set',input)).data,saved.data,'неизвестный исход повторяется безопасно');
 const conflict=await f.call('reel_segments_set',{...input,segments:[{startMs:0,endMs:10000,label:'Чужая правка'}]});
 assert.equal(conflict.isError,true);assert.equal(conflict.data.error.status,409);
 const after=(await f.crm(`/autoposting/reels/${args.reel_id}?companyCode=palitra-love`)).body;
 assert.equal(after.versionCount,2);assert.deepEqual(after.versions[1],original.versions[1]);
 assert.deepEqual({...after.versions[0],segments:undefined},{...original.versions[0],segments:undefined});
 for(const key of ['updatedAt','edits','requests','history','caption','decision','postId'])assert.deepEqual(after[key],original[key],key);
 assert.equal(Object.hasOwn(saved.data,'title'),false,'не возвращаем чужие тексты/переписку');
 for(const bad of [{segments:[{startMs:0,endMs:9999}]},{segments:[{startMs:1,endMs:10000}]},{segments:[{startMs:0,endMs:10000,enabled:'false'}]},
  {segments:[]},{version:999},{reel_id:999},{expected_revision:'bad'},{mediaUrl:asset('c')}]){
  assert.equal((await f.call('reel_segments_set',{...input,...bad})).isError,true,JSON.stringify(bad));
 }
 for(const tool of ['reel_segments_get','reel_segments_set']){
  const foreign=await f.call(tool,{...(tool.endsWith('_set')?input:args),project:'foreign'});
  assert.equal(foreign.isError,true);assert.equal(foreign.data.error.status,404);
 }
 const raw=await f.crm('/coordination/mcp/reel_segments_set','POST',{...input,mediaUrl:asset('c')});assert.equal(raw.status,400);
 const editor=Buffer.from(JSON.stringify({v:1,userId:2,role:'editor',permissions:['autoposting.edit'],companyCodes:['palitra-love']})).toString('base64url');
 assert.equal((await f.crm('/coordination/mcp/reel_segments_get','POST',args,editor)).status,403);
 assert.equal((await f.call('reel_segments_get',{...args,project:'synapse-business'})).data.error.status,404,'чужой reelID в разрешённой компании');
 assert.equal((await f.call('reel_segments_set',{...input,expected_revision:saved.data.revision,segments:[{startMs:0,endMs:10000}]})).isError,false);
 await f.crm(`/autoposting/reels/${args.reel_id}/versions/1/archive?companyCode=palitra-love`,'POST',{reason:'SAMPLE архив'});
 assert.equal((await f.call('reel_segments_get',args)).data.error.status,409);
 assert.equal((await f.call('reel_segments_set',input)).data.error.status,409);
});

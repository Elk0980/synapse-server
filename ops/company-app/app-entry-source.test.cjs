'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),S=require('./app-entry-source.js');
const get=(url='https://spaalvi-38.ru/app',referrer='',companyCode='alvi')=>S.classify({url,referrer,companyCode});
test('tagged entrances identify each studio, including Telegram with no referrer',()=>{
 for(const company of ['palitra-love','alvi','avokado'])for(const [tag,source]of [['2GIS','2gis'],['tg','telegram'],['vk','vk'],['ig','instagram'],['max','max']])assert.deepEqual(get('https://example.test/app?utm_source='+tag,'',company),{companyCode:company,source,evidence:'link_tag'});
});
test('exact external host matching rejects lookalikes and splits maps from search',()=>{
 for(const [url,source]of [['https://2gis.ru/firm/12','2gis'],['https://t.me/studio','telegram'],['https://web.telegram.org/a','telegram'],['https://2gis.ru.evil.test','other'],['https://fake-telegram.org','other'],['https://vk.ru/x','vk'],['https://yandex.ru/maps/org/x','yandex_maps'],['https://yandex.ru/search','yandex'],['android-app://org.telegram.messenger','telegram']])assert.equal(get(undefined,url).source,source);
});
test('missing referrer, duplicate tags, unknown tag and internal navigation never invent acquisition',()=>{
 assert.equal(get().source,'unknown');assert.equal(get('https://a.test/?utm_source=tg&utm_source=vk').evidence,'ambiguous_tag');assert.equal(get('https://a.test/?utm_source=person@example.test').source,'other');assert.equal(get(undefined,'https://spaalvi-38.ru/page').evidence,'internal');
 assert.throws(()=>get(undefined,'','other'));const value=get('https://a.test/?utm_source=tg&phone=123&token=secret','https://t.me/private?data=secret');assert.deepEqual(Object.keys(value),['companyCode','source','evidence']);
});
test('one customer entrance per mounted document; staff, opt-out and SPA switches do not send',async()=>{
 const events=[],tracker=S.create({send:async e=>events.push(e),companyCode:'alvi',url:'https://example.test/app?utm_source=tg'});
 assert.equal(await tracker.enter({audience:'staff'}),false);assert.equal(await tracker.enter({doNotTrack:true}),false);assert.equal(await tracker.enter(),true);assert.equal(await tracker.enter(),false);assert.equal(events.length,1);
 const fail=S.create({send:async()=>{throw new Error('UNKNOWN');},companyCode:'alvi',url:'https://example.test/app'});await assert.rejects(fail.enter(),/UNKNOWN/);assert.equal(await fail.enter(),false);
});
test('installed launch does not reuse campaign retained in home-screen URL; only allowed analytics can send',async()=>{
 const sent=[],w={location:{href:'https://spaalvi-38.ru/app?utm_source=2gis&phone=123'},document:{referrer:''},navigator:{standalone:true},crypto:{randomUUID:()=> '12345678-1234-1234-1234-123456789abc'},fetch:async(path,options)=>{sent.push({path,options});return{status:202};}};
 const tracker=S.mount({window:w,companyCode:'alvi'});assert.equal(await tracker.enter(),false);assert.equal(sent.length,0);
 const allowed=S.mount({window:w,companyCode:'alvi',analyticsAllowed:()=>true});assert.equal(await allowed.enter(),true);assert.deepEqual(JSON.parse(sent[0].options.body),{eventId:'12345678-1234-1234-1234-123456789abc',source:'unknown',evidence:'unavailable'});assert.equal(sent[0].options.credentials,'omit');assert.equal(await allowed.enter(),false);
});

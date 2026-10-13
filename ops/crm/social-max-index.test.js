'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');const {createSocialMaxIndex}=require('./social-max-index');
const at='2026-10-13T12:00:00Z',published='2026-10-12T12:00:00Z';
function fixture(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());return {db,index:createSocialMaxIndex(db)};}
const native=id=>({platformPostId:id,publishedAt:published,metrics:[]});
function accept(f,p,o={}){f.db.exec('BEGIN IMMEDIATE');try{f.index.commit(p,{runId:1,collectedAt:at,...o});f.db.exec('COMMIT')}catch(e){f.db.exec('ROLLBACK');throw e}}
test('индекс namespaces одинаковый MID между каналами и компаниями, known reader не смешивает их',t=>{
 const f=fixture(t),a=f.index.prepare('a','-1',[native('mid.same')]),otherChat=f.index.prepare('a','-2',[native('mid.same')]),b=f.index.prepare('b','-1',[native('mid.same')]);
 assert.notEqual(a.posts[0].platformPostId,otherChat.posts[0].platformPostId);assert.notEqual(a.posts[0].platformPostId,b.posts[0].platformPostId);
 accept(f,a);accept(f,otherChat);accept(f,b);assert.equal(f.index.batch('a','-1').knownPosts.length,1);assert.equal(f.index.batch('missing','-1').knownPosts.length,0);
 assert.equal(f.index.batch('a','-1').knownPosts[0].platformPostId,'mid.same');
});
test('курсор больших known списков сохраняется, проходит весь индекс и не застревает на первых IDs',t=>{
 const f=fixture(t);accept(f,f.index.prepare('a','-1',['mid.a','mid.b','mid.c'].map(native)));
 const one=f.index.batch('a','-1',2);assert.deepEqual(one.knownPosts.map(p=>p.platformPostId),['mid.a','mid.b']);assert.equal(one.hasMore,true);
 accept(f,f.index.prepare('a','-1',[]),{refreshBatch:one,advanceRefresh:true});
 const next=f.index.batch('a','-1',2);assert.deepEqual(next.knownPosts.map(p=>p.platformPostId),['mid.c']);
 accept(f,f.index.prepare('a','-1',[]),{refreshBatch:next,advanceRefresh:true});assert.equal(f.index.batch('a','-1',2).knownPosts[0].platformPostId,'mid.a');
});
test('повтор/поздний запуск не продвигает повторно cursor, rollback не оставляет индекс',t=>{
 const f=fixture(t);accept(f,f.index.prepare('a','-1',['mid.a','mid.b'].map(native)));const batch=f.index.batch('a','-1',1);
 accept(f,f.index.prepare('a','-1',[]),{refreshBatch:batch,advanceRefresh:true});const before=f.db.prepare('SELECT revision FROM social_max_refresh_cursor').get().revision;
 accept(f,f.index.prepare('a','-1',[]),{refreshBatch:batch,advanceRefresh:true});assert.equal(f.db.prepare('SELECT revision FROM social_max_refresh_cursor').get().revision,before);
 f.db.exec('BEGIN IMMEDIATE');f.index.commit(f.index.prepare('a','-1',[native('mid.rollback')]),{collectedAt:at});f.db.exec('ROLLBACK');assert.equal(f.db.prepare("SELECT COUNT(*) n FROM social_max_post_index WHERE native_post_id='mid.rollback'").get().n,0);
 assert.throws(()=>f.index.commit(f.index.prepare('a','-1',[]),{collectedAt:at}),{code:'MAX_INDEX_TRANSACTION'});
});
test('конфликт native времени не переписывает исходный пост, hash нельзя подменить чужим',t=>{
 const f=fixture(t),p=f.index.prepare('a','-1',[native('mid.a')]);accept(f,p);
 const changed=f.index.prepare('a','-1',[{...native('mid.a'),publishedAt:at}]);assert.throws(()=>accept(f,changed),{code:'MAX_POST_IDENTITY_CONFLICT'});
 p.entries[0].postKey='max:foreign';assert.throws(()=>accept(f,p),{code:'MAX_INDEX_CONTEXT'});assert.equal(f.index.batch('a','-1').knownPosts[0].publishedAt,new Date(published).toISOString());
});

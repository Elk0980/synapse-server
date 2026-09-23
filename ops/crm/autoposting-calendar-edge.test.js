'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createCompanyInformation} = require('./company-information');
const {createAutoposting} = require('./autoposting');
const {createMediaMentor} = require('./media-mentor');
const {createMediaMentorTransfer} = require('./media-mentor-transfer');
const ACTOR = {userId:1,userName:'Fixture owner'};
const PERIOD = {from:'2026-10-01',to:'2026-10-31'};

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,
      timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'qa','Fixture','UTC','[]');`);
  const now = () => Date.parse('2026-09-24T00:00:00Z');
  const channels = [{id:'telegram',platform:'telegram',enabled:true,connected:true,revision:1,
    caps:{maxText:4096,maxCaption:1024,maxMedia:10,mediaMode:'photos'}}];
  const information = createCompanyInformation(db,{now});
  const api = createAutoposting(db,{information,now,transport:{getSettings:() => ({channels:structuredClone(channels)}),
    publish:() => assert.fail('calendar must never send')}});
  const mentor = createMediaMentor(db,{now});
  const transfer = createMediaMentorTransfer(db,{mentor,autoposting:api,information,now});
  function ready(post, patch = {}) {
    const edited = api.update(post.id,'qa',{revision:post.revision,text:'Fixture text',
      mediaUrls:['https://example.test/card.jpg'],platformIds:['telegram'],...patch},ACTOR);
    return api.approve(edited.id,'qa',{revision:edited.revision,approved:true},ACTOR);
  }
  function plan() {
    const brief = mentor.saveBrief('qa',{revision:0,brief:{goal:'Bookings',product:'Massage',audience:'Office workers',
      pains:['Tension'],confirmedFacts:[{id:'f1',statement:'Open daily',source:'Company card'}],
      assets:[],shootingComfort:{level:'hands_only',notes:''},platforms:['telegram']}},ACTOR);
    const saved = mentor.savePlan('qa',{planRevision:0,briefRevision:brief.brief.revision,
      days:Array.from({length:7},(_,i) => ({date:`2026-10-0${i+1}`,platform:'telegram',format:'post',role:'reach',topic:`Fixture ${i+1}`}))},ACTOR);
    const versions = {planRevision:saved.plan.revision,briefRevision:brief.brief.revision};
    mentor.decide('qa',{...versions,decision:'approved',comment:''},ACTOR);
    return transfer.transfer('qa',versions,ACTOR).posts;
  }
  return {db,api,channels,ready,plan};
}

test('moving a ready transferred card cannot cover another current plan slot on the new date', async t => {
  const f = fixture(t), posts = f.plan();
  f.ready(posts[0],{scheduledAt:'2026-10-02T12:00:00.000Z'});
  const result = await f.api.calendar('qa',PERIOD);
  assert.ok(result.coverage.uncoveredDates.includes('2026-10-01'));
  assert.ok(result.coverage.uncoveredDates.includes('2026-10-02'),'the second slot still contains its own unfinished draft');
  assert.equal(result.summary.coveredPlanDays,0);
});

test('a cancelled transferred card is a missing slot even though its draft still exists', async t => {
  const f = fixture(t), posts = f.plan();
  f.api.cancel(posts[0].id,'qa',{revision:posts[0].revision});
  const result = await f.api.calendar('qa',PERIOD);
  const slot = result.coverage.days[0].platforms[0];
  assert.equal(slot.planned,1);
  assert.equal(slot.missing,1);
  assert.ok(result.coverage.uncoveredDates.includes('2026-10-01'));
});

test('an old external receipt blocks repeat delivery but does not cover the current content revision', async t => {
  const f = fixture(t), posts = f.plan(), first = f.ready(posts[0]);
  f.api.recordReceipt(first.id,'qa',{platform:'telegram',url:'https://t.me/fixture_channel/1',
    publishedAt:'2026-09-23T12:00:00.000Z',contentRevision:first.contentRevision},ACTOR);
  const edited = f.api.update(first.id,'qa',{revision:first.revision,text:'New current content'},ACTOR);
  f.api.approve(edited.id,'qa',{revision:edited.revision,approved:true},ACTOR);
  const result = await f.api.calendar('qa',PERIOD), post = result.posts.find(p => p.id === first.id);
  assert.equal(post.externalReceipts[0].stale,true);
  assert.equal(post.calendarReadiness.state,'missing');
  assert.equal(result.coverage.days[0].platforms[0].published,0);
  assert.ok(result.coverage.uncoveredDates.includes('2026-10-01'));
});

test('current external publication proof covers a slot without pretending delivery is connected', async t => {
  const f = fixture(t), post = f.plan()[0];
  f.api.recordReceipt(post.id,'qa',{platform:'telegram',url:'https://t.me/fixture_channel/2',
    publishedAt:'2026-09-23T12:00:00.000Z',contentRevision:post.contentRevision},ACTOR);
  const result = await f.api.calendar('qa',PERIOD), view = result.posts.find(p => p.id === post.id);
  assert.equal(view.platformIds.length,0);
  assert.equal(view.calendarReadiness.state,'published');
  assert.equal(view.calendarReadiness.ready,false);
  assert.equal(result.coverage.days[0].platforms[0].published,1);
  assert.equal(result.summary.readyPosts,0);
});

test('a connected channel with a new revision does not make an old scheduled delivery ready', async t => {
  const f = fixture(t);
  const draft = f.api.create('qa',{scheduledAt:'2026-10-01T12:00:00.000Z'});
  const post = f.ready(draft);
  await f.api.schedule(post.id,'qa',{revision:post.revision});
  f.channels[0].revision = 2;
  const result = await f.api.calendar('qa',PERIOD);
  assert.equal(result.posts[0].calendarReadiness.ready,false);
  assert.equal(result.posts[0].calendarReadiness.state,'missing');
});

test('transport-rejected media URLs and absent dates cannot become calendar-ready stock', async t => {
  const f = fixture(t);
  const dated = f.ready(f.api.create('qa',{scheduledAt:'2026-10-01T12:00:00.000Z'}),
    {mediaUrls:['http://example.test/card.jpg']});
  const undated = f.ready(f.api.create('qa',{}));
  const video = f.ready(f.api.create('qa',{scheduledAt:'2026-10-01T12:00:00.000Z'}),
    {mediaUrls:['https://example.test/card.mp4']});
  const result = await f.api.calendar('qa',PERIOD);
  assert.equal(result.posts.find(p => p.id === dated.id).calendarReadiness.ready,false);
  assert.equal(result.undated.find(p => p.id === undated.id).calendarReadiness.ready,false);
  assert.equal(result.posts.find(p => p.id === video.id).calendarReadiness.ready,false);
  assert.equal(result.summary.readyPosts,0);
});

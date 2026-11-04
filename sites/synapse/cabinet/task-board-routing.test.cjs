'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');

test('existing owner task links open the compact board, task deep links and leave cleanup', async t => {
  const dom = new JSDOM('<div id="tasks-content"></div><span id="tasks-badge"></span><dialog id="task-create-dialog"><button data-task-create-close></button><form id="task-create-form"></form></dialog>', {url:'https://example.test/#tasks',runScripts:'outside-only'});
  t.after(() => dom.window.close());
  const w = dom.window, mounts = [];
  let destroys = 0;
  w.SbCabinet = {registerView: (_, view) => { w.view = view; }};
  w.SbTaskBoard = {mount: (container, ctx, options) => {
    mounts.push({container,ctx,options});
    return {destroy: () => { destroys++; }};
  }};
  w.eval(fs.readFileSync(__dirname + '/tasks.js','utf8'));
  const ctx = {identity:{role:'owner'},currentView:'tasks',byId:id => w.document.getElementById(id)};
  for (const [route,view,id] of [['tasks','projects'],['tasks/board','board'],['tasks/today','today'],['tasks/agents','agents'],['tasks/26','projects',26]]) {
    w.history.replaceState(null,'','#'+route);
    w.view.render(w.document.getElementById('tasks-content'),ctx);
    assert.equal(mounts.at(-1).options.view,view);
    assert.equal(mounts.at(-1).options.taskId,id);
    assert.equal(mounts.at(-1).container.id,'tasks-content');
  }
  w.view.onLeave();
  assert.equal(destroys,mounts.length);
});

test('board app starts inside existing cabinet and its icons exist; resources are versioned', () => {
  const root = __dirname + '/..';
  const manifest = JSON.parse(fs.readFileSync(root+'/board.webmanifest','utf8'));
  assert.equal(manifest.start_url,'/cabinet.html?board=1#tasks');
  assert.equal(manifest.display,'standalone');
  for (const icon of manifest.icons) assert.ok(fs.existsSync(root+'/'+icon.src));
  const page = fs.readFileSync(root+'/cabinet.html','utf8');
  assert.match(page,/SB_CABINET_ASSET_VERSION = "\d{8}-[a-z0-9-]+"/);
  assert.ok(page.indexOf('"task-overview", "task-text", "task-board"') > 0);
  assert.ok(page.indexOf('"task-board", "tasks"') > 0);
  assert.match(page,/data-owner-board-entry/);
  assert.match(page,/link\.hasAttribute\('data-owner-board-entry'\) \? identity\?\.role !== 'owner'/);
  assert.match(page,/ownerBoard \? 'board.webmanifest' : 'manifest.webmanifest'/);
  const dom = new JSDOM(page);
  for (const script of dom.window.document.querySelectorAll('script:not([src])')) new Function(script.textContent);
  dom.window.close();
});

test('extended owner record keeps the previous attachment and assistant controls reachable', async t => {
  const dom = new JSDOM('<div id="tasks-content"></div><span id="tasks-badge"></span><dialog id="task-create-dialog"><button data-task-create-close></button><form id="task-create-form"></form></dialog>', {url:'https://example.test/#tasks/record/26',runScripts:'outside-only'});
  t.after(() => dom.window.close());
  const w=dom.window,calls=[];
  w.SbCabinet={registerView:(_,view)=>{w.view=view;}};
  w.SbTaskBoard={mount:()=>{throw Error('Extended record must use existing renderer');}};
  w.eval(fs.readFileSync(__dirname+'/tasks.js','utf8'));
  const ctx={identity:{role:'owner',companies:[]},currentView:'tasks',byId:id=>w.document.getElementById(id),
    scopeParams:()=>({companyCode:'alpha'}),escapeHTML:String,crmQuery:async (path,params)=>{calls.push({path,params});throw Error('Synthetic record reached');}};
  w.view.render(w.document.getElementById('tasks-content'),ctx);
  for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls[0].path,'/tasks/26');
  assert.equal(calls[0].params.companyCode,'');
  assert.equal(w.location.hash,'#tasks/record/26');
});

test('late extended-record responses cannot overwrite the compact board after navigation', async t => {
  const dom = new JSDOM('<div id="tasks-content"></div><span id="tasks-badge"></span><dialog id="task-create-dialog"><button data-task-create-close></button><form id="task-create-form"></form></dialog>',{url:'https://example.test/#tasks/record/26',runScripts:'outside-only'});
  t.after(()=>dom.window.close());
  const w=dom.window;let rejectRecord;
  w.SbCabinet={registerView:(_,view)=>{w.view=view;}};
  w.SbTaskBoard={mount:container=>{container.textContent='CURRENT COMPACT';return {destroy(){}};}};
  w.eval(fs.readFileSync(__dirname+'/tasks.js','utf8'));
  const ctx={identity:{role:'owner',companies:[]},currentView:'tasks',byId:id=>w.document.getElementById(id),scopeParams:()=>({companyCode:'alpha'}),escapeHTML:String,
    crmQuery:()=>new Promise((_,reject)=>{rejectRecord=reject;})};
  const container=w.document.getElementById('tasks-content');
  w.view.render(container,ctx);
  for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));
  w.history.replaceState(null,'','#tasks');w.view.render(container,ctx);
  rejectRecord(Error('Late legacy failure'));
  for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(container.textContent,'CURRENT COMPACT');
});

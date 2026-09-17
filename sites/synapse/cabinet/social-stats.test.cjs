'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const tick=()=>new Promise(resolve=>setImmediate(resolve));const settle=async()=>{for(let i=0;i<8;i++)await tick();};
const platform=(label,over={})=>({label,configured:false,provider:null,enabled:false,access:{status:'not_configured',missing:['аккаунт площадки не настроен в кабинете']},dataStatus:'no_data',lastCollectedAt:null,lastRun:null,totals:{},latest:{},days:{},kinds:[],...over});
const overview=(code='demo-travel')=>({companyCode:code,from:'2026-09-01',to:'2026-09-18',timezone:'Asia/Bangkok',platforms:{
  instagram:platform('Instagram',{configured:true,provider:'direct',enabled:true,access:{status:'missing_access',missing:['Meta-приложение и App Review','решение владельца']},lastRun:{status:'missing_access',date:'2026-09-18',missing:['Meta-приложение и App Review'],error:''}}),
  tiktok:platform('TikTok'),youtube:platform('YouTube'),
  vk:platform('ВКонтакте',{configured:true,provider:'direct',enabled:true,dataStatus:'complete',lastCollectedAt:'2026-09-18T02:00:00.000Z',lastRun:{status:'ok',date:'2026-09-18',missing:[],error:''},totals:{views:40,reach:25},latest:{followers:{value:87,date:'2026-09-18'}},days:{'2026-09-17':{views:{value:40,kind:'organic'},reach:{value:25,kind:'organic'}}},kinds:['organic']}),
  telegram:platform('Telegram',{configured:true,provider:'direct',enabled:true,dataStatus:'partial',lastRun:{status:'partial',date:'2026-09-18',missing:['просмотры постов: Bot API их не отдаёт'],error:''},latest:{followers:{value:1234,date:'2026-09-18'}},totals:{},days:{},kinds:[]})},
  socialAggregate:{views:40,impressions:null,likes:null,comments:null,shares:null,saves:null,reach:null,reachNote:'Охват площадок не суммируется: уникальный охват — UNKNOWN.'},
  crm:{posts:[{platform:'instagram',platformPostId:'ig-1',url:'https://www.instagram.com/reel/abc/',contentId:'12',leads:2,sales:1,revenue:15000,confidence:'utm'}],bySource:[{source:'instagram',leads:3,sales:2,revenue:24000}],note:'Только по подтверждённой метке.'},
  runs:[{id:1,platform:'vk',provider:'direct',trigger:'schedule',date:'2026-09-18',started_at:'2026-09-18T02:00:00.000Z',finished_at:'2026-09-18T02:00:01.000Z',status:'ok',rows:7,error:'',missing:[]}]});
function fixture({role='owner',permissions=[],override}={}) {
  const dom=new JSDOM('<section id="view"></section>',{url:'https://cabinet.example.test/',runScripts:'outside-only'}),w=dom.window,d=w.document,views={},calls=[];
  w.SbCabinet={registerView:(name,view)=>{views[name]=view;}};w.eval(fs.readFileSync(__dirname+'/social-stats.js','utf8'));
  const ctx={selectedProjectId:'demo-travel',identity:{role,permissions,companies:[{id:'demo-travel',name:'Демо-проект'}]},csrfOptions:(method,body)=>({method,headers:{'X-CSRF-Token':'t'},body:JSON.stringify(body)}),
    apiJson:async(url,options={})=>{const u=new URL(url,'https://cabinet.example.test/');const call={path:u.pathname,code:u.searchParams.get('companyCode'),method:options.method||'GET',body:options.body?JSON.parse(options.body):null};calls.push(call);
      if(override){const r=await override(call);if(r!==undefined)return r;}
      if(call.path==='/content/crm/social-stats')return overview(call.code);
      if(call.path==='/content/crm/social-stats/accounts')return {companyCode:call.code,accounts:['instagram','tiktok','youtube','vk','telegram'].map(p=>({platform:p,label:p,accountRef:'',provider:'manual',enabled:false,kind:'organic',collectHour:6,revision:0,access:{status:'not_configured',missing:[]}}))};
      if(call.path==='/content/crm/social-stats/collect')return {status:'missing_access',missing:['x']};
      if(call.path==='/content/crm/social-stats/import')return {ok:true,rows:call.body.rows.length};
      throw new Error('unexpected '+call.path);}};
  return {w,d,ctx,calls,views,container:d.getElementById('view'),render:async()=>{views['social-stats'].render(d.getElementById('view'),ctx);await settle();},close:()=>w.close()};
}
test('сводка: UNKNOWN показывается прочерком, не нулём; уникальный охват не суммируется; статусы доступа и список недостающего честные; атрибуция по UTM',async()=>{
  const f=fixture();try{
    await f.render();const text=f.container.textContent;
    assert.match(text,/Уникальный охват—|Уникальный охват\s*—/);assert.match(text,/не суммируется/);
    const ig=f.container.querySelector('[data-platform="instagram"]');assert.match(ig.textContent,/нет доступа/);assert.match(ig.textContent,/Meta-приложение/);assert.doesNotMatch(ig.textContent,/\b0\b/);
    {const tg=f.container.querySelector('[data-platform="telegram"]').textContent;assert.match(tg,/собрано частично/);assert.match(tg,/Подписчики/);assert.match(tg,/1\s?234/);}
    assert.match(f.container.querySelector('[data-platform="tiktok"]').textContent,/не настроен/);
    assert.match(f.container.querySelector('.social-crm').textContent,/UTM-метка/);assert.match(f.container.querySelector('.social-crm').textContent.replace(/\u00a0/g,' '),/15 000/);
    assert.doesNotMatch(f.container.innerHTML,/token|Bearer/i);
    assert.ok(f.container.querySelector('#social-accounts-form'),'владелец видит настройки');
    assert.ok(f.calls.every(c=>c.code==='demo-travel'));
  }finally{f.close();}
});
test('аналитик читает, но не видит настроек и импорта; поздний ответ другой компании не рисуется; ключ в поле аккаунта отклоняется у владельца',async()=>{
  const viewer=fixture({role:'marketer',permissions:['analytics.view']});try{await viewer.render();assert.equal(viewer.container.querySelector('#social-accounts-form'),null);assert.equal(viewer.container.querySelector('#social-import-form'),null);assert.ok(viewer.calls.every(c=>c.method==='GET'));}finally{viewer.close();}
  const none=fixture({role:'marketer',permissions:[]});try{await none.render();assert.equal(none.container.children.length,0);assert.equal(none.calls.length,0);}finally{none.close();}
  let release;const gate=new Promise(r=>{release=r;});let first=true;
  const f=fixture({override:async call=>{if(call.path==='/content/crm/social-stats'&&first){first=false;await gate;return overview('demo-travel');}}});
  try{
    f.views['social-stats'].render(f.container,f.ctx);await settle();
    f.ctx.selectedProjectId='alvi';release();await settle();
    assert.equal(f.container.querySelector('.social-grid'),null,'ответ прежней компании не отрисован');
    f.ctx.selectedProjectId='demo-travel';await f.render();
    const form=f.container.querySelector('#social-accounts-form');form.elements['vk.accountRef'].value='token=abc';form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await settle();
    assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);assert.match(f.container.querySelector('#social-accounts-state').textContent,/Ключи сюда вводить нельзя/);
    form.elements['vk.accountRef'].value='club240466302';form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await settle();
    const put=f.calls.find(c=>c.method==='PUT');assert.equal(put.body.accounts.find(a=>a.platform==='vk').accountRef,'club240466302');assert.equal(put.body.accounts[0].timezone,'Asia/Bangkok');
  }finally{f.close();}
});

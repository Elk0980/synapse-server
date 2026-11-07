/* specs/217: скриншоты вкладки Статистика с блоком «рилс → заявки → продажи → выручка» на 390 и 1440.
   Данные — SAMPLE (синтетические), запросы к CRM подменены; реальных данных клиентов нет. */
const {chromium}=require('playwright'),fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'../..'),dir=path.join(root,'sites/synapse'),out=__dirname;
const SAMPLE={companyCode:'sample',mode:'LIVE',settings:{companyCode:'sample',enabled:true,active:true,revision:1,label:'Подробнее:',siteUrl:'https://sample.example.test/',reason:''},
  unmatched:{leads:0,visits:0},totals:{visits:41,leads:6,sales:2,revenue:18000,salesWithoutAmount:0},
  reels:[{postId:12,title:'SAMPLE · Как записаться',themeId:12,visits:30,leads:4,sales:2,revenue:18000,salesWithoutAmount:0,platforms:[{platform:'vk',linkStatus:'added'},{platform:'telegram',linkStatus:'added'}],lifetime:{revenue:18000,cost:6000,romi:200,romiReason:''}},
    {postId:14,title:'SAMPLE · День в студии',themeId:12,visits:11,leads:2,sales:0,revenue:0,salesWithoutAmount:0,platforms:[{platform:'instagram',linkStatus:'added'}],lifetime:{revenue:0,cost:null,romi:null,romiReason:'Расход на рилс не внесён (Расходы, источник cf-post-<номер>).'}}],
  themes:[{themeId:12,title:'SAMPLE · Как записаться',postIds:[12,14],visits:41,leads:6,sales:2,revenue:18000,salesWithoutAmount:0,lifetime:{romi:200,romiReason:''}}]};
const STATS={companyCode:'sample',from:'2026-10-09',to:'2026-11-07',socialAggregate:{},platforms:{},crm:{posts:[]}};
(async()=>{const browser=await chromium.launch({headless:true});const results=[];try{
for(const width of [390,1440])for(const variant of ['live','empty']){
  const page=await browser.newPage({viewport:{width,height:width===390?844:900},colorScheme:'dark'}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body></body></html>'}));
  await page.goto('http://sample.test');
  const html=fs.readFileSync(path.join(dir,'cabinet.html'),'utf8'),inline=[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n');
  await page.setContent(`<!doctype html><html lang="ru" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${inline}</style></head><body><main style="max-width:1200px;margin:auto;padding:12px 16px"><section class="view-panel" data-view="content-stats" id="root"></section></main></body></html>`);
  for(const file of ['common.css','cf-kit.css','content-connections.css'])if(fs.existsSync(path.join(dir,'cabinet',file)))await page.addStyleTag({content:fs.readFileSync(path.join(dir,'cabinet',file),'utf8')});
  await page.addScriptTag({content:fs.readFileSync(path.join(dir,'cabinet/cf-kit.js'),'utf8')});
  await page.addScriptTag({content:fs.readFileSync(path.join(dir,'cabinet/content-stats.js'),'utf8')});
  const report=variant==='live'?SAMPLE:{...SAMPLE,mode:'NO_DATA',reels:[],themes:[],totals:{visits:0,leads:0,sales:0,revenue:0},settings:{...SAMPLE.settings,enabled:false,active:false,revision:0}};
  await page.evaluate(async({report,stats})=>{
    const ctx={companyCode:'sample',user:{role:'owner'},csrfToken:'',can:()=>true,signal:new AbortController().signal,
      crm:async(p)=>p==='/social-stats/reel-attribution'?report:p==='/social-stats'?stats:null};
    await window.SbCabinet.contentStats.definition.mount(document.querySelector('#root'),ctx);
    await new Promise(r=>setTimeout(r,50));
  },{report,stats:STATS});
  await page.waitForSelector('[data-cs-funnel]');
  const metrics=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
  assert.ok(metrics.scroll<=metrics.width,JSON.stringify(metrics));assert.equal(errors.length,0,errors.join('\n'));
  const file=`${width}-${variant}.png`;await page.screenshot({path:path.join(out,file),fullPage:true});
  results.push({width,variant,file,metrics,errors});await page.close();
}
fs.writeFileSync(path.join(out,'visual-results.json'),JSON.stringify(results,null,2));console.log('PASS',results.length,'screens, overflow 0, console errors 0');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});

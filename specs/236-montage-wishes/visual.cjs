let browserRuntime;try{browserRuntime=require('playwright');}catch{browserRuntime=require('playwright-core');}
const {chromium}=browserRuntime,fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),dir=path.join(root,'sites/synapse'),out=__dirname;
const segments=Array.from({length:8},(_,i)=>({startMs:i*3000,endMs:(i+1)*3000,label:['С чего начинается отдых','Мастер подбирает программу','Здесь можно расслабиться','Тёплый свет и спокойная музыка','Массаж помогает восстановиться','Загляните после рабочего дня','Выберите удобное время','Приходите отдохнуть'][i]}));
const media='http://sample.test/content/publishing-assets/sample/'+'a'.repeat(32)+'.mp4';
const summary={id:4,key:'reel:4',source:'materials',companyCode:'sample',title:'SAMPLE · Первый визит и спокойный вечер',releaseDate:'2026-11-23',platforms:['instagram','vk'],currentVersion:{version:1,mediaUrl:media,durationMs:24000,segments},versionCount:1,openEdits:0,openRequests:0};
const reel={...summary,versions:[summary.currentVersion],requests:[],edits:[],history:[],log:[]};
(async()=>{
 let browser;try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({channel:'chrome',headless:true});}
 const results=[];
 try {for(const [width,height] of [[360,800],[390,844],[430,932],[1366,768]]) {
  const page=await browser.newPage({viewport:{width,height},colorScheme:'dark'}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().resourceType()==='document'?r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ru"><body></body></html>'}):r.fulfill({status:204,body:''}));
  await page.goto('http://sample.test/');
  const html=fs.readFileSync(path.join(dir,'cabinet.html'),'utf8'),inline=[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n');
  await page.setContent(`<!doctype html><html lang="ru" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${inline}</style></head><body><main class="main"><section class="view-panel"><div id="root"></div></section></main></body></html>`);
  for(const file of ['common.css','cf-kit.css','materials.css','reel-editor.css'])await page.addStyleTag({content:fs.readFileSync(path.join(dir,'cabinet',file),'utf8')});
  await page.evaluate(()=>window.SynapseModulesQueue=[]);
  for(const file of ['cf-kit.js','materials.js'])await page.addScriptTag({content:fs.readFileSync(path.join(dir,'cabinet',file),'utf8')});
  await page.evaluate(async({summary,reel})=>{
   let current=structuredClone(reel);
   const definition=window.SynapseModulesQueue.find(x=>x[0]==='content-materials')[1];
   const answer=async(method,route,body)=>{
    if(route==='crm/autoposting/reels')return {companyCode:'sample',reels:[structuredClone(summary)]};
    if(route.endsWith('/live-edit')) {const request={id:1,kind:'redo',status:'accepted',version:1,editId:9,notes:body.notes,text:'Живой монтаж; выключены отрезки: 3. SAMPLE пожелания',clientRequestId:body.clientRequestId,createdAt:'2026-11-21T09:40:00Z'};current={...current,openEdits:1,requests:[request],edits:[{id:9,kind:'edl',baseVersion:1,status:'pending',edl:{live:{segments:body.segments}}}]};return {reel:structuredClone(current),request};}
    if(route.endsWith('/requests/1/cancel')){current={...current,openEdits:0,requests:current.requests.map(r=>({...r,status:'rejected',reply:'Отменено автором.'})),edits:current.edits.map(e=>({...e,status:'cancelled'}))};return structuredClone(current);}
    if(route==='crm/autoposting/reels/4')return structuredClone(current);
    throw Object.assign(Error('нет данных'),{status:404});
   };
   await definition.mount(document.getElementById('root'),{companyCode:'sample',user:{id:7},can:()=>true,signal:new AbortController().signal,route:{path:''},settings:{content:{get:async()=>({settings:{}})}},api:{get:r=>answer('GET',r),post:(r,b)=>answer('POST',r,b),patch:(r,b)=>answer('PATCH',r,b)},navigate:()=>{}});
  },{summary,reel});
  await page.click('[data-open="reel:4"]');await page.waitForSelector('[data-live-box]');
  const measure=async state=>{
   const m=await page.evaluate(()=>{
    const rect=n=>n.getBoundingClientRect(),detail=document.querySelector('[data-detail]'),layer=document.querySelector('[data-wish-layer]');
    const visible=n=>rect(n).width&&rect(n).height&&getComputedStyle(n).visibility!=='hidden';
    const scope=layer&&!layer.hidden?layer:detail;
    const bar=document.querySelector('[data-live-actions]'),mask=document.querySelector('.mt-toggle'),a=bar&&rect(bar),b=rect(mask);
    const maskOverlap=Boolean(a&&a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top);
    return {maskOverlap,width:innerWidth,scroll:document.documentElement.scrollWidth,detailScroll:detail.scrollWidth,detailClient:detail.clientWidth,screenHeight:rect(document.querySelector('.mt-screen')).height,
      outside:[...scope.querySelectorAll('*')].filter(n=>visible(n)&&(rect(n).right>innerWidth+1||rect(n).left<-1)).map(n=>n.className||n.tagName),
      low:[...scope.querySelectorAll('button,select,textarea,summary')].filter(n=>visible(n)&&rect(n).height<43.5).map(n=>n.textContent.trim().slice(0,25)+':'+Math.round(rect(n).height)),
      save:document.querySelector('[data-live-save]')?{top:rect(document.querySelector('[data-live-save]')).top,bottom:rect(document.querySelector('[data-live-save]')).bottom}:null};
   });
   assert.equal(m.scroll,width,JSON.stringify(m));assert.ok(m.detailScroll<=m.detailClient+1,JSON.stringify(m));assert.deepEqual(m.outside,[],JSON.stringify(m));assert.deepEqual(m.low,[],JSON.stringify(m));
   if(width<900)assert.ok(m.screenHeight>=height*.4-1,'плеер уменьшен');else assert.equal(m.maskOverlap,false,'кнопки перекрывают Маску площадки');
   results.push({width,height,state,...m});
  };
  await measure('phrases');await page.screenshot({path:path.join(out,`sample-${width}-phrases.png`)});
  await page.click('[data-live-seek="1"]');await measure('phrase-sheet');if(width===390)await page.screenshot({path:path.join(out,'sample-390-phrase-sheet.png')});await page.click('[data-wish-close]');
  for(const type of ['font','transition','volume','music','insert','other']) {
   await page.click(`[data-wish-type="${type}"]`);await measure(type);
   if(width===390)await page.screenshot({path:path.join(out,`sample-390-${type}.png`)});
   await page.fill('[data-wish-form] textarea',type==='insert'?'Вид с балкона — https://example.test/folder':'SAMPLE пожелание');
   await page.click('[data-wish-form] button[type=submit]');
  }
  await page.click('[data-live-toggle="enabled:2"]');
  await page.locator('[data-wish-list]').scrollIntoViewIfNeeded();await measure('summary');if(width===390)await page.screenshot({path:path.join(out,'sample-390-summary.png')});
  await page.click('[data-live-save]');await page.waitForSelector('[data-request="1"]');await measure('sent');if(width===390)await page.screenshot({path:path.join(out,'sample-390-sent.png')});
  await page.click('[data-request-cancel="1"]');await measure('cancel-confirm');if(width===390)await page.screenshot({path:path.join(out,'sample-390-cancel-confirm.png')});
  await page.click('[data-request-cancel-no="1"]');assert.equal(await page.locator('[data-request-cancel-confirm]').count(),0);
  await page.click('[data-request-cancel="1"]');await page.click('[data-request-cancel-confirm="1"]');await measure('cancelled');assert.equal(await page.locator('[data-request="1"] .mt-request__status').textContent(),'отменено');if(width===390)await page.screenshot({path:path.join(out,'sample-390-cancelled.png')});
  if(width>=900){
    await page.evaluate(()=>window.samplePlayer=document.querySelector('[data-player]'));
    await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.querySelector('[data-live-actions]').parentElement.matches('[data-detail]'));
    assert.ok(await page.locator('.mt-screen').evaluate(n=>n.getBoundingClientRect().height>=337));
    await page.setViewportSize({width,height});await page.waitForFunction(()=>document.querySelector('[data-live-actions]').parentElement.matches('.mt-side'));
    assert.ok(await page.locator('[data-player]').evaluate(n=>n===window.samplePlayer),'изменение ширины пересоздало плеер');
  }
  assert.deepEqual(errors,[]);await page.close();
 }}finally{await browser.close();}
 fs.writeFileSync(path.join(out,'visual-results.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify({states:results.length,widths:[360,390,430,1366],pass:true}));
})().catch(e=>{console.error(e);process.exit(1);});

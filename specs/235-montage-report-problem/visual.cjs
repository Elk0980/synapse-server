/* specs/231: окно ролика в «Монтаже» с решением, просьбами агенту и «живым монтажом» — телефон 390 и ноутбук 1366.
   Настоящие materials.js, cf-kit.js и стили кабинета; API подменено заглушкой, данные SAMPLE (синтетические), видеофайла нет.
   Проверяется: нет горизонтальной прокрутки, ничего не выходит за ширину окна, нажимаемое в новых блоках не ниже 44 px.
   Запуск: node specs/231-lena-materials-requests/visual.cjs */
const {chromium}=require('playwright'),fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'../..'),dir=path.join(root,'sites/synapse'),out=__dirname;
const media='http://sample.test/content/publishing-assets/sample/'+'a'.repeat(32)+'.mp4';
const segments=[{startMs:0,endMs:3000,label:'SAMPLE вход'},{startMs:3000,endMs:6500},{startMs:6500,endMs:11000,label:'SAMPLE рассказ мастера'},{startMs:11000,endMs:15000,label:'SAMPLE финал'}];
const summary={id:4,key:'reel:4',source:'materials',companyCode:'sample',title:'SAMPLE · Как проходит первый визит — длинное название для проверки переноса',releaseDate:'2026-11-23',platforms:['instagram','vk','telegram'],
  postId:null,currentVersion:{version:2,mediaUrl:media,durationMs:15000,segments},versionCount:2,openEdits:0,caption:'SAMPLE подпись ролика',decision:'redo',decisionComment:'SAMPLE: затянуто начало',openRequests:2};
const REEL={...summary,versions:[{version:1,mediaUrl:media,durationMs:16000},{version:2,mediaUrl:media,durationMs:15000,segments}],edits:[],log:[],
  requests:[
    {id:1,reelId:4,kind:'redo',status:'ready',text:'SAMPLE: уберите паузу в начале',version:1,startMs:1000,endMs:2500,date:'',reply:'Готова новая версия v2. Посмотрите и скажите, подходит ли.',authorName:'SAMPLE Редактор',createdAt:'2026-11-20T03:00:00Z',events:[]},
    {id:2,reelId:4,kind:'publish',status:'waiting_owner',text:'',version:2,startMs:null,endMs:null,date:'',reply:'Черновик публикации №7 создан, на площадки ничего не отправлено. Публикацию должен согласовать владелец (ждут решения: Instagram, ВКонтакте). После согласования она пойдёт в план.',authorName:'SAMPLE Редактор',createdAt:'2026-11-20T04:00:00Z',events:[]},
    {id:3,reelId:4,kind:'reschedule',status:'accepted',text:'SAMPLE: после праздников',version:null,startMs:null,endMs:null,date:'2026-11-27',reply:'',authorName:'SAMPLE Редактор',createdAt:'2026-11-20T05:00:00Z',events:[]}],
  history:[{id:2,field:'decision',fieldLabel:'Решение',before:'',after:'redo',afterLabel:'переделать',comment:'SAMPLE: затянуто начало',authorName:'SAMPLE Редактор',at:'2026-11-20T02:00:00Z'},
    {id:1,field:'caption',fieldLabel:'Подпись',before:'',after:'SAMPLE подпись ролика',comment:'',authorName:'SAMPLE Редактор',at:'2026-11-20T01:00:00Z'}]};
(async()=>{
  let browser;try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({channel:'chrome',headless:true});}
  const results=[];
  try{
    for(const [width,height] of [[390,844],[1440,900]]){
      const page=await browser.newPage({viewport:{width,height},colorScheme:'dark'}),errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/*',r=>r.request().resourceType()==='document'?r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body></body></html>'}):r.fulfill({status:204,body:''}));
      await page.goto('http://sample.test/');
      const html=fs.readFileSync(path.join(dir,'cabinet.html'),'utf8'),inline=[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n');
      await page.setContent(`<!doctype html><html lang="ru" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${inline}</style></head>
        <body><main class="main"><section class="view-panel"><div id="root"></div></section></main></body></html>`);
      for(const file of ['common.css','cf-kit.css','materials.css','reel-editor.css'])await page.addStyleTag({content:fs.readFileSync(path.join(dir,'cabinet',file),'utf8')});
      await page.evaluate(()=>{window.SynapseModulesQueue=[];});
      for(const file of ['cf-kit.js','materials.js'])await page.addScriptTag({content:fs.readFileSync(path.join(dir,'cabinet',file),'utf8')});
      await page.evaluate(async({summary,reel})=>{
        const clone=v=>JSON.parse(JSON.stringify(v)),definition=window.SynapseModulesQueue.find(item=>item[0]==='content-materials')[1];
        const answer=async(method,route)=>{
          if(route==='crm/autoposting/reels'&&method==='GET')return {companyCode:'sample',reels:[clone(summary)]};
          if(route.endsWith('/problems'))return {taskId:91};
          if(route==='crm/autoposting/reels/4')return clone(reel);
          throw Object.assign(new Error('нет данных'),{status:404});};
        const ctx={moduleId:'content-materials',companyCode:'sample',can:()=>true,signal:new AbortController().signal,route:{path:''},settings:{content:{get:async()=>({settings:{}})}},
          api:{get:r=>answer('GET',r),post:r=>answer('POST',r),patch:r=>answer('PATCH',r)},navigate:()=>{}};
        await definition.mount(document.getElementById('root'),ctx);
        await new Promise(r=>setTimeout(r,100));
      },{summary,reel:REEL});
      await page.screenshot({path:path.join(out,`problem-list-${width}.png`)});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'нет переполнения списка');
      await page.click('[data-problem-open]');await page.fill('[data-problem-text]','SAMPLE: не работает звук');
      await page.screenshot({path:path.join(out,`problem-form-${width}.png`)});
      const metrics=await page.locator('[data-problem-form]').evaluate(n=>({scroll:n.scrollWidth,client:n.clientWidth,buttons:[...n.querySelectorAll('button')].filter(b=>!b.hidden).map(b=>b.getBoundingClientRect().height)}));
      assert.ok(metrics.scroll<=metrics.client);assert.ok(metrics.buttons.every(h=>h>=44));
      await page.click('[data-problem-send]');await page.waitForFunction(()=>document.querySelector('[data-problem-status]').textContent.includes('№91'));
      await page.click('[data-problem-close]');await page.click('[data-open="reel:4"]');
      await page.waitForSelector('[data-problem-card]');await page.screenshot({path:path.join(out,`problem-card-${width}.png`)});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'нет переполнения карточки');
      results.push({width,...metrics});assert.deepEqual(errors,[]);await page.close();
    }
  }finally{await browser.close();}
  fs.writeFileSync(path.join(out,'visual-results.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results));
})().catch(error=>{console.error(error);process.exit(1);});

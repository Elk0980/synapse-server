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
    for(const [width,height] of [[390,844],[1366,768]]){
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
          if(route==='crm/autoposting/reels/4')return clone(reel);
          throw Object.assign(new Error('нет данных'),{status:404});};
        const ctx={moduleId:'content-materials',companyCode:'sample',can:()=>true,signal:new AbortController().signal,route:{path:''},settings:{content:{get:async()=>({settings:{}})}},
          api:{get:r=>answer('GET',r),post:r=>answer('POST',r),patch:r=>answer('PATCH',r)},navigate:()=>{}};
        await definition.mount(document.getElementById('root'),ctx);
        await new Promise(r=>setTimeout(r,100));
      },{summary,reel:REEL});
      await page.screenshot({path:path.join(out,`montage-list-${width}.png`)});
      await page.click('[data-open="reel:4"]');await page.waitForSelector('[data-ask-box]');
      await page.click('[data-live-toggle="enabled:1"]');await page.click('[data-live-toggle="sound:2"]');
      await page.click('[data-ask="redo"]');await page.fill('[data-ask-form] textarea','SAMPLE: уберите паузу после приветствия');
      const m=await page.evaluate(()=>{
        const box=n=>n.getBoundingClientRect(),detail=document.querySelector('[data-detail]');
        const fresh=[...detail.querySelectorAll('.mt-review,.mt-ask,.mt-live,.mt-history')];
        const tappable=fresh.flatMap(n=>[...n.querySelectorAll('button,summary,.mt-decision__item,input[type=text],input[type=date],textarea')]).filter(n=>box(n).width>0);
        return {width:innerWidth,scroll:document.documentElement.scrollWidth,detailScroll:detail.scrollWidth,detailClient:detail.clientWidth,
          outside:[...detail.querySelectorAll('*')].filter(n=>box(n).width&&(box(n).right>innerWidth+1||box(n).left<-1)).map(n=>n.className||n.tagName),
          low:tappable.filter(n=>box(n).height<43.5).map(n=>(n.textContent||n.name||n.tagName).trim().slice(0,30)+':'+Math.round(box(n).height)),
          tappable:tappable.length,blocks:fresh.length,rows:detail.querySelectorAll('[data-live-row]').length,requests:detail.querySelectorAll('.mt-request').length,height:Math.ceil(detail.scrollHeight)};});
      assert.equal(m.scroll,m.width,'горизонтальная прокрутка страницы: '+JSON.stringify(m));
      assert.ok(m.detailScroll<=m.detailClient+1,'горизонтальная прокрутка окна ролика: '+JSON.stringify(m));
      assert.deepEqual(m.outside,[],'элементы за шириной окна');assert.deepEqual(m.low,[],'нажимаемое ниже 44 px');
      assert.equal(m.blocks,4);assert.equal(m.rows,4);assert.equal(m.requests,3);assert.deepEqual(errors,[]);
      await page.evaluate(()=>document.querySelector('[data-detail-modal]').scrollTo(0,0));
      if(width<900){
        const mobile=await page.evaluate(()=>{
          const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};};
          return {screen:rect('.mt-stick .mt-screen'),strip:rect('.mt-stick'),live:rect('.mt-live'),platforms:rect('.mt-platforms'),
            controls:[...document.querySelectorAll('.mt-transport button,.mt-transport input')].map(n=>n.getBoundingClientRect().height),
            saveInStrip:!!document.querySelector('.mt-stick [data-live-save]'),saveCount:document.querySelectorAll('[data-live-save]').length};
        });
        assert.ok(mobile.screen.height>=height*.4-1,'плеер не меньше 40vh');
        assert.ok(Math.abs(mobile.screen.width/mobile.screen.height-9/16)<.02,'кадр 9:16');
        assert.ok(mobile.controls.every(h=>h>=44),'управление не мельче 44px');
        assert.ok(mobile.live.top>=mobile.strip.bottom-1&&mobile.live.top<mobile.strip.bottom+20,'фразы сразу под плеером');
        assert.ok(mobile.platforms.top>mobile.live.bottom,'маска после фраз');
        assert.ok(mobile.saveInStrip);assert.equal(mobile.saveCount,1);
        await page.evaluate(()=>document.querySelector('[data-detail-modal]').scrollBy(0,500));
        assert.ok(await page.locator('.mt-stick').evaluate(n=>Math.abs(n.getBoundingClientRect().top-58)<1),'полоса закреплена');
        await page.evaluate(()=>document.querySelector('[data-detail-modal]').scrollTo(0,0));
      }
      await page.screenshot({path:path.join(out,`montage-detail-${width}-top.png`)});
      /* Вся карточка одним кадром: окно того же размера по ширине, высота — по содержимому. */
      await page.setViewportSize({width,height:Math.min(m.height+80,6000)});await page.waitForTimeout(100);
      await page.screenshot({path:path.join(out,`montage-detail-${width}.png`)});
      results.push({width,tappable:m.tappable,scrollWidth:m.scroll,files:[`montage-list-${width}.png`,`montage-detail-${width}-top.png`,`montage-detail-${width}.png`]});
      await page.close();
    }
  }finally{await browser.close();}
  fs.writeFileSync(path.join(out,'visual-results.json'),JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify(results));
})().catch(error=>{console.error(error);process.exit(1);});

/* specs/227: стенд «Текст публикации» в карточке контент-плана — 390 и 1440, без горизонтальной прокрутки. SAMPLE-данные. */
const {chromium}=require('playwright'),fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'../..'),dir=path.join(root,'sites/synapse'),out=__dirname;
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});const results=[];try{
for(const width of [390,1440]){
  const page=await browser.newPage({viewport:{width,height:width===390?844:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body></body></html>'}));await page.goto('http://sample.test');
  const html=fs.readFileSync(path.join(dir,'cabinet.html'),'utf8'),inline=[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n');
  await page.setContent(`<style>${inline}</style><main class="view-panel" style="max-width:1200px;margin:auto;padding:12px" id="root"></main>`);
  for(const file of ['shell.css','workspace.css','content-plan.css'])if(fs.existsSync(path.join(dir,'cabinet',file)))await page.addStyleTag({content:fs.readFileSync(path.join(dir,'cabinet',file),'utf8')});
  await page.addScriptTag({content:fs.readFileSync(path.join(dir,'cabinet/content-plan.js'),'utf8')});
  await page.evaluate(async()=>{
    const long='SAMPLE: '+'Длинный текст публикации с хештегами #массаж #иркутск и ссылкой https://example.test/очень-длинный-адрес-без-пробелов-для-проверки-переноса '.repeat(4);
    const days=[{ideaId:'s-1',date:'2026-11-12',platform:'vk',format:'reel',role:'reach',topic:'SAMPLE · Ответы на вопросы',
      variants:{vk:{text:long,contentRevision:2},telegram:{text:'',contentRevision:1},instagram:{text:'SAMPLE короткая подпись для Instagram',contentRevision:1}}},
      {ideaId:'s-2',date:'2026-11-13',platform:'telegram',format:'reel',role:'reach',topic:'SAMPLE · День в студии',variants:{telegram:{text:'SAMPLE подпись'}}}];
    const mentor={brief:{revision:1,fields:{platforms:['vk','telegram','instagram']}},plan:{revision:3,days},
      variants:[{ideaId:'s-1',platform:'vk',status:'approved'},{ideaId:'s-1',platform:'telegram',status:'empty'},{ideaId:'s-1',platform:'instagram',status:'pending'},{ideaId:'s-2',platform:'telegram',status:'pending'}],
      vocabulary:{platforms:[{id:'vk',label:'ВКонтакте'},{id:'telegram',label:'Telegram'},{id:'instagram',label:'Instagram / Reels'}],formats:[{id:'reel',label:'Рилс'}],roles:[{id:'reach',label:'Охватный'}],
        captionLimits:{vk:15000,telegram:1024,instagram:2200}}};
    const ctx={companyCode:'sample',user:{id:7,role:'owner'},signal:new AbortController().signal,can:()=>true,route:{params:new URLSearchParams()},navigate:()=>{},
      api:{get:async p=>p.endsWith('/questionnaire')?{revision:1,filled:1,total:8,fields:{platforms:['vk'],goals:''}}:p.endsWith('/signoffs')?{stage:'approval',planRevision:3,approvers:[],ideas:2,approvedIdeas:0,emptyIdeas:[]}:mentor},
      settings:{content:{get:async()=>null}}};
    await window.SbCabinet.contentPlan.definition.mount(document.querySelector('#root'),ctx);
  });
  await page.locator('[data-idea="s-1"] [data-toggle]').click();
  for(const screen of ['texts','edit']){
    if(screen==='edit')await page.locator('[data-cp-texts-edit]').click();
    const m=await page.evaluate(()=>{const box=document.querySelector('[data-cp-texts]').getBoundingClientRect();
      return {width:innerWidth,scroll:document.documentElement.scrollWidth,boxRight:Math.round(box.right),
        overflow:[...document.querySelectorAll('[data-cp-texts] *')].filter(n=>n.getBoundingClientRect().right>innerWidth+1).map(n=>n.className||n.tagName)};});
    assert.equal(m.scroll,m.width,JSON.stringify(m));assert.deepEqual(m.overflow,[]);assert.equal(errors.length,0,errors.join('\n'));
    await page.locator('[data-cp-texts]').scrollIntoViewIfNeeded();
    const file=`texts-${width}-${screen}.png`;await page.locator('[data-idea="s-1"]').screenshot({path:path.join(out,file)});results.push({width,screen,file,...m,errors:errors.length});
  }
  await page.close();}
console.log(JSON.stringify(results));console.log('PASS: 4 снимка, scrollWidth = ширине окна, элементы блока в пределах окна, ошибок консоли 0');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});

// Проверка окна «Удалить с площадок» в Chrome на 390 и 1440 px: SAMPLE-данные, сеть заглушена.
const {chromium}=require('playwright-core'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'../..'),dir=path.join(root,'sites/synapse');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME||'/usr/bin/google-chrome',headless:true});const results=[];
try{for(const width of [390,1440]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body></body></html>'}));
  await page.goto('http://sample.test');
  const html=fs.readFileSync(path.join(dir,'cabinet.html'),'utf8'),inline=[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n');
  await page.setContent(`<style>${inline}</style><style>${fs.readFileSync(path.join(dir,'cabinet/autoposting.css'),'utf8')}</style><section id="view"></section>`);
  await page.evaluate(()=>{window.SbCabinet={registerView:(n,v)=>{window.__view=v;}};});
  for(const f of ['company-information.js','autoposting.js'])await page.addScriptTag({content:fs.readFileSync(path.join(dir,'cabinet',f),'utf8')});
  await page.evaluate(async()=>{
    const post={id:40,companyCode:'sample',revision:5,status:'published',title:'SAMPLE · Очень длинное название опубликованного поста для проверки переноса строк',text:'SAMPLE',mediaUrls:[],platformIds:['telegram','instagram'],scheduledAt:null,timezone:'Asia/Irkutsk',profileRevision:2,
      deliveries:[{channelId:'telegram',status:'published',url:'https://t.me/sample_channel/81'}]};
    const targets=[{key:'direct:telegram:81',label:'Telegram',mode:'auto',note:'Удалим сообщение ботом канала.',url:'https://t.me/sample_channel/81'},
      {key:'provider:instagram:op-1',label:'Instagram',mode:'manual',note:'Onlypult не удаляет уже опубликованное: удалите пост на площадке вручную.',url:'https://www.instagram.com/p/SAMPLEVERYLONGIDENTIFIER1234567890/'},
      {key:'receipt:1',label:'ВКонтакте',mode:'manual',note:'Публикация отмечена вручную: удалите её на площадке сами.',url:'https://vk.com/wall-1_2'}];
    const ctx={identity:{role:'owner',permissions:[],companies:[{id:'sample',name:'SAMPLE'}]},selectedProjectId:'sample',csrfOptions:(m,b)=>({method:m,body:JSON.stringify(b)}),
      apiJson:async(url,o={})=>{const p=new URL(url,location.href).pathname;
        if(p.endsWith('/unpublish'))return o.method==='POST'?{postId:40,revision:5,state:'manual_pending',targets:targets.map((t,i)=>({...t,outcome:i?'manual':'removed'})),results:[]}:{postId:40,revision:5,state:'published',targets};
        if(p.endsWith('/autoposting/posts'))return {companyCode:'sample',posts:[post]};
        if(p.endsWith('/autoposting/settings'))return {timezone:'Asia/Irkutsk',channels:[{id:'telegram',platform:'telegram',provider:'direct',name:'Telegram',revision:1,enabled:true,connected:true,tokenConfigured:true,caps:{maxText:4096,maxMedia:10}}]};
        if(p.endsWith('/company-information'))return {companyCode:'sample',revision:2,profile:{name:'SAMPLE',timezone:'Asia/Irkutsk',socials:[]}};
        if(p.endsWith('/trash')||p.endsWith('/archived'))return {posts:[]};if(p.endsWith('/starter-plan'))return {companyCode:'sample',available:false,timezone:'Asia/Irkutsk',reviewNote:'',imports:{vk:null,telegram:null},topics:[]};
        return {};}};
    await window.__view.render(document.getElementById('view'),ctx);
    for(let i=0;i<50&&![...document.getElementById('autoposting-select').options].some(o=>o.value==='40');i++)await new Promise(r=>setTimeout(r,20));
    const sel=document.getElementById('autoposting-select');sel.value='40';sel.dispatchEvent(new Event('change',{bubbles:true}));
    document.getElementById('autoposting-editor').open=true;
  });
  await page.waitForSelector('#autoposting-unpublish-open');await page.click('#autoposting-unpublish-open');
  await page.waitForSelector('#autoposting-unpublish-yes');
  const measure=async stage=>{const m=await page.evaluate(()=>({doc:document.documentElement.scrollWidth,view:window.innerWidth,
    zone:(()=>{const z=document.getElementById('autoposting-unpublish-zone');return {scroll:z.scrollWidth,client:z.clientWidth};})()}));
    const shot=`${width}-${stage}.png`;await page.locator('#autoposting-unpublish-zone').screenshot({path:path.join(__dirname,shot)});
    results.push({width,stage,...m,noHorizontalScroll:m.doc<=m.view&&m.zone.scroll<=m.zone.client,errors:[...errors]});};
  await measure('confirm');await page.click('#autoposting-unpublish-yes');await page.waitForSelector('[data-unpublish-manual]');await measure('result');
  await page.close();}
}finally{await browser.close();}
fs.writeFileSync(path.join(__dirname,'visual-results.json'),JSON.stringify(results,null,1)+'\n');console.log(JSON.stringify(results));
if(results.some(r=>!r.noHorizontalScroll||r.errors.length))process.exit(1);})();

/* №228/№231/№232 (Spec-lite): лента «Постинг · что и куда уходит» с черновиком из «Монтажа» — 390 и 1440, без наложений и горизонтальной прокрутки.
   Данные — SAMPLE (синтетические), API кабинета подменено заглушкой; реальных данных клиентов нет. */
const {chromium}=require('playwright'),fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'../..'),dir=path.join(root,'sites/synapse'),out=__dirname;
const base={companyCode:'sample',revision:4,contentRevision:3,timezone:'Asia/Irkutsk',profileRevision:2,deliveries:[],approval:{approved:false,stale:false},readiness:{ready:true,issues:[]},platformIds:['telegram','vk']};
const POSTS=[
  {...base,id:71,status:'published',title:'№1 SAMPLE · Первый визит',text:'SAMPLE',mediaUrls:['https://sample.test/r1.mp4'],scheduledAt:'2026-11-05T10:30:00Z',approval:{approved:true,stale:false},
    deliveries:[{channelId:'telegram',status:'published',url:'https://t.me/sample_channel/15'},{channelId:'vk',status:'published',url:'https://vk.com/wall-1_2'}]},
  {...base,id:79,status:'draft',title:'№3 SAMPLE · «500 ₽» — длинное название ролика для проверки переноса строки в ленте',text:'',origin:'Материалы: ролик №8 v5',
    mediaUrls:['https://sample.test/reel8-v5.mp4'],scheduledAt:null,captions:{tiktok:''},platformIds:['telegram','vk','tiktok'],readiness:{ready:false,issues:['Нет текста и подписей площадок']}},
  {...base,id:80,status:'scheduled',title:'№4 SAMPLE · Уход после процедуры',text:'SAMPLE',mediaUrls:['https://sample.test/r4.mp4'],scheduledAt:'2026-11-09T11:30:00Z',approval:{approved:true,stale:false}}];
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});const results=[];try{
for(const width of [390,1440]){
  const page=await browser.newPage({viewport:{width,height:width===390?844:900},colorScheme:'dark'}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route('**/*',r=>r.request().url().startsWith('http://sample.test/')&&r.request().resourceType()==='document'
    ?r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body></body></html>'}):r.fulfill({status:204,body:''}));
  await page.goto('http://sample.test/');
  const html=fs.readFileSync(path.join(dir,'cabinet.html'),'utf8'),inline=[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n');
  await page.setContent(`<!doctype html><html lang="ru" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${inline}</style></head><body><main style="max-width:1200px;margin:auto;padding:12px 16px"><section class="view-panel" id="root"></section></main></body></html>`);
  for(const file of ['common.css','cf-kit.css','autoposting.css'])await page.addStyleTag({content:fs.readFileSync(path.join(dir,'cabinet',file),'utf8')});
  await page.evaluate(()=>{const N=Date;window.Date=class extends N{constructor(...a){super(...(a.length?a:['2026-11-07T05:00:00Z']));}static now(){return N.parse('2026-11-07T05:00:00Z');}};
    window.SbCabinet={registerView:(name,view)=>{(window.__views||(window.__views={}))[name]=view;}};});
  for(const file of ['cf-kit.js','company-information.js','autoposting.js'])await page.addScriptTag({content:fs.readFileSync(path.join(dir,'cabinet',file),'utf8')});
  await page.evaluate(async posts=>{
    const clone=v=>JSON.parse(JSON.stringify(v)),T=window.SbCabinet.companyTime;
    const ctx={selectedProjectId:'sample',identity:{role:'owner',permissions:[],companies:[{id:'sample',name:'SAMPLE студия'}]},csrfOptions:()=>({}),apiJson:async url=>{
      const u=new URL(url,'http://sample.test'),p=u.pathname,code=u.searchParams.get('companyCode');
      if(p.endsWith('/company-information'))return {companyCode:code,revision:2,profile:{timezone:'Asia/Irkutsk'}};
      if(p.endsWith('/settings'))return {timezone:'Asia/Irkutsk',channels:[{id:'telegram',platform:'telegram',name:'Telegram',enabled:true,connected:true,revision:1,provider:'direct'},{id:'vk',platform:'vk',name:'ВКонтакте',enabled:true,connected:true,revision:1,provider:'direct'}]};
      if(p.endsWith('/starter-plan'))return {companyCode:code,available:false};
      if(p.endsWith('/calendar')){const items=posts.map(i=>{const d=i.scheduledAt?T.toLocal(i.scheduledAt,'Asia/Irkutsk').slice(0,10):null;return {...clone(i),publishDate:d,effectiveDate:d,dateKind:d?'schedule':null};});
        const from=u.searchParams.get('from'),to=u.searchParams.get('to');
        return {companyCode:code,from,to,timezone:'Asia/Irkutsk',today:'2026-11-07',posts:items.filter(i=>i.effectiveDate&&i.effectiveDate>=from&&i.effectiveDate<=to),undated:items.filter(i=>!i.effectiveDate),truncated:false,undatedTruncated:false};}
      if(p.endsWith('/posts'))return {companyCode:code,posts:clone(posts)};
      const m=p.match(/\/posts\/(\d+)/);if(m)return clone(posts.find(i=>i.id===Number(m[1])));
      if(p.endsWith('/unpublish'))throw Error('no');return null;}};
    await window.__views.autoposting.render(document.getElementById('root'),ctx);
    await new Promise(r=>setTimeout(r,100));
  },POSTS);
  const draft=page.locator('#autoposting-feed [data-feed-post="79"]');await draft.waitFor();
  const m=await page.evaluate(()=>{
    const card=document.querySelector('#autoposting-feed [data-feed-post="79"]'),box=n=>n.getBoundingClientRect();
    const parts=['.ap-feed-open','.ap-feed-out','.ap-feed-foot','[data-feed-need]',...[...card.querySelectorAll('.ap-feed-cells .ap-cell')].map((_,i)=>`.ap-feed-cells .ap-cell:nth-child(${i+1})`)]
      .map(sel=>({sel,node:card.querySelector(sel)})).filter(x=>x.node&&box(x.node).width>0&&box(x.node).height>0);
    const overlaps=[];for(let i=0;i<parts.length;i++)for(let j=i+1;j<parts.length;j++){const a=box(parts[i].node),b=box(parts[j].node);
      if(a.left<b.right-1&&b.left<a.right-1&&a.top<b.bottom-1&&b.top<a.bottom-1)overlaps.push(parts[i].sel+' × '+parts[j].sel);}
    const order=[...document.querySelectorAll('#autoposting-feed [data-feed-post]')].map(n=>n.dataset.feedPost+':'+n.dataset.stage);
    return {width:innerWidth,scroll:document.documentElement.scrollWidth,overlaps,order,need:card.querySelector('[data-feed-need]').textContent,chip:card.querySelector('.cfk-chip').textContent,
      outside:[...card.querySelectorAll('*')].filter(n=>box(n).width&&box(n).right>innerWidth+1).map(n=>n.className||n.tagName)};});
  assert.equal(m.scroll,m.width,JSON.stringify(m));assert.deepEqual(m.overlaps,[],JSON.stringify(m));assert.deepEqual(m.outside,[]);
  assert.deepEqual(m.order,['71:published','79:draft','80:scheduled']);assert.equal(m.chip,'Черновик');
  assert.equal(m.need,'Не хватает: текст публикации · TikTok: кто увидит · дата и время выхода · согласование');
  const file=`posting-${width}.png`;await page.locator('.ap-posting, #autoposting-feed').first().screenshot({path:path.join(out,file)});
  await draft.locator('[data-feed-open]').click();await page.waitForTimeout(150);
  const opened=await page.evaluate(()=>({editor:document.getElementById('autoposting-editor').open,select:document.getElementById('autoposting-select').value}));
  assert.deepEqual(opened,{editor:true,select:'79'});
  const editorFile=`posting-${width}-editor.png`;await page.screenshot({path:path.join(out,editorFile)});
  /* №231: TikTok выбран, режим не задан — «Кто увидит» сразу под площадками; ссылка предупреждения фокусирует поле. */
  const privacy=await page.evaluate(()=>{const zone=document.getElementById('autoposting-tiktok-privacy-zone'),select=document.querySelector('[data-option="tiktok.privacy"]');
    document.querySelector('#autoposting-approval [data-focus-privacy]').click();
    const r=zone.getBoundingClientRect();return {hidden:zone.hidden,inZone:zone.contains(select),folded:Boolean(select.closest('details.autoposting-options')),focused:document.activeElement===select,
      right:r.right,width:innerWidth,scroll:document.documentElement.scrollWidth};});
  assert.deepEqual({hidden:privacy.hidden,inZone:privacy.inZone,folded:privacy.folded,focused:privacy.focused},{hidden:false,inZone:true,folded:false,focused:true},JSON.stringify(privacy));
  assert.ok(privacy.right<=privacy.width+1);assert.equal(privacy.scroll,privacy.width);
  await page.waitForTimeout(400);const privacyFile=`posting-${width}-privacy.png`;
  await page.locator('#autoposting-tiktok-privacy-zone').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,privacyFile)});
  /* №232: серая «Поставить в план» — подпись «Сначала нажмите „Предпросмотр“» и кнопка рядом, без наложений. */
  await page.locator('#autoposting-schedule').scrollIntoViewIfNeeded();await page.waitForTimeout(200);
  const sched=await page.evaluate(()=>{const ids=['autoposting-schedule','autoposting-schedule-hint','autoposting-schedule-preview'],b=id=>document.getElementById(id).getBoundingClientRect();
    const overlaps=[];for(let i=0;i<3;i++)for(let j=i+1;j<3;j++){const x=b(ids[i]),y=b(ids[j]);if(x.left<y.right-1&&y.left<x.right-1&&x.top<y.bottom-1&&y.top<x.bottom-1)overlaps.push(ids[i]+' × '+ids[j]);}
    return {disabled:document.getElementById('autoposting-schedule').disabled,hint:document.getElementById('autoposting-schedule-hint').textContent,
      again:!document.getElementById('autoposting-schedule-preview').hidden,overlaps,outside:ids.filter(id=>b(id).right>innerWidth+1),scroll:document.documentElement.scrollWidth,width:innerWidth};});
  assert.equal(sched.disabled,true);assert.equal(sched.hint,'Сначала нажмите «Предпросмотр»');assert.equal(sched.again,true);
  assert.deepEqual(sched.overlaps,[]);assert.deepEqual(sched.outside,[]);assert.equal(sched.scroll,sched.width);
  const scheduleFile=`posting-${width}-schedule.png`;await page.screenshot({path:path.join(out,scheduleFile)});
  await page.locator('#autoposting-schedule-preview').click();await page.waitForTimeout(200);
  const after=await page.evaluate(()=>({hint:document.getElementById('autoposting-schedule-hint').hidden?'':document.getElementById('autoposting-schedule-hint').textContent,
    link:Boolean(document.querySelector('#autoposting-preview-content [data-focus-privacy]'))}));
  assert.equal(after.link,true,'в замечаниях предпросмотра — ссылка на «Кто увидит»');
  assert.equal(errors.filter(e=>!/Failed to load resource/.test(e)).length,0,errors.join('\n'));
  results.push({width,file,editorFile,privacyFile,scheduleFile,...m,opened,privacy,schedule:sched,afterPreview:after,errors:errors.length});await page.close();
}
fs.writeFileSync(path.join(out,'visual-results.json'),JSON.stringify(results,null,2)+'\n');
console.log('PASS',results.length,'ширины: черновик в ленте, шаги видны, наложений 0, scrollWidth = ширине, клик открывает редактор; «Кто увидит» на виду; подпись и «Предпросмотр» у «Поставить в план»');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});

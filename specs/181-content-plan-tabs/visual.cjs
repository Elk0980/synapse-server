const {chromium}=require('playwright'),fs=require('fs'),path=require('path'),assert=require('assert/strict'),{execFileSync}=require('child_process');
const root=path.resolve(__dirname,'../..'),dir=path.join(root,'sites/synapse'),out=__dirname;
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{const results=[];
for(const width of [390,1440])for(const stage of ['before','after']){
const page=await browser.newPage({viewport:{width,height:width===390?844:900}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body></body></html>'}));await page.goto('http://sample.test');
const html=fs.readFileSync(path.join(dir,'cabinet.html'),'utf8'),inline=[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n');
await page.setContent(`<style>${inline}</style><header style="padding:12px;font:16px system-ui">Контент-план · SAMPLE Авокадо</header><main style="max-width:1200px;margin:auto;padding:12px" id="root"></main>`);
for(const file of ['workspace.css','content-plan.css']){const content=stage==='before'&&file==='content-plan.css'?execFileSync('git',['show','dcb9454f:sites/synapse/cabinet/'+file],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(dir,'cabinet',file),'utf8');await page.addStyleTag({content});}
const source=stage==='before'?execFileSync('git',['show','dcb9454f:sites/synapse/cabinet/content-plan.js'],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(dir,'cabinet/content-plan.js'),'utf8');
await page.addScriptTag({content:source});
await page.evaluate(async()=>{
const days=[1,2,3].map((n)=>({ideaId:'sample-'+n,date:'2026-11-'+(10+n),platform:n===2?'telegram':'vk',format:'reel',topic:'SAMPLE · '+['Ответы на вопросы','День в студии','Советы мастера'][n-1],productionStatus:n===3?'draft':'planned',variants:{[n===2?'telegram':'vk']:{text:'SAMPLE подпись'}}}));
const mentor={brief:{revision:1,fields:{}},plan:{revision:1,days},variants:days.map(d=>({ideaId:d.ideaId,status:'pending'})),vocabulary:{platforms:[{id:'vk',label:'ВКонтакте'},{id:'telegram',label:'Telegram'}]}};
const ctx={companyCode:'avokado',user:{id:7,role:'owner'},signal:new AbortController().signal,can:()=>true,route:{params:new URLSearchParams()},navigate:()=>{},openHughChat:()=>{},api:{get:async p=>p.endsWith('/questionnaire')?{revision:1,filled:1,total:8,fields:{platforms:['vk'],goals:'SAMPLE цель'}}:p.endsWith('/signoffs')?{stage:'approval',approvers:[],ideas:3,approvedIdeas:0,emptyIdeas:[]}:mentor},settings:{content:{get:async()=>({settings:{approverUserIds:[],contentPlanSheetUrl:'https://docs.google.com/spreadsheets/d/sample/edit'},candidates:[]})}}};
await window.SbCabinet.contentPlan.definition.mount(document.querySelector('#root'),ctx);
});
await page.waitForSelector('.cp-row');
const screens=stage==='after'?['plan','sort','drafts','new']:['plan'];
for(const screen of screens){if(screen==='sort')await page.locator('[data-cp-sort-toggle]').click();if(screen==='drafts')await page.locator('[data-cp-tab="drafts"]').click();if(screen==='new')await page.locator('[data-cp="questionnaire"]').click();
const metrics=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,buttonLines:[...document.querySelectorAll('.cp-tabs button,.cp-sort button')].filter(n=>n.getBoundingClientRect().height).map(n=>{const r=document.createRange();r.selectNodeContents(n);return {text:n.textContent,lines:new Set([...r.getClientRects()].map(r=>Math.round(r.top))).size};})}));
assert.equal(metrics.width,metrics.scroll);assert.ok(metrics.buttonLines.every(n=>n.lines<=2),JSON.stringify(metrics));assert.equal(errors.length,0);
if(stage==='after')assert.ok(!(await page.locator('#root').innerText()).includes('Полный план (таблица)'));
const file=`${width}-${stage}-${screen}.png`;await page.screenshot({path:path.join(out,file),fullPage:true});results.push({width,stage,screen,file,metrics,errors});}
await page.close();}
fs.writeFileSync(path.join(out,'visual-results.json'),JSON.stringify(results,null,2));console.log('PASS 10 screens, overflow 0, buttons <=2 lines, console errors 0');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});

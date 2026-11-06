const {chromium}=require('playwright');
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'../..'),dir=path.join(root,'sites/synapse'),out=__dirname;
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const html=fs.readFileSync(path.join(dir,'cabinet.html'),'utf8');
 const inline=[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n');
 const results=[];
 for(const width of [390,1440])for(const theme of ['dark','light']){
 const page=await browser.newPage({viewport:{width,height:width===390?844:900}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body></body></html>'}));await page.goto('http://sample.test');
 await page.setContent(`<style>${inline}</style><body class="owner-task-board"><main id="tasks-view" style="max-width:1200px;margin:auto;padding:12px"><div id="board"></div></main></body>`);
 for(const css of ['workspace.css','task-board.css','task-board-shell.css'])await page.addStyleTag({path:path.join(dir,'cabinet',css)});
 if(theme==='light')await page.addStyleTag({content:':root{--bg:#f4f6fa;--surface:#fff;--surface-soft:#eee;--text:#18212b;--muted:#536174;--line:#ccd5df;--accent:#265a91}'});
 for(const js of ['task-text.js','task-overview.js','task-board.js'])await page.addScriptTag({path:path.join(dir,'cabinet',js)});
 await page.evaluate(async()=>{
 const tasks=[{id:1,title:'SAMPLE · Подтвердить план',status:'in_progress',priority:'high',company_code:'synapse-business',assignee_name:'Codex',description:'SAMPLE инструкция: откройте план и выберите вариант.',waiting_since:'2026-11-06T00:00:00Z',comments:[],coordination:{revision:1,blocker:'ждёт Влада: выбрать вариант',nextAction:'Открыть план и проверить даты.',owner_question:'Согласовать план?',owner_minutes:2,if_yes:'Продолжим работу.',if_no:'Исправим план.',links:[{label:'Открыть план',url:'https://example.test/plan'}],milestones:{}}}];
 window.qa=window.SbTaskBoard.mount(document.querySelector('#board'),{identity:{role:'owner',userId:1,companies:[]},csrfOptions:(method,body)=>({method,body}),crmQuery:async(route,q,o)=>{const n=route.split('/').pop();return n==='tasks_list'?{tasks,pagination:{total:1}}:n==='task_get'?tasks[0]:n==='products_list'?{products:[]}:n==='agents_list'?{agents:[]}:{};}},{view:'projects'});
 });
 await page.waitForSelector('[data-wait-row]');
 for(const screen of ['board','card']){
 if(screen==='card'){await page.locator('[data-task-open="1"]').first().click();await page.waitForSelector('.tb-sheet');}
 const metrics=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,buttons:[...document.querySelectorAll('button,a')].filter(n=>n.getBoundingClientRect().width&&n.getBoundingClientRect().height).map(n=>({text:n.textContent.trim(),lines:n.innerText.split('\n').length,hyphens:getComputedStyle(n).hyphens})),}));
 assert.equal(metrics.width,metrics.scroll);assert.equal(errors.length,0);
 const file=`${width}-${theme}-${screen}.png`;await page.screenshot({path:path.join(out,file),fullPage:true});results.push({width,theme,screen,file,errors,metrics});
 }
 await page.close();}
 fs.writeFileSync(path.join(out,'visual-results.json'),JSON.stringify(results,null,2));console.log('PASS 8 screens, overflow 0, console errors 0');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});

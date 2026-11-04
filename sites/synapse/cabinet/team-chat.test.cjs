'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const flush=async()=>{for(let n=0;n<10;n++)await new Promise(setImmediate);};
test('черновик по проекту, unknown повтор с тем же ID, XSS текстом и отзыв открытой сессии',async t=>{
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'team-chat.html'),'utf8'),{url:'https://synapse.synapsebusiness.ru/cabinet/team-chat.html?companyCode=alpha',runScripts:'outside-only'}),w=dom.window;
  t.after(()=>w.close());let denied=false,failOnce=true;const bodies=[];
  w.HTMLElement.prototype.scrollIntoView=()=>{};w.AbortSignal=AbortSignal;
  w.fetch=async(url,options)=>{
    let data={messages:[{id:1,user_id:3,author_name:'<img src=x onerror=alert(1)>',text:'<script>alert(1)</script>',created_at:new Date().toISOString()}],hasMore:false},status=denied?403:200;
    if(url.endsWith('context'))data={user:{id:2},csrfToken:'test',companies:[{id:'alpha',name:'Альфа'},{id:'beta',name:'Бета'}]};
    if(options.method==='POST'){bodies.push(JSON.parse(options.body));if(failOnce){failOnce=false;throw Error('lost');}data={message:{id:2,user_id:2,author_name:'Тест',text:bodies.at(-1).text,created_at:new Date().toISOString(),task_id:22}};}
    return {ok:status===200,status,json:async()=>data};
  };
  w.eval(fs.readFileSync(path.join(__dirname,'team-chat.js'),'utf8'));await flush();
  const $=id=>w.document.getElementById(id),rooms=$('rooms').children;
  assert.equal($('messages').querySelector('script,img'),null);
  $('text').value='Черновик А';$('text').dispatchEvent(new w.Event('input'));rooms[1].click();await flush();
  $('text').value='Черновик Б';$('text').dispatchEvent(new w.Event('input'));rooms[0].click();await flush();assert.equal($('text').value,'Черновик А');
  $('compose').dispatchEvent(new w.Event('submit',{cancelable:true}));await flush();assert.equal($('text').readOnly,true);assert.match($('notice').textContent,/не подтверждён/);
  $('compose').dispatchEvent(new w.Event('submit',{cancelable:true}));await flush();assert.equal(bodies.length,2);assert.deepEqual(bodies[0],bodies[1]);assert.equal($('text').value,'');assert.match($('messages').textContent,/№22/);
  denied=true;rooms[0].click();await flush();assert.equal($('compose').hidden,true);assert.equal($('messages').children.length,0);
});
test('ссылка из старой задачи открывает сообщение за пределами последних100',async t=>{
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'team-chat.html'),'utf8'),{url:'https://synapse.synapsebusiness.ru/cabinet/team-chat.html?companyCode=alpha#message-1',runScripts:'outside-only'}),w=dom.window;
  t.after(()=>w.close());let scrolled='';w.AbortSignal=AbortSignal;w.HTMLElement.prototype.scrollIntoView=function(){scrolled=this.id;};
  w.fetch=async url=>({ok:true,json:async()=>url.endsWith('context')?{user:{id:2},companies:[{id:'alpha',name:'Альфа'}]}:{messages:[{id:url.includes('before=2')?1:200,user_id:2,author_name:'Тест',text:'Сообщение',created_at:new Date().toISOString()}]}});
  w.eval(fs.readFileSync(path.join(__dirname,'team-chat.js'),'utf8'));await flush();
  assert.ok(w.document.getElementById('message-1'));assert.ok(w.document.getElementById('message-200'));assert.equal(scrolled,'message-1');
});

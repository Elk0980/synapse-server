 'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync(require('node:path').join(__dirname,'../../sites/synapse/cabinet/view-as.js'),'utf8');
test('owner menu, effective employee banner, scoped fetch and recoverable expired token',async()=>{
 const dom=new JSDOM('<button id="view-as-start"></button>',{url:'https://example.test/cabinet.html',runScripts:'outside-only'});
 const w=dom.window;w.Headers=Headers;w.Request=Request;let calls=[];w.fetch=async(...args)=>{calls.push(args);return {ok:true};};w.eval(source);
 w.SynapseViewAs.render({role:'owner'});assert.equal(w.document.querySelector('button').hidden,false);
 w.sessionStorage.setItem('synapse-view-as','synthetic');w.SynapseViewAs.render({role:'editor',viewAs:{name:'Лена'}});
 assert.equal(w.document.querySelector('#view-as-start').hidden,true);assert.match(w.document.querySelector('#view-as-banner').textContent,/Лена — только просмотр/);
 await w.fetch('/content/whoami');assert.equal(calls[0][1].headers.get('X-View-As'),'synthetic');
 await w.fetch('https://other.test/content/whoami');assert.equal(calls[1][1].headers,undefined);
 dom.window.close();
});

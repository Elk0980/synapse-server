const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{JSDOM}=require('jsdom');
const tick=()=>new Promise(r=>setImmediate(r));
const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
test('company settings switch recipients and discard stale responses; saves only the visible company',async()=>{
 const dom=new JSDOM('<section id="settings"></section>',{runScripts:'outside-only'}),w=dom.window,d=w.document,views={},calls=[],pending=[];
 w.SbCabinet={registerView:(n,v)=>views[n]=v};w.eval(fs.readFileSync(__dirname+'/settings.js','utf8'));
 let company='alvi';const ctx={identity:{role:'owner',csrfToken:'qa',companies:[{id:'alvi',name:'АЛВИ'},{id:'avokado',name:'Авокадо'},{id:'synapse-business',name:'Synapse'}]},get selectedProjectId(){return company},escapeHTML:h,apiJson:(url,options)=>{calls.push({url,options});return new Promise(resolve=>pending.push(resolve));}};
 const data=(code,recipient)=>({companyCode:code,recipient,senderConfigured:true,status:{companies:[{code,recipientConfigured:true,sent:3}],smtp:{configured:true,host:true,port:true,user:true,password:true,from:true}}});
 const old=views.settings.render(d.querySelector('section'),ctx);company='avokado';const current=views.settings.render(d.querySelector('section'),ctx);
 pending[1](data('avokado','avocado@example.test'));await current;pending[0](data('alvi','alvi@example.test'));await old;
 assert.equal(d.querySelector('[name=recipient]').value,'avocado@example.test');assert.doesNotMatch(d.body.textContent,/АЛВИ/);
 d.querySelector('[name=recipient]').value='changed@example.test';d.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));
 assert.match(calls[2].url,/companyCode=avokado/);assert.deepEqual(JSON.parse(calls[2].options.body),{recipient:'changed@example.test'});
 company='synapse-business';const next=views.settings.render(d.querySelector('section'),ctx);pending[3](data(company,''));await next;pending[2](data('avokado','changed@example.test'));await tick();
 assert.equal(d.querySelector('[name=recipient]').value,'');assert.doesNotMatch(d.body.textContent,/Авокадо|АЛВИ/);assert.equal(d.querySelector('input[type=password]'),null);w.close();
});

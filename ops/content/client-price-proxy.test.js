'use strict';
// CADDY_BINARY=/path/to/caddy node --test ops/content/client-price-proxy.test.js
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path'), http=require('node:http'), net=require('node:net');
const {spawn}=require('node:child_process');const {once}=require('node:events');
async function port(){const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const p=server.address().port;await new Promise(r=>server.close(r));return p;}
function block(source,marker){const start=source.indexOf(marker);assert.ok(start>=0);let depth=0;
 for(let i=source.indexOf('{',start);i<source.length;i++){if(source[i]==='{')depth++;if(source[i]==='}'&&--depth===0)return source.slice(start,i+1);}throw Error('unterminated Caddy block');}
test('actual Caddy separates cabinet APIs from each public site, including Palitra alias', {skip:!process.env.CADDY_BINARY},async()=>{
 const root=path.resolve(__dirname,'../..'),temp=fs.mkdtempSync('/tmp/client-price-proxy-');
 const upstream=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({route:req.url}));});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');const upstreamPort=upstream.address().port;
 let child;
 try{
  const source=fs.readFileSync(root+'/caddy/Caddyfile','utf8');
  let config='{\nadmin off\nauto_https off\n}\n'+block(source,'(static) {')+'\n'+block(source,'(draft) {')+'\n';
  const sites=['palitra-love','alvi','avokado','avokado2','synapse'],ports={};
  for(const site of sites){ports[site]=await port();config+=block(source,site+'.synapsebusiness.ru {')
   .replace(site+'.synapsebusiness.ru {','http://127.0.0.1:'+ports[site]+' {')
   .replace('/srv/sites/'+site,root+'/sites/'+site).replaceAll('content:8080','127.0.0.1:'+upstreamPort)
   .replaceAll('crm:8080','127.0.0.1:'+upstreamPort)+'\n';}
  fs.writeFileSync(temp+'/Caddyfile',config);
  child=spawn(process.env.CADDY_BINARY,['run','--config',temp+'/Caddyfile','--adapter','caddyfile'],{stdio:'ignore'});
  const req=(site,uri,opts)=>fetch('http://127.0.0.1:'+ports[site]+uri,opts);
  let ready=false;for(let i=0;i<100;i++){try{if((await req('synapse','/cabinet.html')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,30));}
  assert.ok(ready,'Caddy starts with changed site configurations');
  for(const site of sites.filter(s=>s!=='synapse')){
   const contentSite=site==='palitra-love'?'palitra':site==='avokado2'?'avokado':site;
   const response=await req(site,'/api/price');assert.equal(response.status,200);
   assert.equal((await response.json()).route,'/public-content/'+contentSite+'/price');
  }
  assert.equal((await (await req('palitra-love','/content/palitra/price')).json()).route,'/public-content/palitra/price');
  for(const site of ['alvi','avokado','avokado2'])assert.equal((await (await req(site,'/api/site')).json()).route,'/public-content/'+site+'/site');
  assert.equal((await (await req('alvi','/api/leads',{method:'POST',body:'{}'})).json()).route,'/leads');
  assert.equal((await (await req('synapse','/content/alvi/price')).json()).route,'/content/alvi/price');
  for(const route of ['/public-content/alvi/price','/public-content/palitra/price/history'])assert.equal((await req('synapse',route)).status,404);
  const foreign=await req('palitra-love','/content/alvi/price');assert.ok(!(foreign.headers.get('content-type')||'').includes('application/json'));
  const write=await req('palitra-love','/content/palitra/price',{method:'PUT',body:'{}'});assert.ok(!(write.headers.get('content-type')||'').includes('application/json'));
 }finally{if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}await new Promise(r=>upstream.close(r));fs.rmSync(temp,{recursive:true,force:true});}
});

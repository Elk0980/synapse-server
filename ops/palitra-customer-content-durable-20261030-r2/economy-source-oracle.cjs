// Test only: executes extracted pure functions on synthetic records; never requires app modules.
'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),vm=require('node:vm');
const base='C:/Users/Vlad/Documents/Codex/AI_HANDOFF/SYNAPSE_BUSINESS/AVOKADO_SITE_PRICES_V8_20261003/RELEASE/ops/content/';
const pins={'hugh-budget.js':'4ee523b5d6395cd23d837efa0525ceacfbe8ea186e7e5341cb4d310ca88c675b','hugh-providers.js':'6464ac246aa197ef8f9f197a332eed5d2b27f0acda445b08f89192c660514141','hugh-fallback.js':'4b1c4071c868e687057d81fe601358d45b791d5519c4aae7a34b33b0df28ff33','hugh-economy.js':'65973debe10ca8cdae5ea463bc8e46da45dfd4d0a509b7064a72ee2435439d91'};
const src={};for(const [n,h]of Object.entries(pins)){const raw=fs.readFileSync(base+n);if(crypto.createHash('sha256').update(raw).digest('hex')!==h)throw Error('SOURCE_PIN');src[n]=raw.toString();}
function fn(source,name){const at=source.indexOf('function '+name+'(');if(at<0)throw Error('MISSING_FUNCTION '+name);let start=source.indexOf('{',at),depth=0;for(let i=start;i<source.length;i++){if(source[i]==='{')depth++;if(source[i]==='}'&&!--depth)return source.slice(at,i+1);}throw Error('FUNCTION_BOUND');}
// The reviewed functions contain balanced template substitutions. Parse output by VM,
// then evaluate only the extracted definitions, never their surrounding factory.
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{
 const cases=JSON.parse(input),results=[];
 for(const item of cases){
  const ctx={item};vm.createContext(ctx);
  const code=`'use strict';
const MICRO=1000000,WINDOW_DEFAULT_DAYS=30,DEFAULT_MAX_OUTPUT_TOKENS=1200,GUARANTEE='fixture',STALE_MS=1800000;
const present=value=>value!==undefined&&value!==null&&String(value).trim()!=='';
${fn(src['hugh-budget.js'],'money')}
${fn(src['hugh-budget.js'],'whole')}
${fn(src['hugh-budget.js'],'readBudget')}
const now=()=>item.at,config=readBudget(item.env),configBlocked=config.invalid.length>0,windowMs=config.windowDays*86400000;
const windowStartMs=at=>Math.floor(at/windowMs)*windowMs,windowStart=at=>new Date(windowStartMs(at)).toISOString(),rate=()=>({});
const db={prepare(sql){return{get(...args){
 if(sql.includes('sqlite_master'))return {ok:1};
 if(sql.includes('FROM project_chat_provider_state'))return item.states[args[0]];
 const provider=sql.includes('AND provider=?')?args[1]:null,start=args[0];
 if(sql.includes('FROM hugh_fallback_spend')){const rows=item.spend.filter(r=>r.window_start===start&&(provider===null||r.provider===provider));return{requests:rows.reduce((n,r)=>n+r.requests,0),unknownRequests:0,microUsd:rows.reduce((n,r)=>n+r.micro_usd,0)};}
 if(sql.includes('FROM hugh_fallback_reservations')){const rows=item.reservations.filter(r=>r.window_start===start&&(provider===null||r.provider===provider));return{n:rows.length,microUsd:rows.reduce((n,r)=>n+r.micro_usd,0),kept:rows.filter(r=>r.state==='kept').length};}
 throw Error('UNEXPECTED_PURE_SQL');
 }}}};
${fn(src['hugh-budget.js'],'totals')}
${fn(src['hugh-budget.js'],'providerTotals')}
${fn(src['hugh-budget.js'],'providerState')}
${fn(src['hugh-budget.js'],'state')}
const budget={providerState,state,status:state};
const current=()=>item.cache;
${fn(src['hugh-economy.js'],'view').replace('function view(','function economyView(')}
const forecast=()=>null;
const CATALOG=['zai','qwen','deepseek','gemini','mistral','openai','anthropic'].map(name=>({name,title:name,console:'',hosts:[],contractSupported:name!=='anthropic'})),BY_NAME=new Map(CATALOG.map(v=>[v.name,v])),API_STYLE='fixture';
const providerView=(()=>{const row=name=>item.saved[name],economy={view:economyView};
const checkCurrent=s=>Boolean(s&&s.check_state==='ok'&&s.checked_revision!==null&&s.checked_revision===s.config_revision);
${fn(src['hugh-providers.js'],'view').replace('function view(','function providerView(')}
return providerView;})();
const issues=[],currentProviders=()=>item.runtime,row=name=>item.states[name];
const cooling=(name,at=now())=>{const r=row(name);return Boolean(r?.cooldown_until&&Date.parse(r.cooldown_until)>at);};
${fn(src['hugh-fallback.js'],'status').replace('function status(','function runtimeStatus(')}
const out={},warn=(key,active)=>{out[key]=!!active;};
${fn(src['hugh-economy.js'],'warnings')}
warnings({providers:CATALOG.map(p=>providerView(p.name)),budget:state()},runtimeStatus());this.result=out;`;
  vm.runInContext(code,ctx,{timeout:1000});results.push(ctx.result);
 }
 process.stdout.write(JSON.stringify(results));
});

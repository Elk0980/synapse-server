'use strict';
const {fail,range,id,credential} = require('./revenue-analytics-access');
const METRICS = ['ym:s:visits','ym:s:users','ym:s:avgVisitDurationSeconds','ym:s:bounceRate','ym:s:pageDepth'];
const HOSTS = new Set(['api-metrika.yandex.net','api.yclients.ru']);
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
// Метки не должны становиться хранилищем контактов или полных URL.
const safeDimension = v => typeof v === 'string' && v.length <= 200 && !/[@:\/?\x00-\x1f]|\d{7,}/.test(v) ? v : '';
function createRevenueAdapters({fetchImpl = fetch, wait = sleep, now = Date.now} = {}) {
  let queue = Promise.resolve(), lastAt = 0, closed = false;
  const abort = new AbortController();
  async function refreshMetrika(c) {
    credential('metrika',c);
    if(!c.refreshToken)fail('TOKEN_REAUTH_REQUIRED',502);
    if(closed)fail('SERVER_STOPPING',503);
    let response;
    // Refresh может менять ключи: один POST, без слепого повтора при неизвестном результате.
    try {
      response=await fetchImpl(new URL('https://oauth.yandex.ru/token'),{method:'POST',redirect:'error',
        headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({grant_type:'refresh_token',refresh_token:c.refreshToken,client_id:c.clientId,client_secret:c.clientSecret}),
        signal:AbortSignal.any([abort.signal,AbortSignal.timeout(25000)])});
    }catch{fail('TOKEN_REFRESH_UNCERTAIN',502);}
    if(response.status===429){await response.body?.cancel();fail('RATE_LIMITED',502);}
    const reader=response.body?.getReader();if(!reader)fail('TOKEN_REFRESH_UNCERTAIN',502);
    const chunks=[];let size=0,b;
    try {
      for(;;){const{value,done}=await reader.read();if(done)break;size+=value.length;if(size>16384){await reader.cancel();fail('TOKEN_REFRESH_UNCERTAIN',502);}chunks.push(value);}
      b=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }catch{fail('TOKEN_REFRESH_UNCERTAIN',502);}
    if([400,401,403].includes(response.status) && ['invalid_grant','invalid_client','unauthorized_client'].includes(b.error))fail('TOKEN_REAUTH_REQUIRED',502);
    if(!response.ok || b.token_type!=='bearer' || !Number.isSafeInteger(b.expires_in) || b.expires_in<3600 || b.expires_in>730*86400 || (b.scope!==undefined && b.scope!=='metrika:read'))fail('TOKEN_REFRESH_UNCERTAIN',502);
    const refreshedAt=new Date(now()).toISOString(),expiresAt=new Date(now()+b.expires_in*1000).toISOString();
    try {credential('metrika',{...c,token:b.access_token,refreshToken:b.refresh_token,refreshedAt,expiresAt});}catch{fail('TOKEN_REFRESH_UNCERTAIN',502);}
    return {token:b.access_token,refreshToken:b.refresh_token,expiresAt,refreshedAt};
  }
  async function json(url, headers) {
    if (!(url instanceof URL) || url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port || url.username || url.password) fail('BAD_ENDPOINT',500);
    // Один ограничитель всех API-вызовов этого процесса: ниже лимита YCLIENTS 5/сек и 200/мин.
    const previous = queue; let release; queue = new Promise(r => {release=r;}); await previous;
    try {
      for (let attempt=0;attempt<3;attempt++) {
        if (closed) fail('SERVER_STOPPING',503);
        await wait(Math.max(0,350-(now()-lastAt))); lastAt=now();
        let response;
        try { response=await fetchImpl(url, {method:'GET',headers,redirect:'error',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(25000)])}); }
        catch { fail('CONNECTION_UNCERTAIN',504); }
        if ([429,500,502,503,504].includes(response.status) && attempt < 2) { await response.body?.cancel(); await wait(1000 * 2**attempt); continue; }
        if (response.status === 401 || response.status === 403) { await response.body?.cancel(); fail('ACCESS_DENIED',502); }
        if (!response.ok) { await response.body?.cancel(); fail(response.status === 429?'RATE_LIMITED':response.status===404?'NOT_FOUND':'UPSTREAM_ERROR',502); }
        const reader = response.body?.getReader(); if (!reader) fail('RESPONSE_UNCERTAIN',502);
        let size=0; const chunks=[];
        try { for (;;) { const {value,done}=await reader.read(); if(done)break; size+=value.length; if(size>8*1024*1024){await reader.cancel();fail('RESPONSE_TOO_LARGE',502);} chunks.push(value); } }
        catch(e) { if(e.code)throw e; fail('CONNECTION_UNCERTAIN',504); }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('RESPONSE_UNCERTAIN',502); }
      }
    } finally { release(); }
  }
  const ycHeaders = c => ({Authorization:'Bearer '+c.partnerToken+', User '+c.userToken,Accept:'application/vnd.yclients.v2+json','Content-Type':'application/json'});
  async function verifyYclients(binding) {
    const url = new URL('/api/v1/companies','https://api.yclients.ru');
    url.searchParams.set('my','1'); url.searchParams.set('id',binding.config.externalId);
    const b = await json(url,ycHeaders(binding.credential));
    if (b.success !== true || !Array.isArray(b.data)) fail('RESPONSE_UNCERTAIN',502);
    if (!b.data.some(c => String(c.id) === binding.config.externalId)) fail('PROFILE_CHANGED',502);
  }
  async function ycPages(path, params, credential, normalize = v => v) {
    const rows = []; const seen = new Set(); const started=now(); let expectedTotal;
    for(let page=1;page<=200;page++) {
      if (now()-started>15*60*1000) fail('INCOMPLETE',502);
      const url = new URL(path,'https://api.yclients.ru');
      for (const [key,value] of Object.entries({...params,page,count:200})) url.searchParams.set(key,String(value));
      const b=await json(url,ycHeaders(credential));
      if(b.success!==true || !Array.isArray(b.data)) fail('RESPONSE_UNCERTAIN',502);
      for(const r of b.data) { const key=id(r.id); if(seen.has(key))fail('INCOMPLETE',502); seen.add(key); rows.push(normalize(r)); }
      const total=b.meta?.total_count;
      if(total!==undefined && (!Number.isSafeInteger(Number(total)) || Number(total)<rows.length)) fail('INCOMPLETE',502);
      if(expectedTotal!==undefined && total===undefined)fail('INCOMPLETE',502);
      if(total!==undefined) { if(expectedTotal!==undefined && expectedTotal!==Number(total))fail('INCOMPLETE',502);expectedTotal=Number(total); }
      if((total!==undefined && rows.length===Number(total)) || (total===undefined && b.data.length<200))return rows;
      if(!b.data.length)fail('INCOMPLETE',502);
    }
    fail('INCOMPLETE',502);
  }
  async function metrikaReport(c, r, extra={}) {
    range(r.from,r.to);
    const url=new URL('https://api-metrika.yandex.net/stat/v1/data');
    // Явный часовой пояс проекта для сопоставления с YCLIENTS, без зависимости от настроек браузера.
    const offset={'Asia/Irkutsk':'+08:00','Asia/Bangkok':'+07:00','Europe/Moscow':'+03:00',UTC:'+00:00'}[c.config.timezone];
    const q={ids:c.config.externalId,date1:r.from,date2:r.to,accuracy:'full',lang:'ru',timezone:offset,limit:10000,offset:1,include_undefined:true,metrics:METRICS.join(','),...extra};
    for(const[k,v]of Object.entries(q))url.searchParams.set(k,String(v));
    const b=await json(url,{Authorization:'OAuth '+c.credential.token});
    const metrics=String(q.metrics).split(',');
    if(!Array.isArray(b.totals) || b.totals.length!==metrics.length || !b.totals.every(Number.isFinite) || !Array.isArray(b.data))fail('RESPONSE_UNCERTAIN',502);
    if(b.query?.date1!==r.from || b.query?.date2!==r.to || b.query?.metrics?.join(',')!==q.metrics || (b.query.timezone && b.query.timezone!==offset))fail('PROFILE_CHANGED',502);
    if(b.total_rows_rounded || (Number(b.total_rows)||0)>b.data.length)fail('INCOMPLETE',502);
    return {metrics,totals:b.totals,rows:b.data.map(row=>{
      if(!Array.isArray(row.metrics)||row.metrics.length!==metrics.length||!row.metrics.every(Number.isFinite))fail('RESPONSE_UNCERTAIN',502);
      return {dimensions:(row.dimensions||[]).map(d=>({id:safeDimension(String(d.id??'')),name:safeDimension(String(d.name??''))})),metrics:row.metrics};
    }),sampled:Boolean(b.sampled),sampleShare:b.sample_share??null,dataLagSeconds:b.data_lag??null};
  }
  async function metrika(c,r) {
    const overview=await metrikaReport(c,r);
    const utm=await metrikaReport(c,r,{dimensions:['UTMSource','UTMMedium','UTMCampaign','UTMContent','UTMTerm'].map(v=>'ym:s:lastsign'+v).join(',')});
    const sources=await metrikaReport(c,r,{dimensions:'ym:s:lastsignTrafficSource,ym:s:lastsignReferalSource'});
    const goals=[];
    let goalList=c.config.goals;
    if(!goalList.length) {
      const b=await json(new URL('/management/v1/counter/'+c.config.externalId+'/goals','https://api-metrika.yandex.net'),{Authorization:'OAuth '+c.credential.token});
      if(!Array.isArray(b.goals) || b.goals.length>100)fail('RESPONSE_UNCERTAIN',502);
      goalList=b.goals.map(g=>({id:id(g.id),label:String(g.name||'Цель').slice(0,120)}));
    }
    for(const g of goalList) {
      const data=await metrikaReport(c,r,{metrics:['visits','reaches','conversionRate'].map(m=>'ym:s:goal'+g.id+m).join(',')});
      goals.push({...g,visits:data.totals[0],reaches:data.totals[1],conversionRate:data.totals[2],sampled:data.sampled});
    }
    return {overview,utm,sources,goals,attribution:'lastsign',period:r,timezone:c.config.timezone};
  }
  return {metrika,refreshMetrika,ycPages,json,ycHeaders,verifyYclients,stop:()=>{closed=true;abort.abort();}};
}
module.exports={createRevenueAdapters,METRICS};

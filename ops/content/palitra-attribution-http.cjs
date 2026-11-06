'use strict';
const PUBLIC='/api/palitra-attribution/visit',STAFF='/content/palitra/attribution/summary';
const HEADERS=Object.freeze({'cache-control':'no-store','x-content-type-options':'nosniff','cross-origin-resource-policy':'same-origin'});
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
async function readBody(req){
  if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']||'')))fail(415,'ATTRIBUTION_CONTENT_TYPE','Ожидался JSON');
  const parts=[];let n=0;
  for await(const part of req){n+=part.length;if(n>4096)fail(413,'ATTRIBUTION_SIZE','Запрос слишком большой');parts.push(part);}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{fail(400,'ATTRIBUTION_JSON','Некорректный JSON');}
}
function createPalitraAttributionHttp({state,requireSession,publicOrigins,staffOrigin,clientIp}={}){
  if(!state||typeof state.visit!=='function'||typeof state.summary!=='function'||typeof requireSession!=='function'||typeof clientIp!=='function'||!Array.isArray(publicOrigins)||!publicOrigins.length||new URL(staffOrigin).origin!==staffOrigin)
    throw new TypeError('Existing Palitra authentication, origins and trusted clientIp required');
  const allowed=new Set(publicOrigins);
  function fresh(req,previous){const s=requireSession(req);state.authorize(s?.user);if(previous&&(previous.user.id!==s.user.id||previous.user.sessionVersion!==s.user.sessionVersion))fail(403,'ATTRIBUTION_ACCESS','Доступ изменился');return s;}
  async function handle({request:req,url,hostname,reply}){
    const isPublic=url.pathname===PUBLIC,isStaff=url.pathname===STAFF;
    if(!isPublic&&!isStaff){if(!url.pathname.startsWith('/api/palitra-attribution/')&&!url.pathname.startsWith('/content/palitra/attribution/'))return false;reply(404,{ok:false,code:'ATTRIBUTION_ROUTE',error:'Не найдено'},HEADERS);return true;}
    try{
      const session=isStaff?fresh(req):null,method=isPublic?'POST':'GET';
      if(req.method!==method){reply(405,{ok:false,code:'ATTRIBUTION_METHOD',error:'Метод не поддерживается'},{...HEADERS,allow:method});return true;}
      if(req.headers['sec-fetch-site']!==undefined&&!['same-origin','none'].includes(req.headers['sec-fetch-site']))fail(403,'ATTRIBUTION_ORIGIN','Запрос с этого адреса не принимается');
      if(isPublic){
        if(url.search)fail(400,'ATTRIBUTION_QUERY','Параметры адреса не поддерживаются');
        const origin=`https://${hostname}`;
        if(!allowed.has(origin)||req.headers.origin!==origin)fail(403,'ATTRIBUTION_ORIGIN','Запрос с этого адреса не принимается');
        const body=await readBody(req);
        reply(200,state.visit({origin,ip:clientIp(req),body}),HEADERS);return true;
      }
      if(req.headers.origin!==undefined&&req.headers.origin!==staffOrigin)fail(403,'ATTRIBUTION_ORIGIN','Запрос с этого адреса не принимается');
      if(req.headers['transfer-encoding']!==undefined||req.headers['content-length']!==undefined&&req.headers['content-length']!=='0')fail(400,'ATTRIBUTION_BODY','Тело запроса не поддерживается');
      if([...url.searchParams.keys()].some(k=>!['from','until'].includes(k))||['from','until'].some(k=>url.searchParams.getAll(k).length>1))fail(400,'ATTRIBUTION_QUERY','Некорректный период');
      const query={};for(const k of ['from','until'])if(url.searchParams.has(k))query[k]=url.searchParams.get(k);
      const result=state.summary(session.user,query);fresh(req,session);reply(200,result,HEADERS);return true;
    }catch(e){
      const status=[400,401,403,404,405,409,413,415,429,503].includes(e?.status)?e.status:500;
      reply(status,{ok:false,code:status===500?'ATTRIBUTION_INTERNAL':e.code||'ATTRIBUTION_ACCESS',error:status===500?'Учёт источников временно недоступен':String(e.message).slice(0,200)},HEADERS);return true;
    }
  }
  return Object.freeze({handle});
}
module.exports={createPalitraAttributionHttp,PUBLIC,STAFF};

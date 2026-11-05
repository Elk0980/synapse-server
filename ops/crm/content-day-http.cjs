'use strict';
// Integration seam: existing signed company context/permissions, existing CSRF
// proxy and existing createVariant transaction; no new auth or publishing path.
function create({service,context,readJson,reply}={}){
 if(!service||typeof context!=='function'||typeof readJson!=='function'||typeof reply!=='function')throw TypeError('Existing company guard and HTTP functions required');
 const fail=(status,code)=>{throw Object.assign(Error(code),{status,code,details:{code}})};
 return async function handle(req,res,url,cors={}){
  const day=url.pathname==='/autoposting/day',lookup=/^\/autoposting\/day-copies\/([-a-zA-Z0-9_]{8,100})$/.exec(url.pathname),copy=/^\/autoposting\/posts\/([1-9][0-9]{0,14})\/day-copy$/.exec(url.pathname);if(!day&&!lookup&&!copy)return false;
  if(req.method!==(copy?'POST':'GET'))fail(405,'CONTENT_METHOD');const allowed=day?['companyCode','date']:lookup?['companyCode','copySource']:['companyCode'];if([...url.searchParams.keys()].some(k=>!allowed.includes(k))||url.searchParams.getAll('companyCode').length!==1||url.searchParams.getAll('date').length>1||url.searchParams.getAll('copySource').length>1)fail(400,'CONTENT_QUERY');const code=url.searchParams.get('companyCode');
  const {identity,company}=await context(req,code,copy?'autoposting.edit':'autoposting.view');if(!identity||company?.code?.toLowerCase()!==code||!['palitra-love','alvi','avokado'].includes(code))fail(403,'CONTENT_COMPANY');const permissions=identity.permissions;const canEdit=identity.role==='owner'||Boolean(permissions?.has?.('autoposting.edit'))||Array.isArray(permissions)&&permissions.includes('autoposting.edit');const actor={...identity,canEdit};
  let result;if(day)result=await service.read(code,{...(url.searchParams.has('date')?{date:url.searchParams.get('date')}: {})},actor);else if(lookup)result=service.lookup(code,lookup[1],actor,url.searchParams.get('copySource')||'published-snapshot');else {const body=await readJson(req);const current=await context(req,code,'autoposting.edit');if(current.identity?.userId!==identity.userId||current.company?.code!==company.code)fail(403,'CONTENT_CONTEXT_CHANGED');actor.assertCurrent=async()=>{const fresh=await context(req,code,'autoposting.edit');if(fresh.identity?.userId!==identity.userId||fresh.company?.code!==company.code)fail(403,'CONTENT_CONTEXT_CHANGED');};result=await service.duplicate(code,Number(copy[1]),body,actor);}await reply(req,res,copy?201:200,result,cors);return true;
 };
}
module.exports={create};

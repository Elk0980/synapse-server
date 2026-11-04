'use strict';
const {createHmac,createHash,timingSafeEqual}=require('node:crypto');
const HEADER='x-synapse-task-principal';
function createTaskPrincipals(db,{secret,now=()=>Date.now(),releaseAgentId=0,claudeAgentId=0}={}) {
 if(![releaseAgentId,claudeAgentId].every(id=>Number.isSafeInteger(id)&&id>=0)||releaseAgentId>0&&releaseAgentId===claudeAgentId)throw Error('Некорректные registry ID ролей сторожа');
 const principals=new WeakMap();
 const scopes=a=>JSON.stringify([...new Set(['','synapse','synapse-business',...[...(a.companyCodes||[])].map(s=>s.trim().toLowerCase())])].sort());
 function bind(request,actor) {
  if(!actor)return actor;
  try {
   const encoded=request.headers[HEADER];if(typeof encoded!=='string'||encoded.length>2048||!secret)return actor;
   const [payload,signature,...extra]=encoded.split('.');if(extra.length||!payload||!signature)return actor;
   const expected=createHmac('sha256',secret).update(payload).digest();const actual=Buffer.from(signature,'base64url');
   if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return actor;
   const c=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
   if(c.identityHash!==createHash('sha256').update(String(request.headers['x-synapse-crm-identity']||'')).digest('hex'))return actor;
   if(c.v!==1||c.userId!==actor.userId||!Number.isSafeInteger(c.at)||Math.abs(now()-c.at)>60000||c.method!==request.method||c.path!==new URL(request.url,'http://crm').pathname)return actor;
   if(c.source==='cabinet') {
    principals.set(actor,Object.freeze({kind:actor.role==='owner'?'vlad':'person',id:actor.userId,name:actor.role==='owner'?'Влад':`person:${actor.userId}`,key:`person:${actor.userId}`}));
   } else if(c.source==='mcp'&&Number.isSafeInteger(c.agentId)&&c.agentId>0) {
    const r=db.prepare('SELECT a.*,x.owner_id,x.projects FROM agents a JOIN agent_access x ON x.agent_id=a.id WHERE a.id=?').get(c.agentId);
    if(r&&r.owner_id===actor.userId&&r.projects===scopes(actor))principals.set(actor,Object.freeze({kind:r.id===releaseAgentId?'release':r.id===claudeAgentId?'claude':'agent',id:r.id,name:r.name,key:`agent:${r.id}`}));
   }
  } catch {}return actor;
 }
 return {bind,get:actor=>{const p=principals.get(actor);if(!p)return null;if(['vlad','person'].includes(p.kind))return p;
  const r=db.prepare('SELECT a.id,x.owner_id,x.projects FROM agents a JOIN agent_access x ON x.agent_id=a.id WHERE a.id=?').get(p.id);
  return r&&r.owner_id===actor.userId&&r.projects===scopes(actor)?p:null;}};
}
module.exports={createTaskPrincipals,HEADER};

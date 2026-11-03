'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite'),{createHmac,createHash}=require('node:crypto');
const {createTaskPrincipals,HEADER}=require('./task-principal');
function fixture(t) {
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE agents(id INTEGER PRIMARY KEY,name TEXT,kind TEXT);CREATE TABLE agent_access(agent_id INTEGER PRIMARY KEY,owner_id INTEGER,projects TEXT);
 INSERT INTO agents VALUES(1,'Codex','codex'),(2,'Other','claude'),(3,'Claude','codex'),(4,'Release','codex');`);
 for(const id of [1,2,3,4])db.prepare('INSERT INTO agent_access VALUES(?,7,?)').run(id,JSON.stringify(['','alpha','synapse','synapse-business']));
 const time=Date.parse('2026-11-04T00:00:00Z'),secret='SAMPLE internal service key';
 const api=createTaskPrincipals(db,{secret,now:()=>time,claudeAgentId:3,releaseAgentId:4});
 const actor=()=>({userId:7,role:'owner',companyCodes:new Set(['alpha'])});
 function request(source='mcp',agentId=1,overrides={}) {
  const identity='SAMPLE encoded identity',claim={v:1,source,userId:7,agentId,at:time,method:'POST',path:'/coordination/mcp/task_update',identityHash:createHash('sha256').update(identity).digest('hex'),...overrides};
  const encoded=Buffer.from(JSON.stringify(claim)).toString('base64url');
  return {method:'POST',url:claim.path,headers:{'x-synapse-crm-identity':identity,[HEADER]:encoded+'.'+createHmac('sha256',secret).update(encoded).digest('base64url')}};
 }
 return {db,api,actor,request,time};
}
test('cabinet session identity is Vlad; MCP registry ID and grant determine agent, not labels',t=>{
 const {api,actor,request}=fixture(t);
 let a=actor();api.bind(request('cabinet'),a);assert.equal(api.get(a).kind,'vlad');
 a=actor();api.bind(request(),a);assert.equal(api.get(a).key,'agent:1');
 a=actor();api.bind(request('mcp',2),a);assert.equal(api.get(a).kind,'agent','Свободный registry kind claude не выдаёт роль');
 a=actor();api.bind(request('mcp',3),a);assert.equal(api.get(a).kind,'claude');
 a=actor();api.bind(request('mcp',4),a);assert.equal(api.get(a).kind,'release');
});
test('forged, stale, wrong route/identity/scope and missing registry/grant do not authenticate',t=>{
 const {db,api,actor,request,time}=fixture(t);
 for(const mutate of [r=>r.headers[HEADER]+='x',r=>r.method='GET',r=>r.url='/coordination/tasks/9',r=>r.headers['x-synapse-crm-identity']='Changed']) {
  const a=actor(),r=request();mutate(r);api.bind(r,a);assert.equal(api.get(a),null);
 }
 for(const r of [request('mcp',99),request('mcp',1,{at:time-61000}),request('mcp',1,{userId:8})]){const a=actor();api.bind(r,a);assert.equal(api.get(a),null);}
 const a=actor();api.bind(request(),a);assert.ok(api.get(a));
 db.prepare('UPDATE agent_access SET projects=? WHERE agent_id=1').run('[]');assert.equal(api.get(a),null,'Отзыв проверяется повторно перед записью');
});

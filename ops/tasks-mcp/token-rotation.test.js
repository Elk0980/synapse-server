'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), http=require('node:http');
const {randomBytes}=require('node:crypto');
const path=require('node:path'),os=require('node:os');
const {createTasksMcpServer,loadConfig}=require('./server');
const {TOOLS}=require('./tools');

test('ротация при пересоздании MCP: прежний адрес401, новыйinitialize/tools/list/read работают; scope и проверки сохраняются',async t=>{
  const old=randomBytes(32).toString('hex'), next=randomBytes(32).toString('hex');
  const env={TASKS_MCP_TOKEN:old,TASKS_MCP_OWNER_ID:'7',TASKS_MCP_PROJECTS:'synapse-business,palitra-love',CRM_API_KEY:'fixture-crm-key',
    TASKS_MCP_DOCS_DIR:path.join(os.tmpdir(),'tasks-token-missing-docs-'+randomBytes(12).toString('hex'))};
  let server, port;
  const start=async token=>{
    const config=loadConfig({...env,TASKS_MCP_TOKEN:token});
    assert.equal(config.ownerId,7);assert.deepEqual(config.projects,['synapse-business','palitra-love']);
    server=createTasksMcpServer(config,{callCrm:async(name,args)=>{
      assert.equal(name,'task_get');assert.equal(args.task_id,25);
      return {id:25,title:'SAMPLE',company_code:'synapse-business'};
    }});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port||0,'127.0.0.1',resolve);});
    port=server.address().port;
  };
  const stop=async()=>{if(server){const closed=server;server=null;closed.closeAllConnections();await new Promise(resolve=>closed.close(resolve));}};
  t.after(stop);
  const rpc=async(token,method,params)=>{
    const response=await fetch(`http://127.0.0.1:${port}/mcp/${token}`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',connection:'close'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,...(params===undefined?{}:{params})})});
    return {status:response.status,body:await response.json()};
  };
  await start(old);
  assert.equal((await rpc(old,'tools/list')).status,200);assert.equal((await rpc(next,'tools/list')).status,401);
  await stop();await start(next);
  assert.equal((await rpc(old,'tools/list')).status,401);
  const init=await rpc(next,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'SAMPLE rotation',version:'1'}});
  assert.equal(init.status,200);assert.equal(init.body.result.serverInfo.name,'synapse-tasks');
  const listed=await rpc(next,'tools/list');assert.equal(listed.status,200);
  assert.deepEqual(listed.body.result.tools.map(tool=>tool.name),TOOLS.map(tool=>tool.name));
  const read=await rpc(next,'tools/call',{name:'task_get',arguments:{task_id:25}});
  assert.equal(read.status,200);assert.equal(read.body.result.structuredContent.id,25);
  // A missing real MAP must not be misreported as a failed authentication check.
  const missing=await rpc(next,'tools/call',{name:'session_start',arguments:{agent:'SAMPLE',kind:'codex',request:'SAMPLE'}});
  assert.equal(missing.status,200);assert.equal(missing.body.result.isError,true);
  const forbidden=await new Promise((resolve,reject)=>{
    const request=http.request(`http://127.0.0.1:${port}/mcp/${next}`,{method:'POST',headers:{host:'foreign.example','content-type':'application/json',connection:'close'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});
    request.on('error',reject);request.end('{}');
  });
  assert.equal(forbidden,403);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`,{headers:{connection:'close'}})).status,200);
});

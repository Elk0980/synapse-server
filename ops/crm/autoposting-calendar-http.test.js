'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {randomBytes} = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');

test('calendar HTTP route keeps existing company/view authorization and requires one explicit bounded period', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'autoposting-calendar-api-'));
  const database = path.join(directory, 'crm.sqlite');
  const key = randomBytes(24).toString('hex');
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  let child, db;
  t.after(async () => {
    if (db) db.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill();
      await exit;
    }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, {recursive:true, force:true});
  });
  let output = '';
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env:{SystemRoot:process.env.SystemRoot || '', PATH:process.env.PATH || '',
      PORT:String(port), DATABASE_PATH:database, API_KEY:key},
    stdio:['ignore','pipe','ignore'], windowsHide:true,
  });
  child.stdout.on('data', chunk => {output += chunk;});
  for (let attempt = 0; attempt < 200 && !output.includes('слушает'); attempt++) {
    if (child.exitCode !== null) throw Error('Fixture CRM failed to start');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.match(output, /слушает/);

  const encode = identity => Buffer.from(JSON.stringify({v:1,userId:1,role:'editor',permissions:[],companyCodes:[],...identity})).toString('base64url');
  const owner = encode({role:'owner'});
  const viewer = encode({permissions:['autoposting.view'],companyCodes:['qa']});
  const editorOnly = encode({permissions:['autoposting.edit'],companyCodes:['qa']});
  async function request(method, url, {body, identity = owner, authenticated = true} = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method, headers:{...(authenticated ? {'x-api-key':key} : {}),
        ...(identity ? {'x-synapse-crm-identity':identity} : {}),
        ...(body ? {'content-type':'application/json'} : {})},
      body:body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(5000),
    });
    return {status:response.status, body:await response.json(), cache:response.headers.get('cache-control')};
  }
  for (const code of ['qa','other']) assert.equal((await request('POST','/companies',{body:{code,name:code,timezone:'UTC'}})).status,201);
  const card = await request('POST','/autoposting/posts?companyCode=qa',{body:{title:'QA calendar',text:'Fixture text',
    mediaUrls:['https://example.test/fixture.jpg'],platformIds:['telegram'],scheduledAt:'2040-09-24T20:30:00.000Z'}});
  assert.equal(card.status,201);
  const foreign = await request('POST','/autoposting/posts?companyCode=other',{body:{title:'Foreign private text',scheduledAt:'2040-09-25T00:00:00.000Z'}});
  assert.equal(foreign.status,201);
  db = new DatabaseSync(database);
  // A legacy edit has not yet been archived by company-information.get.
  db.prepare("UPDATE companies SET timezone='Asia/Bangkok' WHERE code='qa'").run();
  const snapshot = () => JSON.stringify({
    profiles:db.prepare('SELECT * FROM company_information ORDER BY company_id').all(),
    versions:db.prepare('SELECT * FROM company_information_versions ORDER BY company_id,revision').all(),
    posts:db.prepare('SELECT * FROM autoposting_posts ORDER BY id').all(),
    deliveries:db.prepare('SELECT * FROM autoposting_deliveries ORDER BY post_id,channel_id').all(),
  });
  const before = snapshot();
  const period = '?companyCode=qa&from=2040-09-01&to=2040-09-30';
  const route = '/autoposting/calendar';
  assert.equal((await request('GET',route+period,{authenticated:false})).status,401);
  assert.equal((await request('GET',route+period,{identity:null})).status,403);
  assert.equal((await request('GET',route+period,{identity:editorOnly})).status,403);
  assert.equal((await request('GET',route+period.replace('qa','other'),{identity:viewer})).status,403);
  const result = await request('GET',route+period,{identity:viewer});
  assert.equal(result.status,200);
  assert.equal(result.cache,'no-store');
  assert.equal(result.body.companyCode,'qa');
  assert.equal(result.body.timezone,'Asia/Bangkok');
  assert.equal(result.body.posts.length,1);
  assert.equal(result.body.posts[0].id,card.body.id);
  assert.equal(result.body.posts[0].effectiveDate,'2040-09-25');
  assert.equal(result.body.posts[0].dateKind,'schedule');
  assert.equal(result.body.posts[0].calendarReadiness.ready,false);
  assert.doesNotMatch(JSON.stringify(result.body),/Foreign private text/);
  assert.equal(result.body.summary.stockDays,null);
  assert.equal(result.body.coverage.guaranteedDays,null);
  for (const query of ['', '?companyCode=qa', '?from=2040-09-01&to=2040-09-30',
    '?companyCode=qa&from=2040-02-30&to=2040-03-01',
    '?companyCode=qa&from=2040-09-01&to=2040-10-02',
    '?companyCode=qa&from=2040-09-02&to=2040-09-01',
    period+'&from=2040-09-02', period+'&to=2040-09-29',
    period+'&companyCode=other', period+'&unexpected=1']) {
    assert.equal((await request('GET',route+query)).status,400,query);
  }
  assert.equal((await request('POST',route+period,{body:{}})).status,405);
  assert.equal(snapshot(),before,'calendar and rejected requests must leave profile/post/delivery data unchanged');
});

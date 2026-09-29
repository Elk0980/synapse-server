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

test('split HTTP route reuses existing company-scoped autoposting authorization and refuses unsettled cards', async t => {
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

  const created = await request('POST','/autoposting/posts?companyCode=qa',{body:{title:'Материал',text:'Текст',
    mediaUrls:['https://example.test/clip.mp4'],platformIds:['telegram'],dayKey:'D1',captions:{telegram:'ТГ'},
    timezone:'UTC',profileRevision:1}});
  assert.equal(created.status,201);
  const id = created.body.id;
  assert.ok(Number.isSafeInteger(id) && id > 0, 'создание материала возвращает его идентификатор');

  // Метод существует и не поддерживает ничего, кроме POST.
  assert.equal((await request('GET',`/autoposting/posts/${id}/split?companyCode=qa`)).status,405);

  // Черновик продолжать нельзя: карточка сама может отправить те же площадки.
  const unsettled = await request('POST',`/autoposting/posts/${id}/split?companyCode=qa`,
    {body:{revision:created.body.revision,platformIds:['telegram']}});
  assert.equal(unsettled.status,409);
  assert.match(JSON.stringify(unsettled.body),/можно только после того, как отправка/);
  // cache-control на ответе с ошибкой ставит общий обработчик сервера; его контракт этим тестом
  // не переопределяется и не проверяется — маршрут ради теста не меняем.

  // Права те же, что у правки материалов этой компании: новых режимов не появилось.
  const asViewer = await request('POST',`/autoposting/posts/${id}/split?companyCode=qa`,
    {body:{revision:1,platformIds:['telegram']},identity:viewer});
  assert.equal(asViewer.status,403);
  const foreign = await request('POST',`/autoposting/posts/${id}/split?companyCode=other`,
    {body:{revision:1,platformIds:['telegram']},identity:editorOnly});
  assert.ok([403,404].includes(foreign.status),'чужая компания не продолжает материал');
  const unauthenticated = await request('POST',`/autoposting/posts/${id}/split?companyCode=qa`,
    {body:{revision:1,platformIds:['telegram']},authenticated:false});
  assert.equal(unauthenticated.status,401);
});

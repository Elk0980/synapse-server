'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {hashPassword} = require('./passwords');

test('client account creation is atomic and cabinet APIs enforce project + permission', async () => {
  // All credentials are generated only in memory; never print or write them.
  const dir = fs.mkdtempSync('/tmp/client-price-access-');
  const ownerSecret = crypto.randomBytes(24).toString('hex');
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {...process.env, PORT: String(port), DATABASE_PATH: dir + '/db.sqlite', ASSETS_DIR: dir + '/assets',
      SEED_DIR: path.join(__dirname, 'seed'), API_KEY: '',
      AUTH_USERS: `owner:owner:${hashPassword(ownerSecret)}`, SESSION_SECRET: crypto.randomBytes(32).toString('hex')}, stdio: 'ignore'
  });
  const base = 'http://127.0.0.1:' + port;
  const req = (url, session, method = 'GET', body, extra = {}) => fetch(base + url, {method,
    headers: {...(session ? {cookie: session.cookie, 'X-CSRF-Token': session.csrf} : {}), ...(body ? {'Content-Type':'application/json'} : {}), ...extra},
    ...(body ? {body: JSON.stringify(body)} : {})});
  async function login(name, secret) {
    const r = await req('/content/login', null, 'POST', {login: name, password: secret});
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const who = await req('/content/whoami', {cookie}); assert.equal(who.status, 200);
    const profile = await who.json(); return {cookie, csrf: profile.csrfToken, profile};
  }
  try {
    let ready = false;
    for (let i=0; i<150; i++) { try {if ((await req('/health')).ok) {ready=true;break;}} catch {}
      await new Promise(resolve=>setTimeout(resolve,20)); }
    assert.ok(ready, 'server starts');
    const owner = await login('owner', ownerSecret);
    const opts = await (await req('/content/admin/accounts/access-options', owner)).json();
    const preset = opts.presets.find(p => p.id === 'client-price');
    assert.deepEqual(preset.permissions, ['sites.view', 'price.view', 'price.edit']);
    assert.equal(preset.singleCompany, true);
    const create = async (name, companies, permissions) => {
      const secret = crypto.randomBytes(24).toString('hex');
      const body = {login:name, displayName:'QA', password:secret, companies, permissions};
      const r = await req('/content/admin/accounts', owner, 'POST', body);
      assert.equal(r.status, 201); const safe = await r.json();
      assert.equal(safe.password, undefined); assert.equal(safe.passwordHash, undefined);
      assert.equal(safe.role, 'editor');
      assert.deepEqual(safe.companies.map(c=>c.id).sort(), [...companies].sort());
      assert.deepEqual(safe.permissions.sort(), [...permissions].sort());
      return login(name, secret);
    };
    const client = await create('qa_client', ['palitra-love'], preset.permissions);
    const empty = await create('qa_empty', [], []);
    const viewer = await create('qa_viewer', ['palitra-love'], ['price.view']);
    await create('qa_multi', ['alvi', 'avokado'], ['price.view']);
    const sites = await (await req('/content/sites', client)).json();
    assert.deepEqual(sites.sites.map(site=>site.company.id), ['palitra-love']);
    assert.equal((await req('/content/sites/alvi', client)).status, 404);
    for (const url of ['/content/admin/accounts', '/content/admin/accounts/access-options']) {
      assert.equal((await req(url, client)).status, 403);
    }
    const own = await req('/content/palitra/price', client); assert.equal(own.status, 200);
    const doc = await own.json();
    assert.equal((await req('/content/palitra/price', client, 'PUT', doc)).status, 200);
    assert.equal((await req('/content/palitra/price', client, 'PUT', doc, {'X-CSRF-Token':''})).status, 403);
    assert.equal((await req('/content/palitra/price', viewer, 'PUT', doc)).status, 403);
    const upload = await fetch(base+'/content/palitra/assets', {method:'POST', headers:{cookie:client.cookie,
      'X-CSRF-Token':client.csrf, 'Content-Type':'image/png'}, body:Buffer.from([137,80,78,71])});
    assert.equal(upload.status,200);
    for (const site of ['alvi','avokado','avokado2']) {
      for (const suffix of ['price','price/history','price/version/1','site','assets']) {
        assert.equal((await req(`/content/${site}/${suffix}`, client)).status,403, site+'/'+suffix);
        assert.equal((await req(`/content/${site}/${suffix}`, client, 'GET', null, {'X-API-Key':'invalid-test-header'})).status,401);
      }
      assert.equal((await req(`/content/${site}/price`, client, 'PUT', doc)).status,403);
      assert.equal((await req(`/content/${site}/price/restore/1`, client, 'POST')).status,403);
      assert.equal((await req(`/content/${site}/assets`, client, 'POST', {})).status,403);
    }
    for (const session of [empty, null]) {
      assert.equal((await req('/content/palitra/price', session)).status, session ? 403 : 401);
      assert.equal((await req('/content/alvi/price', session)).status, session ? 403 : 401);
    }
    // Public websites still receive current data, without cookies or privileged endpoints.
    const published = await req('/public-content/palitra/price'); assert.equal(published.status,200);
    assert.equal((await published.json()).version, doc.version+1);
    for (const site of ['alvi','avokado']) assert.equal((await req(`/public-content/${site}/price`)).status,200);
    assert.equal((await req('/public-content/palitra/price/history')).status,404);
    assert.equal((await req('/public-content/palitra/price', null, 'PUT', doc)).status,404);
    // Invalid assignments must not leave behind an account with partially granted access.
    for (const [companies, permissions] of [[['__proto__'],[]], [['palitra-love'],['unknown']]]) {
      const r=await req('/content/admin/accounts', owner, 'POST', {login:'qa_invalid', displayName:'QA',
        password:crypto.randomBytes(24).toString('hex'), companies, permissions}); assert.equal(r.status,400);
    }
    const accounts = await (await req('/content/admin/accounts', owner)).json();
    assert.equal(accounts.accounts.some(account=>account.login==='qa_invalid'),false);
    const dependent = await req('/content/admin/accounts', owner, 'POST', {login:'qa_dependent', displayName:'QA',
      password:crypto.randomBytes(24).toString('hex'), companies:['palitra-love'], permissions:['price.edit']});
    assert.equal(dependent.status,201);
    assert.deepEqual((await dependent.json()).permissions,['price.edit','price.view']);
    // Revocation affects an existing session immediately.
    assert.equal((await req(`/content/admin/accounts/${client.profile.userId}/access`, owner,'PUT',{companies:[],permissions:[]})).status,200);
    assert.equal((await req('/content/palitra/price',client)).status,403);
  } finally {
    if (child.exitCode===null && child.signalCode===null) {child.kill();await once(child,'exit');}
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

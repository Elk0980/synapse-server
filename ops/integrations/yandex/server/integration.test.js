'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { YandexIntegration } = require('./index');
const { FileStore } = require('./store');
const { losslessParse } = require('./core');

const permissions = ['ads.configure', 'ads.read', 'ads.propose', 'ads.approve', 'ads.execute', 'ads.reconcile'];
const actor = (kind = 'human', companyIds = ['co-a', 'co-b'], who = 'owner') => ({ id: who, kind, companyIds, permissions });
const owner = actor();
const agent = actor('agent', ['co-a', 'co-b'], 'agent');
const runner = actor('service', ['co-a', 'co-b'], 'worker');
const range = { from: '2026-10-01', to: '2026-11-01', timezone: 'Europe/Moscow' };
const adId = '9007199254740993123'; // Synthetic signed-long precision fixture.
const secret = 'synthetic-private-credential-do-not-store';

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-yandex-test-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    const relative = path.relative(path.resolve(os.tmpdir()), resolved);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) &&
      path.basename(resolved).startsWith('synapse-yandex-test-'), 'Remove only the isolated test directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  let clock = Date.parse('2026-10-10T00:00:00Z');
  const campaign = (Id) => ({ Id, Status: 'DRAFT', State: 'OFF', Type: 'UNIFIED_CAMPAIGN', Currency: 'RUB' });
  const campaigns = [campaign('101'), campaign('202')];
  const ad = (Id, CampaignId) => ({ Id, CampaignId, AdGroupId: CampaignId + '1', Type: 'RESPONSIVE_AD', Status: 'DRAFT', State: 'OFF',
    ResponsiveAd: { Titles: [{ Title: 'Заголовок один' }, { Title: 'Заголовок два' }],
      Texts: [{ Text: 'Текст один' }, { Text: 'Текст два' }], Href: 'https://a.example/offer?utm_source=yandex',
      DisplayUrlPath: 'offer', AdImages: { Items: [{ ImageHash: 'image-a', Status: 'DRAFT' }, { ImageHash: 'image-b', Status: 'DRAFT' }] },
      VideoExtensions: { Items: [{ CreativeId: '777', Status: 'DRAFT' }] }, SitelinkSetId: '55' } });
  const ads = [ad(adId, '101'), ad('800', '202')];
  ads[1].ResponsiveAd.Href = 'https://b.example/offer';
  const calls = [];
  let timeout = false;
  const transport = async (request) => {
    assert.equal(request.headers.Authorization, `${request.service === 'metrika' ? 'OAuth' : 'Bearer'} ${secret}`);
    calls.push({ service: request.service, method: request.method, url: request.url, body: request.body });
    if (request.service === 'metrika') return { status: 200, body: { total_rows: 1, totals: [3, 2], data: [
      { dimensions: [{ name: '2026-10-10' }], metrics: [3, 2] }], sampled: true, sample_share: 0.5 } };
    const body = losslessParse(request.body);
    if (body.method === 'update') {
      const update = body.params.Ads[0];
      const found = ads.find((row) => row.Id === String(update.Id));
      assert.ok(found);
      for (const [field, value] of Object.entries(update.ResponsiveAd)) {
        found.ResponsiveAd[field] = ['Titles', 'Texts'].includes(field)
          ? value.map((entry) => ({ [field === 'Titles' ? 'Title' : 'Text']: entry })) : value;
      }
      if (timeout) throw new Error(`timeout Authorization Bearer ${secret}`);
      return { status: 200, body: { result: { UpdateResults: [{ Id: found.Id }] } } };
    }
    const wanted = body.params.SelectionCriteria.Ids.map(String);
    if (request.url.endsWith('/campaigns')) return { status: 200, body: { result: { Campaigns: campaigns.filter((row) => wanted.includes(row.Id)) } } };
    return { status: 200, body: { result: { Ads: ads.filter((row) => wanted.includes(row.Id)) } } };
  };
  const config = { directory, now: () => clock, transport, resolveSecret: async (_ref, context) => {
    assert.ok(['co-a', 'co-b'].includes(context.companyId)); return secret;
  } };
  const service = new YandexIntegration(config);
  for (const [companyId, label, site] of [['co-a', 'Первая', 'a.example'], ['co-b', 'Вторая', 'b.example']]) {
    service.saveProfile(owner, { companyId, label, siteHosts: [site], methodologyVersion: 'v1' });
  }
  service.registerConnection(owner, { id: 'shared', principalId: 'principal', accountId: 'account', clientLogin: 'login',
    secretRef: 'vault-ref', companyIds: ['co-a', 'co-b'], active: true, verifiedAt: '2026-10-10T00:00:00Z',
    quota: { limit: options.limit || 1000, windowMs: 60000 } });
  service.saveBindings(owner, 'co-a', { connectionId: 'shared', accountId: 'account', campaignIds: ['101'], counterIds: ['11'] });
  service.saveBindings(owner, 'co-b', { connectionId: 'shared', accountId: 'account', campaignIds: ['202'], counterIds: ['22'] });
  const importA = () => service.importExisting(owner, 'co-a', { campaignIds: ['101'], adIds: [adId] });
  const importB = () => service.importExisting(owner, 'co-b', { campaignIds: ['202'], adIds: ['800'] });
  const policy = (companyId = 'co-a', overrides = {}) => service.setPolicy(owner, companyId, {
    mode: 'draft', period: range, currency: 'RUB', maxBudgetMinor: '10000',
    allocations: [{ campaignId: companyId === 'co-a' ? '101' : '202', budgetMinor: '10000' }],
    allowedAdIds: [companyId === 'co-a' ? adId : '800'], ...overrides });
  const proposal = (companyId = 'co-a') => service.createProposal(agent, companyId, {
    adId: companyId === 'co-a' ? adId : '800', patch: { Titles: ['Новый первый', 'Заголовок два'] },
    expiresAt: '2026-10-10T01:00:00Z' });
  const queue = (p) => {
    service.approveProposal(owner, p.companyId, p.id, p.digest);
    return service.enqueueProposal(runner, p.companyId, p.id, p.digest);
  };
  return { directory, service, config, campaigns, ads, calls, importA, importB, policy, proposal, queue,
    setTimeout: (value) => { timeout = value; }, advance: (ms) => { clock += ms; } };
}

test('new profiles are company-bound and have no inherited business budget or OAuth readiness', (t) => {
  const f = fixture(t);
  const view = f.service.getCompanyView(owner, 'co-b');
  assert.equal(view.policy.mode, 'observe');
  assert.equal(view.policy.maxBudgetMinor, null);
  assert.deepEqual(view.bindings.counterIds, ['22']);
  assert.equal(view.capabilities.import, 'unverified');
  assert.equal(view.capabilities.launch, 'unsupported');
  assert.equal(JSON.stringify(view).includes('vault-ref'), false);
  assert.throws(() => f.service.saveProfile(owner, { companyId: 'co-a', label: 'bad', siteHosts: ['a.example'], methodologyVersion: 'v1', accessToken: 'secret' }), { code: 'INVALID_FIELDS' });
});

test('methodology version is bounded human text while company identity remains a strict key', (t) => {
  const f = fixture(t);
  const profile = f.service.saveProfile(owner, { companyId: 'co-a', label: 'Компания', siteHosts: ['a.example'],
    methodologyVersion: 'Учебная методика 1 · редакция 28 октября' });
  assert.equal(profile.methodologyVersion, 'Учебная методика 1 · редакция 28 октября');
  assert.throws(() => f.service.saveProfile(owner, { companyId: 'co-a', label: 'Компания', siteHosts: ['a.example'],
    methodologyVersion: 'м'.repeat(129) }), { code: 'INVALID_TEXT' });
  assert.throws(() => f.service.saveProfile(owner, { companyId: '../co-a', label: 'Компания', siteHosts: ['a.example'],
    methodologyVersion: 'Методика 1' }), { code: 'INVALID_KEY' });
});

test('tenant, connection, account, campaign, ad and counter substitutions fail before transport', async (t) => {
  const f = fixture(t);
  const onlyA = actor('human', ['co-a']);
  assert.throws(() => f.service.getCompanyView(onlyA, 'co-b'), { code: 'FORBIDDEN' });
  assert.throws(() => f.service.saveBindings(owner, 'co-a', { connectionId: 'shared', accountId: 'other', campaignIds: ['101'], counterIds: ['11'] }), { code: 'BINDING_FORBIDDEN' });
  assert.throws(() => f.service.saveBindings(owner, 'co-a', { connectionId: 'shared', accountId: 'account', campaignIds: ['202'], counterIds: ['11'] }), { code: 'OBJECT_ALREADY_BOUND' });
  await assert.rejects(f.service.importExisting(onlyA, 'co-a', { campaignIds: ['202'], adIds: ['800'] }), { code: 'CAMPAIGN_NOT_BOUND' });
  await assert.rejects(f.service.metrikaReport(onlyA, 'co-a', { counterId: '22', range }), { code: 'COUNTER_NOT_BOUND' });
  assert.equal(f.calls.length, 0);
  await f.importA();
  assert.throws(() => f.service.createProposal(agent, 'co-b', { adId, patch: { Href: 'https://b.example/' }, expiresAt: '2026-10-10T01:00:00Z' }), { code: 'AD_NOT_IMPORTED' });
});

test('duplicate import is upsert, full responsive variants and lossless IDs survive persistence', async (t) => {
  const f = fixture(t);
  await f.importA(); await f.importA();
  const restored = new YandexIntegration(f.config).getCompanyView(owner, 'co-a');
  assert.equal(restored.objects.ads.length, 1);
  assert.equal(restored.objects.ads[0].Id, adId);
  assert.equal(restored.objects.ads[0].ResponsiveAd.Titles.length, 2);
  assert.equal(restored.objects.ads[0].ResponsiveAd.AdImages.Items.length, 2);
  assert.ok(f.calls[1].body.includes(adId));
  assert.ok(!f.calls[1].body.includes(`"${adId}"`));
  assert.equal(losslessParse(`{"Id":${adId}}`).Id, adId);
});

test('read-only default, unsupported fields, variant truncation and non-draft status cannot write', async (t) => {
  const f = fixture(t); await f.importA();
  const p = f.proposal();
  assert.throws(() => f.service.approveProposal(owner, 'co-a', p.id, p.digest), { code: 'READ_ONLY' });
  f.policy();
  assert.throws(() => f.service.createProposal(agent, 'co-a', { adId, patch: { Titles: ['lost'] }, expiresAt: '2026-10-10T01:00:00Z' }), { code: 'VARIANT_LOSS_FORBIDDEN' });
  assert.throws(() => f.service.createProposal(agent, 'co-a', { adId, patch: { TextAd: { Title: 'legacy' } }, expiresAt: '2026-10-10T01:00:00Z' }), { code: 'INVALID_FIELDS' });
  f.ads[0].Status = 'ACCEPTED'; await f.importA();
  const active = f.proposal();
  assert.throws(() => f.service.approveProposal(owner, 'co-a', active.id, active.digest), { code: 'DRAFT_ONLY' });
  assert.ok(f.calls.every((call) => losslessParse(call.body).method === 'get'));
});

test('sum of campaign allocations is bounded once per company and exact period', async (t) => {
  const f = fixture(t); await f.importA();
  f.service.saveBindings(owner, 'co-b', { connectionId: 'shared', accountId: 'account', campaignIds: [], counterIds: ['22'] });
  f.service.saveBindings(owner, 'co-a', { connectionId: 'shared', accountId: 'account', campaignIds: ['101', '202'], counterIds: ['11'] });
  await f.importA();
  assert.throws(() => f.policy('co-a', { allocations: [{ campaignId: '101', budgetMinor: '10000' }, { campaignId: '202', budgetMinor: '10000' }] }), { code: 'TOTAL_BUDGET_EXCEEDED' });
  const good = f.policy('co-a', { allocations: [{ campaignId: '101', budgetMinor: '6000' }, { campaignId: '202', budgetMinor: '4000' }] });
  assert.equal(good.maxBudgetMinor, '10000');
  assert.deepEqual(good.period, range);
});

test('approval binds policy, profile, exact patch, objects, expiry and fresh remote base', async (t) => {
  const f = fixture(t); await f.importA(); f.policy();
  const p = f.proposal();
  assert.throws(() => f.service.approveProposal(owner, 'co-a', p.id, 'wrong'), { code: 'PROPOSAL_NOT_FOUND' });
  assert.throws(() => f.service.approveProposal(agent, 'co-a', p.id, p.digest), { code: 'HUMAN_REQUIRED' });
  f.policy();
  assert.throws(() => f.service.approveProposal(owner, 'co-a', p.id, p.digest), { code: 'STALE_APPROVAL' });
  const fresh = f.proposal(); f.queue(fresh);
  f.ads[0].ResponsiveAd.Texts[1].Text = 'Ручная правка';
  const result = await f.service.runNext(runner, 'co-a', 'w1');
  assert.equal(result.state, 'blocked'); assert.equal(result.code, 'STALE_APPROVAL');
  assert.equal(f.calls.filter((call) => losslessParse(call.body).method === 'update').length, 0);
  const p2 = f.proposal(); f.advance(3600001);
  assert.throws(() => f.service.approveProposal(owner, 'co-a', p2.id, p2.digest), { code: 'APPROVAL_EXPIRED' });
});

test('approved draft update preserves second variant, images, videos, UTM and is durable/idempotent', async (t) => {
  const f = fixture(t); await f.importA(); f.policy();
  const before = structuredClone(f.ads[0].ResponsiveAd);
  const p = f.proposal(); const job = f.queue(p);
  assert.equal(f.service.enqueueProposal(runner, 'co-a', p.id, p.digest).id, job.id);
  const completed = await new YandexIntegration(f.config).runNext(runner, 'co-a', 'worker1');
  assert.equal(completed.state, 'completed');
  const after = f.ads[0].ResponsiveAd;
  assert.equal(after.Titles[1].Title, before.Titles[1].Title);
  assert.deepEqual(after.Texts, before.Texts);
  assert.deepEqual(after.AdImages, before.AdImages);
  assert.deepEqual(after.VideoExtensions, before.VideoExtensions);
  assert.equal(after.Href, before.Href);
  assert.equal(await f.service.runNext(runner, 'co-a', 'worker2'), null);
  const writes = f.calls.filter((call) => losslessParse(call.body).method === 'update');
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(losslessParse(writes[0].body).params.Ads[0]), ['Id', 'ResponsiveAd']);
  assert.ok(!fs.readFileSync(path.join(f.directory, 'state.json'), 'utf8').includes(secret));
});

test('atomic claim blocks duplicate workers and shared-account writes across companies', async (t) => {
  const f = fixture(t); await f.importA(); await f.importB(); f.policy(); f.policy('co-b');
  f.queue(f.proposal()); f.queue(f.proposal('co-b'));
  const a = f.service.claim(runner, 'co-a', 'one', 1000);
  assert.ok(a);
  assert.equal(new YandexIntegration(f.config).claim(runner, 'co-a', 'two'), null);
  assert.equal(f.service.claim(runner, 'co-b', 'three'), null);
  f.advance(1001);
  const replacement = f.service.claim(runner, 'co-a', 'replacement');
  assert.notEqual(replacement.leaseToken, a.leaseToken);
  const locked = path.join(f.directory, 'transaction.lock'); fs.mkdirSync(locked);
  assert.throws(() => new FileStore(f.directory), { code: 'STORE_BUSY' });
  fs.rmdirSync(locked);
});

test('write timeout becomes unknown; restart does not retry; readback reconciles but retains account fence', async (t) => {
  const f = fixture(t); await f.importA(); await f.importB(); f.policy(); f.policy('co-b');
  const queued = f.queue(f.proposal()); f.queue(f.proposal('co-b')); f.setTimeout(true);
  const result = await f.service.runNext(runner, 'co-a', 'one');
  assert.equal(result.state, 'unknown'); assert.equal(result.code, 'TRANSPORT_FAILED');
  const restored = new YandexIntegration(f.config);
  assert.equal(await restored.runNext(runner, 'co-a', 'two'), null);
  assert.equal(await restored.runNext(runner, 'co-b', 'three'), null);
  const reconciled = await restored.reconcileUnknown(runner, 'co-a', queued.id);
  assert.equal(reconciled.state, 'reconciled_locked');
  assert.equal(await restored.runNext(runner, 'co-b', 'four'), null);
  assert.equal(f.calls.filter((call) => call.body && losslessParse(call.body).method === 'update').length, 1);
  const state = fs.readFileSync(path.join(f.directory, 'state.json'), 'utf8');
  assert.ok(!state.includes(secret)); assert.ok(!state.includes('Authorization'));
});

test('shared connection quotas cannot be multiplied by companies or duplicate connections', async (t) => {
  const f = fixture(t, { limit: 3 }); await f.importA();
  await assert.rejects(f.importB(), { code: 'QUOTA_EXCEEDED' });
  assert.equal(f.calls.length, 3);
  assert.throws(() => f.service.registerConnection(owner, { id: 'duplicate', principalId: 'principal', accountId: 'account', clientLogin: 'login',
    secretRef: 'another-ref', companyIds: ['co-a'], active: true, verifiedAt: null, quota: { limit: 99, windowMs: 60000 } }), { code: 'SHARED_QUOTA_MISMATCH' });
});

test('Metrika report only reads bound counters and labels sampled statistics', async (t) => {
  const f = fixture(t);
  const report = await f.service.metrikaReport(owner, 'co-a', { counterId: '11', range });
  assert.deepEqual(report.totals, [3, 2]); assert.equal(report.sampled, true); assert.equal(report.sampleShare, 0.5);
  assert.ok(f.calls.every((call) => call.method === 'GET'));
});

test('unconfigured runtime never performs OAuth or invents live data', (t) => {
  const f = fixture(t);
  const disconnected = new YandexIntegration({ directory: f.directory });
  assert.equal(disconnected.getCompanyView(owner, 'co-a').capabilities.transport, 'disabled');
  assert.equal(typeof disconnected.launch, 'undefined');
  assert.equal(typeof disconnected.moderate, 'undefined');
  assert.equal(typeof disconnected.pay, 'undefined');
});

test('policy changed during async secret resolution prevents the transport write', async (t) => {
  const f = fixture(t); await f.importA(); f.policy(); f.queue(f.proposal());
  let changed = false;
  const service = new YandexIntegration({ ...f.config, resolveSecret: async () => {
    if (!changed && f.calls.length === 4) { changed = true; f.policy(); }
    return secret;
  } });
  const result = await service.runNext(runner, 'co-a', 'one');
  assert.equal(result.state, 'unknown'); assert.equal(result.code, 'STALE_APPROVAL');
  assert.equal(f.calls.filter((call) => call.body && losslessParse(call.body).method === 'update').length, 0);
});

test('expired writing lease is quarantined across restart and cannot be claimed again', async (t) => {
  const f = fixture(t); await f.importA(); f.policy(); f.queue(f.proposal());
  const service = new YandexIntegration({ ...f.config, resolveSecret: async () => {
    if (f.calls.length === 4) f.advance(60001);
    return secret;
  } });
  const result = await service.runNext(runner, 'co-a', 'one');
  assert.equal(result.state, 'unknown'); assert.equal(result.code, 'LEASE_LOST');
  assert.equal(new YandexIntegration(f.config).claim(runner, 'co-a', 'two'), null);
  assert.equal(f.calls.filter((call) => call.body && losslessParse(call.body).method === 'update').length, 0);
});

test('401/403 revoke the shared connection, stop dependent companies and never expose raw body', async (t) => {
  const f = fixture(t);
  const denied = new YandexIntegration({ ...f.config,
    transport: async () => ({ status: 403, body: { message: secret } }) });
  await assert.rejects(denied.importExisting(owner, 'co-a', { campaignIds: ['101'], adIds: [adId] }), { code: 'ACCESS_REVOKED' });
  assert.equal(denied.getCompanyView(owner, 'co-a').connection.active, false);
  assert.equal(denied.getCompanyView(owner, 'co-b').connection.active, false);
  await assert.rejects(denied.importExisting(owner, 'co-b', { campaignIds: ['202'], adIds: ['800'] }), { code: 'CONNECTION_NOT_AVAILABLE' });
  assert.ok(!fs.readFileSync(path.join(f.directory, 'state.json'), 'utf8').includes(secret));
});

test('unsafe numeric ID, response scope mismatch and partial response fail closed', async (t) => {
  const f = fixture(t);
  const unsafe = new YandexIntegration({ ...f.config, transport: async (request) => ({ status: 200,
    body: { result: request.url.endsWith('/campaigns') ? { Campaigns: [{ ...f.campaigns[0], Id: Number(adId) }] } : { Ads: [f.ads[0]] } } }) });
  await assert.rejects(unsafe.importExisting(owner, 'co-a', { campaignIds: ['101'], adIds: [adId] }), { code: 'INVALID_ID' });
  const mismatch = new YandexIntegration({ ...f.config, transport: async (request) => ({ status: 200,
    body: { result: request.url.endsWith('/campaigns') ? { Campaigns: [f.campaigns[1]] } : { Ads: [f.ads[1]] } } }) });
  await assert.rejects(mismatch.importExisting(owner, 'co-a', { campaignIds: ['101'], adIds: [adId] }), { code: 'RESPONSE_SCOPE_MISMATCH' });
  const partial = new YandexIntegration({ ...f.config, transport: async () => ({ status: 200,
    body: { result: { Campaigns: [f.campaigns[0]], LimitedBy: 1 } } }) });
  await assert.rejects(partial.importExisting(owner, 'co-a', { campaignIds: ['101'], adIds: [adId] }), { code: 'INCOMPLETE_RESPONSE' });
  assert.equal(f.service.getCompanyView(owner, 'co-a').objects.ads.length, 0);
});

test('late write 403 revokes captured old connection, preserves new binding and fences shared account', async (t) => {
  const f = fixture(t); await f.importA(); await f.importB(); f.policy(); f.policy('co-b');
  f.queue(f.proposal()); f.queue(f.proposal('co-b'));
  let entered;
  let finish;
  const pending = new Promise((resolve) => { entered = resolve; });
  const service = new YandexIntegration({ ...f.config, transport: async (request) => {
    if (losslessParse(request.body).method !== 'update') return f.config.transport(request);
    entered();
    return new Promise((resolve) => { finish = resolve; });
  } });
  const run = service.runNext(runner, 'co-a', 'old-worker');
  await pending;
  service.registerConnection(owner, { id: 'new-connection', principalId: 'principal', accountId: 'new-account', clientLogin: 'new-login',
    secretRef: 'new-vault-ref', companyIds: ['co-a'], active: true, verifiedAt: '2026-10-10T00:00:00Z', quota: { limit: 1000, windowMs: 60000 } });
  service.saveBindings(owner, 'co-a', { connectionId: 'new-connection', accountId: 'new-account', campaignIds: ['101'], counterIds: ['11'] });
  finish({ status: 403, body: { message: secret } });
  const result = await run;
  assert.equal(result.state, 'unknown'); assert.equal(result.code, 'ACCESS_REVOKED');
  assert.equal(service.getCompanyView(owner, 'co-a').connection.active, true, 'Late old response must not revoke a newly bound connection');
  assert.equal(service.getCompanyView(owner, 'co-b').connection.active, false, 'Shared dependents of the actual old connection are stopped');
  assert.equal(await service.runNext(runner, 'co-b', 'shared-worker'), null, 'Unknown write retains the old shared account fence');
});

test('late write 401 cannot revoke newer authorization under the same connection id', async (t) => {
  const f = fixture(t); await f.importA(); await f.importB(); f.policy(); f.policy('co-b');
  f.queue(f.proposal()); f.queue(f.proposal('co-b'));
  let entered;
  let finish;
  const pending = new Promise((resolve) => { entered = resolve; });
  const service = new YandexIntegration({ ...f.config, transport: async (request) => {
    if (losslessParse(request.body).method !== 'update') return f.config.transport(request);
    entered(); return new Promise((resolve) => { finish = resolve; });
  } });
  const run = service.runNext(runner, 'co-a', 'old-worker');
  await pending;
  service.registerConnection(owner, { id: 'shared', principalId: 'principal', accountId: 'account', clientLogin: 'login',
    secretRef: 'new-auth-ref', companyIds: ['co-a', 'co-b'], active: true, verifiedAt: '2026-10-10T00:00:00Z', quota: { limit: 1000, windowMs: 60000 } });
  finish({ status: 401, body: { message: secret } });
  const result = await run;
  assert.equal(result.state, 'unknown');
  assert.equal(service.getCompanyView(owner, 'co-a').connection.active, true);
  assert.equal(service.getCompanyView(owner, 'co-b').connection.active, true);
  assert.equal(await service.runNext(runner, 'co-b', 'shared-worker'), null);
});

test('late import access failure cannot revoke re-registered connection version', async (t) => {
  const f = fixture(t);
  let entered;
  let finish;
  const pending = new Promise((resolve) => { entered = resolve; });
  const service = new YandexIntegration({ ...f.config, transport: async () => {
    entered(); return new Promise((resolve) => { finish = resolve; });
  } });
  const importing = service.importExisting(owner, 'co-a', { campaignIds: ['101'], adIds: [adId] });
  await pending;
  service.registerConnection(owner, { id: 'shared', principalId: 'principal', accountId: 'account', clientLogin: 'login',
    secretRef: 'new-auth-ref', companyIds: ['co-a', 'co-b'], active: true, verifiedAt: '2026-10-10T00:00:00Z', quota: { limit: 1000, windowMs: 60000 } });
  finish({ status: 403, body: { message: secret } });
  await assert.rejects(importing, { code: 'ACCESS_REVOKED' });
  assert.equal(service.getCompanyView(owner, 'co-a').connection.active, true);
  assert.equal(service.getCompanyView(owner, 'co-b').connection.active, true);
});

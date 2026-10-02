'use strict';
/* Регрессии текущего Telegram-снимка: реальные адаптеры и планировщик, только
   синтетические ответы и SQLite :memory:. Сети и публикаций в этих тестах нет. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createSocialStats } = require('./social-stats');
const { createSocialAdapters } = require('./social-adapters');
const { createAutopostingTransport } = require('./autoposting-transport');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const plain = rows => rows.map(row => ({ ...row }));
const tick = () => new Promise(resolve => setImmediate(resolve));
const failure = code => Object.assign(new Error('Синтетический отказ источника'), { code });

function fixture(t, { provider = 'direct', channel = false, value = 136,
  timezone = 'Asia/Bangkok', collectHour = 6, at = '2026-09-29T01:30:00Z', analytics = null } = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY, code TEXT UNIQUE COLLATE NOCASE, name TEXT, timezone TEXT, is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies(id,code,name,timezone) VALUES
      (1,'demo-a','Компания А','Asia/Bangkok'),(2,'demo-b','Компания Б','Asia/Irkutsk');
    CREATE TABLE leads(id INTEGER PRIMARY KEY, company_code TEXT, created_at TEXT, stage TEXT, sale_amount REAL,
      source TEXT, utm_source TEXT, utm_content TEXT, utm_campaign TEXT, referrer TEXT, landing_page TEXT);`);
  const clock = { ms: Date.parse(at) };
  const source = { value, ref: '@demo_channel', revision: 1, error: null, handler: null, calls: [] };
  const transport = {
    connectionRevision: () => ({ provider: 'direct', revision: source.revision, target: source.ref }),
    async readStats(code, platform, method, params) {
      source.calls.push({ code, platform, method, params, at: clock.ms, path: 'direct' });
      if (source.handler) return source.handler({ code, platform, method, params });
      if (source.error) throw source.error;
      return { provider: 'direct', target: source.ref, result: source.value };
    },
  };
  const channelStats = channel ? {
    ready: true,
    async channelMembers(code) {
      source.calls.push({ code, at: clock.ms, path: 'channel' });
      if (source.handler) return source.handler({ code });
      if (source.error) throw source.error;
      return { companyCode: code, accountRef: source.ref, value: source.value,
        observedAt: new Date(clock.ms).toISOString(), source: 'getChatMemberCount' };
    },
  } : null;
  const adapters = createSocialAdapters({ transport, channelStats, analytics, now: () => clock.ms });
  const options = { now: () => clock.ms, adapters, logger: { warn() {} } };
  let stats = createSocialStats(db, options);
  function save(patch = {}, code = 'demo-a', platform = 'telegram') {
    const current = db.prepare('SELECT * FROM social_accounts WHERE company_code=? AND platform=?').get(code, platform);
    return stats.saveAccounts(code, { accounts: [{
      platform, accountRef: current?.account_ref ?? source.ref, provider: current?.provider ?? provider,
      providerRef: current?.provider_ref ?? '', enabled: Boolean(current?.enabled ?? true),
      kind: current?.kind ?? 'unknown', timezone: current?.timezone ?? timezone,
      collectHour: current?.collect_hour ?? collectHour, revision: current?.revision ?? 0, ...patch,
    }] });
  }
  save();
  return { db, clock, source, adapters, save,
    get stats() { return stats; },
    restart() { stats = createSocialStats(db, options); },
    queue: () => stats.queuedDates('demo-a', 'telegram', source.ref),
    snapshots: () => plain(db.prepare(`SELECT date,value,timezone,collected_at FROM social_snapshots
      WHERE company_code='demo-a' AND platform='telegram' ORDER BY date,timezone`).all()),
  };
}

function seedQueue(f, { code = 'demo-a', platform = 'telegram', ref = '@demo_channel', date = '2026-09-28' } = {}) {
  f.db.prepare(`INSERT INTO social_collect_queue
    (company_code,platform,account_ref,date,reason,attempts,next_attempt_at,last_status,created_at,updated_at)
    VALUES(?,?,?,?,?,2,?,'partial',?,?)`).run(code, platform, ref, date, 'Старая очередь',
    '2026-09-29T00:00:00.000Z', '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z');
}

test('контракт адаптеров: Telegram объявляет current_snapshot и завершает доступный счётчик без retry', async t => {
  for (const [provider, channel] of [['direct', false], ['direct', true], ['onlypult', true]]) {
    await t.test(`${provider}, channelStats=${channel}`, async t => {
      const f = fixture(t, { provider, channel });
      const account = f.db.prepare('SELECT * FROM social_accounts').get();
      const adapter = f.adapters[provider];
      const context = { company: { code: 'demo-a' }, platform: 'telegram', account, date: '2026-09-29', timezone: account.timezone };
      assert.equal(adapter.collectionMode(context), 'current_snapshot');
      const result = await adapter.collect(context);
      assert.equal(result.status, 'partial', 'недоступные просмотры не выдаются за полную аналитику');
      assert.equal(result.retryable, false, 'недоступные метрики не требуют повторного запроса числа подписчиков');
      assert.deepEqual(result.snapshots.map(row => [row.period, row.metric, row.value]), [['lifetime', 'followers', 136]]);
      assert.match(result.missing.join(' '), /Bot API/);
      assert.equal(f.source.calls.length, 1);
      assert.equal(f.source.calls[0].path, channel ? 'channel' : 'direct');
      assert.equal(f.adapters.direct.collectionMode({ platform: 'vk' }), 'daily');
      assert.equal(f.adapters.onlypult.collectionMode({ platform: 'instagram' }), 'daily');
      assert.equal(f.adapters.onlypult.collectionMode({ platform: 'tiktok' }), 'daily');
    });
  }
});

test('Telegram снимается один раз после collectHour в локальном поясе; partial с числом не повторяется', async t => {
  for (const [provider, channel] of [['direct', false], ['direct', true], ['onlypult', true]]) {
    await t.test(`${provider}, channelStats=${channel}`, async t => {
      const f = fixture(t, { provider, channel, timezone: 'Asia/Irkutsk', collectHour: 6, at: '2026-09-28T21:59:59Z' });
      assert.deepEqual(await f.stats.collectDue(), [], '05:59:59 местного времени — ещё рано');
      assert.equal(f.source.calls.length, 0);
      f.clock.ms += 1000;
      const first = await f.stats.collectDue();
      assert.deepEqual(first.map(run => [run.date, run.closed, run.status, run.rows]), [['2026-09-29', false, 'partial', 1]]);
      assert.equal(f.source.calls.length, 1, 'нет запросов за вчера или исторического окна Onlypult');
      assert.deepEqual(f.queue(), []);
      f.clock.ms += 8 * HOUR;
      assert.deepEqual(await f.stats.collectDue(), [], 'успех не превращается в часовой опрос');
      f.restart();
      f.clock.ms += 8 * HOUR;
      assert.deepEqual(await f.stats.collectDue(), [], 'перезапуск процесса не забывает сегодняшний замер');
      f.clock.ms = Date.parse('2026-09-29T21:59:59Z');
      assert.deepEqual(await f.stats.collectDue(), [], 'новые сутки ждут свой час сбора');
      f.clock.ms += 1000;
      const next = await f.stats.collectDue();
      assert.deepEqual(next.map(run => [run.date, run.rows]), [['2026-09-30', 1]]);
      assert.deepEqual(f.snapshots().map(row => [row.date, row.value]), [['2026-09-29', 136], ['2026-09-30', 136]]);
      assert.equal(f.source.calls.length, 2);
    });
  }
});

test('настоящий ноль подписчиков считается успешным дневным снимком', async t => {
  for (const [provider, channel] of [['direct', false], ['onlypult', true]]) {
    await t.test(provider, async t => {
      const f = fixture(t, { provider, channel, value: 0 });
      const [run] = await f.stats.collectDue();
      assert.equal(run.rows, 1);
      assert.equal(run.status, 'partial');
      assert.equal(f.snapshots()[0].value, 0);
      f.clock.ms += 4 * HOUR;
      assert.deepEqual(await f.stats.collectDue(), []);
      assert.equal(f.source.calls.length, 1);
      assert.deepEqual(f.queue(), []);
    });
  }
});

test('ручной запрос прошлой даты даёт сегодняшний снимок и сохраняет настоящую историю', async t => {
  for (const [provider, channel] of [['direct', false], ['onlypult', true]]) {
    await t.test(provider, async t => {
      const f = fixture(t, { provider, channel });
      f.stats.importManual('demo-a', { platform: 'telegram', capturedAt: '2026-09-27T08:00:00.000Z',
        sourceNote: 'Синтетический архивный замер', kind: 'unknown',
        rows: [{ date: '2026-09-27', period: 'lifetime', metric: 'followers', value: 120 }] }, { userId: 1 });
      const before = f.snapshots()[0];
      const run = await f.stats.collect('demo-a', 'telegram', { trigger: 'manual', date: '2026-09-27' });
      assert.equal(run.date, '2026-09-27');
      assert.equal(run.closed, true);
      assert.equal(run.rows, 1);
      assert.deepEqual(f.snapshots()[0], before, 'историческая строка не меняет ни число, ни время наблюдения');
      assert.deepEqual(f.snapshots().map(row => [row.date, row.value]), [['2026-09-27', 120], ['2026-09-29', 136]]);
      assert.deepEqual(await f.stats.collectDue(), [], 'планировщик видит сегодняшний успех даже у запуска за прошлую дату');
      assert.equal(f.source.calls.length, 1);
    });
  }
});

test('очистка старой очереди ограничена точными company/platform/accountRef и не меняет историю', async t => {
  const f = fixture(t, { provider: 'onlypult', channel: true });
  seedQueue(f, { date: '2026-09-27' });
  seedQueue(f, { date: '2026-09-28' });
  seedQueue(f, { date: '2026-09-29' });
  seedQueue(f, { code: 'demo-b' });
  seedQueue(f, { platform: 'vk' });
  seedQueue(f, { ref: '@previous_channel' });
  f.stats.writeSnapshots('demo-a', 'telegram', '@demo_channel', [{ date: '2026-09-27', period: 'lifetime',
    metric: 'followers', value: 120, sourceField: 'archive', completeness: 'complete' }],
  { provider: 'manual', tz: 'Asia/Bangkok', collectedAt: '2026-09-27T01:30:00.000Z' });
  const foreign = plain(f.db.prepare(`SELECT * FROM social_collect_queue
    WHERE company_code<>'demo-a' OR platform<>'telegram' OR account_ref<>'@demo_channel' ORDER BY company_code,platform,account_ref`).all());
  const runs = await f.stats.collectDue();
  assert.deepEqual(runs.map(run => run.date), ['2026-09-29']);
  assert.equal(f.source.calls.length, 1, 'старые даты не отправлены в current-snapshot API');
  assert.deepEqual(f.queue(), []);
  assert.deepEqual(plain(f.db.prepare('SELECT * FROM social_collect_queue ORDER BY company_code,platform,account_ref').all()), foreign);
  assert.deepEqual(f.snapshots().map(row => [row.date, row.value]), [['2026-09-27', 120], ['2026-09-29', 136]]);
});

test('временный отказ повторяется с backoff, восстановление завершает серию', async t => {
  for (const [provider, channel] of [['direct', false], ['onlypult', true]]) {
    await t.test(provider, async t => {
      const f = fixture(t, { provider, channel });
      f.source.error = failure('UNAVAILABLE');
      const [first] = await f.stats.collectDue();
      assert.equal(first.status, 'failed');
      assert.equal(first.rows, 0);
      assert.equal(f.queue().length, 1);
      assert.equal(f.queue()[0].date, '2026-09-29');
      assert.equal(f.queue()[0].attempts, 1);
      assert.equal(Date.parse(f.queue()[0].nextAttemptAt) - f.clock.ms, 15 * MINUTE);
      f.clock.ms += 15 * MINUTE - 1;
      assert.deepEqual(await f.stats.collectDue(), []);
      f.clock.ms += 1;
      const [retry] = await f.stats.collectDue();
      assert.equal(retry.status, 'failed');
      assert.equal(f.queue()[0].attempts, 2);
      assert.equal(Date.parse(f.queue()[0].nextAttemptAt) - f.clock.ms, 30 * MINUTE);
      f.source.error = null;
      f.clock.ms += 30 * MINUTE;
      const [recovered] = await f.stats.collectDue();
      assert.equal(recovered.rows, 1);
      assert.equal(recovered.status, 'partial');
      assert.equal(f.source.calls.length, 3);
      assert.deepEqual(f.queue(), []);
      f.clock.ms += HOUR;
      assert.deepEqual(await f.stats.collectDue(), []);
    });
  }
});

test('за день допускается не больше шести автоматических попыток, без новой серии после рестарта', async t => {
  const f = fixture(t, { provider: 'onlypult', channel: true, at: '2026-09-28T23:00:00Z' });
  f.source.error = failure('UNAVAILABLE');
  const delays = [15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 4 * HOUR];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const runs = await f.stats.collectDue();
    assert.equal(runs.length, 1, `попытка ${attempt + 1}`);
    assert.equal(runs[0].status, 'failed');
    assert.equal(f.source.calls.length, attempt + 1);
    if (attempt < delays.length) {
      assert.equal(Date.parse(f.queue()[0].nextAttemptAt) - f.clock.ms, delays[attempt]);
      f.clock.ms += delays[attempt] - 1;
      assert.deepEqual(await f.stats.collectDue(), []);
      f.clock.ms += 1;
    }
  }
  f.clock.ms += 6 * HOUR;
  assert.deepEqual(await f.stats.collectDue(), [], 'седьмого автоматического вызова нет');
  assert.deepEqual(f.queue(), [], 'исчерпанная очередь очищается');
  f.restart();
  f.clock.ms = Date.parse('2026-09-29T16:59:59Z');
  assert.deepEqual(await f.stats.collectDue(), [], 'история неуспешных запусков пережила рестарт');
  assert.equal(f.source.calls.length, 6);
  f.clock.ms = Date.parse('2026-09-29T23:00:00Z');
  assert.equal((await f.stats.collectDue()).length, 1, 'новый локальный день даёт новую ограниченную серию');
  assert.equal(f.source.calls.length, 7);
  assert.equal(f.queue()[0].attempts, 1);
  assert.equal(f.queue()[0].date, '2026-09-30');
});

test('реальный транспорт различает постоянный Telegram 400 и временные 429/503 без раскрытия ответа', async t => {
  for (const errorCode of [400, 401, 403, 429, 503]) {
    await t.test(String(errorCode), async t => {
      const f = fixture(t);
      let calls = 0;
      const transport = createAutopostingTransport(f.db, {
        apiKey: 'TEST_ONLY_ENCRYPTION_KEY', now: () => f.clock.ms,
        fetchImpl: async () => { calls += 1; return new Response(JSON.stringify({ ok: false,
          error_code: errorCode, description: 'PRIVATE_PROVIDER_RESPONSE' }), { status: errorCode }); },
      });
      transport.saveSettings('demo-a', { channels: [{ id: 'telegram', revision: 0, enabled: true,
        target: '@demo_channel', token: '123456789:TEST_ONLY_TELEGRAM_TOKEN_1234567890' }] });
      const stats = createSocialStats(f.db, { now: () => f.clock.ms, logger: { warn() {} },
        adapters: createSocialAdapters({ transport, now: () => f.clock.ms }) });
      const [first] = await stats.collectDue();
      assert.equal(first.status, errorCode < 429 ? 'missing_access' : 'failed');
      assert.ok(!JSON.stringify(first).includes('PRIVATE_PROVIDER_RESPONSE'));
      f.clock.ms += 15 * MINUTE;
      const retry = await stats.collectDue();
      assert.equal(retry.length, errorCode < 429 ? 0 : 1);
      assert.equal(calls, errorCode < 429 ? 1 : 2);
    });
  }
});

test('missing_access не опрашивается повторно в те же сутки; новая ревизия возобновляет сбор', async t => {
  for (const [provider, channel] of [['direct', false], ['onlypult', true]]) {
    await t.test(provider, async t => {
      const f = fixture(t, { provider, channel });
      f.source.error = failure(channel ? 'NO_BINDING' : 'ACCESS_DENIED');
      const [first] = await f.stats.collectDue();
      assert.equal(first.status, 'missing_access');
      assert.deepEqual(f.queue(), []);
      f.source.error = null;
      for (const delta of [HOUR, 2 * HOUR]) {
        f.clock.ms += delta;
        assert.deepEqual(await f.stats.collectDue(), [], 'не повторяем постоянный отказ в те же сутки');
      }
      assert.equal(f.source.calls.length, 1);
      f.restart();
      assert.deepEqual(await f.stats.collectDue(), []);
      if (channel) f.save({ displayLabel: 'Привязка перепроверена' });
      else f.source.revision += 1;
      const [restored] = await f.stats.collectDue();
      assert.equal(restored.rows, 1, 'новая ревизия разблокировала сбор');
      assert.equal(f.source.calls.length, 2);
    });
  }
});

test('после missing_access новые сутки проверяют восстановление внешних прав без смены настройки', async t => {
  for (const [provider, channel] of [['direct', false], ['onlypult', true]]) {
    await t.test(provider, async t => {
      const f = fixture(t, { provider, channel });
      f.source.error = failure(channel ? 'NO_BINDING' : 'ACCESS_DENIED');
      assert.equal((await f.stats.collectDue())[0].status, 'missing_access');
      f.source.error = null;
      f.clock.ms += DAY;
      f.restart();
      assert.equal((await f.stats.collectDue())[0].rows, 1);
      assert.equal(f.source.calls.length, 2);
      assert.deepEqual(await f.stats.collectDue(), []);
    });
  }
});

test('ручной импорт до замера не закрывает день, после принятого замера не вызывает второй API-запрос', async t => {
  for (const [provider, channel] of [['direct', false], ['onlypult', true]]) {
    await t.test(provider, async t => {
      const f = fixture(t, { provider, channel });
      const imported = value => f.stats.importManual('demo-a', { platform: 'telegram',
        capturedAt: new Date(f.clock.ms - 1000).toISOString(), sourceNote: 'Синтетический ручной снимок',
        rows: [{ date: '2026-09-29', period: 'lifetime', metric: 'followers', value }] });
      imported(130);
      assert.equal((await f.stats.collectDue())[0].rows, 1);
      f.clock.ms += HOUR;
      imported(140);
      f.clock.ms += HOUR;
      f.restart();
      assert.deepEqual(await f.stats.collectDue(), []);
      assert.equal(f.source.calls.length, 1);
      assert.equal(f.snapshots()[0].value, 140);
    });
  }
});

test('принятый снимок переживает остановку между фиксацией проекции и завершением журнала', async t => {
  const f = fixture(t);
  const [accepted] = await f.stats.collectDue();
  f.db.prepare("UPDATE social_collect_runs SET status='failed',rows=0,finished_at=NULL WHERE id=?").run(accepted.runId);
  f.clock.ms += HOUR;
  f.restart();
  assert.deepEqual(await f.stats.collectDue(), []);
  assert.equal(f.source.calls.length, 1);
});

test('миграция сохраняет подтверждённый старый снимок при последующем ручном импорте', async t => {
  const f = fixture(t);
  await f.stats.collectDue();
  f.db.exec('ALTER TABLE social_collect_runs DROP COLUMN snapshot_date; ALTER TABLE social_collect_runs DROP COLUMN snapshot_timezone;');
  f.restart();
  f.clock.ms += HOUR;
  f.stats.importManual('demo-a', { platform: 'telegram', capturedAt: new Date(f.clock.ms).toISOString(),
    sourceNote: 'Синтетическое уточнение', rows: [{ date: '2026-09-29', period: 'lifetime', metric: 'followers', value: 140 }] });
  f.clock.ms += HOUR;
  f.restart();
  assert.deepEqual(await f.stats.collectDue(), []);
  assert.equal(f.source.calls.length, 1);
});

test('смена accountRef, ревизии подключения или timezone разрешает новый замер без переноса старого', async t => {
  for (const change of ['account', 'connection', 'timezone']) {
    await t.test(change, async t => {
      const f = fixture(t, { at: '2026-09-29T08:00:00Z' });
      await f.stats.collectDue();
      f.source.value = 200;
      if (change === 'account') { f.source.ref = '@next_channel'; f.save({ accountRef: f.source.ref }); }
      if (change === 'connection') f.source.revision += 1;
      if (change === 'timezone') f.save({ timezone: 'UTC' });
      const next = await f.stats.collectDue();
      assert.equal(next.length, 1);
      assert.equal(next[0].rows, 1);
      assert.equal(f.source.calls.length, 2);
      assert.deepEqual(await f.stats.collectDue(), []);
      if (change === 'timezone') assert.deepEqual(f.snapshots().map(row => [row.timezone, row.value]), [['Asia/Bangkok', 136], ['UTC', 200]]);
      if (change === 'account') assert.deepEqual(plain(f.db.prepare('SELECT account_ref,value FROM social_snapshots ORDER BY account_ref').all()),
        [{ account_ref: '@demo_channel', value: 136 }, { account_ref: '@next_channel', value: 200 }]);
    });
  }
});

test('изменённые во время запроса ревизия и timezone не принимают старый ответ', async t => {
  for (const change of ['connection', 'timezone']) {
    await t.test(change, async t => {
      const f = fixture(t, { at: '2026-09-29T08:00:00Z' });
      let release;
      f.source.handler = () => new Promise(resolve => { release = () => resolve({ provider: 'direct', target: '@demo_channel', result: 136 }); });
      const pending = f.stats.collectDue();
      await tick();
      assert.equal(typeof release, 'function');
      if (change === 'connection') f.source.revision += 1;
      else f.save({ timezone: 'UTC' });
      release();
      const [stale] = await pending;
      assert.equal(stale.rows, 0);
      assert.equal(stale.status, 'failed');
      assert.deepEqual(f.snapshots(), []);
      f.source.handler = null;
      const [fresh] = await f.stats.collectDue();
      assert.equal(fresh.rows, 1, 'новая привязка не задерживается очередью старой');
    });
  }
});

test('ответ после полуночи сохраняет день начала наблюдения, следующий день имеет отдельный снимок', async t => {
  const f = fixture(t, { provider: 'onlypult', channel: true, timezone: 'Asia/Irkutsk', at: '2026-09-29T15:59:50Z' });
  let release;
  f.source.handler = ({ code }) => new Promise(resolve => { release = () => resolve({ companyCode: code,
    accountRef: '@demo_channel', value: 136, observedAt: '2026-09-29T16:00:05.000Z', source: 'getChatMemberCount' }); });
  const pending = f.stats.collectDue();
  await tick();
  f.clock.ms = Date.parse('2026-09-29T16:00:05Z');
  release();
  const [run] = await pending;
  assert.equal(run.rows, 1);
  assert.deepEqual(f.snapshots(), [{ date: '2026-09-29', value: 136, timezone: 'Asia/Irkutsk', collected_at: '2026-09-29T15:59:50.000Z' }]);
  assert.deepEqual(await f.stats.collectDue(), [], '00:00 новых суток — ещё до часа сбора');
  f.source.handler = null;
  f.source.value = 137;
  f.clock.ms = Date.parse('2026-09-29T22:00:00Z');
  assert.equal((await f.stats.collectDue())[0].rows, 1);
  assert.deepEqual(f.snapshots().map(row => [row.date, row.value]), [['2026-09-29', 136], ['2026-09-30', 137]]);
});

test('partial с rows=0 не закрывает день; запись без успешного run_id не подменяет успех', async t => {
  const f = fixture(t);
  // Уже есть более поздняя проекция, не подтверждённая автоматическим запуском.
  // Защита порядка отклоняет первую запись, но это ещё не успешный сбор расписания.
  f.stats.writeSnapshots('demo-a', 'telegram', '@demo_channel', [{ date: '2026-09-29', period: 'lifetime',
    metric: 'followers', value: 120, sourceField: 'getChatMemberCount', completeness: 'complete' }],
  { provider: 'direct', tz: 'Asia/Bangkok', collectedAt: new Date(f.clock.ms + MINUTE).toISOString() });
  const [discarded] = await f.stats.collectDue();
  assert.equal(discarded.rows, 0);
  assert.equal(discarded.status, 'partial');
  assert.equal(f.snapshots()[0].value, 120);
  assert.deepEqual(await f.stats.collectDue(), [], 'пустой ответ не вызывает тесный цикл');
  f.clock.ms += 15 * MINUTE;
  const [accepted] = await f.stats.collectDue();
  assert.equal(accepted.rows, 1, 'день не был ошибочно закрыт пустым запуском');
  assert.equal(f.snapshots()[0].value, 136);
  assert.equal(f.source.calls.length, 2);
  f.clock.ms += HOUR;
  assert.deepEqual(await f.stats.collectDue(), []);
});

test('нечисловой ответ Telegram не считается успешным нулём и остаётся повторяемым', async t => {
  const f = fixture(t, { value: null });
  const [first] = await f.stats.collectDue();
  assert.equal(first.status, 'failed');
  assert.equal(first.rows, 0);
  assert.deepEqual(f.snapshots(), []);
  assert.equal(f.queue().length, 1);
  f.source.value = 0;
  f.clock.ms += 15 * MINUTE;
  const [next] = await f.stats.collectDue();
  assert.equal(next.rows, 1);
  assert.equal(f.snapshots()[0].value, 0);
});

test('суточный ВКонтакте сохраняет часовой текущий день и итог за вчера после collectHour', async t => {
  const f = fixture(t, { collectHour: 9 });
  f.save({ enabled: false });
  f.save({ accountRef: 'club1', provider: 'direct', collectHour: 9 }, 'demo-a', 'vk');
  f.source.handler = ({ method }) => method === 'groups.getById'
    ? { provider: 'direct', target: '1', result: { groups: [{ id: 1, members_count: 50 }] } }
    : { provider: 'direct', target: '1', result: [{ visitors: { views: 10 }, reach: { reach: 8 }, activity: {} }] };
  const early = await f.stats.collectDue();
  assert.deepEqual(early.map(run => [run.date, run.closed, run.status]), [['2026-09-29', false, 'partial']]);
  f.clock.ms = Date.parse('2026-09-29T02:00:00Z');
  const morning = await f.stats.collectDue();
  assert.deepEqual(morning.map(run => [run.date, run.closed, run.status]), [['2026-09-28', true, 'ok']]);
  f.clock.ms = Date.parse('2026-09-29T02:30:00Z');
  const hourly = await f.stats.collectDue();
  assert.deepEqual(hourly.map(run => [run.date, run.closed, run.status]), [['2026-09-29', false, 'partial']]);
  assert.deepEqual(plain(f.db.prepare("SELECT date,completeness FROM social_snapshots WHERE platform='vk' AND metric='views' ORDER BY date").all()),
    [{ date: '2026-09-28', completeness: 'complete' }, { date: '2026-09-29', completeness: 'partial' }]);
});

test('суточный Onlypult продолжает перепроверять историю, Telegram не наследует эту политику', async t => {
  const calls = [];
  const analytics = {
    credentials: { get: () => ({ configured: true, checked: true }), connectionRevision: () => ({ revision: 1 }) },
    collector: {
      listProfiles: async () => ({ profiles: [{ id: 'an_demo', platform: 'instagram', nativeAccountId: 'demo_instagram' }] }),
      collectDay: async ({ from }) => {
        calls.push(from);
        return { status: 'ok', measurements: [{ date: from, period: 'day', metric: 'views', value: 10,
          completeness: 'complete', sourceField: 'views' }], missing: [] };
      },
    },
  };
  const f = fixture(t, { provider: 'onlypult', channel: true, analytics });
  f.save({ accountRef: 'demo_instagram', provider: 'onlypult', providerRef: 'an_demo' }, 'demo-a', 'instagram');
  await f.stats.collect('demo-a', 'instagram', { date: '2026-09-27' });
  f.clock.ms += DAY;
  calls.length = 0;
  const runs = await f.stats.collectDue();
  assert.ok(calls.includes('2026-09-27'), 'закрытая история Onlypult по-прежнему перепроверяется');
  assert.ok(calls.includes('2026-09-29'), 'суточный итог за вчера сохранён');
  assert.ok(calls.includes('2026-09-30'), 'текущий день Onlypult сохранён');
  assert.deepEqual(runs.filter(run => run.platform === 'telegram').map(run => run.date), ['2026-09-30']);
  assert.equal(f.source.calls.length, 1, 'Telegram спросили только за текущий день');
});

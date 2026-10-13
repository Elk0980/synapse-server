'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {createSocialMaxBackfill} = require('./social-max-backfill');
const {createSocialMaxIndex}=require('./social-max-index');

const CODE = 'alvi', CHAT = '-1000000000000000123', TZ = 'Asia/Irkutsk';
const NOW = Date.parse('2026-10-13T12:00:00Z'), AT = '2026-10-13T12:00:00.000Z', HOUR = 3600000;
const PII = ['Иван', '79990001122', 'example.invalid', 'Звоните'];

test('возобновлённая probe отмечает исчезнувшие native IDs границы, а не забывает проверку',async t=>{
 const f=fixture(t,series(210),{maxPages:1,hook:({query,envelope,code})=>query.after>0?envelope(code,[]):undefined});
 accept(f,await step(f));assert.equal(f.backfill.coverage(CODE,CHAT).phase,'probe');
 accept(f,await step(f));
 assert.ok(f.backfill.coverage(CODE,CHAT).gaps.some(g=>g.kind==='inconsistent_boundary'));
 assert.equal(indexedIds(f).length,100);
});
test('испорченное сохранённое время показывает unknown и не начинает новый обход',async t=>{
 const f=fixture(t,series(210),{maxPages:1});accept(f,await step(f));
 f.db.prepare("UPDATE social_max_backfill_state SET upper_ms='broken'").run();
 const before=f.calls.length,result=await step(f);
 assert.equal(result.prepared,null);assert.equal(result.coverage.phase,'corrupt');assert.equal(f.calls.length,before);
});

function raw(post) {
  return {recipient: {chat_id: post.chat ?? CHAT, chat_type: 'channel'}, timestamp: post.ts,
    body: post.mid === null ? null : {mid: post.mid, text: 'Звоните +79990001122'},
    stat: 'stat' in post ? post.stat : {views: post.views ?? 7},
    sender: {user_id: 42, name: 'Иван Петров'}, link: {url: 'https://example.invalid/private'}};
}
// Мок GET /messages: обратный порядок, ничьи по mid, включительность границ задаётся явно.
function pageOf(posts, {after, before, count}, o) {
  const inside = (ts) => (o.afterInclusive ? ts >= after : ts > after) && (o.beforeInclusive ? ts <= before : ts < before);
  return posts.filter((post) => inside(post.ts))
    .sort((a, b) => b.ts - a.ts || (String(a.mid) < String(b.mid) ? -1 : 1)).slice(0, count).map(raw);
}
function world(posts, o = {}) {
  const state = {ok: true, chatId: CHAT, accountRef: CHAT, accessRevision: 1};
  const clock = {ms: NOW}, calls = [], box = {posts};
  const envelope = (code, messages, extra = {}) => ({companyCode: code, chatId: state.chatId, accessRevision: state.accessRevision,
    observedAtISO: new Date(clock.ms).toISOString(), data: {messages}, ...extra});
  const access = {
    ready: () => ({...state, reason: ''}),
    bindingFingerprint: () => `max_analytics:${state.accessRevision}:${state.chatId}:${state.accountRef}:confirmed`,
    async readMessages(code, query, {signal} = {}) {
      calls.push({...query});
      if (o.hook) {
        const special = await o.hook({code, query, signal, call: calls.length, state, clock, envelope, page: () => pageOf(box.posts, query, o)});
        if (special !== undefined) return special;
      }
      return envelope(code, pageOf(box.posts, query, o));
    },
  };
  return {access, state, clock, calls, box, envelope};
}
function fixture(t, posts, o = {}) {
  const db = new DatabaseSync(o.file || ':memory:');
  const w = world(posts, o);
  const index = createSocialMaxIndex(db);
  const backfill = createSocialMaxBackfill(db, {access: w.access, now: () => w.clock.ms,
    maxPages: o.maxPages ?? 3, deadlineMs: o.deadlineMs ?? 20000});
  const f = {db, index, backfill, ...w, closed: false};
  f.close = async () => { if (f.closed) return; f.closed = true; await backfill.stop(); db.close(); };
  t.after(() => f.close());
  return f;
}
const step = (f, extra = {}) => f.backfill.collectStep({companyCode: CODE, timezone: TZ, ...extra});
function accept(f, result, runId = 1) {
  f.db.exec('BEGIN IMMEDIATE');
  try {
    f.index.commit(f.index.prepare(CODE, CHAT, result.posts), {runId, collectedAt: AT});
    const out = f.backfill.commit(result.prepared, {runId, collectedAt: AT});
    f.db.exec('COMMIT');
    return out;
  } catch (error) { f.db.exec('ROLLBACK'); throw error; }
}
async function drain(f, limit = 40) {
  for (let commits = 0; commits <= limit; commits += 1) {
    const result = await step(f);
    if (!result.prepared) return {commits, last: result};
    accept(f, result, commits + 1);
    f.clock.ms += 60000;
  }
  throw new Error('обход не завершился в пределах циклов');
}
const indexedIds = (f) => f.db.prepare('SELECT native_post_id FROM social_max_post_index ORDER BY native_post_id').all().map((r) => r.native_post_id);
const changes = (f) => Number(f.db.prepare('SELECT total_changes() AS n').get().n);
const id = (i) => `mid.p${String(i).padStart(4, '0')}`;
// Часовой ряд; посты from..to получают одно время и расходятся по стыку страниц.
function series(n, tie = null) {
  const start = Date.parse('2025-01-01T00:00:00Z');
  const posts = Array.from({length: n}, (_, i) => ({mid: id(i), ts: start + i * HOUR}));
  if (tie) for (let i = tie[0]; i <= tie[1]; i += 1) posts[i].ts = posts[tie[0]].ts;
  return posts;
}

test('несколько плановых циклов проходят >300 старых постов без потери ничьих при любой включительности', async (t) => {
  for (const semantics of [{}, {beforeInclusive: true, afterInclusive: true}, {beforeInclusive: true}, {afterInclusive: true}]) {
    const posts = series(350, [247, 252]);
    const f = fixture(t, posts, semantics);
    const {commits, last} = await drain(f);
    assert.ok(commits >= 3, `циклов ${commits}`);
    assert.deepEqual(indexedIds(f), posts.map((post) => post.mid).sort());
    const cover = f.backfill.coverage(CODE, CHAT);
    assert.equal(cover.status, 'partial'); assert.equal(cover.postIndex, 'partial'); assert.equal(cover.historyComplete, false);
    assert.equal(cover.phase, 'done'); assert.equal(cover.tailEnumerated, 'short_page_unverified');
    assert.deepEqual(cover.gaps, []); assert.equal(cover.boundToCurrentAccess, true);
    assert.equal(last.prepared, null); assert.equal(last.posts.length, 0);
    assert.ok(f.calls.every((query) => query.after >= 0 && query.before >= 0 && query.count === 100 && Object.keys(query).length === 3));
    await f.close();
  }
});

test('lifetime просмотры датируются днём наблюдения, повтор не суммируется и старое наблюдение не перезаписывает новое', async (t) => {
  const posts = series(105);
  const boundary = posts[5].mid;
  // Проба приходит с более старым наблюдением и другим числом: остаётся значение листинга.
  const older = fixture(t, posts, {hook: ({query, envelope, code, page, clock}) => (query.after > 0
    ? envelope(code, page().map((m) => ({...m, stat: {views: 3}})), {observedAtISO: new Date(clock.ms - 1000).toISOString()}) : undefined)});
  const first = await step(older);
  const post = first.posts.find((item) => item.platformPostId === boundary);
  assert.deepEqual(post.metrics, [{date: '2026-10-13', period: 'lifetime', metric: 'views', value: 7,
    sourceField: 'MAX.Message.stat.views', completeness: 'complete'}]);
  assert.equal(new Set(first.posts.map((item) => item.platformPostId)).size, first.posts.length);
  // Более новое наблюдение заменяет значение, но не складывается с ним.
  const newer = fixture(t, posts, {hook: ({query, envelope, code, page, clock}) => {
    if (query.after === 0) return undefined;
    clock.ms += 1000;
    return envelope(code, page().map((m) => ({...m, stat: {views: 9}})));
  }});
  const second = await step(newer);
  assert.equal(second.posts.find((item) => item.platformPostId === boundary).metrics[0].value, 9);
});

test('состояние переживает закрытие и повторное открытие SQLite, обход продолжается с сохранённого курсора', async (t) => {
  const file = path.join(os.tmpdir(), `max-backfill-${process.pid}-${Date.now()}.sqlite`);
  const opened = [];
  // Файл удаляется только после закрытия обеих баз: на Windows открытый файл не удаляется.
  t.after(async () => {
    for (const f of opened) await f.close();
    assert.equal(path.dirname(path.resolve(file)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(file).startsWith('max-backfill-'));
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const target=file+suffix;
      if(fs.existsSync(target)){assert.equal(fs.lstatSync(target).isSymbolicLink(),false);fs.rmSync(target);}
    }
  });
  const posts = series(350, [247, 252]);
  const one = fixture(t, posts, {file});
  opened.push(one);
  accept(one, await step(one));
  const before = one.backfill.coverage(CODE, CHAT);
  assert.equal(before.stateRevision, 1); assert.notEqual(before.phase, 'done');
  await one.close();

  const two = fixture(t, posts, {file});
  opened.push(two);
  const reopened = two.backfill.coverage(CODE, CHAT);
  assert.deepEqual({...reopened, boundToCurrentAccess: null}, {...before, boundToCurrentAccess: null});
  await drain(two);
  assert.equal(indexedIds(two).length, 350);
  const after = two.backfill.coverage(CODE, CHAT);
  assert.equal(after.phase, 'done'); assert.equal(after.pagesTotal, 7); assert.equal(after.upperBound, before.upperBound);
  // Первый запрос после открытия продолжает с курсора, а не с верхней границы.
  assert.notEqual(two.calls[0].before, Date.parse(before.upperBound));
  await two.close();
});

test('бюджет между листингом и пробой сохраняет фазу: проба выполняется следующим запуском, посты-ничьи не теряются', async (t) => {
  const posts = series(150, [47, 52]);
  const f = fixture(t, posts, {maxPages: 1});
  const first = await step(f);
  assert.equal(first.coverage.pendingStep.phase, 'probe'); assert.equal(first.retryable, false);
  assert.match(first.missing[0], /пределе страниц/);
  accept(f, first);
  const tie = posts[47].ts;
  assert.equal(f.backfill.coverage(CODE, CHAT).probeAt, new Date(tie).toISOString());
  await step(f).then((result) => accept(f, result, 2));
  assert.deepEqual(f.calls[1], {after: tie - 1, before: tie + 1, count: 100});
  await drain(f);
  assert.deepEqual(indexedIds(f), posts.map((post) => post.mid).sort());
});

test('≥100 постов на одной отметке: пробел сохраняется, обход идёт к старой истории; новый доступ и хороший ответ пробел не снимают', async (t) => {
  const D = Date.parse('2025-06-01T00:00:00Z');
  const newer = Array.from({length: 20}, (_, i) => ({mid: `mid.n${String(i).padStart(3, '0')}`, ts: D + (i + 1) * HOUR}));
  const dense = Array.from({length: 150}, (_, i) => ({mid: `mid.d${String(i).padStart(3, '0')}`, ts: D}));
  const older = Array.from({length: 50}, (_, i) => ({mid: `mid.o${String(i).padStart(3, '0')}`, ts: D - (i + 1) * HOUR}));
  const f = fixture(t, [...newer, ...dense, ...older]);
  const {commits} = await drain(f);
  assert.ok(commits <= 3);
  const cover = f.backfill.coverage(CODE, CHAT);
  assert.deepEqual(cover.gaps, [{pass: 1, kind: 'dense_timestamp', from: new Date(D - 1).toISOString(), to: new Date(D).toISOString(), count: 1}]);
  assert.equal(cover.phase, 'done'); assert.equal(cover.status, 'partial'); assert.notEqual(cover.tailEnumerated, 'complete');
  const ids = indexedIds(f);
  for (const post of older) assert.ok(ids.includes(post.mid));
  // Новый credential того же канала: новый проход, прежние пробелы, свидетельства и индекс сохраняются.
  f.state.accessRevision = 2;
  f.box.posts = [...newer, ...dense.slice(0, 40), ...older];
  assert.equal(f.backfill.coverage(CODE, CHAT).boundToCurrentAccess, false);
  await drain(f);
  const next = f.backfill.coverage(CODE, CHAT);
  assert.equal(next.pass, 2); assert.equal(next.boundToCurrentAccess, true);
  assert.ok(next.gaps.some((item) => item.pass === 1 && item.kind === 'dense_timestamp'));
  assert.ok(!next.gaps.some((item) => item.pass === 2));
  assert.equal(next.previousPasses[0].pass, 1); assert.equal(next.previousPasses[0].coveredFrom, new Date(0).toISOString());
  assert.ok(indexedIds(f).length >= ids.length);
});

test('чужой получатель даже с body:null, чужая ревизия и смена аккаунта во время сети отклоняют шаг целиком', async (t) => {
  const posts = series(20);
  const foreign = fixture(t, posts, {hook: ({envelope, code}) => envelope(code,
    [{...raw({mid: null, ts: 10}), timestamp: -1}, raw({mid: null, ts: 5, chat: '-5'})])});
  const a = await step(foreign);
  assert.equal(a.status, 'missing_access'); assert.equal(a.prepared, null); assert.deepEqual(a.posts, []);
  assert.match(a.missing[0], /не из подтверждённого канала/);

  const revision = fixture(t, posts, {hook: ({envelope, code, page}) => envelope(code, page(), {accessRevision: 99})});
  assert.equal((await step(revision)).status, 'missing_access');

  const account = fixture(t, posts, {hook: ({state}) => { state.accountRef = '-77'; }});
  const c = await step(account);
  assert.equal(c.status, 'missing_access'); assert.equal(c.prepared, null);

  const denied = fixture(t, posts, {hook: () => { throw Object.assign(new Error('x'), {code: 'ACCESS_DENIED'}); }});
  assert.equal((await step(denied)).status, 'missing_access');
  for (const f of [foreign, revision, account, denied]) assert.equal(changes(f), 0);
});

test('поздний кандидат и шаг после смены привязки не двигают курсор', async (t) => {
  const f = fixture(t, series(350));
  const r1 = await step(f), r2 = await step(f);
  accept(f, r1);
  assert.throws(() => accept(f, r2), {code: 'MAX_BACKFILL_STALE'});
  assert.equal(f.backfill.coverage(CODE, CHAT).stateRevision, 1);
  const r3 = await step(f);
  f.state.accountRef = '-77';
  assert.throws(() => accept(f, r3), {code: 'MAX_BACKFILL_STALE'});
  f.state.accountRef = CHAT;
  accept(f, r3, 3);
  assert.equal(f.backfill.coverage(CODE, CHAT).stateRevision, 2);
});

test('collectStep не пишет в базу; commit только в транзакции, своим токеном и после записи индекса', async (t) => {
  const f = fixture(t, series(150));
  const before = changes(f);
  const result = await step(f);
  assert.equal(changes(f), before);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM social_max_backfill_state').get().n, 0);
  assert.equal(f.backfill.coverage(CODE, CHAT).phase, 'not_started');
  assert.ok(result.prepared && Object.keys(result.prepared).length === 0 && Object.isFrozen(result.prepared));
  assert.throws(() => f.backfill.commit(result.prepared, {runId: 1, collectedAt: AT}), {code: 'MAX_BACKFILL_TRANSACTION'});
  const other = createSocialMaxBackfill(f.db, {access: f.access, now: () => f.clock.ms});
  f.db.exec('BEGIN IMMEDIATE');
  assert.throws(() => other.commit(result.prepared, {runId: 1, collectedAt: AT}), {code: 'MAX_BACKFILL_TOKEN'});
  assert.throws(() => f.backfill.commit({}, {runId: 1, collectedAt: AT}), {code: 'MAX_BACKFILL_TOKEN'});
  assert.throws(() => f.backfill.commit(result.prepared, {runId: 1, collectedAt: AT}), {code: 'MAX_BACKFILL_INDEX'});
  assert.throws(() => f.backfill.commit(result.prepared, {runId: 1.5, collectedAt: AT}), {code: 'MAX_BACKFILL_CONTEXT'});
  f.db.exec('ROLLBACK');
  await assert.rejects(f.backfill.collectStep({companyCode: CODE, timezone: TZ, date: '2026-10-13'}), {code: 'BAD_REQUEST'});
  await other.stop();
});

test('откат транзакции Root откатывает курсор; повтор того же шага проходит CAS один раз', async (t) => {
  const f = fixture(t, series(350));
  const result = await step(f);
  f.db.exec('BEGIN IMMEDIATE');
  f.index.commit(f.index.prepare(CODE, CHAT, result.posts), {runId: 1, collectedAt: AT});
  f.backfill.commit(result.prepared, {runId: 1, collectedAt: AT});
  f.db.exec('ROLLBACK');
  assert.equal(f.backfill.coverage(CODE, CHAT).phase, 'not_started'); assert.equal(indexedIds(f).length, 0);
  assert.deepEqual(accept(f, result), {pass: 1, phase: result.coverage.pendingStep.phase, stateRevision: 1});
  assert.throws(() => accept(f, result), {code: 'MAX_BACKFILL_STALE'});
  assert.equal(f.backfill.coverage(CODE, CHAT).stateRevision, 1);
});

test('отмена, срок и остановка прекращают весь шаг; поздний результат не принимается', async (t) => {
  const hang = () => new Promise(() => {});
  const aborted = fixture(t, series(150), {hook: hang});
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(step(aborted, {signal: controller.signal}), {code: 'ABORTED'});
  assert.equal(aborted.calls.length, 1); assert.equal(changes(aborted), 0);

  const late = fixture(t, series(150), {deadlineMs: 50, hook: ({call}) => (call > 1 ? hang() : undefined)});
  const partial = await step(late);
  assert.equal(late.calls.length, 2); assert.equal(partial.retryable, true);
  assert.equal(partial.posts.length, 100); assert.equal(partial.coverage.pendingStep.phase, 'probe');
  assert.match(partial.missing[0], /не уложился в срок/);
  accept(late, partial);
  assert.equal(late.backfill.coverage(CODE, CHAT).phase, 'probe');

  const control = {hang: false};
  const stopped = fixture(t, series(150), {hook: () => (control.hang ? hang() : undefined)});
  const ready = await step(stopped);
  control.hang = true;
  const pending = step(stopped);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await stopped.backfill.stop();
  await assert.rejects(pending, {code: 'STOPPED'});
  await assert.rejects(step(stopped), {code: 'STOPPED'});
  stopped.db.exec('BEGIN IMMEDIATE');
  assert.throws(() => stopped.backfill.commit(ready.prepared, {runId: 1, collectedAt: AT}), {code: 'STOPPED'});
  stopped.db.exec('ROLLBACK');
});

test('нет stat/views — неизвестность, не ноль; body:null и конфликт времени mid — пробелы; PII не выходит и не пишется', async (t) => {
  const posts = [{mid: 'mid.a', ts: 1000 * HOUR, stat: null}, {mid: 'mid.b', ts: 999 * HOUR, stat: {}},
    {mid: 'mid.c', ts: 998 * HOUR, views: 5}, {mid: 'mid.bad', ts: 997 * HOUR, stat: {views: -1}},
    {mid: null, ts: 996 * HOUR}, {mid: 'mid.dup', ts: 995 * HOUR}, {mid: 'mid.dup', ts: 994 * HOUR}];
  const f = fixture(t, posts);
  const result = await step(f);
  const byId = Object.fromEntries(result.posts.map((post) => [post.platformPostId, post.metrics[0]]));
  assert.deepEqual(Object.keys(byId).sort(), ['mid.a', 'mid.b', 'mid.bad', 'mid.c']);
  for (const key of ['mid.a', 'mid.b', 'mid.bad']) { assert.equal(byId[key].value, null); assert.equal(byId[key].completeness, 'partial'); }
  assert.equal(byId['mid.c'].value, 5);
  assert.ok(result.missing.some((note) => /у 2 постов MAX не вернул stat.views/.test(note)));
  assert.ok(result.missing.some((note) => /у 1 постов stat.views пришёл в недопустимом виде/.test(note)));
  assert.ok(result.missing.some((note) => /охват, реакции и репосты/.test(note)));
  accept(f, result);
  const kinds = f.backfill.coverage(CODE, CHAT).gaps.map((item) => item.kind).sort();
  assert.deepEqual(kinds, ['identity_conflict', 'unidentified_message']);
  const dump = JSON.stringify([result, f.backfill.coverage(CODE, CHAT),
    ...['social_max_backfill_state', 'social_max_backfill_gaps', 'social_max_post_index'].map((table) => f.db.prepare(`SELECT * FROM ${table}`).all())]);
  for (const secret of PII) assert.ok(!dump.includes(secret), secret);
  assert.ok(!dump.includes('max_analytics:'));
  // Индекс уже знает mid.c с другим временем: новый ответ его не переписывает, пост отклоняется.
  const g = fixture(t, [{mid: 'mid.c', ts: 500 * HOUR}]);
  g.db.exec('BEGIN IMMEDIATE');
  g.index.commit(g.index.prepare(CODE, CHAT, [{platformPostId: 'mid.c', publishedAt: new Date(998 * HOUR).toISOString()}]), {collectedAt: AT});
  g.db.exec('COMMIT');
  const conflicted = await step(g);
  assert.deepEqual(conflicted.posts, []);
  accept(g, conflicted);
  assert.equal(g.backfill.coverage(CODE, CHAT).gaps[0].kind, 'identity_conflict');
});

test('время наблюдения: будущее вне допуска и интервал вне before отклоняют страницу; в пределах допуска день не уходит вперёд', async (t) => {
  const posts = series(10);
  const future = fixture(t, posts, {hook: ({envelope, code, page, clock}) => envelope(code, page(), {observedAtISO: new Date(clock.ms + 10 * 60000).toISOString()})});
  const a = await step(future);
  assert.equal(a.prepared, null); assert.equal(a.retryable, true); assert.deepEqual(a.posts, []);
  const mismatch = fixture(t, posts, {hook: ({envelope, code, page, clock}) => envelope(code, page(), {observedAt: new Date(clock.ms - 1).toISOString()})});
  assert.equal((await step(mismatch)).prepared, null);
  const outside = fixture(t, posts, {hook: ({envelope, code, query}) => envelope(code, [raw({mid: 'mid.x', ts: query.before + 5})])});
  const b = await step(outside);
  assert.equal(b.prepared, null); assert.equal(b.retryable, false); assert.match(b.missing[0], /вне запрошенного интервала/);
  // 23:59 по Иркутску, ответ датирован 00:01 следующего дня в пределах допуска часов.
  const edge = fixture(t, posts, {hook: ({envelope, code, page, clock}) => envelope(code, page(), {observedAtISO: new Date(clock.ms + 2 * 60000).toISOString()})});
  edge.clock.ms = Date.parse('2026-10-13T15:59:00Z');
  const c = await step(edge);
  assert.ok(c.posts.length && c.posts.every((post) => post.metrics[0].date === '2026-10-13'));
});

test('T=0: обход не уходит в отрицательные границы, начало истории остаётся неподтверждённым пробелом', async (t) => {
  const posts = Array.from({length: 100}, (_, i) => ({mid: `mid.e${String(i).padStart(3, '0')}`, ts: i}));
  const inclusive = fixture(t, posts, {beforeInclusive: true, afterInclusive: true});
  await drain(inclusive);
  const cover = inclusive.backfill.coverage(CODE, CHAT);
  assert.equal(cover.tailEnumerated, 'epoch_reached_unverified'); assert.equal(cover.status, 'partial');
  assert.ok(cover.gaps.some((item) => item.kind === 'epoch_boundary' && item.from === new Date(0).toISOString()));
  assert.ok(inclusive.calls.every((query) => query.after >= 0 && query.before >= 0));
  assert.deepEqual(inclusive.calls[1], {after: 0, before: 1, count: 100});
  assert.equal(indexedIds(inclusive).length, 100);
  // Исключающий after:0 теряет пост ровно в 0 мс: охват этого не скрывает.
  const exclusive = fixture(t, posts);
  await drain(exclusive);
  const loose = exclusive.backfill.coverage(CODE, CHAT);
  assert.equal(indexedIds(exclusive).length, 99); assert.equal(loose.tailEnumerated, 'short_page_unverified');
  assert.ok(loose.uncertainty.some((note) => /ровно 0 мс/.test(note)));
});

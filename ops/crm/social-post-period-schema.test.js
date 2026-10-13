'use strict';
/* Совместимый откат ключа показателей публикаций: прежний писатель ON CONFLICT(post_id,date,metric) работает после отката,
   все day/lifetime/unknown строки лежат в неизменяемом архиве, возврат вперёд восстанавливает их точно и добавляет реальные
   записи прежнего писателя, не выдумывая наблюдений из синтетической проекции. Компании, посты и числа вымышленные. */
const test = require('node:test'), assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ensureSocialPostPeriodSchema: ensure, rollbackSocialPostPeriodSchema: rollback, MIXED_SOURCE, TABLES } = require('./social-post-period-schema');

// DDL как в social-stats.js: прежняя таблица до миграции периода и новая после неё.
const COLUMNS = `post_id INTEGER NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE, date TEXT NOT NULL, metric TEXT NOT NULL, value REAL, unit TEXT NOT NULL,
  source_field TEXT NOT NULL DEFAULT '', completeness TEXT NOT NULL DEFAULT 'unknown', provider TEXT NOT NULL, collected_at TEXT NOT NULL, run_id INTEGER`;
const OLD_DDL = `CREATE TABLE social_post_metrics (${COLUMNS}, PRIMARY KEY(post_id, date, metric))`;
const NEW_DDL = `CREATE TABLE social_post_metrics (${COLUMNS}, period TEXT NOT NULL DEFAULT 'unknown', PRIMARY KEY(post_id,date,metric,period))`;
const SET = 'value=excluded.value,unit=excluded.unit,source_field=excluded.source_field,completeness=excluded.completeness,provider=excluded.provider,collected_at=excluded.collected_at,run_id=excluded.run_id';
// Прежний писатель: 10 именованных столбцов и upsert по тройному ключу.
const OLD_UPSERT = `INSERT INTO social_post_metrics(post_id,date,metric,value,unit,source_field,completeness,provider,collected_at,run_id) VALUES(?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(post_id,date,metric) DO UPDATE SET ${SET} WHERE excluded.collected_at>=social_post_metrics.collected_at`;
// Вариант без ограждения по времени: устаревшая запись всё равно не должна вытеснить более новый архив.
const OLD_UPSERT_UNFENCED = OLD_UPSERT.replace(/ WHERE [^]*$/, '');
const NEW_UPSERT = `INSERT INTO social_post_metrics(post_id,date,metric,value,unit,source_field,completeness,provider,collected_at,run_id,period) VALUES(?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(post_id,date,metric,period) DO UPDATE SET ${SET} WHERE excluded.collected_at>=social_post_metrics.collected_at`;

test('архив нельзя заменить через INSERT OR REPLACE при выключенных recursive_triggers',t=>{
 const db=fixture(t);newWrite(db,SEED[0]);rollback(db);
 db.exec('PRAGMA recursive_triggers=OFF');
 for(const table of Object.values(TABLES).filter(name=>name!==TABLES.metrics)){
  const columns=db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name);
  assert.throws(()=>db.exec(`INSERT OR REPLACE INTO ${table}(${columns.join(',')}) SELECT ${columns.join(',')} FROM ${table}`),/immutable/,table);
 }
});
test('повторно занятый post_id с теми же числами архивируется с новым native владельцем',t=>{
 const db=fixture(t);newWrite(db,SEED[0]);rollback(db);ensure(db);
 db.exec("DELETE FROM social_posts WHERE id=1; INSERT INTO social_posts(id,company_code,platform,platform_post_id,provider,created_at) VALUES(1,'demo-b','max','replacement','direct','2026-10-13T12:00:00Z')");
 newWrite(db,SEED[0]);rollback(db);
 assert.equal(archive(db).filter(r=>r.post_id===1&&r.company_code==='demo-b').length,1);
 assert.equal(ensure(db).state,'restored');
 assert.equal(db.prepare('SELECT value FROM social_post_metrics WHERE post_id=1').get().value,10);
});

const D = '2026-10-10', T0 = '2026-10-10T01:00:00.000Z', T1 = '2026-10-10T02:00:00.000Z', T2 = '2026-10-10T03:00:00.000Z', T5 = '2026-10-11T05:00:00.000Z';
const CURRENT = ['post_id', 'date', 'metric', 'value', 'unit', 'source_field', 'completeness', 'provider', 'collected_at', 'run_id', 'period'];
const full = (r) => ({ date: D, unit: 'views', source_field: 'stat.views', completeness: 'complete', provider: 'direct', value: null, run_id: null, period: 'unknown', ...r });
const SEED = [
  full({ post_id: 1, metric: 'views', period: 'day', value: 10, collected_at: T1, run_id: 11 }),
  full({ post_id: 1, metric: 'views', period: 'lifetime', value: 150, collected_at: T2, run_id: 12 }),
  full({ post_id: 1, metric: 'views', period: 'unknown', value: null, source_field: '', completeness: 'unknown', provider: 'manual', collected_at: T0 }),
  full({ post_id: 1, metric: 'likes', period: 'lifetime', value: 5, unit: 'count', source_field: 'reactions', completeness: 'partial', provider: 'onlypult', collected_at: T1, run_id: 13 }),
  full({ post_id: 2, metric: 'views', period: 'unknown', value: 7, source_field: 'views', provider: 'onlypult', collected_at: T0, run_id: 14 }),
  full({ post_id: 3, metric: 'views', period: 'day', value: 3, collected_at: T1, run_id: 21 }),
  full({ post_id: 3, metric: 'views', period: 'lifetime', value: 30, collected_at: T2, run_id: 22 }),
];
const args = (r) => { const x = full(r); return [x.post_id, x.date, x.metric, x.value, x.unit, x.source_field, x.completeness, x.provider, x.collected_at, x.run_id]; };
const newWrite = (db, r) => db.prepare(NEW_UPSERT).run(...args(r), full(r).period).changes;
const oldWrite = (db, r, sql = OLD_UPSERT) => db.prepare(sql).run(...args(r)).changes;

function fixture(t, { ddl = NEW_DDL, file = null } = {}) {
  const db = new DatabaseSync(file || ':memory:');
  t.after(() => { try { db.close(); } catch { /* уже закрыта тестом */ } });
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY, code TEXT UNIQUE COLLATE NOCASE, name TEXT, is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies(id,code,name) VALUES(1,'demo-a','Компания А'),(2,'demo-b','Компания Б');
    CREATE TABLE social_posts(id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL COLLATE NOCASE, platform TEXT NOT NULL, platform_post_id TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '', content_id TEXT NOT NULL DEFAULT '', published_at TEXT, provider TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'organic',
      created_at TEXT NOT NULL, UNIQUE(company_code, platform, platform_post_id));
    INSERT INTO social_posts(id,company_code,platform,platform_post_id,provider,created_at) VALUES
      (1,'demo-a','max','-1000000000001:101','direct','${T0}'),(2,'demo-a','vk','wall-1_2','onlypult','${T0}'),(3,'demo-b','max','-1000000000002:7','direct','${T0}');
    ${ddl || ''};`);
  if (ddl === NEW_DDL) for (const r of SEED) newWrite(db, r);
  return db;
}
const plain = (rows) => rows.map((r) => ({ ...r }));
const by = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
const cmp = (a, b) => a.post_id - b.post_id || by(a.date, b.date) || by(a.metric, b.metric) || by(String(a.period), String(b.period));
const current = (db) => plain(db.prepare('SELECT * FROM social_post_metrics ORDER BY post_id, date, metric, period').all());
const legacy = (db) => plain(db.prepare('SELECT * FROM social_post_metrics ORDER BY post_id, date, metric').all());
const archive = (db) => plain(db.prepare(`SELECT * FROM ${TABLES.archive} ORDER BY archive_id`).all());
const asRow = (a) => Object.fromEntries(CURRENT.map((c) => [c, a[c]]));
const pk = (db) => db.prepare('PRAGMA table_info(social_post_metrics)').all().filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
const fk = (db) => db.prepare('PRAGMA foreign_keys').get().foreign_keys;
const master = (db) => plain(db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name').all());
const snapshot = (db) => JSON.stringify([master(db), master(db)
  .filter((o) => o.type === 'table' && (o.name.startsWith('social_post_metrics') || o.name === 'sqlite_sequence'))
  .map((o) => [o.name, plain(db.prepare(`SELECT * FROM ${o.name} ORDER BY rowid`).all())])]);
const inject = (at) => ({ onStep: (step) => { if (step === at) throw Object.assign(new Error('сбой для проверки'), { code: 'INJECTED' }); } });

test('после отката прежний ON CONFLICT(post_id,date,metric) выполняется, а все day/lifetime/unknown строки лежат в архиве точно', (t) => {
  const db = fixture(t), before = current(db);
  const result = rollback(db);
  assert.equal(result.state, 'rolled_back');
  assert.equal(result.archived, 7); assert.equal(result.projected, 4); assert.equal(result.mixed, 2);
  assert.deepEqual(pk(db), ['post_id', 'date', 'metric']);
  assert.equal(fk(db), 1, 'исходный foreign_keys возвращён');
  assert.equal(db.isTransaction, false);
  const strip = ({ period, ...rest }) => rest;
  const mixed = (post_id, provider) => ({ post_id, date: D, metric: 'views', value: null, unit: 'views', source_field: MIXED_SOURCE, completeness: 'unknown', provider, collected_at: T2, run_id: null });
  assert.deepEqual(legacy(db), [strip(SEED[3]), mixed(1, 'mixed'), strip(SEED[4]), mixed(3, 'direct')],
    'один период — точное значение; несколько — без значения, не последнее и не сумма');
  const archived = archive(db);
  assert.deepEqual(archived.map(asRow).sort(cmp), before, 'архив хранит все строки со всеми полями, включая NULL и период');
  assert.ok(archived.every((a) => a.origin === 'period_row'));
  assert.deepEqual(archived.filter((a) => a.post_id === 3).map((a) => [a.company_code, a.platform, a.platform_post_id]),
    [['demo-b', 'max', '-1000000000002:7'], ['demo-b', 'max', '-1000000000002:7']], 'владелец поста сохранён в архиве');

  assert.equal(oldWrite(db, { post_id: 2, date: '2026-10-11', metric: 'views', value: 9, collected_at: T5, run_id: 31 }), 1, 'новый тройной ключ');
  assert.equal(oldWrite(db, { post_id: 1, metric: 'views', value: 160, collected_at: T5, run_id: 32 }), 1, 'upsert по тройному ключу');
  assert.equal(oldWrite(db, { post_id: 3, metric: 'views', value: 1, collected_at: T0, run_id: 33 }), 0, 'устаревшая запись не вытесняет проекцию');
  assert.equal(legacy(db).find((r) => r.post_id === 1 && r.metric === 'views').value, 160);
});

test('вперёд: архив восстанавливается точно, записи прежнего писателя добавляются как unknown, синтетическая проекция наблюдением не становится', (t) => {
  const db = fixture(t), before = current(db);
  rollback(db);
  const w2 = { post_id: 2, metric: 'views', value: 8, source_field: 'views', provider: 'onlypult', collected_at: T5, run_id: 31 };
  const wLikes = { post_id: 1, metric: 'likes', value: 6, unit: 'count', source_field: 'reactions', completeness: 'partial', provider: 'onlypult', collected_at: T5, run_id: 32 };
  const wNew = { post_id: 3, date: '2026-10-11', metric: 'views', value: 4, collected_at: T5, run_id: 33 };
  for (const w of [w2, wLikes, wNew]) assert.equal(oldWrite(db, w), 1);
  const result = ensure(db);
  assert.equal(result.state, 'restored');
  assert.equal(result.legacyWrites, 3); assert.equal(result.rows, 9); assert.equal(result.restored, 6); assert.equal(result.skippedDeleted, 0);
  assert.deepEqual(result.conflicts, [{ postId: 2, date: D, metric: 'views', kept: 'legacy_write' }]);
  const expected = [...before.filter((r) => !(r.post_id === 2 && r.period === 'unknown')), full(w2), full(wLikes), full(wNew)].sort(cmp);
  assert.deepEqual(current(db), expected, 'day/lifetime из архива не подменены свежим unknown; смешанные проекции не стали наблюдениями');
  assert.deepEqual(pk(db), ['post_id', 'date', 'metric', 'period']);
  assert.equal(current(db).filter((r) => r.source_field === MIXED_SOURCE).length, 0);
  const archived = archive(db);
  assert.ok(archived.some((a) => a.origin === 'period_row' && a.post_id === 2 && a.value === 7 && a.run_id === 14), 'вытесненная архивная строка не потеряна');
  assert.deepEqual(archived.filter((a) => a.origin === 'legacy_write').map((a) => [a.post_id, a.metric, a.value, a.run_id, a.period]).sort(),
    [[1, 'likes', 6, 32, null], [2, 'views', 8, 31, null], [3, 'views', 4, 33, null]].sort(), 'записи прежнего писателя тоже в архиве');
  assert.equal(newWrite(db, { post_id: 1, metric: 'views', period: 'day', value: 12, collected_at: T5, run_id: 41 }), 1, 'новый писатель работает по четверному ключу');
});

test('повторный цикл и запись с тем же временем снятия сохраняют происхождение; архив только растёт', (t) => {
  const db = fixture(t);
  rollback(db);
  assert.equal(oldWrite(db, { post_id: 2, metric: 'views', value: 70, source_field: 'views', provider: 'manual', collected_at: T0, run_id: 40 }), 1, 'развилка с тем же временем');
  const first = ensure(db);
  assert.deepEqual(first.conflicts, [{ postId: 2, date: D, metric: 'views', kept: 'legacy_write' }], 'равное время — как у писателя: побеждает более поздняя запись');
  const afterFirst = current(db), archiveFirst = archive(db);
  assert.deepEqual(afterFirst.find((r) => r.post_id === 2), full({ post_id: 2, metric: 'views', value: 70, source_field: 'views', provider: 'manual', collected_at: T0, run_id: 40 }));
  assert.ok(archiveFirst.some((a) => a.post_id === 2 && a.origin === 'period_row' && a.value === 7 && a.provider === 'onlypult' && a.run_id === 14));
  assert.ok(archiveFirst.some((a) => a.post_id === 2 && a.origin === 'legacy_write' && a.value === 70 && a.provider === 'manual' && a.run_id === 40));

  const second = rollback(db);
  assert.equal(second.archived, 7);
  const archiveSecond = archive(db);
  assert.deepEqual(archiveSecond.slice(0, archiveFirst.length), archiveFirst, 'прежние строки архива не изменены и не удалены');
  assert.equal(archiveSecond.length, archiveFirst.length + 1, 'неизменные наблюдения не дублируются');
  const legacyRows = legacy(db);
  assert.deepEqual(rollback(db), { changed: false, state: 'legacy' });
  assert.deepEqual(archive(db), archiveSecond); assert.deepEqual(legacy(db), legacyRows);

  const third = ensure(db);
  assert.equal(third.legacyWrites, 0); assert.deepEqual(third.conflicts, []);
  assert.deepEqual(current(db), afterFirst);
  assert.deepEqual(ensure(db), { changed: false, state: 'current' });
  assert.deepEqual(db.prepare(`SELECT kind FROM ${TABLES.cycles} ORDER BY cycle_id`).all().map((r) => r.kind), ['rollback', 'forward', 'rollback', 'forward']);
});

test('устаревшая запись прежнего писателя не вытесняет более новое архивное наблюдение и не теряется', (t) => {
  const db = fixture(t), before = current(db);
  rollback(db);
  const stale = { post_id: 1, metric: 'views', value: 99, provider: 'manual', collected_at: '2026-10-09T00:00:00.000Z', run_id: 50 };
  assert.equal(oldWrite(db, stale), 0, 'ограждённый писатель устаревшую запись не принимает');
  assert.equal(oldWrite(db, stale, OLD_UPSERT_UNFENCED), 1, 'неограждённый писатель перезаписал проекцию');
  const result = ensure(db);
  assert.deepEqual(result.conflicts, [{ postId: 1, date: D, metric: 'views', kept: 'archive' }]);
  assert.deepEqual(current(db), before);
  assert.ok(archive(db).some((a) => a.origin === 'legacy_write' && a.value === 99 && a.run_id === 50));
});

test('идемпотентность: пустая база, прежняя схема без отката, промежуточная схема, новая схема; foreign_keys=OFF сохраняется', (t) => {
  const empty = fixture(t, { ddl: null });
  assert.deepEqual(rollback(empty), { changed: false, state: 'absent' });
  assert.deepEqual(ensure(empty), { changed: true, state: 'created' });
  assert.deepEqual(ensure(empty), { changed: false, state: 'current' });
  assert.deepEqual(pk(empty), ['post_id', 'date', 'metric', 'period']);
  assert.equal(rollback(empty).archived, 0);
  assert.deepEqual(rollback(empty), { changed: false, state: 'legacy' });
  assert.equal(ensure(empty).rows, 0);
  assert.deepEqual(ensure(empty), { changed: false, state: 'current' });

  const old = fixture(t, { ddl: OLD_DDL });
  old.exec('PRAGMA foreign_keys=OFF');
  oldWrite(old, { post_id: 1, metric: 'views', value: 5, collected_at: T1, run_id: 1 });
  oldWrite(old, { post_id: 3, metric: 'likes', value: null, unit: 'count', completeness: 'unknown', collected_at: T2 });
  const legacyBefore = legacy(old);
  assert.deepEqual(ensure(old), { changed: true, state: 'migrated', rows: 2 });
  assert.deepEqual(current(old), legacyBefore.map((r) => ({ ...r, period: 'unknown' })));
  assert.equal(fk(old), 0, 'выключенный foreign_keys не включён помощником');
  assert.equal(old.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'social_post_metrics_period%'").get().n, 0, 'обычный перенос архив не создаёт');
  assert.deepEqual(ensure(old), { changed: false, state: 'current' });

  const mid = fixture(t, { ddl: OLD_DDL.replace('run_id INTEGER', "run_id INTEGER, period TEXT NOT NULL DEFAULT 'unknown'") });
  oldWrite(mid, { post_id: 2, metric: 'views', value: 1, collected_at: T1 });
  mid.exec("UPDATE social_post_metrics SET period='lifetime'");
  assert.equal(ensure(mid).state, 'migrated');
  assert.deepEqual(current(mid).map((r) => r.period), ['lifetime']);
});

test('посты, компании, внешний ключ и сироты не меняются; удалённый за время отката пост не воскресает, но доказательства остаются', (t) => {
  const db = fixture(t);
  db.exec('PRAGMA foreign_keys=OFF');
  newWrite(db, { post_id: 99, metric: 'views', period: 'day', value: 1, collected_at: T1, run_id: 90 });
  db.exec('PRAGMA foreign_keys=ON');
  const outside = () => [plain(db.prepare('SELECT * FROM companies ORDER BY id').all()), plain(db.prepare('SELECT * FROM social_posts ORDER BY id').all())];
  const fkCheck = () => db.prepare('PRAGMA foreign_key_check(social_post_metrics)').all().map((r) => `${r.table}:${r.parent}`);
  const before = current(db), outsideBefore = outside(), orphans = fkCheck();
  assert.deepEqual(orphans, ['social_post_metrics:social_posts']);

  rollback(db);
  assert.equal(fk(db), 1); assert.deepEqual(outside(), outsideBefore); assert.deepEqual(fkCheck(), orphans, 'сирота не удалена и не добавлена');
  const orphan = archive(db).find((a) => a.post_id === 99);
  assert.deepEqual([orphan.company_code, orphan.platform, orphan.platform_post_id], [null, null, null]);
  ensure(db);
  assert.deepEqual(current(db), before); assert.deepEqual(outside(), outsideBefore); assert.deepEqual(fkCheck(), orphans);

  rollback(db);
  db.prepare('DELETE FROM social_posts WHERE id=3').run();
  assert.equal(legacy(db).filter((r) => r.post_id === 3).length, 0, 'каскад прежней таблицы');
  const result = ensure(db);
  assert.equal(result.skippedDeleted, 2);
  assert.deepEqual(current(db), before.filter((r) => r.post_id !== 3));
  assert.equal(archive(db).filter((a) => a.post_id === 3 && a.company_code === 'demo-b').length, 2, 'доказательства удалённого поста в архиве');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_list(social_post_metrics)').all().map((r) => [r.table, r.from, r.to, r.on_delete]), [['social_posts', 'post_id', 'id', 'CASCADE']]);
  db.prepare('DELETE FROM social_posts WHERE id=2').run();
  assert.equal(current(db).filter((r) => r.post_id === 2).length, 0, 'каскад восстановленной таблицы прежний');
});

test('сбой посреди миграции откатывает всё: таблица и архив согласованы, foreign_keys и транзакция возвращены', (t) => {
  const db = fixture(t);
  const steps = [];
  for (const at of ['archived', 'projected', 'swapped']) {
    const before = snapshot(db);
    assert.throws(() => rollback(db, inject(at)), { code: 'INJECTED' });
    assert.equal(snapshot(db), before, `откат: ${at}`);
    assert.equal(fk(db), 1); assert.equal(db.isTransaction, false);
  }
  rollback(db, { onStep: (s) => steps.push(s) });
  assert.deepEqual(steps, ['archived', 'projected', 'swapped']);
  oldWrite(db, { post_id: 2, metric: 'views', value: 8, collected_at: T5, run_id: 31 });
  for (const at of ['copied', 'swapped']) {
    const before = snapshot(db);
    assert.throws(() => ensure(db, inject(at)), { code: 'INJECTED' });
    assert.equal(snapshot(db), before, `возврат: ${at}`);
    assert.equal(fk(db), 1); assert.equal(db.isTransaction, false);
  }
  assert.equal(ensure(db).state, 'restored');
});

test('временная блокировка базы: ничего не изменено, foreign_keys возвращён, повтор проходит', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-post-period-'));
  const db = fixture(t, { file: path.join(dir, 'fixture.sqlite') }), other = new DatabaseSync(path.join(dir, 'fixture.sqlite'));
  try {
    const before = snapshot(db);
    other.exec('BEGIN IMMEDIATE');
    assert.throws(() => rollback(db), (error) => /locked|busy/i.test(error.message));
    assert.equal(snapshot(db), before); assert.equal(fk(db), 1); assert.equal(db.isTransaction, false);
    other.exec('ROLLBACK');
    assert.equal(rollback(db).state, 'rolled_back');
  } finally {
    other.close(); db.close();
    const real=fs.realpathSync(dir),parent=fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(real),parent);assert.ok(path.basename(real).startsWith('social-post-period-'));
    assert.equal(fs.lstatSync(dir).isSymbolicLink(),false);fs.rmSync(dir,{recursive:true});
  }
});

test('чужая транзакция и неожиданная схема отклоняются без изменений', (t) => {
  const db = fixture(t);
  db.exec('BEGIN');
  for (const fn of [ensure, rollback]) assert.throws(() => fn(db), { code: 'EXTERNAL_TRANSACTION' });
  assert.equal(db.isTransaction, true, 'чужая транзакция не закрыта помощником');
  db.exec('ROLLBACK');

  const extra = fixture(t, { ddl: OLD_DDL.replace('run_id INTEGER', 'run_id INTEGER, note TEXT') });
  const before = snapshot(extra);
  for (const fn of [ensure, rollback]) {
    assert.throws(() => fn(extra), { code: 'MALFORMED_SCHEMA' });
    assert.equal(snapshot(extra), before); assert.equal(fk(extra), 1);
  }
  const indexed = fixture(t);
  indexed.exec('CREATE INDEX social_post_metrics_metric ON social_post_metrics(metric)');
  assert.throws(() => rollback(indexed), { code: 'MALFORMED_SCHEMA' }, 'прикреплённый индекс не теряется молча');
  const badArchive = fixture(t);
  badArchive.exec(`CREATE TABLE ${TABLES.archive}(archive_id INTEGER PRIMARY KEY, note TEXT)`);
  assert.throws(() => rollback(badArchive), { code: 'MALFORMED_ARCHIVE' });
  const mismatch = fixture(t);
  rollback(mismatch); ensure(mismatch);
  mismatch.exec(`DROP TABLE social_post_metrics; ${OLD_DDL}`);
  assert.throws(() => ensure(mismatch), { code: 'STATE_MISMATCH' }, 'прежняя таблица без отката после завершённого цикла — не повод выдумывать периоды');
});

test('архив — неизменяемое доказательство: UPDATE и DELETE отклоняются самой базой', (t) => {
  const db = fixture(t);
  rollback(db);
  for (const [name, table] of Object.entries(TABLES)) {
    if (name === 'metrics') continue;
    assert.ok(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n > 0, table);
    assert.throws(() => db.exec(`UPDATE ${table} SET rowid=rowid`), /immutable/, table);
    assert.throws(() => db.exec(`DELETE FROM ${table}`), /immutable/, table);
  }
});

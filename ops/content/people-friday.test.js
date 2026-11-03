'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fridaySummary, fridayEvent, nextWeekStart } = require('./people-friday');

const options = { now: '2026-11-06T05:00:00.000Z', timezone: 'Europe/Moscow', metric: 'pendingIdeas', weekStart: '2026-11-09' };
function fixture(count = 1, status = 'pending') {
  const days = [], variants = [];
  for (let index = 0; index < count; index++) {
    const ideaId = `idea-${index}`;
    days.push({ ideaId, date: '2026-11-09', variants: { telegram: { text: 'Материал', excluded: false, plannedDate: '', contentRevision: 2 } } });
    variants.push({ ideaId, platform: 'telegram', contentRevision: 2, approvable: true, status, decision: status === 'pending' ? null : status });
  }
  return { companyCode: 'synapse-business', brief: { revision: 3 }, plan: { revision: 4, briefRevision: 3, days }, variants };
}
function additional(snapshot, index, platform, { status = 'pending', date = '', text = 'Другой вариант', excluded = false, revision = 2 } = {}) {
  const idea = snapshot.plan.days[index];
  idea.variants[platform] = { text, excluded, contentRevision: revision, plannedDate: date };
  snapshot.variants.push({ ideaId: idea.ideaId, platform, contentRevision: revision, approvable: !excluded && Boolean(text), status, decision: status === 'pending' ? null : status });
}

test('пятница определяется в явно выбранном часовом поясе, а не по UTC/машине', () => {
  const input = fixture();
  assert.equal(fridaySummary(input, { ...options, now: '2026-11-05T23:30:00Z' }).isFriday, true);
  assert.equal(fridaySummary(input, { ...options, now: '2026-11-05T23:30:00Z', timezone: 'America/New_York' }).isFriday, false);
  const saturday = fridaySummary(input, { ...options, now: '2026-11-06T22:30:00Z' });
  assert.equal(saturday.localDate, '2026-11-07');
  assert.equal(fridayEvent(saturday, { slot: 'morning' }), null);
});

test('вечером 6 требует напоминания, 7 нет; утром событие остаётся и при 7', () => {
  const approved = { ...options, metric: 'approvedIdeas' };
  const six = fridaySummary(fixture(6, 'approved'), approved), seven = fridaySummary(fixture(7, 'approved'), approved);
  assert.equal(six.approvedIdeas, 6);
  assert.equal(fridayEvent(six, { slot: 'evening' }).count, 6);
  assert.equal(fridayEvent(seven, { slot: 'evening' }), null);
  assert.equal(fridayEvent(seven, { slot: 'morning' }).count, 7);
});

test('одна идея на нескольких площадках не увеличивает счётчик; согласование требуется всем её версиям', () => {
  const input = fixture(2, 'approved');
  additional(input, 0, 'vk', { status: 'approved' });
  additional(input, 1, 'vk');
  const summary = fridaySummary(input, { ...options, metric: 'approvedIdeas' });
  assert.equal(summary.approvedIdeas, 1);
  assert.equal(summary.pendingIdeas, 1);
  assert.equal(summary.count, 1);
  assert.equal(fridayEvent(summary, { slot: 'morning' }).body, 'Согласовано 1 из 7, на согласовании 1.');
});

test('явный показатель pending сохранён; текст всегда содержит оба фактических счётчика', () => {
  const summary = fridaySummary(fixture(7), options);
  assert.equal(summary.metric, 'pendingIdeas');
  assert.equal(fridayEvent(summary, { slot: 'morning' }).body, 'Согласовано 0 из 7, на согласовании 7.');
  assert.equal(fridayEvent(summary, { slot: 'evening' }), null);
});

test('день недели и минимум задаются настройками; проверяется localDate, а не isFriday', () => {
  const summary = fridaySummary(fixture(6, 'approved'), { ...options, metric: 'approvedIdeas', now: '2026-11-08T10:00:00Z' });
  assert.equal(summary.localDate, '2026-11-08');
  assert.equal(fridayEvent(summary, { slot: 'morning' }), null);
  const event = fridayEvent({ ...summary, isFriday: true }, { slot: 'evening', weekday: 0, minimum: 8 });
  assert.equal(event.weekday, 0);
  assert.equal(event.body, 'Согласовано 6 из 8, на согласовании 0.');
  assert.equal(fridayEvent(summary, { slot: 'evening', weekday: 0, minimum: 6 }), null);
  for (const weekday of [-1, 7, 1.5, '5']) assert.throws(() => fridayEvent(summary, { slot: 'morning', weekday }), { status: 400 });
});

test('следующая неделя начинается следующим понедельником даже в понедельник текущей недели', () => {
  for (const [now, expected] of [
    ['2026-11-02T10:00:00Z', '2026-11-09'],
    ['2026-11-06T10:00:00Z', '2026-11-09'],
    ['2026-11-08T20:59:59Z', '2026-11-09'],
    ['2026-11-08T21:00:00Z', '2026-11-16'],
    ['2026-12-31T10:00:00Z', '2027-01-04']
  ]) assert.equal(nextWeekStart({ now, timezone: 'Europe/Moscow' }), expected);
});

test('следующий понедельник использует местную дату проекта, включая границу воскресенье/понедельник', () => {
  const now = '2026-11-08T17:00:00Z';
  assert.equal(nextWeekStart({ now, timezone: 'Asia/Irkutsk' }), '2026-11-16');
  assert.equal(nextWeekStart({ now, timezone: 'Europe/Moscow' }), '2026-11-09');
  assert.equal(nextWeekStart({ now, timezone: 'America/New_York' }), '2026-11-09');
  assert.throws(() => nextWeekStart({ now }), { status: 400 });
  assert.throws(() => nextWeekStart({ timezone: 'Asia/Irkutsk' }), { status: 400 });
});

test('учитывается точная актуальная ревизия; отозванное решение снова pending', () => {
  const input = fixture(3, 'approved');
  input.variants[0].contentRevision = 1;
  input.variants[1].status = 'pending'; input.variants[1].decision = 'withdrawn';
  input.variants.push({ ...input.variants[2], contentRevision: 1, status: 'pending', decision: null });
  const summary = fridaySummary(input, options);
  assert.equal(summary.approvedIdeas, 1);
  assert.equal(summary.pendingIdeas, 1);
});

test('старый бриф недоступен для уведомления, а не выдаёт нулевой актуальный план', () => {
  const input = fixture(7, 'approved'); input.brief.revision++;
  const summary = fridaySummary(input, options);
  assert.equal(summary.available, false);
  assert.equal(summary.reason, 'stale_brief');
  assert.equal(summary.approvedIdeas, 0);
  assert.equal(fridayEvent(summary, { slot: 'morning' }), null);
});

test('неподтверждённая текущая версия блокирует approved всей идеи при одобренной другой площадке', () => {
  const input = fixture(1, 'approved');
  additional(input, 0, 'vk', { status: 'approved' });
  input.variants[1].contentRevision = 1;
  const summary = fridaySummary(input, options);
  assert.equal(summary.approvedIdeas, 0);
  assert.equal(summary.pendingIdeas, 0);
});

test('исключённые и пустые версии не становятся материалами; отклонённая версия не pending', () => {
  const input = fixture(3);
  input.plan.days[0].variants.telegram.excluded = true;
  input.plan.days[1].variants.telegram.text = '  ';
  input.variants[2].status = 'rejected'; input.variants[2].decision = 'rejected';
  const summary = fridaySummary(input, options);
  assert.equal(summary.pendingIdeas, 0);
  assert.equal(summary.approvedIdeas, 0);
});

test('явный семидневный интервал включает обе границы; дата версии перекрывает дату идеи', () => {
  const input = fixture(4);
  input.plan.days[0].date = '2026-11-08';
  input.plan.days[1].date = '2026-11-15';
  input.plan.days[2].date = '2026-11-16';
  input.plan.days[3].date = '2026-12-01';
  input.plan.days[3].variants.telegram.plannedDate = '2026-11-09';
  const summary = fridaySummary(input, options);
  assert.equal(summary.weekEnd, '2026-11-15');
  assert.equal(summary.pendingIdeas, 2);
});

test('повтор не меняет ключ; слот, метрика и явный интервал получают разные ключи', () => {
  const summary = fridaySummary(fixture(), options);
  const first = fridayEvent(summary, { slot: 'morning' });
  assert.deepEqual(fridayEvent(summary, { slot: 'morning' }), first);
  assert.notEqual(fridayEvent(summary, { slot: 'evening' }).eventKey, first.eventKey);
  assert.notEqual(fridayEvent(fridaySummary(fixture(), { ...options, metric: 'approvedIdeas' }), { slot: 'morning' }).eventKey, first.eventKey);
  assert.notEqual(fridayEvent(fridaySummary(fixture(), { ...options, weekStart: '2026-11-16' }), { slot: 'morning' }).eventKey, first.eventKey);
});

test('дубли состояния/идеи не размножают счётчик, конфликтующие текущие ревизии отклоняются', () => {
  const input = fixture();
  input.variants.push(structuredClone(input.variants[0]));
  input.plan.days.push(structuredClone(input.plan.days[0]));
  assert.equal(fridaySummary(input, options).pendingIdeas, 1);
  input.plan.days[1].variants.telegram.contentRevision++;
  assert.throws(() => fridaySummary(input, options), { status: 502 });
});

test('пустой и отсутствующий план дают честные нули, функции не меняют DTO', () => {
  // До первого сохранения брифа настоящий DTO возвращает revision:0 и plan:null.
  for (const input of [fixture(0), { ...fixture(0), plan: null }, { ...fixture(0), brief: { revision: 0 }, plan: null }]) {
    const original = structuredClone(input);
    const summary = fridaySummary(input, options);
    assert.equal(summary.available, true);
    assert.equal(summary.count, 0);
    assert.equal(fridayEvent(summary, { slot: 'morning' }).count, 0);
    assert.deepEqual(input, original);
  }
});

test('не выбираются молча timezone, метрика, интервал или неточное время', () => {
  for (const patch of [{ timezone: undefined }, { timezone: 'Unknown/Zone' }, { metric: undefined }, { metric: 'posts' },
    { weekStart: undefined }, { weekStart: '2026-02-30' }, { now: undefined }, { now: '2026-11-06' }]) {
    assert.throws(() => fridaySummary(fixture(), { ...options, ...patch }), { status: 400 });
  }
  assert.throws(() => fridayEvent(fridaySummary(fixture(), options), { slot: 'night' }), { status: 400 });
});

test('повреждённый DTO/несовместимое решение не превращаются в успешный подсчёт', () => {
  const input = fixture(); input.variants[0].status = 'approved';
  assert.throws(() => fridaySummary(input, options), { status: 502 });
  assert.throws(() => fridaySummary({ ...fixture(), variants: undefined }, options), { status: 502 });
});

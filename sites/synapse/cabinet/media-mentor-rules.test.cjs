const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const {JSDOM} = require('jsdom');
const script = fs.readFileSync(require.resolve('./media-mentor-rules.js'), 'utf8');

/* Модуль без сети и без модели: проверяются только механические правила курса.
   Окно закрывается в finally — иначе упавший тест оставит его живым и процесс не выйдет. */
function rules() {
  const dom = new JSDOM('<main></main>', {url: 'https://test.local', runScripts: 'outside-only'});
  dom.window.SbCabinet = {};
  dom.window.eval(script);
  return {value: dom.window.SbCabinet.mediaMentorRules, close: () => dom.window.close()};
}

const reel = (date, patch = {}) => ({date, platform: 'instagram', format: 'reel', role: 'reach',
  topic: 'Тема', hook: '', assetId: 'a1', mentorNote: '', ...patch});
const texts = (result) => result.issues.map((item) => item.text).join(' | ');

// Воскресенье, вторник, четверг сентября 2026: 20-е — воскресенье.
const SUN = '2026-09-20', TUE = '2026-09-22', THU = '2026-09-24';

test('план по дням курса замечаний не собирает', () => {
  const r = rules();
  try {
    const result = r.value.review({days: [reel(SUN), reel(TUE), reel(THU)]});
    assert.equal(result.issues.length, 0, texts(result));
    assert.equal(result.ok, true);
    assert.equal(result.checked, 3);
  } finally { r.close(); }
});

test('пятница и суббота названы худшими днями, а не просто отмечены', () => {
  const r = rules();
  try {
    const result = r.value.review({days: [reel(SUN), reel(TUE), reel('2026-09-25')]});
    const worst = result.issues.find((item) => item.date === '2026-09-25');
    assert.equal(worst.level, 'violation');
    assert.match(worst.text, /пятница/);
    assert.match(worst.text, /худшим/);
  } finally { r.close(); }
});

test('понедельник и среда — замечание помягче: это не худший день, а не тот', () => {
  const r = rules();
  try {
    const result = r.value.review({days: [reel('2026-09-21'), reel(THU)]});
    const item = result.issues.find((x) => x.date === '2026-09-21');
    assert.equal(item.level, 'warning');
    assert.match(item.text, /понедельник/);
    assert.match(item.text, /воскресенье, вторник и четверг/);
  } finally { r.close(); }
});

test('два дня подряд названы прямо, с обеими датами', () => {
  const r = rules();
  try {
    const result = r.value.review({days: [reel(SUN), reel('2026-09-21'), reel(TUE)]});
    const pair = result.issues.find((item) => /два дня подряд/.test(item.text));
    assert.ok(pair, texts(result));
    assert.equal(pair.level, 'violation');
    assert.match(pair.text, /20\.09\.2026/);
    assert.match(pair.text, /21\.09\.2026/);
  } finally { r.close(); }
});

test('больше трёх роликов на набор в неделю — замечание с числом', () => {
  const r = rules();
  try {
    const result = r.value.review({days: [reel(SUN), reel(TUE), reel(THU), reel('2026-09-26')]});
    const week = result.issues.find((item) => /роликов на набор \d+/.test(item.text));
    assert.ok(week, texts(result));
    assert.match(week.text, /роликов на набор 4/);
  } finally { r.close(); }
});

test('пустая неделя внутри плана — это пропуск публикаций', () => {
  const r = rules();
  try {
    const result = r.value.review({days: [reel(TUE), reel('2026-10-06')]});
    assert.match(texts(result), /ни одного ролика на набор/);
    assert.match(texts(result), /Пропускать публикации/);
  } finally { r.close(); }
});

test('посты и карусели по дням недели не судятся: правило про короткий контент', () => {
  const r = rules();
  try {
    const result = r.value.review({days: [reel(TUE),
      reel('2026-09-25', {format: 'post'}), reel('2026-09-26', {format: 'carousel'})]});
    assert.equal(result.issues.filter((item) => /худшим|воскресенье, вторник/.test(item.text)).length, 0, texts(result));
  } finally { r.close(); }
});

test('ролик не на набор по дням недели тоже не судится', () => {
  const r = rules();
  try {
    const result = r.value.review({days: [reel(TUE), reel('2026-09-25', {role: 'sale'})]});
    assert.equal(result.issues.filter((item) => /худшим/.test(item.text)).length, 0, texts(result));
  } finally { r.close(); }
});

test('широкий набор форматов — замечание, а не запрет', () => {
  const r = rules();
  try {
    const result = r.value.review({days: [reel(SUN), reel(TUE, {format: 'post'}),
      reel(THU, {format: 'carousel'}), reel('2026-09-27', {format: 'story'}),
      reel('2026-09-29', {format: 'article'})]});
    const item = result.issues.find((x) => /Форматов в плане/.test(x.text));
    assert.ok(item, texts(result));
    assert.equal(item.level, 'warning');
    assert.match(item.text, /Форматов в плане 5/);
  } finally { r.close(); }
});

test('публикация без роли не проходит', () => {
  const r = rules();
  try {
    const result = r.value.review({days: [reel(TUE, {role: ''})]});
    const item = result.issues.find((x) => /нет роли/.test(x.text));
    assert.equal(item.level, 'violation');
  } finally { r.close(); }
});

test('план без роликов на набор отмечается: новых людей взять неоткуда', () => {
  const r = rules();
  try {
    const result = r.value.review({days: [reel(TUE, {format: 'post', role: 'sale'})]});
    assert.match(texts(result), /нет ни одного ролика на набор/);
  } finally { r.close(); }
});

test('пустой план не выдаётся за проверенный', () => {
  const r = rules();
  try {
    const result = r.value.review({days: []});
    assert.equal(result.ok, false);
    assert.equal(result.checked, 0);
    assert.match(result.reason, /пуст/);
  } finally { r.close(); }
});

test('непонятная дата не роняет проверку и не считается днём недели', () => {
  const r = rules();
  try {
    const result = r.value.review({days: [reel('не дата'), reel(TUE)]});
    assert.equal(result.checked, 2);
    assert.equal(result.issues.filter((item) => /худшим/.test(item.text)).length, 0);
  } finally { r.close(); }
});

test('проверка не обещает просмотров и глубины просмотра', () => {
  const r = rules();
  try {
    const result = r.value.review({days: [reel('2026-09-25'), reel('2026-09-26')]});
    const all = `${texts(result)} ${r.value.REMINDERS.join(' ')}`;
    assert.doesNotMatch(all, /просмотр(ов|а)? (будет|получите|гарант)/i);
    assert.doesNotMatch(all, /\d+\s*%\s*(глубин|досмотр)/i);
  } finally { r.close(); }
});

test('напоминания о решениях человека есть и они не смешаны с нарушениями', () => {
  const r = rules();
  try {
    assert.ok(r.value.REMINDERS.length >= 5);
    assert.match(r.value.REMINDERS.join(' '), /субтитры/);
    const result = r.value.review({days: [reel(SUN), reel(TUE), reel(THU)]});
    assert.equal(result.issues.length, 0, "напоминания не должны попадать в замечания по плану");
  } finally { r.close(); }
});

/* Модуль, не перечисленный в кабинете, не грузится — и проверка молча исчезает.
   Такое уже случалось: файл написан, тесты зелёные, на экране ничего нет. */
test('модуль правил перечислен среди модулей кабинета', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'cabinet.html'), 'utf8');
  assert.match(html, /"media-mentor-rules"/,
    'без записи в cabinetModules файл не загрузится и блок проверки не появится');
});

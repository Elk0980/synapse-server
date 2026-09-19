'use strict';
/* Загрузчик навыков Agent Skills: выбор по типу задания, отказ на нецелевых задачах,
   изоляция пути внутри доверенного корня, предел размера, журнал без содержания.
   node --test ops/content/agent-skills.test.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgentSkills, DEFAULT_ROOT, safeRelative } = require('./agent-skills');

const quiet = { info() {}, error() {} };
const CONTENT_TASK = 'Нужен контент-план на месяц: рубрики, рилсы и сторис по неделям';
const skills = (env = {}, root = DEFAULT_ROOT, logger = quiet) => createAgentSkills({ root, env, logger });

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'demo', 'references'), { recursive: true });
  fs.writeFileSync(path.join(root, 'demo', 'SKILL.md'),
    '---\nname: Демо\ndescription: демонстрация\n---\n\nТело навыка про контент.');
  fs.writeFileSync(path.join(root, 'demo', 'references', 'extra.md'), '# Справочник\n\nДополнение про план.');
  const write = (catalog) => fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify(catalog));
  write({ version: 7, skills: [{ id: 'demo', version: '2.0.0', dir: 'demo', entry: 'SKILL.md',
    triggers: ['контент*', 'рубрик*'], references: [{ file: 'references/extra.md', triggers: ['план'] }] }] });
  return { root, write };
}

test('встроенный навык выбирается по контентному заданию и несёт инструкции в запрос', () => {
  const store = skills();
  const chosen = store.select(CONTENT_TASK);
  assert.equal(chosen?.id, 'synapse-content-system');
  const result = store.instructions(CONTENT_TASK, { companyCode: 'alvi' });
  assert.equal(result.id, 'synapse-content-system');
  assert.equal(result.version, '1.0.0');
  assert.match(result.text, /Рабочая инструкция/);
  assert.match(result.text, /роль/i, 'в инструкции есть содержательная часть навыка');
  // Ограничения навыка едут вместе с ним: это текст порядка работы, а не разрешение.
  assert.match(result.text, /не выдаёт доступов/);
  assert.match(result.text, /не подтверждает согласование/);
  assert.match(result.text, /не меняет бюджет/);
  assert.equal(result.text.includes('---'), false, 'шапка Agent Skills в запрос не уходит');
});

test('короткие запросы о контенте и брифе выбирают навык без специальных формулировок', () => {
  const store = skills();
  for (const text of ['Создай контент-план на неделю', 'Помоги с брифом клиента', 'Какие есть идеи для reels?']) {
    assert.equal(store.select(text)?.id, 'synapse-content-system', text);
  }
  assert.equal(store.instructions('Составь контент-план').files.length, 2);
  assert.match(store.instructions('Помоги с брифом').text, /целевую аудиторию/);
});

test('контекст компании отдельный и не подменяется соседней компанией', () => {
  const store = skills();
  const alvi = store.instructions(CONTENT_TASK, { companyCode: 'alvi' });
  const avokado = store.instructions(CONTENT_TASK, { companyCode: 'avokado' });
  assert.match(alvi.text, /проект компании alvi/);
  assert.equal(alvi.text.includes('avokado'), false);
  assert.match(avokado.text, /проект компании avokado/);
  assert.equal(avokado.text.includes('alvi'), false);
  assert.match(alvi.text, /не переносятся/);
});

test('нецелевые задачи навык не подключают', () => {
  const store = skills();
  for (const text of ['Привет, как дела?', 'Когда оплатим счёт за поставку?',
    'Постоянно вылетает форма записи, посмотрите пожалуйста', 'Спасибо!', '']) {
    assert.equal(store.select(text), null, `навык не должен подключаться на: ${text}`);
    assert.equal(store.instructions(text, { companyCode: 'alvi' }), null);
  }
});

test('одного слова недостаточно, «пост» не срабатывает на «поставке»', () => {
  const store = skills();
  assert.equal(store.select('Подготовьте видео'), null, 'одно совпадение ниже порога');
  assert.equal(store.select('Отправьте документы по поставке и постоплате'), null);
  assert.ok(store.select('Сделайте пост и сторис'), 'два совпадения подключают навык');
});

test('справочник подключается только когда задание про него', (t) => {
  const box = sandbox(t);
  const store = skills({}, box.root);
  const planning = store.instructions('Нужен контент-план и рубрики', { companyCode: 'alvi' });
  assert.match(planning.text, /Дополнение про план/);
  assert.equal(planning.files.length, 2);
  const withoutPlan = store.instructions('Контент и рубрики обсудим', { companyCode: 'alvi' });
  assert.equal(withoutPlan.text.includes('Дополнение про план'), false);
  assert.equal(withoutPlan.files.length, 1);
});

test('путь ограничен доверенным корнем: выход, абсолютный путь и не-markdown отвергаются', (t) => {
  const box = sandbox(t);
  const outside = path.join(box.root, '..', `secret-${process.pid}.md`);
  fs.writeFileSync(outside, 'СЕКРЕТ ЗА ПРЕДЕЛАМИ КОРНЯ');
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.writeFileSync(path.join(box.root, 'demo', 'run.sh'), 'echo не должно исполняться');

  for (const bad of ['../secret.md', 'demo/../../secret.md', 'demo/./SKILL.md', '/etc/passwd',
    'C:/Windows/win.ini', 'demo\\SKILL.md', 'demo/run.sh', 'demo/SKILL.md\0.md', '']) {
    assert.equal(safeRelative(bad), null, `путь должен быть отвергнут: ${bad}`);
  }
  assert.equal(safeRelative('demo/references/extra.md'), 'demo/references/extra.md');

  box.write({ version: 1, skills: [{ id: 'escape', version: '1', dir: '..', entry: `secret-${process.pid}.md`,
    triggers: ['контент*', 'рубрик*'] }] });
  const store = skills({}, box.root);
  assert.equal(store.instructions('Контент и рубрики', { companyCode: 'alvi' }), null,
    'запись каталога с выходом за корень ничего не читает');
});

test('символическая ссылка наружу не читается', (t) => {
  const box = sandbox(t);
  const outside = path.join(os.tmpdir(), `skills-outside-${process.pid}.md`);
  fs.writeFileSync(outside, 'СЕКРЕТ ПО ССЫЛКЕ');
  t.after(() => fs.rmSync(outside, { force: true }));
  let linked = true;
  try { fs.symlinkSync(outside, path.join(box.root, 'demo', 'link.md')); }
  catch { linked = false; }
  if (!linked) { t.skip('символические ссылки недоступны в этой среде'); return; }
  box.write({ version: 1, skills: [{ id: 'demo', version: '1', dir: 'demo', entry: 'link.md',
    triggers: ['контент*', 'рубрик*'] }] });
  const result = skills({}, box.root).instructions('Контент и рубрики', { companyCode: 'alvi' });
  assert.equal(result, null, 'чтение по символической ссылке наружу не выполняется');
});

test('предел размера обрезает блок и честно это помечает', () => {
  const store = skills({ HUGH_SKILLS_MAX_BYTES: '900' });
  const result = store.instructions(CONTENT_TASK, { companyCode: 'alvi' });
  assert.ok(result.bytes <= 900, `блок ${result.bytes} байт не умещается в предел`);
  assert.equal(result.truncated, true);
  assert.match(result.text, /сокращено по пределу размера/);
  // Неверное значение не снимает предел, а возвращает к значению по умолчанию.
  const broken = skills({ HUGH_SKILLS_MAX_BYTES: 'много' });
  assert.equal(broken.status().maxBytes, 6000);
  assert.ok(broken.status().issues.some((issue) => /HUGH_SKILLS_MAX_BYTES/.test(issue)));
});

test('выключатель и отсутствующий каталог оставляют запрос без навыка', (t) => {
  assert.equal(skills({ HUGH_SKILLS: 'off' }).select(CONTENT_TASK), null);
  assert.equal(skills({ HUGH_SKILLS: 'off' }).status().enabled, false);
  const missing = skills({}, path.join(os.tmpdir(), `нет-каталога-${process.pid}`));
  assert.equal(missing.status().enabled, false);
  assert.equal(missing.instructions(CONTENT_TASK, { companyCode: 'alvi' }), null);
  assert.ok(missing.status().issues.length > 0, 'причина названа прямо');
  const box = sandbox(t);
  fs.writeFileSync(path.join(box.root, 'catalog.json'), 'не json');
  assert.equal(skills({}, box.root).status().enabled, false);
});

test('в журнал уходят только идентификатор и версия, без содержания навыка', () => {
  const lines = [];
  const store = skills({}, DEFAULT_ROOT, { info: (message) => lines.push(String(message)), error() {} });
  const result = store.instructions(CONTENT_TASK, { companyCode: 'alvi' });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /synapse-content-system/);
  assert.match(lines[0], /1\.0\.0/);
  for (const fragment of result.text.split('\n').filter((line) => line.trim().length > 30)) {
    assert.equal(lines[0].includes(fragment.trim()), false, 'содержание навыка в журнал не попадает');
  }
});

test('встроенный навык не содержит личных имён, клиентских примеров и коммерческих условий', () => {
  const text = fs.readFileSync(path.join(DEFAULT_ROOT, 'synapse-content-system', 'SKILL.md'), 'utf8')
    + fs.readFileSync(path.join(DEFAULT_ROOT, 'synapse-content-system', 'references', 'planning.md'), 'utf8');
  for (const forbidden of ['Влад', 'Хью', 'Claude', 'Codex', 'Palitra', 'Палитра', 'ALVI', 'АЛВИ',
    'Авокадо', 'Avokado', '₽', 'руб', 'USD', 'курс', 'подписк']) {
    assert.equal(text.includes(forbidden), false, `во встроенном навыке не должно быть: ${forbidden}`);
  }
  assert.match(text, /роль/i);
  assert.match(text, /не переносятся/);
});

test('каталог навыков попадает в образ сервиса контента', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^COPY skills \.\/skills$/m, 'без этой строки в контейнере навыков нет');
  const catalog = JSON.parse(fs.readFileSync(path.join(DEFAULT_ROOT, 'catalog.json'), 'utf8'));
  assert.ok(Number.isSafeInteger(catalog.version) && catalog.version > 0, 'каталог версионирован');
  for (const item of catalog.skills) {
    assert.ok(/^[a-z0-9-]{3,40}$/.test(item.id), `некорректный идентификатор навыка: ${item.id}`);
    assert.ok(/^\d+\.\d+\.\d+$/.test(item.version), `версия навыка задана явно: ${item.id}`);
    const entry = path.join(DEFAULT_ROOT, item.dir, item.entry || 'SKILL.md');
    assert.ok(fs.existsSync(entry), `файл навыка существует: ${entry}`);
    for (const ref of item.references || []) {
      assert.ok(fs.existsSync(path.join(DEFAULT_ROOT, item.dir, ref.file)), `справочник существует: ${ref.file}`);
    }
  }
});

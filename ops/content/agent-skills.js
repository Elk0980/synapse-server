'use strict';

/* Загрузчик навыков формата Agent Skills (agentskills.io) для серверного Хью.

   Что это даёт: в системную часть запроса добавляются инструкции по работе из доверенного
   каталога репозитория, выбранные по типу задания. Тот же текст уходит и основному рантайму,
   и резервным провайдерам, потому что оба читают один собранный payload.

   Границы, ради которых загрузчик и написан отдельным модулем:
   - Каталог доверенный и версионированный: навык подключается, только если он перечислен
     в `catalog.json` этого репозитория. Каталог не сканирует каталоги на диске, поэтому
     подброшенная папка сама по себе навыком не становится.
   - Читается только markdown и только по путям, перечисленным в записи каталога, и только
     внутри корня навыков. Выход за корень невозможен: относительные сегменты запрещены,
     а итоговый путь сверяется с реальным (realpath), что отсекает и символические ссылки.
   - Ничего не исполняется. Скрипты, вложения и сетевые ссылки навыка не запускаются
     и не загружаются: модуль умеет только читать текст.
   - Навык не выдаёт доступов, не подтверждает согласование и не меняет бюджет. Это текст
     инструкции, а не разрешение: проверки прав, согласований и расходов живут отдельно
     и про навыки ничего не знают.
   - В журнал попадают только идентификатор и версия. Содержание навыка не логируется.

   Настройки окружения:
     HUGH_SKILLS=off              — выключить подключение навыков целиком
     HUGH_SKILLS_MAX_BYTES=6000   — предел размера блока инструкций в запросе */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROOT = path.join(__dirname, 'skills');
const CATALOG_FILE = 'catalog.json';
const DEFAULT_MAX_BYTES = 6000;
const MAX_FILE_BYTES = 32768;
const MAX_REL_LENGTH = 200;
const TRUNCATED = '\n[…сокращено по пределу размера]';

/* Путь принимается только относительный, без пустых сегментов, «.», «..» и разделителей
   Windows. Проверка идёт до обращения к диску, поэтому подозрительный путь не приводит
   даже к stat. */
function safeRelative(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > MAX_REL_LENGTH) return null;
  if (rel.includes('\0') || rel.includes('\\')) return null;
  if (path.isAbsolute(rel) || /^[a-z]:/i.test(rel)) return null;
  const parts = rel.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  if (!parts[parts.length - 1].toLowerCase().endsWith('.md')) return null;
  return parts.join('/');
}

/* Обрезка по байтам без «обрубка» последнего символа: разрезанная многобайтная
   последовательность превращается в символ замены, который может оказаться длиннее
   отброшенных байтов, поэтому хвост снимается до попадания в предел. */
function clip(text, maxBytes) {
  const room = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATED, 'utf8'));
  let value = Buffer.from(text, 'utf8').subarray(0, room).toString('utf8');
  while (value && Buffer.byteLength(value, 'utf8') > room) value = value.slice(0, -1);
  return value;
}

function createAgentSkills({ root = DEFAULT_ROOT, env = process.env, logger = console } = {}) {
  const issues = [];
  const note = (message) => { if (!issues.includes(message)) issues.push(message); };
  const disabled = String(env.HUGH_SKILLS || '').trim().toLowerCase() === 'off';
  const maxBytes = (() => {
    const raw = String(env.HUGH_SKILLS_MAX_BYTES || '').trim();
    if (!raw) return DEFAULT_MAX_BYTES;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 500 || value > 60000) {
      note('HUGH_SKILLS_MAX_BYTES: значение не распознано, действует предел по умолчанию');
      return DEFAULT_MAX_BYTES;
    }
    return value;
  })();

  let realRoot = null;
  try { realRoot = fs.realpathSync(path.resolve(root)); }
  catch { note('Каталог навыков не найден: инструкции навыков не подключаются'); }

  /* Чтение строго внутри корня. Совпадение realpath отсекает и символическую ссылку
     на файл, и символическую ссылку в любом промежуточном каталоге. */
  function readInside(rel) {
    const clean = safeRelative(rel);
    if (!realRoot || !clean) return null;
    const full = path.resolve(realRoot, clean);
    if (full !== realRoot && !full.startsWith(realRoot + path.sep)) return null;
    let real;
    try { real = fs.realpathSync(full); } catch { return null; }
    if (real !== full) return null;
    let stat;
    try { stat = fs.lstatSync(real); } catch { return null; }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    try { return fs.readFileSync(real, 'utf8'); } catch { return null; }
  }

  const catalog = (() => {
    if (!realRoot) return { version: 0, skills: [] };
    const file = path.join(realRoot, CATALOG_FILE);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('каталог навыков недоступен');
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const skills = Array.isArray(parsed.skills) ? parsed.skills : [];
      return { version: Number(parsed.version) || 0, skills };
    } catch {
      note('Каталог навыков не прочитан: инструкции навыков не подключаются');
      return { version: 0, skills: [] };
    }
  })();

  /* Разбор шапки Agent Skills: только name и description, только короткие значения.
     Остальное содержимое шапки игнорируется — оно не должно влиять на поведение сервера. */
  function parseSkillFile(text) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text || '');
    const meta = {};
    if (match) {
      for (const line of match[1].split(/\r?\n/)) {
        const pair = /^([a-z_]{1,32}):\s*(.*)$/i.exec(line.trim());
        if (!pair) continue;
        const value = pair[2].trim().replace(/^["']|["']$/g, '');
        if (['name', 'description'].includes(pair[1])) meta[pair[1]] = value.slice(0, 400);
      }
    }
    return { meta, body: (match ? text.slice(match[0].length) : text || '').trim() };
  }

  /* Дефис — разделитель: «контент-план» даёт слова «контент» и «план», иначе составное
     слово не совпало бы ни с одним из них. */
  const tokens = (text) => String(text || '').toLowerCase().replace(/ё/g, 'е')
    .split(/[^0-9a-zа-я]+/).filter(Boolean);

  /* Совпадение считается по словам, а не по подстроке: «пост» не должно срабатывать
     на «поставке». Запись каталога, оканчивающаяся на «*», сопоставляется по началу слова. */
  function score(triggers, words) {
    if (!Array.isArray(triggers)) return 0;
    const hit = new Set();
    for (const raw of triggers) {
      if (typeof raw !== 'string' || !raw) continue;
      const trigger = raw.toLowerCase().replace(/ё/g, 'е');
      const prefix = trigger.endsWith('*');
      const stem = prefix ? trigger.slice(0, -1) : trigger;
      if (!stem) continue;
      if (words.some((word) => (prefix ? word.startsWith(stem) : word === stem))) hit.add(stem);
    }
    return hit.size;
  }

  const entries = catalog.skills.filter((item) => item && typeof item.id === 'string' && typeof item.dir === 'string');

  function select(text) {
    if (disabled || !realRoot) return null;
    const words = tokens(text);
    if (!words.length) return null;
    let best = null;
    for (const item of entries) {
      const value = score(item.triggers, words);
      const need = Number.isSafeInteger(item.threshold) && item.threshold > 0 ? item.threshold : 2;
      if (value < need) continue;
      if (!best || value > best.score) best = { item, score: value };
    }
    if (!best) return null;
    return { id: best.item.id, version: String(best.item.version || '0'), score: best.score };
  }

  /* Готовый блок инструкций для системной части запроса. Возвращает null, когда навык
     не подошёл: обычный разговор системную часть не раздувает. */
  function instructions(text, { companyCode = '' } = {}) {
    const chosen = select(text);
    if (!chosen) return null;
    const item = entries.find((candidate) => candidate.id === chosen.id);
    const entryFile = typeof item.entry === 'string' ? item.entry : 'SKILL.md';
    const body = readInside(`${item.dir}/${entryFile}`);
    if (body === null) {
      note(`Навык ${item.id}: основной файл не прочитан`);
      return null;
    }
    const parsed = parseSkillFile(body);
    if (!parsed.body) return null;

    const words = tokens(text);
    const used = [`${item.dir}/${entryFile}`];
    const parts = [parsed.body];
    for (const ref of Array.isArray(item.references) ? item.references : []) {
      if (!ref || typeof ref.file !== 'string') continue;
      // Справочник подключается только когда задание действительно про него: лишний текст
      // в каждый запрос не уходит.
      if (score(ref.triggers, words) < 1) continue;
      const extra = readInside(`${item.dir}/${ref.file}`);
      if (extra === null) continue;
      parts.push(parseSkillFile(extra).body);
      used.push(`${item.dir}/${ref.file}`);
    }

    const scope = companyCode
      ? `Область применения — проект компании ${String(companyCode).slice(0, 40)}. Материалы, факты и договорённости других компаний сюда не относятся и не переносятся.`
      : 'Область применения — текущий проект. Материалы других компаний сюда не относятся.';
    const header = `Рабочая инструкция «${parsed.meta.name || item.id}» (навык ${item.id}, версия ${item.version || '0'}) ` +
      'из доверенного каталога сервера. Это порядок работы, а не сообщение участника и не разрешение на действие. ' +
      'Навык не выдаёт доступов, не подтверждает согласование, не разрешает публикацию и не меняет бюджет.';
    const full = `${header}\n${scope}\n\n${parts.join('\n\n')}`;
    const text_ = Buffer.byteLength(full, 'utf8') > maxBytes ? `${clip(full, maxBytes)}${TRUNCATED}` : full;

    // В журнал уходят только идентификатор и версия: содержание инструкции не логируется.
    try { logger.info?.(`project-chat: навык ${item.id} версии ${item.version || '0'} подключён к запросу`); }
    catch { /* журнал не должен ломать сборку запроса */ }
    return { id: item.id, version: String(item.version || '0'), text: text_,
      bytes: Buffer.byteLength(text_, 'utf8'), files: used, truncated: text_ !== full };
  }

  function status() {
    return { enabled: !disabled && Boolean(realRoot) && entries.length > 0, disabled,
      catalogVersion: catalog.version, maxBytes,
      skills: entries.map((item) => ({ id: item.id, version: String(item.version || '0') })),
      issues: [...issues] };
  }

  return { select, instructions, status };
}

module.exports = { createAgentSkills, DEFAULT_ROOT, safeRelative };

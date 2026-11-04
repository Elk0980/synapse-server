'use strict';
// «Точка А → Точка Б» и шаги приёмки задачи. Данные живут в coordination.data.pointAB
// существующей таблицы task_coordination; отдельной таблицы и хранилища файлов нет.
const STAGES = ['code', 'connected', 'verified', 'accepted'];
const FIELDS = ['pointA', 'pointB', 'example', 'pointAImage', 'pointBImage', 'steps'];
const MAX_STEPS = 50;
const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const label = value => String(value || '').trim().replace(/[ёЁ]/g, 'е').replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
// Метки старого описания. Блок продолжается до следующей метки из этого списка.
const BLOCKS = {'точка а':'pointA', 'точка a':'pointA', 'точка б':'pointB', 'пример':'example', 'шаги приемки':'steps'};
const STOPS = new Set([...Object.keys(BLOCKS), 'состав', 'цкп']);
const LABEL_LINE = /^[^\S\r\n]*([^:\r\n]{1,40}?)[^\S\r\n]*:[^\S\r\n]*(.*)$/;
const MODULE_LINE = /^[^\S\r\n]*Модуль[^\S\r\n]+№[^\S\r\n]*\d+[^\S\r\n]*$/i;
const STEP_LINE = /^[^\S\r\n]*(?:[-*•]|\d+[.)])?[^\S\r\n]*\[([ xXхХ✓vV]?)\][^\S\r\n]*(.*\S)[^\S\r\n]*$/;

function text(value, max, name) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) fail(400, `Некорректное поле: ${name}`);
  return value.trim();
}

// Только https без учётных данных — для картинок А/Б и доказательств шагов.
function httpsUrl(value, name, required = false) {
  const raw = text(value, 2048, name);
  if (!raw) { if (required) fail(400, `Нужна https-ссылка: ${name}`); return ''; }
  let parsed;
  try { parsed = new URL(raw); } catch { fail(400, `Нужна https-ссылка: ${name}`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || /\s/.test(raw)) fail(400, `Нужна https-ссылка без учётных данных: ${name}`);
  return parsed.href;
}

function parseDescription(description) {
  const result = {pointA:'', pointB:'', example:'', pointAImage:'', pointBImage:'', steps:[]};
  const lines = String(description || '').split(/\r?\n/);
  const blocks = {pointA:[], pointB:[], example:[], steps:[]};
  let current = null, found = false;
  for (const line of lines) {
    const match = line.match(LABEL_LINE), key = match ? label(match[1]) : '';
    if (match && STOPS.has(key)) {
      current = BLOCKS[key] || null;
      if (current) { if (current !== 'example') found = true; if (match[2].trim()) blocks[current].push(match[2]); }
      continue;
    }
    if (MODULE_LINE.test(line)) { current = null; continue; }
    if (current) blocks[current].push(line);
  }
  if (!found) return null;
  for (const key of ['pointA', 'pointB', 'example']) result[key] = blocks[key].join('\n').trim();
  let index = 0;
  for (const line of blocks.steps) {
    const step = line.match(STEP_LINE);
    if (!step) continue;
    // «[x]» в описании не закрывает шаг: его можно поставить правкой текста без доказательства.
    // Такой шаг остаётся открытым с пометкой наследия, пока проверяющий не закроет его с доказательством.
    const marked = step[1].trim() !== '';
    result.steps.push({id:`d${++index}`, text:step[2].trim().slice(0, 500), state:'open',
      evidence:'', evidenceKind:'', closedAt:'', closedBy:'', ...(marked ? {legacy:true} : {})});
    if (result.steps.length === MAX_STEPS) break;
  }
  return result;
}

// Сохранённый блок важнее описания; описание читается только для старых задач.
function effective(stored, description) {
  if (object(stored)) return {...blank(), ...stored, steps:Array.isArray(stored.steps) ? stored.steps : [], source:'card'};
  const parsed = parseDescription(description);
  return parsed ? {...parsed, source:'description'} : null;
}

const blank = () => ({pointA:'', pointB:'', example:'', pointAImage:'', pointBImage:'', steps:[]});
const stored = value => { if (!value) return blank(); const {source, ...rest} = value; return rest; };
// Снятый проверяющим шаг не учитывается; снятие исполнителем ждёт подтверждения и шаг продолжает блокировать.
const withdrawn = step => step?.removed === true && step.removalConfirmed === true;
const counts = value => {
  const steps = (Array.isArray(value?.steps) ? value.steps : []).filter(step => !withdrawn(step));
  return {total:steps.length, closed:steps.filter(step => step.state === 'closed').length};
};

// Формула specs/101-task-point-a-b: без шагов — этапы×25; с шагами — среднее этапов×25 и доли закрытых шагов.
function progress(status, milestones, steps) {
  if (status === 'done') return 100;
  const base = STAGES.filter(stage => milestones?.[stage]?.state === 'confirmed').length * 25;
  const {total, closed} = steps || {total:0, closed:0};
  return total > 0 ? Math.round((base + 100 * closed / total) / 2) : base;
}

function validateIncoming(value) {
  if (!object(value) || Object.keys(value).some(key => !FIELDS.includes(key))) fail(400, 'Некорректный блок «Точка А → Точка Б»');
  const result = {};
  if ('pointA' in value) result.pointA = text(value.pointA, 4000, 'Точка А');
  if ('pointB' in value) result.pointB = text(value.pointB, 4000, 'Точка Б');
  if ('example' in value) result.example = text(value.example, 4000, 'Пример');
  if ('pointAImage' in value) result.pointAImage = httpsUrl(value.pointAImage, 'картинка Точки А');
  if ('pointBImage' in value) result.pointBImage = httpsUrl(value.pointBImage, 'картинка Точки Б');
  if ('steps' in value) {
    if (!Array.isArray(value.steps) || value.steps.length > MAX_STEPS) fail(400, `Нужен список не более ${MAX_STEPS} шагов приёмки`);
    const ids = new Set();
    result.steps = value.steps.map(item => {
      if (!object(item) || Object.keys(item).some(key => !['id', 'text'].includes(key))) fail(400, 'Шаг приёмки передаётся как id и текст');
      const stepText = text(item.text, 500, 'шаг приёмки');
      if (!stepText) fail(400, 'Пустой шаг приёмки');
      if (item.id === undefined) return {text:stepText};
      if (typeof item.id !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(item.id) || ids.has(item.id)) fail(400, 'Некорректный идентификатор шага');
      ids.add(item.id);
      return {id:item.id, text:stepText};
    });
  }
  return result;
}

// Переносит состояние закрытых шагов; клиент не может сам выставить «закрыт».
function merge(previous, incoming) {
  const base = stored(previous), old = new Map(base.steps.map(step => [step.id, step]));
  const result = {...base, ...incoming, steps:base.steps};
  if (incoming.steps) {
    const used = new Set(base.steps.map(step => step.id));
    let next = 0;
    const nextId = () => { let id; do id = `s${++next}`; while (used.has(id)); used.add(id); return id; };
    result.steps = incoming.steps.map(item => {
      if (!item.id) return {id:nextId(), text:item.text, state:'open', evidence:'', evidenceKind:'', closedAt:'', closedBy:''};
      const step = old.get(item.id);
      if (!step) fail(400, 'Неизвестный шаг приёмки');
      if (withdrawn(step)) fail(409, 'Шаг снят: верните его повторным открытием');
      if (step.state === 'closed' && step.text !== item.text) fail(409, 'Закрытый шаг нельзя переписать: сначала откройте его заново');
      return {...step, text:item.text};
    });
    const kept = new Set(incoming.steps.map(item => item.id).filter(Boolean));
    for (const step of base.steps) {
      if (kept.has(step.id) || step.state === 'closed') continue;
      // Снятые шаги остаются в блоке как след решения; открытый шаг молча удалить нельзя.
      if (withdrawn(step)) { result.steps.push(step); continue; }
      fail(400, 'Открытый шаг приёмки нельзя удалить: закройте его с доказательством или снимите через task_step_remove с причиной');
    }
  }
  return result;
}

const personKey = value => String(value || '').trim().replace(/[ёЁ]/g, 'е').toLocaleLowerCase('ru-RU');
// Модель principal: закрывающий — авторизованный пользователь CRM (userId/userName),
// исполнитель — tasks.assignee_name. Совпадение по имени или person:<id> запрещает закрытие.
// author — имя, которым агент представился в вызове: агенты работают под ключом владельца,
// поэтому имя проверяется дополнительно к principal.
function isExecutor(executorName, actor) {
  const executor = personKey(executorName);
  if (!executor) return false;
  return executor === personKey(actor?.userName) || executor === `person:${actor?.userId}` ||
    (!!actor?.author && executor === personKey(actor.author));
}

function close(previous, value, actor, executorName, stamp) {
  if (!object(value) || Object.keys(value).some(key => !['id', 'evidence', 'kind'].includes(key))) fail(400, 'Передайте шаг и доказательство');
  const base = stored(previous), step = base.steps.find(item => item.id === value.id);
  if (!step) fail(404, 'Шаг приёмки не найден');
  if (step.state === 'closed') fail(409, 'Шаг уже закрыт');
  if (withdrawn(step)) fail(409, 'Шаг снят: верните его повторным открытием');
  const kind = value.kind === undefined ? 'link' : value.kind;
  if (!['link', 'image'].includes(kind)) fail(400, 'Доказательство — ссылка или картинка');
  const evidence = text(value.evidence, 2048, 'доказательство') ?
    httpsUrl(value.evidence, 'доказательство шага') : fail(400, 'Закрыть шаг можно только с доказательством: https-ссылка или картинка');
  if (isExecutor(executorName, actor)) fail(403, 'Шаг закрывает проверяющий, а не исполнитель задачи');
  const closedBy = String(actor?.author || actor?.userName || `#${actor?.userId}`).slice(0, 200);
  return {...base, steps:base.steps.map(item => item.id === step.id ? {...item, state:'closed', evidence, evidenceKind:kind,
    closedAt:stamp, closedBy, closedById:actor.userId, legacy:undefined} : item)};
}

// Снятие шага: причина обязательна, запись идёт в ревизию и историю. Исполнитель может только
// предложить снятие — шаг блокирует «Готово», пока его не снимет или не закроет проверяющий.
function remove(previous, value, actor, executorName, stamp) {
  if (!object(value) || Object.keys(value).some(key => !['id', 'reason'].includes(key))) fail(400, 'Передайте шаг и причину');
  const base = stored(previous), step = base.steps.find(item => item.id === value.id);
  if (!step) fail(404, 'Шаг приёмки не найден');
  if (withdrawn(step)) fail(409, 'Шаг уже снят');
  const reason = text(value.reason, 500, 'причина');
  if (!reason) fail(400, 'Укажите причину снятия шага');
  const by = String(actor?.author || actor?.userName || `#${actor?.userId}`).slice(0, 200);
  const confirmed = step.state === 'closed' || !isExecutor(executorName, actor);
  return {...base, steps:base.steps.map(item => item.id === step.id ? {...item, removed:true, removalConfirmed:confirmed,
    removedReason:reason, removedBy:by, removedById:actor.userId, removedAt:stamp} : item)};
}

function reopen(previous, value) {
  if (!object(value) || Object.keys(value).join() !== 'id') fail(400, 'Передайте шаг');
  const base = stored(previous);
  if (!base.steps.some(item => item.id === value.id)) fail(404, 'Шаг приёмки не найден');
  return {...base, steps:base.steps.map(item => item.id === value.id ?
    {id:item.id, text:item.text, state:'open', evidence:'', evidenceKind:'', closedAt:'', closedBy:'', ...(item.legacy ? {legacy:true} : {})} : item)};
}

function assertCanFinish(value) {
  const {total, closed} = counts(value);
  if (closed < total) fail(409, `Нельзя перевести в «Готово»: открыты шаги приёмки — ${total - closed} из ${total}. Шаг закрывает проверяющий с доказательством.`);
}

// Единая серверная проверка перехода в «Готово» для всех путей записи статуса.
// row — строка задачи с уже применёнными изменениями (например, новым описанием), status — прежний статус.
function assertTaskCanFinish(db, row) {
  if (!row || row.status === 'done') return;
  const table = Number.isSafeInteger(row.id) &&
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_coordination'").get();
  const saved = table ? db.prepare('SELECT data FROM task_coordination WHERE task_id=?').get(row.id) : null;
  let data = {};
  try { data = saved ? JSON.parse(saved.data) : {}; } catch { data = {}; }
  const value = effective(data.pointAB, row.description);
  if (value) assertCanFinish(value);
}

module.exports = {assertTaskCanFinish, MAX_STEPS,parseDescription, effective, counts, progress, validateIncoming, merge, close, remove, reopen, withdrawn,
  assertCanFinish, isExecutor, httpsUrl, stored};

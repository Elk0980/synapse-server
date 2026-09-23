'use strict';

/* Черновик контент-плана Медиа-наставника по брифу компании.

   Модуль НИЧЕГО не сохраняет и ничего не согласовывает: он возвращает предложение,
   которое человек переносит в план сам, обычными маршрутами медиа-наставника.
   Хранилище плана (crm/media-mentor.js) остаётся без обращений к моделям.

   Правила, ради которых модуль и нужен:
   - Словарь не расширяется моделью. Площадка обязана быть из брифа, формат — из FORMATS,
     роль — из ROLES. Всё остальное отбрасывается с явной причиной, а не «исправляется».
   - Материалы не выдумываются: assetId принимается только если такой исходник есть в брифе.
     Выдуманная ссылка на материал — это ложное «материал готов», поэтому она стирается.
   - Провайдер недоступен — это не повод отдать пустой план как результат: статус unavailable,
     и ни одной позиции наружу.
   - Ответ модели не считается проверенным. Любая позиция уходит наружу со статусом черновика,
     который человек обязан прочитать. Модуль не умеет отличать факт от догадки модели. */

const MIN_DAYS = 7, MAX_DAYS = 14, MAX_ITEMS_PER_DAY = 3;
const FORMAT_KEYS = ['post', 'story', 'reel', 'carousel'];
const ROLE_KEYS = ['reach', 'affection', 'sale'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTICE = 'Это предложение модели, а не согласованный план. Ни одна позиция не сохранена ' +
  'и не согласована: перенос в план и согласование остаются отдельными действиями человека. ' +
  'Темы и зацепки моделью не проверены — сверьте их с подтверждёнными фактами брифа.';
const UNAVAILABLE = 'Предложение не построено: ни один провайдер ответов сейчас не доступен. ' +
  'Пустой план не выдаётся за результат — повторите позже или заполните план вручную.';
const UNUSABLE = 'Ответ модели не удалось разобрать как план. Ничего не предлагается: ' +
  'додумывать за модель модуль не станет.';

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/* Даты плана задаёт код, а не модель: модель ошибается в календаре, а сдвиг дат
   тихо ломает соответствие плана неделе, на которую его смотрит человек. */
function dates(startDate, days) {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  if (!DAY_RE.test(String(startDate)) || !Number.isFinite(start)) throw Error('Некорректная дата начала плана');
  const out = [];
  for (let i = 0; i < days; i += 1) out.push(new Date(start + i * 86400000).toISOString().slice(0, 10));
  return out;
}

function buildPrompt(brief, { startDate, days }) {
  const list = (rows, map) => (rows || []).map(map).join('; ') || 'не указано';
  const system = 'Ты медиа-наставник. Составляешь контент-план по брифу компании. ' +
    'Отвечай ТОЛЬКО массивом JSON, без пояснений и без разметки. ' +
    'Каждый элемент: {"date":"ГГГГ-ММ-ДД","platform":"...","format":"post|story|reel|carousel",' +
    '"role":"reach|affection|sale","topic":"...","hook":"...","assetId":"","mentorNote":"..."}. ' +
    'Площадку бери только из списка площадок брифа. Материал (assetId) указывай только из списка ' +
    'исходников брифа, иначе оставляй пустым. Не выдумывай факты, цифры, акции и цены: ' +
    'если сведений нет, пиши тему без них. ' +
    'Роль материала по ОВП: reach — охват незнакомых людей через их вопрос; ' +
    'affection — доверие через людей, процесс и подтверждённый опыт; ' +
    'sale — отдельное конкретное предложение и путь к обращению только при подтверждённых условиях. ' +
    'Для нескольких направлений не смешивай аудитории и продукты. ' +
    'Начало короткого видео должно ясно называть ситуацию зрителя, содержание — отвечать на обещанный вопрос. ' +
    'Адаптируй зацепку и формат под выбранную площадку, не делай одинаковый пост для всех. ' +
    'В mentorNote укажи, какой один факт или материал нужен от клиента, и объясни ему простыми словами, ' +
    'зачем мы это просим и какой этап пути покупателя это улучшит. ' +
    'Задание на съёмку — одно простое действие по указанной готовности; лицо и голос не требуй. ' +
    'Не навязывай фиксированные дни, длину видео, пороги удержания или обещания охватов. ' +
    'Предложи компактный первый набор из 3–5 материалов в пределах периода: topic до 60 знаков, ' +
    'hook до 80 знаков, mentorNote до 140 знаков. Это не обещание ежедневного выпуска.';
  const user = [
    `Даты плана: ${dates(startDate, days).join(', ')}.`,
    `Не более ${MAX_ITEMS_PER_DAY} позиций на дату.`,
    `Площадки: ${(brief.platforms || []).join(', ') || 'не указано'}.`,
    `Цель: ${clean(brief.goal, 1000) || 'не указано'}.`,
    `Продукт: ${clean(brief.product, 1000) || 'не указано'}.`,
    `Аудитория: ${clean(brief.audience, 1000) || 'не указано'}.`,
    `Боли: ${list(brief.pains, (p) => clean(p, 300))}.`,
    `Факты, разрешённые для контента: ${list((brief.confirmedFacts || []).filter((f) => f.approvedForContent === true),
      (f) => `${clean(f.statement, 300)} (источник: ${clean(f.source, 120)})`)}.`,
    `Исходники: ${list(brief.assets, (a) => `${a.id} — ${clean(a.title, 200)} [${a.kind}]`)}.`,
    `Готовность к съёмке: ${brief.shootingComfort?.level || 'unknown'}. ${clean(brief.shootingComfort?.notes, 500)}`,
  ].join('\n');
  return { system, messages: [{ role: 'user', content: user }], responseProfile: 'structured-draft' };
}

/* Из ответа берётся первый массив JSON. Если его нет — это не план, и чинить нечего. */
function extractArray(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function normalize(rows, { brief, startDate, days }) {
  const allowedDates = new Set(dates(startDate, days));
  const allowedPlatforms = new Set(brief.platforms || []);
  const allowedAssets = new Set((brief.assets || []).map((a) => a.id));
  const perDay = new Map();
  const items = [], dropped = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) { dropped.push('позиция не является объектом'); continue; }
    const date = clean(row.date, 10);
    if (!allowedDates.has(date)) { dropped.push(`дата вне плана: ${date || 'пусто'}`); continue; }
    const platform = clean(row.platform, 50).toLowerCase();
    if (!allowedPlatforms.has(platform)) { dropped.push(`площадка не выбрана в брифе: ${platform || 'пусто'}`); continue; }
    const format = clean(row.format, 20).toLowerCase();
    if (!FORMAT_KEYS.includes(format)) { dropped.push(`формат вне словаря: ${format || 'пусто'}`); continue; }
    const role = clean(row.role, 20).toLowerCase();
    if (!ROLE_KEYS.includes(role)) { dropped.push(`роль вне словаря: ${role || 'пусто'}`); continue; }
    const topic = clean(row.topic, 300);
    if (!topic) { dropped.push(`пустая тема на ${date}`); continue; }
    const used = perDay.get(date) || 0;
    if (used >= MAX_ITEMS_PER_DAY) { dropped.push(`сверх ${MAX_ITEMS_PER_DAY} позиций на ${date}`); continue; }
    perDay.set(date, used + 1);
    const assetId = clean(row.assetId, 100);
    const known = assetId && allowedAssets.has(assetId);
    if (assetId && !known) dropped.push(`материал ${assetId} не найден в брифе — ссылка удалена`);
    items.push({ date, platform, format, role, topic,
      hook: clean(row.hook, 300), assetId: known ? assetId : '',
      mentorNote: clean(row.mentorNote, 1000) });
  }
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { items, dropped };
}

/* Ответ модели берётся тем же транспортом, что и личная переписка владельца
   (projectChat.askHugh): второго пути к провайдерам и второго места для ключей не заводим. */
function answerText(answer) {
  if (typeof answer === 'string') return { text: answer, provider: null, model: null };
  if (answer && typeof answer.text === 'string') {
    return { text: answer.text, provider: answer.provider || null, model: answer.model || null };
  }
  return null;
}


/* Разбор брифа: позиционирование, рубрики и пробелы. Один вызов на клиента, не на каждый план.
   Рубрика — это не пост: она говорит, о чём писать регулярно. Пробелы — то, чего не хватает
   в брифе; они не заполняются моделью и остаются вопросами к человеку. */
const MAX_RUBRICS = 8, MAX_GAPS = 10;
const ANALYSIS_NOTICE = 'Это разбор модели, а не проверенные сведения. Ничего не сохранено. ' +
  'Позиционирование и рубрики — предложение: сверьте их с подтверждёнными фактами брифа.';

function analysisPrompt(brief) {
  const list = (rows, map) => (rows || []).map(map).join('; ') || 'не указано';
  const system = 'Ты медиа-наставник. Разбираешь бриф компании. Отвечай ТОЛЬКО объектом JSON, ' +
    'без пояснений и без разметки: {"positioning":"...","audience":"...",' +
    '"rubrics":[{"title":"...","why":"...","formats":["post"]}],"gaps":["..."]}. ' +
    'Форматы только из списка: post, story, reel, carousel. ' +
    'Не выдумывай факты, цифры, награды и опыт: чего нет в брифе, того не пиши. ' +
    'В gaps перечисли только сведения, которые нужны для ближайшего решения. ' +
    'Каждый пункт начни с одного простого вопроса клиенту, затем коротко объясни: ' +
    '«Зачем спрашиваем: ...» и какой рычаг в пути клиента это позволит настроить. ' +
    'Не задавай повторно то, что уже подтверждено в брифе, и не обещай быстрый рост продаж.';
  const user = [
    `Цель: ${clean(brief.goal, 1000) || 'не указано'}.`,
    `Продукт: ${clean(brief.product, 1000) || 'не указано'}.`,
    `Аудитория: ${clean(brief.audience, 1000) || 'не указано'}.`,
    `Боли: ${list(brief.pains, (p) => clean(p, 300))}.`,
    `Факты, разрешённые для контента: ${list((brief.confirmedFacts || []).filter((f) => f.approvedForContent === true),
      (f) => `${clean(f.statement, 300)} (источник: ${clean(f.source, 120)})`)}.`,
    `Исходники: ${list(brief.assets, (a) => `${clean(a.title, 200)} [${a.kind}]`)}.`,
    `Готовность к съёмке: ${brief.shootingComfort?.level || 'unknown'}.`,
    `Площадки: ${(brief.platforms || []).join(', ') || 'не указано'}.`,
  ].join('\n');
  return { system, messages: [{ role: 'user', content: user }] };
}

function extractObject(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function normalizeAnalysis(data) {
  const dropped = [];
  const rubrics = [];
  for (const row of Array.isArray(data.rubrics) ? data.rubrics : []) {
    if (rubrics.length >= MAX_RUBRICS) { dropped.push(`рубрик больше ${MAX_RUBRICS} — лишние отброшены`); break; }
    if (!row || typeof row !== 'object') { dropped.push('рубрика не является объектом'); continue; }
    const title = clean(row.title, 200);
    if (!title) { dropped.push('рубрика без названия'); continue; }
    const formats = (Array.isArray(row.formats) ? row.formats : [])
      .map((value) => clean(value, 20).toLowerCase())
      .filter((value, index, all) => FORMAT_KEYS.includes(value) && all.indexOf(value) === index);
    const askedFormats = Array.isArray(row.formats) ? row.formats.length : 0;
    // Молчаливая чистка скрыла бы, что модель предлагала формат, которого у нас нет.
    if (formats.length < askedFormats) dropped.push(`рубрика «${title}»: форматы вне словаря удалены`);
    rubrics.push({ title, why: clean(row.why, 500), formats });
  }
  const gaps = (Array.isArray(data.gaps) ? data.gaps : [])
    .map((value) => clean(value, 300)).filter(Boolean).slice(0, MAX_GAPS);
  return { positioning: clean(data.positioning, 1000), audience: clean(data.audience, 1000), rubrics, gaps, dropped };
}


/* Разбор статистики и правки плана.

   Главное правило, вынесенное в код, а не в просьбу к модели: площадка без данных не может
   получить вывод. Модель не знает, что «нет данных» и «ноль» — разные вещи, и охотно объясняет
   провал там, где просто не подключён доступ. Поэтому площадки с dataStatus no_data в задание
   не попадают, а выводы и правки, нацеленные на них, отбрасываются с причиной.

   Никаких «примерно» и «скорее всего» в цифрах: цифры берутся из снимка как есть,
   модель только объясняет и предлагает, что менять в плане. */
const ACTIONS = ['strengthen', 'reduce', 'test', 'keep'];
const ACTION_LABELS = Object.freeze({ strengthen: 'усилить', reduce: 'сократить',
  test: 'проверить тестом', keep: 'оставить как есть' });
const MAX_FINDINGS = 8, MAX_CHANGES = 8, MAX_QUESTIONS = 6;
const REVIEW_NOTICE = 'Это разбор модели по собранным цифрам. Ничего не изменено: правки плана ' +
  'вносит человек. Площадки без данных в разбор не попадают — отсутствие данных не является ' +
  'плохим результатом.';
const NO_DATA = 'Разбор не строится: ни по одной площадке нет собранных данных за период. ' +
  'Сначала подключите сбор статистики — выводы по пустым площадкам были бы выдумкой.';

/* Сжатая выжимка снимка: модели не нужен весь JSON аналитики, а лишние байты стоят денег. */
function statsDigest(overview) {
  const usable = [], skipped = [];
  for (const [code, platform] of Object.entries(overview?.platforms || {})) {
    if (!platform || platform.dataStatus === 'no_data') { skipped.push(code); continue; }
    const totals = Object.entries(platform.totals || {})
      .filter(([, value]) => typeof value === 'number')
      .map(([metric, value]) => `${metric}=${Math.round(value * 100) / 100}`);
    const followers = platform.latest?.followers?.value;
    usable.push({ code,
      line: `${code}: ${totals.join(', ') || 'показателей нет'}` +
        (typeof followers === 'number' ? `, подписчиков ${followers}` : '') +
        (platform.dataStatus === 'partial' ? ' (данные неполные)' : ''),
    });
  }
  return { usable, skipped };
}

function planDigest(plan) {
  if (!plan || !Array.isArray(plan.days) || !plan.days.length) return 'плана нет';
  const count = (key) => {
    const tally = new Map();
    for (const day of plan.days) tally.set(day[key], (tally.get(day[key]) || 0) + 1);
    return [...tally.entries()].map(([value, times]) => `${value}×${times}`).join(', ');
  };
  return `площадки: ${count('platform')}; форматы: ${count('format')}; роли: ${count('role')}`;
}

function reviewPrompt(overview, plan, digest) {
  const system = 'Ты медиа-наставник. Разбираешь результаты публикаций и предлагаешь правки плана. ' +
    'Отвечай ТОЛЬКО объектом JSON: {"findings":[{"statement":"...","basis":"..."}],' +
    '"planChanges":[{"action":"strengthen|reduce|test|keep","platform":"...","format":"",' +
    '"why":"..."}],"questions":["..."]}. ' +
    'Опирайся только на приведённые цифры: не добавляй показателей, которых нет, ' +
    'и не объясняй результат площадок, которых нет в списке. ' +
    'basis — та самая цифра из списка, на которой держится вывод. ' +
    'Если цифр мало для вывода, так и напиши в questions, а не додумывай.';
  const user = [
    `Период: ${overview?.from || '—'} — ${overview?.to || '—'}.`,
    `Собранные показатели по площадкам:\n${digest.usable.map((item) => `- ${item.line}`).join('\n')}`,
    digest.skipped.length ? `Площадки без данных (о них выводов не делай): ${digest.skipped.join(', ')}.` : '',
    `Текущий план: ${planDigest(plan)}.`,
  ].filter(Boolean).join('\n');
  return { system, messages: [{ role: 'user', content: user }] };
}

function normalizeReview(data, allowed) {
  const dropped = [];
  const findings = [];
  for (const row of Array.isArray(data.findings) ? data.findings : []) {
    if (findings.length >= MAX_FINDINGS) { dropped.push(`выводов больше ${MAX_FINDINGS} — лишние отброшены`); break; }
    const statement = clean(row?.statement, 500);
    if (!statement) continue;
    // Вывод без опоры на цифру — это мнение, а не разбор.
    const basis = clean(row?.basis, 300);
    if (!basis) { dropped.push(`вывод без опоры на цифру отброшен: ${statement.slice(0, 60)}`); continue; }
    findings.push({ statement, basis });
  }
  const planChanges = [];
  for (const row of Array.isArray(data.planChanges) ? data.planChanges : []) {
    if (planChanges.length >= MAX_CHANGES) { dropped.push(`правок больше ${MAX_CHANGES} — лишние отброшены`); break; }
    const action = clean(row?.action, 20).toLowerCase();
    if (!ACTIONS.includes(action)) { dropped.push(`действие вне словаря: ${action || 'пусто'}`); continue; }
    const platform = clean(row?.platform, 50).toLowerCase();
    if (platform && !allowed.has(platform)) { dropped.push(`правка по площадке без данных отброшена: ${platform}`); continue; }
    const format = clean(row?.format, 20).toLowerCase();
    if (format && !FORMAT_KEYS.includes(format)) { dropped.push(`формат правки вне словаря: ${format}`); continue; }
    const why = clean(row?.why, 500);
    if (!why) { dropped.push('правка без объяснения отброшена'); continue; }
    planChanges.push({ action, actionLabel: ACTION_LABELS[action], platform, format, why });
  }
  const questions = (Array.isArray(data.questions) ? data.questions : [])
    .map((value) => clean(value, 300)).filter(Boolean).slice(0, MAX_QUESTIONS);
  return { findings, planChanges, questions, dropped };
}

function createMediaMentorSuggest({ ask }) {
  if (typeof ask !== 'function') throw Error('Media mentor suggest requires ask');

  async function suggest(brief, { startDate, days = MIN_DAYS } = {}) {
    if (!brief || typeof brief !== 'object') throw Error('Нужен бриф компании');
    if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) throw Error(`План строится на ${MIN_DAYS}–${MAX_DAYS} дней`);
    if (!(brief.platforms || []).length) {
      return { status: 'brief_incomplete', items: [], dropped: [], notice: 'Сначала укажите площадки компании в брифе.' };
    }
    /* Сбой транспорта — не ошибка задания: обращения не было, план не строится.
       Исключение наружу не выпускаем, иначе кабинет покажет аварию вместо «повторите позже». */
    let raw;
    try { raw = await ask(JSON.stringify(buildPrompt(brief, { startDate, days }))); }
    catch { return { status: 'unavailable', items: [], dropped: [], notice: UNAVAILABLE }; }
    const answer = answerText(raw);
    if (!answer || !answer.text) return { status: 'unavailable', items: [], dropped: [], notice: UNAVAILABLE };
    const rows = extractArray(answer.text);
    if (!rows) {
      return { status: 'unusable', items: [], dropped: [], notice: UNUSABLE,
        provider: answer.provider || null, model: answer.model || null };
    }
    const { items, dropped } = normalize(rows, { brief, startDate, days });
    if (!items.length) {
      return { status: 'unusable', items: [], dropped, notice: UNUSABLE,
        provider: answer.provider || null, model: answer.model || null };
    }
    return { status: 'ok', items, dropped, notice: NOTICE,
      provider: answer.provider || null, model: answer.model || null,
      capabilities: { saved: false, approved: false, factsVerified: false } };
  }

  async function analyze(brief) {
    if (!brief || typeof brief !== 'object') throw Error('Нужен бриф компании');
    let raw;
    try { raw = await ask(JSON.stringify(analysisPrompt(brief))); }
    catch { return { status: 'unavailable', rubrics: [], gaps: [], dropped: [], notice: UNAVAILABLE }; }
    const answer = answerText(raw);
    if (!answer || !answer.text) return { status: 'unavailable', rubrics: [], gaps: [], dropped: [], notice: UNAVAILABLE };
    const data = extractObject(answer.text);
    if (!data) {
      return { status: 'unusable', rubrics: [], gaps: [], dropped: [], notice: UNUSABLE,
        provider: answer.provider || null, model: answer.model || null };
    }
    const result = normalizeAnalysis(data);
    // Разбор без позиционирования и без рубрик ничего не объясняет — это не результат.
    if (!result.positioning && !result.rubrics.length) {
      return { status: 'unusable', rubrics: [], gaps: [], dropped: result.dropped, notice: UNUSABLE,
        provider: answer.provider || null, model: answer.model || null };
    }
    return { status: 'ok', ...result, notice: ANALYSIS_NOTICE,
      provider: answer.provider || null, model: answer.model || null,
      capabilities: { saved: false, approved: false, factsVerified: false } };
  }

  async function review(overview, plan = null) {
    if (!overview || typeof overview !== 'object') throw Error('Нужен снимок статистики');
    const digest = statsDigest(overview);
    // Ни одной площадки с данными — к модели не идём: платить за выдумку незачем.
    if (!digest.usable.length) {
      return { status: 'no_data', findings: [], planChanges: [], questions: [], dropped: [],
        skipped: digest.skipped, notice: NO_DATA };
    }
    let raw;
    try { raw = await ask(JSON.stringify(reviewPrompt(overview, plan, digest))); }
    catch { return { status: 'unavailable', findings: [], planChanges: [], questions: [], dropped: [], notice: UNAVAILABLE }; }
    const answer = answerText(raw);
    if (!answer || !answer.text) {
      return { status: 'unavailable', findings: [], planChanges: [], questions: [], dropped: [], notice: UNAVAILABLE };
    }
    const data = extractObject(answer.text);
    if (!data) {
      return { status: 'unusable', findings: [], planChanges: [], questions: [], dropped: [], notice: UNUSABLE,
        provider: answer.provider || null, model: answer.model || null };
    }
    const result = normalizeReview(data, new Set(digest.usable.map((item) => item.code)));
    if (!result.findings.length && !result.planChanges.length) {
      return { status: 'unusable', findings: [], planChanges: [], questions: result.questions,
        dropped: result.dropped, notice: UNUSABLE, provider: answer.provider || null, model: answer.model || null };
    }
    return { status: 'ok', ...result, skipped: digest.skipped, notice: REVIEW_NOTICE,
      provider: answer.provider || null, model: answer.model || null,
      capabilities: { saved: false, planChanged: false, factsVerified: false } };
  }

  return { suggest, analyze, review, buildPrompt, analysisPrompt, reviewPrompt,
    MEDIA_MENTOR_SUGGEST_NOTICE: NOTICE, MEDIA_MENTOR_ANALYSIS_NOTICE: ANALYSIS_NOTICE };
}


/* HTTP-слой подсказки. Отдельный адрес /content/media-mentor-suggest, а не /media-mentor/...:
   маршруты медиа-наставника целиком проксируются в CRM, и подсказка не должна притворяться
   частью его хранилища. Бриф читается на сервере служебным ключом, а не принимается от клиента:
   иначе подсказку можно было бы построить на подложенном брифе чужой компании. */
const CODE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function createMediaMentorSuggestRoute({ suggester, loadBrief, loadStats, requireSession, requireCsrf,
  requirePermission, sendJson, readBody, fail }) {
  if (!suggester || typeof suggester.suggest !== 'function'
    || typeof suggester.analyze !== 'function'
    || typeof suggester.review !== 'function') throw Error('Route requires suggester');
  if (typeof loadBrief !== 'function') throw Error('Route requires loadBrief');
  if (typeof loadStats !== 'function') throw Error('Route requires loadStats');

  async function handle(request, response, url) {
    const analysing = url.pathname === '/content/media-mentor-analyze';
    const reviewing = url.pathname === '/content/media-mentor-review';
    if (!analysing && !reviewing && url.pathname !== '/content/media-mentor-suggest') return false;
    if (request.method !== 'POST') fail(405, 'Метод не поддерживается');
    const session = requireSession(request);
    requireCsrf(request, session);
    const code = url.searchParams.get('companyCode');
    if (!code || !CODE_RE.test(code)) fail(400, 'Выберите компанию');
    // Права те же, что у плана: подсказка — подготовка правки плана, а не отдельная власть.
    if (session.user?.role !== 'owner') requirePermission(request, 'autoposting.edit', code);
    const body = await readBody(request);
    const allowed = analysing ? [] : reviewing ? ['from', 'to'] : ['startDate', 'days'];
    const extra = Object.keys(body).filter((key) => !allowed.includes(key));
    if (extra.length) fail(400, 'Переданы лишние поля');
    let result;
    try {
      if (reviewing) {
        const stats = await loadStats(code, { from: body.from, to: body.to }, session.user);
        if (!stats) fail(404, 'Статистика компании не найдена');
        result = await suggester.review(stats.overview, stats.plan || null);
      } else {
        const brief = await loadBrief(code, session.user);
        if (!brief) fail(404, 'Бриф компании не найден');
        result = analysing ? await suggester.analyze(brief)
          : await suggester.suggest(brief, { startDate: body.startDate, days: body.days ?? MIN_DAYS });
      }
    }
    catch (error) { fail(400, error?.message || 'Не удалось построить предложение'); }
    sendJson(response, 200, { ...result, companyCode: code });
    return true;
  }

  return { handle };
}

module.exports = { createMediaMentorSuggest, createMediaMentorSuggestRoute,
  MEDIA_MENTOR_SUGGEST_NOTICE: NOTICE, MEDIA_MENTOR_ANALYSIS_NOTICE: ANALYSIS_NOTICE,
  MEDIA_MENTOR_REVIEW_NOTICE: REVIEW_NOTICE, MAX_RUBRICS, ACTIONS,
  MIN_DAYS, MAX_DAYS, MAX_ITEMS_PER_DAY, FORMAT_KEYS, ROLE_KEYS };

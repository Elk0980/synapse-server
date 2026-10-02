'use strict';

/* Бюджетный стоп резервных провайдеров Хью.

   Правило слоя: сомнение трактуется против расхода. Неизвестная цена, неизвестный расход,
   ошибка и таймаут не считаются нулём и не освобождают бронь без доказательства.

   Порядок работы:
   1. До обращения бронируется ВЕРХНЯЯ оценка стоимости и слот запроса — одной транзакцией,
      поэтому параллельные запросы не могут вместе перескочить границу.
   2. Верхняя оценка = байты запроса как потолок токенов запроса + жёсткий потолок ответа
      (max_tokens, он же уходит провайдеру).
   3. После ответа бронь уточняется фактическим расходом. Если провайдер не вернул usage,
      если была ошибка или таймаут — бронь остаётся в силе целиком.
   4. Освобождается бронь только когда провайдер явно отказался обрабатывать запрос
      (401, 403, 429): генерации не было.

   Конфигурация только явная, ничего не подставляется:
     HUGH_FALLBACK_BUDGET_USD=100            — граница расхода за окно
     HUGH_FALLBACK_BUDGET_MAX_REQUESTS=2000  — граница числа обращений за окно
     HUGH_FALLBACK_BUDGET_WINDOW_DAYS=30     — длина окна, по умолчанию 30
     HUGH_FALLBACK_BUDGET_MAX_OUTPUT_TOKENS=1200 — жёсткий потолок ответа

   Кроме общей границы у провайдера может быть СВОЙ лимит, заданный владельцем в кабинете
   («Лимит расходов, $»). Он считается по тому же окну и по тем же правилам, что общая
   граница, и действует вместе с ней: срабатывает та, которая наступит раньше. Провайдер,
   исчерпавший свой лимит, выбывает из резерва, а остальные продолжают отвечать.
   Личный лимит без объявленной цены провайдера не имеет смысла — тогда провайдер
   не используется, как и при общей денежной границе.
     HUGH_FALLBACK_<ПРОВАЙДЕР>_USD_PER_1K_PROMPT=…     — цена, объявленная владельцем
     HUGH_FALLBACK_<ПРОВАЙДЕР>_USD_PER_1K_COMPLETION=…
   Заданный ноль — это цена ноль. Не заданное значение — цена неизвестна, это разные вещи.
   Неверное значение любой из этих переменных ОСТАНАВЛИВАЕТ платный резерв: молча работать
   без границы, которую владелец пытался задать, нельзя.

   Чего слой не обещает: это локальная верхняя оценка, а не потолок на стороне провайдера.
   Провайдер может посчитать иначе, изменить цену или списать за запрос, ответ на который
   потерялся. Жёсткий потолок расхода даёт только ограничение в личном кабинете провайдера. */

const WINDOW_DEFAULT_DAYS = 30;
const DEFAULT_MAX_OUTPUT_TOKENS = 1200;
const MICRO = 1000000;
const NAME_RE = /^[a-z][a-z0-9_-]{0,30}$/i;
const GUARANTEE = 'local-estimate';
const NO_PROVIDER_CAP = 'Это локальная верхняя оценка, а не потолок на стороне провайдера: ' +
  'жёсткое ограничение расхода задаётся только в личном кабинете провайдера.';

const envKey = (name) => name.toUpperCase().replace(/-/g, '_');
const present = (value) => value !== undefined && value !== null && String(value).trim() !== '';
// Возвращает {ok,value} — чтобы отличить заданный ноль от неверного значения.
function money(value) {
  const parsed = Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1000000) return {ok: false, value: 0};
  return {ok: true, value: Math.round(parsed * MICRO)};
}
function whole(value, max = 100000000) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return {ok: false, value: 0};
  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) return {ok: false, value: 0};
  return {ok: true, value: parsed};
}

function readBudget(env = process.env) {
  const issues = [], invalid = [];
  const read = (name, parser, fallback = 0) => {
    if (!present(env[name])) return fallback;
    const parsed = parser(env[name]);
    if (!parsed.ok) { invalid.push(name); issues.push(`${name}: значение не распознано — платный резерв остановлен`); return fallback; }
    return parsed.value;
  };
  const limitMicroUsd = read('HUGH_FALLBACK_BUDGET_USD', money);
  const maxRequests = read('HUGH_FALLBACK_BUDGET_MAX_REQUESTS', (value) => whole(value));
  const windowDays = read('HUGH_FALLBACK_BUDGET_WINDOW_DAYS', (value) => whole(value, 3650), WINDOW_DEFAULT_DAYS) || WINDOW_DEFAULT_DAYS;
  const maxOutputTokens = read('HUGH_FALLBACK_BUDGET_MAX_OUTPUT_TOKENS', (value) => whole(value, 200000),
    DEFAULT_MAX_OUTPUT_TOKENS) || DEFAULT_MAX_OUTPUT_TOKENS;
  return {configured: limitMicroUsd > 0 || maxRequests > 0, limitMicroUsd, maxRequests, windowDays,
    maxOutputTokens, invalid, issues};
}

/* Цена провайдера: null — не задана (неизвестна), {invalid:true} — задана неверно,
   объект с нулями — владелец явно объявил нулевую цену. */
function readPrice(name, env = process.env) {
  if (!NAME_RE.test(String(name || ''))) return {invalid: true, reason: 'Недопустимое имя провайдера'};
  const key = envKey(name);
  const promptKey = `HUGH_FALLBACK_${key}_USD_PER_1K_PROMPT`;
  const completionKey = `HUGH_FALLBACK_${key}_USD_PER_1K_COMPLETION`;
  const hasPrompt = present(env[promptKey]), hasCompletion = present(env[completionKey]);
  if (!hasPrompt && !hasCompletion) return null;
  const prompt = hasPrompt ? money(env[promptKey]) : {ok: true, value: 0};
  const completion = hasCompletion ? money(env[completionKey]) : {ok: true, value: 0};
  if (!prompt.ok || !completion.ok) {
    return {invalid: true, reason: `Цена провайдера ${name}: значение не распознано`};
  }
  return {promptMicroUsdPer1k: prompt.value, completionMicroUsdPer1k: completion.value};
}

/* priceFor можно передать снаружи: цены провайдеров, введённые владельцем в ЛК, хранятся
   в своей таблице, а учёт расхода остаётся один и тот же. */
function createHughBudget({db, env = process.env, now = () => Date.now(), random = () => Math.random(),
  priceFor: priceOverride = null} = {}) {
  const config = readBudget(env);
  db.exec(`CREATE TABLE IF NOT EXISTS hugh_fallback_spend (
    window_start TEXT NOT NULL, provider TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0, unknown_requests INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
    micro_usd INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    PRIMARY KEY(window_start,provider));
    CREATE TABLE IF NOT EXISTS hugh_fallback_reservations (
    id TEXT PRIMARY KEY, window_start TEXT NOT NULL, provider TEXT NOT NULL,
    micro_usd INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('held','kept')),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS hugh_fallback_reservations_window
    ON hugh_fallback_reservations(window_start,state)`);
  // Scope links use the existing cost samples: settlement/release has one source of truth.
  db.exec(`CREATE TABLE IF NOT EXISTS content_plan_cost_scope (
    reservation_id TEXT PRIMARY KEY, company TEXT NOT NULL, job TEXT NOT NULL, window_start TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS content_plan_cost_scope_job ON content_plan_cost_scope(company,job);
    CREATE INDEX IF NOT EXISTS content_plan_cost_scope_window ON content_plan_cost_scope(company,window_start)`);
  // All six values must be explicitly positive. Company caps use the global budget window;
  // job caps span its entire resume lineage, across windows. No deployment defaults.
  // CONTENT_PLAN_JOB_BUDGET_USD / CONTENT_PLAN_JOB_MAX_REQUESTS
  // CONTENT_PLAN_COMPANY_BUDGET_USD / CONTENT_PLAN_COMPANY_MAX_REQUESTS
  // CONTENT_PLAN_CHAT_RESERVE_USD / CONTENT_PLAN_CHAT_RESERVE_REQUESTS
  // Chat reserve is a remaining-budget floor for plans, not a promise of provider balance.
  const planKeys = {
    jobUsd:['CONTENT_PLAN_JOB_BUDGET_USD',money], companyUsd:['CONTENT_PLAN_COMPANY_BUDGET_USD',money],
    jobRequests:['CONTENT_PLAN_JOB_MAX_REQUESTS',whole], companyRequests:['CONTENT_PLAN_COMPANY_MAX_REQUESTS',whole],
    chatUsd:['CONTENT_PLAN_CHAT_RESERVE_USD',money], chatRequests:['CONTENT_PLAN_CHAT_RESERVE_REQUESTS',whole]};
  const planPolicy = Object.fromEntries(Object.entries(planKeys).map(([key,[name,parse]])=>{
    const parsed=present(env[name])?parse(env[name]):{ok:false,value:0};
    return [key,parsed.ok&&parsed.value>0?parsed.value:null];
  }));
  function planReady(){return !configBlocked && config.limitMicroUsd>0 && config.maxRequests>0 &&
    Object.values(planPolicy).every(v=>v!==null) && planPolicy.chatUsd<config.limitMicroUsd && planPolicy.chatRequests<config.maxRequests;}
  function planTotals(company,job,start){
    return db.prepare(`SELECT COUNT(*) requests,COALESCE(SUM(s.micro_usd),0) microUsd
      FROM content_plan_cost_scope c JOIN ai_cost_samples s ON s.id=c.reservation_id
      WHERE c.company=? AND (? IS NULL OR c.job=?) AND (? IS NULL OR c.window_start=?)`).get(company,job,job,start,start);
  }
  const windowMs = config.windowDays * 24 * 60 * 60 * 1000;
  db.exec(`CREATE TABLE IF NOT EXISTS ai_cost_samples(id TEXT PRIMARY KEY,provider TEXT NOT NULL,
    created_at INTEGER NOT NULL,micro_usd INTEGER NOT NULL,priced INTEGER NOT NULL,state TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ai_cost_samples_time ON ai_cost_samples(created_at,provider);
    CREATE TABLE IF NOT EXISTS ai_economy_meta(id INTEGER PRIMARY KEY,started_at INTEGER NOT NULL)`);
  db.prepare('INSERT OR IGNORE INTO ai_economy_meta VALUES(1,?)').run(now());
  function rate(provider = null, at = now()) {
    const start = Math.max(db.prepare('SELECT started_at FROM ai_economy_meta WHERE id=1').get().started_at, at - 7 * 86400000);
    const rows = db.prepare(`SELECT COUNT(*) n,COALESCE(SUM(micro_usd),0) cost,
      COALESCE(SUM(CASE WHEN priced=0 THEN 1 ELSE 0 END),0) unpriced
      FROM ai_cost_samples WHERE created_at>=? AND created_at<=? AND (? IS NULL OR provider=?)`).get(start,at,provider,provider);
    const days = Math.max(0,(at-start)/86400000), enough = days>=1 && rows.n>=3 && !rows.unpriced;
    return {since:new Date(start).toISOString(),days,requests:rows.n,unpriced:rows.unpriced,
      usdPerDay:enough && rows.cost>0 ? rows.cost/MICRO/days : null,
      reason:rows.unpriced?'Есть обращения без известного тарифа':!enough?'Нужно не менее суток наблюдений и трёх обращений':rows.cost===0?'Недостаточно расхода для прогноза':'',
      basis:'local-estimate'};
  }
  const windowStartMs = (at) => Math.floor(at / windowMs) * windowMs;
  const windowStart = (at) => new Date(windowStartMs(at)).toISOString();
  const prices = new Map();
  const priceFor = (name) => {
    if (priceOverride) return priceOverride(name);
    if (!prices.has(name)) prices.set(name, readPrice(name, env));
    return prices.get(name);
  };
  // Неверная конфигурация границы — остановка, а не работа без границы.
  const configBlocked = config.invalid.length > 0;

  function totals(at = now()) {
    const start = windowStart(at);
    const spent = db.prepare(`SELECT COALESCE(SUM(requests),0) requests,COALESCE(SUM(unknown_requests),0) unknownRequests,
      COALESCE(SUM(micro_usd),0) microUsd FROM hugh_fallback_spend WHERE window_start=?`).get(start);
    const held = db.prepare(`SELECT COUNT(*) n,COALESCE(SUM(micro_usd),0) microUsd,
      COALESCE(SUM(CASE WHEN state='kept' THEN 1 ELSE 0 END),0) kept
      FROM hugh_fallback_reservations WHERE window_start=?`).get(start);
    return {requests: spent.requests + held.n, microUsd: spent.microUsd + held.microUsd,
      unknownRequests: spent.unknownRequests + held.kept, heldRequests: held.n, heldMicroUsd: held.microUsd};
  }

  /* Расход одного провайдера за то же окно: у личного лимита не может быть своего счётчика,
     иначе два лимита считали бы по-разному и расходились. */
  function providerTotals(provider, at = now()) {
    const start = windowStart(at), name = String(provider);
    const spent = db.prepare(`SELECT COALESCE(SUM(requests),0) requests,COALESCE(SUM(micro_usd),0) microUsd
      FROM hugh_fallback_spend WHERE window_start=? AND provider=?`).get(start, name);
    const held = db.prepare(`SELECT COUNT(*) n,COALESCE(SUM(micro_usd),0) microUsd
      FROM hugh_fallback_reservations WHERE window_start=? AND provider=?`).get(start, name);
    return {requests: spent.requests + held.n, microUsd: spent.microUsd + held.microUsd};
  }

  /* Состояние личного лимита провайдера. limitMicroUsd не задан — ограничения нет,
     и это честно видно в ответе, а не подменяется нулём. */
  function providerState(provider, limitMicroUsd = null, at = now()) {
    const used = providerTotals(provider, at);
    const limit = Number.isSafeInteger(limitMicroUsd) && limitMicroUsd > 0 ? limitMicroUsd : 0;
    const reached = limit > 0 && used.microUsd >= limit;
    return {provider: String(provider), spentUsd: used.microUsd / MICRO, requests: used.requests,
      remainingUsd:limit>0?Math.max(0,(limit-used.microUsd)/MICRO):null,rate:rate(String(provider),at),
      limitUsd: limit > 0 ? limit / MICRO : null, stopped: reached,
      reason: reached ? `Достигнут личный лимит расходов провайдера ${provider}` : ''};
  }

  function state(at = now()) {
    const used = totals(at);
    const byUsd = config.limitMicroUsd > 0 && used.microUsd >= config.limitMicroUsd;
    const byRequests = config.maxRequests > 0 && used.requests >= config.maxRequests;
    return {configured: config.configured, blockedByConfig: configBlocked,
      windowStart: windowStart(at), windowDays: config.windowDays,
      resetAt: new Date(windowStartMs(at) + windowMs).toISOString(),
      spentUsd: used.microUsd / MICRO, limitUsd: config.limitMicroUsd / MICRO,
      requests: used.requests, maxRequests: config.maxRequests,
      remainingUsd:config.limitMicroUsd>0?Math.max(0,(config.limitMicroUsd-used.microUsd)/MICRO):null,
      remainingRequests:config.maxRequests>0?Math.max(0,config.maxRequests-used.requests):null,rate:rate(null,at),
      unknownRequests: used.unknownRequests, heldRequests: used.heldRequests,
      heldUsd: used.heldMicroUsd / MICRO, maxOutputTokens: config.maxOutputTokens, guarantee: GUARANTEE,
      stopped: configBlocked || byUsd || byRequests,
      reason: configBlocked ? 'Границы бюджета заданы неверно: платный резерв остановлен'
        : byUsd ? 'Достигнута граница расхода резервных провайдеров'
          : byRequests ? 'Достигнута граница числа обращений к резервным провайдерам' : ''};
  }
  const stopped = (at = now()) => state(at).stopped;

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const newId = () => `${now().toString(36)}-${Math.floor(random() * 1e12).toString(36)}-${Math.floor(random() * 1e12).toString(36)}`;

  /* Бронь верхней оценки до обращения. Одна транзакция на проверку и запись, поэтому
     два параллельных запроса не могут вместе выйти за границу. */
  function reserve(provider, {promptBytes = 0, maxOutputTokens = null, limitMicroUsd = null, contentPlan = null} = {}) {
    if(contentPlan && (!planReady() || typeof contentPlan.company!=='string' || !/^[a-z0-9_-]{1,80}$/i.test(contentPlan.company) ||
      typeof contentPlan.job!=='string' || !/^[a-z0-9_-]{1,100}$/i.test(contentPlan.job)))
      return {allowed:false,reason:'Лимиты подготовки плана и резерв клиентских ответов не настроены'};
    const ownLimit = Number.isSafeInteger(limitMicroUsd) && limitMicroUsd > 0 ? limitMicroUsd : 0;
    const at = now(), price = priceFor(provider);
    if (configBlocked) return {allowed: false, reason: state(at).reason};
    if (price && price.invalid) {
      return {allowed: false, reason: `${price.reason || 'Цена провайдера задана неверно'}: платный резерв остановлен`};
    }
    // При денежной границе провайдер без объявленной цены не используется:
    // иначе его расход учитывался бы нулём и граница ничего не ограничивала бы.
    if ((config.limitMicroUsd > 0 || ownLimit > 0 || contentPlan) && !price) {
      return {allowed: false, unpriced: true,
        reason: `Цена провайдера ${provider} не задана: при денежной границе он не используется`};
    }
    const promptTokensBound = Math.max(0, Math.ceil(promptBytes));
    // Потолок ответа берётся фактический: у проверки соединения он меньше общего.
    const outputBound = Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0
      ? Math.min(maxOutputTokens, config.maxOutputTokens) : config.maxOutputTokens;
    const estimate = price
      ? Math.ceil((promptTokensBound / 1000) * price.promptMicroUsdPer1k)
        + Math.ceil((outputBound / 1000) * price.completionMicroUsdPer1k)
      : 0;
    return transaction(() => {
      const current = state(at);
      if (current.stopped) return {allowed: false, reason: current.reason};
      const used = totals(at);
      if (config.limitMicroUsd > 0 && used.microUsd + estimate > config.limitMicroUsd) {
        return {allowed: false, reason: 'Верхняя оценка стоимости запроса не умещается в остаток бюджета'};
      }
      if (config.maxRequests > 0 && used.requests + 1 > config.maxRequests) {
        return {allowed: false, reason: 'Достигнута граница числа обращений к резервным провайдерам'};
      }
      if(contentPlan){
        const company=contentPlan.company.toLowerCase();
        const jobUsed=planTotals(company,contentPlan.job,null),companyUsed=planTotals(company,null,windowStart(at));
        if(jobUsed.requests+1>planPolicy.jobRequests || jobUsed.microUsd+estimate>planPolicy.jobUsd ||
          companyUsed.requests+1>planPolicy.companyRequests || companyUsed.microUsd+estimate>planPolicy.companyUsd ||
          used.requests+1>config.maxRequests-planPolicy.chatRequests || used.microUsd+estimate>config.limitMicroUsd-planPolicy.chatUsd)
          return {allowed:false,reason:'Достигнут лимит подготовки плана или резерв клиентских ответов'};
      }
      // Личный лимит проверяется в той же транзакции, что и общий: иначе параллельные
      // запросы одного провайдера вместе перескочили бы его границу.
      if (ownLimit > 0) {
        const own = providerTotals(provider, at);
        if (own.microUsd + estimate > ownLimit) {
          return {allowed: false, ownLimitReached: true,
            reason: `Верхняя оценка запроса не умещается в личный лимит провайдера ${provider}`};
        }
      }
      const id = newId(), stamp = new Date(at).toISOString();
      db.prepare(`INSERT INTO hugh_fallback_reservations(id,window_start,provider,micro_usd,state,created_at,updated_at)
        VALUES(?,?,?,?,'held',?,?)`).run(id, windowStart(at), String(provider), estimate, stamp, stamp);
      db.prepare("INSERT INTO ai_cost_samples VALUES(?,?,?,?,?,'held')").run(id,String(provider),at,estimate,price?1:0);
      if(contentPlan)db.prepare('INSERT INTO content_plan_cost_scope VALUES(?,?,?,?)').run(id,contentPlan.company.toLowerCase(),contentPlan.job,windowStart(at));
      return {allowed: true, id, provider: String(provider), estimateMicroUsd: estimate,
        estimateUsd: estimate / MICRO, maxOutputTokens: outputBound, priced: Boolean(price)};
    });
  }

  const reservation = (id) => db.prepare('SELECT * FROM hugh_fallback_reservations WHERE id=?').get(id) || null;
  function addSpend(provider, windowStartValue, {requests = 0, unknownRequests = 0, promptTokens = 0,
    completionTokens = 0, microUsd = 0} = {}) {
    db.prepare(`INSERT INTO hugh_fallback_spend(window_start,provider,requests,unknown_requests,prompt_tokens,
      completion_tokens,micro_usd,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(window_start,provider) DO UPDATE SET requests=requests+excluded.requests,
      unknown_requests=unknown_requests+excluded.unknown_requests,prompt_tokens=prompt_tokens+excluded.prompt_tokens,
      completion_tokens=completion_tokens+excluded.completion_tokens,micro_usd=micro_usd+excluded.micro_usd,
      updated_at=excluded.updated_at`)
      .run(windowStartValue, String(provider), requests, unknownRequests, promptTokens, completionTokens,
        microUsd, new Date(now()).toISOString());
  }

  /* Уточнение брони фактическим расходом. Факт известен только если провайдер вернул usage
     и цена объявлена; иначе бронь сохраняется целиком как неизвестный расход. */
  function settle(id, usage = {}) {
    const row = reservation(id);
    if (!row || row.state !== 'held') return {settled: false};
    const price = priceFor(row.provider);
    const promptTokens = whole(usage.promptTokens ?? '').value;
    const completionTokens = whole(usage.completionTokens ?? '').value;
    const known = Boolean(price) && !price.invalid && (present(usage.promptTokens) || present(usage.completionTokens));
    return transaction(() => {
      if (!known) {
        db.prepare("UPDATE hugh_fallback_reservations SET state='kept',updated_at=? WHERE id=? AND state='held'")
          .run(new Date(now()).toISOString(), id);
        return {settled: false, kept: true, microUsd: row.micro_usd};
      }
      const actual = Math.ceil((promptTokens / 1000) * price.promptMicroUsdPer1k)
        + Math.ceil((completionTokens / 1000) * price.completionMicroUsdPer1k);
      db.prepare("UPDATE ai_cost_samples SET micro_usd=?,state='settled',priced=1 WHERE id=?").run(actual,id);
      db.prepare('DELETE FROM hugh_fallback_reservations WHERE id=?').run(id);
      addSpend(row.provider, row.window_start, {requests: 1, promptTokens, completionTokens, microUsd: actual});
      return {settled: true, microUsd: actual};
    });
  }

  /* Ошибка, таймаут и потерянный ответ: бронь остаётся в силе. Доказательства, что провайдер
     ничего не потратил, у нас нет, а занижать расход нельзя. */
  function keep(id) {
    const row = reservation(id);
    if (!row || row.state !== 'held') return {kept: false};
    db.prepare("UPDATE hugh_fallback_reservations SET state='kept',updated_at=? WHERE id=? AND state='held'")
      .run(new Date(now()).toISOString(), id);
    return {kept: true, microUsd: row.micro_usd};
  }

  /* Освобождение только при явном отказе провайдера обрабатывать запрос (401, 403, 429):
     генерации не было, значит и расхода нет. */
  function release(id) {
    const row = reservation(id);
    if (!row || row.state !== 'held') return {released: false};
    transaction(() => {
      db.prepare("DELETE FROM hugh_fallback_reservations WHERE id=? AND state='held'").run(id);
      db.prepare('DELETE FROM ai_cost_samples WHERE id=?').run(id);
      db.prepare('DELETE FROM content_plan_cost_scope WHERE reservation_id=?').run(id);
    });
    return {released: true, microUsd: row.micro_usd};
  }

  /* После перезапуска зависшие брони не освобождаются: они переводятся в неизвестный расход
     и продолжают занимать бюджет. Занижать расход после аварии нельзя. */
  function recover({staleMs = 15 * 60 * 1000} = {}) {
    const limit = new Date(now() - staleMs).toISOString();
    const result = db.prepare("UPDATE hugh_fallback_reservations SET state='kept',updated_at=? WHERE state='held' AND created_at<=?")
      .run(new Date(now()).toISOString(), limit);
    return {kept: result.changes};
  }

  function status(at = now()) {
    const current = state(at), issues = [...config.issues];
    if (!config.configured && !configBlocked) {
      issues.push('Бюджетный стоп не настроен: задайте HUGH_FALLBACK_BUDGET_USD или HUGH_FALLBACK_BUDGET_MAX_REQUESTS');
    }
    if (current.unknownRequests > 0) {
      issues.push(`Обращений с неизвестным фактическим расходом: ${current.unknownRequests}. ` +
        'Их верхняя оценка продолжает занимать бюджет и не освобождается без доказательства.');
    }
    if (config.configured) issues.push(NO_PROVIDER_CAP);
    return {...current, issues};
  }

  return {planReady, planTotals, config, state, stopped, reserve, settle, keep, release, recover, status, priceFor, totals,
    providerTotals, providerState, reservation, rate};
}

module.exports = {createHughBudget, readBudget, readPrice, WINDOW_DEFAULT_DAYS,
  DEFAULT_MAX_OUTPUT_TOKENS, BUDGET_GUARANTEE: GUARANTEE, BUDGET_NO_PROVIDER_CAP: NO_PROVIDER_CAP};

'use strict';

/* Защищённое хранилище настроек провайдеров Хью для владельца ЛК.

   Схема шифрования повторяет уже работающую в автопостинге (ops/crm/autoposting-transport.js):
   AES-256-GCM, случайные salt и IV на каждую запись, ключ выводится HKDF-SHA256 из внешнего
   мастер-ключа, AAD привязывает запись к своему пространству имён и имени провайдера.

   Обязательные свойства:
   - Ключ write-only. Он не возвращается ни в одном ответе, не попадает в DOM, журналы,
     Git и браузерное хранилище. Наружу видно только «ключ задан» и когда он задан.
   - Без внешнего мастер-ключа HUGH_PROVIDER_MASTER_KEY хранилище закрыто: сохранить ключ
     нельзя, существующие ключи не читаются. Имитировать безопасность без ключа нельзя.
   - Произвольный адрес запретён: хост должен быть в списке официальных, только https,
     без логина, пароля, нестандартного порта и IP-литерала. Это отсекает SSRF.
   - Сохранение ничего не включает и не тратит денег: провайдер по умолчанию выключен,
     а «сохранено» и «проверено» — разные состояния.
   - Реализован ровно один контракт: OpenAI-совместимый POST {base}/chat/completions,
     тот самый, что уже умеет ops/content/hugh-fallback.js. Никаких догадок про другие API.  */

const crypto = require('node:crypto');
const {createHughBudget} = require('./hugh-budget');

const NAMESPACE = 'synapse/hugh-provider/v1';
const MIN_MASTER_KEY = 32;
const API_STYLE = 'openai-chat-completions';
/* Список официальных хостов кандидатов. Он ограничивает адрес, но НЕ подтверждает, что провайдер
   совместим с нашим контрактом: совместимость подтверждается только успешной проверкой.
   Оператор сервера может дополнить список через HUGH_PROVIDER_ALLOWED_HOSTS. */
const CATALOG = Object.freeze([
  {name: 'zai', title: 'Z.ai (GLM)', hosts: ['api.z.ai', 'open.bigmodel.cn'], console: 'https://z.ai/manage-apikey/billing', contractSupported: true},
  {name: 'qwen', title: 'Alibaba Model Studio (Qwen)', hosts: ['dashscope-intl.aliyuncs.com', 'dashscope.aliyuncs.com'], console: 'https://modelstudio.console.alibabacloud.com/', contractSupported: true},
  {name: 'deepseek', title: 'DeepSeek', hosts: ['api.deepseek.com'], console: 'https://platform.deepseek.com/', contractSupported: true},
  {name: 'gemini', title: 'Google Gemini', hosts: ['generativelanguage.googleapis.com'], console: 'https://aistudio.google.com/apikey', contractSupported: true},
  {name: 'mistral', title: 'Mistral', hosts: ['api.mistral.ai'], console: 'https://console.mistral.ai/', contractSupported: true},
  {name: 'openai', title: 'OpenAI (резерв)', hosts: ['api.openai.com'], console: 'https://platform.openai.com/', contractSupported: true},
  /* Anthropic Messages API устроен иначе, чем реализованный у нас OpenAI-совместимый
     /chat/completions. Непроверенный адаптер не пишем: кандидат помечен недоступным
     через этот контракт, ключ для него не принимается. */
  {name: 'anthropic', title: 'Anthropic (резерв)', hosts: ['api.anthropic.com'], console: 'https://console.anthropic.com/',
    contractSupported: false, unsupportedReason: 'Через реализованный контракт OpenAI-совместимого /chat/completions этот провайдер не подключается: его API устроен иначе. Адаптер не написан.'},
]);
const BY_NAME = new Map(CATALOG.map((item) => [item.name, item]));
const SECRET_RE = /(?:^|[^A-Za-z0-9])(?:token|secret|password)(?:[^A-Za-z0-9]|$)/i;

function fail(status, message, code) {
  throw Object.assign(new Error(message), {status, details: code ? {code} : undefined});
}

function extraHosts(env) {
  return String(env.HUGH_PROVIDER_ALLOWED_HOSTS || '').split(',').map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-z0-9.-]{3,253}$/.test(value));
}

/* Адрес принимается только из списка: произвольный URL и внутренние адреса невозможны. */
function checkBaseUrl(value, provider, env) {
  if (typeof value !== 'string' || value.length > 300) fail(400, 'Проверьте адрес API');
  const clean = value.trim().replace(/\/+$/, '');
  let url;
  try { url = new URL(clean); } catch { fail(400, 'Адрес API должен быть полным https-адресом'); }
  if (url.protocol !== 'https:') fail(400, 'Адрес API должен начинаться с https://');
  if (url.username || url.password) fail(400, 'Адрес API не должен содержать логин и пароль');
  if (url.port && url.port !== '443') fail(400, 'Адрес API должен использовать стандартный порт');
  if (url.search || url.hash) fail(400, 'Адрес API не должен содержать параметров');
  const host = url.hostname.toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) fail(400, 'Адрес по IP не принимается');
  const allowed = new Set([...(BY_NAME.get(provider)?.hosts || []), ...extraHosts(env)]);
  if (!allowed.has(host)) {
    fail(400, `Хост ${host} не входит в список официальных адресов этого провайдера`, 'HOST_NOT_ALLOWED');
  }
  if (/\.\.|\/\//.test(url.pathname)) fail(400, 'Проверьте путь адреса API');
  return `https://${host}${url.pathname.replace(/\/+$/, '')}`;
}

function createHughProviders({db, env = process.env, now = () => Date.now()} = {}) {
  const masterKey = String(env.HUGH_PROVIDER_MASTER_KEY || '');
  // Fail-closed: без надёжного мастер-ключа хранилище не работает и не притворяется рабочим.
  const available = masterKey.length >= MIN_MASTER_KEY;
  const lockedReason = masterKey
    ? `HUGH_PROVIDER_MASTER_KEY короче ${MIN_MASTER_KEY} символов: хранилище ключей закрыто`
    : 'HUGH_PROVIDER_MASTER_KEY не задан: хранилище ключей закрыто, сохранить ключ нельзя';
  db.exec(`CREATE TABLE IF NOT EXISTS hugh_provider_settings(
    name TEXT PRIMARY KEY, base_url TEXT NOT NULL DEFAULT '', model_id TEXT NOT NULL DEFAULT '',
    encrypted_key TEXT NOT NULL DEFAULT '', key_set_at TEXT, enabled INTEGER NOT NULL DEFAULT 0,
    timeout_ms INTEGER NOT NULL DEFAULT 60000, max_output_tokens INTEGER NOT NULL DEFAULT 1200,
    price_prompt_micro INTEGER, price_completion_micro INTEGER, budget_usd_micro INTEGER,
    revision INTEGER NOT NULL DEFAULT 0, check_state TEXT NOT NULL DEFAULT 'not_checked',
    check_message TEXT NOT NULL DEFAULT '', checked_at TEXT, checked_revision INTEGER,
    updated_at TEXT NOT NULL, updated_by TEXT NOT NULL DEFAULT '')`);
  /* config_revision меняется только при правке того, что влияет на соединение: адрес, модель,
     ключ. Включение и выключение, цены и лимиты проверку не обесценивают. */
  const columns = new Set(db.prepare('PRAGMA table_info(hugh_provider_settings)').all().map((row) => row.name));
  if (!columns.has('config_revision')) db.exec('ALTER TABLE hugh_provider_settings ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 0');
  const budget = createHughBudget({db, env, now, priceFor: (name) => {
    const saved = db.prepare('SELECT price_prompt_micro,price_completion_micro FROM hugh_provider_settings WHERE name=?').get(name);
    if (!saved || saved.price_prompt_micro === null || saved.price_completion_micro === null) return null;
    return {promptMicroUsdPer1k: saved.price_prompt_micro, completionMicroUsdPer1k: saved.price_completion_micro};
  }});

  function crypt(name, value, decrypt = false) {
    if (!available) fail(503, lockedReason, 'SECRET_STORE_LOCKED');
    const aad = Buffer.from(`${NAMESPACE}/${name}`);
    const envelope = decrypt ? JSON.parse(value)
      : {v: 1, salt: crypto.randomBytes(16).toString('base64'), iv: crypto.randomBytes(12).toString('base64')};
    if (envelope.v !== 1) throw new Error('Invalid credential envelope');
    const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(masterKey), Buffer.from(envelope.salt, 'base64'), aad, 32));
    try {
      const cipher = decrypt ? crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
        : crypto.createCipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      cipher.setAAD(aad);
      if (decrypt) {
        cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        return Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()]).toString('utf8');
      }
      envelope.data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64');
      envelope.tag = cipher.getAuthTag().toString('base64');
      return JSON.stringify(envelope);
    } finally { key.fill(0); }
  }

  const row = (name) => db.prepare('SELECT * FROM hugh_provider_settings WHERE name=?').get(name) || null;
  const money = (value, name) => {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1000000) fail(400, `Проверьте ${name}`);
    return Math.round(parsed * 1000000);
  };
  const whole = (value, name, min, max, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail(400, `Проверьте ${name}`);
    return parsed;
  };

  /* Наружу никогда не уходит ключ. Только признак «задан», когда задан, и что проверено. */
  // Проверка считается действующей, только если она сделана для нынешней версии соединения.
  const checkCurrent = (saved) => Boolean(saved && saved.check_state === 'ok' &&
    saved.checked_revision !== null && saved.checked_revision === saved.config_revision);

  function view(name) {
    const item = BY_NAME.get(name), saved = row(name);
    return {name, title: item.title, console: item.console, hosts: [...item.hosts], apiStyle: API_STYLE,
      contractSupported: item.contractSupported !== false,
      unsupportedReason: item.contractSupported === false ? item.unsupportedReason : '',
      configRevision: saved?.config_revision || 0, checkCurrent: checkCurrent(saved),
      baseUrl: saved?.base_url || '', modelId: saved?.model_id || '',
      keyConfigured: Boolean(saved?.encrypted_key), keySetAt: saved?.key_set_at || null,
      enabled: Boolean(saved?.enabled), timeoutMs: saved?.timeout_ms ?? 60000,
      maxOutputTokens: saved?.max_output_tokens ?? 1200,
      pricePromptUsdPer1k: saved?.price_prompt_micro === null || saved?.price_prompt_micro === undefined
        ? null : saved.price_prompt_micro / 1000000,
      priceCompletionUsdPer1k: saved?.price_completion_micro === null || saved?.price_completion_micro === undefined
        ? null : saved.price_completion_micro / 1000000,
      budgetUsd: saved?.budget_usd_micro === null || saved?.budget_usd_micro === undefined
        ? null : saved.budget_usd_micro / 1000000,
      revision: saved?.revision || 0,
      // «Сохранено» и «проверено» — разные состояния и показываются раздельно.
      saved: Boolean(saved), checkState: saved?.check_state || 'not_checked',
      checkMessage: saved?.check_message || '', checkedAt: saved?.checked_at || null,
      checkStale: Boolean(saved && saved.checked_revision !== null && saved.checked_revision !== saved.config_revision),
      updatedAt: saved?.updated_at || null, updatedBy: saved?.updated_by || '',
      /* Расход за текущее окно и состояние личного лимита. Владелец должен видеть
         потраченное до того, как провайдер замолчит, а не узнавать об этом из тишины
         в чате. Цифры считает бюджетный модуль по своей таблице, здесь их не пересчитываем. */
      spend: budget.providerState(name, saved?.budget_usd_micro ?? null)};
  }

  const status = () => {
    /* Причина отсева считается один раз на весь ответ: иначе каждая карточка
       заново расшифровывала бы ключ ради одной строки текста. */
    const report = available ? runtimeReport() : {ready: [], skipped: []};
    const skipped = new Map(report.skipped.map((item) => [item.name, item.reason]));
    const ready = new Set(report.ready.map((item) => item.name));
    return {storeAvailable: available, lockedReason: available ? '' : lockedReason,
    apiStyle: API_STYLE,
    providers: CATALOG.map((item) => ({...view(item.name),
      // «Включён» в настройке и «участвует в ответах» — разные вещи, и разница названа.
      inRuntime: ready.has(item.name), runtimeSkipReason: skipped.get(item.name) || ''})),
    readyCount: report.ready.length,
    /* Общая граница расхода — одна на всех и главнее личных. Показываем её рядом,
       иначе личный лимит читается как полная картина, а это не так. */
    budget: budget.state(),
    notice: 'Ключ хранится зашифрованным и не возвращается ни в одном ответе. Сохранение ничего ' +
      'не включает и не списывает денег: провайдер остаётся выключенным, пока его не включат ' +
      'отдельно, а «сохранено» не означает «проверено». Реализован один контракт: ' +
      'OpenAI-совместимый /chat/completions. Совместимость подтверждается только успешной проверкой.'};
  };

  function save(name, body, actor = {}) {
    if (!BY_NAME.has(name)) fail(404, 'Неизвестный провайдер', 'NOT_FOUND');
    const item = BY_NAME.get(name);
    // Неподтверждённый адаптер не пишем и вид работы не изображаем.
    if (item.contractSupported === false) fail(400, item.unsupportedReason, 'CONTRACT_NOT_SUPPORTED');
    if (!available) fail(503, lockedReason, 'SECRET_STORE_LOCKED');
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some((key) => !['revision', 'baseUrl', 'modelId', 'apiKey', 'enabled', 'timeoutMs',
        'maxOutputTokens', 'pricePromptUsdPer1k', 'priceCompletionUsdPer1k', 'budgetUsd'].includes(key))) {
      fail(400, 'Неизвестные поля настройки провайдера');
    }
    const current = row(name);
    if (!Number.isSafeInteger(body.revision) || body.revision < 0) fail(400, 'Укажите версию настройки');
    if (body.revision !== (current?.revision || 0)) fail(409, 'Настройка уже изменена. Обновите страницу.', 'REVISION_CONFLICT');
    const baseUrl = checkBaseUrl(body.baseUrl ?? current?.base_url ?? '', name, env);
    // Фактический идентификатор модели вводит человек: он не выводится из названия провайдера.
    const modelId = String(body.modelId ?? current?.model_id ?? '').trim();
    if (!modelId || modelId.length > 200 || /[\s\x00]/.test(modelId)) fail(400, 'Укажите фактический идентификатор модели');
    let encrypted = current?.encrypted_key || '', keySetAt = current?.key_set_at || null;
    if (body.apiKey !== undefined && body.apiKey !== null && body.apiKey !== '') {
      const value = String(body.apiKey);
      if (value.length < 8 || value.length > 2048 || /[\s\x00]/.test(value)) fail(400, 'Проверьте ключ API');
      if (SECRET_RE.test(value)) fail(400, 'Похоже, вставлено название поля, а не ключ');
      encrypted = crypt(name, value);
      keySetAt = new Date(now()).toISOString();
    }
    const enabled = body.enabled === undefined ? Boolean(current?.enabled) : Boolean(body.enabled);
    // Включить без ключа нельзя: иначе «включено» было бы неправдой.
    if (enabled && !encrypted) fail(400, 'Сначала сохраните ключ этого провайдера');
    /* Версия соединения растёт только от адреса, модели и ключа. Прежняя проверка после этого
       недействительна, поэтому включить провайдера той же операцией нельзя. */
    const keyChanged = encrypted !== (current?.encrypted_key || '');
    const materialChanged = !current || keyChanged || baseUrl !== current.base_url || modelId !== current.model_id;
    const configRevision = (current?.config_revision || 0) + (materialChanged ? 1 : 0);
    const checkValid = !materialChanged && checkCurrent(current);
    if (enabled && !checkValid) {
      fail(400, materialChanged
        ? 'Адрес, модель или ключ изменились: сначала сохраните, затем проверьте соединение, и только потом включайте'
        : 'Включить можно только после успешной проверки соединения этой настройки', 'CHECK_REQUIRED');
    }
    const timeoutMs = whole(body.timeoutMs, 'таймаут', 5000, 180000, current?.timeout_ms ?? 60000);
    const maxOutputTokens = whole(body.maxOutputTokens, 'потолок ответа', 1, 200000, current?.max_output_tokens ?? 1200);
    const pricePrompt = body.pricePromptUsdPer1k === undefined ? (current?.price_prompt_micro ?? null)
      : money(body.pricePromptUsdPer1k, 'цену запроса');
    const priceCompletion = body.priceCompletionUsdPer1k === undefined ? (current?.price_completion_micro ?? null)
      : money(body.priceCompletionUsdPer1k, 'цену ответа');
    const budget = body.budgetUsd === undefined ? (current?.budget_usd_micro ?? null) : money(body.budgetUsd, 'лимит расходов');
    const time = new Date(now()).toISOString();
    const by = String(actor.userName || '').slice(0, 200);
    db.prepare(`INSERT INTO hugh_provider_settings(name,base_url,model_id,encrypted_key,key_set_at,enabled,
      timeout_ms,max_output_tokens,price_prompt_micro,price_completion_micro,budget_usd_micro,revision,
      config_revision,check_state,check_message,checked_at,checked_revision,updated_at,updated_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,'not_checked','',NULL,NULL,?,?)
      ON CONFLICT(name) DO UPDATE SET base_url=excluded.base_url,model_id=excluded.model_id,
      encrypted_key=excluded.encrypted_key,key_set_at=excluded.key_set_at,enabled=excluded.enabled,
      timeout_ms=excluded.timeout_ms,max_output_tokens=excluded.max_output_tokens,
      price_prompt_micro=excluded.price_prompt_micro,price_completion_micro=excluded.price_completion_micro,
      budget_usd_micro=excluded.budget_usd_micro,revision=hugh_provider_settings.revision+1,
      config_revision=excluded.config_revision,
      updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .run(name, baseUrl, modelId, encrypted, keySetAt, enabled ? 1 : 0, timeoutMs, maxOutputTokens,
        pricePrompt, priceCompletion, budget, configRevision, time, by);
    return view(name);
  }

  /* Проверка соединения — отдельное явное действие. Она не включает провайдера
     и выполняется с минимальным запросом и жёстким потолком ответа. */
  const CHECK_MAX_OUTPUT_TOKENS = 1;
  /* Ответ считается подтверждающим контракт только по структуре: непустой массив choices,
     в первом элементе объект message с ролью и полем content допустимого типа.
     Пустой текст при max_tokens=1 допустим и подтверждением не мешает; пустой JSON — не ответ. */
  function contractOk(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (!choice || typeof choice !== 'object') return false;
    const message = choice.message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
    if (typeof message.role !== 'string' || !message.role) return false;
    return typeof message.content === 'string' || Array.isArray(message.content) || message.content === null;
  }
  // Секрет не должен попасть в сообщение проверки, даже если провайдер вернул его в model или error.
  const scrub = (value, secret) => {
    let text = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (secret && secret.length >= 8) text = text.split(secret).join('[ключ скрыт]');
    return text;
  };

  async function check(name, {fetchImpl = (...args) => globalThis.fetch(...args)} = {}) {
    if (!BY_NAME.has(name)) fail(404, 'Неизвестный провайдер', 'NOT_FOUND');
    const item = BY_NAME.get(name);
    if (item.contractSupported === false) fail(400, item.unsupportedReason, 'CONTRACT_NOT_SUPPORTED');
    if (!available) fail(503, lockedReason, 'SECRET_STORE_LOCKED');
    const current = row(name);
    if (!current || !current.encrypted_key) fail(400, 'Сначала сохраните ключ этого провайдера');
    // Снимок версии соединения до обращения: результат применяется только к ней.
    const snapshot = current.config_revision;
    let secret;
    try { secret = crypt(name, current.encrypted_key, true); }
    catch { return record(name, snapshot, 'failed', 'Ключ не читается этим мастер-ключом'); }
    // Адрес перепроверяется прямо перед сетью: список хостов мог измениться после сохранения.
    let endpoint;
    try { endpoint = `${checkBaseUrl(current.base_url, name, env)}/chat/completions`; }
    catch (error) { return record(name, snapshot, 'failed', scrub(error.message, secret)); }
    const body = JSON.stringify({model: current.model_id, max_tokens: CHECK_MAX_OUTPUT_TOKENS,
      temperature: 0, messages: [{role: 'user', content: 'ping'}]});
    /* Проверка — платное обращение, поэтому она идёт через тот же учёт бюджета:
       неизвестная цена при денежной границе и исчерпанный бюджет останавливают её ДО сети. */
    const booking = budget.reserve(name, {promptBytes: Buffer.byteLength(body, 'utf8'),
      maxOutputTokens: CHECK_MAX_OUTPUT_TOKENS});
    if (!booking.allowed) return record(name, snapshot, 'blocked', scrub(booking.reason, secret));
    let response;
    try {
      // redirect: 'error' — иначе разрешённый адрес мог бы увести запрос с ключом на чужой хост.
      response = await fetchImpl(endpoint, {method: 'POST', redirect: 'error',
        headers: {'content-type': 'application/json', authorization: `Bearer ${secret}`},
        body, signal: AbortSignal.timeout(current.timeout_ms)});
    } catch (error) {
      budget.keep(booking.id);
      const timeout = error?.name === 'TimeoutError';
      const redirected = /redirect/i.test(String(error?.message || ''));
      return record(name, snapshot, 'failed', timeout ? 'Таймаут соединения'
        : redirected ? 'Адрес перенаправляет запрос на другой ресурс: соединение отклонено'
          : 'Сеть недоступна');
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      budget.release(booking.id);
      return record(name, snapshot, 'failed', 'Адрес перенаправляет запрос на другой ресурс: соединение отклонено');
    }
    if (response.status === 401 || response.status === 403) {
      budget.release(booking.id);
      return record(name, snapshot, 'failed', `Ключ отклонён (HTTP ${response.status})`);
    }
    if (response.status === 429) {
      budget.release(booking.id);
      return record(name, snapshot, 'failed', 'Лимит провайдера (429)');
    }
    if (response.status === 404) {
      budget.keep(booking.id);
      return record(name, snapshot, 'failed', 'Адрес не отвечает на /chat/completions: контракт не подтверждён');
    }
    if (!response.ok) {
      budget.keep(booking.id);
      return record(name, snapshot, 'failed', `Провайдер ответил ошибкой (HTTP ${response.status})`);
    }
    let data;
    try { data = await response.json(); }
    catch { budget.keep(booking.id); return record(name, snapshot, 'failed', 'Ответ не разобран как JSON'); }
    budget.settle(booking.id, {promptTokens: data?.usage?.prompt_tokens, completionTokens: data?.usage?.completion_tokens});
    if (!contractOk(data)) {
      return record(name, snapshot, 'failed',
        'Ответ не содержит ожидаемой структуры choices[0].message: контракт не подтверждён');
    }
    const model = scrub(typeof data.model === 'string' ? data.model : '', secret);
    return record(name, snapshot, 'ok',
      model ? `Соединение подтверждено, модель ответа: ${model}` : 'Соединение подтверждено');
  }
  /* Результат привязан к снимку версии соединения. Если между запросом и записью настройку
     изменили, результат к новой настройке не относится и подтверждением её не считается. */
  function record(name, snapshot, state, message) {
    const current = row(name);
    const applies = current && current.config_revision === snapshot;
    db.prepare('UPDATE hugh_provider_settings SET check_state=?,check_message=?,checked_at=?,checked_revision=? WHERE name=?')
      .run(state, applies ? String(message).slice(0, 300)
        : `${String(message).slice(0, 220)} — настройка изменилась во время проверки, результат к ней не относится`,
      new Date(now()).toISOString(), snapshot, name);
    return view(name);
  }

  /* Подключение к существующему рантайму ответов: сохранённые и включённые провайдеры
     отдаются в том же виде, в каком hugh-fallback читает их из окружения. */
  /* Отбор в рантайм вместе с причиной отказа по каждому отсеянному.
     Молчаливый пропуск стоил часов разбора: провайдер выглядел включённым в кабинете,
     а в ответах не участвовал, и узнать почему было неоткуда. */
  function runtimeReport() {
    if (!available) return {ready: [], skipped: [], lockedReason};
    const rows = db.prepare("SELECT * FROM hugh_provider_settings WHERE enabled=1 AND encrypted_key<>''").all();
    const ready = [], skipped = [];
    const skip = (name, reason) => { skipped.push({name, reason}); };
    for (const item of rows) {
      // Включённого мало: в рантайм идёт только провайдер с успешной проверкой ЭТОЙ версии.
      if (!checkCurrent(item)) {
        skip(item.name, item.check_state === 'failed'
          ? 'Последняя проверка соединения не прошла'
          : item.checked_revision === null
            ? 'Настройка ни разу не проверена'
            : 'Настройку меняли после успешной проверки — нужна новая проверка');
        continue;
      }
      if (BY_NAME.get(item.name)?.contractSupported === false) {
        skip(item.name, BY_NAME.get(item.name).unsupportedReason || 'Контракт этого провайдера не реализован');
        continue;
      }
      // Адрес перепроверяется и здесь: сохранённое значение не считается вечно доверенным.
      try { checkBaseUrl(item.base_url, item.name, env); }
      catch { skip(item.name, 'Сохранённый адрес API больше не проходит проверку официальных хостов'); continue; }
      let secret;
      try { secret = crypt(item.name, item.encrypted_key, true); }
      catch { skip(item.name, 'Ключ не расшифровывается: мастер-ключ сервера изменился или ключ повреждён'); continue; }
      ready.push({name: item.name, url: item.base_url, secret, model: item.model_id,
        timeoutMs: item.timeout_ms, maxOutputTokens: item.max_output_tokens,
        pricePromptMicroUsdPer1k: item.price_prompt_micro, priceCompletionMicroUsdPer1k: item.price_completion_micro,
        budgetMicroUsd: item.budget_usd_micro});
    }
    return {ready, skipped, lockedReason: ''};
  }

  const runtimeProviders = () => runtimeReport().ready;

  return {status, view, save, check, runtimeProviders, runtimeReport, available, lockedReason, catalog: CATALOG};
}

module.exports = {createHughProviders, HUGH_PROVIDER_CATALOG: CATALOG, HUGH_PROVIDER_API_STYLE: API_STYLE,
  HUGH_PROVIDER_MIN_MASTER_KEY: MIN_MASTER_KEY, checkBaseUrl};

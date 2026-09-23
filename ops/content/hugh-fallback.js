'use strict';
/* Резервные провайдеры ответов Хью (OpenAI-совместимый chat/completions) и честное подтверждение приёма.
   Провайдер считается настроенным только при наличии адреса, ключа и модели в окружении сервера:
   HUGH_FALLBACK_PROVIDERS=openrouter,deepseek
   HUGH_FALLBACK_OPENROUTER_URL=https://openrouter.ai/api/v1  HUGH_FALLBACK_OPENROUTER_KEY=…  HUGH_FALLBACK_OPENROUTER_MODEL=…
   Ключи в код и журнал не попадают. Наличие переменных — не доказательство живого подключения:
   живой ответ подтверждается только успешным обменом, который виден в статусе (lastSuccessAt). */
const { createHughBudget } = require('./hugh-budget');
const DEFAULT_TIMEOUT_MS = 60000;
const RATE_LIMIT_DEFAULT_S = 300, SERVER_ERROR_BASE_S = 60, SERVER_ERROR_MAX_S = 900, AUTH_ERROR_S = 3600, CLIENT_ERROR_S = 300;
const ACK_INTERVAL_MS = 30 * 60 * 1000;
const ACK_TEXT = 'Хью, бизнес-ассистент Синапс Бизнес (ИИ): сообщение получено и поставлено в очередь. ' +
  'Сейчас ответить не могу — сервис ИИ временно недоступен. Отвечу, когда он восстановится; ' +
  'никаких действий по вашему сообщению пока не выполнялось.';
const NAME_RE = /^[a-z][a-z0-9_-]{0,30}$/i;
const shortText = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const retryAfterSeconds = (value) => { const n = Number.parseInt(String(value ?? ''), 10); return Number.isFinite(n) && n > 0 && n <= 86400 ? n : 0; };

function readProviders(env = process.env) {
  const names = String(env.HUGH_FALLBACK_PROVIDERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const providers = [], issues = [];
  for (const name of names) {
    if (!NAME_RE.test(name)) { issues.push(`HUGH_FALLBACK_PROVIDERS: недопустимое имя ${JSON.stringify(name)} пропущено`); continue; }
    const key = name.toUpperCase().replace(/-/g, '_');
    const url = String(env[`HUGH_FALLBACK_${key}_URL`] || '').trim().replace(/\/$/, '');
    const secret = String(env[`HUGH_FALLBACK_${key}_KEY`] || '').trim();
    const model = String(env[`HUGH_FALLBACK_${key}_MODEL`] || '').trim();
    const timeout = Number.parseInt(env[`HUGH_FALLBACK_${key}_TIMEOUT_MS`] || '', 10);
    if (!url || !secret || !model) { issues.push(`Резервный провайдер ${name}: не заданы URL, ключ или модель — пропущен`); continue; }
    if (!/^https:\/\//.test(url)) { issues.push(`Резервный провайдер ${name}: адрес должен быть https — пропущен`); continue; }
    providers.push({ name: name.toLowerCase(), url, secret, model, timeoutMs: Number.isFinite(timeout) && timeout >= 5000 ? timeout : DEFAULT_TIMEOUT_MS });
  }
  return { providers, issues };
}

function createHughFallback({ db, env = process.env, fetchImpl = (...args) => globalThis.fetch(...args), now = () => Date.now(), messageLimit = 4000, providerStore = null } = {}) {
  const fromEnv = readProviders(env);
  const issues = [...fromEnv.issues];
  /* Провайдеры из защищённого хранилища ЛК подключаются к тому же рантайму ответов,
     что и заданные в окружении: отдельного мёртвого экрана настроек нет.
     Одноимённый провайдер из хранилища заменяет заданный в окружении. */
  // Настройки из кабинета меняются во время работы сервера. Читать их только при запуске
  // значит продолжать отвечать старой моделью (или считать резерв пустым) до перезапуска.
  const currentProviders = () => {
    const stored = providerStore && typeof providerStore.runtimeProviders === 'function'
      ? providerStore.runtimeProviders() : [];
    const savedNames = new Set(stored.map((item) => item.name));
    return [...fromEnv.providers.filter((item) => !savedNames.has(item.name)), ...stored];
  };
  if (providerStore && !providerStore.available && providerStore.lockedReason) issues.push(providerStore.lockedReason);
  db.exec(`CREATE TABLE IF NOT EXISTS project_chat_provider_state (
    provider TEXT PRIMARY KEY, cooldown_until TEXT, failures INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
    last_attempt_at TEXT, last_success_at TEXT, last_model TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)`);
  const stamp = (ms = now()) => new Date(ms).toISOString();
  const row = (name) => db.prepare('SELECT * FROM project_chat_provider_state WHERE provider=?').get(name);
  const upsert = (name, patch) => {
    const current = row(name) || { provider: name, cooldown_until: null, failures: 0, last_error: '', last_attempt_at: null, last_success_at: null, last_model: '' };
    const next = { ...current, ...patch, updated_at: stamp() };
    db.prepare(`INSERT INTO project_chat_provider_state(provider,cooldown_until,failures,last_error,last_attempt_at,last_success_at,last_model,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET cooldown_until=excluded.cooldown_until,failures=excluded.failures,
      last_error=excluded.last_error,last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,last_model=excluded.last_model,updated_at=excluded.updated_at`)
      .run(name, next.cooldown_until, next.failures, next.last_error, next.last_attempt_at, next.last_success_at, next.last_model, next.updated_at);
  };
  const budget = createHughBudget({ db, env, now });
  // Зависшие после аварии брони не освобождаются: они переходят в неизвестный расход.
  budget.recover();
  const cooling = (name, at = now()) => { const r = row(name); return Boolean(r?.cooldown_until && Date.parse(r.cooldown_until) > at); };
  // Достигнутая граница бюджета убирает всех провайдеров разом: вопрос остаётся в очереди,
  // существующий обработчик честно подтверждает приём и не выдаёт подтверждение за ответ.
  /* Провайдер выбывает и по своему личному лимиту из кабинета, а не только по общей границе:
     иначе кабинет показывал бы лимит, который ни на что не влияет. */
  const ownLimitReached = (provider, at) => (provider.budgetMicroUsd
    ? budget.providerState(provider.name, provider.budgetMicroUsd, at).stopped : false);
  const available = (at = now()) => (budget.stopped(at)
    ? [] : currentProviders().filter((p) => !cooling(p.name, at) && !ownLimitReached(p, at)));
  const nextAvailableAt = (at = now()) => {
    const times = currentProviders().map((p) => Date.parse(row(p.name)?.cooldown_until || '') || at).filter((t) => t > at);
    return times.length ? Math.min(...times) : at;
  };
  function cooldown(name, seconds, error) {
    const current = row(name), failures = (current?.failures || 0) + 1;
    upsert(name, { cooldown_until: stamp(now() + seconds * 1000), failures, last_error: shortText(error, 200), last_attempt_at: stamp() });
  }
  function toChatBody(payload, model, maxOutputTokens) {
    const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const messages = [{ role: 'system', content: String(data.system || '') }, ...(data.messages || []).map((m) => ({ role: m.role, content: m.content }))];
    // Потолок ответа уходит провайдеру ровно тот, под который забронированы деньги.
    return JSON.stringify({ model, messages, temperature: 0.3, max_tokens: maxOutputTokens });
  }
  async function callProvider(provider, payload) {
    const at = now();
    // Деньги и слот резервируются ДО обращения: параллельные запросы не могут вместе
    // перескочить границу, а неизвестный расход не считается нулём.
    const probe = toChatBody(payload, provider.model, budget.config.maxOutputTokens);
    const booking = budget.reserve(provider.name, { promptBytes: Buffer.byteLength(probe, 'utf8'),
      limitMicroUsd: provider.budgetMicroUsd ?? null });
    if (!booking.allowed) return { budgetBlocked: true, reason: booking.reason };
    const body = toChatBody(payload, provider.model, booking.maxOutputTokens);
    let response;
    try {
      // Запрет переадресации: разрешённый адрес не должен уводить запрос с ключом на чужой хост.
      response = await fetchImpl(`${provider.url}/chat/completions`, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.secret}` },
        body, signal: AbortSignal.timeout(provider.timeoutMs) });
    } catch (error) {
      // Таймаут и обрыв: доказательства, что провайдер ничего не потратил, нет — бронь остаётся.
      budget.keep(booking.id);
      const failures = row(provider.name)?.failures || 0;
      cooldown(provider.name, Math.min(SERVER_ERROR_MAX_S, SERVER_ERROR_BASE_S * 2 ** Math.min(failures, 4)), error?.name === 'TimeoutError' ? 'Таймаут ответа провайдера' : 'Сеть провайдера недоступна');
      return null;
    }
    // Переадресация трактуется как отказ: ответ пришёл не с того адреса, что разрешён.
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      budget.release(booking.id);
      cooldown(provider.name, CLIENT_ERROR_S, 'Адрес провайдера перенаправляет запрос');
      return null;
    }
    // Явный отказ обрабатывать запрос: генерации не было, бронь освобождается.
    if (response.status === 429) { budget.release(booking.id); cooldown(provider.name, retryAfterSeconds(response.headers?.get?.('retry-after')) || RATE_LIMIT_DEFAULT_S, 'Лимит провайдера (429)'); return null; }
    if (response.status === 401 || response.status === 403) { budget.release(booking.id); cooldown(provider.name, AUTH_ERROR_S, `Ключ провайдера отклонён (HTTP ${response.status})`); return null; }
    if (response.status >= 500) {
      budget.keep(booking.id);
      const failures = row(provider.name)?.failures || 0;
      cooldown(provider.name, Math.min(SERVER_ERROR_MAX_S, SERVER_ERROR_BASE_S * 2 ** Math.min(failures, 4)), `Ошибка провайдера (HTTP ${response.status})`); return null;
    }
    if (!response.ok) { budget.keep(booking.id); cooldown(provider.name, CLIENT_ERROR_S, `Провайдер отклонил запрос (HTTP ${response.status})`); return null; }
    let data;
    try { data = await response.json(); } catch { budget.keep(booking.id); cooldown(provider.name, CLIENT_ERROR_S, 'Некорректный JSON провайдера'); return null; }
    // Бронь уточняется фактом только если провайдер вернул usage и цена объявлена;
    // иначе верхняя оценка остаётся занятой.
    budget.settle(booking.id, { promptTokens: data?.usage?.prompt_tokens, completionTokens: data?.usage?.completion_tokens });
    const content = data?.choices?.[0]?.message?.content;
    const text = shortText(typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c?.text || '').join(' ') : '', messageLimit);
    if (!text) { cooldown(provider.name, CLIENT_ERROR_S, 'Пустой ответ провайдера'); return null; }
    upsert(provider.name, { cooldown_until: null, failures: 0, last_error: '', last_attempt_at: stamp(at), last_success_at: stamp(), last_model: shortText(data?.model || provider.model, 100) });
    return { text, provider: provider.name, model: shortText(data?.model || provider.model, 100) };
  }
  /* Пробует доступных провайдеров по порядку; исчерпание всех — не ошибка задания, а ожидание. */
  async function reply(payload, { beforeAttempt = null } = {}) {
    let blockedReason = '';
    for (const provider of available()) {
      if (beforeAttempt) beforeAttempt(provider);
      const result = await callProvider(provider, payload);
      // Бюджет не дал брони: это не сбой провайдера, обращения не было.
      if (result && result.budgetBlocked) { blockedReason = result.reason || blockedReason; continue; }
      if (result) return result;
    }
    if (blockedReason && !budget.stopped()) {
      throw Object.assign(new Error(`${blockedReason}: вопрос ждёт в очереди`),
        { allUnavailable: true, budgetStopped: true, delay: 900 });
    }
    const at = now(), stop = budget.state(at);
    // Бюджет исчерпан — это не сбой провайдера: ждать до конца окна, а не до конца паузы.
    if (stop.stopped) {
      throw Object.assign(new Error(`${stop.reason}: вопрос ждёт в очереди`),
        { allUnavailable: true, budgetStopped: true,
          delay: Math.max(60, Math.min(900, Math.ceil((Date.parse(stop.resetAt) - at) / 1000) || 900)) });
    }
    const until = nextAvailableAt(at);
    throw Object.assign(new Error(currentProviders().length ? 'Резервные провайдеры недоступны: вопрос ждёт в очереди' : 'Резервные провайдеры не настроены'),
      { allUnavailable: true, delay: Math.max(30, Math.min(900, Math.ceil((until - at) / 1000) || 30)) });
  }
  /* Подтверждение приёма: не чаще раза в 30 минут на компанию, только когда ни один путь ответа не доступен. */
  function ackDue(code, at = now()) {
    const r = row(`ack:${code}`);
    return !(r?.last_success_at && at - Date.parse(r.last_success_at) < ACK_INTERVAL_MS);
  }
  const markAck = (code) => upsert(`ack:${code}`, { last_success_at: stamp() });
  function status() {
    const providers = currentProviders();
    return { configured: providers.length > 0, issues, budget: budget.status(), providers: providers.map((p) => {
      const r = row(p.name) || {};
      return { name: p.name, model: p.model, cooling: cooling(p.name), cooldownUntil: r.cooldown_until || null, failures: r.failures || 0,
        lastError: r.last_error || '', lastAttemptAt: r.last_attempt_at || null, lastSuccessAt: r.last_success_at || null,
        live: Boolean(r.last_success_at),
        // Расход и личный лимит видны в кабинете: цифра без границы и граница без цифры
        // одинаково бесполезны.
        ...(() => {
          const own = budget.providerState(p.name, p.budgetMicroUsd ?? null);
          return { spentUsd: own.spentUsd, spentRequests: own.requests,
            ownLimitUsd: own.limitUsd, ownLimitReached: own.stopped };
        })() };
    }) };
  }
  // Аренда серверного подхвата: сумма таймаутов провайдеров плюс запас — чтобы она не истекла посреди последовательных попыток.
  const leaseMs = () => currentProviders().reduce((total, p) => total + p.timeoutMs, 0) + 30000;
  return { get providers() { return currentProviders().map((p) => ({ name: p.name, model: p.model })); },
    issues, available, reply, status, ackDue, markAck, leaseMs, budget, ACK_TEXT };
}
module.exports = { createHughFallback, readProviders, ACK_TEXT };

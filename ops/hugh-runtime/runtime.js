'use strict';

/* Ядро приватного рантайма Hugh: жизненный цикл app-server, вход по коду устройства,
   один ход в эфемерном потоке без окружений и строгий разбор результата.

   Правила, которые нельзя ослаблять:
   - ход не начинается, пока thread.environments не вернулся пустым списком;
   - любой запрос инструмента или подтверждения — нарушение: ход прерывается, рантайм закрывается;
   - наружу уходит только текст завершённых agentMessage, без рассуждений и служебных данных;
   - предохранитель изоляции закрыт по умолчанию и открывается только доказательством. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {AppServerClient} = require('./app-server-client');
const {validateRestrictedCatalog} = require('./model-catalog');
const {
  PINNED_CODEX_VERSION,
  THREAD_PARAMS_TEMPLATE,
  TURN_PARAMS_TEMPLATE,
  buildConfigToml,
  isolationFingerprint,
} = require('./codex-config');
const {loadGate, assertEmptyEnvironments, isForbiddenItem} = require('./safety-gate');
const {
  LOGIN_TIMEOUT_MS,
  parseDeviceLoginResponse,
  matchLoginCompleted,
  parseAccount,
} = require('./device-login');
const {buildDeveloperInstructions, buildTurnInput} = require('./prompt');
const {capOutput} = require('./limits');
const {RuntimeError, unavailable} = require('./errors');

const CLIENT_INFO = Object.freeze({
  name: 'synapse_hugh_runtime',
  title: 'Synapse Hugh Runtime',
  version: '1.0.0',
});

const DEFAULT_JOB_TIMEOUT_MS = 120_000;
const DEFAULT_INTERRUPT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_INTERRUPT_GRACE_MS = 15_000;
const VERSION_PATTERN = /\b(\d+\.\d+\.\d+)\b/;

/* Сколько ждать до следующей попытки, когда подписка ответила отказом по лимиту.
   Точное время берётся из снимка rate limits, если он есть и правдоподобен. */
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 300;
const DEFAULT_OVERLOAD_WAIT_SECONDS = 30;
const MAX_LIMIT_WAIT_SECONDS = 6 * 3600;

const UPSTREAM_MAP = new Map([
  ['rateLimitExceeded', {status: 429, code: 'RATE_LIMITED', message: 'Лимит подписки исчерпан, попробуйте позже'}],
  ['usageLimitExceeded', {status: 429, code: 'RATE_LIMITED', message: 'Лимит подписки исчерпан, попробуйте позже'}],
  ['serverOverloaded', {status: 503, code: 'UPSTREAM_BUSY', message: 'Модель перегружена, попробуйте позже'}],
  ['unauthorized', {status: 503, code: 'LOGIN_REQUIRED', message: 'Подписка требует повторного входа'}],
  ['contextWindowExceeded', {status: 400, code: 'CONTEXT_TOO_LARGE', message: 'Переписка не помещается в контекст'}],
]);

function upstreamError(turnError) {
  const info = turnError && turnError.codexErrorInfo;
  const key = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : null;
  const mapped = UPSTREAM_MAP.get(key);
  if (mapped) return new RuntimeError(mapped.status, mapped.code, mapped.message);
  return unavailable('UPSTREAM_ERROR', 'Модель не смогла ответить');
}

const privateHome = (codexHome) => path.join(codexHome, 'home');
const delay = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  if (typeof timer.unref === 'function') timer.unref();
});

/* Отбор текста для клиента.

   `phase` в протоколе — Option<MessagePhase> со значениями `commentary` и `final_answer`
   (protocol/src/models.rs:914). Исходники прямо предупреждают: провайдеры выставляют фазу
   непоследовательно, `None` означает «фаза неизвестна».

   Поэтому:
   - есть хотя бы одно `final_answer` — берём только их;
   - фазы нет ни у одного сообщения (старый протокол) — берём последнее, и только если оно
     единственное без фазы среди прочих без фазы, то есть выбор однозначен;
   - остались только `commentary` или смесь «комментарий + без фазы» — ответа нет.
     Промежуточные рассуждения клиенту не отдаются никогда. */
function selectFinalAnswer(messages) {
  const entries = [...messages.values()].filter((entry) => entry.text.trim().length > 0);
  if (entries.length === 0) return {texts: [], reason: 'no_messages'};

  const final = entries.filter((entry) => entry.phase === 'final_answer');
  if (final.length > 0) return {texts: final.map((entry) => entry.text.trim()), reason: 'final_answer'};

  const unphased = entries.filter((entry) => entry.phase === null || entry.phase === undefined);
  if (unphased.length === entries.length) {
    // Узкая совместимость со старым протоколом: однозначное последнее завершённое сообщение.
    return {texts: [unphased[unphased.length - 1].text.trim()], reason: 'legacy_unphased'};
  }
  return {texts: [], reason: 'commentary_only'};
}

function ensureDirectory(directory, mode) {
  fs.mkdirSync(directory, {recursive: true, mode});
  try {
    fs.chmodSync(directory, mode);
  } catch {
    /* на некоторых файловых системах смена режима недоступна */
  }
}

function writePrivateFile(file, content) {
  fs.writeFileSync(file, content, {mode: 0o600});
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* см. выше */
  }
}

/* Windows нужен для локальных проверок на машине владельца. Без SystemRoot и служебных
   переменных бинарь падает на инициализации сокетов ещё до initialize.
   Профиль подменяется на приватный каталог, чтобы настольная сессия Codex не подхватывалась.
   Прод — Linux, там этот список не применяется. */
const WINDOWS_SYSTEM_VARIABLES = Object.freeze([
  'SystemRoot',
  'windir',
  'SystemDrive',
  'COMSPEC',
  'PATHEXT',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'OS',
]);

class HughRuntime {
  constructor(options) {
    this.executable = options.executable;
    this.codexHome = options.codexHome;
    this.workspace = options.workspace;
    this.model = options.model || null;
    this.proofPath = options.proofPath || null;
    this.modelCatalogPath = options.modelCatalogPath || null;
    // Прод обязан иметь собранный при сборке образа каталог; тесты с поддельным app-server — нет.
    this.requireCatalog = options.requireCatalog !== false;
    this.jobTimeoutMs = options.jobTimeoutMs || DEFAULT_JOB_TIMEOUT_MS;
    this.interruptRequestTimeoutMs = options.interruptRequestTimeoutMs || DEFAULT_INTERRUPT_REQUEST_TIMEOUT_MS;
    this.interruptGraceMs = options.interruptGraceMs || DEFAULT_INTERRUPT_GRACE_MS;
    this.loginTimeoutMs = options.loginTimeoutMs || LOGIN_TIMEOUT_MS;
    this.extraChildEnv = options.extraChildEnv || {};
    this.providerConfig = options.providerConfig || {};
    this.store = options.store || null;
    this.logger = options.logger || console;
    this.clientFactory = options.clientFactory || ((config) => new AppServerClient(config));

    this.client = null;
    this.lastClient = null;
    this.readyPromise = null;
    this.version = null;
    this.versionOk = null;
    this.authenticated = false;
    this.accountReason = 'unknown';
    this.preflight = {ok: false, reason: 'not_run', model: null};
    this.violation = null;
    this.startupError = null;
    this.catalogState = {ok: true, reason: 'catalog_absent'};
    this.activeJob = null;
    this.busy = false;
    this.login = {status: 'idle', loginId: null, verificationUrl: null, userCode: null, expiresAt: null, reason: null};
    this.fingerprint = null;
    this.gate = {verified: false, reason: 'proof_not_loaded'};
    this.limited = null;
    this.rateLimitResetAt = null;
  }

  /* Готовит приватный CODEX_HOME, конфигурацию и предохранитель. Вызывается один раз при старте. */
  prepare() {
    ensureDirectory(this.codexHome, 0o700);
    ensureDirectory(privateHome(this.codexHome), 0o700);
    if (process.platform === 'win32') {
      ensureDirectory(path.join(privateHome(this.codexHome), 'AppData', 'Roaming'), 0o700);
      ensureDirectory(path.join(privateHome(this.codexHome), 'AppData', 'Local'), 0o700);
    }

    let catalogSha = null;
    if (this.modelCatalogPath) {
      let raw = null;
      try {
        raw = fs.readFileSync(this.modelCatalogPath, 'utf8');
      } catch {
        this.catalogState = {ok: false, reason: 'catalog_unreadable'};
      }
      if (raw !== null) {
        this.catalogState = validateRestrictedCatalog(raw);
        catalogSha = crypto.createHash('sha256').update(raw).digest('hex');
        if (this.catalogState.ok) {
          // Модель берётся из проверенного каталога. Переменная HUGH_MODEL — только сверка.
          if (this.model && this.model !== this.catalogState.slug) {
            this.catalogState = {ok: false, reason: 'catalog_model_mismatch'};
          } else {
            this.model = this.catalogState.slug;
          }
        }
      }
    } else if (this.requireCatalog) {
      this.catalogState = {ok: false, reason: 'catalog_path_unset'};
    }

    this.fingerprint = isolationFingerprint({
      modelCatalogSha256: this.catalogState.ok ? catalogSha : null,
      model: this.catalogState.ok ? this.model : null,
    });
    writePrivateFile(
      path.join(this.codexHome, 'config.toml'),
      buildConfigToml({
        modelCatalogPath: this.catalogState.ok ? this.modelCatalogPath : null,
        ...this.providerConfig,
      }),
    );
    this.reloadGate();
    if (this.store) {
      this.store.recoverInterrupted();
      this.store.prune();
      // Ограничение переживает перезапуск: иначе бэкенд снова упрётся в тот же лимит.
      const savedLimit = this.store.readLimit();
      if (savedLimit && savedLimit.until_ms > Date.now()) {
        this.limited = {reason: savedLimit.reason, until: savedLimit.until_ms};
      } else if (savedLimit) {
        this.store.clearLimit();
      }
      // Незавершённый вход после перезапуска не показываем пригодным.
      const saved = this.store.readLogin();
      if (saved && saved.status === 'pending') {
        this.store.saveLogin({status: 'interrupted'});
      }
    }
  }

  /* ----- временная недоступность из-за лимита подписки -----
     Лимит не стирает вход: учётные данные остаются, меняется только доступность. */

  #rememberRateLimits(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const now = Date.now();
    const candidates = [snapshot.primary, snapshot.secondary]
      .filter((window) => window && typeof window === 'object')
      .map((window) => Number(window.resetsAt ?? window.resets_at))
      // resets_at — Unix-время в секундах (protocol/src/protocol.rs:2373).
      .map((value) => value * 1000)
      .filter((value) => Number.isFinite(value) && value > now && value < now + MAX_LIMIT_WAIT_SECONDS * 1000);
    if (candidates.length > 0) this.rateLimitResetAt = Math.min(...candidates);
  }

  markLimited(reason, error) {
    const now = Date.now();
    const fallback = reason === 'overloaded' ? DEFAULT_OVERLOAD_WAIT_SECONDS : DEFAULT_RATE_LIMIT_WAIT_SECONDS;
    let until = now + fallback * 1000;
    if (reason === 'rate_limit' && this.rateLimitResetAt && this.rateLimitResetAt > now) {
      until = Math.min(this.rateLimitResetAt, now + MAX_LIMIT_WAIT_SECONDS * 1000);
    }
    this.limited = {reason, until};
    if (this.store) this.store.saveLimit({reason, until});
    const retryAfterSeconds = Math.max(1, Math.ceil((until - now) / 1000));
    if (error) error.retryAfterSeconds = retryAfterSeconds;
    this.logger.warn(`hugh-runtime: limited reason=${JSON.stringify(reason)} retry_after=${retryAfterSeconds}`);
    return retryAfterSeconds;
  }

  clearLimit() {
    if (!this.limited) return;
    this.limited = null;
    this.rateLimitResetAt = null;
    if (this.store) this.store.clearLimit();
  }

  /* Возвращает текущее ограничение или null, попутно снимая истёкшее. */
  limitState() {
    if (!this.limited) return null;
    const remaining = this.limited.until - Date.now();
    if (remaining <= 0) {
      this.clearLimit();
      return null;
    }
    return {
      reason: this.limited.reason,
      until: this.limited.until,
      retryAfterSeconds: Math.max(1, Math.ceil(remaining / 1000)),
    };
  }

  #failedTurnError(turnError) {
    const error = upstreamError(turnError);
    if (error.code === 'RATE_LIMITED') this.markLimited('rate_limit', error);
    else if (error.code === 'UPSTREAM_BUSY') this.markLimited('overloaded', error);
    return error;
  }

  reloadGate() {
    this.gate = loadGate({
      proofPath: this.proofPath,
      fingerprint: this.fingerprint,
      codexVersion: PINNED_CODEX_VERSION,
    });
    return this.gate;
  }

  childEnv() {
    const home = privateHome(this.codexHome);
    const base = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: home,
      CODEX_HOME: this.codexHome,
      LANG: process.env.LANG || 'C.UTF-8',
      LC_ALL: process.env.LC_ALL || 'C.UTF-8',
      TZ: process.env.TZ || 'UTC',
      TMPDIR: process.env.TMPDIR || (process.platform === 'win32' ? os.tmpdir() : '/tmp'),
      NO_COLOR: '1',
    };
    if (process.platform === 'win32') {
      for (const key of WINDOWS_SYSTEM_VARIABLES) {
        if (process.env[key]) base[key] = process.env[key];
      }
      base.USERPROFILE = home;
      base.APPDATA = path.join(home, 'AppData', 'Roaming');
      base.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
      base.TEMP = base.TMPDIR;
      base.TMP = base.TMPDIR;
    }
    return {...base, ...this.extraChildEnv};
  }

  #attach(client) {
    client.on('notification', (method, params) => this.#onNotification(method, params));
    client.on('serverRequest', (request) => this.#onServerRequest(client, request));
    client.on('exit', () => {
      // Обработчик привязан к конкретному процессу и не должен сбрасывать уже созданный новый.
      if (this.lastClient === client) this.lastClient = null;
      if (this.client !== client) return;
      this.client = null;
      this.readyPromise = null;
      this.#failActiveJob(unavailable('RUNTIME_UNAVAILABLE', 'Рантайм перезапускается'));
    });
    client.on('protocolError', (reason) => {
      this.logger.warn(`hugh-runtime: protocol_error reason=${JSON.stringify(reason)}`);
    });
  }

  /* Любой запрос со стороны app-server неожиданен: инструментов нет, подтверждать нечего. */
  #onServerRequest(client, request) {
    try {
      client.respondError(request.id, -32601, 'tools are disabled for this runtime');
    } catch {
      /* процесс мог уже завершиться */
    }
    this.#recordViolation(`server_request:${request.method}`);
  }

  #recordViolation(reason) {
    this.violation = reason;
    this.logger.error(`hugh-runtime: tool_isolation_violation reason=${JSON.stringify(reason)}`);
    const job = this.activeJob;
    // Пометка ставится даже если ход уже успел завершиться: отравленное задание не отдаёт ответ.
    // Прерывание хода делает #finishTurn: оно ждёт подтверждения, а не «выстрелил и забыл».
    if (job) job.poisoned = reason;
    this.#failActiveJob(unavailable('TOOL_ISOLATION_VIOLATION', 'Рантайм остановлен: обнаружен запрещённый инструмент'));
  }

  #failActiveJob(error) {
    const job = this.activeJob;
    if (!job || job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    job.reject(error);
  }

  #onNotification(method, params) {
    if (method === 'account/login/completed') {
      this.#onLoginCompleted(params).catch((error) => {
        this.logger.warn(`hugh-runtime: login_completed_failed code=${JSON.stringify(error.code || 'error')}`);
      });
      return;
    }
    if (!params) return;
    // Запрещённый элемент — нарушение всегда: ни в одном потоке рантайма его быть не может,
    // в том числе после того, как ход уже отчитался об успехе.
    if ((method === 'item/started' || method === 'item/completed') && isForbiddenItem(params.item)) {
      this.#recordViolation(`item:${params.item.type}`);
      return;
    }
    if (method === 'account/rateLimits/updated') {
      this.#rememberRateLimits(params.rateLimits);
      return;
    }
    const job = this.activeJob;
    if (!job) return;
    if (params.threadId !== job.threadId) return; // чужой поток игнорируем
    // Идентификатор хода и факт его завершения нужны даже для уже отклонённого задания:
    // без подтверждения завершения нельзя начинать следующее.
    if (method === 'turn/started') {
      job.turnId = params.turn && params.turn.id ? params.turn.id : job.turnId;
      return;
    }
    if (method === 'turn/completed') {
      job.turnFinished = (params.turn && params.turn.status) || 'unknown';
      job.resolveFinished(job.turnFinished);
      if (!job.settled) {
        job.settled = true;
        clearTimeout(job.timer);
        job.resolve(params.turn || {});
      }
      return;
    }
    if (job.settled) return;
    if (method === 'item/completed') {
      const item = params.item;
      if (item && item.type === 'agentMessage' && typeof item.text === 'string') {
        // Фаза сохраняется как есть: отбор финального ответа делается один раз, в конце хода.
        job.messages.set(item.id, {text: item.text, phase: item.phase ?? null});
      }
    }
  }

  async #ensureClient() {
    if (this.client && this.client.running) return this.client;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.#startClient().catch((error) => {
      this.readyPromise = null;
      this.client = null;
      throw error;
    });
    return this.readyPromise;
  }

  async #startClient() {
    const client = this.clientFactory({
      executable: this.executable,
      args: ['app-server', '--stdio', '--strict-config'],
      env: this.childEnv(),
      cwd: this.workspace,
    });
    this.client = client;
    // Ссылка переживает выход процесса: при остановке мы ждём фактического закрытия потоков.
    this.lastClient = client;
    this.#attach(client);
    client.start();

    const initialize = await client.request('initialize', {
      clientInfo: {...CLIENT_INFO},
      capabilities: {experimentalApi: true},
    });
    const match = VERSION_PATTERN.exec(String((initialize && initialize.userAgent) || ''));
    this.version = match ? match[1] : null;
    this.versionOk = this.version === PINNED_CODEX_VERSION;
    if (!this.versionOk) {
      client.stop('version_mismatch');
      this.startupError = 'VERSION_MISMATCH';
      throw unavailable('VERSION_MISMATCH', 'Версия Codex не совпадает с закреплённой');
    }
    client.notify('initialized', {});
    this.startupError = null;
    await this.refreshAccount();
    await this.runPreflight();
    return client;
  }

  /* Фоновый прогрев: поднимает app-server, чтобы /status знал версию, вход и окружения. */
  warmUp() {
    return this.#ensureClient().catch((error) => {
      this.logger.warn(`hugh-runtime: warmup_failed code=${JSON.stringify((error && error.code) || 'error')}`);
      return null;
    });
  }

  async refreshAccount() {
    const client = this.client;
    if (!client || !client.running) return this.authenticated;
    try {
      const result = await client.request('account/read', {refreshToken: false});
      const parsed = parseAccount(result);
      this.authenticated = parsed.authenticated;
      this.accountReason = parsed.reason;
    } catch {
      this.authenticated = false;
      this.accountReason = 'account_read_failed';
    }
    return this.authenticated;
  }

  /* Пробный эфемерный поток без хода: проверяет пустые окружения и узнаёт модель.
     Ни одного обращения к модели здесь нет, подписка не расходуется. */
  async runPreflight() {
    const client = this.client;
    if (!client || !client.running) {
      this.preflight = {ok: false, reason: 'client_absent', model: null};
      return this.preflight;
    }
    try {
      const result = await client.request('thread/start', this.#threadParams('Проверка изоляции.'));
      const guard = assertEmptyEnvironments(result && result.thread);
      this.preflight = {ok: guard.ok, reason: guard.reason, model: (result && result.model) || null};
    } catch (error) {
      this.preflight = {ok: false, reason: 'thread_start_failed', model: null};
      this.logger.warn(`hugh-runtime: preflight_failed code=${JSON.stringify(error.rpcCode || 'error')}`);
    }
    return this.preflight;
  }

  #threadParams(developerInstructions) {
    return {
      ...THREAD_PARAMS_TEMPLATE,
      cwd: this.workspace,
      developerInstructions,
      ...(this.model ? {model: this.model} : {}),
    };
  }

  /* ----- состояние для /status ----- */

  statusSnapshot() {
    const gate = this.gate;
    let state = 'connecting';
    let errorCode = null;
    let error = null;

    if (this.violation) {
      state = 'unavailable';
      errorCode = 'TOOL_ISOLATION_VIOLATION';
      error = 'Рантайм остановлен: обнаружен запрещённый инструмент';
    } else if (this.versionOk === false || this.startupError === 'VERSION_MISMATCH') {
      state = 'unavailable';
      errorCode = 'VERSION_MISMATCH';
      error = 'Версия Codex не совпадает с закреплённой';
    } else if (!this.catalogState.ok) {
      state = 'unavailable';
      errorCode = 'MODEL_CATALOG_REJECTED';
      error = 'Каталог моделей не прошёл проверку';
    } else if (this.versionOk === null) {
      // Процесс ещё не поднимался: состояние входа пока неизвестно.
      state = 'connecting';
    } else if (!this.authenticated) {
      state = this.login.status === 'pending' ? 'connecting' : 'login_required';
      errorCode = 'LOGIN_REQUIRED';
      error = 'Нужен вход в подписку ChatGPT';
    } else if (!gate.verified) {
      state = 'unavailable';
      errorCode = 'TOOL_ISOLATION_UNVERIFIED';
      error = 'Изоляция инструментов ещё не подтверждена проверкой';
    } else if (!this.preflight.ok) {
      state = 'unavailable';
      errorCode = 'ENVIRONMENT_GUARD_FAILED';
      error = 'Рантайм не подтвердил пустой список окружений';
    } else {
      state = 'connected';
    }

    // Вход и изоляция — это одно, наличие свободной квоты — другое.
    // Лимит подписки делает рантайм временно недоступным, но НЕ разлогинивает его.
    const connected = state === 'connected';
    const limit = this.limitState();
    if (connected && limit) {
      state = 'unavailable';
      errorCode = 'RATE_LIMITED';
      error = 'Лимит подписки исчерпан, ответ будет позже';
    }
    const available = connected && !limit;
    return {
      connected,
      authenticated: this.authenticated,
      available,
      limited: Boolean(limit),
      retryAfter: limit ? limit.retryAfterSeconds : null,
      limitedUntil: limit ? new Date(limit.until).toISOString() : null,
      limitReason: limit ? limit.reason : null,
      provider: 'codex',
      model: this.preflight.model || this.model,
      state,
      loginUrl: this.login.status === 'pending' ? this.login.verificationUrl : null,
      userCode: this.login.status === 'pending' ? this.login.userCode : null,
      error,
      errorCode,
      replyEnabled: available,
      version: this.version,
      safety: {toolIsolationVerified: gate.verified, reason: gate.reason},
    };
  }

  /* ----- вход по коду устройства ----- */

  async startLogin() {
    if (this.login.status === 'pending' && this.login.expiresAt > Date.now()) {
      return this.statusSnapshot();
    }
    const client = await this.#ensureClient();
    let result;
    try {
      result = await client.request('account/login/start', {type: 'chatgptDeviceCode'}, {timeoutMs: 30_000});
    } catch {
      this.login = {status: 'failed', loginId: null, verificationUrl: null, userCode: null, expiresAt: null, reason: 'login_start_failed'};
      throw unavailable('LOGIN_FAILED', 'Не удалось начать вход в подписку');
    }
    const parsed = parseDeviceLoginResponse(result);
    if (!parsed.ok) {
      this.logger.error(`hugh-runtime: login_rejected reason=${JSON.stringify(parsed.reason)}`);
      if (result && typeof result.loginId === 'string') {
        client.request('account/login/cancel', {loginId: result.loginId}, {timeoutMs: 10_000}).catch(() => {});
      }
      this.login = {status: 'failed', loginId: null, verificationUrl: null, userCode: null, expiresAt: null, reason: parsed.reason};
      throw unavailable('LOGIN_REJECTED', 'Сервис вернул недопустимые данные входа');
    }
    this.login = {
      status: 'pending',
      loginId: parsed.loginId,
      verificationUrl: parsed.verificationUrl,
      userCode: parsed.userCode,
      expiresAt: Date.now() + this.loginTimeoutMs,
      reason: null,
    };
    this.#saveLogin();
    const timer = setTimeout(() => this.#expireLogin(parsed.loginId), this.loginTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.loginTimer = timer;
    return this.statusSnapshot();
  }

  #saveLogin() {
    if (!this.store) return;
    this.store.saveLogin({
      status: this.login.status,
      loginId: this.login.loginId,
      userCode: this.login.userCode,
      verificationUrl: this.login.verificationUrl,
      expiresAt: this.login.expiresAt,
    });
  }

  #expireLogin(loginId) {
    if (this.login.status !== 'pending' || this.login.loginId !== loginId) return;
    this.login = {status: 'expired', loginId: null, verificationUrl: null, userCode: null, expiresAt: null, reason: 'login_timeout'};
    this.#saveLogin();
    if (this.client && this.client.running) {
      this.client.request('account/login/cancel', {loginId}, {timeoutMs: 10_000}).catch(() => {});
    }
  }

  async #onLoginCompleted(params) {
    const match = matchLoginCompleted(params, this.login.loginId);
    if (!match.matched) return;
    clearTimeout(this.loginTimer);
    if (!match.success) {
      this.login = {status: 'failed', loginId: null, verificationUrl: null, userCode: null, expiresAt: null, reason: 'login_declined'};
      this.#saveLogin();
      return;
    }
    // Успех подтверждаем только повторным чтением учётной записи.
    const authenticated = await this.refreshAccount();
    this.login = {
      status: authenticated ? 'completed' : 'failed',
      loginId: null,
      verificationUrl: null,
      userCode: null,
      expiresAt: null,
      reason: authenticated ? null : this.accountReason,
    };
    this.#saveLogin();
    if (authenticated) await this.runPreflight();
  }

  /* ----- один ответ ----- */

  async reply(payload) {
    if (this.violation) throw unavailable('TOOL_ISOLATION_VIOLATION', 'Рантайм остановлен: обнаружен запрещённый инструмент');
    if (!this.catalogState.ok) throw unavailable('MODEL_CATALOG_REJECTED', 'Каталог моделей не прошёл проверку');
    if (!this.gate.verified) {
      throw unavailable('TOOL_ISOLATION_UNVERIFIED', 'Изоляция инструментов ещё не подтверждена проверкой');
    }
    // Пока действует лимит подписки, к модели не обращаемся вовсе: попытка всё равно
    // вернулась бы отказом и только сожгла бы ещё одну.
    const limit = this.limitState();
    if (limit) {
      throw new RuntimeError(429, 'RATE_LIMITED', 'Лимит подписки исчерпан, ответ будет позже', {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    if (this.busy) throw new RuntimeError(429, 'BUSY', 'Рантайм занят другим заданием', {retryAfterSeconds: 5});
    this.busy = true;
    try {
      const result = await this.#replyInner(payload);
      this.clearLimit(); // успешный ответ снимает прежнее ограничение
      return result;
    } finally {
      this.busy = false;
    }
  }

  async #replyInner(payload) {
    const client = await this.#ensureClient();
    if (!this.authenticated) throw unavailable('LOGIN_REQUIRED', 'Нужен вход в подписку ChatGPT');

    const thread = await client.request('thread/start', this.#threadParams(buildDeveloperInstructions(payload.system)));
    const guard = assertEmptyEnvironments(thread && thread.thread);
    if (!guard.ok) {
      this.preflight = {ok: false, reason: guard.reason, model: this.preflight.model};
      this.logger.error(`hugh-runtime: environment_guard_failed reason=${JSON.stringify(guard.reason)}`);
      throw unavailable('ENVIRONMENT_GUARD_FAILED', 'Рантайм не подтвердил пустой список окружений');
    }
    const threadId = thread.thread.id;
    // Провайдер не имеет права подменить модель: сверяем ровно тот слаг, что закреплён каталогом.
    if (this.model && thread.model !== this.model) {
      this.logger.error('hugh-runtime: model_mismatch');
      throw unavailable('MODEL_MISMATCH', 'Сервис вернул не ту модель, что закреплена');
    }
    this.preflight = {ok: true, reason: guard.reason, model: thread.model || this.preflight.model};

    // Завершение хода отслеживается отдельно от результата задания: задание могло быть
    // отклонено по таймауту или нарушению, а ход на стороне подписки ещё живёт.
    let resolveFinished = () => {};
    const finished = new Promise((resolve) => {
      resolveFinished = resolve;
    });
    const completion = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#failActiveJob(unavailable('TIMEOUT', 'Модель не ответила вовремя'));
      }, this.jobTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.activeJob = {
        threadId,
        turnId: null,
        messages: new Map(),
        resolve,
        reject,
        timer,
        settled: false,
        poisoned: null,
        turnFinished: null,
        finished,
        resolveFinished,
      };
    });
    const job = this.activeJob;
    // Отказ может прийти раньше, чем мы дойдём до await: помечаем промис обработанным.
    completion.catch(() => {});

    try {
      const started = await client.request(
        'turn/start',
        {
          ...TURN_PARAMS_TEMPLATE,
          threadId,
          input: buildTurnInput(payload.messages),
        },
        {timeoutMs: this.jobTimeoutMs},
      );
      if (started && started.turn && started.turn.id) job.turnId = started.turn.id;
      const turn = await completion;
      // Уведомление о запрещённом инструменте может прийти в том же куске stdout, что и
      // turn/completed. Даём уже полученным строкам дойти до обработчиков и только потом
      // решаем, можно ли отдавать ответ.
      await new Promise((resolve) => setImmediate(resolve));
      if (this.violation || job.poisoned) {
        throw unavailable('TOOL_ISOLATION_VIOLATION', 'Рантайм остановлен: обнаружен запрещённый инструмент');
      }
      if (turn.status !== 'completed') {
        if (turn.status === 'failed') throw this.#failedTurnError(turn.error);
        throw unavailable('TURN_INTERRUPTED', 'Ход был прерван');
      }
      const selected = selectFinalAnswer(job.messages);
      if (selected.texts.length === 0) {
        this.logger.warn(`hugh-runtime: empty_reply reason=${JSON.stringify(selected.reason)}`);
        throw unavailable('EMPTY_REPLY', 'Модель не вернула итоговый ответ');
      }
      const {text} = capOutput(selected.texts.join('\n\n'));
      if (!text) throw unavailable('EMPTY_REPLY', 'Модель не вернула итоговый ответ');
      return {text, model: thread.model || this.model || null};
    } finally {
      clearTimeout(job.timer);
      // Нельзя освобождать рантайм, пока прежний ход может продолжать тратить квоту.
      const confirmed = await this.#finishTurn(job, client);
      this.activeJob = null;
      if (!confirmed) await this.#restartClient('turn_interrupt_unconfirmed');
    }
  }

  /* Доводит ход до подтверждённого конца: либо уже пришёл turn/completed, либо посылаем
     turn/interrupt и ограниченно ждём подтверждения. Неподтверждённый ход — повод убить
     процесс целиком, а не начинать следующее задание рядом с ним. */
  async #finishTurn(job, client) {
    if (job.turnFinished) return true;
    if (!job.turnId) return true; // ход не начинался
    if (!client || !client.running) return true; // процесса уже нет, чужой ход не продолжится
    try {
      await client.request(
        'turn/interrupt',
        {threadId: job.threadId, turnId: job.turnId},
        {timeoutMs: this.interruptRequestTimeoutMs},
      );
    } catch (error) {
      this.logger.warn(`hugh-runtime: turn_interrupt_failed code=${JSON.stringify(error.rpcCode || 'error')}`);
    }
    const outcome = await Promise.race([job.finished, delay(this.interruptGraceMs).then(() => null)]);
    if (outcome) return true;
    this.logger.error('hugh-runtime: turn_interrupt_unconfirmed');
    return false;
  }

  /* Полная остановка процесса с ожиданием закрытия: следующее задание получит новый app-server. */
  async #restartClient(reason) {
    const client = this.client || this.lastClient;
    this.client = null;
    this.readyPromise = null;
    this.preflight = {ok: false, reason: 'client_restarted', model: this.preflight.model};
    if (client) await client.stop(reason);
    this.logger.warn(`hugh-runtime: app_server_restarted reason=${JSON.stringify(reason)}`);
  }

  /* Останавливает рантайм и ждёт фактического завершения дочернего процесса. */
  stop() {
    clearTimeout(this.loginTimer);
    const client = this.client || this.lastClient;
    if (!client) return Promise.resolve(null);
    return client.stop('shutdown');
  }
}

module.exports = {
  HughRuntime,
  CLIENT_INFO,
  DEFAULT_JOB_TIMEOUT_MS,
  WINDOWS_SYSTEM_VARIABLES,
  upstreamError,
  selectFinalAnswer,
  privateHome,
};

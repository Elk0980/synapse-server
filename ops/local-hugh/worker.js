'use strict';

/* Локальный обработчик Хью: heartbeat → claim → генерация → durable outbox → complete.

   Что гарантируется:
   - рантайм вызывается напрямую (HughRuntime), никаких HTTP-слушателей;
   - результат записывается на диск ДО complete и повторяется до подтверждения сервером;
     пока в outbox есть неподтверждённый результат, новых claim нет;
   - взятое задание сохраняется на диск сразу после claim; после перезапуска аренда
     проверяется renew, и только подтверждённая аренда продолжается;
   - heartbeat идёт каждые 20 секунд независимо от генерации, renew — каждые 20 секунд
     параллельно генерации;
   - в heartbeat уходят только публичные поля рантайма, кодов входа там нет никогда;
     код и ссылка входа отдаются только через complete задания login и только пока
     вход действительно ожидает подтверждения;
   - в журнал и status.json попадают только короткие коды, числа и время. */

const crypto = require('node:crypto');
const {RuntimeError} = require('../hugh-runtime/errors');
const {validateReplyPayload, canonicalPayload} = require('../hugh-runtime/limits');
const {isAllowedVerificationUrl, isAllowedUserCode} = require('../hugh-runtime/device-login');
const {toContractFailure, contractFailure} = require('./error-codes');
const {TransportError} = require('./transport');
const {publicRuntimeStatus, sanitizeServerStats, buildStatusDocument} = require('./status-file');

const WORKER_VERSION = '1.0.0';
const JOB_KINDS = new Set(['reply', 'login']);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const COMPANY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const LEASE_TOKEN_PATTERN = /^[A-Za-z0-9._:-]{8,256}$/;
/* Временные отказы рантайма снимают аренду в job-store, как в http-server.js. */
const TRANSIENT_RUNTIME_CODES = new Set(['BUSY', 'RATE_LIMITED', 'UPSTREAM_BUSY']);
/* Ответы complete, после которых повтор бессмыслен: сервер отказал окончательно. */
const FINAL_REJECT_STATUSES = new Set([400, 403, 404, 409, 410, 413, 422]);

const DEFAULTS = Object.freeze({
  heartbeatIntervalMs: 20_000,
  renewIntervalMs: 20_000,
  idleRetryAfterSeconds: 5,
  maxRetryAfterSeconds: 60,
  backoffBaseMs: 5_000,
  backoffMaxMs: 60_000,
  scopeCooldownMs: 300_000,
  maintenanceIntervalMs: 60_000,
  accountRefreshIntervalMs: 300_000,
  pruneIntervalMs: 3_600_000,
  ackedRetentionMs: 72 * 3600 * 1000,
});

const realScheduler = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer),
});

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/* Строгий разбор задания из ответа claim. Любое отклонение — null, задание не берётся. */
function parseClaimedJob(raw) {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== 'string' || !JOB_ID_PATTERN.test(raw.id)) return null;
  if (!JOB_KINDS.has(raw.kind)) return null;
  if (typeof raw.companyCode !== 'string' || !COMPANY_PATTERN.test(raw.companyCode)) return null;
  if (typeof raw.payloadHash !== 'string' || !HASH_PATTERN.test(raw.payloadHash)) return null;
  if (typeof raw.leaseToken !== 'string' || !LEASE_TOKEN_PATTERN.test(raw.leaseToken)) return null;
  if (typeof raw.leaseExpiresAt !== 'string' || !Number.isFinite(Date.parse(raw.leaseExpiresAt))) return null;
  if (!isPlainObject(raw.payload)) return null;
  return {
    jobId: raw.id,
    kind: raw.kind,
    companyCode: raw.companyCode,
    payload: raw.payload,
    payloadHash: raw.payloadHash,
    leaseToken: raw.leaseToken,
    leaseExpiresAt: new Date(Date.parse(raw.leaseExpiresAt)).toISOString(),
  };
}

function clampRetryAfterMs(value, fallbackSeconds, maxSeconds) {
  const number = Number(value);
  const seconds = Number.isFinite(number) && number >= 1 ? Math.min(maxSeconds, number) : fallbackSeconds;
  return Math.trunc(seconds * 1000);
}

class LocalHughWorker {
  constructor(options) {
    this.runtime = options.runtime;
    this.store = options.store;
    this.outbox = options.outbox;
    this.transport = options.transport;
    this.logger = options.logger || console;
    this.scheduler = options.scheduler || realScheduler;
    this.statusWriter = options.statusWriter || null;
    this.companies = new Set(options.companies || ['palitra-love']);
    this.bootId = options.bootId || crypto.randomUUID();
    this.settings = {...DEFAULTS, ...(options.settings || {})};

    this.running = false;
    this.startedAt = null;
    this.activeJob = null;
    this.recovered = null;
    this.heartbeatTimer = null;
    this.heartbeatInFlight = false;
    this.workPromise = null;
    this.sleepers = new Set();
    this.backoffMs = 0;
    this.outboxRetryAt = 0;
    this.scopeCooldownUntil = 0;
    this.lastMaintenanceAt = 0;
    this.lastAccountRefreshAt = 0;
    this.lastPruneAt = 0;
    this.lastClaimAt = null;
    this.lastCompleteAt = null;
    this.lastTransport = null;
    this.counters = {
      claims: 0,
      jobsProcessed: 0,
      repliesReused: 0,
      completesAccepted: 0,
      completesRejected: 0,
      failuresReported: 0,
      scopeRejected: 0,
      invalidClaims: 0,
      hashUnverified: 0,
      transportErrors: 0,
      internalErrors: 0,
    };
    this.server = {
      lastHeartbeatAt: null,
      lastHeartbeatOkAt: null,
      lastHeartbeatOk: false,
      lastHeartbeatStatus: null,
      serverTime: null,
      stats: sanitizeServerStats(null),
    };
  }

  /* ----- жизненный цикл ----- */

  async start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.scheduler.now();
    await this.recover();
    // Первый heartbeat до первого claim: сервер выдаёт reply только при свежем heartbeat той же загрузки.
    await this.heartbeatOnce().catch(() => {});
    this.#scheduleHeartbeat(this.settings.heartbeatIntervalMs);
    this.workPromise = this.#workLoop();
    this.writeStatus();
  }

  /* Останавливает циклы. Текущее задание доводится до записи в outbox: результат не теряется. */
  async stop() {
    this.running = false;
    if (this.heartbeatTimer !== null) {
      this.scheduler.clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const sleeper of this.sleepers) {
      this.scheduler.clearTimeout(sleeper.timer);
      sleeper.resolve();
    }
    this.sleepers.clear();
    if (this.workPromise) await this.workPromise;
    this.workPromise = null;
    this.writeStatus();
  }

  /* Восстановление после перезапуска: взятое задание без результата продолжается только
     при подтверждённой renew аренде. Иначе оно отпускается — сервер выдаст его заново
     после истечения аренды, а лишняя генерация не тратит квоту впустую. */
  async recover() {
    const active = this.outbox.readActiveJob();
    if (!active) return null;
    const releaseInStore = () => {
      if (active.kind !== 'reply' || !active.payload || typeof active.payload.jobId !== 'string') return;
      try {
        this.store.release(active.companyCode, active.payload.jobId);
      } catch {
        /* строки могло не быть */
      }
    };
    const drop = (reason) => {
      this.logger.warn(`local-hugh: recovery_dropped reason=${JSON.stringify(reason)}`);
      this.outbox.clearActiveJob();
      releaseInStore();
      return null;
    };
    if (!active.payload) return drop('payload_unreadable');
    if (Date.parse(active.leaseExpiresAt) <= this.scheduler.now()) return drop('lease_expired');
    let response;
    try {
      response = await this.transport.post('renew', {jobId: active.jobId, leaseToken: active.leaseToken});
    } catch (error) {
      this.#noteTransportError('renew', error);
      return drop('renew_unreachable');
    }
    this.#noteTransportResult('renew', response.status);
    if (response.status !== 200 || !response.body || response.body.ok !== true) return drop('renew_rejected');
    releaseInStore(); // прежняя аренда job-store снята: генерация начнётся заново
    this.logger.warn('local-hugh: recovery_resumed');
    this.recovered = {...active, leaseExpiresAt: this.#leaseFromBody(response.body) || active.leaseExpiresAt};
    return this.recovered;
  }

  /* ----- heartbeat ----- */

  #scheduleHeartbeat(delayMs) {
    if (!this.running) return;
    this.heartbeatTimer = this.scheduler.setTimeout(() => {
      this.heartbeatTimer = null;
      this.heartbeatOnce()
        .catch(() => {})
        .finally(() => this.#scheduleHeartbeat(this.settings.heartbeatIntervalMs));
    }, delayMs);
  }

  async heartbeatOnce() {
    if (this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    try {
      const status = publicRuntimeStatus(this.runtime.statusSnapshot());
      let response;
      try {
        response = await this.transport.post('heartbeat', {bootId: this.bootId, status});
      } catch (error) {
        this.#noteTransportError('heartbeat', error);
        this.server.lastHeartbeatAt = this.scheduler.now();
        this.server.lastHeartbeatOk = false;
        this.server.lastHeartbeatStatus = null;
        return;
      }
      this.#noteTransportResult('heartbeat', response.status);
      this.server.lastHeartbeatAt = this.scheduler.now();
      this.server.lastHeartbeatStatus = response.status;
      const ok = response.status === 200 && isPlainObject(response.body) && response.body.ok === true;
      this.server.lastHeartbeatOk = ok;
      if (ok) {
        this.server.lastHeartbeatOkAt = this.server.lastHeartbeatAt;
        const serverTime = Date.parse(String(response.body.serverTime || ''));
        this.server.serverTime = Number.isFinite(serverTime) ? new Date(serverTime).toISOString() : null;
        this.server.stats = sanitizeServerStats(response.body.stats);
      } else {
        this.logger.warn(`local-hugh: heartbeat_rejected status=${JSON.stringify(response.status)}`);
      }
    } finally {
      this.heartbeatInFlight = false;
      this.writeStatus();
    }
  }

  /* ----- рабочий цикл ----- */

  async #workLoop() {
    while (this.running) {
      try {
        await this.#maintenance();
        if (this.outbox.pendingCount() > 0) {
          // Неподтверждённый результат важнее новых заданий: повтор по расписанию backoff.
          const wait = this.outboxRetryAt - this.scheduler.now();
          if (wait > 0) await this.#sleep(wait);
          else await this.flushOutbox();
          continue;
        }
        if (this.recovered) {
          const job = this.recovered;
          this.recovered = null;
          await this.processJob(job);
          continue;
        }
        const outcome = await this.claimOnce();
        if (outcome.kind === 'job') {
          this.#resetBackoff();
          await this.processJob(outcome.job);
        } else if (outcome.kind === 'idle') {
          this.#resetBackoff();
          await this.#sleep(outcome.retryAfterMs);
        } else {
          await this.#sleep(this.#nextBackoff());
        }
      } catch (error) {
        this.counters.internalErrors += 1;
        this.logger.error(`local-hugh: work_loop_error name=${JSON.stringify((error && error.name) || 'Error')}`);
        this.writeStatus();
        await this.#sleep(this.#nextBackoff());
      }
    }
  }

  /* Регулярное обслуживание: прогрев процесса, перечитывание учётной записи, уборка.
     statusSnapshot сам ничего не поднимает, поэтому это делается здесь. */
  async #maintenance() {
    const now = this.scheduler.now();
    if (now - this.lastMaintenanceAt < this.settings.maintenanceIntervalMs) return;
    this.lastMaintenanceAt = now;
    const runtime = this.runtime;
    try {
      if (!runtime.client || !runtime.client.running) {
        await runtime.warmUp();
      } else if (now - this.lastAccountRefreshAt >= this.settings.accountRefreshIntervalMs) {
        this.lastAccountRefreshAt = now;
        await runtime.refreshAccount();
        const loginPending = runtime.login && runtime.login.status === 'pending';
        if (runtime.authenticated && runtime.preflight && !runtime.preflight.ok && !loginPending) {
          await runtime.runPreflight();
        }
      }
    } catch (error) {
      this.logger.warn(`local-hugh: maintenance_failed code=${JSON.stringify((error && error.code) || 'error')}`);
    }
    if (now - this.lastPruneAt >= this.settings.pruneIntervalMs) {
      this.lastPruneAt = now;
      try {
        this.store.prune();
        this.outbox.pruneAcked(this.settings.ackedRetentionMs);
      } catch {
        this.logger.warn('local-hugh: prune_failed');
      }
    }
  }

  /* Возвращает {kind:'job', job} | {kind:'idle', retryAfterMs} | {kind:'blocked'} | {kind:'error'}. */
  async claimOnce() {
    if (this.activeJob) return {kind: 'blocked'};
    if (this.scopeCooldownUntil > this.scheduler.now()) return {kind: 'blocked'};
    let response;
    try {
      response = await this.transport.post('claim', {bootId: this.bootId});
    } catch (error) {
      this.#noteTransportError('claim', error);
      return {kind: 'error'};
    }
    this.#noteTransportResult('claim', response.status);
    if (response.status !== 200 || !isPlainObject(response.body)) {
      this.logger.warn(`local-hugh: claim_rejected status=${JSON.stringify(response.status)}`);
      return {kind: 'error'};
    }
    const body = response.body;
    if (body.job === null || body.job === undefined) {
      return {
        kind: 'idle',
        retryAfterMs: clampRetryAfterMs(body.retryAfter, this.settings.idleRetryAfterSeconds, this.settings.maxRetryAfterSeconds),
      };
    }
    const job = parseClaimedJob(body.job);
    if (!job) {
      this.counters.invalidClaims += 1;
      this.logger.error('local-hugh: claim_job_invalid');
      this.writeStatus();
      return {kind: 'error'};
    }
    this.counters.claims += 1;
    this.lastClaimAt = this.scheduler.now();
    this.outbox.saveActiveJob({...job, bootId: this.bootId, claimedAt: this.lastClaimAt});
    return {kind: 'job', job};
  }

  /* Обрабатывает одно задание: генерация, запись результата в outbox, попытка complete. */
  async processJob(job) {
    if (!this.companies.has(job.companyCode)) {
      // Чужая компания — ошибка конфигурации, а не повод отвечать. Аренда истечёт на сервере.
      this.counters.scopeRejected += 1;
      this.scopeCooldownUntil = this.scheduler.now() + this.settings.scopeCooldownMs;
      this.logger.error('local-hugh: scope_rejected');
      this.outbox.clearActiveJob();
      this.writeStatus();
      return null;
    }
    this.activeJob = {
      jobId: job.jobId,
      kind: job.kind,
      leaseToken: job.leaseToken,
      claimedAt: this.scheduler.now(),
      leaseExpiresAt: job.leaseExpiresAt,
      leaseLost: false,
    };
    this.writeStatus();
    const stopRenew = this.#startRenew(job);
    let result;
    try {
      result = job.kind === 'login' ? await this.#runLogin() : await this.#runReply(job);
    } catch (error) {
      this.counters.internalErrors += 1;
      this.logger.error(`local-hugh: job_internal_error name=${JSON.stringify((error && error.name) || 'Error')}`);
      result = contractFailure('INTERNAL_ERROR');
    } finally {
      stopRenew();
    }
    // Сначала диск, потом сеть: обрыв после этой строки ничего не теряет.
    this.outbox.enqueue({
      jobId: job.jobId,
      kind: job.kind,
      companyCode: job.companyCode,
      leaseToken: job.leaseToken,
      payloadHash: job.payloadHash,
      result,
    });
    this.activeJob = null;
    this.counters.jobsProcessed += 1;
    if (result.ok !== true) this.counters.failuresReported += 1;
    this.writeStatus();
    await this.flushOutbox();
    return result;
  }

  async #runReply(job) {
    let payload;
    try {
      payload = validateReplyPayload(job.payload);
    } catch (error) {
      this.logger.warn('local-hugh: payload_invalid');
      return toContractFailure(error);
    }
    if (payload.companyCode !== job.companyCode) {
      this.logger.warn('local-hugh: payload_company_mismatch');
      return contractFailure('INVALID_PAYLOAD');
    }
    if (payload.jobId !== `project-chat:${job.jobId}`) this.logger.warn('local-hugh: payload_job_id_mismatch');
    // Сервер хэшировал сохранённую строку; сверка здесь только информационная,
    // в complete уходит ровно полученный payloadHash.
    if (sha256(JSON.stringify(job.payload)) !== job.payloadHash) {
      this.counters.hashUnverified += 1;
      this.logger.warn('local-hugh: payload_hash_unverified');
    }
    const localHash = sha256(canonicalPayload(payload));
    let claim;
    try {
      claim = this.store.claim(payload.companyCode, payload.jobId, localHash);
    } catch (error) {
      this.logger.warn(`local-hugh: store_claim_failed code=${JSON.stringify(error instanceof RuntimeError ? error.code : 'error')}`);
      return toContractFailure(error);
    }
    if (claim.reuse) {
      this.counters.repliesReused += 1;
      return {ok: true, text: claim.reuse.text, provider: 'codex', model: claim.reuse.model || null};
    }
    try {
      const reply = await this.runtime.reply(payload);
      this.store.complete(payload.companyCode, payload.jobId, reply.text, reply.model);
      return {ok: true, text: reply.text, provider: 'codex', model: reply.model || null};
    } catch (error) {
      const code = error instanceof RuntimeError ? error.code : 'INTERNAL_ERROR';
      if (TRANSIENT_RUNTIME_CODES.has(code)) this.store.release(payload.companyCode, payload.jobId);
      else this.store.fail(payload.companyCode, payload.jobId, code);
      this.logger.warn(`local-hugh: reply_failed code=${JSON.stringify(code)}`);
      return toContractFailure(error);
    }
  }

  async #runLogin() {
    try {
      await this.runtime.startLogin();
    } catch (error) {
      this.logger.warn(`local-hugh: login_failed code=${JSON.stringify(error instanceof RuntimeError ? error.code : 'error')}`);
      return toContractFailure(error);
    }
    return {ok: true, status: this.loginStatus()};
  }

  /* Статус для complete задания login: публичные поля плюс код/ссылка/срок, и только пока
     вход действительно ожидает подтверждения и данные прошли те же проверки, что в рантайме.
     Срок берётся из runtime.login.expiresAt — не выдумывается.
     Рантайм показывает ожидающий вход как `connecting`; сервер принимает код только при
     состоянии входа, поэтому здесь оно называется `login_pending` (ops/content/project-chat-local-worker.js). */
  loginStatus() {
    const status = publicRuntimeStatus(this.runtime.statusSnapshot());
    const login = this.runtime.login || {};
    const pending =
      login.status === 'pending' &&
      Number.isFinite(login.expiresAt) &&
      login.expiresAt > this.scheduler.now() &&
      isAllowedVerificationUrl(login.verificationUrl) &&
      isAllowedUserCode(login.userCode);
    return {
      ...status,
      state: pending && !status.authenticated ? 'login_pending' : status.state,
      loginUrl: pending ? login.verificationUrl : null,
      userCode: pending ? login.userCode : null,
      expiresAt: pending ? new Date(login.expiresAt).toISOString() : null,
    };
  }

  #startRenew(job) {
    let timer = null;
    let stopped = false;
    const tick = async () => {
      timer = null;
      if (stopped) return;
      try {
        const response = await this.transport.post('renew', {jobId: job.jobId, leaseToken: job.leaseToken});
        this.#noteTransportResult('renew', response.status);
        if (response.status === 200 && isPlainObject(response.body) && response.body.ok === true) {
          const lease = this.#leaseFromBody(response.body);
          if (this.activeJob && lease) this.activeJob.leaseExpiresAt = lease;
        } else if (FINAL_REJECT_STATUSES.has(response.status)) {
          // Аренда заменена или задание снято: генерация доводится до конца, complete решит сервер.
          if (this.activeJob) this.activeJob.leaseLost = true;
          this.logger.warn(`local-hugh: renew_rejected status=${JSON.stringify(response.status)}`);
        }
      } catch (error) {
        this.#noteTransportError('renew', error);
      }
      this.writeStatus();
      if (!stopped) timer = this.scheduler.setTimeout(tick, this.settings.renewIntervalMs);
    };
    timer = this.scheduler.setTimeout(tick, this.settings.renewIntervalMs);
    return () => {
      stopped = true;
      if (timer !== null) this.scheduler.clearTimeout(timer);
      timer = null;
    };
  }

  /* Отправляет неподтверждённые результаты по порядку. Возвращает число оставшихся.
     Первый же сетевой сбой прерывает проход: порядок сохраняется, повтор — после backoff. */
  async flushOutbox() {
    let deferred = false;
    for (const item of this.outbox.pending()) {
      if (!item.result) {
        // Результат нечитаем — такое не восстановить, а сервер не примет.
        this.outbox.markAcked(item.jobId, 'rejected');
        this.counters.completesRejected += 1;
        this.logger.error('local-hugh: outbox_result_unreadable');
        continue;
      }
      let response;
      try {
        response = await this.transport.post('complete', {
          jobId: item.jobId,
          leaseToken: item.leaseToken,
          payloadHash: item.payloadHash,
          result: item.result,
        });
      } catch (error) {
        this.#noteTransportError('complete', error);
        this.outbox.recordAttempt(item.jobId, error instanceof TransportError ? error.category : 'unknown');
        deferred = true;
        break;
      }
      this.#noteTransportResult('complete', response.status);
      if (response.status === 200) {
        this.outbox.markAcked(item.jobId, 'accepted');
        this.counters.completesAccepted += 1;
        this.lastCompleteAt = this.scheduler.now();
        continue;
      }
      if (FINAL_REJECT_STATUSES.has(response.status)) {
        this.outbox.markAcked(item.jobId, 'rejected');
        this.counters.completesRejected += 1;
        this.logger.warn(`local-hugh: complete_rejected status=${JSON.stringify(response.status)}`);
        continue;
      }
      // 401 (ключ), 5xx и прочее: результат остаётся, повтор позже.
      this.outbox.recordAttempt(item.jobId, `http_${response.status}`);
      this.logger.warn(`local-hugh: complete_deferred status=${JSON.stringify(response.status)}`);
      deferred = true;
      break;
    }
    const pending = this.outbox.pendingCount();
    if (deferred) this.outboxRetryAt = this.scheduler.now() + this.#nextBackoff();
    else if (pending === 0) this.#resetBackoff();
    this.writeStatus();
    return pending;
  }

  /* ----- служебное ----- */

  #leaseFromBody(body) {
    const parsed = Date.parse(String((body && body.leaseExpiresAt) || ''));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  #noteTransportError(operation, error) {
    this.counters.transportErrors += 1;
    const category = error instanceof TransportError ? error.category : 'unknown';
    this.lastTransport = {operation, status: null, category, at: this.scheduler.now()};
    this.logger.warn(`local-hugh: ${operation}_transport_error category=${JSON.stringify(category)}`);
    this.writeStatus();
  }

  #noteTransportResult(operation, status) {
    this.lastTransport = {operation, status, category: null, at: this.scheduler.now()};
  }

  #nextBackoff() {
    this.backoffMs = this.backoffMs === 0 ? this.settings.backoffBaseMs : Math.min(this.settings.backoffMaxMs, this.backoffMs * 2);
    return this.backoffMs;
  }

  #resetBackoff() {
    this.backoffMs = 0;
  }

  #sleep(ms) {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => {
      const entry = {resolve, timer: null};
      entry.timer = this.scheduler.setTimeout(() => {
        this.sleepers.delete(entry);
        resolve();
      }, ms);
      this.sleepers.add(entry);
    });
  }

  /* Снимок для status.json: только безопасные поля (см. status-file.js). */
  snapshot() {
    const iso = (value) => (Number.isFinite(value) ? new Date(value).toISOString() : null);
    let runtimeStatus = null;
    try {
      runtimeStatus = this.runtime.statusSnapshot();
    } catch {
      runtimeStatus = null;
    }
    return buildStatusDocument({
      updatedAt: iso(this.scheduler.now()),
      bootId: this.bootId,
      startedAt: iso(this.startedAt),
      worker: {
        version: WORKER_VERSION,
        running: this.running,
        activeJob: this.activeJob
          ? {kind: this.activeJob.kind, claimedAt: iso(this.activeJob.claimedAt), leaseLost: this.activeJob.leaseLost}
          : null,
        outboxPending: this.outbox.pendingCount(),
        counters: this.counters,
        lastClaimAt: iso(this.lastClaimAt),
        lastCompleteAt: iso(this.lastCompleteAt),
        lastTransport: this.lastTransport ? {...this.lastTransport, at: iso(this.lastTransport.at)} : null,
      },
      runtime: runtimeStatus,
      loginPending: Boolean(this.runtime.login && this.runtime.login.status === 'pending'),
      server: {
        ...this.server,
        lastHeartbeatAt: iso(this.server.lastHeartbeatAt),
        lastHeartbeatOkAt: iso(this.server.lastHeartbeatOkAt),
      },
    });
  }

  writeStatus() {
    if (!this.statusWriter) return;
    try {
      this.statusWriter(this.snapshot());
    } catch {
      this.logger.warn('local-hugh: status_write_failed');
    }
  }
}

module.exports = {
  LocalHughWorker,
  WORKER_VERSION,
  DEFAULTS,
  FINAL_REJECT_STATUSES,
  parseClaimedJob,
  clampRetryAfterMs,
  realScheduler,
};

'use strict';

/* Цикл коннектора поверх существующего серверного контракта
   /content/project-chat-worker/{heartbeat,claim,renew,complete}.

   Второй очереди нет: канонической остаётся project_chat_ai_jobs на сервере, а локально
   хранится только текущее задание и неподтверждённый результат (тот же ops/local-hugh/outbox.js).
   Второго отправителя нет: текст ответа сервер сам кладёт в комнату и в существующую
   исходящую очередь Telegram — коннектор в Telegram не ходит и токен бота не видит.

   Защиты:
   - результат записывается в outbox ДО отправки complete, поэтому при обрыве он не теряется;
   - повтор того же результата сервер узнаёт по хешу и отвечает duplicate — дубля в чате нет;
   - неопределённая доставка (сеть, 5xx) остаётся в outbox и повторяется; 4xx/409 закрывают
     запись как rejected: аренда уже у другого, слать снова нельзя;
   - просроченная аренда: задание не запускается, результат по нему не отправляется;
   - чужая компания: задание не выполняется, возвращается INVALID_PAYLOAD. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createTransport, TransportError } = require('../local-hugh/transport');
const { createOutbox } = require('../local-hugh/outbox');
const { createAgentRunner } = require('./adapter');
const { buildStatus } = require('./policy');
const { failure, toFailure, AgentError } = require('./codes');

const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const EMPTY_PAYLOAD_HASH = sha256('{}');
// Ответы, после которых результат ещё имеет шанс быть принятым: закрывать запись нельзя.
const RETRYABLE_STATUS = new Set([408, 425, 429]);

function createConnector({ config, agentByName, workerKey, now = () => Date.now(), log = () => {}, spawnImpl }) {
  const transport = createTransport({ endpoint: config.endpoint, token: workerKey,
    allowInsecureLoopback: config.allowInsecureLoopback });
  // Каталог состояния создаётся до открытия базы: иначе SQLite не откроет файл.
  fs.mkdirSync(path.dirname(config.outboxPath), { recursive: true });
  fs.mkdirSync(config.workdir, { recursive: true });
  const outbox = createOutbox(config.outboxPath, { now });
  const runner = createAgentRunner(config, spawnImpl ? { spawnImpl } : {});
  // bootId постоянен для процесса: сервер сверяет его со свежим heartbeat перед выдачей задания.
  const bootId = `connector-${crypto.randomBytes(8).toString('hex')}`;
  /* Проба агента кешируется НЕ навсегда: иначе упавший агент навсегда останется «готовым».
     Срок жизни — один интервал heartbeat, но не больше минуты. */
  const PROBE_TTL_MS = Math.min(config.heartbeatIntervalMs, 60_000);
  const HISTORY_LIMIT = 50;
  // Проба кешируется ОТДЕЛЬНО по каждому агенту: у маршрутов разные процессы и разное состояние.
  const probes = new Map();

  const agentFor = (companyCode) => agentByName.get(config.routing.companies[companyCode] || config.routing.default);
  const expired = (job, at = now()) => {
    const ms = Date.parse(String(job?.leaseExpiresAt ?? ''));
    return !Number.isFinite(ms) || ms <= at;
  };

  async function refreshProbe(agent) {
    const result = await runner.probe(agent);
    probes.set(agent.name, { result, at: now() });
    return result;
  }
  const probeFresh = (agent, at = now()) => {
    const cached = probes.get(agent?.name);
    return Boolean(cached) && at - cached.at < PROBE_TTL_MS;
  };
  const probeFor = async (agent, { allowStale = false } = {}) => {
    const cached = probes.get(agent?.name);
    if (probeFresh(agent) || (allowStale && cached)) return cached.result;
    return refreshProbe(agent);
  };

  /* Состояние обработчика на сервере одно на всех: диспетчер один (см. README, «Один диспетчер»).
     Поэтому провайдер и модель заявляются только когда маршрут ведёт РОВНО к одному агенту;
     при нескольких маршрутах поля остаются пустыми — приписывать всем компаниям модель
     агента по умолчанию было бы неправдой. Фактические провайдер и модель каждого ответа
     уходят в complete по своему заданию. */
  const routedAgents = () => [...new Set([config.routing.default, ...Object.values(config.routing.companies)])];
  async function heartbeat({ allowStale = false } = {}) {
    const names = routedAgents();
    const agent = agentByName.get(config.routing.default);
    const single = names.length === 1;
    const states = [];
    for (const name of names) {
      const routed = agentByName.get(name);
      states.push(buildStatus({ probe: await probeFor(routed, { allowStale }), agent: routed }));
    }
    // Сервер хранит один общий статус: при неисправности любого маршрута новые задания ждут.
    // Независимая готовность компаний потребует отдельного серверного контракта.
    const status = { ...(states.find(state => !state.available) || states[0]) };
    if (!single) { status.provider = ''; status.model = ''; }
    const response = await transport.post('heartbeat', { bootId, status });
    if (response.status === 401 || response.status === 403) {
      // Отказ доступа — явная ошибка настройки, а не спокойный простой.
      throw Object.assign(new Error('worker_unauthorized'), { code: 'UNAUTHORIZED', status: response.status });
    }
    if (response.status !== 200) throw new TransportError('network', response.status);
    log('heartbeat', { status: response.status, state: status.state, available: status.available, agents: names.length });
    return response;
  }

  async function claim() {
    const response = await transport.post('claim', { bootId });
    if (response.status === 401 || response.status === 403) {
      throw Object.assign(new Error('worker_unauthorized'), { code: 'UNAUTHORIZED', status: response.status });
    }
    if (response.status !== 200) throw new TransportError('network', response.status);
    if (!response.body) throw new TransportError('invalid_json', response.status);
    const job = response.body.job || null;
    if (!job) return null;
    const saved = { jobId: String(job.id), kind: String(job.kind), companyCode: String(job.companyCode),
      payload: job.payload || {}, payloadHash: String(job.payloadHash || ''), leaseToken: String(job.leaseToken || ''),
      leaseExpiresAt: String(job.leaseExpiresAt || ''), bootId, claimedAt: now() };
    outbox.saveActiveJob(saved);
    log('claim', { jobId: saved.jobId, kind: saved.kind, company: saved.companyCode });
    return saved;
  }

  async function renew(job) {
    try {
      const response = await transport.post('renew', { jobId: job.jobId, leaseToken: job.leaseToken });
      if (response.status === 200 && response.body?.leaseExpiresAt) {
        job.leaseExpiresAt = String(response.body.leaseExpiresAt);
        outbox.saveActiveJob(job);
        return true;
      }
      return false;
    } catch { return false; }
  }

  /* Готовит результат задания. Наружу — только конверт контракта. */
  async function produce(job) {
    if (job.kind === 'login') {
      // Вход — устройство-логин Codex, коннектор его не умеет и не подделывает.
      log('login_declined', { jobId: job.jobId });
      return failure('UNAVAILABLE', 600);
    }
    if (!config.companies.includes(job.companyCode)) {
      log('foreign_company', { jobId: job.jobId, company: job.companyCode });
      return toFailure(new AgentError('FOREIGN_COMPANY'));
    }
    const agent = agentFor(job.companyCode);
    if (!agent) return toFailure(new AgentError('AGENT_NOT_FOUND'));
    if (!job.payload || !Array.isArray(job.payload.messages) || !job.payload.messages.length) {
      return toFailure(new AgentError('PAYLOAD_INVALID'));
    }
    try {
      const reply = await runner.reply(agent, job.payload);
      return { ok: true, text: reply.text, provider: reply.provider, model: reply.model };
    } catch (error) {
      log('agent_failed', { jobId: job.jobId, code: String(error?.code || 'INTERNAL_ERROR') });
      return toFailure(error);
    }
  }

  /* Одна попытка отправки результата. Возвращает 'accepted' | 'rejected' | 'retry'. */
  async function deliver(entry) {
    let response;
    try {
      response = await transport.post('complete', { jobId: entry.jobId, leaseToken: entry.leaseToken,
        payloadHash: entry.payloadHash, result: entry.result });
    } catch (error) {
      outbox.recordAttempt(entry.jobId, error instanceof TransportError ? error.category : 'unknown');
      return 'retry';
    }
    if (response.status === 200) { outbox.markAcked(entry.jobId, 'accepted'); return 'accepted'; }
    // Перегрузка и таймауты — временные: результат обязан дожить до повтора, а не закрыться.
    if (RETRYABLE_STATUS.has(response.status)) { outbox.recordAttempt(entry.jobId, `http_${response.status}`); return 'retry'; }
    if (response.status >= 400 && response.status < 500) {
      // 409 — аренду забрал другой исполнитель; 403 — режим обслуживания компании изменён.
      outbox.recordAttempt(entry.jobId, `http_${response.status}`);
      outbox.markAcked(entry.jobId, 'rejected');
      log('result_rejected', { jobId: entry.jobId, status: response.status });
      return 'rejected';
    }
    outbox.recordAttempt(entry.jobId, `http_${response.status}`);
    return 'retry';
  }

  async function flush() {
    const results = [];
    for (const entry of outbox.pending()) results.push({ jobId: entry.jobId, outcome: await deliver(entry) });
    return results;
  }

  /* Один цикл: досылка неподтверждённого, heartbeat, взятие задания, ответ, отправка. */
  async function tick() {
    const flushed = await flush();
    await heartbeat();
    const active = outbox.readActiveJob();
    if (active) {
      // Задание, оставшееся от прошлого запуска: результата нет, аренда, скорее всего, истекла.
      if (expired(active)) { outbox.clearActiveJob(); log('lease_expired', { jobId: active.jobId }); }
    }
    const job = await claim();
    if (!job) return { flushed, claimed: null };
    if (expired(job)) { outbox.clearActiveJob(); log('lease_expired', { jobId: job.jobId }); return { flushed, claimed: null }; }
    /* Пока агент думает, сервер должен видеть обработчика живым: без heartbeat он посчитает
       компьютер офлайн через минуту, даже при исправном renew. Новый вызов не запускается,
       пока не закончился прошлый, и пробу агента заново не гоняет. */
    let keepAlivePending = null;
    const keepAlive = setInterval(() => {
      if (keepAlivePending) return;
      keepAlivePending = Promise.allSettled([renew(job), heartbeat({ allowStale: true })])
        .finally(() => { keepAlivePending = null; });
    }, config.renewIntervalMs);
    if (typeof keepAlive.unref === 'function') keepAlive.unref();
    let result;
    try { result = await produce(job); } finally {
      clearInterval(keepAlive);
      // Продление не должно восстановить active_job после enqueue или обратиться к закрытой БД.
      if (keepAlivePending) await keepAlivePending;
    }
    // Результат ложится в outbox ДО отправки: даже при обрыве питания он не потеряется.
    outbox.enqueue({ jobId: job.jobId, kind: job.kind, companyCode: job.companyCode,
      leaseToken: job.leaseToken, payloadHash: job.payloadHash || (job.kind === 'login' ? EMPTY_PAYLOAD_HASH : ''), result });
    const outcome = await deliver(outbox.get(job.jobId));
    return { flushed, claimed: job.jobId, outcome };
  }

  /* История ограничена: длительная работа не должна расти в памяти. Хранятся последние циклы. */
  /* Временный сетевой сбой не должен ронять демон: пауза с ограниченным ростом и продолжение.
     Отказ доступа (401/403) — исключение: это ошибка настройки, её глушить нельзя. */
  const BACKOFF_STEPS = [5_000, 15_000, 60_000];
  async function run({ cycles = Infinity, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    const history = [];
    let completed = 0;
    let failures = 0;
    for (let index = 0; index < cycles; index += 1) {
      let outcome;
      try {
        outcome = await tick();
        failures = 0;
      } catch (error) {
        if (error?.code === 'UNAUTHORIZED') throw error;
        failures += 1;
        const pause = BACKOFF_STEPS[Math.min(failures - 1, BACKOFF_STEPS.length - 1)];
        outcome = { error: String(error?.category || error?.code || 'transport'), retryInMs: pause };
        log('cycle_failed', outcome);
        history.push(outcome);
        if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
        completed += 1;
        if (index + 1 < cycles) await sleep(pause);
        continue;
      }
      history.push(outcome);
      if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
      completed += 1;
      if (index + 1 < cycles) await sleep(config.heartbeatIntervalMs);
    }
    return { cycles: completed, recent: history };
  }

  return { bootId, tick, run, heartbeat, claim, renew, produce, deliver, flush, refreshProbe, probeFresh, routedAgents,
    limits: { probeTtlMs: PROBE_TTL_MS, historyLimit: HISTORY_LIMIT },
    outbox, agentFor, close: () => outbox.close() };
}

module.exports = { createConnector, EMPTY_PAYLOAD_HASH, sha256 };

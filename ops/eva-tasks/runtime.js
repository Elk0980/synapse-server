'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const API_METHODS = new Set(['getMe', 'getWebhookInfo', 'getUpdates', 'sendMessage', 'editMessageText', 'answerCallbackQuery']);
const OUTPUT_METHODS = new Set(['sendMessage', 'editMessageText', 'answerCallbackQuery']);
const EVENTS = new Set(['started', 'stopped', 'runtime_error', 'poll_error', 'delivery_error', 'handler_error',
  'output_rejected', 'access_denied', 'source_error', 'duplicate_update', 'navigation', 'stale_callback',
  'invalid_config', 'invalid_token_file', 'state_unavailable', 'cursor_save_failed', 'state_close_failed',
  'webhook_present', 'bot_identity_rejected', 'invalid_updates', 'poll_wait_failed']);
const MAX_UPDATE_ID = Number.MAX_SAFE_INTEGER - 1;
const CABINET_URL = 'https://synapse.synapsebusiness.ru/cabinet.html#tasks';

class RuntimeError extends Error {
  constructor(event, code = 0, retryAfter = 0) {
    super(event);
    this.name = 'EvaRuntimeError';
    this.code = Number.isSafeInteger(code) && code >= 0 && code <= 599 ? code : 0;
    this.retryAfter = Number.isFinite(retryAfter) ? Math.min(60, Math.max(0, retryAfter)) : 0;
  }
}

function numericCode(error) {
  return error instanceof RuntimeError ? error.code : 0;
}

// Never pass errors, URLs, IDs, task text or arbitrary event names to the log sink.
function createAudit(write = (line) => process.stdout.write(`${line}\n`)) {
  return (event, code = 0) => {
    if (!EVENTS.has(event)) return;
    try { write(JSON.stringify({ event, code: Number.isSafeInteger(code) && code >= 0 && code <= 599 ? code : 0 })); }
    catch { /* Logging failure must not leak the original payload via another logger. */ }
  };
}

function absolutePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && path.isAbsolute(value);
}

function loadConfig(env = process.env) {
  const owner = env.EVA_OWNER_USER_ID;
  const timeZone = env.EVA_TIMEZONE || 'Etc/UTC';
  if (typeof owner !== 'string' || !/^[1-9]\d*$/.test(owner) || !Number.isSafeInteger(Number(owner))) {
    throw new RuntimeError('invalid_config');
  }
  if (![env.EVA_TOKEN_FILE, env.EVA_TASK_SOCKET, env.EVA_STATE_DIR].every(absolutePath)) {
    throw new RuntimeError('invalid_config');
  }
  if (typeof timeZone !== 'string' || !/^[A-Za-z][A-Za-z0-9._+-]*(\/[A-Za-z0-9._+-]+)*$/.test(timeZone)) {
    throw new RuntimeError('invalid_config');
  }
  try { new Intl.DateTimeFormat('en', { timeZone }).format(0); }
  catch { throw new RuntimeError('invalid_config'); }
  return Object.freeze({ tokenFile: env.EVA_TOKEN_FILE, taskSocket: env.EVA_TASK_SOCKET,
    stateDir: env.EVA_STATE_DIR, ownerUserId: Number(owner), timeZone });
}

function validToken(token) {
  return typeof token === 'string' && token.length <= 4096 && /^[1-9]\d*:[A-Za-z0-9_-]+$/.test(token)
    && Number.isSafeInteger(Number(token.split(':')[0]));
}

function readToken(tokenFile) {
  if (!absolutePath(tokenFile)) throw new RuntimeError('invalid_token_file');
  try {
    const stat = fs.statSync(tokenFile);
    if (!stat.isFile() || stat.size > 4096) throw new RuntimeError('invalid_token_file');
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    if (!validToken(token)) throw new RuntimeError('invalid_token_file');
    return token;
  } catch { throw new RuntimeError('invalid_token_file'); }
}

function createTelegramTransport({ token, fetchImpl = globalThis.fetch, timeoutMs = 45000 }) {
  if (!validToken(token) || typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RuntimeError('invalid_transport');
  }
  return async (method, params = {}, { signal } = {}) => {
    if (!API_METHODS.has(method)) throw new RuntimeError('method_rejected');
    let response;
    let body;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params), signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
      body = await response.json();
    } catch {
      // Successful headers do not mean the response body arrived. A dropped or
      // truncated HTTP 200 body is a transient read failure, not a permanent 200.
      throw new RuntimeError('telegram_unavailable', response?.status >= 400 ? response.status : 0);
    }
    if (!response.ok || !body || body.ok !== true || !Object.hasOwn(body, 'result')) {
      throw new RuntimeError('telegram_rejected', Number.isInteger(body?.error_code) ? body.error_code : response.status,
        typeof body?.parameters?.retry_after === 'number' ? body.parameters.retry_after : 0);
    }
    return body.result;
  };
}

function validUpdateId(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_UPDATE_ID;
}

// This directory contains transport metadata only. A crash lock is never stolen.
function createState({ stateDir, fsImpl = fs }) {
  if (!absolutePath(stateDir)) throw new RuntimeError('invalid_state_directory');
  const lockPath = path.join(stateDir, 'runtime.lock');
  const cursorPath = path.join(stateDir, 'cursor.json');
  let lockFd;
  let lockStat;
  let cursor = -1;
  let closed = false;
  let poisoned = false;

  function close() {
    if (closed) return;
    closed = true;
    if (lockFd === undefined) return;
    try {
      const current = fsImpl.lstatSync(lockPath);
      // If an operator replaced the lock, never remove their file.
      if (current.dev !== lockStat.dev || current.ino !== lockStat.ino) throw new RuntimeError('lock_changed');
      fsImpl.closeSync(lockFd);
      lockFd = undefined;
      fsImpl.unlinkSync(lockPath);
    } catch {
      if (lockFd !== undefined) { try { fsImpl.closeSync(lockFd); } catch {} }
      throw new RuntimeError('state_close_failed');
    }
  }

  try {
    fsImpl.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    if (!fsImpl.lstatSync(stateDir).isDirectory()) throw new RuntimeError('invalid_state_directory');
    lockFd = fsImpl.openSync(lockPath, 'wx', 0o600);
    lockStat = fsImpl.fstatSync(lockFd);
    fsImpl.writeFileSync(lockFd, JSON.stringify({ version: 1, pid: process.pid }));
    fsImpl.fsyncSync(lockFd);
    try {
      const stat = fsImpl.lstatSync(cursorPath);
      if (!stat.isFile() || stat.size > 256) throw new RuntimeError('invalid_cursor');
      const saved = JSON.parse(fsImpl.readFileSync(cursorPath, 'utf8'));
      if (saved?.version !== 1 || !validUpdateId(saved.lastUpdateId)
          || Object.keys(saved).sort().join(',') !== 'lastUpdateId,version') throw new RuntimeError('invalid_cursor');
      cursor = saved.lastUpdateId;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new RuntimeError('invalid_cursor');
    }
  } catch {
    if (lockFd !== undefined) { try { close(); } catch {} }
    throw new RuntimeError('state_unavailable');
  }

  return {
    get lastUpdateId() { return cursor; },
    save(updateId) {
      if (closed || poisoned || !validUpdateId(updateId)) throw new RuntimeError('cursor_save_failed');
      if (updateId <= cursor) return;
      const temporary = path.join(stateDir, `cursor-${randomBytes(12).toString('hex')}.tmp`);
      let fd;
      let ownedTemporary = false;
      try {
        fd = fsImpl.openSync(temporary, 'wx', 0o600);
        ownedTemporary = true;
        fsImpl.writeFileSync(fd, JSON.stringify({ version: 1, lastUpdateId: updateId }));
        fsImpl.fsyncSync(fd);
        fsImpl.closeSync(fd);
        fd = undefined;
        fsImpl.renameSync(temporary, cursorPath);
        ownedTemporary = false;
        // Directory fsync makes the rename durable on the Linux server.
        // Windows does not support opening directories through this API.
        if (process.platform !== 'win32') {
          const directoryFd = fsImpl.openSync(stateDir, 'r');
          try { fsImpl.fsyncSync(directoryFd); } finally { fsImpl.closeSync(directoryFd); }
        }
        cursor = updateId;
      } catch {
        poisoned = true;
        if (fd !== undefined) { try { fsImpl.closeSync(fd); } catch {} }
        if (ownedTemporary) { try { fsImpl.unlinkSync(temporary); } catch {} }
        throw new RuntimeError('cursor_save_failed');
      }
    },
    close,
  };
}

function authorizedUpdate(update, ownerUserId) {
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0 || !validUpdateId(update?.update_id)) return false;
  if (update.message && update.callback_query) return false;
  if (update.message) {
    const message = update.message;
    return message.from?.id === ownerUserId && message.chat?.id === ownerUserId && message.chat?.type === 'private';
  }
  const callback = update.callback_query;
  return !!callback && callback.from?.id === ownerUserId && callback.message?.chat?.id === ownerUserId
    && callback.message.chat.type === 'private' && typeof callback.id === 'string'
    && callback.id.length > 0 && callback.id.length <= 256 && !callback.inline_message_id;
}

function safeKeyboard(markup) {
  if (markup === undefined) return undefined;
  if (!markup || Object.keys(markup).join(',') !== 'inline_keyboard' || !Array.isArray(markup.inline_keyboard)
      || markup.inline_keyboard.length > 30) throw new RuntimeError('output_rejected');
  return { inline_keyboard: markup.inline_keyboard.map((row) => {
    if (!Array.isArray(row) || row.length > 8) throw new RuntimeError('output_rejected');
    return row.map((button) => {
      if (!button || typeof button.text !== 'string' || !button.text.length || button.text.length > 128) {
        throw new RuntimeError('output_rejected');
      }
      const keys = Object.keys(button).sort().join(',');
      if (keys === 'text,url' && button.url === CABINET_URL) return { text: button.text, url: CABINET_URL };
      if (keys !== 'callback_data,text' || typeof button.callback_data !== 'string'
          || !/^[\x21-\x7e]{1,64}$/.test(button.callback_data)) throw new RuntimeError('output_rejected');
      return { text: button.text, callback_data: button.callback_data };
    });
  }) };
}

// Do not trust a handler's chosen destination, callback ID or API method.
function validateOutput(action, update, ownerUserId) {
  if (!authorizedUpdate(update, ownerUserId) || !OUTPUT_METHODS.has(action?.method)
      || !action.params || typeof action.params !== 'object' || Array.isArray(action.params)) {
    throw new RuntimeError('output_rejected');
  }
  const input = action.params;
  if (action.method === 'answerCallbackQuery') {
    if (!update.callback_query || input.callback_query_id !== update.callback_query.id
        || Object.keys(input).some((key) => !['callback_query_id', 'text', 'show_alert', 'cache_time'].includes(key))
        || (input.text !== undefined && (typeof input.text !== 'string' || input.text.length > 200))
        || (input.show_alert !== undefined && typeof input.show_alert !== 'boolean')
        || (input.cache_time !== undefined && input.cache_time !== 0)) throw new RuntimeError('output_rejected');
    return { method: action.method, params: { ...input, cache_time: 0 } };
  }
  const keys = ['chat_id', 'text', 'reply_markup', 'link_preview_options'];
  if (action.method === 'editMessageText') keys.push('message_id');
  if (input.chat_id !== ownerUserId || typeof input.text !== 'string' || !input.text.length || input.text.length > 4096
      || Object.keys(input).some((key) => !keys.includes(key))
      || (input.link_preview_options !== undefined && (input.link_preview_options?.is_disabled !== true
        || Object.keys(input.link_preview_options).join(',') !== 'is_disabled'))) throw new RuntimeError('output_rejected');
  const params = { chat_id: ownerUserId, text: input.text, link_preview_options: { is_disabled: true } };
  if (action.method === 'editMessageText') {
    if (!Number.isSafeInteger(input.message_id) || input.message_id <= 0
        || input.message_id !== update.callback_query?.message?.message_id) throw new RuntimeError('output_rejected');
    params.message_id = input.message_id;
  }
  const markup = safeKeyboard(input.reply_markup);
  if (markup !== undefined) params.reply_markup = markup;
  return { method: action.method, params };
}

async function processBatch({ updates, state, bot, transport, ownerUserId, audit = () => {}, signal }) {
  if (!Array.isArray(updates) || updates.some((update) => !validUpdateId(update?.update_id))) {
    throw new RuntimeError('invalid_updates');
  }
  let handled = 0;
  for (const update of [...updates].sort((a, b) => a.update_id - b.update_id)) {
    if (signal?.aborted) break;
    if (update.update_id <= state.lastUpdateId) { audit('duplicate_update'); continue; }
    // At-most-once delivery: a crash after this save may lose a display, never replay it.
    // Failure to persist is fatal and occurs before reading tasks or sending messages.
    await state.save(update.update_id);
    handled += 1;
    if (!authorizedUpdate(update, ownerUserId)) { audit('access_denied'); continue; }
    let actions;
    try { actions = await bot.handleUpdate(update); }
    catch { audit('handler_error'); continue; }
    if (!Array.isArray(actions) || actions.length > 5) { audit('output_rejected'); continue; }
    let outputs;
    try { outputs = actions.map((action) => validateOutput(action, update, ownerUserId)); }
    catch { audit('output_rejected'); continue; }
    for (const action of outputs) {
      try { await transport(action.method, action.params, { signal }); }
      catch (error) {
        // Never retry a send after an ambiguous response; a new owner action is safe.
        audit('delivery_error', numericCode(error));
      }
    }
  }
  return handled;
}

async function startupCheck({ transport, expectedBotId, signal }) {
  const identity = await transport('getMe', {}, { signal });
  if (!identity || identity.is_bot !== true || !Number.isSafeInteger(identity.id) || identity.id <= 0
      || (expectedBotId !== undefined && identity.id !== expectedBotId)) throw new RuntimeError('bot_identity_rejected');
  const webhook = await transport('getWebhookInfo', {}, { signal });
  if (!webhook || webhook.url !== '') throw new RuntimeError('webhook_present');
}

async function runOnce(options) {
  const updates = await options.transport('getUpdates', {
    offset: options.state.lastUpdateId + 1, timeout: 30, limit: 50,
    allowed_updates: ['message', 'callback_query'],
  }, { signal: options.signal });
  return processBatch({ ...options, updates });
}

async function poll(options) {
  let backoff = 1;
  const sleep = options.sleep || ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  while (!options.signal?.aborted) {
    try { await runOnce(options); backoff = 1; }
    catch (error) {
      if (options.signal?.aborted) break;
      const code = numericCode(error);
      // Only transient transport failures retry. Cursor/handler protocol failures stop.
      if (!(error instanceof RuntimeError) || !['telegram_unavailable', 'telegram_rejected'].includes(error.message)
          || code === 409 || (code !== 0 && code !== 429 && code < 500)) throw error;
      options.audit?.('poll_error', code);
      const seconds = Math.min(60, Math.max(backoff, error.retryAfter));
      try { await sleep(seconds * 1000, options.signal); }
      catch { if (options.signal?.aborted) break; throw new RuntimeError('poll_wait_failed'); }
      backoff = Math.min(60, backoff * 2);
    }
  }
}

async function main() {
  const audit = createAudit();
  const config = loadConfig();
  const token = readToken(config.tokenFile);
  const transport = createTelegramTransport({ token });
  const state = createState({ stateDir: config.stateDir });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let source;
  try {
    await startupCheck({ transport, expectedBotId: Number(token.split(':')[0]), signal: controller.signal });
    const { createTaskSource } = require('./socket-source');
    const { createBot } = require('./bot');
    source = createTaskSource({ socketPath: config.taskSocket });
    const bot = createBot({ ownerUserId: config.ownerUserId, source, timeZone: config.timeZone, audit });
    audit('started');
    await poll({ transport, state, bot, ownerUserId: config.ownerUserId, audit, signal: controller.signal });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    try { source?.close(); } finally { state.close(); }
    audit('stopped');
  }
}

module.exports = { RuntimeError, createAudit, loadConfig, readToken, createTelegramTransport, createState,
  authorizedUpdate, validateOutput, processBatch, startupCheck, runOnce, poll, main };

if (require.main === module) {
  main().catch((error) => {
    createAudit()(error instanceof RuntimeError && EVENTS.has(error.message) ? error.message : 'runtime_error', numericCode(error));
    process.exitCode = 1;
  });
}

'use strict';

/* Клиент stdio-транспорта Codex app-server.
   Формат подтверждён в codex-rs/app-server-protocol/src/rpc.rs тега rust-v0.154.0:
   по одному JSON-объекту на строку, без поля "jsonrpc".
   Запрос  {id, method, params}
   Ответ   {id, result} либо {id, error:{code, message, data}}
   Событие {method, params, emittedAtMs}

   Процесс запускается только через spawn с shell:false и заранее собранным окружением.
   Ни одна строка HTTP-запроса не попадает в аргументы, путь, конфигурацию или окружение. */

const {EventEmitter} = require('node:events');
const {spawn} = require('node:child_process');

const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 8 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 5_000;

class AppServerClient extends EventEmitter {
  constructor(options) {
    super();
    this.executable = options.executable;
    this.args = Object.freeze([...(options.args || [])]);
    this.env = Object.freeze({...(options.env || {})});
    this.cwd = options.cwd;
    this.maxLineBytes = options.maxLineBytes || DEFAULT_MAX_LINE_BYTES;
    this.maxStderrBytes = options.maxStderrBytes || DEFAULT_MAX_STDERR_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.stderrTail = '';
    this.exitInfo = null;
    this.stopping = false;
    this.markClosed = () => {};
    // Позволяет дождаться реального завершения процесса перед уборкой файлов.
    this.closed = new Promise((resolve) => {
      this.markClosed = resolve;
    });
  }

  get running() {
    return Boolean(this.child) && this.exitInfo === null;
  }

  start() {
    if (this.child) throw new Error('app-server уже запущен');
    const child = spawn(this.executable, [...this.args], {
      shell: false,
      cwd: this.cwd,
      env: {...this.env},
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    child.stderr.on('data', (chunk) => this.#onStderr(chunk));
    // Разрыв канала после смерти процесса не должен валить родителя.
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => {});
    child.on('error', (error) => {
      this.#onExit({reason: 'spawn_failed', detail: error.message});
      this.markClosed(this.exitInfo);
    });
    child.on('exit', (code, signal) => this.#onExit({reason: 'exit', code, signal}));
    // close наступает после закрытия всех потоков: только тогда Windows отпускает файлы.
    child.on('close', () => this.markClosed(this.exitInfo));
    return child;
  }

  #onStderr(chunk) {
    // Журнал дочернего процесса остаётся внутри: наружу он не уходит никогда.
    this.stderrTail = (this.stderrTail + chunk).slice(-this.maxStderrBytes);
  }

  #onStdout(chunk) {
    this.stdoutBuffer += chunk;
    let index = this.stdoutBuffer.indexOf('\n');
    while (index !== -1) {
      const line = this.stdoutBuffer.slice(0, index);
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      this.#onLine(line.trim());
      index = this.stdoutBuffer.indexOf('\n');
    }
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > this.maxLineBytes) {
      this.stdoutBuffer = '';
      this.emit('protocolError', 'stdout_line_too_long');
      this.stop('stdout_line_too_long');
    }
  }

  #onLine(line) {
    if (!line) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit('protocolError', 'invalid_json');
      return;
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      this.emit('protocolError', 'invalid_message');
      return;
    }
    const hasId = Object.hasOwn(message, 'id');
    if (hasId && typeof message.method === 'string') {
      this.emit('serverRequest', {id: message.id, method: message.method, params: message.params ?? {}});
      return;
    }
    if (hasId) {
      this.#settle(message);
      return;
    }
    if (typeof message.method === 'string') {
      this.emit('notification', message.method, message.params ?? {});
      return;
    }
    this.emit('protocolError', 'unknown_message');
  }

  #settle(message) {
    const key = String(message.id);
    const entry = this.pending.get(key);
    if (!entry) {
      // Ответ на чужой или уже завершённый идентификатор отбрасывается.
      this.emit('protocolError', 'unexpected_response_id');
      return;
    }
    this.pending.delete(key);
    clearTimeout(entry.timer);
    if (message.error) {
      const error = new Error('app-server вернул ошибку');
      error.rpcCode = message.error.code;
      error.rpcMessage = String(message.error.message || '');
      entry.reject(error);
      return;
    }
    entry.resolve(message.result ?? null);
  }

  #write(payload) {
    if (!this.running) throw new Error('app-server не запущен');
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method, params, options = {}) {
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs || this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        const error = new Error('app-server не ответил вовремя');
        error.rpcCode = 'timeout';
        reject(error);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(String(id), {resolve, reject, timer, method});
      try {
        this.#write({id, method, params: params ?? {}});
      } catch (error) {
        this.pending.delete(String(id));
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.#write({method, params: params ?? {}});
  }

  respond(id, result) {
    this.#write({id, result: result ?? {}});
  }

  respondError(id, code, message) {
    this.#write({id, error: {code, message}});
  }

  #onExit(info) {
    if (this.exitInfo) return;
    this.exitInfo = info;
    for (const [key, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(key);
      const error = new Error('app-server завершился');
      error.rpcCode = 'process_exit';
      entry.reject(error);
    }
    this.emit('exit', info);
  }

  /* Останавливает процесс вместе с группой: осиротевших потомков остаться не должно.
     Возвращает промис завершения, чтобы вызывающий мог дождаться освобождения файлов. */
  stop(reason = 'stop') {
    if (!this.child) return Promise.resolve(null);
    if (this.exitInfo || this.stopping) return this.closed;
    this.stopping = true;
    const child = this.child;
    const killGroup = (signal) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* процесс уже завершён */
        }
      }
    };
    killGroup('SIGTERM');
    const timer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    child.once('exit', () => clearTimeout(timer));
    this.emit('stopping', reason);
    return this.closed;
  }
}

module.exports = {
  AppServerClient,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
};

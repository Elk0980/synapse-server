'use strict';

/* Адаптер ИИ: запуск любой CLI, которая читает запрос со стандартного ввода и печатает ответ.
   Модель и поставщик здесь не зашиты — их объявляет конфигурация, а коннектор передаёт
   на сервер как есть. Неизвестная модель остаётся пустой строкой: выдумывать нельзя.

   Дочерний процесс получает ТОЛЬКО собранное с нуля окружение и отдельный пустой рабочий каталог.
   Ключ сервера, cookies браузера и токен бота в дочерний процесс не попадают никогда:
   их нет в окружении коннектора в момент сборки env (см. envFor) и нет в аргументах. */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { AgentError } = require('./codes');
const { inspectSpawn } = require('./spawn-guard');

const PROMPT_HEADER = 'Ты — Хью, ассистент проекта. Ответь клиенту одним сообщением на русском языке.';

/* Запрос сервера → текст для CLI. Формат payload задан сервером (buildPayload в project-chat.js):
   {jobId, companyCode, system, messages:[{role,content}]}. */
function renderPrompt(payload) {
  const lines = [PROMPT_HEADER, '', '### Инструкция проекта', String(payload.system || '').trim(), '', '### Переписка'];
  for (const message of Array.isArray(payload.messages) ? payload.messages : []) {
    const who = message.role === 'assistant' ? 'Хью' : 'Клиент';
    lines.push(`${who}: ${String(message.content || '').trim()}`);
  }
  lines.push('', '### Ответ Хью');
  return lines.join('\n');
}

function envFor(agent, { readFile = fs.readFileSync } = {}) {
  const env = Object.create(null);
  for (const name of agent.envPassthrough) {
    const value = process.env[name];
    if (typeof value === 'string') env[name] = value;
  }
  for (const [name, file] of Object.entries(agent.secretEnvFrom)) {
    let secret;
    try { secret = String(readFile(file, 'utf8')).trim(); } catch { throw new AgentError('AGENT_CREDENTIALS_MISSING'); }
    if (!secret) throw new AgentError('AGENT_CREDENTIALS_MISSING');
    env[name] = secret;
  }
  return env;
}

/* План запуска без секретов — то, что проверяет spawn-guard и что можно печатать. */
function spawnPlan(agent, config, args) {
  return {
    shell: false, workdir: config.workdir, stateDir: config.stateDir,
    timeoutMs: config.jobTimeoutMs, maxOutputBytes: config.maxOutputBytes,
    args, envNames: [...agent.envPassthrough, ...Object.keys(agent.secretEnvFrom)],
  };
}

function ensureWorkdir(workdir) {
  fs.mkdirSync(workdir, { recursive: true });
  return workdir;
}

/* Запускает процесс и возвращает {code, stdout, stderrSize}. Наружу отдаётся только stdout:
   stderr не пересылается и не печатается — там могут оказаться пути и фрагменты запроса. */
function runProcess(agent, config, args, input, { spawnImpl = spawn } = {}) {
  const plan = spawnPlan(agent, config, args);
  const guard = inspectSpawn(plan);
  if (!guard.safe) throw new AgentError('SPAWN_GUARD_FAILED');
  const env = envFor(agent);
  ensureWorkdir(config.workdir);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(agent.command, args, { cwd: config.workdir, env, shell: false, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { reject(new AgentError('AGENT_NOT_FOUND')); return; }
    let settled = false, size = 0, stderrSize = 0;
    const chunks = [];
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => { finish(reject, new AgentError('AGENT_TIMEOUT')); try { child.kill('SIGKILL'); } catch { /* уже мёртв */ } }, config.jobTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.on('error', () => finish(reject, new AgentError('AGENT_NOT_FOUND')));
    /* Агент может закрыть stdin раньше, чем мы дописали запрос: EPIPE здесь ожидаем и не должен
       ронять процесс коннектора. Итог задания определяет код возврата, а не эта ошибка записи. */
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > config.maxOutputBytes) { finish(reject, new AgentError('AGENT_OUTPUT_TOO_LARGE')); try { child.kill('SIGKILL'); } catch { /* уже мёртв */ } return; }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => { stderrSize += chunk.length; });
    /* code === null означает завершение сигналом (в том числе нашим SIGKILL по таймауту).
       Number(null) дал бы 0 и превратил убитый процесс в «успех» — поэтому null сохраняем. */
    child.on('close', (code, signal) => finish(resolve, { code: code === null ? null : Number(code),
      signal: signal || null, stdout: Buffer.concat(chunks).toString('utf8'), stderrSize }));
    if (input !== null && input !== undefined) child.stdin.end(String(input), 'utf8');
    else child.stdin.end();
  });
}

function parseOutput(agent, stdout) {
  if (agent.output === 'text') return String(stdout || '').trim();
  let parsed;
  try { parsed = JSON.parse(String(stdout || '').trim()); } catch { throw new AgentError('AGENT_BAD_OUTPUT'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AgentError('AGENT_BAD_OUTPUT');
  const value = parsed[agent.textField];
  if (typeof value !== 'string') throw new AgentError('AGENT_BAD_OUTPUT');
  return value.trim();
}

/* Модель берётся из ответа агента, если он её назвал; иначе — из конфигурации; иначе пусто.
   Строка, не прошедшая ограничения сервера, отбрасывается, а не «исправляется». */
function reportedModel(agent, stdout) {
  if (agent.output !== 'json') return agent.model;
  try {
    const parsed = JSON.parse(String(stdout || '').trim());
    const value = String(parsed?.model ?? '');
    if (value && /^[\w.:/-]{1,60}$/.test(value)) return value;
  } catch { /* ответ не JSON — модель остаётся из конфигурации */ }
  return agent.model;
}

function createAgentRunner(config, { spawnImpl = spawn } = {}) {
  /* Проверка готовности: запускает агента с probeArgs. Сеть не используется коннектором,
     но сам агент может обращаться к своему поставщику — это его дело и его ключ. */
  async function probe(agent) {
    const started = Date.now();
    try {
      const result = await runProcess(agent, config, agent.probeArgs, null, { spawnImpl });
      // Успех — только явный нулевой код. Завершение сигналом успехом не считается.
      const ok = result.code === 0 && result.signal === null;
      return { name: agent.name, ok, exitCode: result.code, signal: result.signal, ms: Date.now() - started,
        spawnGuard: inspectSpawn(spawnPlan(agent, config, agent.probeArgs)),
        credentials: credentialState(agent), reason: ok ? '' : (result.signal ? 'killed' : 'exit_code') };
    } catch (error) {
      return { name: agent.name, ok: false, exitCode: null, ms: Date.now() - started,
        spawnGuard: inspectSpawn(spawnPlan(agent, config, agent.probeArgs)),
        credentials: credentialState(agent), reason: String(error.code || 'AGENT_FAILED') };
    }
  }

  /* Готовит ответ клиенту. Бросает AgentError — вызывающий переводит его в код контракта. */
  async function reply(agent, payload) {
    const prompt = renderPrompt(payload);
    const input = agent.input === 'stdin-json'
      ? JSON.stringify({ system: payload.system, messages: payload.messages, prompt })
      : prompt;
    const result = await runProcess(agent, config, agent.args, input, { spawnImpl });
    if (result.code !== 0 || result.signal !== null) throw new AgentError('AGENT_FAILED');
    const text = parseOutput(agent, result.stdout);
    if (!text) throw new AgentError('AGENT_EMPTY');
    return { text, provider: agent.provider, model: reportedModel(agent, result.stdout) };
  }

  return { probe, reply, renderPrompt, spawnPlan: (agent, args) => spawnPlan(agent, config, args || agent.args) };
}

/* Наличие файлов секретов — без чтения значений. */
function credentialState(agent) {
  const names = Object.keys(agent.secretEnvFrom);
  const missing = names.filter((name) => {
    try { return !String(fs.readFileSync(agent.secretEnvFrom[name], 'utf8')).trim(); } catch { return true; }
  });
  return { required: agent.requiresCredentials, names, missing, ok: !agent.requiresCredentials || (names.length > 0 && missing.length === 0) };
}

module.exports = { createAgentRunner, renderPrompt, parseOutput, envFor, credentialState, spawnPlan, PROMPT_HEADER, ensureWorkdir, path };

#!/usr/bin/env node
'use strict';

/* Командная строка коннектора. Внешние действия названы явно:

   help            — офлайн, ничего не запускает и никуда не ходит;
   doctor          — офлайн: только читает конфигурацию и проверяет файлы. Сеть не трогает,
                     агента не запускает, значения ключей и секретов не печатает;
   probe           — ВНЕШНЕЕ ДЕЙСТВИЕ: запускает локальный процесс ИИ (агент может сам пойти
                     в сеть к своему поставщику). В кабинет и Telegram не ходит;
   status          — ВНЕШНЕЕ ДЕЙСТВИЕ: один heartbeat на сервер кабинета;
   once            — ВНЕШНЕЕ ДЕЙСТВИЕ: один цикл (heartbeat, попытка взять задание, ответ, отправка);
   run             — ВНЕШНЕЕ ДЕЙСТВИЕ: цикл до остановки.

   Переписка клиентов, ключи и секреты не печатаются никогда: в выводе только идентификаторы
   заданий, коды и размеры. */

const { loadConfig, readWorkerKey, redacted, ConfigError } = require('./config');
const { createAgentRunner } = require('./adapter');
const { credentialState } = require('./adapter');
const { createConnector } = require('./connector');
const { SAFETY_REASON } = require('./policy');

const HELP = `hugh-agent-connector — общий коннектор ответов Хью

  node cli.js help                         офлайн, эта справка
  node cli.js doctor --config <путь>       офлайн, проверка конфигурации и файлов
  node cli.js probe  --config <путь> [--agent имя]   ВНЕШНЕЕ: запуск локального ИИ
  node cli.js status --config <путь>       ВНЕШНЕЕ: один heartbeat на сервер
  node cli.js once   --config <путь>       ВНЕШНЕЕ: один цикл работы
  node cli.js run    --config <путь>       ВНЕШНЕЕ: работа до остановки

Границы, заложенные в код: safety.toolIsolationVerified и authenticated у этого коннектора
всегда false (${SAFETY_REASON}) — подтвердить изоляцию инструментов и вход модели внешнего
интерактивного ИИ он не может. Вместо ложного входа заявляется readiness=attested.

Право отвечать даёт только сервер: компания должна быть названа в HUGH_TRUSTED_AGENT_COMPANIES.
Пока её там нет, коннектор работает вхолостую — heartbeat уходит, заданий нет. Режим
изолированного Codex этим не затрагивается. Подробности: README.md.`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item.startsWith('--')) { args[item.slice(2)] = argv[index + 1]?.startsWith('--') || argv[index + 1] === undefined ? true : argv[index += 1]; }
    else args._.push(item);
  }
  return args;
}

function doctor(args, out) {
  const { config, agentByName } = loadConfig(args.config);
  const report = { config: redacted(config), checks: [] };
  const check = (name, ok, detail = '') => report.checks.push({ name, ok, detail });
  let key = null;
  try { key = readWorkerKey(config); check('worker_key_file', true, 'ключ прочитан, значение не печатается'); }
  catch (error) { check('worker_key_file', false, error.code); }
  check('endpoint_https', config.secure || config.allowInsecureLoopback, config.secure ? 'https' : 'http разрешён только для loopback в тестах');
  const runner = createAgentRunner(config);
  for (const agent of config.agents) {
    const plan = runner.spawnPlan(agent);
    const guard = require('./spawn-guard').inspectSpawn(plan);
    check(`agent_${agent.name}_spawn_guard`, guard.safe, guard.reason || 'запуск проверен');
    const credentials = credentialState(agent);
    check(`agent_${agent.name}_credentials`, credentials.ok, credentials.missing.length ? `нет значений: ${credentials.missing.join(',')}` : 'файлы на месте');
  }
  check('tool_isolation_proof', false, `${SAFETY_REASON}: подтверждения изоляции инструментов нет и не будет; ответы возможны только если сервер назвал компанию в HUGH_TRUSTED_AGENT_COMPANIES`);
  check('trusted_mode_hint', true, 'включение проверяется на сервере: doctor этого не видит и не проверяет');
  report.ok = report.checks.every((item) => item.ok || item.name === 'tool_isolation_proof');
  out(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

async function probe(args, out) {
  const { config, agentByName } = loadConfig(args.config);
  const runner = createAgentRunner(config);
  const names = typeof args.agent === 'string' ? [args.agent] : config.agents.map((agent) => agent.name);
  const results = [];
  for (const name of names) {
    const agent = agentByName.get(name);
    if (!agent) { results.push({ name, ok: false, reason: 'unknown_agent' }); continue; }
    const result = await runner.probe(agent);
    results.push({ name: result.name, ok: result.ok, exitCode: result.exitCode, ms: result.ms,
      spawnGuard: result.spawnGuard.safe, reason: result.reason, credentials: result.credentials.ok });
  }
  out(JSON.stringify({ probe: results }, null, 2));
  return results.every((item) => item.ok) ? 0 : 1;
}

async function online(args, out, mode) {
  const { config, agentByName } = loadConfig(args.config);
  const workerKey = readWorkerKey(config);
  const connector = createConnector({ config, agentByName, workerKey });
  try {
    if (mode === 'status') { const response = await connector.heartbeat(); out(JSON.stringify({ heartbeat: response.status, bootId: connector.bootId }, null, 2)); return 0; }
    if (mode === 'once') { const result = await connector.tick(); out(JSON.stringify(result, null, 2)); return 0; }
    await connector.run({});
    return 0;
  } finally { connector.close(); }
}

async function main(argv = process.argv.slice(2), out = (text) => process.stdout.write(`${text}\n`)) {
  const args = parseArgs(argv);
  const command = args._[0] || 'help';
  if (command === 'help' || args.help) { out(HELP); return 0; }
  if (!args.config || args.config === true) { out('Нужен --config <путь к connector.config.json>'); return 2; }
  try {
    if (command === 'doctor') return doctor(args, out);
    if (command === 'probe') return await probe(args, out);
    if (['status', 'once', 'run'].includes(command)) return await online(args, out, command);
    out(HELP);
    return 2;
  } catch (error) {
    // Наружу — только код ошибки конфигурации: путей с секретами и текстов исключений здесь нет.
    out(JSON.stringify({ error: error instanceof ConfigError ? error.code : 'failed' }));
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
}

module.exports = { main, parseArgs, HELP };

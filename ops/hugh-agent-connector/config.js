'use strict';

/* Конфигурация коннектора: JSON вне Git, белый список ключей, никаких секретов внутри.

   Ключ сервера лежит в отдельном файле (keyFile) и возвращается ОТДЕЛЬНО от настроек,
   чтобы не попасть ни в статус, ни в журнал, ни в окружение дочернего процесса ИИ.
   Секреты агентов задаются только путями к файлам (secretEnvFrom) — значения не читаются
   при загрузке конфигурации и никогда не печатаются. */

const fs = require('node:fs');
const path = require('node:path');
const { validateEndpoint, EndpointError } = require('../local-hugh/transport');

const CONFIG_SCHEMA = 1;
const CONFIG_KEYS = Object.freeze(['_комментарий', 'schema', 'endpoint', 'keyFile', 'companies', 'agents', 'routing',
  'stateDir', 'outboxPath', 'statusPath', 'jobTimeoutMs', 'heartbeatIntervalMs', 'renewIntervalMs',
  'maxOutputBytes', 'allowInsecureLoopback']);
const AGENT_KEYS = Object.freeze(['name', 'provider', 'model', 'command', 'args', 'probeArgs', 'input',
  'output', 'textField', 'envPassthrough', 'secretEnvFrom', 'requiresCredentials']);

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const COMPANY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const PROVIDER_PATTERN = /^[\w.-]{1,40}$/;             // ограничения сервера: publicStatus.provider
const MODEL_PATTERN = /^[\w.:/-]{0,60}$/;              // ограничения сервера: publicStatus.model
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const WORKER_KEY_PATTERN = /^[A-Za-z0-9._~+/=-]{16,512}$/;
const INPUTS = new Set(['stdin-json', 'stdin-text']);
const OUTPUTS = new Set(['json', 'text']);

const INT_BOUNDS = Object.freeze({
  jobTimeoutMs: { min: 10_000, max: 600_000, fallback: 120_000 },
  heartbeatIntervalMs: { min: 5_000, max: 60_000, fallback: 20_000 },
  renewIntervalMs: { min: 5_000, max: 60_000, fallback: 20_000 },
  maxOutputBytes: { min: 1024, max: 1_000_000, fallback: 256 * 1024 },
});

class ConfigError extends Error {
  constructor(code) { super(code); this.name = 'ConfigError'; this.code = code; }
}

const resolveFrom = (baseDir, value, key) => {
  if (typeof value !== 'string' || !value.trim()) throw new ConfigError(`${key}_invalid`);
  return path.resolve(baseDir, value);
};

function integer(value, key) {
  const bounds = INT_BOUNDS[key];
  if (value === undefined) return bounds.fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < bounds.min || number > bounds.max) throw new ConfigError(`${key}_invalid`);
  return number;
}

function readAgent(raw, baseDir, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`agent_${index}_invalid`);
  for (const key of Object.keys(raw)) if (!AGENT_KEYS.includes(key)) throw new ConfigError(`agent_${index}_unknown_key_${key}`);
  const name = String(raw.name ?? '');
  if (!NAME_PATTERN.test(name)) throw new ConfigError(`agent_${index}_name_invalid`);
  const provider = String(raw.provider ?? name);
  if (!PROVIDER_PATTERN.test(provider)) throw new ConfigError(`agent_${name}_provider_invalid`);
  const model = String(raw.model ?? '');
  if (!MODEL_PATTERN.test(model)) throw new ConfigError(`agent_${name}_model_invalid`);
  const command = resolveFrom(baseDir, raw.command, `agent_${name}_command`);
  const args = Array.isArray(raw.args) ? raw.args.map((item) => String(item)) : [];
  const probeArgs = Array.isArray(raw.probeArgs) ? raw.probeArgs.map((item) => String(item)) : ['--version'];
  const input = String(raw.input ?? 'stdin-json');
  if (!INPUTS.has(input)) throw new ConfigError(`agent_${name}_input_invalid`);
  const output = String(raw.output ?? 'text');
  if (!OUTPUTS.has(output)) throw new ConfigError(`agent_${name}_output_invalid`);
  const textField = String(raw.textField ?? 'text');
  if (output === 'json' && !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(textField)) throw new ConfigError(`agent_${name}_textField_invalid`);
  const envPassthrough = Array.isArray(raw.envPassthrough) ? raw.envPassthrough.map((item) => String(item)) : ['PATH'];
  for (const envName of envPassthrough) if (!ENV_NAME_PATTERN.test(envName)) throw new ConfigError(`agent_${name}_envPassthrough_invalid`);
  const secretSource = raw.secretEnvFrom && typeof raw.secretEnvFrom === 'object' && !Array.isArray(raw.secretEnvFrom) ? raw.secretEnvFrom : {};
  const secretEnvFrom = {};
  for (const [envName, file] of Object.entries(secretSource)) {
    if (!ENV_NAME_PATTERN.test(envName)) throw new ConfigError(`agent_${name}_secretEnv_name_invalid`);
    secretEnvFrom[envName] = resolveFrom(baseDir, file, `agent_${name}_secretEnv_${envName}`);
  }
  const requiresCredentials = raw.requiresCredentials === undefined
    ? Object.keys(secretEnvFrom).length > 0
    : raw.requiresCredentials === true;
  return { name, provider, model, command, args, probeArgs, input, output, textField, envPassthrough, secretEnvFrom, requiresCredentials };
}

/* Возвращает {config, workerKey}. Ключ не входит в config и нигде больше не хранится. */
function loadConfig(configPath, { readFile = fs.readFileSync } = {}) {
  const file = path.resolve(String(configPath || ''));
  const baseDir = path.dirname(file);
  let raw;
  try { raw = JSON.parse(readFile(file, 'utf8')); } catch { throw new ConfigError('config_unreadable'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('config_invalid');
  for (const key of Object.keys(raw)) if (!CONFIG_KEYS.includes(key)) throw new ConfigError(`unknown_key_${key}`);
  if (raw.schema !== CONFIG_SCHEMA) throw new ConfigError('schema_unsupported');

  const allowInsecureLoopback = raw.allowInsecureLoopback === true;
  let endpoint;
  try { endpoint = validateEndpoint(raw.endpoint, { allowInsecureLoopback }); }
  catch (error) { throw new ConfigError(error instanceof EndpointError ? `endpoint_${error.reason}` : 'endpoint_invalid'); }

  const companies = [...new Set((Array.isArray(raw.companies) ? raw.companies : []).map((item) => String(item)))];
  if (!companies.length) throw new ConfigError('companies_empty');
  for (const code of companies) if (!COMPANY_PATTERN.test(code)) throw new ConfigError('companies_invalid');

  const agents = (Array.isArray(raw.agents) ? raw.agents : []).map((item, index) => readAgent(item, baseDir, index));
  if (!agents.length) throw new ConfigError('agents_empty');
  const byName = new Map();
  for (const agent of agents) {
    if (byName.has(agent.name)) throw new ConfigError(`agent_${agent.name}_duplicate`);
    byName.set(agent.name, agent);
  }

  const routingRaw = raw.routing && typeof raw.routing === 'object' && !Array.isArray(raw.routing) ? raw.routing : {};
  const defaultAgent = String(routingRaw.default ?? agents[0].name);
  if (!byName.has(defaultAgent)) throw new ConfigError('routing_default_unknown');
  const perCompany = {};
  const companyRouting = routingRaw.companies && typeof routingRaw.companies === 'object' && !Array.isArray(routingRaw.companies) ? routingRaw.companies : {};
  for (const [code, agentName] of Object.entries(companyRouting)) {
    if (!companies.includes(code)) throw new ConfigError('routing_company_unknown');
    if (!byName.has(String(agentName))) throw new ConfigError('routing_agent_unknown');
    perCompany[code] = String(agentName);
  }

  const stateDir = resolveFrom(baseDir, raw.stateDir ?? 'state', 'stateDir');
  const config = {
    schema: CONFIG_SCHEMA,
    endpoint: raw.endpoint,
    endpointOrigin: endpoint.origin,
    secure: endpoint.secure,
    allowInsecureLoopback,
    companies,
    agents,
    routing: { default: defaultAgent, companies: perCompany },
    stateDir,
    workdir: path.join(stateDir, 'agent-workdir'),
    outboxPath: resolveFrom(baseDir, raw.outboxPath ?? path.join(stateDir, 'connector-outbox.sqlite'), 'outboxPath'),
    statusPath: resolveFrom(baseDir, raw.statusPath ?? path.join(stateDir, 'status.json'), 'statusPath'),
    jobTimeoutMs: integer(raw.jobTimeoutMs, 'jobTimeoutMs'),
    heartbeatIntervalMs: integer(raw.heartbeatIntervalMs, 'heartbeatIntervalMs'),
    renewIntervalMs: integer(raw.renewIntervalMs, 'renewIntervalMs'),
    maxOutputBytes: integer(raw.maxOutputBytes, 'maxOutputBytes'),
    keyFile: resolveFrom(baseDir, raw.keyFile, 'keyFile'),
  };
  return { config, agentByName: byName };
}

/* Ключ читается отдельным вызовом и только там, где он нужен транспорту. */
function readWorkerKey(config, { readFile = fs.readFileSync } = {}) {
  let text;
  try { text = String(readFile(config.keyFile, 'utf8')).trim(); } catch { throw new ConfigError('key_unreadable'); }
  if (!WORKER_KEY_PATTERN.test(text)) throw new ConfigError('key_invalid');
  return text;
}

/* Безопасный для печати вид: без ключа, без значений секретов — только пути и факт наличия. */
function redacted(config) {
  return {
    schema: config.schema, endpoint: config.endpoint, secure: config.secure, companies: config.companies,
    routing: config.routing, stateDir: config.stateDir, workdir: config.workdir,
    keyFile: config.keyFile, keyValue: 'REDACTED',
    jobTimeoutMs: config.jobTimeoutMs, heartbeatIntervalMs: config.heartbeatIntervalMs,
    renewIntervalMs: config.renewIntervalMs, maxOutputBytes: config.maxOutputBytes,
    agents: config.agents.map((agent) => ({ name: agent.name, provider: agent.provider, model: agent.model,
      command: agent.command, args: agent.args, input: agent.input, output: agent.output,
      envPassthrough: agent.envPassthrough, secretEnv: Object.keys(agent.secretEnvFrom), secretValues: 'REDACTED',
      requiresCredentials: agent.requiresCredentials })),
  };
}

module.exports = { CONFIG_SCHEMA, CONFIG_KEYS, AGENT_KEYS, ConfigError, loadConfig, readWorkerKey, redacted };

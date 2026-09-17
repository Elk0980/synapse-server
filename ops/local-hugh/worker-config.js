'use strict';

/* Конфигурация локального worker: JSON вне Git с белым списком ключей.
   Ключ Bearer лежит в отдельном файле (keyFile) и возвращается отдельно от настроек,
   чтобы он не попал ни в статус, ни в журнал, ни в окружение дочернего Codex. */

const fs = require('node:fs');
const path = require('node:path');
const {validateEndpoint, EndpointError} = require('./transport');

const CONFIG_SCHEMA = 1;
const DEFAULT_COMPANIES = Object.freeze(['palitra-love']);
const COMPANY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MODEL_PATTERN = /^[A-Za-z0-9.-]{1,64}$/;
const WORKER_KEY_PATTERN = /^[A-Za-z0-9._~-]{32,256}$/;

const CONFIG_KEYS = Object.freeze([
  'schema',
  'endpoint',
  'keyFile',
  'companies',
  'codexBinary',
  'codexHome',
  'workspace',
  'catalogPath',
  'proofPath',
  'statePath',
  'outboxPath',
  'statusPath',
  'logPath',
  'lockPath',
  'model',
  'jobTimeoutMs',
  'heartbeatIntervalMs',
  'renewIntervalMs',
  'allowInsecureLoopback',
]);

const PATH_DEFAULTS = Object.freeze({
  codexBinary: 'vendor/x86_64-pc-windows-msvc/bin/codex.exe',
  codexHome: 'codex-home',
  workspace: 'workspace',
  catalogPath: 'build/restricted-models.json',
  proofPath: 'build/tool-isolation-proof.json',
  statePath: 'state/hugh-runtime.sqlite',
  outboxPath: 'state/worker-outbox.sqlite',
  statusPath: 'state/status.json',
  logPath: 'logs/worker.log',
  lockPath: 'state/worker.lock',
});

const INT_BOUNDS = Object.freeze({
  jobTimeoutMs: {min: 10_000, max: 600_000, fallback: 120_000},
  heartbeatIntervalMs: {min: 5_000, max: 60_000, fallback: 20_000},
  renewIntervalMs: {min: 5_000, max: 60_000, fallback: 20_000},
});

class ConfigError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ConfigError';
    this.code = code;
  }
}

function resolvePath(baseDir, value, key) {
  if (typeof value !== 'string' || !value.trim()) throw new ConfigError(`${key}_invalid`);
  return path.resolve(baseDir, value);
}

function boundedInt(value, key) {
  const bounds = INT_BOUNDS[key];
  if (value === undefined) return bounds.fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < bounds.min || number > bounds.max) throw new ConfigError(`${key}_invalid`);
  return number;
}

function readWorkerKey(keyFile) {
  let raw;
  try {
    raw = fs.readFileSync(keyFile, 'utf8');
  } catch (error) {
    throw new ConfigError(error && error.code === 'ENOENT' ? 'key_file_missing' : 'key_file_unreadable');
  }
  const key = raw.trim();
  if (!WORKER_KEY_PATTERN.test(key)) throw new ConfigError('key_invalid');
  return key;
}

/* Разбирает уже прочитанный объект конфигурации. Пути считаются от baseDir. */
function parseConfig(raw, baseDir) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('config_not_object');
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.includes(key)) throw new ConfigError('config_unknown_key');
  }
  if (raw.schema !== CONFIG_SCHEMA) throw new ConfigError('config_schema');
  const allowInsecureLoopback = raw.allowInsecureLoopback === true;
  if (raw.allowInsecureLoopback !== undefined && typeof raw.allowInsecureLoopback !== 'boolean') {
    throw new ConfigError('allowInsecureLoopback_invalid');
  }
  try {
    validateEndpoint(raw.endpoint, {allowInsecureLoopback});
  } catch (error) {
    throw new ConfigError(error instanceof EndpointError ? error.reason : 'endpoint_invalid');
  }

  let companies = DEFAULT_COMPANIES;
  if (raw.companies !== undefined) {
    if (!Array.isArray(raw.companies) || raw.companies.length === 0) throw new ConfigError('companies_invalid');
    for (const company of raw.companies) {
      if (typeof company !== 'string' || !COMPANY_PATTERN.test(company)) throw new ConfigError('companies_invalid');
    }
    companies = Object.freeze([...new Set(raw.companies)]);
  }

  let model = null;
  if (raw.model !== undefined && raw.model !== null) {
    if (typeof raw.model !== 'string' || !MODEL_PATTERN.test(raw.model)) throw new ConfigError('model_invalid');
    model = raw.model;
  }

  const settings = {
    endpoint: raw.endpoint,
    allowInsecureLoopback,
    companies,
    model,
    keyFile: resolvePath(baseDir, raw.keyFile, 'keyFile'),
    jobTimeoutMs: boundedInt(raw.jobTimeoutMs, 'jobTimeoutMs'),
    heartbeatIntervalMs: boundedInt(raw.heartbeatIntervalMs, 'heartbeatIntervalMs'),
    renewIntervalMs: boundedInt(raw.renewIntervalMs, 'renewIntervalMs'),
  };
  for (const [key, fallback] of Object.entries(PATH_DEFAULTS)) {
    settings[key] = resolvePath(baseDir, raw[key] === undefined ? fallback : raw[key], key);
  }
  return Object.freeze(settings);
}

/* Возвращает {settings, token}. settings не содержит ключа; token — только для транспорта. */
function loadConfig(configPath) {
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new ConfigError(error && error.code === 'ENOENT' ? 'config_missing' : 'config_unreadable');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError('config_unparsable');
  }
  const settings = parseConfig(raw, path.dirname(path.resolve(configPath)));
  const token = readWorkerKey(settings.keyFile);
  return {settings, token};
}

module.exports = {
  CONFIG_SCHEMA,
  CONFIG_KEYS,
  DEFAULT_COMPANIES,
  PATH_DEFAULTS,
  WORKER_KEY_PATTERN,
  ConfigError,
  parseConfig,
  loadConfig,
  readWorkerKey,
};

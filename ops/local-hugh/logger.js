'use strict';

/* Журнал worker в файл с простой ротацией. Сюда попадают только строки, которые
   составили runtime.js и worker.js: короткие коды, числа, время. Сырых ошибок нет. */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function createLogger(options = {}) {
  const filePath = options.path || null;
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const mirror = options.mirror || null; // например console — для запуска вручную
  let size = 0;

  if (filePath) {
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    try {
      size = fs.statSync(filePath).size;
    } catch {
      size = 0;
    }
  }

  function rotate() {
    try {
      fs.renameSync(filePath, `${filePath}.1`);
    } catch {
      /* прежний файл мог исчезнуть; пишем дальше в новый */
    }
    size = 0;
  }

  function write(level, message) {
    const line = `${new Date().toISOString()} ${level} ${String(message)}\n`;
    if (mirror && typeof mirror[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'] === 'function') {
      mirror[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](line.trimEnd());
    }
    if (!filePath) return;
    try {
      if (size + line.length > maxBytes) rotate();
      fs.appendFileSync(filePath, line, {mode: 0o600});
      size += line.length;
    } catch {
      /* журнал не должен ронять worker */
    }
  }

  return {
    log: (message) => write('info', message),
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  };
}

module.exports = {createLogger, DEFAULT_MAX_BYTES};

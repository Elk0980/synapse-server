'use strict';

/* Поддельный app-server для тестов: запускается настоящим spawn, говорит тем же
   построчным JSON без поля jsonrpc. Сценарий задаётся файлом HUGH_FAKE_SCENARIO,
   всё полученное дописывается в HUGH_FAKE_RECORD (по объекту на строку). */

const fs = require('node:fs');

const scenario = JSON.parse(fs.readFileSync(process.env.HUGH_FAKE_SCENARIO, 'utf8'));
const recordPath = process.env.HUGH_FAKE_RECORD || null;
const chunkBytes = Number(scenario.chunkBytes || 0);
let lastThreadId = scenario.threadId || 'thread-1';

function writeRaw(text) {
  if (!chunkBytes) {
    process.stdout.write(text);
    return;
  }
  for (let index = 0; index < text.length; index += chunkBytes) {
    process.stdout.write(text.slice(index, index + chunkBytes));
  }
}

function send(object) {
  writeRaw(`${JSON.stringify(object)}\n`);
}

function substitute(value, threadId) {
  return JSON.parse(JSON.stringify(value).split('__THREAD_ID__').join(threadId));
}

function record(message) {
  if (!recordPath) return;
  fs.appendFileSync(recordPath, `${JSON.stringify(message)}\n`);
}

if (scenario.stderrBytes) process.stderr.write('e'.repeat(Number(scenario.stderrBytes)));
for (const line of scenario.preludeLines || []) writeRaw(`${line}\n`);

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
    index = buffer.indexOf('\n');
  }
});

function handle(message) {
  record(message);
  if (!message.method || !Object.hasOwn(message, 'id')) return; // уведомления и ответы клиента
  const step = (scenario.methods || {})[message.method];
  const threadId = (message.params && message.params.threadId) || lastThreadId;
  if (!step) {
    send({id: message.id, error: {code: -32601, message: `unsupported ${message.method}`}});
    return;
  }
  const emit = () => {
    // noResponse моделирует зависший app-server: запрос принят, ответа не будет никогда.
    if (step.noResponse) {
      if (scenario.exitAfter === message.method) setTimeout(() => process.exit(7), Number(step.exitDelayMs || 5));
      return;
    }
    if (step.error) send({id: message.id, error: step.error});
    else {
      const result = substitute(step.result ?? {}, threadId);
      if (message.method === 'thread/start' && result.thread && result.thread.id) lastThreadId = result.thread.id;
      send({id: message.id, result});
    }
    // Порядок задаётся явно: тесты проверяют и «запрос инструмента до ответа», и «после».
    const notifications = step.after || [];
    const requests = step.serverRequests || [];
    const sequence = step.emitOrder === 'notificationsFirst' ? [...notifications, ...requests] : [...requests, ...notifications];
    const delay = Number(step.afterDelayMs || 1);
    if (sequence.length > 0) {
      // Одной записью: клиент обязан разобрать все строки за один проход, порядок сохраняется.
      const batch = sequence
        .map((event) => `${JSON.stringify(substitute(event, message.method === 'thread/start' ? lastThreadId : threadId))}\n`)
        .join('');
      setTimeout(() => writeRaw(batch), delay);
    }
    if (scenario.exitAfter === message.method) setTimeout(() => process.exit(7), Number(step.exitDelayMs || 5));
  };
  if (step.delayMs) setTimeout(emit, Number(step.delayMs));
  else emit();
}

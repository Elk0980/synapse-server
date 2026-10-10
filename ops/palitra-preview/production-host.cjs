'use strict';
/*
 * Palitra — тестовый просмотр для отдельного сервиса за HTTPS reverse proxy (Caddy/nginx на том же сервере).
 * Тот же обработчик, статический список и вымышленные примеры, что у функции Vercel и local-preview.cjs.
 * НЕ рабочая CRM: вымышленные данные в памяти процесса, все транспорты выключены, токенов и баз нет.
 *
 * Обязательное окружение:
 *   PALITRA_PREVIEW_PORT  порт слушателя на 127.0.0.1 (1024–65535, не 8789 — это просмотр Влада)
 *   PREVIEW_ORIGINS       точные HTTPS-адреса страницы через запятую, например https://preview.example.ru
 * Слушает ТОЛЬКО 127.0.0.1; снаружи доступен лишь через прокси. Host и X-Forwarded-* не используются для доступа:
 * изменения принимаются только при точном заголовке Origin из PREVIEW_ORIGINS.
 */
const http = require('node:http');

function fail(message) { process.stderr.write(`palitra-preview: ${message}\n`); process.exit(1); }

const major = Number(process.versions.node.split('.')[0]);
if (!(major >= 24)) fail(`нужен Node.js 24 или новее, сейчас ${process.version}`);
try { require('node:sqlite'); } catch { fail('в этой сборке Node.js нет node:sqlite — запуск невозможен'); }

const port = Number(process.env.PALITRA_PREVIEW_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('укажите PALITRA_PREVIEW_PORT — число 1024–65535');
if (port === 8789) fail('порт 8789 занят просмотром Влада — выберите другой');

const origins = new Set();
for (const raw of String(process.env.PREVIEW_ORIGINS || '').split(',').map((v) => v.trim()).filter(Boolean)) {
  let url;
  try { url = new URL(raw); } catch { fail(`PREVIEW_ORIGINS: некорректный адрес ${JSON.stringify(raw)}`); }
  if (url.protocol !== 'https:' || url.origin !== raw) fail(`PREVIEW_ORIGINS: нужен точный https-адрес без пути и косой черты в конце, получено ${JSON.stringify(raw)}`);
  origins.add(raw);
}
if (!origins.size) fail('укажите PREVIEW_ORIGINS — точные https-адреса страницы просмотра');

const { createPreviewHandler } = require('./api/_app/handler');
const handler = createPreviewHandler({ origins });
const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1']);
const server = http.createServer((req, res) => {
  // Подключения только от прокси на этом же сервере (слушатель и так привязан к 127.0.0.1).
  if (!LOOPBACK.has(req.socket.remoteAddress)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }); res.end('Только через прокси'); return; }
  handler(req, res);
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.once('error', (error) => fail(error.code === 'EADDRINUSE' ? `127.0.0.1:${port} уже занят` : `не удалось запустить: ${error.code || error.message}`));
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`palitra-preview: слушаю 127.0.0.1:${port} (PID ${process.pid}); страница: ${[...origins].join(', ')}; данные вымышленные, отправки выключены\n`);
});
const stop = () => { server.close(() => process.exit(0)); server.closeAllConnections(); setTimeout(() => process.exit(0), 5000).unref(); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

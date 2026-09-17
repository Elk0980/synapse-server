'use strict';

/* Локальный предпросмотр сайта Palitra для визуальной проверки.
   Запуск вручную: node ops/dev/palitra-site-preview.cjs  → http://127.0.0.1:8788/
   Остановка: Ctrl+C. Это не служба и не установщик: никакого автозапуска, ничего не пишет.

   Что делает:
   - отдаёт статику из sites/palitra-love (индекс каталога — index.html, корректный MIME);
   - только GET и HEAD, остальное — 405;
   - ровно три публичных маршрута проксирует на https://palitra-love.synapsebusiness.ru:
     /api/price, /content/palitra/price, /api/assets/<id> — с таймаутом 15 с, без cookie и
     авторизации, без следования редиректам, с сохранением статуса upstream;
   - выход за корень сайта через «..» или символические ссылки запрещён (404).
   POST /api/orders намеренно не проксируется: предпросмотр не создаёт реальных заявок (405). */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const HOST = '127.0.0.1';
const PORT = 8788;
// ops/dev → корень репозитория → sites/palitra-love
const ROOT = fs.realpathSync(path.resolve(__dirname, '..', '..', 'sites', 'palitra-love'));
const UPSTREAM = 'https://palitra-love.synapsebusiness.ru';
const UPSTREAM_TIMEOUT_MS = 15_000;
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_UPSTREAM_BYTES = 32 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'cache-control': 'no-store', ...headers });
  response.end(body);
}

function text(response, status, message, method) {
  send(response, status, method === 'HEAD' ? undefined : `${message}\n`, { 'content-type': 'text/plain; charset=utf-8' });
}

/* Путь URL → файл внутри ROOT. Любой выход за корень (в том числе через символическую ссылку) — null. */
function resolveStatic(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const relative = decoded.replace(/^\/+/, '');
  const candidate = path.resolve(ROOT, relative);
  if (candidate !== ROOT && !candidate.startsWith(ROOT + path.sep)) return null;
  let stat;
  try { stat = fs.statSync(candidate); } catch { return null; }
  let file = candidate;
  if (stat.isDirectory()) {
    if (!decoded.endsWith('/')) return { redirect: `${pathname}/` };
    file = path.join(candidate, 'index.html');
    try { stat = fs.statSync(file); } catch { return null; }
    if (!stat.isFile()) return null;
  } else if (!stat.isFile()) {
    return null;
  }
  // Реальный путь после разыменования ссылок тоже обязан лежать внутри корня.
  let real;
  try { real = fs.realpathSync(file); } catch { return null; }
  if (real !== ROOT && !real.startsWith(ROOT + path.sep)) return null;
  return { file: real, size: stat.size };
}

function serveStatic(request, response, pathname) {
  const target = resolveStatic(pathname);
  if (!target) return text(response, 404, 'Не найдено', request.method);
  if (target.redirect) return send(response, 301, undefined, { location: target.redirect });
  const type = MIME[path.extname(target.file).toLowerCase()] || 'application/octet-stream';
  response.writeHead(200, { 'content-type': type, 'content-length': target.size, 'cache-control': 'no-store' });
  if (request.method === 'HEAD') return response.end();
  const stream = fs.createReadStream(target.file);
  stream.on('error', () => { if (!response.headersSent) text(response, 500, 'Ошибка чтения файла', request.method); else response.destroy(); });
  stream.pipe(response);
}

/* Фиксированные публичные маршруты прода. Возвращает путь upstream либо null. */
function proxyTarget(pathname) {
  if (pathname === '/api/price' || pathname === '/content/palitra/price') return pathname;
  const asset = /^\/api\/assets\/([^/]+)$/.exec(pathname);
  if (asset && ASSET_ID.test(asset[1])) return `/api/assets/${asset[1]}`;
  return null;
}

function proxy(request, response, upstreamPath) {
  const options = {
    method: request.method,
    headers: {
      // Ни cookie, ни авторизации, ни заголовков браузера наружу: только то, что нужно для ответа.
      accept: request.headers.accept || '*/*',
      'user-agent': 'palitra-site-preview/1.0 (local)',
    },
    timeout: UPSTREAM_TIMEOUT_MS,
  };
  const upstream = https.request(`${UPSTREAM}${upstreamPath}`, options, (res) => {
    const status = res.statusCode || 502;
    if (status >= 300 && status < 400) {
      // Редиректы не выполняются: показываем как есть, без перехода на другой адрес.
      res.resume();
      return text(response, 502, `Upstream ответил редиректом ${status}; предпросмотр по редиректам не ходит`, request.method);
    }
    const headers = { 'cache-control': 'no-store' };
    for (const name of ['content-type', 'content-length', 'etag', 'last-modified']) {
      if (res.headers[name]) headers[name] = res.headers[name];
    }
    response.writeHead(status, headers);
    if (request.method === 'HEAD') { res.resume(); return response.end(); }
    let received = 0;
    res.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_UPSTREAM_BYTES) { res.destroy(); response.destroy(); }
    });
    res.on('error', () => response.destroy());
    res.pipe(response);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  upstream.on('error', (error) => {
    const reason = error && error.message === 'timeout' ? `upstream не ответил за ${UPSTREAM_TIMEOUT_MS / 1000} с` : `ошибка соединения с upstream (${(error && error.code) || 'error'})`;
    if (!response.headersSent) text(response, 502, reason, request.method); else response.destroy();
  });
  upstream.end();
}

const server = http.createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return text(response, 405, 'Предпросмотр принимает только GET и HEAD; заявки здесь не отправляются', request.method);
  }
  let url;
  try { url = new URL(request.url || '/', `http://${HOST}:${PORT}`); } catch { return text(response, 400, 'Некорректный адрес', request.method); }
  const upstreamPath = proxyTarget(url.pathname);
  if (upstreamPath) return proxy(request, response, upstreamPath);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/content/')) {
    return text(response, 404, 'Этот маршрут в предпросмотре не проксируется', request.method);
  }
  return serveStatic(request, response, url.pathname);
});

server.on('error', (error) => {
  console.error(`palitra-site-preview: не удалось запустить сервер (${error.code || error.message})`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`palitra-site-preview: http://${HOST}:${PORT}/  (корень: ${ROOT})`);
  console.log(`  proxy → ${UPSTREAM}: /api/price, /content/palitra/price, /api/assets/<id>; таймаут ${UPSTREAM_TIMEOUT_MS / 1000} с, без редиректов и cookie`);
  console.log('  только GET/HEAD; POST /api/orders → 405 (реальные заявки не создаются). Ctrl+C — остановка.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

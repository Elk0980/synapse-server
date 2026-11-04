"""Local-only browser fixture. Never forwards API calls or loads real metrics.
Not part of the four production files. Bind is fixed to 127.0.0.1.
"""
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
import argparse
import json

ROOT = Path(__file__).resolve().parent
PAGES = ('turbo-massazh-irkutsk.html', 'apparatnyy-massazh-irkutsk.html')
CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
       "connect-src 'self'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'")
GUARD = r"""'use strict';
window.__metrikaReady = true;
window.ym = function () {}; window.ym.a = []; window.ym.l = Date.now();
document.addEventListener('submit', function (event) {
  event.preventDefault(); event.stopImmediatePropagation();
  const status = event.target.querySelector('[data-callback-status]');
  if (status) status.textContent = 'Локальная проверка: отправка отключена. Заявка не создавалась.';
}, true);
document.addEventListener('click', function (event) {
  const anchor = event.target.closest && event.target.closest('a[href]');
  if (!anchor) return;
  const url = new URL(anchor.href, location.href);
  if (url.origin !== location.origin) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
"""

def route_response(method, raw_path, price_case='ready'):
    if method not in ('GET', 'HEAD'):
        return 405, 'text/plain; charset=utf-8', b'LOCAL_FIXTURE_WRITE_DISABLED'
    path = urlsplit(raw_path).path
    if path == '/api/price':
        if price_case == 'unavailable':
            return 503, 'application/json', b'{"error":"LOCAL_FIXTURE_UNAVAILABLE"}'
        raw = (ROOT / 'fixtures/public/price-live.json').read_bytes()
        if price_case == 'unexpected':
            data = json.loads(raw)
            for category in data['categories']:
                if category['id'] == 'first-visit':
                    for item in category['items']:
                        if item['id'] == 'first-1':
                            item['price'] = '650 ₽'
            raw = json.dumps(data, ensure_ascii=False).encode('utf-8')
        return 200, 'application/json; charset=utf-8', raw
    if path == '/__fixture__/guard.js':
        return 200, 'application/javascript; charset=utf-8', GUARD.encode('utf-8')
    if path == '/':
        page = '<!doctype html><html lang="ru"><meta charset="utf-8"><title>Локальная проверка Авокадо</title><h1>Локальная проверка: без заявок и метрики</h1>'
        page += ''.join(f'<p><a href="/{name}">{name}</a></p>' for name in PAGES)
        return 200, 'text/html; charset=utf-8', page.encode('utf-8')
    routes = {f'/{name}': (ROOT / name, 'text/html; charset=utf-8') for name in PAGES}
    for name in ('avokado-yandex-landing.css', 'avokado-yandex-landing.js'):
        routes['/' + name] = (ROOT / name, 'text/css' if name.endswith('.css') else 'application/javascript')
    for name in ('callback.js', 'attribution.js'):
        routes['/' + name] = (ROOT / 'fixtures/public' / name, 'application/javascript')
    if path not in routes:
        return 404, 'text/plain; charset=utf-8', b'LOCAL_FIXTURE_NOT_FOUND'
    target, mime = routes[path]
    raw = target.read_bytes()
    if path[1:] in PAGES:
        raw = raw.replace(b'<head>', b'<head>\n<script src="/__fixture__/guard.js"></script>', 1)
    return 200, mime, raw

class FixtureHandler(BaseHTTPRequestHandler):
    def respond(self):
        status, mime, raw = route_response(self.command, self.path, self.server.price_case)
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Content-Security-Policy', CSP)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(raw)
    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = respond
    def log_message(self, fmt, *args):
        # Do not record query strings, form bodies, names, or phone numbers.
        print(f'LOCAL_FIXTURE {self.command} {urlsplit(self.path).path}')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=61334)
    parser.add_argument('--price-case', choices=('ready', 'unavailable', 'unexpected'), default='ready')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('port must be in 1024..65535')
    with ThreadingHTTPServer(('127.0.0.1', args.port), FixtureHandler) as server:
        server.price_case = args.price_case
        print(f'LOCAL_ONLY http://127.0.0.1:{args.port}/ price={args.price_case}; POST and external metrics disabled')
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass

if __name__ == '__main__':
    main()

#!/usr/bin/env node
'use strict';
/* Скриншоты страниц с <select> (и главных страниц остальных сайтов) для ревью site kit.
   Без сети: локальный статический сервер раздаёт sites/<сайт> корнем, как Caddy
   (try_files {path} {path}/index.html /index.html). Запросы /api/* получают 404.
   node tools/site-kit/screenshots.js --out <каталог> [--root <checkout>] [--sites a,b] [--all-sites]
   Пишет PNG и report.json: для каждого select — computed appearance и наличие kit-кнопки. */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

function args(argv) {
  const out = { root: path.resolve(__dirname, '..', '..'), out: null, sites: null, allSites: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = path.resolve(argv[++i]);
    else if (argv[i] === '--root') out.root = path.resolve(argv[++i]);
    else if (argv[i] === '--sites') out.sites = argv[++i].split(',').filter(Boolean);
    else if (argv[i] === '--all-sites') out.allSites = true;
  }
  if (!out.out) throw new Error('--out обязателен');
  return out;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain', '.xml': 'application/xml' };

function serve(dir) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) { res.writeHead(404); return res.end(); }
    const clean = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const tries = [path.join(dir, clean), path.join(dir, clean, 'index.html'), path.join(dir, 'index.html')];
    const file = tries.find((f) => f.startsWith(dir) && fs.existsSync(f) && fs.statSync(f).isFile());
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function pagesWithSelect(siteDir) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'kit') continue;
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.html') && /<select[\s>]/i.test(fs.readFileSync(full, 'utf8'))) out.push(full);
    }
  };
  walk(siteDir);
  return out.map((f) => '/' + path.relative(siteDir, f).replace(/\\/g, '/').replace(/(^|\/)index\.html$/, '$1'));
}

async function main() {
  const opt = args(process.argv.slice(2));
  const { chromium } = require('playwright');
  const sitesDir = path.join(opt.root, 'sites');
  const configFile = path.join(sitesDir, '_kit', 'sites.json');
  // «До»: в checkout без kit конфигурации нет — сайты задаются --sites.
  const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : { sites: {} };
  const wanted = opt.sites || Object.keys(config.sites);
  const jobs = wanted.map((site) => ({ site, pages: pagesWithSelect(path.join(sitesDir, site)), open: true }));
  if (opt.allSites) {
    for (const e of fs.readdirSync(sitesDir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('_') || wanted.includes(e.name)) continue;
      if (fs.existsSync(path.join(sitesDir, e.name, 'index.html'))) jobs.push({ site: e.name, pages: ['/'], open: false });
    }
  }
  fs.mkdirSync(opt.out, { recursive: true });
  const browser = await chromium.launch();
  const report = [];
  const viewports = [
    { name: '1280', viewport: { width: 1280, height: 900 } },
    { name: '390', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  ];
  for (const job of jobs) {
    const server = await serve(path.join(sitesDir, job.site));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const vp of viewports) {
      const context = await browser.newContext({ ...vp, reducedMotion: 'reduce', serviceWorkers: 'block' });
      for (const page of job.pages) {
        const tab = await context.newPage();
        const errors = [];
        tab.on('pageerror', (e) => errors.push(String(e.message || e)));
        await tab.goto(base + page, { waitUntil: 'load', timeout: 30000 }).catch((e) => errors.push('goto: ' + e.message));
        await tab.waitForTimeout(400);
        await tab.evaluate(() => { for (const id of ['page-loader']) document.getElementById(id)?.remove(); document.querySelector('.cookie')?.classList.add('hidden'); });
        const slug = (job.site + page).replace(/[^a-z0-9]+/gi, '_').replace(/_$/, '');
        const info = await tab.evaluate(() => [...document.querySelectorAll('select')].map((s) => ({
          name: s.name, appearance: getComputedStyle(s).appearance, kit: s.dataset.kitSelect || null,
          visible: !!(s.offsetWidth || s.offsetHeight || s.closest('.kit-select')),
          arrow: getComputedStyle(s.closest('.kit-select')?.querySelector('.kit-select__button') || s).backgroundImage.includes('gradient'),
        })));
        // Список может быть только в скрытой панели (корзина каталога) — раскрываем её.
        if (!(await tab.locator('select:visible').count())) {
          const reveal = tab.locator('[data-kit-reveal]:visible, [data-cart-open]:visible').first();
          if (await reveal.count()) { await reveal.click().catch(() => {}); await tab.waitForTimeout(300); }
        }
        const target = tab.locator('form:has(select):visible, select:visible').first();
        const file = path.join(opt.out, `${slug}__${vp.name}.png`);
        if (await target.count()) {
          await target.scrollIntoViewIfNeeded().catch(() => {});
          await target.screenshot({ path: file }).catch((e) => errors.push('shot: ' + e.message));
          if (job.open && vp.name === '1280') {
            const button = target.locator('.kit-select__button:visible').first();
            if (await button.count()) {
              await button.click();
              await tab.waitForTimeout(150);
              const list = tab.locator('.kit-select__list:not([hidden])').first();
              await list.scrollIntoViewIfNeeded().catch(() => {});
              const a = await target.locator('.kit-select').first().boundingBox();
              const b = await list.boundingBox();
              if (a && b) {
                const x = Math.max(0, Math.min(a.x, b.x) - 24), y = Math.max(0, Math.min(a.y, b.y) - 48);
                const bottom = Math.min(vp.viewport.height, Math.max(a.y + a.height, b.y + b.height) + 24);
                await tab.screenshot({ path: path.join(opt.out, `${slug}__${vp.name}__open.png`),
                  clip: { x, y, width: Math.min(vp.viewport.width - x, a.width + 48), height: bottom - y } }).catch((e) => errors.push('open: ' + e.message));
              }
              await tab.keyboard.press('Escape');
            }
          }
        } else {
          await tab.screenshot({ path: file });
        }
        report.push({ site: job.site, page, viewport: vp.name, file, selects: info, errors });
        await tab.close();
      }
      await context.close();
    }
    server.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(opt.out, 'report.json'), JSON.stringify(report, null, 2));
  const bad = report.filter((r) => r.selects.some((s) => s.appearance !== 'none'));
  console.log(`снимков: ${report.length}; страниц со системным select: ${bad.length}`);
}

module.exports = { serve };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

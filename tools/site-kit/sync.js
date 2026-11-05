#!/usr/bin/env node
'use strict';
/* Общий набор деталей сайтов (site kit). Источник один — sites/_kit.
   Каждый сайт раздаётся Caddy изолированно (root * /srv/sites/<сайт>), поэтому файлы kit
   копируются внутрь сайта: sites/<сайт>/<dest>/. Скрипт:
     1) копирует files из sites/_kit/sites.json побайтно;
     2) генерирует <dest>/theme.css из темы сайта (переменные --kit-*);
     3) на каждой странице сайта с <select> гарантирует подключение kit и обновляет ?v=хеш.
   node tools/site-kit/sync.js          — применить
   node tools/site-kit/sync.js --check  — только проверить (код 1 при расхождении)        */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const SITES = path.join(ROOT, 'sites');
const KIT = path.join(SITES, '_kit');
const CSS_ORDER = ['theme.css', 'fields.css', 'select.css'];
const SCRIPT = 'select.js';

const hash = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 10);
const readConfig = () => JSON.parse(fs.readFileSync(path.join(KIT, 'sites.json'), 'utf8'));

function themeCss(site, theme) {
  const vars = Object.entries(theme).map(([k, v]) => {
    if (!/^--kit-[a-z0-9-]+$/.test(k) || /[;{}<]/.test(String(v))) throw new Error(`${site}: недопустимая переменная темы ${k}`);
    return `  ${k}: ${v};`;
  });
  return `/* Сгенерировано tools/site-kit/sync.js из sites/_kit/sites.json (сайт ${site}). Не править вручную. */\n:root {\n${vars.join('\n')}\n}\n`;
}

function htmlPages(dir, skip) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || full === skip) continue;
    if (entry.isDirectory()) out.push(...htmlPages(full, skip));
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

const hasSelect = (html) => /<select[\s>]/i.test(html);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* Возвращает новую разметку страницы с подключённым kit (или ту же, если уже актуальна). */
function connectPage(html, url, versions) {
  let out = html;
  const tag = (file) => file.endsWith('.js')
    ? `<script src="${url}${file}?v=${versions[file]}" defer></script>`
    : `<link rel="stylesheet" href="${url}${file}?v=${versions[file]}">`;
  const missing = [];
  for (const file of [...CSS_ORDER, SCRIPT]) {
    const re = new RegExp(`(${escapeRe(url + file)})\\?v=[A-Za-z0-9_-]*`, 'g');
    if (re.test(out)) out = out.replace(re, `$1?v=${versions[file]}`);
    else missing.push(file);
  }
  if (!missing.length) return out;
  const head = out.search(/<\/head>/i);
  if (head < 0) throw new Error('нет </head>');
  const block = missing.map(tag).join('');
  // Сразу после последней таблицы стилей сайта: kit загружается позже и перекрывает
  // системный вид select, но собственные правила сайта с :where() не перебивает.
  const links = [...out.slice(0, head).matchAll(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi)];
  const at = links.length ? links[links.length - 1].index + links[links.length - 1][0].length : head;
  return out.slice(0, at) + block + out.slice(at);
}

/* План: какие файлы должны существовать с каким содержимым. Ничего не пишет. */
function plan(config = readConfig()) {
  const writes = new Map();
  for (const [site, opts] of Object.entries(config.sites)) {
    const siteDir = path.join(SITES, site);
    if (!fs.existsSync(path.join(siteDir, 'index.html'))) throw new Error(`нет сайта sites/${site}`);
    const destDir = path.join(siteDir, opts.dest);
    const versions = {};
    for (const file of config.files) {
      const text = fs.readFileSync(path.join(KIT, file), 'utf8');
      writes.set(path.join(destDir, file), text);
      versions[file] = hash(text);
    }
    const theme = themeCss(site, opts.theme || {});
    writes.set(path.join(destDir, 'theme.css'), theme);
    versions['theme.css'] = hash(theme);
    for (const page of htmlPages(siteDir, destDir)) {
      const html = fs.readFileSync(page, 'utf8');
      if (!hasSelect(html) && !html.includes(opts.url)) continue;
      writes.set(page, connectPage(html, opts.url, versions));
    }
  }
  return writes;
}

function diff(writes) {
  const stale = [];
  for (const [file, text] of writes) {
    const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (now !== text) stale.push(path.relative(ROOT, file));
  }
  return stale;
}

function main(argv) {
  const writes = plan();
  const stale = diff(writes);
  if (argv.includes('--check')) {
    if (stale.length) {
      console.error('site kit не синхронизирован. Запустите node tools/site-kit/sync.js:\n  ' + stale.join('\n  '));
      return 1;
    }
    console.log(`site kit синхронизирован: ${writes.size} файлов`);
    return 0;
  }
  for (const [file, text] of writes) {
    if (!stale.includes(path.relative(ROOT, file))) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  console.log(stale.length ? 'обновлено:\n  ' + stale.join('\n  ') : 'изменений нет');
  return 0;
}

module.exports = { plan, diff, connectPage, themeCss, hash, readConfig, htmlPages, hasSelect, SITES, KIT, CSS_ORDER, SCRIPT };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

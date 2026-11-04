'use strict';
/* Счётчик Метрики в локальных исходниках опубликованного сайта компании (CONTENT_CONNECTIONS_SITES_DIR), без сети.
   Нет каталога или сайта — источник молчит. Найденный счётчик — «стоит в коде», а не «данные приходят в ЛК». */
const fs = require('node:fs'), path = require('node:path');

/* Компания → папка опубликованного сайта; сверяется тестом с LEGACY_SITES в ops/content/site-store.js. */
const PUBLISHED_SITE_DIRS = Object.freeze({ alvi: 'alvi', avokado: 'avokado3', 'palitra-love': 'palitra-love' });
const MAX_FILES = 200, MAX_BYTES = 1_500_000, TTL_MS = 10 * 60_000;
const PATTERNS = [/mc\.yandex\.(?:ru|com)\/metrika\/tag\.js\?id=(\d{5,12})/, /mc\.yandex\.(?:ru|com)\/watch\/(\d{5,12})/,
  /\bym\(\s*(\d{5,12})\s*,\s*['"]init['"]/, /yaCounter(\d{5,12})\b/];
const NAMED = /\b(?:counterId|counter_id|COUNTER_ID|metrikaId|metrikaCounter|ymCounter|YM_COUNTER)\s*[:=]\s*['"]?(\d{5,12})\b/;

function counterIn(text) {
  for (const re of PATTERNS) { const m = text.match(re); if (m) return m[1]; }
  // Номер в переменной засчитывается, только если в том же файле есть загрузчик Метрики.
  if (/mc\.yandex\.(?:ru|com)\/metrika/.test(text)) { const m = text.match(NAMED); if (m) return m[1]; }
  return null;
}

function createMetrikaSiteSource({ sitesDir = '', dirs = PUBLISHED_SITE_DIRS, now = () => Date.now() } = {}) {
  const cache = new Map();
  let root = null;
  try { root = sitesDir ? fs.realpathSync(sitesDir) : null; } catch { root = null; }
  function find(companyCode) {
    const folder = root && dirs[String(companyCode || '').toLowerCase()];
    if (!folder) return null;
    const hit = cache.get(folder);
    if (hit && now() - hit.at < TTL_MS) return hit.value;
    let value = null;
    try {
      const dir = fs.realpathSync(path.join(root, folder));
      if (dir.startsWith(root + path.sep)) {
        // Только верхний уровень сайта: HTML и JS-файлы, без перехода по ссылкам за пределы каталога.
        const files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && /\.(?:html?|js)$/i.test(e.name))
          .map((e) => e.name).sort((a, b) => Number(/metrika|attribution|analytics|counter/i.test(b)) - Number(/metrika|attribution|analytics|counter/i.test(a)))
          .slice(0, MAX_FILES);
        value = { site: folder, counterId: null, file: null };
        for (const name of files) {
          if (fs.statSync(path.join(dir, name)).size > MAX_BYTES) continue;
          const id = counterIn(fs.readFileSync(path.join(dir, name), 'utf8'));
          if (id) { value = { site: folder, counterId: id, file: name }; break; }
        }
      }
    } catch { value = null; }
    cache.set(folder, { at: now(), value });
    return value;
  }
  return { find };
}

module.exports = { createMetrikaSiteSource, counterIn, PUBLISHED_SITE_DIRS };

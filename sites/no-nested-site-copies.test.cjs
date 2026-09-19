'use strict';
// 19.09.2026. Дефект, который этот тест не даёт повторить: в sites/avokado3/ лежали
// вложенные копии других сайтов — sites/avokado3/alvi/ и sites/avokado3/avokado3/.
// Caddy отдаёт /srv/sites/avokado3 корнем домена avokado38.ru, поэтому по адресу
// avokado38.ru/alvi/ открывался устаревший сайт ALVI со старыми кнопками Yclients.
// Копия сайта внутри папки другого сайта публикуется вместе с ним и доступна по его
// домену — это всегда дефект.
//
// Тест намеренно узкий: он ловит ТОЛЬКО подпапку, чьё имя совпадает с именем сайта
// верхнего уровня. Обычные подстраницы (sites/palitra-love/catalog, .../oferta и т. п.)
// дефектом не считаются и не трогаются.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SITES = __dirname;

// sites/drafts — каталог черновиков, его подпапки названы по сайтам намеренно
// (drafts.synapsebusiness.ru, PR #245). Это единственное осознанное исключение.
const ALLOWED_PARENTS = new Set(['drafts']);

function listDirs(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map(e => e.name);
}

const isSiteDir = dir => fs.existsSync(path.join(dir, 'index.html'));

test('sites: папка сайта не содержит копию другого сайта', () => {
  const siteNames = listDirs(SITES).filter(name => isSiteDir(path.join(SITES, name)));
  assert.ok(siteNames.length > 0, 'не найдено ни одной папки сайта — проверь путь');

  const offenders = [];
  for (const site of siteNames) {
    if (ALLOWED_PARENTS.has(site)) continue;
    for (const child of listDirs(path.join(SITES, site))) {
      if (siteNames.includes(child)) offenders.push(`sites/${site}/${child}`);
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    'Копия сайта внутри другого сайта публикуется вместе с ним и открывается по его ' +
      'домену. Удалить или вынести из папки сайта: ' + offenders.join(', ')
  );
});

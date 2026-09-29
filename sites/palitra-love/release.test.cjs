/* Выпуск Palitra на боевом домене palitra-love.ru (29.09.2026).
   Проверяет статически: канонический адрес без www во всех метаданных, robots/sitemap боевого домена,
   маршруты Caddy для боевого и временного адресов, отсутствие просроченной сезонной рекламы и
   неподтверждённых числовых соцдоказательств. Живой DNS/TLS это не заменяет.
   node --test sites/palitra-love/release.test.cjs */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const REPO = path.resolve(ROOT, '..', '..');
const APEX = 'https://palitra-love.ru';
const TEMP_HOST = 'palitra-love.synapsebusiness.ru';
// Windows-копия репозитория хранит CRLF: проверки не зависят от концов строк.
const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
function files(dir = ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'fonts' && entry.name !== 'img' && entry.name !== 'video') files(full, out);
    else if (entry.isFile() && /\.(html|xml|txt|js)$/.test(entry.name) && !/\.test\.cjs$/.test(entry.name)) out.push(full);
  }
  return out;
}
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/');
const publicFiles = files();
const pages = publicFiles.filter((file) => file.endsWith('.html'));

/* Блок сайта из Caddyfile с учётом вложенных фигурных скобок. */
function caddyBlock(source, address) {
  const start = source.search(new RegExp(`^${address.replace(/[.()]/g, '\\$&')} \\{$`, 'm'));
  assert.ok(start >= 0, `в Caddyfile нет блока ${address}`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`блок ${address} не закрыт`);
}

test('SITE_URL и все абсолютные адреса сайта ведут на боевой домен без www', () => {
  assert.match(read(path.join(ROOT, 'config.js')), /SITE_URL:\s*"https:\/\/palitra-love\.ru"/);
  for (const file of publicFiles) {
    const text = read(file);
    assert.ok(!text.includes(TEMP_HOST), `${rel(file)}: остался временный адрес`);
    assert.ok(!/https?:\/\/www\.palitra-love\.ru/.test(text), `${rel(file)}: адрес с www`);
    assert.ok(!/http:\/\/palitra-love\.ru/.test(text), `${rel(file)}: http вместо https`);
  }
});

test('каждая страница: canonical на palitra-love.ru, og:url совпадает, нет meta noindex', () => {
  for (const file of pages) {
    const html = read(file);
    const name = rel(file);
    const canonical = (html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1];
    assert.ok(canonical && canonical.startsWith(`${APEX}/`), `${name}: canonical ${canonical}`);
    const expected = name === 'index.html' ? `${APEX}/` : name === 'price.html' ? `${APEX}/price.html` : `${APEX}/${name.replace(/\/index\.html$/, '')}`;
    assert.equal(canonical, expected, `${name}: canonical соответствует пути страницы`);
    const og = (html.match(/<meta property="og:url" content="([^"]+)"/) || [])[1];
    if (og) assert.equal(og, canonical, `${name}: og:url`);
    assert.ok(!/<meta name="robots"[^>]*noindex/i.test(html), `${name}: meta noindex закрыл бы боевой домен`);
  }
});

test('sitemap.xml и robots.txt боевого домена', () => {
  const sitemap = read(path.join(ROOT, 'sitemap.xml'));
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length >= 20, 'sitemap не пуст');
  assert.equal(new Set(locs).size, locs.length, 'sitemap без повторов');
  for (const loc of locs) {
    assert.ok(loc === `${APEX}/` || loc.startsWith(`${APEX}/`), loc);
    const route = loc.slice(APEX.length).replace(/^\//, '');
    const file = route ? path.join(ROOT, route, 'index.html') : path.join(ROOT, 'index.html');
    assert.ok(fs.existsSync(file), `${loc}: нет страницы ${rel(file)}`);
  }
  const robots = read(path.join(ROOT, 'robots.txt'));
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.ok(!/^Disallow: \/\s*$/m.test(robots), 'боевой robots не должен запрещать обход');
  assert.match(robots, /^Sitemap: https:\/\/palitra-love\.ru\/sitemap\.xml$/m);
});

test('Caddy: боевой домен, www → 301 на apex, временный адрес открыт, но noindex и Disallow', () => {
  const caddy = read(path.join(REPO, 'caddy', 'Caddyfile'));
  const snippet = caddyBlock(caddy, '(palitra_site)');
  assert.match(snippet, /root \* \/srv\/sites\/palitra-love/);
  for (const [route, target] of [['/api/company-links', '/public-company-links/palitra'], ['/api/price /content/palitra/price', '/public-content/palitra/price'],
    ['/api/assets/*', null], ['/api/orders', '/public-orders/palitra']]) {
    assert.ok(snippet.includes(`path ${route}`), `маршрут ${route}`);
    if (target) assert.ok(snippet.includes(`rewrite * ${target}`), `перезапись ${target}`);
  }
  assert.match(snippet, /uri replace \/api\/assets\/ \/content\/palitra\/assets\//);
  assert.match(snippet, /try_files \{path\} \{path\}\/index\.html \/index\.html/);
  assert.ok(!snippet.includes('import draft'), 'сниппет не закрывает боевой домен от поиска');

  const apex = caddyBlock(caddy, 'palitra-love.ru');
  assert.match(apex, /import palitra_site/);
  assert.ok(!apex.includes('import draft'), 'боевой домен без noindex');
  const www = caddyBlock(caddy, 'www.palitra-love.ru');
  assert.match(www, /redir https:\/\/palitra-love\.ru\{uri\} 301/);
  assert.ok(!www.includes('import palitra_site'), 'www только перенаправляет');

  const temp = caddyBlock(caddy, TEMP_HOST);
  assert.match(temp, /import draft/);
  assert.match(temp, /import palitra_site/);
  assert.match(temp, /path \/robots\.txt/);
  assert.match(temp, /User-agent: \*\nDisallow: \/\n/);
  assert.ok(!/redir/.test(temp), 'временный адрес не перенаправляется, пока DNS не переключён');
  assert.match(caddy, /\(draft\) \{\s*header X-Robots-Tag "noindex, nofollow"/);
});

test('нет просроченной сезонной рекламы и неподтверждённых числовых соцдоказательств', () => {
  for (const file of publicFiles) {
    const text = read(file);
    const name = rel(file);
    assert.ok(!/1 сентября|к первому уроку|pervoe-sentyabrya/i.test(text), `${name}: реклама к 1 сентября`);
    for (const claim of ['4,82', '92,5 тыс', '148 отзывов', 'Хорошее место 2026', 'Яндекс.Карты 4,8']) {
      assert.ok(!text.includes(claim), `${name}: неподтверждённое «${claim}»`);
    }
  }
  const home = read(path.join(ROOT, 'index.html'));
  assert.ok(!/Букеты от 3 ?290 руб, шарики от 2 ?990 руб/.test(home), 'старая акционная цена');
  const teacher = read(path.join(ROOT, 'uchitelyu', 'index.html'));
  assert.ok(!/от 3 ?290|от 2 ?990/.test(teacher), 'на странице учителю нет старых цен');
});

test('подборка «День рождения мужчине» на главной — позиция каталога для мужчин, не «Дембель»', () => {
  const app = read(path.join(ROOT, 'assets', 'app.js'));
  const line = app.split('\n').find((row) => row.includes("occasion:'День рождения мужчине'"));
  assert.ok(line, 'подборка есть');
  assert.ok(!/Дембель|dembel\.jpg/.test(line), line);
  assert.match(line, /img:'muzhskoy-set\.jpg'/);
  assert.match(line, /priceId:''/, 'цена не подставляется без подтверждённой позиции');
  const price = JSON.parse(read(path.join(ROOT, 'data', 'price.json')));
  const men = price.categories.find((category) => category.id === 'dr-muzhchine');
  assert.ok(men.items.some((item) => item.photo === '/assets/img/muzhskoy-set.jpg'), 'фото относится к разделу «День рождения мужчине» каталога');
});

/* Размеры PNG из заголовка IHDR: width/height в разметке должны совпадать, чтобы пропорции сохранялись. */
function pngSize(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.toString('ascii', 12, 16), 'IHDR', `${file}: не PNG`);
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

test('логотип: оригинальные PNG клиента в шапке и подвале всех страниц с верными пропорциями', () => {
  const dark = pngSize(path.join(ROOT, 'assets', 'img', 'logo-palitralove-dark.png'));
  const light = pngSize(path.join(ROOT, 'assets', 'img', 'logo-palitralove-light.png'));
  for (const file of pages) {
    const html = read(file);
    const name = rel(file);
    assert.ok(!/logo-(dark|light)\.svg/.test(html), `${name}: остался временный словесный знак SVG`);
    const header = html.match(/<a class="brand"[^>]*><img class="brand-logo" src="([^"]+)"[^>]*width="(\d+)" height="(\d+)"/);
    assert.ok(header, `${name}: логотип в шапке`);
    assert.equal(header[1], '/assets/img/logo-palitralove-dark.png', `${name}: шапка`);
    assert.deepEqual([Number(header[2]), Number(header[3])], dark, `${name}: размеры шапки`);
    const footer = html.match(/<img class="footer-logo" src="([^"]+)"[^>]*width="(\d+)" height="(\d+)"/);
    assert.ok(footer, `${name}: логотип в подвале`);
    assert.equal(footer[1], '/assets/img/logo-palitralove-light.png', `${name}: подвал`);
    assert.deepEqual([Number(footer[2]), Number(footer[3])], light, `${name}: размеры подвала`);
  }
  const css = read(path.join(ROOT, 'assets', 'styles.css'));
  assert.match(css, /\.brand img\.brand-logo\{width:220px;height:auto/, 'шапка масштабируется по ширине без искажения');
  assert.match(css, /\.footer-logo\{width:auto;height:54px;aspect-ratio:1026\/397/, 'подвал сохраняет пропорцию');
  assert.ok(!read(path.join(ROOT, 'assets', 'app.js')).includes('logo-dark.svg'), 'разметка Organization ссылается на PNG');
});

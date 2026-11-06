'use strict';
// №144: сплошной осмотр вёрстки Контент-завода и Настроек на 390 и 1440 — ничего не обрезано,
// не наложено, не выходит за край. Две части: статическая проверка правил (jsdom не считает
// раскладку) и реальный замер в headless Chrome (getBoundingClientRect/scrollWidth), если
// браузер есть на машине; без браузера замер пропускается с явной пометкой.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
const cabinetHtml = fs.readFileSync(path.join(__dirname, '..', 'cabinet.html'), 'utf8');
const shellCss = [...cabinetHtml.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
const contentPlanCss = read('content-plan.css'), autopostingCss = read('autoposting.css');
const settingsCss = read('settings.css'), materialsCss = read('materials.css'), viewAs = read('view-as.js');

test('план-таблица на 640px: первые три ячейки переносятся (правило nowrap перебито в мобильном блоке)', () => {
  const mobile = /@media \(max-width: 640px\) \{([\s\S]*?)\n\}/.exec(contentPlanCss);
  assert.ok(mobile, 'есть мобильный блок 640px');
  assert.match(mobile[1], /\.cp-sheet > tbody > tr > td:nth-child\(-n\+3\)\s*\{[^}]*white-space:\s*normal/);
});

test('полоса дней Постинга на 430px: кнопки делят ширину, а не уезжают за край', () => {
  const blocks = [...autopostingCss.matchAll(/@media\(max-width:430px\)\s*\{([\s\S]*?)\n\}/g)].map(m => m[1]);
  assert.ok(blocks.length, 'есть блок 430px');
  assert.ok(blocks.some(b => /\.ap-day-strip button\s*\{[^}]*flex:\s*1 1 0/.test(b)), 'кнопки полосы дней делят ширину (flex:1 1 0)');
});

test('получатели заявок: подпись над полем, поле на всю ширину формы', () => {
  assert.match(settingsCss, /\.settings-email form\.field-stack > label\s*\{[^}]*display:\s*grid/);
  assert.match(settingsCss, /\.settings-email form\.field-stack input\s*\{[^}]*width:\s*100%/);
});

test('фильтры Материалов: колонка подписи может ужиматься, поле даты не шире неё', () => {
  assert.match(materialsCss, /\.mt-filters label\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(materialsCss, /\.mt-filters input\[type=date\][^{]*\{[^}]*max-width:\s*100%/);
});

test('плашка «Посмотреть как» встаёт под фиксированной мобильной шапкой', () => {
  assert.match(viewAs, /\.mobile-bar/);
  assert.match(viewAs, /banner\.style\.top\s*=/);
});

// ---------- реальный замер в headless Chrome ----------
const chrome = [process.env.CHROME_BIN, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter(Boolean)
  .map(bin => { try { return execFileSync('which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } })
  .find(Boolean);

const inner = () => `<!doctype html><html><head><meta charset="utf-8"><title>layout-144</title>
<style>${shellCss}</style><style>${contentPlanCss}</style><style>${autopostingCss}</style><style>${settingsCss}</style><style>${materialsCss}</style>
<style>.sidebar{display:none}</style></head>
<body class="owner-task-navigation" data-cabinet-view="home">
<div class="mobile-bar"><button class="menu-button" id="menu-button" type="button">☰</button><div class="mobile-context"><strong id="mobile-title">Главная</strong><span id="mobile-project">Авокадо</span></div></div>
<div id="app" class="shell"><main class="main" id="main-content">
<section class="view-panel"><div class="sb-module-root"><section class="cp" data-cp-layout="sheet"><section class="cp-plan">
<div class="cp-sheet-wrap"><table class="cp-sheet"><thead><tr><th>№</th><th>Дата</th><th>Площадки</th><th>Тема</th></tr></thead><tbody>
<tr data-idea="1"><td data-label="№">№1</td><td data-label="Дата">вс, 01.11</td><td data-label="Площадки" id="t-platforms">Instagram / Reels, ВКонтакте, TikTok, YouTube Shorts, Telegram</td><td data-label="Тема">Массаж сжигает жир?</td></tr>
</tbody></table></div></section></section></div></section>
<section class="view-panel autoposting-view"><section class="ap-board-section"><nav id="autoposting-day-strip" class="ap-day-strip" aria-label="Дни недели">
${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d, i) => `<button type="button" class="plain-button" data-strip-date="2026-11-0${i + 2}" aria-pressed="${i === 3}"><span>${d}</span><b>${i + 2}</b></button>`).join('')}
</nav></section></section>
<section class="view-panel"><section class="card settings-email" id="t-email"><h2>Получатели заявок</h2><form class="field-stack"><label>Почта компании<input id="t-recipient" name="recipient" type="email" multiple value="avocado38@example.test,vksenzov40@example.test"></label><button type="submit">Сохранить получателей</button></form></section></section>
<section class="view-panel"><div class="mt-view"><form class="mt-filters"><label>Выход с<input type="date" name="from"></label><label id="t-to">по<input type="date" name="to"></label><label>Площадка<select name="platform"><option>Все площадки</option></select></label></form></div></section>
</main></div>
<script>${viewAs}</script>
<script>
window.SynapseViewAs.render({viewAs:{name:'Лена'}, role:'owner', companies:[], csrfToken:'x'});
const W = document.documentElement.clientWidth, R = el => el.getBoundingClientRect();
const range = document.createRange(); range.selectNodeContents(document.getElementById('t-platforms').firstChild);
const strip = document.getElementById('autoposting-day-strip'), email = document.getElementById('t-email'), input = document.getElementById('t-recipient');
const banner = document.getElementById('view-as-banner'), menu = document.getElementById('menu-button'), to = document.getElementById('t-to');
const result = {
  width: W,
  bodyScrollWidth: document.body.scrollWidth,
  platformsTextRight: Math.round(range.getBoundingClientRect().right),
  stripScrollWidth: strip.scrollWidth, stripClientWidth: strip.clientWidth, stripDisplay: getComputedStyle(strip).display,
  recipientWidth: Math.round(R(input).width), emailFormWidth: Math.round(R(email.querySelector('form')).width),
  bannerTop: Math.round(R(banner).top), bannerBottom: Math.round(R(banner).bottom), menuBottom: Math.round(R(menu).bottom), menuVisible: getComputedStyle(menu.parentElement).display !== 'none',
  toRight: Math.round(R(to).right), toInputRight: Math.round(R(to.querySelector('input')).right)
};
window.__layoutResult = result;
</script></body></html>`;

// Headless Chrome не даёт окно уже 500px, поэтому экран нужной ширины — iframe (srcdoc наследует
// origin родителя, результат читается напрямую).
const fixture = (width, height) => `<!doctype html><html><head><meta charset="utf-8"><title>layout-144</title></head><body style="margin:0">
<iframe id="f" style="border:0;width:${width}px;height:${height}px" srcdoc="${inner().replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>
<script>
const f = document.getElementById('f');
const done = () => { const pre = document.createElement('pre'); pre.id = 'layout-result'; pre.textContent = JSON.stringify(f.contentWindow.__layoutResult || {error: 'нет результата'}); document.body.append(pre); };
if (f.contentWindow && f.contentWindow.__layoutResult) done(); else f.addEventListener('load', done);
</script></body></html>`;

function measure(width, height) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-144-'));
  const file = path.join(dir, 'fixture.html');
  fs.writeFileSync(file, fixture(width, height));
  const out = execFileSync(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--disable-dev-shm-usage',
    `--window-size=${Math.max(width, 500) + 40},${height + 40}`, '--virtual-time-budget=1500', '--dump-dom', `file://${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  fs.rmSync(dir, { recursive: true, force: true });
  const m = /<pre id="layout-result">([^<]*)<\/pre>/.exec(out);
  assert.ok(m, 'Chrome вернул результат замера');
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
}

test('замер в Chrome 390: ничего не выходит за край, полоса дней без прокрутки, поле получателей на всю ширину, плашка под шапкой',
  { skip: chrome ? false : 'headless Chrome не найден (CHROME_BIN / google-chrome / chromium) — замер раскладки пропущен' }, () => {
    const r = measure(390, 844);
    assert.equal(r.width, 390);
    assert.ok(r.bodyScrollWidth <= 390, `страница без горизонтальной прокрутки: ${r.bodyScrollWidth}`);
    assert.ok(r.platformsTextRight <= 390, `текст «Площадки» в пределах экрана: ${r.platformsTextRight}`);
    assert.equal(r.stripDisplay, 'flex');
    assert.ok(r.stripScrollWidth <= r.stripClientWidth + 1, `полоса дней без прокрутки: ${r.stripScrollWidth} ≤ ${r.stripClientWidth}`);
    assert.ok(r.recipientWidth >= r.emailFormWidth - 2, `поле получателей на всю форму: ${r.recipientWidth} ≥ ${r.emailFormWidth}`);
    assert.ok(r.menuVisible, 'мобильная шапка видна');
    assert.ok(r.bannerTop >= r.menuBottom, `плашка под шапкой: ${r.bannerTop} ≥ ${r.menuBottom}`);
    assert.ok(r.toInputRight <= r.toRight + 1 && r.toRight <= 390, `поле «по» в пределах подписи и экрана: ${r.toInputRight}/${r.toRight}`);
  });

test('замер в Chrome 1440: поле получателей на всю ширину, плашка сверху, без горизонтальной прокрутки',
  { skip: chrome ? false : 'headless Chrome не найден — замер раскладки пропущен' }, () => {
    const r = measure(1440, 900);
    assert.equal(r.width, 1440);
    assert.ok(r.bodyScrollWidth <= 1440, `без горизонтальной прокрутки: ${r.bodyScrollWidth}`);
    assert.ok(r.recipientWidth >= r.emailFormWidth - 2, `поле получателей на всю форму: ${r.recipientWidth} ≥ ${r.emailFormWidth}`);
    assert.equal(r.bannerTop, 0, 'на ПК плашка у верхнего края');
    assert.equal(r.menuVisible, false, 'мобильной шапки на ПК нет');
  });

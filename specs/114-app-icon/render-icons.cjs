// Рендер значков Синапса через Playwright из утверждённой картинки (буквы не перенабираются).
// Вариант B (выбран Владом 05.11): фон #020d24; 180/192/512/maskable — логотип целиком
// (шар + надпись Synapse), 32 — только шар .sb-orb.
// Вариант T (отклонён, прозрачный фон): альфа получена из утверждённой картинки «вычитанием» тёмного фона
// (color-to-alpha), сам шар непрозрачен; maskable-512 остаётся на #020d24 (Android режет маской).
// Вариант A (альтернатива): все размеры — только шар .sb-orb на #020d24. Запуск:
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node specs/114-app-icon/render-icons.cjs [B|A|T] [выходной каталог]
// Нужны playwright и sharp (NODE_PATH или /opt/npm-tools/node_modules).
const fs = require('node:fs'), path = require('node:path');
const load = name => { try { return require(name); } catch { return require('/opt/npm-tools/node_modules/' + name); } };
const { chromium } = load('playwright'), sharp = load('sharp');
const brand = path.resolve(__dirname, '../../sites/synapse/brand');
const variant = (process.argv[2] || 'B').toUpperCase(), out = path.resolve(process.argv[3] || brand);
const orb = '<span class="sb-orb" aria-hidden="true"><i class="sb-orb__stone"></i><i class="sb-orb__current"></i><i class="sb-orb__pulse"></i></span>';
const full = '<img class="art" src="sapphire-approved.webp" alt="">';
const fullAlpha = '<img class="art" src=".render-art-rgba.png" alt="">';
// Шар в исходной картинке: кадрирование .sb-orb (265,132,720,720) из living-logo.css.
const orbAlpha = '<div class="crop"><img src=".render-art-rgba.png" alt=""></div>';
const transparent = variant === 'T';
// [файл, размер, доля холста, разметка]; доля 0.8 — безопасная зона maskable (круг 80%).
const jobs = [
  ['synapse-icon-32.png', 32, 1, transparent ? orbAlpha : orb, transparent],
  ['synapse-icon-180.png', 180, 1, transparent ? fullAlpha : variant === 'A' ? orb : full, transparent],
  ['synapse-icon-192.png', 192, 1, transparent ? fullAlpha : variant === 'A' ? orb : full, transparent],
  ['synapse-icon-512.png', 512, 1, transparent ? fullAlpha : variant === 'A' ? orb : full, transparent],
  ['synapse-icon-512-maskable.png', 512, 0.8, variant === 'A' ? orb : full, false]
];
// color-to-alpha относительно тёмного фона картинки; внутри шара альфа = 1.
async function buildAlphaArt(file) {
  const { data, info } = await sharp(path.join(brand, 'sapphire-approved.webp')).raw().toBuffer({ resolveWithObject: true });
  const B = [0, 11, 37], floor = 0.08, cx = 625, cy = 492, solid = 336, edge = 352;
  const outBuf = Buffer.alloc(info.width * info.height * 4);
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * info.channels, o = (y * info.width + x) * 4, c = [data[i], data[i + 1], data[i + 2]];
    let a = 0;
    // Пиксели темнее фона считаются фоном (шум подложки), а не тёмным цветом.
    for (let k = 0; k < 3; k++) if (c[k] > B[k]) a = Math.max(a, (c[k] - B[k]) / (255 - B[k]));
    a = Math.min(1, Math.max(0, (a - floor) / (1 - floor)));
    const r = Math.hypot(x - cx, y - cy), disk = r <= solid ? 1 : r >= edge ? 0 : (edge - r) / (edge - solid);
    a = Math.max(a, disk);
    for (let k = 0; k < 3; k++) outBuf[o + k] = a > 0 ? Math.round(Math.min(255, Math.max(0, (c[k] - B[k] * (1 - a)) / a))) : 0;
    outBuf[o + 3] = Math.round(a * 255);
  }
  await sharp(outBuf, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(file);
}
(async () => {
  const artFile = path.join(brand, '.render-art-rgba.png');
  if (transparent) await buildAlphaArt(artFile);
  const browser = await chromium.launch(), page = await browser.newPage();
  const tmp = path.join(brand, '.render-icon.html');
  try {
    for (const [name, size, ratio, body, clear] of jobs) {
      const s = size < 128 ? size * 8 : size, inner = Math.round(s * ratio);
      await page.setViewportSize({ width: s, height: s });
      // Без living-logo.js анимации стоят на кадре 0% — статичный кадр живого знака.
      fs.writeFileSync(tmp, `<!doctype html><html><head><link rel="stylesheet" href="living-logo.css"><style>
html,body{margin:0;width:${s}px;height:${s}px;background:${clear ? 'transparent' : '#020d24'};overflow:hidden}
.crop{position:relative;width:${inner}px;height:${inner}px;overflow:hidden;border-radius:50%}
.crop img{position:absolute;width:${inner * 1254 / 720}px;left:${-inner * 265 / 720}px;top:${-inner * 132 / 720}px}
.wrap{width:${s}px;height:${s}px;display:grid;place-items:center}
.sb-orb{--sb-orb-size:${inner}px}
.art{display:block;width:${inner}px;height:${inner}px${ratio < 1 ? ';-webkit-mask-image:radial-gradient(closest-side,#000 88%,transparent 100%);mask-image:radial-gradient(closest-side,#000 88%,transparent 100%)' : ''}}
</style></head><body><div class="wrap">${body}</div></body></html>`);
      await page.goto('file://' + tmp, { waitUntil: 'load' });
      await page.evaluate(async () => { const image = new Image(); image.src = 'sapphire-approved.webp'; await image.decode(); });
      await page.waitForTimeout(100);
      const shot = await page.screenshot({ type: 'png', omitBackground: clear });
      await sharp(shot).resize(size, size, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toFile(path.join(out, name));
      console.log(variant, name);
    }
  } finally { fs.rmSync(tmp, { force: true }); fs.rmSync(artFile, { force: true }); await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });

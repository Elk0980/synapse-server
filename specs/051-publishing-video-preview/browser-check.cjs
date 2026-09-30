// Проверка SC-002 (spec 051). Запуск вручную там, где Playwright уже установлен (в CI не входит):
//   node browser-check.cjs <URL медиафайла> <метка>
// Открывает URL напрямую (служебный документ плеера) и без скриптов страницы собирает события CDP Media,
// запросы с Range и CSP-ошибки консоли; перематывает стрелками через встроенные элементы управления.
// Direct navigation to a media URL (Chromium media document). Script-free observation:
// CDP Media domain (player properties/events/errors), network requests with Range, console CSP errors,
// then a seek through the native controls with the keyboard (ArrowRight), and screenshots.
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
const url = process.argv[2], tag = process.argv[3] || 'x';
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 960, height: 600 } }); const logs = [], reqs = [];
  const cdp = await p.context().newCDPSession(p); await cdp.send('Media.enable');
  const props = {}, events = [], errors = [];
  cdp.on('Media.playerPropertiesChanged', e => { for (const q of e.properties) props[q.name] = q.value; });
  cdp.on('Media.playerEventsAdded', e => { for (const q of e.events) events.push(q.value); });
  cdp.on('Media.playerErrorsRaised', e => { for (const q of e.errors) errors.push(q.errorType + ':' + q.code); });
  p.on('console', m => logs.push(m.text().slice(0, 160)));
  p.on('request', r => { const h=r.headers(); reqs.push(r.resourceType() + ':' + (h.range || 'no-range') + (r.resourceType()==='media' ? ' mode=' + (h['sec-fetch-mode']||'?') + ' origin=' + (h.origin||'none') : '')); });
  await p.goto(url, { waitUntil: 'commit', timeout: 10000 });
  await p.waitForTimeout(3000);
  const snap1 = { ...props };
  await p.screenshot({ path: `./shot_${tag}_1.png` });
  await p.waitForTimeout(1000); await p.screenshot({ path: `./shot_${tag}_1b.png` });
  await p.mouse.click(480, 300); for (let i = 0; i < 6; i++) await p.keyboard.press('ArrowRight');
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `./shot_${tag}_2.png` });
  const pick = o => Object.fromEntries(Object.entries(o).filter(([k]) => /Duration|Paused|VideoDecoder|FrameUrl|IsVideoEncrypted|Resolution|kEnded|kIsStreaming|kVideoPlaybackRoughness|kAudioDecoder|kTotalBytes/.test(k)));
  console.log(tag, 'props@3s', JSON.stringify(pick(snap1)));
  const ev=[...new Set(events)].map(x=>{try{return JSON.parse(x)}catch{return {raw:x}}}); console.log(tag, 'pipeline', JSON.stringify(ev.filter(e=>e.pipeline_state).map(e=>e.pipeline_state))); console.log(tag, 'seeks', JSON.stringify(ev.filter(e=>e.event==='kSeek').map(e=>e.seek_target))); console.log(tag, 'other', JSON.stringify(ev.filter(e=>/kPlay|kPause|kEnded|kDurationChanged|Error/i.test(e.event||'')).map(e=>e.event+(e.duration?':'+e.duration:''))));
  console.log(tag, 'errors', JSON.stringify(errors));
  console.log(tag, 'requests', JSON.stringify(reqs.slice(0, 10)), 'total', reqs.length);
  console.log(tag, 'console', JSON.stringify(logs.filter(l => /Security|Refused/i.test(l)).slice(0, 2)));
  await b.close();
})().catch(e => { console.log('probe error', e.message); process.exit(1); });

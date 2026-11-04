'use strict';
/* Поиск счётчика Яндекс Метрики на живом сайте компании (websiteUrl из CRM). Только GET своего сайта:
   HTML главной и подключённые с того же сайта скрипты (сначала analytics/attribution/metrika/counter).
   Ничего не отправляет в Метрику и не подтверждает, что данные приходят: результат — «счётчик стоит на сайте».
   Кэш на 6 ч, таймаут на запрос, лимит размера; адреса-IP, localhost и внутренние домены не запрашиваются. */
const MAX_BYTES = 1_500_000, MAX_SCRIPTS = 25, TIMEOUT_MS = 5000, TTL_MS = 6 * 3600_000, FAIL_TTL_MS = 10 * 60_000;
const PRIORITY = /metrika|attribution|analytics|counter|track|ym\b/i;
const PATTERNS = [/mc\.yandex\.(?:ru|com)\/metrika\/tag\.js\?id=(\d{5,12})/, /mc\.yandex\.(?:ru|com)\/watch\/(\d{5,12})/,
  /\bym\(\s*(\d{5,12})\s*,\s*['"]init['"]/, /yaCounter(\d{5,12})\b/];
const NAMED = /\b(?:counterId|counter_id|COUNTER_ID|metrikaId|metrikaCounter|ymCounter|YM_COUNTER)\s*[:=]\s*['"]?(\d{5,12})\b/;

function counterIn(text) {
  for (const re of PATTERNS) { const m = text.match(re); if (m) return m[1]; }
  // Номер в переменной засчитывается, только если в том же файле есть загрузчик Метрики.
  if (/mc\.yandex\.(?:ru|com)\/metrika/.test(text)) { const m = text.match(NAMED); if (m) return m[1]; }
  return null;
}
function publicHttpUrl(value) {
  let url; try { url = new URL(value); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || /(^|\.)(localhost|local|internal|lan|home|corp)$/.test(host)) return null;
  return url;
}

function createMetrikaSiteProbe({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const cache = new Map();
  async function get(url, origin) {
    let current = url;
    for (let hop = 0; hop < 4; hop++) {
      const response = await fetchImpl(current.href, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'text/html,application/javascript,*/*' } });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        const next = publicHttpUrl(new URL(response.headers.get('location'), current).href);
        if (!next || next.hostname.replace(/^www\./, '') !== origin) return null;
        current = next; continue;
      }
      if (!response.ok) return null;
      const text = await response.text();
      return { text: text.slice(0, MAX_BYTES), url: current };
    }
    return null;
  }
  async function probe(siteUrl) {
    const start = publicHttpUrl(siteUrl);
    if (!start) return { counterId: null, checked: false, reason: 'адрес сайта не подходит для проверки' };
    const key = start.origin, hit = cache.get(key);
    if (hit && now() - hit.at < (hit.value.checked ? TTL_MS : FAIL_TTL_MS)) return hit.value;
    const origin = start.hostname.replace(/^www\./, '');
    let value;
    try {
      const page = await get(start, origin);
      if (!page) value = { counterId: null, checked: false, reason: 'сайт не ответил' };
      else {
        let counterId = counterIn(page.text), foundIn = counterId ? page.url.href : null;
        const scripts = [...page.text.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)]
          .map((m) => { try { return new URL(m[1], page.url); } catch { return null; } })
          .filter((u) => u && publicHttpUrl(u.href) && u.hostname.replace(/^www\./, '') === origin)
          .sort((a, b) => Number(PRIORITY.test(b.pathname)) - Number(PRIORITY.test(a.pathname))).slice(0, MAX_SCRIPTS);
        for (const script of scripts) {
          if (counterId) break;
          const js = await get(script, origin).catch(() => null);
          if (js && (counterId = counterIn(js.text))) foundIn = script.origin + script.pathname;
        }
        value = { counterId, checked: true, foundIn, checkedAt: new Date(now()).toISOString() };
      }
    } catch { value = { counterId: null, checked: false, reason: 'сайт не ответил' }; }
    cache.set(key, { at: now(), value });
    return value;
  }
  return { probe, counterIn };
}

module.exports = { createMetrikaSiteProbe, counterIn, publicHttpUrl };

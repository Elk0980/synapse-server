'use strict';

// Run inside the existing chat container. Never print credentials or request URLs.
const mode = process.argv[2] || 'inspect';
const token = String(process.env.PALITRA_CLIENT_BOT_TOKEN || '').trim();
const expected = { id: 8949578179, username: 'palitra_love_orders_bot' };
const before = { type: 'web_app', text: 'Тестовое приложение',
  web_app: { url: 'https://palitra-bot-preview.synapsebusiness.ru/' } };
const desired = { type: 'web_app', text: 'Каталог Palitra',
  web_app: { url: 'https://palitra-love.ru/catalog' } };
const same = (a, b) => a?.type === b.type && a?.text === b.text && a?.web_app?.url === b.web_app.url;
const refuse = code => { const e = new Error(code); e.safeCode = code; throw e; };

async function telegram(method, body = {}) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
  } catch { refuse(method === 'setChatMenuButton' ? 'WRITE_OUTCOME_UNKNOWN_READ_FIRST' : 'READ_NETWORK_FAILED'); }
  let data;
  try { data = await response.json(); } catch { refuse('INVALID_TELEGRAM_RESPONSE'); }
  if (!response.ok || data?.ok !== true) refuse('TELEGRAM_REJECTED_' + response.status);
  return data.result;
}

(async () => {
  if (!['inspect', 'apply'].includes(mode)) refuse('INVALID_MODE');
  if (!token) refuse('PALITRA_TOKEN_NOT_CONFIGURED');
  const me = await telegram('getMe');
  if (me.id !== expected.id || me.username !== expected.username || !me.is_bot) refuse('WRONG_BOT');
  const menu = await telegram('getChatMenuButton');
  if (mode === 'inspect') {
    console.log(JSON.stringify({ mode, bot: expected, menu })); return;
  }
  if (same(menu, desired)) {
    console.log(JSON.stringify({ mode, status: 'ALREADY_APPLIED', bot: expected, menu })); return;
  }
  if (!same(menu, before)) refuse('MENU_BASE_CHANGED');
  if (await telegram('setChatMenuButton', { menu_button: desired }) !== true) refuse('WRITE_NOT_CONFIRMED');
  const readback = await telegram('getChatMenuButton');
  if (!same(readback, desired)) refuse('MENU_READBACK_MISMATCH');
  console.log(JSON.stringify({ mode, status: 'APPLIED_AND_READBACK_OK', bot: expected, menu: readback }));
})().catch(e => {
  console.error(JSON.stringify({ status: 'STOP', code: e.safeCode || 'UNEXPECTED_FAILURE_NO_DETAILS' }));
  process.exitCode = 1;
});

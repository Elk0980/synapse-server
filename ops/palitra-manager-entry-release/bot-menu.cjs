'use strict';

// Run inside the existing chat container. Never print credentials or request URLs.
// Modes:
//   inspect | apply                       — default menu button of the bot (unchanged behaviour).
//   inspect-manager <chatId> | apply-manager <chatId>
//                                         — menu button of ONE private chat (Root-verified native manager binding).
// The per-chat button only opens the existing owner cabinet; it is not a login and grants no rights.
const args = process.argv.slice(2);
const mode = args[0] || 'inspect';
const token = String(process.env.PALITRA_CLIENT_BOT_TOKEN || '').trim();
const expected = { id: 8940578179, username: 'palitra_love_orders_bot' };
const before = { type: 'web_app', text: 'Тестовое приложение',
  web_app: { url: 'https://palitra-bot-preview.synapsebusiness.ru/' } };
const desired = { type: 'web_app', text: 'Каталог Palitra',
  web_app: { url: 'https://palitra-love.ru/catalog' } };
const workplace = { type: 'web_app', text: 'Рабочее место',
  web_app: { url: 'https://synapse.synapsebusiness.ru/cabinet/palitra-work.html' } };
const plainDefault = { type: 'default' };
// Approved per-chat baselines before the manager write. Anything else stops.
const managerBaselines = [before, desired, plainDefault];

const refuse = code => { const e = new Error(code); e.safeCode = code; throw e; };
const keysAre = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
// Exact comparison: the same set of keys and values, nothing extra (covers {type:'default'}).
function same(actual, wanted) {
  if (wanted.type === 'default') return keysAre(actual, ['type']) && actual.type === 'default';
  return keysAre(actual, ['type', 'text', 'web_app']) && actual.type === wanted.type && actual.text === wanted.text
    && keysAre(actual.web_app, ['url']) && actual.web_app.url === wanted.web_app.url;
}

async function telegram(method, body = {}) {
  const write = method === 'setChatMenuButton';
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
  } catch { refuse(write ? 'WRITE_OUTCOME_UNKNOWN_READ_FIRST' : 'READ_NETWORK_FAILED'); }
  let data;
  try { data = await response.json(); } catch { refuse(write ? 'WRITE_OUTCOME_UNKNOWN_READ_FIRST' : 'INVALID_TELEGRAM_RESPONSE'); }
  if (!response.ok || data?.ok !== true) {
    // An explicit Telegram refusal is a known outcome; a write without a readable verdict is not.
    if (write && data?.ok !== false) refuse('WRITE_OUTCOME_UNKNOWN_READ_FIRST');
    refuse('TELEGRAM_REJECTED_' + response.status);
  }
  return data.result;
}
// Reads after a sent write: a failure here does not mean the write failed.
const readAfterWrite = async (body) => {
  try { return await telegram('getChatMenuButton', body); } catch { refuse('READBACK_FAILED_READ_FIRST'); }
};

function parseArgs() {
  if (['inspect', 'apply'].includes(mode)) {
    if (args.length > 1) refuse('UNEXPECTED_ARGUMENTS');
    return null;
  }
  if (!['inspect-manager', 'apply-manager'].includes(mode)) refuse('INVALID_MODE');
  if (args.length !== 2) refuse('MANAGER_CHAT_ID_REQUIRED');
  const raw = args[1];
  const chatId = /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(chatId) || chatId <= 0) refuse('INVALID_MANAGER_CHAT_ID');
  return chatId;
}

async function defaultMode() {
  const menu = await telegram('getChatMenuButton');
  if (mode === 'inspect') {
    console.log(JSON.stringify({ mode, bot: expected, menu })); return;
  }
  if (same(menu, desired)) {
    console.log(JSON.stringify({ mode, status: 'ALREADY_APPLIED', bot: expected, menu })); return;
  }
  if (!same(menu, before)) refuse('MENU_BASE_CHANGED');
  if (await telegram('setChatMenuButton', { menu_button: desired }) !== true) refuse('WRITE_NOT_CONFIRMED');
  const readback = await readAfterWrite({});
  if (!same(readback, desired)) refuse('MENU_READBACK_MISMATCH');
  console.log(JSON.stringify({ mode, status: 'APPLIED_AND_READBACK_OK', bot: expected, menu: readback }));
}

async function managerMode(chatId) {
  // The default button must already be the main catalog: the manager branch never writes the default.
  const defaultMenu = await telegram('getChatMenuButton');
  const defaultOk = same(defaultMenu, desired);
  const chatMenu = await telegram('getChatMenuButton', { chat_id: chatId });
  const baseline = same(chatMenu, workplace) ? 'workplace' : same(chatMenu, before) ? 'old_test_app'
    : same(chatMenu, desired) ? 'catalog_main' : same(chatMenu, plainDefault) ? 'default' : 'unapproved';
  if (mode === 'inspect-manager') {
    console.log(JSON.stringify({ mode, bot: expected, chatId, defaultMenu, defaultIsCatalogMain: defaultOk, chatMenu, baseline })); return;
  }
  if (!defaultOk) refuse('DEFAULT_NOT_CATALOG_MAIN');
  if (baseline === 'workplace') {
    console.log(JSON.stringify({ mode, status: 'ALREADY_APPLIED', bot: expected, chatId, chatMenu, defaultMenu })); return;
  }
  if (!managerBaselines.some(base => same(chatMenu, base))) refuse('MANAGER_BASE_CHANGED');
  if (await telegram('setChatMenuButton', { chat_id: chatId, menu_button: workplace }) !== true) refuse('WRITE_NOT_CONFIRMED');
  const readback = await readAfterWrite({ chat_id: chatId });
  if (!same(readback, workplace)) refuse('MANAGER_READBACK_MISMATCH');
  const defaultAfter = await readAfterWrite({});
  if (!same(defaultAfter, desired)) refuse('DEFAULT_CHANGED_AFTER_MANAGER_WRITE');
  console.log(JSON.stringify({ mode, status: 'APPLIED_AND_READBACK_OK', bot: expected, chatId, from: baseline, chatMenu: readback, defaultMenu: defaultAfter }));
}

(async () => {
  const chatId = parseArgs();
  if (!token) refuse('PALITRA_TOKEN_NOT_CONFIGURED');
  const me = await telegram('getMe');
  if (me?.id !== expected.id || me?.username !== expected.username || me?.is_bot !== true) refuse('WRONG_BOT');
  if (chatId === null) await defaultMode(); else await managerMode(chatId);
})().catch(e => {
  console.error(JSON.stringify({ status: 'STOP', code: e.safeCode || 'UNEXPECTED_FAILURE_NO_DETAILS' }));
  process.exitCode = 1;
});

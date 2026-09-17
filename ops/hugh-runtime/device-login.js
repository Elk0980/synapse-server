'use strict';

/* Вход по коду устройства через типизированный метод app-server (account/login/start).
   Схема подтверждена в codex-rs/app-server-protocol/src/protocol/v2/account.rs 0.154.0:
   параметры {"type":"chatgptDeviceCode"}, ответ {type, loginId, verificationUrl, userCode}.
   Имя поля именно verificationUrl. Разбора текста CLI здесь нет — нечего ломать инъекцией. */

const {DEVICE_VERIFICATION_URL} = require('./codex-config');

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const USER_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const LOGIN_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

/* Разрешён ровно один официальный адрес. Логин/пароль в URL, чужой хост,
   параметры запроса и якорь отклоняются. */
function isAllowedVerificationUrl(value) {
  if (typeof value !== 'string' || value.length > 256) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (url.search || url.hash) return false;
  if (url.port) return false;
  if (url.hostname !== 'auth.openai.com') return false;
  const path = url.pathname.replace(/\/+$/, '');
  return path === '/codex/device';
}

function isAllowedUserCode(value) {
  return typeof value === 'string' && USER_CODE_PATTERN.test(value);
}

/* Проверяет ответ account/login/start. Любое отклонение — отказ без показа сырых данных. */
function parseDeviceLoginResponse(result) {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return {ok: false, reason: 'login_response_invalid'};
  }
  if (result.type !== 'chatgptDeviceCode') return {ok: false, reason: 'login_type_unexpected'};
  if (typeof result.loginId !== 'string' || !LOGIN_ID_PATTERN.test(result.loginId)) {
    return {ok: false, reason: 'login_id_invalid'};
  }
  if (!isAllowedVerificationUrl(result.verificationUrl)) return {ok: false, reason: 'login_url_rejected'};
  if (!isAllowedUserCode(result.userCode)) return {ok: false, reason: 'login_code_rejected'};
  return {
    ok: true,
    loginId: result.loginId,
    verificationUrl: DEVICE_VERIFICATION_URL,
    userCode: result.userCode,
  };
}

/* Проверяет уведомление account/login/completed. Успех признаём только при совпадении loginId. */
function matchLoginCompleted(params, expectedLoginId) {
  if (typeof params !== 'object' || params === null) return {matched: false, success: false};
  if (params.loginId && params.loginId !== expectedLoginId) return {matched: false, success: false};
  if (!params.loginId) return {matched: false, success: false};
  return {matched: true, success: params.success === true};
}

/* Кэш авторизации ещё не означает, что вывод доступен: это отдельная проверка. */
function parseAccount(result) {
  if (typeof result !== 'object' || result === null) return {authenticated: false, reason: 'account_unreadable'};
  const account = result.account;
  if (!account || typeof account !== 'object') return {authenticated: false, reason: 'account_absent'};
  if (account.type !== 'chatgpt') return {authenticated: false, reason: 'account_not_chatgpt'};
  // Электронную почту и идентификаторы наружу не отдаём.
  return {authenticated: true, reason: 'account_chatgpt'};
}

module.exports = {
  LOGIN_TIMEOUT_MS,
  isAllowedVerificationUrl,
  isAllowedUserCode,
  parseDeviceLoginResponse,
  matchLoginCompleted,
  parseAccount,
};

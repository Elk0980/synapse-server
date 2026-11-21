'use strict';
// Клиент Google Sheets API v4 и Drive API v3 на fetch, без npm-зависимостей.
// Авторизация: сервисный аккаунт Google (JSON-ключ в GOOGLE_SHEETS_SA_JSON),
// JWT RS256 подписывается встроенным node:crypto и обменивается на access token.
const crypto = require('node:crypto');

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
];
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets/';
const DRIVE = 'https://www.googleapis.com/drive/v3/files/';
const TOKEN_SKEW_MS = 60_000;

class GoogleSheetsError extends Error {
  constructor(message, {code = 'GOOGLE_SHEETS_ERROR', status = 0, retryable = false} = {}) {
    super(message);
    this.name = 'GoogleSheetsError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const notConnected = (reason) => new GoogleSheetsError('Google Таблицы не подключены: ' + reason, {code: 'NOT_CONNECTED'});

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Извлекает spreadsheetId из ссылки вида https://docs.google.com/spreadsheets/d/<id>/edit...
// Правила совпадают с проверкой contentPlanSheetUrl в content-settings.js.
function extractSpreadsheetId(sheetUrl) {
  if (typeof sheetUrl !== 'string' || !sheetUrl || sheetUrl.length > 2048) return null;
  let url;
  try { url = new URL(sheetUrl); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || url.port || url.username || url.password) return null;
  const match = /^\/spreadsheets\/d\/([\w-]+)(?:\/|$)/.exec(url.pathname);
  return match ? match[1] : null;
}

function parseCredentials(raw) {
  if (raw === undefined || raw === null || raw === '') return {error: 'переменная GOOGLE_SHEETS_SA_JSON не задана'};
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return {error: 'GOOGLE_SHEETS_SA_JSON не является JSON-ключом сервисного аккаунта'}; }
  }
  if (!value || typeof value !== 'object' || typeof value.client_email !== 'string' || typeof value.private_key !== 'string' || !value.client_email || !value.private_key) {
    return {error: 'в ключе нет client_email или private_key'};
  }
  try { crypto.createPrivateKey(value.private_key); } catch { return {error: 'private_key в ключе не читается'}; }
  return {credentials: {client_email: value.client_email, private_key: value.private_key, token_uri: TOKEN_URI}};
}

function signJwt(credentials, nowMs, scopes = SCOPES) {
  const iat = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({alg: 'RS256', typ: 'JWT'}));
  const claims = base64url(JSON.stringify({iss: credentials.client_email, scope: scopes.join(' '), aud: TOKEN_URI, iat, exp: iat + 3600}));
  const input = header + '.' + claims;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(input), credentials.private_key);
  return input + '.' + base64url(signature);
}

const quoteSheet = (title) => "'" + String(title).replace(/'/g, "''") + "'";

function createGoogleSheetsClient({credentials = process.env.GOOGLE_SHEETS_SA_JSON, fetchImpl = globalThis.fetch, now = () => Date.now()} = {}) {
  const parsed = parseCredentials(credentials);
  let token = null; // {value, expiresAt}
  let pending = null;

  function status() {
    return parsed.credentials
      ? {connected: true, serviceAccountEmail: parsed.credentials.client_email}
      : {connected: false, reason: parsed.error};
  }

  async function request(url, init = {}) {
    let response;
    try { response = await fetchImpl(url, init); } catch (error) {
      throw new GoogleSheetsError('Сеть недоступна: ' + (error && error.message || error), {code: 'NETWORK', retryable: true});
    }
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!response.ok) {
      const detail = body && body.error && (body.error.message || body.error_description || body.error) || text.slice(0, 200);
      const retryable = response.status === 429 || response.status >= 500;
      const code = response.status === 403 ? 'FORBIDDEN' : response.status === 404 ? 'NOT_FOUND' : response.status === 401 ? 'UNAUTHORIZED' : 'HTTP_' + response.status;
      throw new GoogleSheetsError('Google API ' + response.status + ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)), {code, status: response.status, retryable});
    }
    return body;
  }

  async function accessToken() {
    if (!parsed.credentials) throw notConnected(parsed.error);
    if (token && token.expiresAt - TOKEN_SKEW_MS > now()) return token.value;
    if (pending) return pending;
    pending = (async () => {
      const assertion = signJwt(parsed.credentials, now());
      const body = new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion}).toString();
      const result = await request(TOKEN_URI, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body});
      if (!result || typeof result.access_token !== 'string') throw new GoogleSheetsError('Google не выдал access token', {code: 'TOKEN'});
      token = {value: result.access_token, expiresAt: now() + (Number(result.expires_in) || 3600) * 1000};
      return token.value;
    })();
    try { return await pending; } finally { pending = null; }
  }

  async function api(url, {method = 'GET', body} = {}) {
    const headers = {authorization: 'Bearer ' + await accessToken()};
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await request(url, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
    } catch (error) {
      if (error.status === 401) token = null; // ключ отозван или токен истёк раньше срока
      throw error;
    }
  }

  const sid = (spreadsheetId) => {
    if (typeof spreadsheetId !== 'string' || !/^[\w-]+$/.test(spreadsheetId)) throw new GoogleSheetsError('Некорректный spreadsheetId', {code: 'BAD_ID'});
    return encodeURIComponent(spreadsheetId);
  };

  return {
    status,
    accessToken,
    async getModifiedTime(spreadsheetId) {
      const result = await api(DRIVE + sid(spreadsheetId) + '?fields=modifiedTime&supportsAllDrives=true');
      return result && result.modifiedTime || null;
    },
    async getValues(spreadsheetId, range) {
      const result = await api(SHEETS + sid(spreadsheetId) + '/values/' + encodeURIComponent(range) + '?valueRenderOption=FORMATTED_VALUE');
      return result && Array.isArray(result.values) ? result.values : [];
    },
    async batchGetValues(spreadsheetId, ranges) {
      const query = ranges.map((range) => 'ranges=' + encodeURIComponent(range)).join('&');
      const result = await api(SHEETS + sid(spreadsheetId) + '/values:batchGet?' + query + '&valueRenderOption=FORMATTED_VALUE');
      return (result && result.valueRanges || []).map((item) => Array.isArray(item.values) ? item.values : []);
    },
    async batchUpdateValues(spreadsheetId, data) {
      if (!data.length) return {totalUpdatedRows: 0};
      return api(SHEETS + sid(spreadsheetId) + '/values:batchUpdate', {method: 'POST', body: {valueInputOption: 'RAW', data}});
    },
    async ensureSheet(spreadsheetId, title) {
      const meta = await api(SHEETS + sid(spreadsheetId) + '?fields=' + encodeURIComponent('sheets.properties(sheetId,title)'));
      const found = (meta && meta.sheets || []).find((sheet) => sheet.properties && sheet.properties.title === title);
      if (found) return {sheetId: found.properties.sheetId, created: false};
      const result = await api(SHEETS + sid(spreadsheetId) + ':batchUpdate', {method: 'POST', body: {requests: [{addSheet: {properties: {title}}}]}});
      const reply = result && result.replies && result.replies[0] && result.replies[0].addSheet;
      return {sheetId: reply && reply.properties ? reply.properties.sheetId : null, created: true};
    },
  };
}

module.exports = {createGoogleSheetsClient, extractSpreadsheetId, parseCredentials, signJwt, quoteSheet, GoogleSheetsError, SCOPES, TOKEN_URI};

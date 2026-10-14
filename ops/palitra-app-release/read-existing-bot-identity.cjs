'use strict';
// Native Root readonly helper: SELECT existing bridge identity only; no tokens/accounts/messages/network.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const configured = String(process.env.PALITRA_CLIENT_BOT_USERNAME || '').trim().replace(/^@/, '');
const database = String(process.env.DATABASE_PATH || '/data/content.sqlite');
let db = null;
try {
  if (!fs.existsSync(database)) throw new Error('DATABASE_UNAVAILABLE');
  db = new DatabaseSync(database, { readOnly: true });
  const row = db.prepare('SELECT bot_key,ok,username,telegram_bot_id,checked_at FROM client_bot_bridge_state WHERE bot_key=?').get('palitra');
  const username = row && /^[A-Za-z0-9_]{5,32}$/.test(String(row.username)) ? String(row.username) : null;
  const botId = row && /^[1-9]\d{0,19}$/.test(String(row.telegram_bot_id)) ? String(row.telegram_bot_id) : null;
  const matches = Boolean(username && /^[A-Za-z0-9_]{5,32}$/.test(configured) && username.toLowerCase() === configured.toLowerCase());
  const checked = row && Date.parse(row.checked_at), fresh = Number.isFinite(checked) && checked <= Date.now() && Date.now() - checked <= 5 * 60 * 1000;
  console.log(JSON.stringify({status:row?'EXISTING_BINDING_READ':'MISSING_BINDING',site:'palitra',companyCode:'palitra-love',botKey:'palitra',configuredUsername:/^[A-Za-z0-9_]{5,32}$/.test(configured)?configured:null,bridgeUsername:username,botId,bridgeConfirmed:Boolean(row&&row.ok===1),usernameMatches:matches,fresh:Boolean(fresh),checkedAt:row&&typeof row.checked_at==='string'?row.checked_at:null,dbWrites:0,network:0}));
} catch (_) {
  console.log(JSON.stringify({status:'READ_UNAVAILABLE',dbWrites:0,network:0}));process.exitCode=2;
} finally { if (db) db.close(); }

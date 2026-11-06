'use strict';
// Existing CRM access performs Telegram Ed25519 verification, auth_date and nonce replay protection.
// This adapter adds NO memberships/roles and does not create orders/threads or Telegram handlers.
const COMPANY = 'palitra-love', SITE = 'palitra';
const crypto=require('node:crypto');
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
const {DDL,assertMiniappSchema}=require('./miniapp-schema.cjs');
const deny = (status, code, message) => { throw Object.assign(new Error(message), {status,code}); };
const positive = v => Number.isSafeInteger(v) && v > 0;
function createMiniappAuthority({access, db, transact, botId, getBotIdentity, resolveStaff,now=Date.now}) {
  if (!access || typeof access.exchangeTelegram !== 'function' || typeof access.verifyTelegram !== 'function' || typeof access.resolve !== 'function' ||
      typeof access.currentRole !== 'function' || !db || typeof transact!=='function' || typeof getBotIdentity !== 'function' || typeof resolveStaff !== 'function' ||
      typeof botId!=='string' || !/^[1-9]\d{0,19}$/.test(botId))
    throw new TypeError('Нужны существующие auth/database/bot/staff зависимости');
  assertMiniappSchema(db);
  function botKey() {
    // Host constructs existing CRM verifier with this exact botId. A changed/disabled bot
    // invalidates this adapter immediately; caller must never supply bot identity from HTTP.
    const bot=getBotIdentity();
    if (!bot || bot.enabled!==true || bot.botId!==botId || typeof bot.key!=='string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(bot.key))
      deny(503,'MINIAPP_BOT','Связь с ботом временно недоступна');
    return bot.key;
  }
  function actor(token) {
    const key=botKey();
    const binding=typeof token==='string'?db.prepare('SELECT * FROM palitra_miniapp_sessions WHERE token_hash=? AND company_code=?').get(digest(token),COMPANY):null;
    if(!binding||binding.bot_key!==key||binding.bot_id!==botId||binding.expires_at<=now())
      deny(401,'MINIAPP_SESSION','Откройте приложение заново через Telegram');
    const value=access.resolve(token);
    if (!value || value.companyCode!==COMPANY || value.principal?.provider!=='telegram' ||
        typeof value.principal.subject!=='string' || !/^[1-9]\d{0,15}$/.test(value.principal.subject))
      deny(401,'MINIAPP_SESSION','Откройте приложение заново через Telegram');
    return value;
  }
  function exchange(input) {
    const key=botKey();
    if (!input || Object.getPrototypeOf(input)!==Object.prototype || Object.keys(input).some(k=>k!=='initData') || typeof input.initData!=='string')
      deny(400,'MINIAPP_INPUT','Личность подтверждается только Telegram');
    // No automatic retry: existing exchange consumes signed nonce exactly once.
    return transact(()=>{
      const receipt=access.exchangeTelegram(input.initData);
      db.prepare('INSERT INTO palitra_miniapp_sessions(token_hash,company_code,bot_key,bot_id,created_at,expires_at) VALUES(?,?,?,?,?,?)')
        .run(digest(receipt.token),COMPANY,key,botId,now(),receipt.expiresAt);
      return receipt;
    });
  }
  function staff(token, permission='crm.view') {
    if (!['crm.view','crm.edit'].includes(permission)) deny(403,'MINIAPP_PERMISSION','Нет доступа');
    const who=actor(token), role=access.currentRole(who);
    if (!['owner','admin'].includes(role)) deny(403,'MINIAPP_STAFF','Нет действующего доступа сотрудника');
    // Host must resolve existing verified Telegram→Synapse link and CURRENT actual permission/sessionVersion.
    const user=resolveStaff(who.principal.subject,permission);
    if (!user || !positive(user.id) || !Number.isSafeInteger(user.sessionVersion) || user.companyCode!==COMPANY)
      deny(403,'MINIAPP_STAFF','Доступ сотрудника изменился');
    return Object.freeze({id:user.id,sessionVersion:user.sessionVersion});
  }
  function threads(token) {
    const who=actor(token), key=botKey();
    // Read existing VERIFIED channels only. Last per-thread channel wins, including replacement/revocation.
    // A switched thread is an older order of the SAME verified user, not another customer's order.
    return db.prepare(`SELECT t.id AS threadId,t.order_id AS orderId,c.status,c.deactivated_reason
      FROM chat_threads t JOIN chat_thread_channels c ON c.thread_id=t.id
      WHERE t.site=? AND t.company_code=? AND c.bot_key=? AND c.telegram_user_id=?
      AND c.id=(SELECT max(last.id) FROM chat_thread_channels last WHERE last.thread_id=t.id AND last.bot_key=c.bot_key)
      AND (c.status='active' OR (c.status='inactive' AND c.deactivated_reason='switched'))
      ORDER BY t.id DESC`).all(SITE,COMPANY,key,who.principal.subject).map(row=>{
        if (!positive(row.threadId) || !positive(row.orderId)) return null;
        return Object.freeze({orderId:row.orderId,orderRef:`native-order:${row.orderId}`,threadId:row.threadId,threadRef:`thread:${row.threadId}`});
      }).filter(Boolean);
  }
  function order(token,id) {
    if (!positive(id)) deny(404,'MINIAPP_ORDER','Заказ не найден');
    const found=conversations(token).find(row=>row.orderId===id);
    if (!found) deny(404,'MINIAPP_ORDER','Заказ не найден');
    return found;
  }
  function conversations(token) {
    const who=actor(token), current=threads(token), key=botKey();
    const seen=new Set(current.map(x=>x.orderId));
    // Legacy claims remain bound to the exact verified dialog, never name/phone. A newer web-channel
    // binding takes precedence and cannot be bypassed by an older legacy claim.
    const old=db.prepare(`SELECT DISTINCT l.order_id AS orderId,d.id AS dialogId
      FROM client_order_links l JOIN client_dialogs d ON d.id=l.dialog_id AND d.bot_key=l.bot_key
      JOIN site_orders o ON o.id=l.order_id AND o.site=l.site
      WHERE l.site=? AND d.company_code=? AND l.bot_key=? AND d.telegram_user_id=? AND l.used_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM chat_threads t JOIN chat_thread_channels c ON c.thread_id=t.id
        WHERE t.site=l.site AND t.company_code=d.company_code AND t.order_id=l.order_id)
      ORDER BY l.order_id DESC`).all(SITE,COMPANY,key,who.principal.subject);
    for (const row of old) {
      if (!positive(row.orderId)||!positive(row.dialogId)||seen.has(row.orderId)) continue;
      seen.add(row.orderId);
      current.push(Object.freeze({orderId:row.orderId,orderRef:`native-order:${row.orderId}`,
        threadId:null,threadRef:null,dialogId:row.dialogId,dialogRef:`legacy:${row.dialogId}`}));
    }
    return current;
  }
  function bootstrap(token) {
    const who=actor(token), role=access.currentRole(who);
    if (['owner','admin'].includes(role)) { staff(token); return {schema:'palitra-miniapp/v1',role:'staff',companyCode:COMPANY}; }
    return {schema:'palitra-miniapp/v1',role:'customer',companyCode:COMPANY,orders:conversations(token)};
  }
  // Pure signature verification does not consume the exchange nonce. A browser cookie alone
  // cannot identify the Telegram account currently opening the Mini App on this device.
  function resume(token,initData) {
    botKey();
    const principal=access.verifyTelegram(initData),who=actor(token);
    if(principal.provider!==who.principal.provider||principal.subject!==who.principal.subject)
      deny(401,'MINIAPP_IDENTITY_CHANGED','В Telegram открыт другой аккаунт');
    return bootstrap(token);
  }
  return Object.freeze({exchange,actor,staff,threads,conversations,order,bootstrap,resume});
}
module.exports={createMiniappAuthority,DDL};

'use strict';
const crypto=require('node:crypto');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
const TOKEN=/^pcrm\.[A-Za-z0-9_-]{43}$/;
function createMiniappChatContext({db,transact,authority,origin,refKey,now=Date.now}) {
  if (!db || typeof transact!=='function' || !authority || typeof authority.order!=='function' ||
      typeof origin!=='string' || !/^https:\/\/[^/?#]+$/.test(origin)||!Buffer.isBuffer(refKey)||refKey.length<32) throw new TypeError('Нужен существующий контекст чата, server refKey и HTTPS origin');
  function binding(token) {
    const principal=authority.actor(token);
    if(!TOKEN.test(token)||principal.principal?.provider!=='telegram')fail(401,'MINIAPP_SESSION','Откройте приложение через Telegram');
    // Use the already issued CRM session. No new identity, grant by phone/username, account or database.
    const crm=db.prepare(`SELECT s.expires_at,m.bot_key,m.bot_id FROM palitra_crm_sessions s JOIN palitra_miniapp_sessions m ON m.token_hash=s.token_hash
      WHERE s.token_hash=? AND s.company_code='palitra-love' AND s.provider='telegram' AND s.subject=? AND s.revoked_at IS NULL`)
      .get(hash(token),principal.principal.subject);
    if (!crm || !Number.isSafeInteger(crm.expires_at) || crm.expires_at<=now()) fail(401,'MINIAPP_SESSION','Откройте приложение заново через Telegram');
    return {principal,crm};
  }
  function draftScope(token) {
    const {principal,crm}=binding(token);
    // An opaque storage partition, never an authorization credential or the private chat cookie.
    return crypto.createHmac('sha256',refKey).update('palitra-miniapp-draft-v1:'+JSON.stringify([origin,'palitra-love',crm.bot_key,crm.bot_id,principal.principal.subject])).digest('hex');
  }
  function request(token,orderId) {
    const {principal,crm}=binding(token),owned=authority.order(token,orderId),stamp=now();
    if (owned.threadId===null)fail(409,'MINIAPP_LEGACY_CONTEXT','У этой заявки прежняя переписка в Telegram');
    // Private deterministic token is NEVER returned to HTTP/HTML. Standard web cookies remain untouched.
    // The same verified Telegram principal retains its core actor across new MiniApp sessions.
    // This preserves native text/file UUID receipts after reopen. Every call still validates the
    // CURRENT CRM token and exact order binding; this private cookie is never sent to the browser.
    // refKey is the host's already existing server key, not a new credential/provider.
    const secret=crypto.createHmac('sha256',refKey).update('palitra-miniapp-webchat-v2:'+JSON.stringify([origin,'palitra-love',crm.bot_key,crm.bot_id,principal.principal.subject])).digest('base64url');
    const csrf=crypto.createHmac('sha256',secret).update('palitra-chat-csrf-v1').digest('base64url');
    const tokenHash=hash(secret);
    transact(()=>{
      const existing=db.prepare('SELECT * FROM chat_web_sessions WHERE token_hash=?').get(tokenHash);
      if (existing && (existing.revoked_at || existing.site!=='palitra' ||
          existing.company_code!=='palitra-love' || existing.origin!==origin || existing.scope!=='customer_chat' ||
          existing.csrf_hash!==hash(csrf))) fail(401,'MINIAPP_CONTEXT','Сессия переписки изменилась');
      if (!existing) db.prepare(`INSERT INTO chat_web_sessions(token_hash,csrf_hash,site,company_code,origin,scope,account_kind,account_user_id,created_at,expires_at)
        VALUES(?,?,?,?,?,?,'guest',NULL,?,?)`).run(tokenHash,hash(csrf),'palitra','palitra-love',origin,'customer_chat',new Date(stamp).toISOString(),new Date(crm.expires_at).toISOString());
      else if(Date.parse(existing.expires_at)<crm.expires_at)db.prepare('UPDATE chat_web_sessions SET expires_at=? WHERE id=? AND revoked_at IS NULL').run(new Date(crm.expires_at).toISOString(),existing.id);
      const session=db.prepare('SELECT id FROM chat_web_sessions WHERE token_hash=?').get(tokenHash);
      // Recheck authoritative binding inside the same existing transaction, before a new scoped grant.
      if (authority.order(token,orderId).threadId!==owned.threadId) fail(409,'MINIAPP_SCOPE','Переписка заказа изменилась');
      db.prepare('INSERT OR IGNORE INTO chat_web_grants(session_id,thread_id,created_at) VALUES(?,?,?)').run(session.id,owned.threadId,new Date(stamp).toISOString());
    });
    return Object.freeze({site:'palitra',origin,cookie:`__Host-PalitraChat=${secret}`,csrf});
  }
  return Object.freeze({request,draftScope});
}
module.exports={createMiniappChatContext};

'use strict';

const {validatePushSubscription} = require('./people-notifications');
const rejected = code => Object.assign(new Error('Служба доставки отклонила уведомление'), {statusCode:code});
const unknown = () => Object.assign(new Error('Результат доставки не подтверждён'), {uncertain:true});

function createPeopleNotificationTransport({vapidSubject = '',vapidPublicKey = '',vapidPrivateKey = '',fetchImpl = fetch,webPush} = {}) {
  const configured = Boolean(vapidSubject && vapidPublicKey && vapidPrivateKey);
  async function sendPush({subscription,payload}) {
    const safe = validatePushSubscription(subscription);
    if (!configured) throw Object.assign(new Error('Push ещё не настроен'),{statusCode:503});
    let details;
    try {
      const library = webPush || require('web-push');
      details = library.generateRequestDetails(safe,JSON.stringify(payload),{TTL:300,urgency:'normal',contentEncoding:'aes128gcm',
        vapidDetails:{subject:vapidSubject,publicKey:vapidPublicKey,privateKey:vapidPrivateKey}});
    } catch { throw Object.assign(new Error('Не удалось подготовить push'),{statusCode:400}); }
    let response;
    try { response = await fetchImpl(safe.endpoint,{method:'POST',headers:details.headers,body:details.body,redirect:'error',signal:AbortSignal.timeout(15000)}); }
    catch { throw unknown(); }
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw rejected(response.status);
    return {ok:true};
  }
  async function sendTelegram({recipient,payload}) {
    if (!recipient || !/^\d{1,20}$/.test(String(recipient.chatId)) || typeof recipient.botToken !== 'string' || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(recipient.botToken)) throw rejected(400);
    const text = `${payload.title}\n${payload.body}`;
    let response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${recipient.botToken}/sendMessage`,{method:'POST',redirect:'error',
        signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json'},
        body:JSON.stringify({chat_id:String(recipient.chatId),text,disable_web_page_preview:true})});
    } catch { throw unknown(); }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw rejected(response.status); }
    let result;
    try { result = await response.json(); } catch { throw unknown(); }
    if (result?.ok !== true || !Number.isSafeInteger(result.result?.message_id)) {
      if (result?.ok === false && Number.isInteger(result.error_code)) throw rejected(result.error_code);
      throw unknown();
    }
    return {ok:true};
  }
  return {configured,publicKey:configured?vapidPublicKey:'',sendPush,sendTelegram};
}
module.exports = {createPeopleNotificationTransport};

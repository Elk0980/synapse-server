'use strict';
const {VK_ERRORS} = require('./vk-community');
const fail = (status,message) => { throw Object.assign(new Error(message),{status,code:status===403?'FORBIDDEN':'INVALID_REQUEST'}); };
function createVkCommunityHandler({community,companyModuleContext,readJson,send}) {
  return async function handle(request,response,url,cors={}) {
    if (!/^\/vk-community(?:\/|$)/.test(url.pathname)) return false;
    const {identity,company} = companyModuleContext(request,url.searchParams.get('companyCode'),'vk-community.owner');
    if (identity.role !== 'owner') fail(403,'Подключение и сообщения ВК доступны владельцу');
    const code = company.code; let result;
    async function body(limit=64*1024,revalidate=false) {
      const value=await readJson(request,limit);
      if (!value || typeof value!=='object' || Array.isArray(value)) fail(400,'Ожидается объект JSON');
      if(revalidate) {
        const current=companyModuleContext(request,url.searchParams.get('companyCode'),'vk-community.owner');
        if(current.identity.role!=='owner'||current.identity.userId!==identity.userId||current.company.code!==code)fail(403,'Доступ к выбранной компании изменился');
      }
      return value;
    }
    try {
      if (url.pathname === '/vk-community/settings' && request.method === 'GET') result = community.getSettings(code);
      else if (url.pathname === '/vk-community/settings' && request.method === 'PUT') result = community.saveSettings(code,await body());
      else if (url.pathname === '/vk-community/check' && request.method === 'POST') result = await community.checkConnection(code);
      else if (url.pathname === '/vk-community/conversations' && request.method === 'POST') result = await community.syncConversations(code,await body());
      else if (url.pathname === '/vk-community/history' && request.method === 'POST') result = await community.syncHistory(code,await body());
      else if (url.pathname === '/vk-community/reply-preview' && request.method === 'POST') result = community.previewReply(code,await body(12*1024*1024,true));
      else if (url.pathname === '/vk-community/reply-confirm' && request.method === 'POST') result = await community.confirmReply(code,await body(64*1024,true));
      else if (url.pathname === '/vk-community/reply' && request.method === 'POST') result = await community.reply(code,await body());
      else fail(405,'Метод не поддерживается');
      send(response,200,await result,{...cors,'cache-control':'no-store'});
    } catch (error) {
      if (!Object.hasOwn(VK_ERRORS,error.code)) throw error;
      const status=Number.isInteger(error.status) && error.status>=400 && error.status<=599 ? error.status : 502;
      send(response,status,{error:VK_ERRORS[error.code],code:error.code},{...cors,'cache-control':'no-store'});
    }
    return true;
  };
}
module.exports = {createVkCommunityHandler};

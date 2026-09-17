'use strict';
const fail = (status,message) => { throw Object.assign(new Error(message),{status,code:status===403?'FORBIDDEN':'INVALID_REQUEST'}); };
function createVkCommunityHandler({community,companyModuleContext,readJson,send}) {
  return async function handle(request,response,url,cors={}) {
    if (!/^\/vk-community(?:\/|$)/.test(url.pathname)) return false;
    const {identity,company} = companyModuleContext(request,url.searchParams.get('companyCode'),'vk-community.owner');
    if (identity.role !== 'owner') fail(403,'Подключение и сообщения ВК доступны владельцу');
    const code = company.code; let result;
    async function body() {
      const value=await readJson(request);
      if (!value || typeof value!=='object' || Array.isArray(value)) fail(400,'Ожидается объект JSON');
      return value;
    }
    if (url.pathname === '/vk-community/settings' && request.method === 'GET') result = community.getSettings(code);
    else if (url.pathname === '/vk-community/settings' && request.method === 'PUT') result = community.saveSettings(code,await body());
    else if (url.pathname === '/vk-community/check' && request.method === 'POST') result = await community.checkConnection(code);
    else if (url.pathname === '/vk-community/conversations' && request.method === 'POST') result = await community.syncConversations(code,await body());
    else if (url.pathname === '/vk-community/history' && request.method === 'POST') result = await community.syncHistory(code,await body());
    else if (url.pathname === '/vk-community/reply' && request.method === 'POST') result = await community.reply(code,await body());
    else fail(405,'Метод не поддерживается');
    send(response,200,await result,{...cors,'cache-control':'no-store'}); return true;
  };
}
module.exports = {createVkCommunityHandler};

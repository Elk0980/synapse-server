'use strict';
const {VK_DIRECT_ERRORS}=require('./vk-direct');
const {VK_DESIGN_ERRORS}=require('./vk-design');
const fail=(status,code)=>{throw Object.assign(Error(code),{status,code});};
const ERRORS=Object.freeze({INVALID_REQUEST:'Проверьте параметры операции ВК.',SETTINGS_CHANGED:'Подключение изменилось. Обновите раздел.',
  OPERATION_FAILED:'Не удалось выполнить операцию ВК.',...VK_DIRECT_ERRORS,...VK_DESIGN_ERRORS});
function createVkToolsHandler({direct,design,companyModuleContext,readJson,send}) {
  return async function handle(request,response,url,cors={}) {
    if(!/^\/vk-tools(?:\/|$)/.test(url.pathname))return false;
    const scoped=()=>{
      const value=companyModuleContext(request,url.searchParams.get('companyCode'),'vk-community.owner');
      if(value.identity.role!=='owner')fail(403,'FORBIDDEN');
      return value;
    };
    const initial=scoped(),code=initial.company.code;
    try {
      const match=/^\/vk-tools\/(analytics|design)\/(settings|check|state|preview|apply|history|rollback-preview)$/.exec(url.pathname);
      if(!match)fail(404,'INVALID_REQUEST');
      const [,purpose,action]=match;
      const method=action==='settings'?(request.method==='GET'?'GET':'PUT'):['state','history'].includes(action)?'GET':'POST';
      if(request.method!==method || (purpose==='analytics'&&!['settings','check'].includes(action)))fail(405,'INVALID_REQUEST');
      let body;
      if(method!=='GET') {
        body=await readJson(request,action==='preview'?12*1024*1024:64*1024);
        if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'INVALID_REQUEST');
        const fresh=scoped();
        if(fresh.company.code!==code||fresh.identity.userId!==initial.identity.userId)fail(403,'FORBIDDEN');
        if(body.companyCode!==undefined&&String(body.companyCode).toLowerCase()!==code.toLowerCase())fail(400,'INVALID_REQUEST');
      }
      let result;
      if(action==='settings')result=method==='GET'?direct.getSettings(code,purpose):direct.saveSettings(code,purpose,body);
      else if(action==='check') {
        if(!Number.isSafeInteger(body.revision)||body.revision<1||body.revision!==direct.getSettings(code,purpose).revision)fail(409,'SETTINGS_CHANGED');
        result=await direct.checkConnection(code,purpose);
        if(result.revision!==body.revision)fail(409,'SETTINGS_CHANGED');
      } else if(action==='state') {
        const raw=url.searchParams.get('revision');
        if(raw!==null&&!/^[1-9]\d{0,12}$/.test(raw))fail(400,'INVALID_REQUEST');
        result=await design.getState(code,raw===null?{}:{revision:Number(raw)});
      } else if(action==='history')result=design.history(code);
      else if(action==='preview')result=await design.preview(code,body);
      else if(action==='apply')result=await design.apply(code,body);
      else if(action==='rollback-preview')result=await design.rollbackPreview(code,body);
      send(response,200,result,{...cors,'cache-control':'no-store'});
    } catch(error) {
      const known=Object.hasOwn(ERRORS,error.code),status=Number.isInteger(error.status)&&[400,403,404,405,409,413,415,429,500,502,503].includes(error.status)?error.status:500;
      send(response,status,{code:known?error.code:'OPERATION_FAILED',error:known?ERRORS[error.code]:ERRORS.OPERATION_FAILED},{...cors,'cache-control':'no-store'});
    }
    return true;
  };
}
module.exports={createVkToolsHandler};

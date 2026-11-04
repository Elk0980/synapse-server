'use strict';
/* Маршруты «Материалов». Браузер приходит через content proxy (/content/crm/autoposting/reels…):
   proxy уже проверяет autoposting.view/edit для компании и CSRF; здесь права и компания проверяются повторно.
   /internal/reel-materials/* — только по ключу сервиса без заголовка личности: API агента монтажа и лог для чата с Хью. */
const fail=(status,message,code)=>{throw Object.assign(Error(message),{status,...(code?{details:{code}}:{})});};
const REEL=/^\/autoposting\/reels(?:\/(\d+)(?:\/(edits|publication)(?:\/(\d+)\/(cancel))?)?)?$/;
const INTERNAL=/^\/internal\/reel-materials\/(?:(queue|hugh-log)|edits\/(\d+)\/(claim)|reels\/(\d+)\/(versions))$/;
function createReelMaterialsHandler({materials,companyModuleContext,readJson,send,trustedService}){
  return async function handle(request,response,url){
    const headers={'cache-control':'no-store'};
    const internal=INTERNAL.exec(url.pathname);
    if(internal){
      if(!trustedService(request))fail(403,'Только служебный обработчик');
      const code=url.searchParams.get('companyCode')||'';
      let result;
      if(internal[1]){if(request.method!=='GET')fail(405,'Метод не поддерживается');
        /* hugh-log: content забирает записи правок автора в его личный чат с Хью (компания обязательна). */
        result=internal[1]==='queue'?materials.queue(code||null):materials.hughLog(code,url.searchParams.get('authorId'));}
      else if(request.method!=='POST')fail(405,'Метод не поддерживается');
      else if(internal[3])result=materials.claim(code,Number(internal[2]));
      else{const body=await readJson(request);result=materials.addVersion(code,Number(internal[4]),body,request.headers['x-agent-name']);}
      send(response,200,result,headers);return true;
    }
    const match=REEL.exec(url.pathname);if(!match)return false;
    const [,id,section,editId,action]=match,read=request.method==='GET';
    const {identity,company}=companyModuleContext(request,url.searchParams.get('companyCode'),read?'autoposting.view':'autoposting.edit');
    const code=company.code,reelId=id?Number(id):null;let result,status=200;
    if(!id&&read)result=materials.list(code,{from:url.searchParams.get('from')||'',to:url.searchParams.get('to')||'',platform:url.searchParams.get('platform')||''});
    else if(!id&&request.method==='POST'){result=materials.create(code,await readJson(request),identity);status=201;}
    else if(id&&!section&&read)result=materials.get(code,reelId);
    else if(id&&!section&&request.method==='PATCH')result=materials.update(code,reelId,await readJson(request));
    else if(section==='edits'&&!editId&&request.method==='POST'){result=materials.requestEdit(code,reelId,await readJson(request),identity);status=result.duplicate?200:201;}
    else if(section==='edits'&&action==='cancel'&&request.method==='POST')result=materials.cancelEdit(code,reelId,Number(editId));
    else if(section==='publication'&&request.method==='POST'){result=materials.createPublication(code,reelId,await readJson(request),identity);status=201;}
    else fail(405,'Метод не поддерживается');
    send(response,status,result,headers);return true;
  };
}
module.exports={createReelMaterialsHandler};

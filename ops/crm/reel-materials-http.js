'use strict';
/* Маршруты «Материалов». Браузер приходит через content proxy (/content/crm/autoposting/reels…):
   proxy уже проверяет autoposting.view/edit для компании и CSRF; здесь права и компания проверяются повторно.
   /internal/reel-materials/* — только по ключу сервиса без заголовка личности: API агента монтажа и лог для чата с Хью. */
const fail=(status,message,code)=>{throw Object.assign(Error(message),{status,...(code?{details:{code}}:{})});};
const REEL=/^\/autoposting\/reels(?:\/(\d+)(?:\/(edits|publication)(?:\/(\d+)\/(cancel))?)?)?$/;
const INTERNAL=/^\/internal\/reel-materials\/(?:(queue|hugh-log)|edits\/(\d+)\/(claim)|reels\/(\d+)\/(versions))$/;
/* №166: согласование рилса в общем чате компании. Решения — существующими approve / requestEdit (reel-chat-approval.js). */
const CHAT=/^\/autoposting\/reels\/(\d+)\/chat-approvals(?:\/(\d+)(?:\/(approve|changes|publish))?)?$/;
function createReelMaterialsHandler({materials,chatApprovals,companyModuleContext,readJson,send,trustedService}){
  return async function handle(request,response,url){
    const headers={'cache-control':'no-store'};
    if(chatApprovals&&url.pathname==='/internal/reel-materials/chat-approvals'){
      if(!trustedService(request))fail(403,'Только служебный обработчик');
      if(request.method!=='GET')fail(405,'Метод не поддерживается');
      send(response,200,chatApprovals.updates(url.searchParams.get('companyCode')||null),headers);return true;
    }
    const chat=chatApprovals&&CHAT.exec(url.pathname);
    if(chat){
      const [,reel,approvalId,action]=chat,read=request.method==='GET';
      if(read?Boolean(action):(request.method!=='POST'||(approvalId&&!action)))fail(405,'Метод не поддерживается');
      const {identity,company}=companyModuleContext(request,url.searchParams.get('companyCode'),read?'autoposting.view':'autoposting.edit');
      /* Согласование версии — то же право, что у /autoposting/posts/:id/approve: владелец или autoposting.approve. */
      if(action==='approve'&&identity.role!=='owner'&&!identity.permissions?.has('autoposting.approve'))fail(403,'Нет права согласовывать публикации','FORBIDDEN');
      const reelId=Number(reel),id=approvalId?Number(approvalId):null;let result,status=200;
      if(read)result=id?chatApprovals.get(company.code,reelId,id):chatApprovals.latest(company.code,reelId);
      else if(!approvalId){result=chatApprovals.send(company.code,reelId,await readJson(request),identity);status=result.duplicate?200:201;}
      else if(action==='approve'){const body=await readJson(request);if(body&&Object.keys(body).length)fail(400,'Лишние поля запроса');result=chatApprovals.approve(company.code,reelId,id,identity);}
      else if(action==='publish')result=await chatApprovals.publish(company.code,reelId,id,await readJson(request),identity);
      else result=chatApprovals.changes(company.code,reelId,id,await readJson(request),identity);
      send(response,status,result,headers);return true;
    }
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

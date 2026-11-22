'use strict';
/* Маршруты «Материалов». Браузер приходит через content proxy (/content/crm/autoposting/reels…):
   proxy уже проверяет autoposting.view/edit для компании и CSRF; здесь права и компания проверяются повторно.
   /internal/reel-materials/* — только по ключу сервиса без заголовка личности: API агента монтажа и лог для чата с Хью. */
const fail=(status,message,code)=>{throw Object.assign(Error(message),{status,...(code?{details:{code}}:{})});};
const REEL=/^\/autoposting\/reels(?:\/(\d+)(?:\/(edits|publication|archive|restore|requests|live-edit)(?:\/(\d+)\/(cancel))?)?)?$/;
/* specs/231-lena-materials-requests: просьбы агенту с ролика (requests), «живой монтаж» (live-edit) и служебные маршруты агента:
   очередь просьб, ответ со статусом, отрезки версии. Права те же: чтение — autoposting.view, изменение — autoposting.edit. */
const INTERNAL_REQUESTS=/^\/internal\/reel-materials\/(?:(requests)|requests\/(\d+)\/(reply)|reels\/(\d+)\/versions\/(\d+)\/(segments))$/;
/* specs/224-content-archive: убрать/вернуть ролик и отдельную версию. Право — правка контента компании (autoposting.edit). */
/* specs/233: разметка версии по фразам (segments) из кабинета — то же право autoposting.edit и та же проверка компании. */
const VERSION_ARCHIVE=/^\/autoposting\/reels\/(\d+)\/versions\/(\d+)\/(archive|restore|segments)$/;
const INTERNAL=/^\/internal\/reel-materials\/(?:(queue|hugh-log)|edits\/(\d+)\/(claim)|reels\/(\d+)\/(versions))$/;
function createReelMaterialsHandler({materials,companyModuleContext,readJson,send,trustedService}){
  return async function handle(request,response,url){
    const headers={'cache-control':'no-store'};
    // specs/238: только конкретная разметка через существующий Owner MCP; project scope проверяем и для owner.
    if(['/coordination/mcp/reel_segments_get','/coordination/mcp/reel_segments_set'].includes(url.pathname)){
      if(request.method!=='POST')fail(405,'Метод не поддерживается');
      const body=await readJson(request),write=url.pathname.endsWith('_set');
      require('./reel-segments-mcp').validate(body,write);
      const {identity,company}=companyModuleContext(request,body.project,'autoposting.edit');
      if(identity.role!=='owner')fail(403,'Инструмент доступен владельцу');
      if(!identity.companyCodes.has(company.code.toLowerCase()))fail(404,'Проект не найден');
      const result=write?materials.setSegments(company.code,body.reel_id,body.version,{segments:body.segments,expectedRevision:body.expected_revision},{summaryOnly:true})
        :materials.getSegments(company.code,body.reel_id,body.version);
      send(response,200,result,headers);return true;
    }
    if(url.pathname==='/internal/reel-materials/notifications'){
      if(!trustedService(request))fail(403,'Только служебный обработчик');
      if(request.method!=='GET')fail(405,'Метод не поддерживается');
      send(response,200,materials.notificationFeed(Number(url.searchParams.get('after')||0),Number(url.searchParams.get('limit')||100)),headers);return true;
    }
    const notice=/^\/autoposting\/reels\/(?:notifications|(\d+)\/notifications\/read)$/.exec(url.pathname);
    if(notice){
      if(request.method!==(notice[1]?'POST':'GET'))fail(405,'Метод не поддерживается');
      const access=()=>{try{return companyModuleContext(request,url.searchParams.get('companyCode'),'autoposting.view');}
        catch(error){if(error.status!==403)throw error;return companyModuleContext(request,url.searchParams.get('companyCode'),'autoposting.edit');}};
      let context=access();const body=notice[1]?await readJson(request):null;
      context=access();
      const result=notice[1]?materials.readNotifications(context.company.code,Number(notice[1]),body,context.identity):materials.unreadNotifications(context.company.code,context.identity);
      send(response,200,result,headers);return true;
    }
    const problem=/^\/autoposting\/reels\/(\d+)\/problems$/.exec(url.pathname);
    if(problem){
      if(request.method!=='POST')fail(405,'Метод не поддерживается');
      let context;
      try{context=companyModuleContext(request,url.searchParams.get('companyCode'),'autoposting.view');}
      catch(error){if(error.status!==403)throw error;context=companyModuleContext(request,url.searchParams.get('companyCode'),'autoposting.edit');}
      const result=materials.reportProblem(context.company.code,Number(problem[1]),await readJson(request),context.identity);
      send(response,result.duplicate?200:201,result,headers);return true;
    }
    const agent=INTERNAL_REQUESTS.exec(url.pathname);
    if(agent){
      if(!trustedService(request))fail(403,'Только служебный обработчик');
      const code=url.searchParams.get('companyCode')||'';
      let result;
      if(agent[1]){if(request.method!=='GET')fail(405,'Метод не поддерживается');result=materials.requestQueue(code||null);}
      else if(request.method!=='POST')fail(405,'Метод не поддерживается');
      else if(agent[3])result=materials.replyRequest(code,Number(agent[2]),await readJson(request),request.headers['x-agent-name']);
      else result=materials.setSegments(code,Number(agent[4]),Number(agent[5]),await readJson(request));
      send(response,200,result,headers);return true;
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
    const versionArchive=VERSION_ARCHIVE.exec(url.pathname);
    if(versionArchive){
      if(request.method!=='POST')fail(405,'Метод не поддерживается');
      const {identity,company}=companyModuleContext(request,url.searchParams.get('companyCode'),'autoposting.edit');
      const body=await readJson(request),[,reel,version,action]=versionArchive;
      const result=action==='segments'?materials.setSegments(company.code,Number(reel),Number(version),body)
        :materials[action==='archive'?'archiveVersion':'restoreVersion'](company.code,Number(reel),Number(version),body,identity);
      send(response,200,result,headers);return true;
    }
    const match=REEL.exec(url.pathname);if(!match)return false;
    const [,id,section,editId,action]=match,read=request.method==='GET';
    const {identity,company}=companyModuleContext(request,url.searchParams.get('companyCode'),read?'autoposting.view':'autoposting.edit');
    const code=company.code,reelId=id?Number(id):null;let result,status=200;
    if(!id&&read)result=materials.list(code,{from:url.searchParams.get('from')||'',to:url.searchParams.get('to')||'',platform:url.searchParams.get('platform')||'',
      archived:url.searchParams.get('archived')==='1'});
    else if((section==='archive'||section==='restore')&&!editId){
      if(request.method!=='POST')fail(405,'Метод не поддерживается');
      result=materials[section](code,reelId,await readJson(request),identity);
    }
    else if(!id&&request.method==='POST'){result=materials.create(code,await readJson(request),identity);status=result.appended?200:201;}
    else if(id&&!section&&read)result=materials.get(code,reelId);
    else if(id&&!section&&request.method==='PATCH')result=materials.update(code,reelId,await readJson(request),identity);
    else if(section==='requests'&&!editId&&request.method==='POST'){result=materials.createRequest(code,reelId,await readJson(request),identity);status=result.duplicate?200:201;}
    else if(section==='requests'&&action==='cancel'&&request.method==='POST')result=materials.cancelRequest(code,reelId,Number(editId),identity);
    else if(section==='live-edit'&&!editId&&request.method==='POST'){result=materials.liveEdit(code,reelId,await readJson(request),identity);status=result.duplicate?200:201;}
    else if(section==='edits'&&!editId&&request.method==='POST'){result=materials.requestEdit(code,reelId,await readJson(request),identity);status=result.duplicate?200:201;}
    else if(section==='edits'&&action==='cancel'&&request.method==='POST')result=materials.cancelEdit(code,reelId,Number(editId),identity);
    else if(section==='publication'&&request.method==='POST'){result=materials.createPublication(code,reelId,await readJson(request),identity);status=201;}
    else fail(405,'Метод не поддерживается');
    send(response,status,result,headers);return true;
  };
}
module.exports={createReelMaterialsHandler};

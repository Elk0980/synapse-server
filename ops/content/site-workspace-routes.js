'use strict';

function createWorkspaceRoutes({workspaces,siteStore,requirePermission,requireCsrf,readJson}) {
  return async function route(request,reply,url) {
    const parts=url.pathname.split('/').filter(Boolean);
    if(parts[0]!=='content'||parts[1]!=='sites'||parts.length!==4)return false;
    let id;try{id=decodeURIComponent(parts[2]);}catch{throw Object.assign(new Error('Некорректный сайт'),{status:400});}
    const action=parts[3];
    if(!['clone','workspace','file','files','history'].includes(action))return false;
    const write=request.method!=='GET';
    const permission=action==='clone'?'sites.create':write?'site_editor.edit':'site_editor.view';
    const session=requirePermission(request,permission);
    siteStore.get(session.user,id);
    if(write)requireCsrf(request,session);
    const checkBody=(body,fields)=>{
      if(!body||Array.isArray(body)||Object.keys(body).sort().join(',')!==fields.sort().join(','))
        throw Object.assign(new Error('Переданы лишние поля'),{status:400});
      return body;
    };
    if(action==='clone'&&request.method==='POST') {
      const body=checkBody(await readJson(request),['companyCode','name','requestId']);
      const row=workspaces.clone(session.user,{...body,sourceSiteId:id});
      const site=workspaces.enrich(siteStore.get(session.user,row.id),session.user);
      reply(201,{...site,editorUrl:site.editorUrls.site});return true;
    }
    if(action==='workspace'&&request.method==='GET'){reply(200,workspaces.workspace(session.user,id));return true;}
    if(action==='file'&&request.method==='GET'){reply(200,workspaces.file(session.user,id,url.searchParams.get('path')));return true;}
    if(action==='history'&&request.method==='GET'){reply(200,{revisions:workspaces.history(session.user,id)});return true;}
    if(action==='files'&&request.method==='PUT') {
      const body=checkBody(await readJson(request),['baseRevision','files','message']);
      reply(200,workspaces.save(session.user,id,body));return true;
    }
    throw Object.assign(new Error('Метод не поддерживается'),{status:405});
  };
}
module.exports={createWorkspaceRoutes};

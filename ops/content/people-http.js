'use strict';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
function createPeopleHttp({authStore,team,tasks,chat,plan,notifications,runtime,transport,requireSession,requireCsrf,readJson,sendJson}) {
  return async function handle(request,response,url) {
    if(!/^\/content\/people(?:\/|$)/.test(url.pathname))return false;
    const session=requireSession(request),path=url.pathname.slice('/content/people'.length),method=request.method;
    const reply=(status,body)=>{fresh(null);sendJson(response,status,body,{'cache-control':'private, no-store'});return true;};
    const company=()=>{const values=url.searchParams.getAll('companyCode');if(values.length!==1||!session.user.companyCodes.includes(values[0]))fail(403,'Выберите доступную компанию');return values[0];};
    const fresh=(code,owner=false)=>{
      const current=requireSession(request);
      if(current.user.id!==session.user.id||current.user.sessionVersion!==session.user.sessionVersion)fail(401,'Сессия изменилась. Войдите заново');
      if(owner){if(current.user.role!=='owner'||!current.user.companyCodes.includes(code))fail(403,'Доступно владельцу');}
      else if(code)tasks.access(current.user.id,code);
      return current;
    };
    const read=async(code,owner=false)=>{requireCsrf(request,session);const body=await readJson(request);const current=fresh(code,owner);requireCsrf(request,current);return body;};
    if(path==='/context'&&method==='GET') {
      const user=authStore.public(session.user);
      if(user.role!=='owner'&&!user.permissions.includes('tasks.self.view'))fail(403,'Нет доступа к своим задачам');
      const companies=user.companies.filter(c=>{try{tasks.access(user.id,c.id);return true;}catch{return false;}});
      return reply(200,{user,companies,csrfToken:session.csrf,isOwner:user.role==='owner'});
    }
    const member=/^\/members\/(\d+)$/.exec(path);
    const approval=/^\/members\/(\d+)\/approval$/.exec(path);
    const reset=/^\/members\/(\d+)\/temp-password$/.exec(path);
    if(reset&&method==='POST') {
      if(session.user.role!=='owner')fail(403,'Пароль выдаёт владелец');
      const body=await read(null);fresh(body.companyCode,true);
      if(Object.keys(body).join(',')!=='companyCode')fail(400,'Переданы лишние поля');
      const id=Number(reset[1]);
      if(!team.list(session.user.id,body.companyCode).some(m=>m.id===id&&m.staffRole==='human_executor'))fail(403,'Выберите исполнителя этой команды');
      return reply(200,authStore.issueTemporary(session.user.id,id));
    }
    if(approval&&method==='PUT') {
      if(session.user.role!=='owner')fail(403,'Право назначает владелец');
      const body=await read(null);fresh(body.companyCode,true);
      if(Object.keys(body).sort().join(',')!=='companyCode,enabled')fail(400,'Переданы лишние поля');
      return reply(200,plan.grant(session.user.id,Number(approval[1]),body.companyCode,body.enabled));
    }
    if(path==='/members'||member) {
      let code=url.searchParams.get('companyCode');
      if(method==='POST'||method==='PUT') {
        // До чтения тела — проверка owner; конкретная компания проверяется после чтения.
        if(session.user.role!=='owner')fail(403,'Доступ создаёт владелец');
        const body=await read(null,false);code=body.companyCode;fresh(code,true);
        if(path==='/members'&&method==='POST') {
          if(body.staffRole!=='human_executor')fail(400,'Выберите роль исполнителя');
          const {temporaryPassword,expiresAt,...member}=team.create(session.user.id,body,true);
          return reply(201,{member,temporaryPassword,expiresAt});
        }
        if(member&&method==='PUT') {
          if(Object.keys(body).sort().join(',')!=='companyCode,staffRole'||body.staffRole!=='human_executor')fail(400,'Переданы лишние поля');
          return reply(200,{member:team.assignHuman(session.user.id,Number(member[1]),code)});
        }
      }
      if(path==='/members'&&method==='GET') {code=company();fresh(code,true);return reply(200,{members:team.list(session.user.id,code).map(m=>({...m,canApprovePlan:authStore.getById(m.id)?.permissions.includes('content-plan.approve')===true})),roles:['human_executor']});}
      fail(405,'Метод не поддерживается');
    }
    const code=company();fresh(code);
    if(path==='/team-chat'&&method==='GET')return reply(200,chat.list(session.user.id,code,url.searchParams.get('before')));
    if(path==='/team-chat'&&method==='POST')return reply(200,await chat.send(session.user.id,code,await read(code)));
    if(path==='/plan'&&method==='GET')return reply(200,await plan.get(session.user.id,code));
    if(path==='/plan/decision'&&method==='POST')return reply(200,await plan.decide(session.user.id,code,await read(code)));
    if(path==='/tasks'&&method==='GET')return reply(200,await tasks.list(session.user.id,code));
    const task=/^\/tasks\/(\d+)$/.exec(path);
    if(task&&method==='GET')return reply(200,await tasks.get(session.user.id,code,Number(task[1])));
    if(task&&method==='PATCH')return reply(200,await tasks.update(session.user.id,code,Number(task[1]),await read(code)));
    if(path==='/preferences') {
      if(method==='GET')return reply(200,{preferences:notifications.getPreferences(session.user.id,code),pushPublicKey:transport.publicKey,deliveryEnabled:transport.deliveryEnabled});
      if(method==='PUT')return reply(200,{preferences:notifications.setPreferences(session.user.id,code,await read(code))});
    }
    if(path==='/subscriptions') {
      if(method==='POST')return reply(201,notifications.subscribe(session.user.id,code,await read(code)));
      if(method==='DELETE')return reply(200,notifications.unsubscribe(session.user.id,code,await read(code)));
    }
    if(path==='/preview'&&method==='GET')return reply(200,notifications.preview(session.user.id,code));
    if(path==='/friday-rule') {
      fresh(code,true);
      if(method==='GET')return reply(200,{rule:runtime.getRule(session.user.id,code)});
      if(method==='PUT')return reply(200,{rule:runtime.saveRule(session.user.id,code,await read(code,true))});
    }
    if(path==='/friday-preview'&&method==='POST') {requireCsrf(request,session);fresh(code,true);return reply(200,await runtime.preview(session.user.id,code));}
    fail(405,'Метод или адрес не поддерживается');
  };
}
module.exports={createPeopleHttp};

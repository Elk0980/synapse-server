'use strict';
const {createPeopleTasks}=require('./people-tasks');
const {createPeopleCrmClient}=require('./people-crm-client');
const {createPeopleNotifications}=require('./people-notifications');
const {createPeopleNotificationTransport}=require('./people-notification-transport');
const {createPeopleRuntime,createPeopleTelegramResolver}=require('./people-runtime');
const {createPeopleHttp}=require('./people-http');
const {createPeoplePlan}=require('./people-plan');
function createPeopleService({db,authStore,team,crmUrl,crmKey,requireSession,requireCsrf,readJson,sendJson,env=process.env,contentSettings=null,shootingFacts=null}) {
  const enabled=env.PEOPLE_NOTIFICATIONS_ENABLED==='1'&&env.PEOPLE_NOTIFICATIONS_TEXT_APPROVED==='1';
  const call=createPeopleCrmClient({crmUrl,apiKey:crmKey,authStore});
  const tasks=createPeopleTasks({authStore,db,call});
  const answers=require('./team-chat-answers').createTeamChatAnswers({db,tasks,call,env});
  const teamChat=require('./team-chat').createTeamChat({db,tasks,call,answers,unsafe:require('./team-chat-answers').unsafe});
  const plan=createPeoplePlan({db,authStore,tasks,call});
  const transport={...createPeopleNotificationTransport({vapidSubject:env.PEOPLE_VAPID_SUBJECT,
    vapidPublicKey:env.PEOPLE_VAPID_PUBLIC_KEY,vapidPrivateKey:env.PEOPLE_VAPID_PRIVATE_KEY}),deliveryEnabled:enabled};
  const notifications=createPeopleNotifications({db,authStore,enabled,sendPush:transport.sendPush,sendTelegram:transport.sendTelegram,
    resolveTelegram:createPeopleTelegramResolver({db,authStore,env}),
    canReceive:(id,code)=>{try{tasks.access(id,code);return true;}catch{return false;}},
    validateEvent:async({userId,companyCode,eventKey,payload})=>{
      const decision=/^owner-decision:(\d+):(?:created|blocker:\d+)$/.exec(eventKey);
      if(decision) {
        const actor=authStore.getById(userId);
        if(actor?.role!=='owner'||!actor.companyCodes.includes(companyCode))return false;
        const result=await call('ownerDecisionEvents',{taskId:Number(decision[1])},actor,companyCode);
        return result.events.some(event=>event.eventKey===eventKey && event.title.slice(0,1000)===payload.body);
      }
      const match=/^people-task:(\d+):(\d+):(inbox|planned|in_progress|done|cancelled)$/.exec(eventKey);
      if(match) {
        try {const {task}=await tasks.get(userId,companyCode,Number(match[1]));
          return task.assignee_name===`person:${userId}`&&task.coordination.revision===Number(match[2])&&task.status===match[3];
        }catch(error){if([403,404].includes(error.status))return false;throw error;}
      }
      // Этапы Контент-завода (specs/214): своё событие проверяет только модуль рассылки по матрице.
      if(eventKey.startsWith('cf-stage:'))return stageNotify?stageNotify.validateEvent({userId,companyCode,eventKey}):false;
      return runtime.validateEvent({userId,companyCode,eventKey,payload});
    }});
  // Рассылка по матрице «этап × роль»: включается владельцем на компанию (по умолчанию выкл.), доставка — эта же очередь.
  const stageNotify=contentSettings?require('./content-stage-notify').createContentStageNotify({db,authStore,settings:contentSettings,call,
    notifications,shootingFacts:typeof shootingFacts==='function'?shootingFacts:()=>'',peopleDeliveryEnabled:enabled,requireSession,sendJson,
    cabinetUrl:env.CABINET_PUBLIC_URL||undefined}):null;
  const runtime=createPeopleRuntime({db,authStore,tasks,call,notifications,enabled});
  const peopleHandle=createPeopleHttp({authStore,team,tasks,chat:teamChat,plan,notifications,runtime,transport,requireSession,requireCsrf,readJson,sendJson});
  const handle=async(request,response,url)=>(stageNotify&&await stageNotify.handle(request,response,url))||peopleHandle(request,response,url);
  return {handle,stageNotify,
    start(){runtime.start();stageNotify?.start();},
    async stop(){await Promise.all([runtime.stop(),stageNotify?.stop()]);}};
}
module.exports={createPeopleService};

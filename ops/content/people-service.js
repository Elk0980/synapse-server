'use strict';
const {createPeopleTasks}=require('./people-tasks');
const {createPeopleCrmClient}=require('./people-crm-client');
const {createPeopleNotifications}=require('./people-notifications');
const {createPeopleNotificationTransport}=require('./people-notification-transport');
const {createPeopleRuntime,createPeopleTelegramResolver}=require('./people-runtime');
const {createPeopleHttp}=require('./people-http');
const {createPeoplePlan}=require('./people-plan');
function createPeopleService({db,authStore,team,crmUrl,crmKey,requireSession,requireCsrf,readJson,sendJson,env=process.env}) {
  const enabled=env.PEOPLE_NOTIFICATIONS_ENABLED==='1'&&env.PEOPLE_NOTIFICATIONS_TEXT_APPROVED==='1';
  const call=createPeopleCrmClient({crmUrl,apiKey:crmKey});
  const tasks=createPeopleTasks({authStore,db,call});
  const answers=require('./team-chat-answers').createTeamChatAnswers({db,tasks,call,env});
  const teamChat=require('./team-chat').createTeamChat({db,tasks,call,answers});
  const plan=createPeoplePlan({db,authStore,tasks,call});
  const transport={...createPeopleNotificationTransport({vapidSubject:env.PEOPLE_VAPID_SUBJECT,
    vapidPublicKey:env.PEOPLE_VAPID_PUBLIC_KEY,vapidPrivateKey:env.PEOPLE_VAPID_PRIVATE_KEY}),deliveryEnabled:enabled};
  const notifications=createPeopleNotifications({db,authStore,enabled,sendPush:transport.sendPush,sendTelegram:transport.sendTelegram,
    resolveTelegram:createPeopleTelegramResolver({db,authStore,env}),
    canReceive:(id,code)=>{try{tasks.access(id,code);return true;}catch{return false;}},
    validateEvent:async({userId,companyCode,eventKey,payload})=>{
      const match=/^people-task:(\d+):(\d+):(inbox|planned|in_progress|done|cancelled)$/.exec(eventKey);
      if(match) {
        try {const {task}=await tasks.get(userId,companyCode,Number(match[1]));
          return task.assignee_name===`person:${userId}`&&task.coordination.revision===Number(match[2])&&task.status===match[3];
        }catch(error){if([403,404].includes(error.status))return false;throw error;}
      }
      return runtime.validateEvent({userId,companyCode,eventKey,payload});
    }});
  const runtime=createPeopleRuntime({db,authStore,tasks,call,notifications,enabled});
  const handle=createPeopleHttp({authStore,team,tasks,chat:teamChat,plan,notifications,runtime,transport,requireSession,requireCsrf,readJson,sendJson});
  return {handle,start:runtime.start,stop:runtime.stop};
}
module.exports={createPeopleService};

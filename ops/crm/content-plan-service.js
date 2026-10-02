'use strict';
const {object,fail}=require('./company-information');
const {slotsFor,validateWorkflowContext,WORKFLOW_FIELDS}=require('./content-plan-worker');
const {validateSourceLibrary}=require('./content-plan-jobs');
const {validatePlanningContext}=require('./content-factory-planning-context');
// The request supplies only month and idempotency key. Context is always taken from this company's stored versions.
function createContentPlanService({mentor,jobs,workflow=null}){
 function workflowSnapshot(code){
  if(!workflow)return null;
  const saved=workflow.get(code);
  // Полный CF21 DTO содержит указанное имя ответственного. В задания/модель идут только operational поля.
  object(saved.fields,[...WORKFLOW_FIELDS,'publisherName']);
  return validateWorkflowContext({companyCode:saved.companyCode,revision:saved.revision,configured:saved.configured,
   fields:Object.fromEntries(WORKFLOW_FIELDS.map(key=>[key,saved.fields[key]]))},code);
 }
 function create(code,body,serverContext=null,planningContext=null){
  object(body,['clientRequestId','month']);
  const previous=jobs.lookupRequest(code,body.clientRequestId,body.month);
  if(previous)return previous;
  const sourceLibrary=serverContext===null?null:validateSourceLibrary(serverContext,code);
  const planningInsights=planningContext===null?null:validatePlanningContext(planningContext,code,body.month);
  const brief=mentor.get(code).brief,profile=mentor.inputs.get(code),month=mentor.inputs.month(code,body.month);
  const workflowContext=workflowSnapshot(code);
  const questions=[],ask=(id,target,text)=>questions.push({id,target,text,required:true});
  if(!brief.fields.product?.trim())ask('product','brief.product','Какой продукт или услугу продвигаем?');
  if(!brief.fields.audience?.trim())ask('audience','brief.audience','Для кого готовим публикации?');
  if(!brief.fields.pains?.length)ask('situation','brief.pains','В какой ситуации покупателю нужен ваш продукт?');
  // Целевое действие необязательно по спецификации: отсутствие не блокирует черновой план.
  if(!profile.timezone)ask('timezone','profile.timezone','Укажите часовой пояс в настройках компании.');
  let requested=0;
  try{requested=slotsFor(month.month,month.inputs).length}catch{ask('volume','month.platforms','Выберите площадки и ненулевой объём публикаций на месяц.');}
  if(month.inputs.platforms.includes('youtube_shorts')&&month.inputs.perDay.youtube_shorts>0&&
    month.inputs.formats?.length&&!month.inputs.formats.includes('reel'))
    ask('formats','month.formats','Для YouTube Shorts нужен формат Reels / Shorts / клип. Добавьте его в выбранные форматы или уберите объём YouTube Shorts.');
  // Other DB clients can write between these reads. Never attach a mixed set of revisions to a queued job.
  if(mentor.get(code).brief.revision!==brief.revision || mentor.inputs.get(code).profile.revision!==profile.profile.revision || mentor.inputs.month(code,body.month).revision!==month.revision ||
    workflowContext&&workflowSnapshot(code).revision!==workflowContext.revision)
    fail(409,'Вводные изменились во время запуска. Повторите запуск.','INPUTS_CHANGED');
  const snapshot={inputs:{briefRevision:brief.revision,profileRevision:profile.profile.revision,monthRevision:month.revision,...(workflowContext?{workflowRevision:workflowContext.revision}:{})},
   timezone:profile.timezone,brief:{...brief.fields,confirmedFacts:(brief.fields.confirmedFacts||[]).filter(f=>f.approvedForContent===true)},
   profile:profile.profile.fields,monthInputs:JSON.parse(JSON.stringify(month.inputs)),requested,
   ...(workflowContext?{workflow:workflowContext}:{}),...(sourceLibrary===null?{}:{sourceLibrary}),...(planningInsights===null?{}:{planningInsights})};
  if(!questions.length&&!jobs.canGenerate())fail(501,'Исполнитель подготовки пока не подключён. Обратитесь к администратору.','PROVIDER_NOT_CONFIGURED');
  const job=jobs.enqueue(code,{clientRequestId:body.clientRequestId,month:body.month,snapshot,questions});
  return {companyCode:profile.companyCode,job};
 }
 return {create,get:jobs.get,list:jobs.list};
}
module.exports={createContentPlanService};

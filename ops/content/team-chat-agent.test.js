'use strict';
// specs/228: ответы агента владельца «Лео · Claude» в Чатах кабинета.
const {test}=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {createTeamChat}=require('./team-chat');
const {createTeamChatAnswers,unsafe,HANDOFF,LEO_HANDOFF,LEO_REDIRECT}=require('./team-chat-answers');
const {createTeamChatAgent}=require('./team-chat-agent');
const {createPeopleHttp}=require('./people-http');

function fixture(t,{env={}}={}) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  // 1 — владелец (alvi, avokado); 2, 3 — alvi; 4 — avokado.
  const people={1:{name:'Влад',codes:['alvi','avokado'],role:'owner'},2:{name:'Лена',codes:['alvi']},3:{name:'Таня',codes:['alvi']},4:{name:'Петя',codes:['avokado']}};
  const tasks={access(id,code){const p=people[id];if(!p||!p.codes.includes(code))throw Object.assign(Error('denied'),{status:403});return {id,displayName:p.name,role:p.role||'editor'};}};
  let taskId=700;
  const call=async(action,args,user,code)=>{if(action==='teamChatContext')return {companyCode:code,tasks:[],plan:[]};
    if(action==='hughTask')return {task:{id:++taskId,company_code:code,assignee_name:'Хью'}};
    if(action==='teamChatTask')return {task:{id:++taskId,company_code:code,assignee_name:`person:${user.id}`}};
    throw Error(`unexpected ${action}`);};
  let clock=Date.parse('2026-11-07T11:00:00Z');const now=()=>new Date(clock).toISOString();
  const answers=createTeamChatAnswers({db,tasks,call,env,now:()=>clock});
  const chat=createTeamChat({db,tasks,call,answers,unsafe,now});
  const agent=createTeamChatAgent({db,chat,now});
  let n=0;const send=(id,code,text,extra={})=>chat.send(id,code,{text,clientMessageId:`agent-test-${++n}`,...extra}).then(r=>r.message);
  const audit=id=>db.prepare('SELECT * FROM team_chat_answers WHERE message_id=?').get(id);
  const assistant=(viewer,code='alvi',room='common')=>chat.list(viewer,code,null,room).messages.filter(m=>m.user_id===0);
  return {db,chat,agent,send,audit,assistant,tasks,advance(ms){clock+=ms;}};
}

test('запасной ответ: «Лео, …» без встроенного ИИ — «Лео получил запрос», Хью — как раньше, упоминание — без ответа',async t=>{
  const f=fixture(t);
  const leo=await f.send(2,'alvi','Лео, смонтируй рилс из вчерашних дублей');
  const hugh=await f.send(2,'alvi','Хью, что у меня в работе?');
  await f.send(2,'alvi','Мы вчера обсуждали это с Лео');
  const own=f.assistant(2);
  assert.deepEqual(own.map(m=>[m.author_name,m.text]),[['Лео',LEO_HANDOFF],['Хью · ИИ','Хью передал вопрос команде — ответим здесь, в этом чате.']]);
  assert.equal(f.audit(leo.id).status,'agent_pending');assert.equal(f.audit(hugh.id).status,'review_required');
  assert.equal(f.db.prepare('SELECT count(*) n FROM team_chat_answers').get().n,2,'упоминание без обращения ответа не вызывает');
  assert.equal(f.assistant(3).length,0,'запасной ответ видит спрашивающий и владелец, не коллеги');
  // Чужой лог с Хью владелец не читает — честно зовём в общий чат; свой лог владельца агент читает.
  const hidden=await f.send(2,'alvi','Лео, подготовь план съёмки',{room:'hugh:2'});
  assert.equal(f.audit(hidden.id).status,'agent_redirect');assert.equal(f.assistant(2,'alvi','hugh:2').at(-1).text,LEO_REDIRECT);
  const mine=await f.send(1,'alvi','Лео, проверь монтаж',{room:'hugh:1'});assert.equal(f.audit(mine.id).status,'agent_pending');
  const dm=await f.send(2,'alvi','@Лео посмотри исходники',{room:'dm:1-2'});assert.equal(f.audit(dm.id).status,'agent_pending');
  // Названы оба — отвечает тот, кто раньше.
  const both=await f.send(2,'alvi','Хью, передай Лео: монтаж');assert.equal(f.audit(both.id).status,'review_required');
});

test('inbox: только владельцу, обращения к персоне в комнатах владельца, без отвеченных, 7 дней, since',async t=>{
  const f=fixture(t);
  const common=await f.send(2,'alvi','Лео, смонтируй рилс');
  const dmOwner=await f.send(2,'alvi','Лео, вот исходники',{room:'dm:1-2'});
  await f.send(2,'alvi','Лео, это только Тане',{room:'dm:2-3'});
  await f.send(2,'alvi','Лео, в моём логе',{room:'hugh:2'});
  await f.send(4,'avokado','Лео, другая компания');
  const hugh=await f.send(3,'alvi','Хью, поправь сайт');
  const ownLog=await f.send(1,'alvi','Что по сайту?',{room:'hugh:1'});
  await f.send(2,'alvi','Коллеги, привет');
  const inbox=f.agent.inbox(1,'alvi',{persona:'leo'});
  assert.deepEqual(inbox.messages.map(m=>m.id),[common.id,dmOwner.id]);
  assert.equal(inbox.messages[0].fallbackStatus,'agent_pending');assert.equal(inbox.messages[0].authorName,'Лена');
  assert.deepEqual(f.agent.inbox(1,'alvi',{persona:'hugh'}).messages.map(m=>m.id),[hugh.id,ownLog.id],'в своём логе с Хью обращение подразумевается');
  assert.deepEqual(f.agent.inbox(1,'avokado',{persona:'leo'}).messages.map(m=>m.text),['Лео, другая компания']);
  assert.deepEqual(f.agent.inbox(1,'alvi',{persona:'leo',since:String(common.id)}).messages.map(m=>m.id),[dmOwner.id]);
  f.agent.reply(1,'alvi',{room:'common',text:'Смонтировал, проверьте.',persona:'leo',replyTo:common.id,clientId:'agent-reply-0001'});
  assert.deepEqual(f.agent.inbox(1,'alvi',{persona:'leo'}).messages.map(m=>m.id),[dmOwner.id],'отвеченное агентом уходит из inbox');
  f.advance(8*864e5);await f.send(2,'alvi','Лео, свежий запрос');
  assert.deepEqual(f.agent.inbox(1,'alvi',{persona:'leo'}).messages.map(m=>m.text),['Лео, свежий запрос'],'старше 7 дней не показываются');
  assert.throws(()=>f.agent.inbox(2,'alvi',{persona:'leo'}),{status:403});
  assert.throws(()=>f.agent.inbox(1,'alvi',{persona:'eva'}),{status:400});
  assert.throws(()=>f.agent.inbox(1,'alvi',{persona:'leo',since:'-1'}),{status:400});
});

test('inbox: не больше 50 за раз, nextSince продолжает без повторов',async t=>{
  const f=fixture(t);
  for(let i=0;i<60;i++)await f.send(2,'alvi',`Лео, запрос ${i}`);
  const first=f.agent.inbox(1,'alvi',{persona:'leo'});assert.equal(first.messages.length,50);
  const rest=f.agent.inbox(1,'alvi',{persona:'leo',since:first.nextSince});
  assert.equal(rest.messages.length,10);assert.equal(rest.messages[0].text,'Лео, запрос 50');
});

test('reply: «Лео · Claude» в той же комнате, видят участники комнаты, запасной ответ остаётся со статусом agent_answered',async t=>{
  const f=fixture(t);
  const question=await f.send(2,'alvi','Лео, смонтируй рилс');
  const hughQ=await f.send(3,'alvi','Хью, что по сайту?');
  assert.equal(f.chat.list(1,'alvi').reviewQueue.length,1);
  const body={room:'common',text:'  Смонтировал черновик, ссылка в материалах.  ',persona:'leo',replyTo:question.id,clientId:'agent-reply-0001'};
  const first=f.agent.reply(1,'alvi',body);
  assert.equal(first.created,true);assert.equal(first.message.user_id,0);assert.equal(first.message.author_name,'Лео · Claude');
  assert.equal(first.message.room,'common');assert.equal(first.message.company_code,'alvi');assert.equal(first.message.text,'Смонтировал черновик, ссылка в материалах.');
  assert.deepEqual(first.message.agentReply,{persona:'leo',replyTo:question.id});
  for(const viewer of [1,2,3])assert.ok(f.chat.list(viewer,'alvi').messages.some(m=>m.id===first.message.id&&m.agentReply?.persona==='leo'),`видит ${viewer}`);
  assert.equal(f.chat.list(4,'avokado').messages.length,0,'другая компания не видит');
  assert.equal(f.audit(question.id).status,'agent_answered');
  assert.ok(f.assistant(2).some(m=>m.text===LEO_HANDOFF),'история запасного ответа не удаляется');
  // Идемпотентность clientId.
  const again=f.agent.reply(1,'alvi',body);assert.equal(again.created,false);assert.equal(again.message.id,first.message.id);
  assert.throws(()=>f.agent.reply(1,'alvi',{...body,text:'Другой текст'}),{status:409});
  assert.throws(()=>f.agent.reply(1,'alvi',{...body,persona:'hugh'}),{status:409});
  assert.equal(f.db.prepare("SELECT count(*) n FROM team_chat_messages WHERE author_name='Лео · Claude'").get().n,1);
  // Ответ Хью · Claude снимает вопрос из очереди проверки владельца.
  f.agent.reply(1,'alvi',{room:'common',text:'Сайт обновлён.',persona:'hugh',replyTo:hughQ.id,clientId:'agent-reply-0002'});
  assert.equal(f.audit(hughQ.id).status,'agent_answered');assert.equal(f.chat.list(1,'alvi').reviewQueue.length,0);
  // Без replyTo — просто ответ ассистента в комнату.
  const free=f.agent.reply(1,'alvi',{room:'dm:1-2',text:'Готово.',persona:'leo',clientId:'agent-reply-0003'});
  assert.equal(free.message.agentReply.replyTo,null);assert.ok(f.chat.list(2,'alvi',null,'dm:1-2').messages.some(m=>m.id===free.message.id));
  // Позднее завершение встроенного ответа не дублирует уже отвеченное агентом.
  assert.equal(f.assistant(2).filter(m=>m.text===LEO_HANDOFF).length,1);
});

test('reply: права, комнаты и компании — 403, проверка тела — 400',async t=>{
  const f=fixture(t);
  const question=await f.send(2,'alvi','Лео, смонтируй рилс');
  const private_=await f.send(2,'alvi','Лео, только Тане',{room:'dm:2-3'});
  const other=await f.send(4,'avokado','Лео, другая компания');
  const ok={room:'common',text:'Ответ',persona:'leo',clientId:'agent-reply-0100'};
  assert.throws(()=>f.agent.reply(2,'alvi',ok),{status:403},'не владелец');
  assert.throws(()=>f.agent.reply(1,'alvi',{...ok,room:'dm:2-3'}),{status:403},'чужой личный чат');
  assert.throws(()=>f.agent.reply(1,'alvi',{...ok,room:'hugh:2'}),{status:403},'чужой лог с Хью');
  assert.throws(()=>f.agent.reply(1,'alvi',{...ok,replyTo:other.id}),{status:403},'сообщение другой компании');
  assert.throws(()=>f.agent.reply(1,'alvi',{...ok,replyTo:private_.id}),{status:403},'сообщение другой комнаты');
  assert.throws(()=>f.agent.reply(1,'alvi',{...ok,replyTo:99999}),{status:403});
  assert.throws(()=>f.agent.reply(1,'alvi',{...ok,room:'dm:1-4'}),{status:403},'собеседник из другой компании');
  const leoAnswer=f.assistant(2)[0];
  assert.throws(()=>f.agent.reply(1,'alvi',{...ok,replyTo:leoAnswer.id}),{status:403},'на ответ ассистента не отвечаем');
  for(const bad of [{...ok,text:''},{...ok,text:'   '},{...ok,text:'x'.repeat(2001)},{...ok,persona:'eva'},{...ok,clientId:'short'},{...ok,replyTo:0},{...ok,replyTo:'1'},{...ok,extra:1},{room:'common',text:'x',persona:'leo'},null,[]])
    assert.throws(()=>f.agent.reply(1,'alvi',bad),{status:400},JSON.stringify(bad));
  assert.equal(f.agent.reply(1,'alvi',{...ok,text:'x'.repeat(2000),replyTo:question.id}).message.text.length,2000);
});

test('HTTP: маршруты только владельцу, companyCode и CSRF обязательны',async t=>{
  const f=fixture(t);
  const question=await f.send(2,'alvi','Лео, смонтируй рилс');
  const sessions={1:{user:{id:1,role:'owner',companyCodes:['alvi','avokado'],sessionVersion:1},csrf:'csrf-owner'},2:{user:{id:2,role:'editor',companyCodes:['alvi'],sessionVersion:1},csrf:'csrf-lena'}};
  const forbid=m=>{throw Object.assign(Error(m),{status:403});};
  const handle=createPeopleHttp({authStore:{},team:{},tasks:f.tasks,chat:f.chat,agent:f.agent,plan:{},notifications:{},runtime:{},transport:{},
    requireSession:r=>sessions[r.user]||(()=>{throw Object.assign(Error('login'),{status:401});})(),
    requireCsrf:(r,s)=>{if(r.headers['x-csrf-token']!==s.csrf)forbid('csrf');},readJson:async r=>r.body,
    sendJson:(res,status,body)=>{res.status=status;res.body=body;}});
  const call=async(user,method,route,body,csrf=true)=>{
    const url=new URL(route,'http://cabinet.test'),response={};
    try{await handle({user,method,headers:csrf?{'x-csrf-token':sessions[user]?.csrf}:{},body},response,url);return response;}
    catch(error){return {status:error.status||500,body:{error:error.message}};}
  };
  const reply={room:'common',text:'Смонтировал.',persona:'leo',replyTo:question.id,clientId:'agent-http-0001'};
  const post='/content/people/team-chat/agent-reply?companyCode=alvi';
  assert.equal((await call(1,'POST',post,reply,false)).status,403,'без CSRF');
  assert.equal((await call(2,'POST',post,reply)).status,403,'не владелец');
  assert.equal((await call(1,'POST','/content/people/team-chat/agent-reply',reply)).status,403,'без companyCode');
  assert.equal((await call(1,'POST','/content/people/team-chat/agent-reply?companyCode=palitra',reply)).status,403,'компания вне сессии');
  assert.equal((await call(1,'POST','/content/people/team-chat/agent-reply?companyCode=avokado',reply)).status,403,'вопрос другой компании');
  const inboxUrl='/content/people/team-chat/agent-inbox?companyCode=alvi&persona=leo';
  const inbox=await call(1,'GET',inboxUrl);assert.equal(inbox.status,200);assert.deepEqual(inbox.body.messages.map(m=>m.id),[question.id]);
  assert.equal((await call(2,'GET',inboxUrl)).status,403);
  const created=await call(1,'POST',post,reply);assert.equal(created.status,200);assert.equal(created.body.message.author_name,'Лео · Claude');
  const repeat=await call(1,'POST',post,reply);assert.equal(repeat.body.message.id,created.body.message.id);assert.equal(repeat.body.created,false);
  assert.equal((await call(1,'POST',post,{...reply,text:'Иначе'})).status,409);
  assert.equal((await call(1,'GET',inboxUrl)).body.messages.length,0);
  assert.equal((await call(1,'DELETE',post)).status,405);
  assert.equal((await call(1,'GET','/content/people/team-chat/agent-inbox?companyCode=alvi')).status,400,'персона обязательна');
});

test('inbox: упоминание персоны — не обращение; логика та же, что у ответа в чате',async t=>{
  const f=fixture(t);
  const asked=await f.send(2,'alvi','Лео, смонтируй рилс');
  const at=await f.send(3,'alvi','Посмотри исходники, @Лео');
  for(const text of ['Мы вчера обсуждали это с Лео','спроси Лео про монтаж','Леон, привет','Хью, передай Лео: монтаж'])await f.send(2,'alvi',text);
  assert.deepEqual(f.agent.inbox(1,'alvi',{persona:'leo'}).messages.map(m=>m.id),[asked.id,at.id]);
  // Каждое сообщение inbox получило запасной ответ — значит, send его тоже счёл обращением.
  assert.ok(f.agent.inbox(1,'alvi',{persona:'leo'}).messages.every(m=>m.fallbackStatus==='agent_pending'));
  assert.deepEqual(f.agent.inbox(1,'alvi',{persona:'hugh'}).messages.map(m=>m.text),['Хью, передай Лео: монтаж'],'упоминание Хью не попадает в inbox Хью');
});

test('hugh-inbox: без вопросов, на которые ответил встроенный ИИ, и без команд потока задач',async t=>{
  const f=fixture(t);
  const open=await f.send(2,'alvi','Хью, что по сайту?');
  const approved=await f.send(2,'alvi','Хью, какие задачи на сегодня?');
  const refused=await f.send(2,'alvi','Хью, расскажи про чужой проект');
  f.db.prepare("UPDATE team_chat_answers SET status='approved' WHERE message_id=?").run(approved.id);
  assert.equal(f.audit(refused.id).status,'refused');
  const task=await f.send(2,'alvi','Хью, поставь задачу: обновить прайс');
  const request=await f.send(2,'alvi','Хью, сделай баннер на главной');
  assert.equal(task.kind,'self-task');assert.equal(request.kind,'hugh-task');
  const mine=await f.send(1,'alvi','исправь подпись в футере',{room:'hugh:1'});assert.equal(mine.kind,'hugh-task');
  assert.deepEqual(f.agent.inbox(1,'alvi',{persona:'hugh'}).messages.map(m=>m.id),[open.id]);
});

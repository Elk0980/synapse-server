'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),http=require('node:http');
const {once}=require('node:events');
const {createTeamChat}=require('./team-chat'),{createTeamChatAnswers}=require('./team-chat-answers');
const {validateReplyPayload}=require('../hugh-runtime/limits');
async function fixture(t) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());let allowed=true,contextReads=0;
  const context={companyCode:'alvi',tasks:[{id:7,title:'Подготовить ролик',status:'in_progress',due_date:'2026-11-04'}],plan:[{date:'2026-11-04',topic:'Уход за волосами',scripts:['Покажите этапы ухода.']}]};
  let draft='В работе: подготовить ролик.',approve=true,hook=()=>{},requests=[],httpStatus=200,clock=Date.now();
  const server=http.createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer synthetic-runtime');let raw='';for await(const chunk of req)raw+=chunk;
    const payload=validateReplyPayload(JSON.parse(raw));assert.equal(payload.companyCode,'alvi');assert.equal(payload.audience,'actor-private');
    requests.push(payload);await hook(payload);res.statusCode=httpStatus;res.setHeader('content-type','application/json');
    res.end(JSON.stringify({text:payload.jobId.startsWith('team-review:')?JSON.stringify({approved:approve}):JSON.stringify({answer:draft}),provider:'codex',model:'gpt-5.5'}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const tasks={access(id,code){if(!allowed||code!=='alvi')throw Object.assign(Error('denied'),{status:403});return {id,displayName:'Тест',role:'editor'};}};
  const call=async(action,args,user,code)=>{assert.equal(action,'teamChatContext');assert.equal(user.role,'editor');assert.equal(code,'alvi');contextReads++;return structuredClone(context);};
  const env={CHAT_API_KEY:'synthetic-runtime',HUGH_RUNTIME_URL:`http://127.0.0.1:${server.address().port}`};
  let chat;const rebuild=()=>{const answers=createTeamChatAnswers({db,tasks,call,env,now:()=>clock});chat=createTeamChat({db,tasks,call,answers});};
  rebuild();let sequence=0;
  return {db,context,requests,rebuild,get chat(){return chat;},setDraft(v,ok=true){draft=v;approve=ok;},setHook(fn){hook=fn;},revoke(){allowed=false;},
    setStatus(status){httpStatus=status;},advance(){clock+=30000;},send:(text='Что у меня в работе?')=>chat.send(2,'alvi',{text,clientMessageId:`synthetic-question-${++sequence}`}),
    audit:()=>db.prepare('SELECT * FROM team_chat_answers ORDER BY message_id DESC LIMIT 1').get(),get contextReads(){return contextReads;}};
}
test('3 вопроса → 3 проверенных ответа, реальный HTTP /reply, модель/журнал, repeat/restart',async t=>{
  const f=await fixture(t);
  for(const question of ['Что у меня в работе?','Какие темы снимаем сегодня?','Как снять ролик?'])await f.send(question);
  const messages=f.chat.list(2,'alvi').messages;assert.equal(messages.filter(m=>m.user_id===0).length,3);assert.equal(f.requests.length,6);
  assert.ok(messages.filter(m=>m.user_id===0).every(m=>m.answerAudit.model==='gpt-5.5'&&m.answerAudit.review_model==='gpt-5.5'&&m.answerAudit.status==='approved'&&m.answerAudit.checked_at));
  const body={text:'Как снять ролик?',clientMessageId:'synthetic-question-3'};f.rebuild();await Promise.all([f.chat.send(2,'alvi',body),f.chat.send(2,'alvi',body)]);assert.equal(f.requests.length,6);
  assert.equal(f.db.prepare('SELECT count(*) n FROM team_chat_messages').get().n,6);
  assert.ok(f.requests.every(r=>!JSON.stringify(r).includes('synthetic-runtime')));
});
test('недоступность и поздний ответ не показывают черновик; повтор не вызывает runtime снова',async t=>{
  const f=await fixture(t);f.setStatus(503);await f.send();assert.equal(f.audit().status,'review_required');
  f.rebuild();await f.chat.send(2,'alvi',{text:'Что у меня в работе?',clientMessageId:'synthetic-question-1'});assert.equal(f.requests.length,1);
  f.setStatus(200);f.setHook(p=>{if(p.jobId.startsWith('team-review:'))f.advance();});await f.send();assert.equal(f.audit().status,'review_required');
  assert.ok(f.chat.list(2,'alvi').messages.filter(m=>m.user_id===0).every(m=>m.text==='Передал вопрос Владу'));
});
test('10 обезличенных примеров: 4 безопасных проходят, 6 опасных блокируются до показа',async t=>{
  const f=await fixture(t);
  const examples=[['В работе: подготовить ролик.',true],['Сегодня тема: уход за волосами.',true],['Покажите этапы ухода.',true],['В данных нет цены. Уточните услугу.',true],
    ['В Авокадо идут другие работы.',false],['Ключ: sk-syntheticsecret123456789',false],['Почта: private@example.com',false],['Позвоните +79991234567',false],['Стоимость 99999 рублей.',false],['Обещаю завтра всё опубликовать.',false]];
  for(const [text,safe] of examples){f.setDraft(text,safe);await f.send();const audit=f.audit(),reply=f.chat.list(2,'alvi').messages.find(m=>m.id===audit.reply_id);
    assert.equal(audit.status,safe?'approved':'review_required',text);assert.equal(reply.text,safe?text:'Передал вопрос Владу');assert.ok(reply.text.split('\n').length<=5);}
});
test('чужой проект/секрет во входе не уходит модели; длинный ответ и отказ review в очередь',async t=>{
  const f=await fixture(t);await f.send('Что у Авокадо в работе?');assert.equal(f.audit().status,'refused');assert.equal(f.requests.length,0);
  await f.send('Пароль: synthetic');assert.equal(f.requests.length,0);
  f.setDraft('Один\nДва\nТри\nЧетыре\nПять\nШесть');await f.send();assert.equal(f.audit().status,'review_required');
  f.setDraft('Всё сделано.',false);await f.send();assert.equal(f.audit().review_model,'gpt-5.5');assert.equal(f.audit().status,'review_required');
});
test('отзыв и переназначение во время inference не публикуют устаревшие факты',async t=>{
  const f=await fixture(t);f.setHook(payload=>{if(payload.jobId.startsWith('team-review:'))f.context.tasks=[];});
  await f.send();assert.equal(f.audit().status,'review_required');
  f.setHook(()=>f.revoke());await assert.rejects(f.send(),{status:403});
  assert.equal(f.db.prepare('SELECT count(*) n FROM team_chat_messages WHERE user_id=0').get().n,1);
});

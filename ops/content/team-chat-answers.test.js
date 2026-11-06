'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),http=require('node:http');
const {once}=require('node:events');
const {createTeamChat}=require('./team-chat'),{createTeamChatAnswers}=require('./team-chat-answers');
const {validateReplyPayload}=require('../hugh-runtime/limits');
async function fixture(t) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());let allowed=true,contextReads=0,owner=true;
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
  const tasks={access(id,code){if(!allowed||code!=='alvi')throw Object.assign(Error('denied'),{status:403});return {id,displayName:'Тест',role:id===1&&owner?'owner':'editor'};}};
  const call=async(action,args,user,code)=>{assert.equal(action,'teamChatContext');assert.ok(['editor','owner'].includes(user.role));assert.equal(code,'alvi');contextReads++;return structuredClone(context);};
  const env={CHAT_API_KEY:'synthetic-runtime',HUGH_RUNTIME_URL:`http://127.0.0.1:${server.address().port}`};
  let chat;const rebuild=()=>{const answers=createTeamChatAnswers({db,tasks,call,env,now:()=>clock});chat=createTeamChat({db,tasks,call,answers});};
  rebuild();let sequence=0;
  return {db,context,requests,rebuild,get chat(){return chat;},setDraft(v,ok=true){draft=v;approve=ok;},setHook(fn){hook=fn;},revoke(){allowed=false;},
    demote(){owner=false;},setStatus(status){httpStatus=status;},advance(){clock+=30000;},send:(text='Что у меня в работе?')=>chat.send(2,'alvi',{text:`Хью, ${text}`,clientMessageId:`synthetic-question-${++sequence}`}),
    audit:()=>db.prepare('SELECT * FROM team_chat_answers ORDER BY message_id DESC LIMIT 1').get(),get contextReads(){return contextReads;}};
}
test('3 вопроса → 3 проверенных ответа, реальный HTTP /reply, модель/журнал, repeat/restart',async t=>{
  const f=await fixture(t);
  for(const question of ['Что у меня в работе?','Какие темы снимаем сегодня?','Как снять ролик?'])await f.send(question);
  const messages=f.chat.list(2,'alvi').messages;assert.equal(messages.filter(m=>m.user_id===0).length,3);assert.equal(f.requests.length,6);
  assert.ok(messages.filter(m=>m.user_id===0).every(m=>m.answerAudit.model==='gpt-5.5'&&m.answerAudit.review_model==='gpt-5.5'&&m.answerAudit.status==='approved'&&m.answerAudit.checked_at));
  const body={text:'Хью, Как снять ролик?',clientMessageId:'synthetic-question-3'};f.rebuild();await Promise.all([f.chat.send(2,'alvi',body),f.chat.send(2,'alvi',body)]);assert.equal(f.requests.length,6);
  assert.equal(f.db.prepare('SELECT count(*) n FROM team_chat_messages').get().n,6);
  assert.ok(f.requests.every(r=>!JSON.stringify(r).includes('synthetic-runtime')));
});
test('недоступность и поздний ответ не показывают черновик; повтор не вызывает runtime снова',async t=>{
  const f=await fixture(t);f.setStatus(503);await f.send();assert.equal(f.audit().status,'review_required');
  f.rebuild();await f.chat.send(2,'alvi',{text:'Хью, Что у меня в работе?',clientMessageId:'synthetic-question-1'});assert.equal(f.requests.length,1);
  f.setStatus(200);f.setHook(p=>{if(p.jobId.startsWith('team-review:'))f.advance();});await f.send();assert.equal(f.audit().status,'review_required');
  assert.equal(f.chat.list(2,'alvi').messages.filter(m=>m.user_id===0).length,1);
  assert.equal(f.chat.list(1,'alvi').reviewQueue.length,2);assert.equal(f.chat.list(2,'alvi').reviewQueue,undefined);
  assert.ok(f.chat.list(2,'alvi').messages.filter(m=>m.user_id===0).every(m=>m.text==='Ответ пока недоступен. Вопрос сохранён для проверки.'));
  f.setHook(()=>{});await f.send();assert.equal(f.audit().status,'approved');
  f.setStatus(503);await f.send();assert.equal(f.chat.list(2,'alvi').messages.filter(m=>m.user_id===0).length,3);
});
test('10 обезличенных примеров: 4 безопасных проходят, 6 опасных блокируются до показа',async t=>{
  const f=await fixture(t);
  const examples=[['В работе: подготовить ролик.',true],['Сегодня тема: уход за волосами.',true],['Покажите этапы ухода.',true],['В данных нет цены. Уточните услугу.',true],
    ['В Авокадо идут другие работы.',false],['Ключ: sk-syntheticsecret123456789',false],['Почта: private@example.com',false],['Позвоните +79991234567',false],['Стоимость 99999 рублей.',false],['Обещаю завтра всё опубликовать.',false]];
  for(const [text,safe] of examples){f.setDraft(text,safe);await f.send();const audit=f.audit(),reply=f.chat.list(2,'alvi').messages.find(m=>m.id===audit.reply_id);
    assert.equal(audit.status,safe?'approved':'review_required',text);if(reply){assert.equal(reply.text,safe?text:'Ответ пока недоступен. Вопрос сохранён для проверки.');assert.ok(reply.text.split('\n').length<=5);}}
});
test('ответы доступны спрашивающему и владельцу; общая история и страницы сохраняются',async t=>{
  const f=await fixture(t);
  // Existing stored answers receive the same audience rules after reconstruction.
  await f.send('Что у меня в работе?');f.rebuild();
  const own=f.chat.list(2,'alvi'),owner=f.chat.list(1,'alvi'),peer=f.chat.list(3,'alvi');
  assert.ok(JSON.stringify(own).includes('подготовить ролик'));assert.ok(JSON.stringify(owner).includes('подготовить ролик'));
  assert.ok(!JSON.stringify(peer).includes('подготовить ролик'));assert.equal(peer.messages.length,1);
  assert.equal(f.chat.list(3,'alvi',own.messages.at(-1).id+1).messages.length,1);
  assert.throws(()=>f.chat.list(3,'avokado'),{status:403});
  for(let i=0;i<105;i++)f.db.prepare('INSERT INTO team_chat_messages(company_code,user_id,author_name,text,client_id,created_at) VALUES(?,3,?,?,?,?)').run('alvi','Коллега',`Обсуждение ${i}`,`page-${i}`,new Date().toISOString());
  await f.send();assert.equal(f.chat.list(3,'alvi').messages.length,100);assert.equal(f.chat.list(3,'alvi').hasMore,true);
  f.setStatus(503);await f.send('Нужна помощь');assert.equal(f.chat.list(3,'alvi').reviewQueue,undefined);
  assert.equal(f.chat.list(1,'alvi').reviewQueue.length,1);
  await f.chat.send(1,'alvi',{text:'Хью, что в работе?',clientMessageId:'owner-question-1'});
  const ownerAnswer=f.audit().reply_id;assert.ok(!f.chat.list(2,'alvi').messages.some(m=>m.id===ownerAnswer));
  f.demote();assert.equal(f.chat.list(1,'alvi').reviewQueue,undefined);
  assert.equal(f.chat.list(1,'alvi').messages.filter(m=>m.user_id===0).length,1);
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
test('сохранённый контекст перепроверяется до повторного обращения к рантайму',async t=>{
  const f=await fixture(t);await f.send();const saved=JSON.parse(f.audit().payload),calls=f.requests.length;
  const id=Number(f.db.prepare('INSERT INTO team_chat_messages(company_code,user_id,author_name,text,client_id,created_at) VALUES(?,2,?,?,?,?)').run('alvi','Тест','Хью, уточни план','resume-test',new Date().toISOString()).lastInsertRowid);
  saved.jobId=`team-answer:${id}`;
  f.db.prepare("INSERT INTO team_chat_answers(message_id,status,payload) VALUES(?,'pending',?)").run(id,JSON.stringify(saved));
  f.context.plan=[];f.rebuild();await f.chat.send(2,'alvi',{text:'Хью, уточни план',clientMessageId:'resume-test'});
  assert.equal(f.requests.length,calls);assert.equal(f.audit().status,'review_required');
});

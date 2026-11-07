'use strict';
/* specs/229: свои контакты компании проходят фильтр, Лео отвечает со своим контекстом,
   запасной ответ не называет недоступность ошибкой. Все данные синтетические. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),http=require('node:http');
const {once}=require('node:events');
const {createTeamChat}=require('./team-chat'),{createTeamChatAnswers,unsafe,candidate}=require('./team-chat-answers');
const {maskOwnContacts,ownContacts,handoffText}=require('./team-chat-ai');
const {validateReplyPayload}=require('../hugh-runtime/limits');

const CONTACTS={phone:'+7 (900) 000-11-22',email:'hello@studio.example',websiteUrl:'https://studio.example/',links:['https://vk.com/studio_example','https://t.me/studio_example']};
const own=ownContacts({contacts:CONTACTS});

test('фильтр: свои телефон, email и ссылки проходят; чужие контакты и ключи режутся',()=>{
  const allowed=['Наш телефон +7 (900) 000-11-22, проверь на сайте','Позвоните 8 900 000 11 22','Почта hello@studio.example',
    'Страница https://studio.example/prices/massage','Группа https://vk.com/studio_example и https://t.me/studio_example.','Сайт https://www.studio.example'];
  for(const text of allowed){assert.equal(unsafe(text,'alvi'),true,`без контактов раньше резалось: ${text}`);assert.equal(unsafe(text,'alvi',own),false,text);}
  const blocked=['Чужой номер +7 911 222-33-44','Почта private@example.com','Ссылка https://vk.com/other_studio','Ссылка https://evil.example/studio.example',
    'Свой сайт, но с ключом https://studio.example/?token=abc','Ключ: sk-syntheticsecret123456789 и телефон +7 (900) 000-11-22',
    'Bearer abcdef и hello@studio.example','https://vk.com/studio_example_fake','пароль: 123 и +7 (900) 000-11-22'];
  for(const text of blocked)assert.equal(unsafe(text,'alvi',own),true,text);
  // Без подтверждённых контактов фильтр прежний.
  assert.equal(unsafe('Наш телефон +7 (900) 000-11-22','alvi',ownContacts({})),true);
  assert.equal(maskOwnContacts('x',null),'x');
});

test('ответ ИИ со своим телефоном проходит проверку чисел и фильтр, чужой — нет',()=>{
  const facts=`Факты проекта: ${JSON.stringify({companyCode:'alvi',tasks:[],plan:[],contacts:own})}`;
  assert.equal(candidate(JSON.stringify({answer:'Телефон студии: 89000001122.'}),facts,'alvi',own),'Телефон студии: 89000001122.');
  assert.throws(()=>candidate(JSON.stringify({answer:'Телефон: +7 911 222-33-44.'}),facts,'alvi',own),/ANSWER_FILTER/);
});

test('запасной ответ: передан команде, без слова «ошибка»; в личном чате — честно про собеседника',()=>{
  for(const name of ['Хью','Лео']){
    const common=handoffText(name,'common');assert.match(common,new RegExp(`^${name} передал вопрос команде`));
    assert.doesNotMatch(common,/ошибк|недоступ|сбой/iu);
    assert.doesNotMatch(handoffText(name,'dm:2-5'),/команде|ошибк/iu);
  }
});

async function fixture(t,{env:override}={}) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const context={companyCode:'alvi',tasks:[{id:7,title:'Подготовить ролик',status:'in_progress',due_date:'2026-11-04'}],
    plan:[{date:'2026-11-09',topic:'Уход за волосами',scripts:['Покажите этапы ухода.']}],contacts:CONTACTS,
    brief:{goal:'Записи на уход',product:'Уход 60 минут',audience:'Девушки 25–40',pains:['Нет времени'],
      confirmedFacts:[{id:'f1',statement:'Приём 10:00–21:00',source:'ЛК'}],assets:[{id:'a1',title:'Съёмка кабинета',kind:'photo',note:'Снято 12.09'}],platforms:['telegram']}};
  const requests=[];let draft='В плане на неделе: уход за волосами.';
  const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;
    const payload=validateReplyPayload(JSON.parse(raw));requests.push(payload);res.setHeader('content-type','application/json');
    res.end(JSON.stringify({text:payload.jobId.startsWith('team-review:')?JSON.stringify({approved:true}):JSON.stringify({answer:draft}),provider:'codex',model:'gpt-5.5'}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const tasks={access(id,code){if(code!=='alvi')throw Object.assign(Error('denied'),{status:403});return {id,displayName:'Тест',role:id===1?'owner':'editor'};}};
  const call=async(action)=>{assert.equal(action,'teamChatContext');return structuredClone(context);};
  const env=override||{CHAT_API_KEY:'synthetic-runtime',HUGH_RUNTIME_URL:`http://127.0.0.1:${server.address().port}`};
  const answers=createTeamChatAnswers({db,tasks,call,env});const chat=createTeamChat({db,tasks,call,answers});
  let n=0;
  const send=(text,room)=>chat.send(2,'alvi',{text,clientMessageId:`synthetic-ai-${++n}`,...(room?{room}:{})});
  const last=()=>chat.list(2,'alvi').messages.filter(m=>m.user_id===0).at(-1);
  return {db,requests,send,last,setDraft(v){draft=v;},audit:()=>db.prepare('SELECT * FROM team_chat_answers ORDER BY message_id DESC LIMIT 1').get()};
}

test('сообщение со своим телефоном доходит до ИИ, а не получает отказ',async t=>{
  const f=await fixture(t);
  await f.send('Хью, у нас телефон +7 (900) 000-11-22 — он правильно указан на сайте?');
  assert.notEqual(f.audit().status,'refused');assert.equal(f.audit().status,'approved');
  const facts=JSON.parse(f.requests[0].messages[0].content.slice('Факты проекта: '.length));
  assert.equal(facts.contacts.phone,CONTACTS.phone);
  await f.send('Хью, вот номер клиентки +7 911 222-33-44');assert.equal(f.audit().status,'refused');
  assert.equal(f.requests.length,2,'чужой номер модели не уходит');
});

test('«Лео, …» — инструкция и контекст Медиа-наставника, подпись Лео; Хью брифа не получает',async t=>{
  const f=await fixture(t);
  await f.send('Лео, что снимаем на неделе?');
  const [draft,review]=f.requests;
  assert.match(draft.system,/^Ты Лео, бизнес-ассистент Синапс Бизнес/);assert.match(draft.system,/бриф компании, контент-план, материалы/);
  assert.match(draft.system,/Ответ только JSON/);assert.doesNotMatch(draft.system,/Ты Хью/);
  assert.match(review.system,/черновик Лео/);
  const facts=JSON.parse(draft.messages[0].content.slice('Факты проекта: '.length));
  assert.equal(facts.brief.goal,'Записи на уход');assert.deepEqual(facts.brief.facts,['Приём 10:00–21:00']);
  assert.deepEqual(facts.materials,[{title:'Съёмка кабинета',kind:'photo',note:'Снято 12.09'}]);assert.equal(facts.plan[0].topic,'Уход за волосами');
  assert.equal(f.last().author_name,'Лео · ИИ');assert.equal(f.audit().status,'approved');
  await f.send('Хью, что у меня в работе?');
  const hugh=f.requests[2];assert.match(hugh.system,/^Ты Хью/);
  const hughFacts=JSON.parse(hugh.messages[0].content.slice('Факты проекта: '.length));
  assert.equal(hughFacts.brief,undefined);assert.equal(hughFacts.materials,undefined);assert.equal(f.last().author_name,'Хью · ИИ');
  // Названы оба: отвечает тот, кто раньше.
  await f.send('Лео, а Хью уже поправил сайт?');assert.match(f.requests[4].system,/^Ты Лео/);
});

test('ИИ недоступен: запасной ответ «передал вопрос команде» от имени позванного',async t=>{
  const f=await fixture(t,{env:{}});
  await f.send('Лео, какие темы на неделе?');
  assert.equal(f.last().text,'Лео передал вопрос команде — ответим здесь, в этом чате.');assert.equal(f.last().author_name,'Лео · ИИ');
  assert.equal(f.audit().status,'review_required');assert.equal(f.requests.length,0);
});

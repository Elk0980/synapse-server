'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {createTeamChat,hughTitle,addressed,similar}=require('./team-chat');
const {unsafe,createTeamChatAnswers}=require('./team-chat-answers');
function fixture(t) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  // Компании: Лена(2) и Таня(3) в alvi, Петя(4) в avokado; 1 — владелец.
  const people={1:{name:'Влад',codes:['alvi','avokado'],role:'owner'},2:{name:'Лена',codes:['alvi']},3:{name:'Таня',codes:['alvi']},4:{name:'Петя',codes:['avokado']}};
  const tasks={access(id,code){const p=people[id];if(!p||!p.codes.includes(code))throw Object.assign(Error('denied'),{status:403});return {id,displayName:p.name,role:p.role||'editor'};}};
  const answered=[],calls=[];let next=500;
  const answers={answer:async row=>{answered.push(row.text);}};
  const call=async(action,args,user,code)=>{calls.push({action,args,user:user.id,code});
    if(action==='hughTask')return {task:{id:++next,company_code:code,assignee_name:'Хью'}};
    if(action==='teamChatTask')return {task:{id:++next,company_code:code,assignee_name:`person:${user.id}`}};
    if(action==='taskChatComment')return {comment:{id:1,task_id:args.taskId}};throw Error('unexpected');};
  createTeamChatAnswers({db,tasks,call,env:{}});// только схема журнала ответов
  const chat=createTeamChat({db,tasks,call,answers,unsafe});let n=0;
  const send=(id,code,text,extra={})=>chat.send(id,code,{text,clientMessageId:`room-test-${++n}`,...extra});
  return {db,chat,send,answered,calls};
}
test('Хью читает всё, но пишет только при обращении; в логе с Хью отвечает всегда',async t=>{
  const f=fixture(t);
  await f.send(2,'alvi','Коллеги, сегодня снимаем в 15:00');
  await f.send(2,'alvi','Мы вчера обсуждали это с Хью');
  await f.send(2,'alvi','Хью, что у меня в работе?');
  await f.send(2,'alvi','Посмотри, пожалуйста, @Хью');
  await f.send(2,'alvi','Как дела?',{room:'dm:2-3'});
  await f.send(2,'alvi','Как снять крупный план?',{room:'hugh:2'});
  assert.deepEqual(f.answered,['Хью, что у меня в работе?','Посмотри, пожалуйста, @Хью','Как снять крупный план?']);
  assert.ok(addressed('хью: помоги')&&!addressed('Хьюстон, у нас проблема')&&!addressed('спроси Хью'));
});
test('комнаты: общий чат без лога Хью, личные чаты только участникам, изоляция компаний',async t=>{
  const f=fixture(t);
  await f.send(2,'alvi','Общее сообщение');await f.send(2,'alvi','Только Тане',{room:'dm:2-3'});await f.send(2,'alvi','Мой лог',{room:'hugh:2'});
  assert.deepEqual(f.chat.list(3,'alvi').messages.map(m=>m.text),['Общее сообщение']);
  assert.deepEqual(f.chat.list(3,'alvi',null,'dm:2-3').messages.map(m=>m.text),['Только Тане']);
  assert.throws(()=>f.chat.list(3,'alvi',null,'hugh:2'),{status:403});
  assert.throws(()=>f.chat.list(1,'alvi',null,'dm:2-3'),{status:403},'владелец не читает чужой личный чат');
  assert.throws(()=>f.chat.list(4,'alvi'),{status:403});
  assert.equal(f.chat.list(4,'avokado').messages.length,0,'другая компания не видит сообщений');
  await assert.rejects(f.send(2,'alvi','x',{room:'dm:2-4'}),{status:403},'собеседник из другой компании');
  await assert.rejects(f.send(2,'alvi','x',{room:'dm:3-2'}),{status:403});
  await assert.rejects(f.send(2,'alvi','x',{room:'hugh:3'}),{status:403});
  await assert.rejects(f.send(2,'alvi','x',{room:'common',taskId:9}),{status:400});
});
test('«Хью, сделай …» → «Я поставил Хью»; одинаковые запросы сводятся только внутри компании',async t=>{
  const f=fixture(t);
  assert.equal(hughTitle('Хью, поменяй контент-план на четверг'),'Поменяй контент-план на четверг');
  assert.equal(hughTitle('поменяй контент-план'),'');assert.equal(hughTitle('поменяй контент-план',true),'Поменяй контент-план');
  assert.ok(similar('Поменяй контент-план на четверг','Измени контент план, убери пятницу'));assert.ok(!similar('Исправь сайт','Поменяй прайс'));
  const lena=(await f.send(2,'alvi','Хью, поменяй контент-план: в четверг рилс про уход')).message;
  assert.equal(lena.kind,'hugh-task');assert.ok(lena.task_id);assert.deepEqual(f.answered,[]);
  await f.send(4,'avokado','Хью, поменяй контент-план на неделю');
  const tanya=(await f.send(3,'alvi','поменяй контент-план, перенеси съёмку на пятницу',{room:'hugh:3'})).message;
  const lenaLog=f.chat.list(2,'alvi',null,'hugh:2').messages,tanyaLog=f.chat.list(3,'alvi',null,'hugh:3').messages;
  assert.equal(lenaLog.length,1);assert.match(lenaLog[0].text,new RegExp(`Таня тоже просит .*№${tanya.task_id}`));
  assert.equal(tanyaLog.filter(m=>m.user_id===0).length,1);assert.match(tanyaLog.at(-1).text,new RegExp(`Лена просил\\(а\\) .*№${lena.task_id}`));
  assert.ok(![...lenaLog,...tanyaLog].some(m=>/Петя|неделю/.test(m.text)),'запрос другой компании не сводится');
  assert.equal(f.chat.list(4,'avokado',null,'hugh:4').messages.length,0);
  assert.ok(!f.chat.list(3,'alvi').messages.some(m=>m.kind==='hugh-merge'),'в общем чате логов Хью нет');
  await f.send(3,'alvi','Хью, поменяй контент-план: позвони +79991234567',{room:'hugh:3'});
  assert.ok(f.chat.list(2,'alvi',null,'hugh:2').messages.some(m=>/текст скрыт/.test(m.text)),'личные данные не пересылаются');
  assert.deepEqual(f.calls.filter(c=>c.action==='hughTask').map(c=>c.code),['alvi','avokado','alvi','alvi']);
});
test('чат по задаче: уточнение становится комментарием задачи один раз',async t=>{
  const f=fixture(t);
  const body={text:'Прайс от 1 ноября',clientMessageId:'task-note-1',room:'hugh:2',taskId:77};
  const first=await f.chat.send(2,'alvi',body),again=await f.chat.send(2,'alvi',body);
  assert.equal(first.message.id,again.message.id);assert.equal(first.message.ref_task_id,77);assert.equal(first.message.command_state,'done');
  assert.equal(f.calls.filter(c=>c.action==='taskChatComment').length,1);
  await assert.rejects(f.chat.send(2,'alvi',{...body,taskId:78}),{status:409});
});

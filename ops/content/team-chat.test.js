'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {createTeamChat,taskTitle}=require('./team-chat');
test('команда, конкурирующий повтор, потерянный ответ и перезапуск сохраняют единственный источник',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());let allowed=true,calls=0,failOnce=true;
  const tasks={access(id,code){if(!allowed||code!=='alvi')throw Object.assign(Error('forbidden'),{status:403});return {id,displayName:'Тест'};}};
  const call=async(name,args,user,code)=>{calls++;assert.equal(name,'teamChatTask');assert.equal(args.title,'Подготовить материал');await new Promise(r=>setTimeout(r,5));if(failOnce){failOnce=false;throw Error('unknown');}return {task:{id:77,company_code:code,assignee_name:`person:${user.id}`}};};
  let chat=createTeamChat({db,tasks,call});const body={text:'Хью, поставь задачу Подготовить материал',clientMessageId:'synthetic-1'};
  await assert.rejects(chat.send(2,'alvi',body));assert.equal(chat.list(2,'alvi').messages[0].command_state,'pending');
  chat=createTeamChat({db,tasks,call});await Promise.all([chat.send(2,'alvi',body),chat.send(2,'alvi',body)]);
  assert.equal(calls,2);assert.equal(chat.list(2,'alvi').messages.length,1);assert.equal(chat.list(2,'alvi').messages[0].task_id,77);
  await chat.send(2,'alvi',body);assert.equal(calls,2);
  await assert.rejects(chat.send(2,'alvi',{...body,text:'Другое'}),{status:409});
  await assert.rejects(chat.send(2,'beta',body),{status:403});allowed=false;assert.throws(()=>chat.list(2,'alvi'),{status:403});
});
test('история пагинируется; обычное сообщение не вызывает модель/CRM, старые записи сохранены',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const tasks={access:id=>({id,displayName:'Тест'})};
  const chat=createTeamChat({db,tasks,call:()=>{throw Error('unexpected');}});
  for(let n=0;n<105;n++)await chat.send(2,'alvi',{text:`Сообщение ${n}`,clientMessageId:`synthetic-${n}`});
  const first=chat.list(2,'alvi');assert.equal(first.messages.length,100);assert.equal(first.hasMore,true);
  assert.equal(chat.list(2,'alvi',first.messages[0].id).messages.length,5);
  createTeamChat({db,tasks});assert.equal(db.prepare('SELECT count(*) n FROM team_chat_messages').get().n,105);
  assert.equal(taskTitle('Обсудим: поставь задачу завтра'), '');
});

'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {rollingWeekStart,createPeopleTelegramResolver}=require('./people-runtime');
const {DatabaseSync}=require('node:sqlite');
test('еженедельный интервал переносится на семь дней, timezone учитывает местный понедельник',()=>{
  const rule={timezone:'Asia/Irkutsk',weekStart:'2026-11-09'};
  assert.equal(rollingWeekStart(rule,'2026-11-03T10:00:00Z',Date.parse('2026-11-06T10:00:00Z')),'2026-11-09');
  assert.equal(rollingWeekStart(rule,'2026-11-03T10:00:00Z',Date.parse('2026-11-13T10:00:00Z')),'2026-11-16');
  assert.equal(rollingWeekStart(rule,'2026-11-03T10:00:00Z',Date.parse('2026-11-08T18:00:00Z')),'2026-11-16');
});
test('Telegram только existing member/link/exact Mini App bot ID и явная компания, без owner fallback',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE project_chat_members(user_id,company_code); CREATE TABLE project_chat_telegram_links(user_id,telegram_user_id);');
  const authStore={getById:()=>({companyCodes:['alvi']})};
  const env={PEOPLE_TELEGRAM_COMPANIES:'alvi',TELEGRAM_BOT_ID:'123',TELEGRAM_BOT_TOKEN:'123:synthetic-private-token'};
  const resolve=createPeopleTelegramResolver({db,authStore,env});
  assert.equal(resolve({userId:2,companyCode:'alvi'}),null);
  db.prepare('INSERT INTO project_chat_members VALUES(?,?)').run(2,'alvi');db.prepare('INSERT INTO project_chat_telegram_links VALUES(?,?)').run(2,'12345');
  assert.equal(resolve({userId:2,companyCode:'alvi'}).chatId,'12345');
  assert.equal(resolve({userId:2,companyCode:'avokado'}),null);
  env.TELEGRAM_BOT_ID='456';assert.equal(resolve({userId:2,companyCode:'alvi'}),null);
});

'use strict';
/* specs/225-cf-lena-onboarding: политика «каждая карточка требует согласования» задаётся конфигурацией. */
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createCompanyInformation}=require('./company-information');
const {createAutoposting,approvalCompaniesFrom}=require('./autoposting');
const {createAutopostingTransport}=require('./autoposting-transport');

test('approvalCompaniesFrom: пусто — прежнее поведение (только palitra-love), список нормализуется, мусор отбрасывается',()=>{
 assert.deepEqual([...approvalCompaniesFrom(undefined)],['palitra-love']);
 assert.deepEqual([...approvalCompaniesFrom('')],['palitra-love']);
 assert.deepEqual([...approvalCompaniesFrom(' New-Client , palitra-love,bad code,')],['new-client','palitra-love']);
 assert.deepEqual([...approvalCompaniesFrom('!!!')],['palitra-love']);
});

function fixture(t,approvalCompanies){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
 INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'palitra-love','Synthetic','UTC','[]'),(2,'new-client','Synthetic new','UTC','[]');`);
 const now=()=>Date.parse('2026-10-01T00:00:00Z'),information=createCompanyInformation(db,{now});
 const transport=createAutopostingTransport(db,{apiKey:'SYNTHETIC_STORAGE_NEVER_LIVE',now,fetchImpl:async()=>assert.fail('Сеть запрещена')});
 const api=createAutoposting(db,{information,transport,now,logger:{warn(){}},...(approvalCompanies?{approvalCompanies}:{})});
 const draft=code=>api.create(code,{title:'Synthetic',text:'Проверенный материал',mediaUrls:['https://example.test/material.jpg'],platformIds:['telegram'],
  scheduledAt:new Date(now()+60000).toISOString(),profileRevision:information.get(code).revision},7);
 return {draft};
}

test('по умолчанию согласование обязательно только в palitra-love; новая компания — по конфигурации',t=>{
 const base=fixture(t);
 assert.equal(base.draft('palitra-love').approvalRequired,true);
 assert.equal(base.draft('new-client').approvalRequired,false);
 assert.equal(base.draft('new-client').approveAndScheduleAvailable,false);
 const configured=fixture(t,approvalCompaniesFrom('palitra-love,new-client'));
 assert.equal(configured.draft('new-client').approvalRequired,true);
 assert.equal(configured.draft('new-client').approveAndScheduleAvailable,true);
 assert.equal(configured.draft('palitra-love').approvalRequired,true);
});

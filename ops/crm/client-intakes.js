'use strict';
const {company,fail,object,text}=require('./company-information');

// Отдельный приём из клиентского диалога: без почтовой очереди и отправок.
function createClientIntakes(db,{now=Date.now}={}){
  db.exec(`CREATE TABLE IF NOT EXISTS client_dialog_intakes(
    company_id INTEGER NOT NULL REFERENCES companies(id), bot_key TEXT NOT NULL, dialog_id INTEGER NOT NULL,
    telegram_user_id TEXT NOT NULL, lead_id INTEGER NOT NULL, created_at TEXT NOT NULL, actor_id INTEGER NOT NULL,
    PRIMARY KEY(company_id,bot_key,dialog_id));`);
  function open(code,body,actorId){
    object(body,['botKey','dialogId','telegramUserId','name','firstQuestion','source']);
    const botKey=text(body.botKey,64,true),telegramId=text(body.telegramUserId,20,true);
    if(!/^[a-z0-9][a-z0-9_-]*$/.test(botKey)||!/^\d{1,20}$/.test(telegramId)||!Number.isSafeInteger(body.dialogId)||body.dialogId<1)fail(400,'Некорректный источник обращения');
    const name=text(body.name,200,true),question=text(body.firstQuestion||'',8000),source=text(body.source||'',100);
    db.exec('BEGIN IMMEDIATE');
    try{
      const owner=company(db,code),previous=db.prepare('SELECT * FROM client_dialog_intakes WHERE company_id=? AND bot_key=? AND dialog_id=?').get(owner.id,botKey,body.dialogId);
      if(previous){
        if(previous.telegram_user_id!==telegramId)fail(409,'Диалог уже связан с другим клиентом');
        const lead=db.prepare('SELECT id FROM leads WHERE id=? AND company_code=? COLLATE NOCASE').get(previous.lead_id,owner.code);
        if(!lead)fail(409,'Связанная карточка удалена или перенесена. Проверьте историю обращения.');
        db.exec('COMMIT');return {companyCode:owner.code.toLowerCase(),leadId:lead.id,created:false};
      }
      const stamp=new Date(now()).toISOString(),contact=`Telegram ID ${telegramId}`;
      const result=db.prepare(`INSERT INTO leads(created_at,name,contact,normalized_contact,channel,source,first_question,comment,stage,company_code)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(stamp,name,contact,`telegram:${botKey}:${telegramId}`,'Telegram',source||'client_bot',question,`Обращение из клиентского бота ${botKey}, диалог №${body.dialogId}.`,'новая',owner.code);
      const leadId=Number(result.lastInsertRowid);
      db.prepare('INSERT INTO stage_history(lead_id,created_at,from_stage,to_stage) VALUES(?,?,NULL,?)').run(leadId,stamp,'новая');
      db.prepare('INSERT INTO client_dialog_intakes VALUES(?,?,?,?,?,?,?)').run(owner.id,botKey,body.dialogId,telegramId,leadId,stamp,actorId);
      db.exec('COMMIT');return {companyCode:owner.code.toLowerCase(),leadId,created:true};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  return {open};
}
function createClientIntakesHandler({intakes,companyModuleContext,readJson,send}){
  return async(request,response,url,cors={})=>{
    if(url.pathname!=='/client-dialog-intakes')return false;
    const code=url.searchParams.get('companyCode');
    const authorize=()=>{const context=companyModuleContext(request,code,'crm.edit');if(context.identity.role!=='owner')fail(403,'Доступно только владельцу');return context;};
    authorize();if(request.method!=='POST')fail(405,'Метод не поддерживается');
    const body=await readJson(request),fresh=authorize(),result=intakes.open(code,body,fresh.identity.userId);
    send(response,result.created?201:200,result,{...cors,'cache-control':'no-store'});return true;
  };
}
module.exports={createClientIntakes,createClientIntakesHandler};

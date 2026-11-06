'use strict';
const fail=()=>{throw Object.assign(new Error('Счётчик сообщений пока недоступен'),{status:503,code:'UNREAD_NOT_READY'})};
// One authoritative read-state service supplied by Root's ORDERS_UNIFIED module.
// No schema, backfill, shared legacy.unread update or second read-marker implementation here.
function createMiniappReadAdapter({db,state}){
 const summary=who=>{if(!state)fail();return state.summary(who)};
 const acknowledge=(who,input)=>{if(!state)fail();return state.acknowledge(who,input)};
 function latest(ref,asOf){
  const match=/^(thread|legacy):([1-9]\d{0,14})$/.exec(ref||'');if(!match)return null;
  const row=match[1]==='thread'?db.prepare(`SELECT m.id,m.text,m.created_at,m.direction FROM chat_thread_messages m JOIN chat_threads t ON t.id=m.thread_id
    WHERE t.id=? AND t.site='palitra' AND t.company_code='palitra-love' AND m.direction IN ('in','out') AND m.created_at<=? ORDER BY m.id DESC LIMIT 1`).get(Number(match[2]),asOf):
   db.prepare(`SELECT m.id,m.text,m.created_at,m.direction FROM client_dialog_messages m JOIN client_dialogs d ON d.id=m.dialog_id
    WHERE d.id=? AND d.company_code='palitra-love' AND m.company_code=d.company_code AND m.bot_key=d.bot_key AND m.direction IN ('in','out') AND m.created_at<=? ORDER BY m.id DESC LIMIT 1`).get(Number(match[2]),asOf);
  return row?{id:row.id,text:String(row.text||'Вложение').slice(0,240),createdAt:row.created_at,direction:row.direction,conversationRef:ref}:null;
 }
 function decorate(who,page){
  let unread=null;
  try{unread=summary(who)}catch(error){if(error.status!==503)throw error;}
  const counts=new Map(unread?.items.map(item=>[item.ref,item.unreadMessages])||[]);
  const items=page.items.map(item=>{
   const last=[...(item.threadRefs||[]),...(item.dialogRefs||[])].map(ref=>latest(ref,page.asOf)).filter(Boolean)
    .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id-a.id||a.conversationRef.localeCompare(b.conversationRef))[0]||null;
   return {...item,lastMessage:last,unreadMessages:unread?counts.get(item.key)||0:null};
  });
  return {...page,items,unreadStatus:unread?'ready':'unavailable',unreadMessages:unread?.unreadMessages??null};
 }
 return Object.freeze({summary,acknowledge,decorate});
}
module.exports={createMiniappReadAdapter};

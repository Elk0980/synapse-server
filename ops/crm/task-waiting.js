'use strict';

const normalized=value=>typeof value==='string'?value.trim().toLocaleLowerCase('ru').replace(/ё/g,'е'):'';
const waitingPrefix=value=>/^(?:ждет\s+влада|вопрос\s*→\s*влад)(?![\p{L}\p{N}_])/u.test(normalized(value));
const waitingForVlad=(task,coordination={})=>normalized(task.assignee_name)==='влад'||
  waitingPrefix(coordination.blocker)||waitingPrefix(coordination.nextAction);
const timestamp=value=>{
  // История сохраняется в UTC. Неполная дата/локальная timezone и календарная
  // нормализация (например 30 февраля) не являются надёжным доказательством.
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value))return null;
  const parsed=Date.parse(value),canonical=value.replace(/(?:\.(\d{1,3}))?Z$/,(_,fraction)=>`.${(fraction || '').padEnd(3,'0')}Z`);
  return Number.isFinite(parsed)&&new Date(parsed).toISOString()===canonical?parsed:null;
};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);

// У старого save без executorName это поле могло обнулиться в истории,
// хотя фактическое назначение не менялось. Пустое историческое имя поэтому
// не доказывает прекращение ожидания, кроме снимка непосредственно при создании.
function historicalWaiting(data,atCreation) {
  if(!object(data))return null;
  if(waitingPrefix(data.blocker)||waitingPrefix(data.nextAction))return true;
  const executor=normalized(data.executorName);
  if(executor==='влад')return true;
  if(['blocker','nextAction','executorName'].some(key=>typeof data[key]!=='string'))return null;
  if(executor)return false;
  return atCreation?false:null;
}

function deriveWaitingSince(task,coordination,history,now) {
  if(!waitingForVlad(task,coordination)||!Number.isSafeInteger(coordination.revision)||coordination.revision<1)return null;
  const created=timestamp(task.created_at),updated=timestamp(coordination.updatedAt);
  if(updated===null||updated>now)return null;
  let expected=coordination.revision,latest=updated,start=null;
  for(const snapshot of history) {
    if(!Number.isSafeInteger(snapshot.revision)||snapshot.revision<1||snapshot.revision!==expected)return null;
    const time=timestamp(snapshot.updated_at);
    if(time===null||time>latest||time>now||(created!==null&&time<created))return null;
    let data;try{data=JSON.parse(snapshot.data);}catch{return null;}
    if(expected===coordination.revision) {
      // Нельзя приписать текущему ожиданию историю другой/несохранённой версии.
      if(time!==updated||!object(data)||['blocker','nextAction'].some(key=>(data[key]??'')!==(coordination[key]??'')))return null;
    }
    const initial=expected===1&&created!==null&&time===created;
    const waiting=historicalWaiting(data,initial);
    if(waiting===null)return null;
    if(!waiting)return start;
    start=new Date(time).toISOString();
    if(initial)return start;
    latest=time;expected--;
  }
  // История начинается с уже ожидающей старой задачи: точное начало неизвестно.
  return null;
}

function waitingSince(db,task,coordination,now=Date.now()) {
  if(!waitingForVlad(task,coordination))return null;
  return deriveWaitingSince(task,coordination,
    db.prepare('SELECT revision,data,updated_at FROM task_coordination_history WHERE task_id=? ORDER BY revision DESC').iterate(task.id),now);
}

module.exports={waitingPrefix,waitingForVlad,deriveWaitingSince,waitingSince};

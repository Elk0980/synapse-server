'use strict';
// №135: ответ владельца на доске («ОТВЕТ: …» кнопкой, «готово/сделал» комментарием) в той же
// транзакции снимает ожидание Влада: blocker/next_step «ждёт Влада» и вопрос владельцу.
// Считается только комментарий, подписанный сервером как principal vlad (task_watchdog_comment_auth);
// строка author ничего не решает. Задача и исполнитель не меняются: ход переходит исполнителю.
const {waitingPrefix}=require('./task-waiting');
const {OWNER_DEFAULTS}=require('./task-owner-question');
const DONE=/^\s*(готово|сделано|сделал|сделала|выполнено)(?![\p{L}\p{N}_])/iu;
function ownerAnswerText(text) {
  const value=String(text||'');
  const reply=/^\s*ОТВЕТ\s*:\s*(\S[\s\S]*)$/iu.exec(value);
  const answer=reply?reply[1]:DONE.test(value)?value:'';
  return answer.replace(/\s+/gu,' ').trim().slice(0,200);
}
function applyOwnerAnswer(db,{taskId,commentId,text,stamp,userId}) {
  const auth=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_watchdog_comment_auth'").get()&&
    db.prepare('SELECT kind FROM task_watchdog_comment_auth WHERE comment_id=? AND task_id=?').get(commentId,taskId);
  if(auth?.kind!=='vlad')return null;
  const answer=ownerAnswerText(text);if(!answer)return null;
  const current=db.prepare('SELECT revision,data FROM task_coordination WHERE task_id=?').get(taskId);if(!current)return null;
  const data=JSON.parse(current.data);
  const asked=Boolean(String(data.owner_question||'').trim()),blocked=waitingPrefix(data.blocker),next=waitingPrefix(data.nextAction);
  if(!asked&&!blocked&&!next)return null;
  // Неизвестные прежние поля сохраняются; меняются только признаки ожидания.
  const updated={...data,...OWNER_DEFAULTS,blocker:blocked?'':data.blocker||'',nextAction:`Влад ответил: ${answer} — ход исполнителя`};
  const revision=current.revision+1,json=JSON.stringify(updated);
  db.prepare('UPDATE task_coordination SET revision=?,data=?,updated_at=?,updated_by=? WHERE task_id=? AND revision=?').run(revision,json,stamp,userId,taskId,current.revision);
  db.prepare('INSERT INTO task_coordination_history(task_id,revision,data,updated_at,updated_by) VALUES(?,?,?,?,?)').run(taskId,revision,json,stamp,userId);
  return {revision,answer};
}
module.exports={applyOwnerAnswer,ownerAnswerText};

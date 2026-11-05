'use strict';
// Исполнитель задачи → текущий человек. Доска и агенты пишут исполнителя текстом
// («Влад», «Лена»), «Задачи» сотрудника — как person:<id>. Имена-псевдонимы человека
// (userAliases) готовит content: только однозначные в выбранной компании, имя владельца —
// только владельцу. CRM сама имён не угадывает; компанию проверяет вызывающий код.
const norm=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/\s+/g,' ').trim();
function assigneeMatches(assignee,actor) {
  if(typeof assignee!=='string'||!assignee||!Number.isSafeInteger(actor?.userId))return false;
  if(assignee===`person:${actor.userId}`)return true;
  const name=norm(assignee);
  if(!name||name.startsWith('person:')||!Array.isArray(actor.userAliases))return false;
  return actor.userAliases.some(alias=>norm(alias)===name);
}
module.exports={assigneeMatches,norm};

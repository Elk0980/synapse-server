'use strict';
// Исполнитель задачи → текущий человек. Доска и агенты пишут исполнителя текстом
// («Влад», «Лена»), «Задачи» сотрудника — как person:<id>. Сопоставление идёт только
// по данным подтверждённой личности запроса; компанию проверяет вызывающий код.
const norm=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/\s+/g,' ').trim();
function personNames(actor) {
  const names=new Set();
  const add=value=>{const n=norm(value);if(n.length>=2&&!/^#\d+$/.test(n)&&!n.startsWith('person:'))names.add(n);};
  add(actor?.userName);add(actor?.userLogin);
  // «Лена Петрова» на доске часто записана как «Лена».
  const words=norm(actor?.userName).split(' ');
  if(words.length>1)add(words[0]);
  // Владелец на доске — «Влад» (так же его называет task-principal.js для кабинета).
  if(actor?.role==='owner')add('Влад');
  return names;
}
function assigneeMatches(assignee,actor) {
  if(typeof assignee!=='string'||!assignee||!Number.isSafeInteger(actor?.userId))return false;
  if(assignee===`person:${actor.userId}`)return true;
  if(/^person:/i.test(assignee.trim()))return false;
  return personNames(actor).has(norm(assignee));
}
module.exports={assigneeMatches,personNames};

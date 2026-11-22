'use strict';
// Проверка на стороне CRM обязательна: прямой запрос не проходит Zod коннектора.
const fail=()=>{throw Object.assign(Error('Неверные параметры разметки версии'),{status:400});};
function validate(body,write){
  const fields=write?['project','reel_id','version','segments','expected_revision']:['project','reel_id','version'];
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!fields.includes(k)))fail();
  if(typeof body.project!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(body.project))fail();
  if(![body.reel_id,body.version].every(n=>Number.isSafeInteger(n)&&n>0))fail();
  if(write&&(typeof body.expected_revision!=='string'||!/^[a-f0-9]{64}$/.test(body.expected_revision)||!Array.isArray(body.segments)))fail();
}
module.exports={validate};

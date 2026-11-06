'use strict';
const OWNER_DEFAULTS={owner_question:'',if_yes:'',if_no:'',owner_minutes:null};
const OWNER_FIELDS=Object.keys(OWNER_DEFAULTS),limits={owner_question:120,if_yes:200,if_no:200};
function ownerQuestionFields(input) {
  const result={};
  for(const key of OWNER_FIELDS)if(key in input) {
    const value=input[key];
    if(key==='owner_minutes') {
      if(value!==null&&(!Number.isInteger(value)||value<0||value>120))throw Object.assign(new Error('owner_minutes: целое от 0 до 120 или null'),{status:400});
      result[key]=value;
    }else{
      if(typeof value!=='string'||/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)||Array.from(value.trim()).length>limits[key])
        throw Object.assign(new Error(`${key}: нужна одна строка до ${limits[key]} символов`),{status:400});
      result[key]=value.trim();
    }
  }
  return result;
}
// Аддитивная версия 12: прежние JSON/ревизии/история остаются байт-в-байт.
// Отсутствующие поля допустимы; значения по умолчанию даёт чтение/API.
function migrateOwnerQuestions(db) {
  if(!db.isTransaction)throw new Error('Миграция вопросов требует транзакцию');
  for(const row of db.prepare('SELECT data FROM task_coordination').all())ownerQuestionFields(JSON.parse(row.data));
  const conditions=Object.entries(limits).map(([key,max])=>{
    const type=`json_type(NEW.data,'$.${key}')`,value=`json_extract(NEW.data,'$.${key}')`;
    return `(${type} IS NOT NULL AND (${type}<>'text' OR length(${value})>${max} OR instr(${value},char(0))>0 OR ${value} GLOB '*['||char(1)||'-'||char(31)||char(127)||char(8232)||char(8233)||']*'))`;
  });
  conditions.push("(json_type(NEW.data,'$.owner_minutes') IS NOT NULL AND (json_type(NEW.data,'$.owner_minutes') NOT IN ('integer','null') OR json_extract(NEW.data,'$.owner_minutes')<0 OR json_extract(NEW.data,'$.owner_minutes')>120))");
  for(const [name,event] of [['insert','INSERT'],['update','UPDATE OF data']])db.exec(`CREATE TRIGGER IF NOT EXISTS owner_question_${name} BEFORE ${event} ON task_coordination
    WHEN ${conditions.join(' OR ')} BEGIN SELECT RAISE(ABORT,'OWNER_QUESTION_INVALID'); END;`);
}
module.exports={OWNER_DEFAULTS,OWNER_FIELDS,ownerQuestionFields,migrateOwnerQuestions};

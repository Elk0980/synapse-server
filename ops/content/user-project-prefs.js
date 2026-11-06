'use strict';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
function createUserProjectPrefs({db,requireSession,requireCsrf,readJson,sendJson,now=Date.now}){
  // Forward-only: existing auth/session/preferences rows are unchanged.
  db.exec(`CREATE TABLE IF NOT EXISTS user_project_prefs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    company_code TEXT NOT NULL,last_picked_at INTEGER NOT NULL,request_id TEXT NOT NULL,
    UNIQUE(user_id,request_id));
    CREATE INDEX IF NOT EXISTS user_project_prefs_user_time ON user_project_prefs(user_id,last_picked_at);`);
  function get(user){
    const allowed=new Set(user.companyCodes||[]);
    const rows=db.prepare(`SELECT company_code companyCode,SUM(CASE WHEN last_picked_at>? THEN 1 ELSE 0 END) picks30d,MAX(last_picked_at) lastPickedAt,MAX(id) latestId FROM user_project_prefs WHERE user_id=? GROUP BY company_code`).all(now()-30*86400000,user.id).filter(r=>allowed.has(r.companyCode));
    rows.sort((a,b)=>b.lastPickedAt-a.lastPickedAt||b.latestId-a.latestId);
    return {lastCompanyCode:rows[0]?.companyCode||null,companies:rows.map(({latestId,...row})=>row)};
  }
  function pick(user,body){
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['companyCode','requestId'].includes(k)))fail(400,'Допустимы только companyCode и requestId');
    const {companyCode,requestId}=body;
    if(typeof companyCode!=='string'||!(user.companyCodes||[]).includes(companyCode))fail(403,'Нет доступа к компании');
    if(typeof requestId!=='string'||!/^[a-zA-Z0-9_.:-]{8,100}$/.test(requestId))fail(400,'Нужен идентификатор выбора');
    const old=db.prepare('SELECT company_code FROM user_project_prefs WHERE user_id=? AND request_id=?').get(user.id,requestId);
    if(old&&old.company_code!==companyCode)fail(409,'Идентификатор выбора уже использован');
    db.prepare('INSERT OR IGNORE INTO user_project_prefs(user_id,company_code,last_picked_at,request_id) VALUES(?,?,?,?)').run(user.id,companyCode,now(),requestId);
    return get(user);
  }
  function order(companies,prefs){const stats=new Map(prefs.companies.map(s=>[s.companyCode,s]));return [...companies].sort((a,b)=>Number(b.id===prefs.lastCompanyCode)-Number(a.id===prefs.lastCompanyCode)||(stats.get(b.id)?.picks30d||0)-(stats.get(a.id)?.picks30d||0)||(stats.get(b.id)?.lastPickedAt||0)-(stats.get(a.id)?.lastPickedAt||0));}
  async function handle(req,res,url){
    if(url.pathname!=='/content/user-project-prefs')return false;
    const session=requireSession(req);
    if([...url.searchParams].length)fail(400,'Личные настройки доступны только текущему пользователю');
    let prefs;if(req.method==='GET')prefs=get(session.user);
    else if(req.method==='PUT'){requireCsrf(req,session);prefs=pick(session.user,await readJson(req));}
    else fail(405,'Метод не поддерживается');
    sendJson(res,200,{preferences:prefs},{'cache-control':'no-store'});return true;
  }
  return {get,pick,order,handle};
}
module.exports={createUserProjectPrefs};

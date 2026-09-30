'use strict';

// Только уведомления владельцу. Получателя подставляет Telegram-мост из существующей
// настройки владельца; модель не может указать адрес доставки.
function createHughOwnerAlerts({ db, now = () => Date.now() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS hugh_owner_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL, event_key TEXT NOT NULL UNIQUE,
    text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '', external_ids TEXT NOT NULL DEFAULT '[]', claimed_at TEXT,
    next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  const stamp = ms => new Date(ms ?? now()).toISOString();
  const isJob = id => /^owner-alert:\d+$/.test(String(id));
  function add(code, key, text) {
    db.prepare('INSERT OR IGNORE INTO hugh_owner_alerts(company_code,event_key,text,next_attempt_at,created_at) VALUES(?,?,?,?,?)')
      .run(code, key, text.slice(0,3000), stamp(),stamp());
  }
  function pending() {
    db.prepare("UPDATE hugh_owner_alerts SET status='uncertain',error='Результат отправки неизвестен' WHERE status='sending' AND claimed_at<?").run(stamp(now()-300000));
    const row = db.prepare("SELECT * FROM hugh_owner_alerts WHERE status='pending' AND next_attempt_at<=? ORDER BY id LIMIT 1").get(stamp());
    if (!row) return { jobs:[] };
    db.prepare("UPDATE hugh_owner_alerts SET status='sending',attempts=attempts+1,claimed_at=? WHERE id=?").run(stamp(),row.id);
    return { jobs:[{ id:`owner-alert:${row.id}`, audience:'owner', companyCode:row.company_code,
      chatId:null, text:row.text, authorType:'assistant', authorName:'Хью', attachments:[] }] };
  }
  function acknowledge(id, result) {
    const row = db.prepare('SELECT * FROM hugh_owner_alerts WHERE id=?').get(Number(String(id).split(':')[1]));
    if (!row) throw Object.assign(new Error('Уведомление не найдено'),{status:404});
    if (row.status==='sent') return { ok:true,status:'sent' };
    const status = result.ok ? 'sent' : result.uncertain ? 'uncertain' : result.retryable && row.attempts<3 ? 'pending' : 'error';
    db.prepare('UPDATE hugh_owner_alerts SET status=?,error=?,external_ids=?,next_attempt_at=?,claimed_at=NULL WHERE id=?')
      .run(status,result.ok?'':String(result.error||'Не доставлено').slice(0,200),JSON.stringify(result.externalMessageIds||[]),stamp(now()+30000),row.id);
    return { ok:!!result.ok,status };
  }
  function list(code) { return db.prepare('SELECT id,text,status,error,created_at AS createdAt FROM hugh_owner_alerts WHERE company_code=? ORDER BY id DESC LIMIT 20').all(code); }
  return { add, pending, acknowledge, isJob, list };
}
module.exports={createHughOwnerAlerts};

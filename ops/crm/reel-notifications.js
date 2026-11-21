'use strict';
const {company,fail,object}=require('./company-information');
const number=(n,min=0)=>Number.isSafeInteger(n)&&n>=min;
function createReelNotifications(db,{enabled=false}={}){
  const active=enabled===true;
  db.exec('SAVEPOINT reel_notification_schema');
  try{db.exec(`CREATE TABLE IF NOT EXISTS reel_notification_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT NOT NULL UNIQUE,company_id INTEGER NOT NULL,
    reel_id INTEGER NOT NULL,author_id TEXT NOT NULL,title TEXT NOT NULL,kind TEXT NOT NULL,
    version INTEGER,text TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS reel_notification_author ON reel_notification_events(company_id,author_id,reel_id,id);
    CREATE TABLE IF NOT EXISTS reel_notification_reads (
      company_id INTEGER NOT NULL,author_id TEXT NOT NULL,reel_id INTEGER NOT NULL,through_id INTEGER NOT NULL,
      PRIMARY KEY(company_id,author_id,reel_id));
    CREATE TABLE IF NOT EXISTS reel_notification_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL);
    DROP TRIGGER IF EXISTS reel_notification_edit;
    DROP TRIGGER IF EXISTS reel_notification_request;
    CREATE TRIGGER reel_notification_edit AFTER UPDATE OF status ON reel_edits
      WHEN (SELECT enabled FROM reel_notification_settings WHERE id=1)=1
        AND NEW.status<>OLD.status AND NEW.status IN ('in_progress','done','cancelled') AND NEW.author_id<>''
        AND NEW.status_actor_id<>NEW.author_id
      BEGIN
        INSERT OR IGNORE INTO reel_notification_events(event_key,company_id,reel_id,author_id,title,kind,version,text,created_at)
          SELECT 'reel-edit:'||NEW.id||':'||NEW.status,NEW.company_id,NEW.reel_id,NEW.author_id,m.title,
            NEW.status,COALESCE(NEW.result_version,NEW.base_version),
            CASE NEW.status WHEN 'in_progress' THEN 'Правку взяли в работу.' WHEN 'done' THEN 'Версия v'||NEW.result_version||' готова, посмотрите.' ELSE 'Правка отменена.' END,
            NEW.updated_at FROM reel_materials m WHERE m.id=NEW.reel_id AND m.company_id=NEW.company_id;
      END;
    CREATE TRIGGER reel_notification_request AFTER INSERT ON reel_request_events
      WHEN (SELECT enabled FROM reel_notification_settings WHERE id=1)=1 AND NEW.status IN ('in_progress','ready','waiting_owner','rejected')
      BEGIN
        INSERT OR IGNORE INTO reel_notification_events(event_key,company_id,reel_id,author_id,title,kind,version,text,created_at)
          SELECT 'reel-request:'||r.id||':reply:'||NEW.id,r.company_id,r.reel_id,r.author_id,m.title,
            NEW.status,r.version,NEW.text,NEW.created_at FROM reel_requests r
            JOIN reel_materials m ON m.id=r.reel_id AND m.company_id=r.company_id
            WHERE r.id=NEW.request_id AND r.company_id=NEW.company_id AND r.author_id<>''
              AND NEW.actor_id<>r.author_id
              AND NOT(r.edit_id IS NOT NULL AND NEW.actor='Материалы');
      END;`);
  db.prepare('INSERT INTO reel_notification_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled').run(Number(active));
  db.exec('RELEASE reel_notification_schema');
  }catch(error){db.exec('ROLLBACK TO reel_notification_schema; RELEASE reel_notification_schema');throw error;}
  function feed(after=0,limit=100){
    if(!number(after)||!number(limit,1)||limit>200)fail(400,'Некорректный курсор');
    if(!active)return {enabled:false,events:[],nextAfter:after};
    const events=db.prepare(`SELECT e.id,e.event_key eventKey,lower(c.code) companyCode,e.reel_id reelId,e.author_id authorId,e.title,e.kind,e.version,e.text,e.created_at createdAt
      FROM reel_notification_events e JOIN companies c ON c.id=e.company_id AND c.is_deleted=0
      WHERE e.id>? ORDER BY e.id LIMIT ?`).all(after,limit);
    return {enabled:true,events,nextAfter:events.at(-1)?.id??after};
  }
  function unread(code,actor){
    const owner=company(db,code),author=String(actor.userId);
    if(!active)return {enabled:false,companyCode:owner.code.toLowerCase(),count:0,reels:[]};
    const rows=db.prepare(`SELECT e.reel_id reelId,COUNT(*) count,MAX(e.id) throughId,
      MAX(CASE WHEN e.kind IN ('done','ready') THEN 1 ELSE 0 END) newVersion
      FROM reel_notification_events e JOIN reel_materials m ON m.id=e.reel_id AND m.company_id=e.company_id AND m.archived_at IS NULL
      LEFT JOIN reel_notification_reads r
      ON r.company_id=e.company_id AND r.author_id=e.author_id AND r.reel_id=e.reel_id
      WHERE e.company_id=? AND e.author_id=? AND e.id>COALESCE(r.through_id,0) GROUP BY e.reel_id`).all(owner.id,author);
    return {enabled:true,companyCode:owner.code.toLowerCase(),count:rows.reduce((n,r)=>n+r.count,0),reels:rows};
  }
  function read(code,reelId,body,actor){
    const owner=company(db,code),author=String(actor.userId);object(body,['throughId']);
    if(!active)fail(404,'Уведомления пока не включены');
    if(!number(reelId,1)||!db.prepare('SELECT 1 FROM reel_materials WHERE id=? AND company_id=?').get(reelId,owner.id))fail(404,'Ролик не найден');
    if(!number(body.throughId,1)||!db.prepare('SELECT 1 FROM reel_notification_events WHERE id=? AND reel_id=? AND company_id=? AND author_id=?').get(body.throughId,reelId,owner.id,author))fail(404,'Уведомление не найдено');
    db.prepare(`INSERT INTO reel_notification_reads VALUES(?,?,?,?) ON CONFLICT(company_id,author_id,reel_id)
      DO UPDATE SET through_id=MAX(through_id,excluded.through_id)`).run(owner.id,author,reelId,body.throughId);
    return unread(code,actor);
  }
  return {notificationFeed:feed,unreadNotifications:unread,readNotifications:read};
}
module.exports={createReelNotifications};

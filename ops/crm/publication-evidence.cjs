'use strict';
const {createHash}=require('node:crypto');
const fingerprint=row=>createHash('sha256').update(JSON.stringify([row.content_revision,row.title,row.text,row.media_urls,row.media_sha256,row.expected_media_sha256,row.expected_media_file,row.platform_ids,row.captions,row.platform_options,row.meta])).digest('hex');
function resolve(db,row,delivery){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='autoposting_publication_payloads'").get())return null;
 const start=delivery.startedAt||delivery.started_at,channel=delivery.platform||delivery.channel_id;if(!start||!channel)return null;
 const saved=db.prepare('SELECT payload,fingerprint FROM autoposting_publication_payloads WHERE company_id=? AND post_id=? AND channel_id=? AND started_at=?').get(row.company_id,row.id,channel,start);if(!saved)return null;
 try{const payload=JSON.parse(saved.payload);if(payload.id!==row.id||payload.company_id!==row.company_id||!Number.isSafeInteger(payload.content_revision)||fingerprint(payload)!==saved.fingerprint)return null;return payload;}catch{return null;}
}
function initialize(db){db.exec(`CREATE TABLE IF NOT EXISTS autoposting_publication_payloads(
 company_id INTEGER NOT NULL REFERENCES companies(id),post_id INTEGER NOT NULL REFERENCES autoposting_posts(id),channel_id TEXT NOT NULL,started_at TEXT NOT NULL,
 content_revision INTEGER NOT NULL,payload TEXT NOT NULL,fingerprint TEXT NOT NULL,captured_at TEXT NOT NULL,
 PRIMARY KEY(company_id,post_id,channel_id,started_at));
 CREATE TRIGGER IF NOT EXISTS autoposting_publication_payloads_no_update BEFORE UPDATE ON autoposting_publication_payloads BEGIN SELECT RAISE(ABORT,'Immutable publication payload'); END;
 CREATE TRIGGER IF NOT EXISTS autoposting_publication_payloads_no_delete BEFORE DELETE ON autoposting_publication_payloads BEGIN SELECT RAISE(ABORT,'Immutable publication payload'); END;`);}
function capture(db,row,channel){const current=db.prepare('SELECT started_at,status FROM autoposting_deliveries WHERE post_id=? AND channel_id=?').get(row.id,channel);if(!current?.started_at||current.status!=='publishing')throw Object.assign(Error('Publication attempt changed'),{ambiguous:false});
 const exists=db.prepare('SELECT fingerprint FROM autoposting_publication_payloads WHERE company_id=? AND post_id=? AND channel_id=? AND started_at=?').get(row.company_id,row.id,channel,current.started_at),hash=fingerprint(row);if(exists){if(exists.fingerprint!==hash)throw Object.assign(Error('Publication payload changed'),{ambiguous:false});return;}
 db.prepare('INSERT INTO autoposting_publication_payloads(company_id,post_id,channel_id,started_at,content_revision,payload,fingerprint,captured_at) VALUES(?,?,?,?,?,?,?,?)').run(row.company_id,row.id,channel,current.started_at,row.content_revision,JSON.stringify(row),hash,new Date().toISOString());
}
function published(db,row,wanted,at){
 if(row.content_revision===wanted&&db.prepare('SELECT 1 FROM autoposting_publication_receipts WHERE company_id=? AND post_id=? AND content_revision=? AND published_at<=? LIMIT 1').get(row.company_id,row.id,wanted,at))return row;
 const deliveries=db.prepare("SELECT * FROM autoposting_deliveries WHERE post_id=? AND status='published' AND finished_at IS NOT NULL AND finished_at<>'' AND finished_at<=? ORDER BY finished_at DESC").all(row.id,at);
 for(const delivery of deliveries){const snapshot=resolve(db,row,delivery);if(snapshot?.content_revision===wanted)return snapshot;}return null;
}
function legacy(db,row,at){const all=db.prepare("SELECT * FROM autoposting_deliveries WHERE post_id=? AND status='published' AND finished_at IS NOT NULL AND finished_at<>'' AND finished_at<=? ORDER BY finished_at DESC").all(row.id,at);const d=all.find(d=>Number.isFinite(Date.parse(d.finished_at))&&Date.parse(d.finished_at)<=Date.parse(at)&&(!d.started_at||(Number.isFinite(Date.parse(d.started_at))&&Date.parse(d.started_at)<=Date.parse(d.finished_at)))&&!resolve(db,row,d));return d?{channelId:d.channel_id,startedAt:d.started_at||null,confirmedAt:d.finished_at,url:d.url||null}:null;}
module.exports={fingerprint,resolve,initialize,capture,published,legacy};

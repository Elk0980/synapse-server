#!/usr/bin/env python3
"""Диагностика очереди автопостинга. Только чтение: база открывается readOnly, ничего не меняется.
Запуск на сервере: python3 diag.py           — очередь и последние публикации Палитры
                   python3 diag.py ID        — подробно одна публикация
"""
import json, subprocess, sys

CONTAINER = "synapse-crm-1"
POST_ID = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 0

JS = r"""
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/data/crm.sqlite',{readOnly:true});
const now=new Date().toISOString(), out={now};
const has=t=>Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(t));
const info=id=>has('company_information')?db.prepare('SELECT revision FROM company_information WHERE company_id=?').get(id)?.revision??null:null;
out.due=db.prepare(`SELECT p.id,c.code,p.status,p.scheduled_at,p.publishing_at,p.revision,p.content_revision,p.profile_revision,p.last_error_code,p.company_id
  FROM autoposting_posts p JOIN companies c ON c.id=p.company_id WHERE p.archived_at IS NULL AND p.deleted_at IS NULL
  AND p.status IN ('scheduled','publishing') ORDER BY p.scheduled_at,p.id LIMIT 12`).all().map(r=>({...r,companyInfoRevision:info(r.company_id),isDue:r.scheduled_at<=now}));
const owner=db.prepare("SELECT id FROM companies WHERE code='palitra-love' COLLATE NOCASE").get();
out.palitraRecent=db.prepare(`SELECT id,title,status,scheduled_at,updated_at,last_error_code,profile_revision FROM autoposting_posts
  WHERE company_id=? ORDER BY updated_at DESC LIMIT 5`).all(owner.id);
const pick=Number(process.env.POST_ID)||out.palitraRecent[0]?.id;
out.deliveries=db.prepare(`SELECT post_id,channel_id,status,error_code,provider_post_id,provider_status,provider_checked_at,started_at,finished_at,url
  FROM autoposting_deliveries WHERE post_id=? ORDER BY channel_id`).all(pick);
out.channels=db.prepare(`SELECT id,provider,enabled,status,revision,checked_revision FROM autoposting_channels WHERE company_code='palitra-love' COLLATE NOCASE ORDER BY id`).all();
console.log(JSON.stringify(out));
db.close();
"""


def main():
    raw = subprocess.run(["docker", "exec", "-i", "-e", "POST_ID=" + str(POST_ID), CONTAINER, "node", "-"],
                         input=JS.encode(), capture_output=True, timeout=60)
    if raw.returncode:
        print("ОШИБКА ЧТЕНИЯ", raw.stderr.decode()[-300:])
        return 1
    d = json.loads(raw.stdout)
    print("сейчас", d["now"])
    print("ОЧЕРЕДЬ (scheduled/publishing):")
    for r in d["due"]:
        print(" ", r["id"], r["code"], r["status"], r["scheduled_at"], "due" if r["isDue"] else "-",
              "prof", r["profile_revision"], "/", r["companyInfoRevision"], r["last_error_code"] or "")
    print("ПАЛИТРА, последние:")
    for r in d["palitraRecent"]:
        print(" ", r["id"], r["status"], r["scheduled_at"], r["last_error_code"] or "", (r["title"] or "")[:30])
    print("ДОСТАВКИ:")
    for r in d["deliveries"]:
        print(" ", r["post_id"], r["channel_id"], r["status"], r["error_code"] or "", r["provider_post_id"] or "",
              r["provider_status"] or "", r["url"] or "")
    print("КАНАЛЫ:", " ".join(f'{c["id"]}:{c["provider"]}:{"on" if c["enabled"] else "off"}:{c["revision"]}/{c["checked_revision"]}' for c in d["channels"]))
    logs = subprocess.run(["docker", "logs", "--since", "40m", CONTAINER], capture_output=True, timeout=60)
    lines = [l for l in (logs.stdout + logs.stderr).decode("utf-8", "replace").splitlines() if "autopost" in l.lower() or "worker" in l.lower()]
    print("ЖУРНАЛ (автопостинг, 40 мин):", len(lines))
    for l in lines[-8:]:
        print(" ", l[:150])
    return 0


if __name__ == "__main__":
    sys.exit(main())

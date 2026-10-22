"""Read-only Palitra order inventory; never emit customer details or credentials."""
import json
import pathlib
import sqlite3
import subprocess


def inventory(label, path, tables):
    if not pathlib.Path(path).is_file():
        print(json.dumps({"database": label, "available": False}))
        return
    db = sqlite3.connect("file:" + path + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA query_only=ON")
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        for table in tables:
            columns = {row[1] for row in db.execute("PRAGMA table_info(" + table + ")")}
            if not columns:
                print(json.dumps({"database": label, "table": table, "available": False}))
                continue
            scope = " WHERE company_code='palitra-love'" if "company_code" in columns else " WHERE site='palitra'" if "site" in columns else ""
            safe = [key for key in ["id", "site", "company_code", "order_id", "created_at", "updated_at", "status", "kind"] if key in columns]
            count = db.execute("SELECT count(*) FROM " + table + scope).fetchone()[0]
            recent = [dict(row) for row in db.execute("SELECT " + ",".join(safe) + " FROM " + table + scope + " ORDER BY rowid DESC LIMIT 5")]
            print(json.dumps({"database": label, "table": table, "count": count, "recent": recent}))
        if label == "content":
            row = db.execute("SELECT seq FROM sqlite_sequence WHERE name='site_orders'").fetchone()
            print(json.dumps({"database": label, "lastAllocatedOrderId": row[0] if row else None}))
    finally:
        db.close()


inventory("content", "/var/lib/docker/volumes/synapse_content_data/_data/content.sqlite", ["site_orders", "chat_threads", "client_dialogs", "chat_widget_starts", "site_order_outbox", "client_order_links"])
inventory("crm", "/var/lib/docker/volumes/synapse_crm_data/_data/crm.sqlite", ["leads"])

# Caddy access logging may be disabled. An empty log is explicitly not proof of no requests.
try:
    result = subprocess.run(["docker", "logs", "--since", "36h", "synapse-caddy-1"], capture_output=True, text=True, timeout=20)
    entries = []
    for line in (result.stdout + result.stderr).splitlines():
        try:
            item = json.loads(line)
        except ValueError:
            continue
        request = item.get("request") or {}
        path = str(request.get("uri", "")).split("?", 1)[0]
        if request.get("method") == "POST" and str(request.get("host", "")).split(":")[0] in {"palitra-love.ru", "www.palitra-love.ru"} and path in {"/api/orders", "/api/customer-chat/session"}:
            entries.append({"time": item.get("ts"), "path": path, "status": item.get("status")})
    print(json.dumps({"accessLogReturnCode": result.returncode, "matchingRequests": entries[-30:], "emptyIsNotProof": True}))
except (OSError, subprocess.TimeoutExpired):
    print(json.dumps({"accessLogAvailable": False}))

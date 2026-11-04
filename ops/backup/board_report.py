"""Small stateless MCP client for task 58 only. No SSH write capability.

An existing, explicitly configured MCP URL is read from a private file. We never
discover credentials or print URLs/errors. Unknown comment delivery is read back,
never blindly repeated. Outbox contains only whitelisted backup status fields.
"""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import urllib.parse
import urllib.request

AUTHOR = "Synapse Backup — №58"
ACK = "BACKUP58_ACK "
ERRORS = {"NO_SPACE_SERVER", "NO_SPACE_D", "NO_SPACE_TEMP", "BAD_SHA", "BAD_RECEIPT", "STALE_BACKUP", "NO_BACKUP", "IDENTITY_MUST_BE_OUTSIDE_BACKUPS", "TEMP_MUST_BE_OUTSIDE_BACKUPS", "RESTORE_BUDGET_INVALID", "CREATE_FAILED", "PULL_OR_VERIFY_FAILED", "SOURCE_CHANGED", "LINK_OUTSIDE_ROOTS", "UNSAFE_DESTINATION", "LOCAL_BACKUP_DAMAGED", "RESTORE_BUDGET_EXCEEDED", "UNSAFE_SQLITE_PATH"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kw):
        raise ValueError("Redirect denied")


def rpc(c, name, args):
    url = Path(c["board_endpoint_file"]).read_text(encoding="utf-8-sig").strip()
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Private HTTPS endpoint required")
    payload = {"jsonrpc": "2.0", "id": 58, "method": "tools/call", "params": {"name": name, "arguments": args}}
    request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        data = response.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise ValueError("Response too large")
    body = json.loads(data)
    result = body.get("result", {})
    if body.get("error") or result.get("isError"):
        raise ValueError("MCP declined")
    return result["structuredContent"]


def comments(c):
    offset = 0
    for _ in range(50):
        result = rpc(c, "task_get", {"task_id": 58, "comments_limit": 20, "comments_offset": offset})
        page = result.get("comments", [])
        yield from page
        offset += len(page)
        if not page or offset >= result.get("comments_pagination", {}).get("total", offset):
            return
    raise ValueError("Comment pagination limit")


def atomic_json(path, value):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def publish(c, root, status):
    safe = {k: status[k] for k in ("phase", "id", "bytes", "sha", "result", "receipt_sha") if k in status}
    if status.get("error"):
        safe["error"] = status["error"] if status["error"] in ERRORS else "PULL_OR_VERIFY_FAILED"
    safe["date"] = dt.datetime.now(dt.timezone.utc).date().isoformat()
    marker = "BACKUP58_REPORT " + hashlib.sha256(json.dumps(safe, sort_keys=True).encode()).hexdigest()
    text = "Копия за {date}: {id}; размер {bytes}; SHA {sha}; {result}".format(**{"id": "—", "bytes": 0, "sha": "UNKNOWN", **safe})
    if safe.get("error"):
        text += "; " + ("нет места" if safe["error"].startswith("NO_SPACE") else safe["error"])
    text += "\n" + marker
    if safe.get("phase") == "pull" and safe.get("result") == "OK":
        text += "\n" + ACK + json.dumps({"id": safe["id"], "receipt_sha": safe["receipt_sha"]}, sort_keys=True)
    outbox = Path(root) / ".board-outbox"
    outbox.mkdir(mode=0o700, exist_ok=True)
    path = outbox / (marker.split()[1] + ".json")
    if not path.exists():
        atomic_json(path, {"marker": marker, "text": text, "state": "pending"})
    if not c.get("board_endpoint_file"):
        return False
    session_id = None
    try:
        # Start/read map as required; deployed MAP may still be unavailable.
        try:
            session = rpc(c, "session_start", {"agent": AUTHOR, "kind": "codex", "request": "Короткий отчёт резервного копирования №58"})
            session_id = session.get("session_id")
            for document in session.get("documents", []):
                rpc(c, "doc_read", {"path": document["path"]})
        except Exception:
            pass
        history = list(comments(c))
        seen = {entry.get("text", "") for entry in history if entry.get("author") == AUTHOR}
        for item in sorted(outbox.glob("*.json")):
            saved = json.loads(item.read_text(encoding="utf-8"))
            if saved["state"] == "sent":
                continue
            if any(saved["marker"] in text for text in seen):
                saved["state"] = "sent"
            elif saved["state"] == "sending":
                # Unknown result: leave pending investigation; don't duplicate.
                continue
            else:
                saved["state"] = "sending"
                atomic_json(item, saved)
                rpc(c, "task_comment", {"task_id": 58, "author": AUTHOR, "text": saved["text"]})
                saved["state"] = "sent"
            atomic_json(item, saved)
        return json.loads(path.read_text(encoding="utf-8"))["state"] == "sent"
    except Exception:
        return False
    finally:
        if session_id:
            try:
                rpc(c, "session_end", {"session_id": session_id, "summary": "Отчёт резервного копирования №58; состояние в outbox", "state": "idle"})
            except Exception:
                pass


def acknowledged(c, name, receipt_sha):
    for comment in comments(c):
        if comment.get("author") != AUTHOR:
            continue
        for line in comment.get("text", "").splitlines():
            if line.startswith(ACK):
                try:
                    if json.loads(line[len(ACK):]) == {"id": name, "receipt_sha": receipt_sha}:
                        return True
                except (ValueError, TypeError):
                    continue
    return False

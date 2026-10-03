"""One-shot owner pairing. No task source, runtime, files, or persistent state."""

import http.client
import json
import re
import secrets
import ssl
import time


MAX_BODY = 262144
METHODS = frozenset(("getMe", "getWebhookInfo", "getUpdates", "sendMessage"))


class PairingError(Exception):
    """Only static messages, never Telegram bodies, credentials or challenge values."""


def safe_id(value):
    return type(value) is int and 0 < value <= 2**53 - 1


def ensure_fresh(deadline, *, clock=time.monotonic):
    if clock() >= deadline:
        raise PairingError("Срок подтверждения истёк. Настройка не сохранена.")


class TelegramAPI:
    def __init__(self, token, *, connection_factory=http.client.HTTPSConnection):
        if (not isinstance(token, str)
                or not re.fullmatch(r"[1-9][0-9]{4,15}:[A-Za-z0-9_-]{20,200}", token)
                or int(token.split(":", 1)[0]) > 2**53 - 1):
            raise PairingError("Неверный формат токена.")
        self._token = token
        self._connection_factory = connection_factory

    def __call__(self, method, params=None):
        if method not in METHODS:
            raise PairingError("Метод настройки запрещён.")
        connection = None
        try:
            # Fixed verified TLS origin, no proxy environment or redirect handling.
            connection = self._connection_factory(
                "api.telegram.org", 443, timeout=15, context=ssl.create_default_context())
            connection.request("POST", "/bot" + self._token + "/" + method,
                               body=json.dumps(params or {}).encode("utf-8"),
                               headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            if response.status != 200:
                raise PairingError("Telegram отклонил настройку; проверьте подключение и другой poller.")
            raw = response.read(MAX_BODY + 1)
            if len(raw) > MAX_BODY:
                raise PairingError("Ответ Telegram превышает предел настройки.")
            envelope = json.loads(raw.decode("utf-8"))
            if not isinstance(envelope, dict) or envelope.get("ok") is not True or "result" not in envelope:
                raise PairingError("Telegram не подтвердил действие настройки.")
            return envelope["result"]
        except PairingError:
            raise
        except Exception:
            raise PairingError("Соединение настройки Telegram прервано. Повторите личную настройку позже.") from None
        finally:
            if connection is not None:
                try:
                    connection.close()
                except PairingError:
                    raise  # The one-shot deadline alarm must never be swallowed.
                except Exception:
                    pass


def validate_updates(updates):
    if (not isinstance(updates, list) or len(updates) > 50
            or any(not isinstance(item, dict) or type(item.get("update_id")) is not int
                   or not 0 <= item["update_id"] < 2**53 - 1 for item in updates)):
        raise PairingError("Неверный ответ очереди Telegram.")
    return sorted(updates, key=lambda item: item["update_id"])


def candidate_id(update, payload):
    if set(update) != {"update_id", "message"}:
        return None
    message = update.get("message")
    if not isinstance(message, dict):
        return None
    if any(key in message for key in (
            "forward_origin", "forward_from", "forward_from_chat", "forward_sender_name", "forward_date",
            "is_automatic_forward", "via_bot", "sender_chat", "edit_date",
            "business_connection_id", "guest_query_id")):
        return None
    sender, chat = message.get("from"), message.get("chat")
    if not isinstance(sender, dict) or not isinstance(chat, dict):
        return None
    if (not safe_id(sender.get("id")) or not safe_id(chat.get("id"))
            or sender.get("is_bot") is not False or chat.get("type") != "private"
            or sender["id"] != chat["id"] or message.get("text") != "/start " + payload):
        return None
    return sender["id"]


def pair_owner(transport, expected_bot_username, expected_bot_id, *, show_link, confirm_code,
               clock=time.monotonic, nonce_factory=lambda: secrets.token_urlsafe(24),
               code_factory=lambda: secrets.token_hex(5).upper(), lifetime=300):
    """Possession of BOTH trusted TTY and chosen private Telegram is required.

    A candidate is never an owner until its private code comes back through TTY.
    The caller must enforce the same wall-clock deadline on blocking human input.
    """
    if (not isinstance(expected_bot_username, str)
            or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{4,31}", expected_bot_username)
            or not expected_bot_username.lower().endswith("bot") or not safe_id(expected_bot_id)
            or type(lifetime) is not int or not 1 <= lifetime <= 300):
        raise PairingError("Неверные параметры подтверждения.")
    deadline = clock() + lifetime
    identity = transport("getMe", {})
    ensure_fresh(deadline, clock=clock)
    if (not isinstance(identity, dict) or identity.get("is_bot") is not True
            or not safe_id(identity.get("id")) or identity["id"] != expected_bot_id
            or not isinstance(identity.get("username"), str)
            or identity["username"].lower() != expected_bot_username.lower()):
        raise PairingError("Токен относится к другому боту. Настройка остановлена.")
    webhook = transport("getWebhookInfo", {})
    ensure_fresh(deadline, clock=clock)
    if not isinstance(webhook, dict) or webhook.get("url") != "":
        raise PairingError("У бота настроен webhook. Ничего не изменено.")
    nonce, code = nonce_factory(), code_factory()
    if (not isinstance(nonce, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32}", nonce)
            or not isinstance(code, str) or not re.fullmatch(r"[A-F0-9]{10}", code)):
        raise PairingError("Не удалось создать одноразовое подтверждение.")
    payload = "eva_" + nonce
    show_link("https://t.me/" + expected_bot_username + "?start=" + payload)
    offset, seen = 0, 0
    for _ in range(60):
        ensure_fresh(deadline, clock=clock)
        updates = validate_updates(transport("getUpdates", {
            "offset": offset, "timeout": 10, "limit": 50, "allowed_updates": ["message"]}))
        ensure_fresh(deadline, clock=clock)
        for update in updates:
            if update["update_id"] < offset:
                continue
            offset = update["update_id"] + 1
            seen += 1
            if seen > 1000:
                raise PairingError("Очередь настройки превышает предел. Настройка остановлена.")
            owner_id = candidate_id(update, payload)
            if owner_id is None:
                continue
            ensure_fresh(deadline, clock=clock)
            # No task text and no name/username reflection. Exactly one frozen destination.
            delivery = transport("sendMessage", {
                "chat_id": owner_id,
                "text": "Eva: код подтверждения личного аккаунта: " + code
                        + ". Введите его только в открытой вами личной серверной консоли. "
                          "Не передавайте код другому человеку или агенту. Задачи ещё не подключены.",
                "protect_content": True})
            ensure_fresh(deadline, clock=clock)
            if (not isinstance(delivery, dict) or not safe_id(delivery.get("message_id"))
                    or not isinstance(delivery.get("chat"), dict)
                    or not safe_id(delivery["chat"].get("id"))
                    or delivery["chat"].get("id") != owner_id
                    or delivery["chat"].get("type") != "private"):
                raise PairingError("Доставка подтверждения не проверена. Настройка остановлена.")
            entered = confirm_code(deadline - clock())
            ensure_fresh(deadline, clock=clock)
            if (not isinstance(entered, str) or not re.fullmatch(r"[A-F0-9]{10}", entered)
                    or not secrets.compare_digest(entered, code)):
                raise PairingError("Аккаунт не подтверждён. Настройка не сохранена.")
            # /start <nonce> is a task command to the ordinary runtime. Acknowledge
            # this exact candidate before saving config, but not subsequent updates.
            validate_updates(transport("getUpdates", {
                "offset": offset, "timeout": 0, "limit": 50, "allowed_updates": ["message"]}))
            ensure_fresh(deadline, clock=clock)
            return {"owner_id": str(owner_id), "expires_at": deadline}
    raise PairingError("Подтверждение не получено. Настройка не сохранена.")

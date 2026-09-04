"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { URL } = require("node:url");

const SCRIPT = {
  greeting:
    "Здравствуйте! Я Хью, ассистент Synapse Business. " +
    "Как я могу к вам обращаться и какой у вас вопрос?",
  askName: "Спасибо! Подскажите, пожалуйста, как к вам обращаться?",
  askPhone:
    "Чтобы специалист мог точно ответить, оставьте, пожалуйста, номер телефона.",
  askQuestion:
    "Спасибо! Опишите, пожалуйста, ваш вопрос — я передам его специалисту.",
  accepted:
    "Спасибо! Я передал вопрос специалисту. Он свяжется с вами по указанному номеру.",
  unknown:
    "Я не буду придумывать цены или обещания: на этот вопрос точно ответит специалист. " +
    "Оставьте, пожалуйста, номер телефона для связи.",
};
const MODEL_SYSTEM_PROMPT =
  "Ты — русскоязычный ассистент Synapse Business. Отвечай кратко и " +
  "доброжелательно. Узнай вопрос, имя и телефон. Ничего не выдумывай.";
const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const DATABASE_PATH = process.env.DATABASE_PATH || "/data/chat.sqlite";
const API_KEY = process.env.API_KEY || "";
const ADMIN_KEY = process.env.CHAT_ADMIN_KEY || "";
const CRM_URL = process.env.CRM_URL || "";
const CRM_API_KEY = process.env.CRM_API_KEY || "";
const MODEL_API_URL = process.env.MODEL_API_URL || "";
const MODEL_API_KEY = process.env.MODEL_API_KEY || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const TELEGRAM_OWNER_ID = process.env.TELEGRAM_OWNER_ID || "";
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const COMPANIES = new Set(["alvi", "avokado", "palitra", "synapse"]);
const UTM_FIELDS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
];

if (!API_KEY.trim()) throw new Error("API_KEY не должен быть пустым");
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT должен быть целым числом от 1 до 65535");
}

const db = new DatabaseSync(DATABASE_PATH);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    site TEXT, page TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT,
    utm_content TEXT, referrer TEXT, client_id TEXT, visitor_key TEXT NOT NULL, lead_id INTEGER,
    status TEXT NOT NULL DEFAULT 'open'
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL
  );
`);

function addColumn(table, definition) {
  const name = definition.split(" ")[0];
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((column) => column.name === name))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

addColumn("conversations", "company TEXT NOT NULL DEFAULT 'synapse'");
addColumn("conversations", "channel TEXT NOT NULL DEFAULT 'web'");
addColumn("conversations", "external_chat_id TEXT");
addColumn("conversations", "title TEXT");
addColumn("conversations", "unread_count INTEGER NOT NULL DEFAULT 0");
addColumn("conversations", "last_message_at TEXT");
addColumn("messages", "author_type TEXT");
addColumn("messages", "author_name TEXT");
addColumn("messages", "external_message_id TEXT");
db.exec(`
  UPDATE messages SET author_type = CASE role WHEN 'operator' THEN 'owner' ELSE role END
    WHERE author_type IS NULL;
  UPDATE conversations SET last_message_at = updated_at WHERE last_message_at IS NULL;
  CREATE INDEX IF NOT EXISTS conversations_updated_idx ON conversations(updated_at);
  CREATE UNIQUE INDEX IF NOT EXISTS conversations_telegram_idx
    ON conversations(channel, external_chat_id) WHERE external_chat_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, id);
`);

const insertWebConversation = db.prepare(`INSERT INTO conversations
  (created_at, updated_at, last_message_at, site, page, utm_source, utm_medium, utm_campaign,
   utm_term, utm_content, referrer, client_id, visitor_key, title)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insertTelegramConversation = db.prepare(`INSERT INTO conversations
  (created_at, updated_at, last_message_at, visitor_key, company, channel, external_chat_id, title)
  VALUES (?, ?, ?, '', 'synapse', 'telegram', ?, ?)`);
const getConversation = db.prepare("SELECT * FROM conversations WHERE id = ?");
const getTelegramConversation = db.prepare(
  "SELECT * FROM conversations WHERE channel = 'telegram' AND external_chat_id = ?",
);
const insertMessage = db.prepare(`INSERT INTO messages
  (conversation_id, created_at, role, text, author_type, author_name, external_message_id)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);
const getMessages =
  db.prepare(`SELECT id, created_at, role, text, author_type, author_name,
  external_message_id FROM messages WHERE conversation_id = ? ORDER BY id`);
const updateActivity =
  db.prepare(`UPDATE conversations SET updated_at = ?, last_message_at = ?,
  unread_count = unread_count + ? WHERE id = ?`);
const saveLead = db.prepare(
  "UPDATE conversations SET lead_id = ?, status = 'lead', updated_at = ? WHERE id = ?",
);
const visitorLimits = new Map();
const ipLimits = new Map();
const notificationTimes = new Map();

function send(response, status, payload, origin) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...(origin
      ? { "access-control-allow-origin": origin, vary: "Origin" }
      : {}),
  });
  response.end(body);
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string")
    fail(400, `Поле «${field}» должно быть строкой`);
  return value.trim().slice(0, 4000) || null;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) fail(413, "Тело запроса не должно превышать 1 МБ");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object")
      fail(400, "Ожидается JSON-объект");
    return value;
  } catch (error) {
    if (error.status) throw error;
    fail(400, "Некорректный JSON");
  }
}

function conversationId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1)
    fail(400, "Некорректный идентификатор диалога");
  return id;
}

function existingConversation(id) {
  const row = getConversation.get(id);
  if (!row) fail(404, "Диалог не найден");
  return row;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function requireVisitor(request, row) {
  const token =
    request.headers.authorization?.replace(/^Bearer\s+/i, "") ||
    request.headers["x-visitor-token"];
  if (!token || hashToken(String(token)) !== row.visitor_key)
    fail(401, "Неверный токен посетителя");
}

function requireOperator(request) {
  if (request.headers["x-api-key"] !== API_KEY) fail(401, "Неверный API-ключ");
}

function requireAdmin(request) {
  if (!ADMIN_KEY || request.headers["x-api-key"] !== ADMIN_KEY)
    fail(401, "Неверный ключ владельца");
}

function clientIp(request) {
  return String(
    request.headers["x-forwarded-for"] || request.socket.remoteAddress || "",
  )
    .split(",")[0]
    .trim();
}

function takeLimit(map, key, maximum, windowMs) {
  const now = Date.now();
  const recent = (map.get(key) || []).filter((time) => time > now - windowMs);
  if (recent.length >= maximum)
    fail(429, "Слишком много сообщений. Попробуйте позже.");
  recent.push(now);
  map.set(key, recent);
}

function serialize(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    company: row.company,
    channel: row.channel,
    externalChatId: row.external_chat_id,
    title: row.title,
    unreadCount: row.unread_count,
    lastMessageAt: row.last_message_at,
    site: row.site,
    page: row.page,
    leadId: row.lead_id,
    status: row.status,
    messages: getMessages.all(row.id),
  };
}

function addMessage(
  row,
  text,
  authorType,
  authorName = null,
  externalMessageId = null,
  unread = false,
) {
  const now = new Date().toISOString();
  const role =
    authorType === "owner"
      ? "operator"
      : authorType === "system"
        ? "assistant"
        : authorType;
  insertMessage.run(
    row.id,
    now,
    role,
    text,
    authorType,
    authorName,
    externalMessageId,
  );
  updateActivity.run(now, now, unread ? 1 : 0, row.id);
  return now;
}

function contactData(messages) {
  const texts = messages
    .filter((item) => item.author_type === "visitor")
    .map((item) => item.text);
  const joined = texts.join("\n");
  const phone =
    joined
      .match(
        /(?:\+?7|8)?[\s(.-]*\d{3}[\s).-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}/,
      )?.[0]
      ?.trim() || null;
  const explicit = joined.match(
    /(?:меня зовут|я)\s+([А-ЯЁ][а-яё-]{1,30})/i,
  )?.[1];
  const shortName = texts
    .find((text) => /^[А-ЯЁ][а-яё-]{1,30}$/i.test(text.trim()))
    ?.trim();
  const firstQuestion =
    texts.find((text) => text !== shortName && text !== phone) || null;
  return { name: explicit || shortName || null, phone, firstQuestion };
}

async function createLead(row, data) {
  if (!CRM_URL || !CRM_API_KEY) return false;
  const response = await fetch(CRM_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": CRM_API_KEY },
    body: JSON.stringify({
      name: data.name,
      contact: data.phone,
      channel: "chat",
      utmSource: row.utm_source,
      utmMedium: row.utm_medium,
      utmCampaign: row.utm_campaign,
      utmContent: row.utm_content,
      clientId: row.client_id,
      referrer: row.referrer,
      landingPage: row.page,
      firstQuestion: data.firstQuestion,
    }),
  });
  if (!response.ok) throw new Error(`CRM вернула HTTP ${response.status}`);
  const lead = await response.json();
  if (!lead.id) throw new Error("CRM не вернула id заявки");
  saveLead.run(lead.id, new Date().toISOString(), row.id);
  return true;
}

function scriptedReply(data, leadCreated) {
  if (leadCreated) return SCRIPT.accepted;
  if (!data.name) return SCRIPT.askName;
  if (!data.phone) return SCRIPT.askPhone;
  if (!data.firstQuestion) return SCRIPT.askQuestion;
  return SCRIPT.unknown;
}

async function modelReply(messages) {
  const response = await fetch(MODEL_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${MODEL_API_KEY}`,
    },
    body: JSON.stringify({
      messages: [
        { role: "system", content: MODEL_SYSTEM_PROMPT },
        ...messages.map((item) => ({
          role: item.author_type === "visitor" ? "user" : "assistant",
          content: item.text,
        })),
      ],
    }),
  });
  if (!response.ok) throw new Error(`Модель вернула HTTP ${response.status}`);
  const body = await response.json();
  const text = body.choices?.[0]?.message?.content || body.reply || body.output;
  if (typeof text !== "string" || !text.trim())
    throw new Error("Модель вернула пустой ответ");
  return text.trim();
}

async function telegramRequest(method, payload) {
  if (!TELEGRAM_BOT_TOKEN)
    return { ok: false, warning: "не отправлено в Telegram: токен не задан" };
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  const body = await response.json();
  if (!response.ok || !body.ok)
    throw new Error(`Telegram ${method}: HTTP ${response.status}`);
  return body;
}

async function notifyOwner(row, text) {
  if (!TELEGRAM_OWNER_ID || !TELEGRAM_BOT_TOKEN) return;
  const previous = notificationTimes.get(row.id) || 0;
  if (Date.now() - previous < 60_000) return;
  notificationTimes.set(row.id, Date.now());
  const preview = text.replace(/\s+/g, " ").slice(0, 80);
  try {
    await telegramRequest("sendMessage", {
      chat_id: TELEGRAM_OWNER_ID,
      text: `Новое сообщение · ${row.company} · ${preview}`,
    });
  } catch (error) {
    console.error("Не удалось уведомить владельца:", error.message);
  }
}

function telegramAuthor(message) {
  const owner = String(message.from?.id || "") === String(TELEGRAM_OWNER_ID);
  return {
    type: owner || message.from?.is_bot ? "owner" : "visitor",
    name:
      [message.from?.first_name, message.from?.last_name]
        .filter(Boolean)
        .join(" ") ||
      message.from?.username ||
      null,
  };
}

async function handleWebhook(request, response, origin) {
  if (
    !TELEGRAM_WEBHOOK_SECRET ||
    request.headers["x-telegram-bot-api-secret-token"] !==
      TELEGRAM_WEBHOOK_SECRET
  ) {
    fail(401, "Неверный секрет Telegram webhook");
  }
  const update = await readJson(request);
  const message = update.message;
  if (!message || !["group", "supergroup"].includes(message.chat?.type)) {
    return send(response, 200, { ok: true }, origin);
  }
  const chatId = String(message.chat.id);
  let row = getTelegramConversation.get(chatId);
  if (!row) {
    const now = new Date().toISOString();
    const title =
      optionalString(message.chat.title, "title") || `Telegram ${chatId}`;
    const result = insertTelegramConversation.run(now, now, now, chatId, title);
    row = getConversation.get(Number(result.lastInsertRowid));
  }
  const text = message.text || message.caption;
  if (!text) return send(response, 200, { ok: true }, origin);
  if (text.startsWith("/")) {
    const company = text
      .match(/^\/company(?:@\w+)?\s+(alvi|avokado|palitra)\s*$/i)?.[1]
      ?.toLowerCase();
    const isOwner =
      String(message.from?.id || "") === String(TELEGRAM_OWNER_ID);
    if (company && isOwner) {
      db.prepare("UPDATE conversations SET company = ? WHERE id = ?").run(
        company,
        row.id,
      );
      await telegramRequest("sendMessage", {
        chat_id: chatId,
        text: `Компания: ${company}`,
      });
    }
    return send(
      response,
      200,
      { ok: true, company: company && isOwner ? company : row.company },
      origin,
    );
  }
  const author = telegramAuthor(message);
  addMessage(
    row,
    text,
    author.type,
    author.name,
    String(message.message_id),
    author.type !== "owner",
  );
  if (author.type !== "owner")
    await notifyOwner(getConversation.get(row.id), text);
  return send(response, 200, { ok: true }, origin);
}

async function adminRoutes(request, response, url, origin) {
  requireAdmin(request);
  if (request.method === "GET" && url.pathname === "/admin/conversations") {
    const company = url.searchParams.get("company");
    if (company && !COMPANIES.has(company)) fail(400, "Неизвестная компания");
    const where = company ? "WHERE c.company = ?" : "";
    const statement = db.prepare(`SELECT c.*,
      (SELECT text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1)
        AS last_message
      FROM conversations c ${where} ORDER BY c.last_message_at DESC, c.id DESC LIMIT 500`);
    const rows = company ? statement.all(company) : statement.all();
    return send(
      response,
      200,
      {
        conversations: rows.map((row) => ({
          id: row.id,
          company: row.company,
          channel: row.channel,
          title: row.title || row.site || `Диалог ${row.id}`,
          lastMessage: row.last_message,
          unreadCount: row.unread_count,
          lastMessageAt: row.last_message_at,
        })),
      },
      origin,
    );
  }
  let match = url.pathname.match(/^\/admin\/conversations\/(\d+)\/messages$/);
  if (request.method === "GET" && match) {
    const row = existingConversation(conversationId(match[1]));
    return send(
      response,
      200,
      { conversation: serialize(row), messages: getMessages.all(row.id) },
      origin,
    );
  }
  if (request.method === "POST" && match) {
    const row = existingConversation(conversationId(match[1]));
    const body = await readJson(request);
    const text = optionalString(body.text, "text");
    if (!text) fail(400, "Поле «text» обязательно");
    addMessage(row, text, "owner", "Владислав");
    let delivery = { ok: true };
    if (row.channel === "telegram") {
      try {
        delivery = await telegramRequest("sendMessage", {
          chat_id: row.external_chat_id,
          text,
        });
      } catch (error) {
        delivery = {
          ok: false,
          warning: `не отправлено в Telegram: ${error.message}`,
        };
      }
      if (!delivery.ok) addMessage(row, delivery.warning, "system", "Система");
    }
    return send(
      response,
      201,
      {
        conversation: serialize(getConversation.get(row.id)),
        delivery,
      },
      origin,
    );
  }
  match = url.pathname.match(/^\/admin\/conversations\/(\d+)\/read$/);
  if (request.method === "POST" && match) {
    const row = existingConversation(conversationId(match[1]));
    db.prepare("UPDATE conversations SET unread_count = 0 WHERE id = ?").run(
      row.id,
    );
    return send(response, 200, { ok: true }, origin);
  }
  fail(404, "Метод или адрес не найден");
}

async function route(request, response, origin) {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname.startsWith("/admin/"))
    return adminRoutes(request, response, url, origin);
  if (request.method === "POST" && url.pathname === "/telegram/webhook") {
    return handleWebhook(request, response, origin);
  }
  if (request.method === "POST" && url.pathname === "/conversations") {
    const body = await readJson(request);
    const token = crypto.randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const values = [
      now,
      now,
      now,
      optionalString(body.site, "site"),
      optionalString(body.page, "page"),
      ...UTM_FIELDS.map((field) =>
        optionalString(
          body[field] ??
            body[
              field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
            ],
          field,
        ),
      ),
      optionalString(body.referrer, "referrer"),
      optionalString(body.client_id ?? body.clientId, "client_id"),
      hashToken(token),
      optionalString(body.title, "title"),
    ];
    const result = insertWebConversation.run(...values);
    const id = Number(result.lastInsertRowid);
    addMessage(getConversation.get(id), SCRIPT.greeting, "assistant", "Хью");
    return send(
      response,
      201,
      { id, visitorToken: token, reply: SCRIPT.greeting },
      origin,
    );
  }
  if (request.method === "GET" && url.pathname === "/conversations") {
    requireOperator(request);
    const rows = db
      .prepare("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 500")
      .all();
    return send(response, 200, { conversations: rows.map(serialize) }, origin);
  }
  let match = url.pathname.match(/^\/conversations\/(\d+)$/);
  if (request.method === "GET" && match) {
    const row = existingConversation(conversationId(match[1]));
    if (request.headers["x-api-key"] !== API_KEY) requireVisitor(request, row);
    return send(response, 200, serialize(row), origin);
  }
  match = url.pathname.match(/^\/conversations\/(\d+)\/messages$/);
  if (request.method === "POST" && match) {
    const row = existingConversation(conversationId(match[1]));
    requireVisitor(request, row);
    takeLimit(visitorLimits, row.id, 20, 60_000);
    takeLimit(ipLimits, clientIp(request), 60, 3_600_000);
    const body = await readJson(request);
    const text = optionalString(body.text, "text");
    if (!text) fail(400, "Поле «text» обязательно");
    addMessage(row, text, "visitor", null, null, true);
    await notifyOwner(getConversation.get(row.id), text);
    const all = getMessages.all(row.id);
    const data = contactData(all);
    let leadCreated = false;
    if (!row.lead_id && data.name && data.phone && data.firstQuestion) {
      try {
        leadCreated = await createLead(row, data);
      } catch (error) {
        console.error("Не удалось создать заявку в CRM:", error.message);
      }
    }
    let reply = scriptedReply(data, leadCreated);
    if (MODEL_API_URL && MODEL_API_KEY && !leadCreated) {
      try {
        reply = await modelReply(all);
      } catch (error) {
        console.error("Ошибка модели, используется сценарий:", error.message);
      }
    }
    addMessage(row, reply, "assistant", "Хью");
    return send(
      response,
      201,
      { reply, conversation: serialize(getConversation.get(row.id)) },
      origin,
    );
  }
  match = url.pathname.match(/^\/conversations\/(\d+)$/);
  if (request.method === "PATCH" && match) {
    requireAdmin(request);
    const row = existingConversation(conversationId(match[1]));
    const body = await readJson(request);
    if (!COMPANIES.has(body.company)) fail(400, "Неизвестная компания");
    db.prepare("UPDATE conversations SET company = ? WHERE id = ?").run(
      body.company,
      row.id,
    );
    return send(response, 200, serialize(getConversation.get(row.id)), origin);
  }
  match = url.pathname.match(/^\/conversations\/(\d+)\/operator$/);
  if (request.method === "POST" && match) {
    requireOperator(request);
    const row = existingConversation(conversationId(match[1]));
    const body = await readJson(request);
    const text = optionalString(body.text, "text");
    if (!text) fail(400, "Поле «text» обязательно");
    addMessage(row, text, "owner", "Оператор");
    return send(response, 201, serialize(getConversation.get(row.id)), origin);
  }
  fail(404, "Метод или адрес не найден");
}

function sameOrigin(request, origin) {
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch (_) {
    return false;
  }
}

const server = http.createServer((request, response) => {
  const origin = request.headers.origin;
  const allowed = ALLOWED_ORIGINS.size
    ? ALLOWED_ORIGINS.has(origin)
    : sameOrigin(request, origin);
  if (origin && !allowed)
    return send(response, 403, { error: "Источник запроса не разрешён" });
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      ...(origin
        ? { "access-control-allow-origin": origin, vary: "Origin" }
        : {}),
      "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
      "access-control-allow-headers":
        "Content-Type, Authorization, X-Visitor-Token, X-API-Key",
      "access-control-max-age": "86400",
    });
    return response.end();
  }
  return route(request, response, origin).catch((error) => {
    console.error(error);
    send(
      response,
      error.status || 500,
      {
        error: error.status ? error.message : "Внутренняя ошибка сервиса",
      },
      origin,
    );
  });
});

server.listen(PORT, () =>
  console.log(`Чат слушает порт ${PORT}; база: ${DATABASE_PATH}`),
);

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const CONSENT_COPY = require("./consent-texts.json");
const { DatabaseSync } = require("node:sqlite");
const { URL } = require("node:url");
const {
  parseQuietHours,
  prepareTelegramPayload,
  isQuietTime,
} = require("./quiet-hours");
const { detectTask } = require("./task-intake");
const { bindingError, parseBindingCommand } = require("./telegram-binding");

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
  groupHelp:
    "Опишите задачу одним сообщением — Хью передаст её команде и ответит номером задачи.",
};
const OWNER_SCRIPT = {
  greeting: "Здравствуйте! Чем помочь по проекту?",
  fallback:
    "Готов помочь по проекту. Опишите задачу или уточните, что нужно сделать.",
};
const MODEL_SYSTEM_PROMPT =
  "Ты — русскоязычный ассистент Synapse Business. Отвечай кратко и " +
  "доброжелательно. Узнай вопрос, имя и телефон. Ничего не выдумывай.";
const OWNER_MODEL_SYSTEM_PROMPT =
  "Ты — русскоязычный рабочий ассистент владельца Synapse Business. " +
  "Помогай по проекту кратко, конкретно и по-деловому. Не спрашивай имя или телефон.";
const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const DATABASE_PATH = process.env.DATABASE_PATH || "/data/chat.sqlite";
const API_KEY = process.env.CHAT_API_KEY || process.env.API_KEY || "";
const ADMIN_KEY = process.env.CHAT_ADMIN_KEY || "";
const CRM_URL = process.env.CRM_URL || "";
const CRM_TASKS_URL =
  process.env.CRM_TASKS_URL || CRM_URL.replace(/\/leads\/?$/, "/tasks");
const CRM_DASHBOARD_URL = CRM_URL.replace(/\/leads\/?$/, "/dashboard");
const CRM_API_KEY = process.env.CRM_API_KEY || "";
const MODEL_API_URL = process.env.MODEL_API_URL || "";
const MODEL_API_KEY = process.env.MODEL_API_KEY || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const TELEGRAM_OWNER_ID = process.env.TELEGRAM_OWNER_ID || "";
const TELEGRAM_POLLING = process.env.TELEGRAM_POLLING === "1";
const CLIENT_BOARD_SECRET = process.env.CLIENT_BOARD_SECRET || "";
const CONSENT_SERVICE_KEY = process.env.CONSENT_SERVICE_KEY || "";
const CLIENT_BOARD_BASE_URL = (process.env.CLIENT_BOARD_BASE_URL || "https://{company}.synapsebusiness.ru/zadachi.html").trim();
const TELEGRAM_QUIET_HOURS = parseQuietHours(process.env);
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
  CREATE TABLE IF NOT EXISTS client_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT NOT NULL CHECK(company IN ('alvi','avokado','palitra')),
    title TEXT NOT NULL, why TEXT NOT NULL, instruction TEXT NOT NULL,
    link TEXT, due TEXT,
    status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','in_progress','done','blocked')),
    blocked_reason TEXT,
    assignee TEXT NOT NULL DEFAULT 'client' CHECK(assignee IN ('client','owner','team')),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','api')),
    notify_chat_id TEXT, last_notified_at TEXT
  );
  CREATE TABLE IF NOT EXISTS client_task_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES client_tasks(id) ON DELETE CASCADE,
    text TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS client_chats (
    company TEXT PRIMARY KEY CHECK(company IN ('alvi','avokado','palitra')),
    chat_id TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS client_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER REFERENCES client_tasks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, chat_id TEXT NOT NULL, text TEXT NOT NULL,
    created_at TEXT NOT NULL, sent_at TEXT
  );
  CREATE TABLE IF NOT EXISTS telegram_clients (
    telegram_id TEXT PRIMARY KEY, phone TEXT NOT NULL, name TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS consent_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id TEXT NOT NULL, phone TEXT NOT NULL,
    name TEXT, created_at TEXT NOT NULL, kind TEXT NOT NULL, granted INTEGER NOT NULL,
    text TEXT NOT NULL, text_sha256 TEXT NOT NULL, text_version INTEGER NOT NULL
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
addColumn("conversations", "owner_mode INTEGER NOT NULL DEFAULT 0");
addColumn("messages", "author_type TEXT");
addColumn("messages", "author_name TEXT");
addColumn("messages", "external_message_id TEXT");
addColumn("messages", "task_status TEXT NOT NULL DEFAULT ''");
addColumn("messages", "task_id INTEGER");
db.exec(`
  UPDATE messages SET author_type = CASE role WHEN 'operator' THEN 'owner' ELSE role END
    WHERE author_type IS NULL;
  UPDATE conversations SET last_message_at = updated_at WHERE last_message_at IS NULL;
  CREATE INDEX IF NOT EXISTS conversations_updated_idx ON conversations(updated_at);
  CREATE UNIQUE INDEX IF NOT EXISTS conversations_telegram_idx
    ON conversations(channel, external_chat_id) WHERE external_chat_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, id);
  CREATE INDEX IF NOT EXISTS client_tasks_company_idx ON client_tasks(company, status, updated_at);
  CREATE INDEX IF NOT EXISTS client_notifications_pending_idx ON client_notifications(sent_at, id);
  CREATE INDEX IF NOT EXISTS consent_events_telegram_idx ON consent_events(telegram_id, id);
  CREATE INDEX IF NOT EXISTS telegram_clients_phone_idx ON telegram_clients(phone);
`);

const insertWebConversation = db.prepare(`INSERT INTO conversations
  (created_at, updated_at, last_message_at, site, page, utm_source, utm_medium, utm_campaign,
   utm_term, utm_content, referrer, client_id, visitor_key, title, owner_mode)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
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
  external_message_id, task_status, task_id
  FROM messages WHERE conversation_id = ? ORDER BY id`);
const getPendingOwnerQuestions = db.prepare(`SELECT
  messages.id, messages.conversation_id, messages.created_at, messages.text
  FROM messages
  JOIN conversations ON conversations.id = messages.conversation_id
  WHERE conversations.owner_mode = 1
    AND messages.role = 'visitor'
    AND NOT EXISTS (
      SELECT 1 FROM messages AS replies
      WHERE replies.conversation_id = messages.conversation_id
        AND replies.id > messages.id
        AND replies.role IN ('assistant', 'operator')
    )
  ORDER BY messages.id`);
const getTelegramMessage = db.prepare(`SELECT * FROM messages
  WHERE conversation_id = ? AND external_message_id = ? ORDER BY id DESC LIMIT 1`);
const updateTask = db.prepare(
  "UPDATE messages SET task_status = ?, task_id = ? WHERE id = ?",
);
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

function isOwnerRequest(request) {
  return Boolean(API_KEY) && request.headers["x-api-key"] === API_KEY;
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
  const result = insertMessage.run(
    row.id,
    now,
    role,
    text,
    authorType,
    authorName,
    externalMessageId,
  );
  updateActivity.run(now, now, unread ? 1 : 0, row.id);
  return Number(result.lastInsertRowid);
}

function taskCompany(company) {
  if (company === "palitra") return "palitra-love";
  return company === "synapse" ? "" : company;
}

async function createTask(row, messageRow, detected, details) {
  if (!CRM_TASKS_URL || !CRM_API_KEY) {
    throw new Error("CRM_TASKS_URL или CRM_API_KEY не настроены");
  }
  const response = await fetch(CRM_TASKS_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": CRM_API_KEY },
    body: JSON.stringify({
      title: detected.title,
      description: details.description,
      companyCode: taskCompany(row.company),
      assigneeRole: "synapse",
      status: "inbox",
      priority: detected.priority,
      source: details.source,
      sourceRef: details.sourceRef,
      sourceAuthor: details.authorName,
      createdBy: "chat-intake",
    }),
  });
  if (!response.ok) throw new Error(`CRM вернула HTTP ${response.status}`);
  const body = await response.json();
  const taskId = body.task?.id;
  if (!taskId) throw new Error("CRM не вернула id задачи");
  updateTask.run(body.duplicate ? "duplicate" : "created", taskId, messageRow.id);
  return taskId;
}

async function intakeTelegramTask(row, messageRow, detected, details) {
  let taskId;
  try {
    taskId = await createTask(row, messageRow, detected, details);
  } catch (error) {
    updateTask.run("failed", null, messageRow.id);
    console.error("Не удалось создать задачу в CRM:", error.message);
    return;
  }
  try {
    await telegramRequest("sendMessage", {
      chat_id: row.external_chat_id,
      text: `Принял, записал в задачи №${taskId}.`,
      reply_parameters: { message_id: Number(details.messageId) },
    });
  } catch (error) {
    console.error("Не удалось подтвердить задачу в Telegram:", error.message);
  }
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

function metric(value, suffix = "") {
  return Number.isFinite(value) && value > 0
    ? `${new Intl.NumberFormat("ru-RU").format(value)}${suffix}`
    : "нет данных";
}

async function ownerSummary(row) {
  if (!CRM_DASHBOARD_URL || !CRM_TASKS_URL || !CRM_API_KEY) {
    return "Нет данных из CRM: подключение к CRM не настроено.";
  }
  const companyCode = taskCompany(row.company);
  const dashboardUrl = new URL(CRM_DASHBOARD_URL);
  dashboardUrl.searchParams.set("period", "30d");
  const tasksUrl = new URL(`${CRM_TASKS_URL.replace(/\/$/, "")}/summary`);
  if (companyCode) {
    dashboardUrl.searchParams.set("companyCode", companyCode);
    tasksUrl.searchParams.set("companyCode", companyCode);
  }
  const headers = { "x-api-key": CRM_API_KEY };
  const [dashboardResponse, tasksResponse] = await Promise.all([
    fetch(dashboardUrl, { headers }),
    fetch(tasksUrl, { headers }),
  ]);
  if (!dashboardResponse.ok || !tasksResponse.ok) {
    throw new Error(
      `CRM вернула HTTP ${dashboardResponse.status}/${tasksResponse.status}`,
    );
  }
  const [dashboard, tasks] = await Promise.all([
    dashboardResponse.json(),
    tasksResponse.json(),
  ]);
  const summary = dashboard.summary || {};
  const openTasks = [tasks.inbox, tasks.planned, tasks.inProgress]
    .filter(Number.isFinite)
    .reduce((total, value) => total + value, 0);
  return [
    "Сводка по проекту за последние 30 дней:",
    `Заявки: ${metric(summary.total)}`,
    `Задачи: ${metric(openTasks)}`,
    `Сделки: ${metric(summary.sales)}`,
    `Выручка: ${metric(summary.revenue, " ₽")}`,
  ].join("\n");
}

function scriptedReply(data, leadCreated) {
  if (leadCreated) return SCRIPT.accepted;
  if (!data.name) return SCRIPT.askName;
  if (!data.phone) return SCRIPT.askPhone;
  if (!data.firstQuestion) return SCRIPT.askQuestion;
  return SCRIPT.unknown;
}

async function modelReply(messages, owner = false) {
  const response = await fetch(MODEL_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${MODEL_API_KEY}`,
    },
    body: JSON.stringify({
      messages: [
        {
          role: "system",
          content: owner ? OWNER_MODEL_SYSTEM_PROMPT : MODEL_SYSTEM_PROMPT,
        },
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
  const preparedPayload = prepareTelegramPayload(
    method,
    payload,
    new Date(),
    TELEGRAM_QUIET_HOURS,
  );
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(preparedPayload),
    },
  );
  const body = await response.json();
  if (!response.ok || !body.ok)
    throw new Error(`Telegram ${method}: HTTP ${response.status}`);
  return body;
}

const CLIENT_COMPANIES = new Set(["alvi", "avokado", "palitra"]);
const CLIENT_STATUSES = new Set(["new", "in_progress", "done", "blocked"]);
const CLIENT_ASSIGNEES = new Set(["client", "owner", "team"]);

function clientToken(company) {
  return crypto.createHmac("sha256", CLIENT_BOARD_SECRET).update(company).digest("base64url");
}

function tokenCompany(token) {
  if (!CLIENT_BOARD_SECRET) fail(503, "Доска временно недоступна");
  for (const company of CLIENT_COMPANIES) {
    const expected = clientToken(company);
    if (token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return company;
  }
  fail(401, "Ссылка недействительна");
}

function boardUrl(company) {
  const separator = CLIENT_BOARD_BASE_URL.includes("?") ? "&" : "?";
  return `${CLIENT_BOARD_BASE_URL.replace("{company}", company)}${separator}t=${encodeURIComponent(clientToken(company))}`;
}

function clientTask(row, includeComments = false) {
  return {
    id: row.id, company: row.company, title: row.title, why: row.why,
    instruction: row.instruction, link: row.link, due: row.due, status: row.status,
    blocked_reason: row.blocked_reason, assignee: row.assignee,
    created_at: row.created_at, updated_at: row.updated_at, source: row.source,
    notify_chat_id: row.notify_chat_id, last_notified_at: row.last_notified_at,
    ...(includeComments ? { comments: db.prepare("SELECT id, text, author, created_at FROM client_task_comments WHERE task_id = ? ORDER BY id").all(row.id) } : {}),
  };
}

function getClientTask(id) {
  const task = db.prepare("SELECT * FROM client_tasks WHERE id = ?").get(id);
  if (!task) fail(404, "Задача не найдена");
  return task;
}

function taskId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) fail(400, "Некорректный идентификатор задачи");
  return id;
}

function notificationText(kind, task) {
  if (kind === "done") return `Спасибо, задача «${task.title}» закрыта.`;
  if (kind === "reminder") return `Напоминаем о задаче: ${task.title}. Зачем: ${task.why}. Открыть: ${boardUrl(task.company)}`;
  if (kind === "due") return `Изменён срок задачи «${task.title}»: ${task.due || "без срока"}. Открыть: ${boardUrl(task.company)}`;
  return `Новая задача для вас: ${task.title}. Зачем: ${task.why}. Открыть: ${boardUrl(task.company)}`;
}

function enqueueClientNotification(task, kind) {
  if (!CLIENT_BOARD_SECRET) return;
  const chatId = task.notify_chat_id || db.prepare("SELECT chat_id FROM client_chats WHERE company = ?").get(task.company)?.chat_id;
  if (!chatId) return;
  db.prepare("INSERT INTO client_notifications (task_id, kind, chat_id, text, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(task.id, kind, chatId, notificationText(kind, task), new Date().toISOString());
}

async function processClientNotifications() {
  if (!TELEGRAM_BOT_TOKEN || isQuietTime(new Date(), TELEGRAM_QUIET_HOURS)) return;
  const stale = db.prepare(`SELECT * FROM client_tasks t WHERE t.status = 'new'
    AND t.created_at <= ? AND NOT EXISTS (SELECT 1 FROM client_notifications n WHERE n.task_id=t.id AND n.kind='reminder')`).all(new Date(Date.now() - 86400000).toISOString());
  stale.forEach((task) => enqueueClientNotification(task, "reminder"));
  const pending = db.prepare("SELECT * FROM client_notifications WHERE sent_at IS NULL ORDER BY id LIMIT 20").all();
  for (const item of pending) {
    try {
      await telegramRequest("sendMessage", { chat_id: item.chat_id, text: item.text });
      const now = new Date().toISOString();
      db.prepare("UPDATE client_notifications SET sent_at = ? WHERE id = ?").run(now, item.id);
      if (item.task_id) db.prepare("UPDATE client_tasks SET last_notified_at = ? WHERE id = ?").run(now, item.task_id);
    } catch (error) { console.error("Не удалось уведомить клиента:", error.message); }
  }
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

function telegramName(from) {
  return [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.username || null;
}

function consentHash(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function recordConsent(from, kind, granted, text, version = CONSENT_COPY.version) {
  const telegramId = String(from?.id || "");
  const client = db.prepare("SELECT phone FROM telegram_clients WHERE telegram_id = ?").get(telegramId);
  if (!client) return false;
  db.prepare(`INSERT INTO consent_events
    (telegram_id, phone, name, created_at, kind, granted, text, text_sha256, text_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(telegramId, client.phone, telegramName(from), new Date().toISOString(), kind,
      granted ? 1 : 0, text, consentHash(text), version);
  return true;
}

async function showConsentChoices(chatId) {
  const labels = {
    personal_data: "Согласен на обработку данных",
    messages: "Согласен получать сообщения",
    terms: "Принимаю условия",
  };
  for (const kind of Object.keys(labels)) {
    await telegramRequest("sendMessage", {
      chat_id: chatId,
      text: CONSENT_COPY.texts[kind],
      reply_markup: { inline_keyboard: [[{
        text: labels[kind], callback_data: `consent:${kind}:${CONSENT_COPY.version}`,
      }]] },
    });
  }
}

async function handlePrivateTelegram(update) {
  const callback = update.callback_query;
  if (callback) {
    const match = String(callback.data || "").match(/^consent:(personal_data|messages|terms):(\d+)$/);
    if (!match) return { ok: true };
    const [, kind, rawVersion] = match;
    const version = Number(rawVersion);
    const text = callback.message?.text;
    const valid = version === CONSENT_COPY.version && text === CONSENT_COPY.texts[kind];
    const saved = valid && recordConsent(callback.from, kind, true, text, version);
    await telegramRequest("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: saved ? "Согласие сохранено" : "Сначала поделитесь контактом",
      show_alert: !saved,
    });
    return { ok: true };
  }
  const message = update.message;
  if (!message || message.chat?.type !== "private") return null;
  const chatId = String(message.chat.id);
  const text = String(message.text || "").trim();
  if (/^\/start(?:@\w+)?(?:\s|$)/iu.test(text)) {
    await telegramRequest("sendMessage", {
      chat_id: chatId,
      text: "Здравствуйте! Чтобы продолжить, поделитесь номером телефона кнопкой ниже.",
      reply_markup: { keyboard: [[{ text: "Поделиться контактом", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
    });
    return { ok: true };
  }
  if (message.contact) {
    if (String(message.contact.user_id || "") !== String(message.from?.id || "")) {
      await telegramRequest("sendMessage", { chat_id: chatId, text: "Можно отправить только свой контакт кнопкой «Поделиться контактом»." });
      return { ok: true };
    }
    const phone = String(message.contact.phone_number || "").trim();
    if (!phone) return { ok: true };
    db.prepare(`INSERT INTO telegram_clients (telegram_id, phone, name, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET phone=excluded.phone, name=excluded.name, updated_at=excluded.updated_at`)
      .run(String(message.from.id), phone, telegramName(message.from), new Date().toISOString());
    await showConsentChoices(chatId);
    return { ok: true };
  }
  const messagesRevocation = /^(?:стоп|\/(?:стоп|stop)(?:@\w+)?)$/iu.test(text);
  const personalDataRevocation = /^(?:отозвать|\/(?:отозвать|revoke)(?:@\w+)?)$/iu.test(text);
  const revocation = messagesRevocation
    ? ["messages", "messages_revoked"]
    : personalDataRevocation ? ["personal_data", "personal_data_revoked"] : null;
  if (revocation) {
    const [kind, textKey] = revocation;
    const reply = CONSENT_COPY.texts[textKey];
    const saved = recordConsent(message.from, kind, false, reply);
    await telegramRequest("sendMessage", { chat_id: chatId, text: saved ? reply : "Сначала поделитесь контактом через /start." });
    return { ok: true };
  }
  // A phone number typed as ordinary text is deliberately ignored.
  return { ok: true };
}

async function handleTelegramUpdate(update) {
  const privateResult = await handlePrivateTelegram(update);
  if (privateResult !== null) return privateResult;
  const message = update.message;
  if (!message || !["group", "supergroup"].includes(message.chat?.type)) {
    return { ok: true };
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
  if (!text) return { ok: true };
  if (/^Хью$/iu.test(text.trim())) {
    await telegramRequest("sendMessage", {
      chat_id: chatId,
      text: SCRIPT.groupHelp,
      reply_parameters: { message_id: Number(message.message_id) },
    });
    return { ok: true };
  }
  const bindingCommand = parseBindingCommand(text);
  if (bindingCommand?.type === "status") {
    const binding = db.prepare("SELECT company FROM client_chats WHERE chat_id = ?").get(chatId);
    const reply = binding
      ? `Эта группа привязана: ${binding.company.toUpperCase()}`
      : "Эта группа не привязана ни к одной компании";
    await telegramRequest("sendMessage", { chat_id: chatId, text: reply });
    return { ok: true, company: binding?.company || null };
  }
  if (bindingCommand?.type === "bind") {
    const replyError = bindingError(
      bindingCommand,
      TELEGRAM_OWNER_ID,
      message.from?.id,
    );
    if (!TELEGRAM_OWNER_ID.trim()) {
      console.error("Невозможно привязать Telegram-группу: TELEGRAM_OWNER_ID не настроен");
    }
    if (replyError) {
      await telegramRequest("sendMessage", {
        chat_id: chatId, text: replyError,
      });
      return { ok: true, company: null };
    }
    const company = bindingCommand.company;
    db.prepare(`INSERT INTO client_chats (company, chat_id, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(company) DO UPDATE SET chat_id=excluded.chat_id, updated_at=excluded.updated_at`)
      .run(company, chatId, new Date().toISOString());
    await telegramRequest("sendMessage", {
      chat_id: chatId,
      text: `Группа привязана: ${company.toUpperCase()}. Сюда будут приходить задачи и напоминания`,
    });
    return { ok: true, company };
  }
  if (/^\/company(?:@\w+)?\b/i.test(text)) {
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
    return { ok: true, company: company && isOwner ? company : row.company };
  }
  const author = telegramAuthor(message);
  if (text.startsWith("/") && !/^\/(?:task|задача)(?:@\w+)?(?=\s|:|$)/iu.test(text)) {
    return { ok: true };
  }
  let taskText = text;
  let taskMessageId = String(message.message_id);
  let taskAuthor = author;
  let detected = detectTask(text, { authorType: author.type, channel: "telegram" });
  const replyCommand = /^\/(?:task|задача)(?:@\w+)?\s*$/iu.test(text);
  const repliedAuthor = message.reply_to_message
    ? telegramAuthor(message.reply_to_message)
    : null;
  if (
    replyCommand &&
    author.type === "owner" &&
    repliedAuthor?.type !== "owner"
  ) {
    const replied = message.reply_to_message;
    taskText = replied.text || replied.caption || "";
    taskMessageId = String(replied.message_id);
    taskAuthor = repliedAuthor;
    detected = {
      kind: "explicit",
      title: taskText.split(/\r?\n/, 1)[0].trim().slice(0, 200),
      priority: /срочно/iu.test(taskText) ? "urgent" : "normal",
    };
  }
  const existingMessage = getTelegramMessage.get(
    row.id,
    String(message.message_id),
  );
  const insertedId = existingMessage
    ? existingMessage.id
    : addMessage(
        row,
        text,
        author.type,
        author.name,
        String(message.message_id),
        author.type !== "owner",
      );
  let taskMessage = existingMessage || { id: insertedId };
  if (replyCommand && message.reply_to_message) {
    taskMessage = getTelegramMessage.get(row.id, taskMessageId) || taskMessage;
  }
  if (!existingMessage && detected.kind && detected.title) {
    await intakeTelegramTask(row, taskMessage, detected, {
      text: taskText,
      description: `${taskText}\nГруппа: ${row.title}`,
      source: "telegram",
      sourceRef: `telegram:chat:${row.external_chat_id}:msg:${taskMessageId}`,
      authorName: taskAuthor.name,
      messageId: taskMessageId,
    });
  }
  if (!existingMessage && author.type !== "owner")
    await notifyOwner(getConversation.get(row.id), text);
  return { ok: true };
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
  return send(response, 200, await handleTelegramUpdate(update), origin);
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function pollTelegramUpdates() {
  try {
    await telegramRequest("deleteWebhook", {});
  } catch (error) {
    console.error("Не удалось удалить Telegram webhook перед опросом:", error.message);
  }

  let offset;
  while (true) {
    try {
      const result = await telegramRequest("getUpdates", {
        timeout: 30,
        ...(offset === undefined ? {} : { offset }),
      });
      if (!Array.isArray(result.result)) {
        throw new Error("Telegram getUpdates вернул некорректный ответ");
      }
      for (const update of result.result) {
        await handleTelegramUpdate(update);
        if (Number.isSafeInteger(update.update_id)) {
          offset = update.update_id + 1;
        }
      }
    } catch (error) {
      console.error("Ошибка Telegram polling:", error.message);
      await pause(5_000);
    }
  }
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
    const messageId = addMessage(row, text, "owner", "Владислав");
    const detected = detectTask(text, { authorType: "owner", channel: "web" });
    if (detected.kind && detected.title) {
      try {
        await createTask(row, { id: messageId }, detected, {
          description: `${text}\nДиалог: ${row.title || row.site || row.id}`,
          source: "chat",
          sourceRef: `chat:conversation:${row.id}:msg:${messageId}`,
          authorName: "Владислав",
        });
      } catch (error) {
        updateTask.run("failed", null, messageId);
        console.error("Не удалось создать задачу в CRM:", error.message);
      }
    }
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

async function clientTaskRoutes(request, response, url, origin) {
  let match = url.pathname.match(/^\/t\/([^/]+)$/);
  if (request.method === "GET" && match) {
    const company = tokenCompany(decodeURIComponent(match[1]));
    const rows = db.prepare("SELECT * FROM client_tasks WHERE company = ? AND assignee = 'client' ORDER BY status='done', due IS NULL, due, id DESC").all(company);
    return send(response, 200, { company, tasks: rows.map((row) => clientTask(row, true)) }, origin);
  }
  match = url.pathname.match(/^\/t\/([^/]+)\/(\d+)\/status$/);
  if (request.method === "POST" && match) {
    const company = tokenCompany(decodeURIComponent(match[1]));
    const task = getClientTask(taskId(match[2]));
    if (task.company !== company || task.assignee !== "client") fail(404, "Задача не найдена");
    const body = await readJson(request);
    if (!new Set(["done", "blocked"]).has(body.status)) fail(400, "Клиент может выбрать «done» или «blocked»");
    const comment = optionalString(body.comment, "comment");
    if (body.status === "blocked" && !comment) fail(400, "Расскажите, что не получилось");
    const now = new Date().toISOString();
    db.prepare("UPDATE client_tasks SET status=?, blocked_reason=?, updated_at=? WHERE id=?")
      .run(body.status, body.status === "blocked" ? comment : null, now, task.id);
    if (comment) db.prepare("INSERT INTO client_task_comments (task_id,text,author,created_at) VALUES (?,?,?,?)").run(task.id, comment, "client", now);
    const updated = getClientTask(task.id);
    if (body.status === "done" && task.status !== "done") enqueueClientNotification(updated, "done");
    void processClientNotifications();
    return send(response, 200, { task: clientTask(updated, true) }, origin);
  }
  fail(404, "Метод или адрес не найден");
}

async function clientTaskAdminRoutes(request, response, url, origin) {
  requireAdmin(request);
  if (request.method === "GET" && url.pathname === "/client-tasks") {
    const company = url.searchParams.get("company");
    if (company && !CLIENT_COMPANIES.has(company)) fail(400, "Неизвестная компания");
    const rows = company
      ? db.prepare("SELECT * FROM client_tasks WHERE company=? ORDER BY status='done', id DESC").all(company)
      : db.prepare("SELECT * FROM client_tasks ORDER BY status='done', id DESC").all();
    return send(response, 200, { tasks: rows.map((row) => clientTask(row, true)) }, origin);
  }
  if (request.method === "POST" && url.pathname === "/client-tasks") {
    const body = await readJson(request);
    const company = optionalString(body.company, "company");
    const title = optionalString(body.title, "title");
    const why = optionalString(body.why, "why");
    const instruction = optionalString(body.instruction, "instruction");
    if (!CLIENT_COMPANIES.has(company) || !title || !why || !instruction) fail(400, "Обязательны company, title, why и instruction");
    const status = body.status || "new", assignee = body.assignee || "client", source = body.source || "manual";
    if (!CLIENT_STATUSES.has(status) || !CLIENT_ASSIGNEES.has(assignee) || !new Set(["manual", "api"]).has(source)) fail(400, "Некорректный status, assignee или source");
    const due = optionalString(body.due, "due");
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) fail(400, "Срок должен иметь формат YYYY-MM-DD");
    const link = optionalString(body.link, "link");
    if (link && !/^https?:\/\//i.test(link)) fail(400, "Ссылка должна начинаться с http:// или https://");
    const now = new Date().toISOString();
    const result = db.prepare(`INSERT INTO client_tasks
      (company,title,why,instruction,link,due,status,blocked_reason,assignee,created_at,updated_at,source,notify_chat_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(company,title,why,instruction,link,due,status,
        optionalString(body.blocked_reason,"blocked_reason"),assignee,now,now,source,optionalString(body.notify_chat_id,"notify_chat_id"));
    const task = getClientTask(Number(result.lastInsertRowid));
    enqueueClientNotification(task, "new"); void processClientNotifications();
    return send(response, 201, { task: clientTask(task, true) }, origin);
  }
  let match = url.pathname.match(/^\/client-tasks\/(\d+)$/);
  if (request.method === "PATCH" && match) {
    const old = getClientTask(taskId(match[1])); const body = await readJson(request);
    const allowed = ["title","why","instruction","link","due","status","blocked_reason","assignee","notify_chat_id"];
    const next = { ...old };
    for (const key of allowed) if (Object.hasOwn(body, key)) next[key] = optionalString(body[key], key);
    if (!next.title || !next.why || !next.instruction || !CLIENT_STATUSES.has(next.status) || !CLIENT_ASSIGNEES.has(next.assignee)) fail(400, "Некорректные поля задачи");
    if (next.due && !/^\d{4}-\d{2}-\d{2}$/.test(next.due)) fail(400, "Срок должен иметь формат YYYY-MM-DD");
    if (next.link && !/^https?:\/\//i.test(next.link)) fail(400, "Ссылка должна начинаться с http:// или https://");
    db.prepare(`UPDATE client_tasks SET title=?,why=?,instruction=?,link=?,due=?,status=?,blocked_reason=?,assignee=?,notify_chat_id=?,updated_at=? WHERE id=?`)
      .run(next.title,next.why,next.instruction,next.link,next.due,next.status,next.blocked_reason,next.assignee,next.notify_chat_id,new Date().toISOString(),old.id);
    const task = getClientTask(old.id);
    if (old.due !== task.due) enqueueClientNotification(task, "due");
    if (old.status !== "done" && task.status === "done") enqueueClientNotification(task, "done");
    void processClientNotifications();
    return send(response, 200, { task: clientTask(task, true) }, origin);
  }
  match = url.pathname.match(/^\/client-tasks\/(\d+)\/comment$/);
  if (request.method === "POST" && match) {
    const task = getClientTask(taskId(match[1])); const body = await readJson(request);
    const comment = optionalString(body.comment || body.text, "comment"); if (!comment) fail(400, "Комментарий обязателен");
    db.prepare("INSERT INTO client_task_comments (task_id,text,author,created_at) VALUES (?,?,?,?)").run(task.id, comment, "owner", new Date().toISOString());
    return send(response, 201, { task: clientTask(getClientTask(task.id), true) }, origin);
  }
  fail(404, "Метод или адрес не найден");
}

async function route(request, response, origin) {
  const url = new URL(request.url, "http://localhost");
  if (request.method === "GET" && url.pathname === "/internal/consents") {
    if (!CONSENT_SERVICE_KEY || request.headers["x-service-key"] !== CONSENT_SERVICE_KEY)
      fail(401, "Неверный ключ сервиса");
    const telegramId = url.searchParams.get("telegram_id");
    const phone = url.searchParams.get("phone");
    if (!telegramId && !phone) fail(400, "Укажите phone или telegram_id");
    const clients = telegramId
      ? db.prepare("SELECT * FROM telegram_clients WHERE telegram_id = ?").all(telegramId)
      : db.prepare("SELECT * FROM telegram_clients WHERE phone = ?").all(phone);
    const people = clients.map((client) => {
      const events = db.prepare("SELECT * FROM consent_events WHERE telegram_id = ? ORDER BY id").all(client.telegram_id);
      const consents = {};
      for (const event of events) {
        consents[event.kind] = {
          granted: Boolean(event.granted),
          givenAt: event.granted ? event.created_at : null,
          changedAt: event.created_at,
          version: event.text_version,
        };
      }
      return { telegramId: client.telegram_id, phone: client.phone, name: client.name, consents };
    });
    return send(response, 200, { clients: people }, origin);
  }
  if (url.pathname.startsWith("/t/")) return clientTaskRoutes(request, response, url, origin);
  if (url.pathname === "/client-tasks" || url.pathname.startsWith("/client-tasks/")) return clientTaskAdminRoutes(request, response, url, origin);
  if (url.pathname.startsWith("/admin/"))
    return adminRoutes(request, response, url, origin);
  if (request.method === "POST" && url.pathname === "/telegram/webhook") {
    return handleWebhook(request, response, origin);
  }
  if (request.method === "GET" && url.pathname === "/owner/pending") {
    requireOperator(request);
    const pending = getPendingOwnerQuestions.all().map((message) => ({
      id: message.id,
      conversationId: message.conversation_id,
      createdAt: message.created_at,
      text: message.text,
    }));
    return send(response, 200, { pending }, origin);
  }
  if (request.method === "POST" && url.pathname === "/conversations") {
    const owner = isOwnerRequest(request);
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
      owner ? 1 : 0,
    ];
    const result = insertWebConversation.run(...values);
    const id = Number(result.lastInsertRowid);
    const greeting = owner ? OWNER_SCRIPT.greeting : SCRIPT.greeting;
    addMessage(getConversation.get(id), greeting, "assistant", "Хью");
    return send(
      response,
      201,
      { id, visitorToken: token, reply: greeting, owner },
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
    const owner = Boolean(row.owner_mode) && isOwnerRequest(request);
    if (!owner) requireVisitor(request, row);
    takeLimit(visitorLimits, row.id, 20, 60_000);
    takeLimit(ipLimits, clientIp(request), 60, 3_600_000);
    const body = await readJson(request);
    const text = optionalString(body.text, "text");
    if (!text) fail(400, "Поле «text» обязательно");
    addMessage(row, text, "visitor", null, null, true);
    if (!owner) await notifyOwner(getConversation.get(row.id), text);
    const all = getMessages.all(row.id);
    const data = owner ? null : contactData(all);
    let leadCreated = false;
    if (!owner && !row.lead_id && data.name && data.phone && data.firstQuestion) {
      try {
        leadCreated = await createLead(row, data);
      } catch (error) {
        console.error("Не удалось создать заявку в CRM:", error.message);
      }
    }
    let reply = owner ? OWNER_SCRIPT.fallback : scriptedReply(data, leadCreated);
    if (owner) {
      try {
        reply = await ownerSummary(row);
      } catch (error) {
        console.error("Не удалось получить сводку из CRM:", error.message);
        reply = "Нет данных из CRM: не удалось получить сводку по проекту.";
      }
    } else if (MODEL_API_URL && MODEL_API_KEY && !leadCreated) {
      try {
        reply = await modelReply(all, false);
      } catch (error) {
        console.error("Ошибка модели, используется сценарий:", error.message);
      }
    }
    addMessage(row, reply, "assistant", "Хью");
    return send(
      response,
      201,
      { reply, owner, conversation: serialize(getConversation.get(row.id)) },
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
        "Content-Type, Authorization, X-Visitor-Token, X-API-Key, X-Service-Key",
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
if (TELEGRAM_POLLING) void pollTelegramUpdates();
const clientNotificationTimer = setInterval(() => void processClientNotifications(), 60_000);
clientNotificationTimer.unref();
void processClientNotifications();

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

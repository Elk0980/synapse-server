"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { mkdtemp, rm } = require("node:fs/promises");
const { spawn } = require("node:child_process");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  return { status: response.status, body: await response.json() };
}

test("Telegram webhook creates idempotent tasks and survives CRM errors", async (t) => {
  const crmRequests = [];
  const telegramRequests = [];
  const sourceRefs = new Set();
  const mock = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("content-type", "application/json");
    if (request.url === "/telegram") {
      telegramRequests.push(body);
      response.end(JSON.stringify({ ok: true, result: {} }));
      return;
    }
    crmRequests.push(body);
    if (body.title.includes("сломать CRM")) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: "test" }));
      return;
    }
    const duplicate = sourceRefs.has(body.sourceRef);
    sourceRefs.add(body.sourceRef);
    response.statusCode = duplicate ? 200 : 201;
    response.end(JSON.stringify({ duplicate, task: { id: 700 + sourceRefs.size } }));
  });
  await listen(mock);
  const mockPort = mock.address().port;
  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-intake-"));
  const probe = http.createServer();
  await listen(probe);
  const chatPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(
    process.execPath,
    ["--experimental-sqlite", "-r", "./webhook-test-fetch.js", "server.js"],
    {
      cwd: __dirname,
      env: {
        ...process.env,
        PORT: String(chatPort),
        DATABASE_PATH: path.join(directory, "chat.sqlite"),
        API_KEY: "operator-test",
        CHAT_ADMIN_KEY: "admin-test",
        CRM_TASKS_URL: `http://127.0.0.1:${mockPort}/tasks`,
        CRM_API_KEY: "crm-test",
        TELEGRAM_BOT_TOKEN: "bot-test",
        TELEGRAM_WEBHOOK_SECRET: "hook-test",
        TELEGRAM_OWNER_ID: "1",
        MOCK_TELEGRAM_URL: `http://127.0.0.1:${mockPort}/telegram`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Чат слушает")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`chat exited ${code}: ${errors}`)));
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => mock.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const webhook = (message) =>
    jsonRequest(`http://127.0.0.1:${chatPort}/telegram/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "hook-test",
      },
      body: JSON.stringify({ update_id: message.message_id, message }),
    });
  const base = { chat: { id: -10, type: "group", title: "Клиенты" } };
  await webhook({
    ...base,
    message_id: 1,
    text: "/company alvi",
    from: { id: 1, first_name: "Владислав" },
  });
  telegramRequests.length = 0;

  const explicitMessage = {
    ...base,
    message_id: 2,
    text: "#задача Срочно обновить баннер",
    from: { id: 22, first_name: "Анна" },
  };
  assert.equal((await webhook(explicitMessage)).status, 200);
  assert.equal(crmRequests[0].companyCode, "alvi");
  assert.equal(crmRequests[0].sourceRef, "telegram:chat:-10:msg:2");
  assert.equal(crmRequests[0].sourceAuthor, "Анна");
  assert.equal(crmRequests[0].priority, "urgent");
  assert.ok(
    telegramRequests.some(
      (request) => request.chat_id === "-10" && request.text === "Записал в задачи #701",
    ),
  );

  telegramRequests.length = 0;
  assert.equal(
    (await webhook({
      ...base,
      message_id: 3,
      text: "Сделайте пожалуйста баннер на главной",
      from: { id: 23, first_name: "Иван" },
    })).status,
    200,
  );
  assert.equal(crmRequests.at(-1).status, "inbox");
  assert.equal(
    telegramRequests.some((request) => request.chat_id === "-10"),
    false,
  );
  await webhook({
    ...base,
    message_id: 30,
    text: "/задача",
    from: { id: 1, first_name: "Владислав" },
    reply_to_message: {
      ...base,
      message_id: 3,
      text: "Сделайте пожалуйста баннер на главной",
      from: { id: 23, first_name: "Иван" },
    },
  });
  assert.equal(crmRequests.at(-1).sourceRef, "telegram:chat:-10:msg:3");
  assert.equal(crmRequests.at(-1).sourceAuthor, "Иван");

  for (const [company, companyCode, messageId] of [
    ["avokado", "avokado", 31],
    ["palitra", "palitra-love", 33],
  ]) {
    await webhook({
      ...base,
      message_id: messageId,
      text: `/company ${company}`,
      from: { id: 1, first_name: "Владислав" },
    });
    await webhook({
      ...base,
      message_id: messageId + 1,
      text: `#задача Проверить код ${company}`,
      from: { id: 22, first_name: "Анна" },
    });
    assert.equal(crmRequests.at(-1).companyCode, companyCode);
  }

  assert.equal(
    (await webhook({
      ...base,
      message_id: 4,
      text: "#задача сломать CRM для проверки",
      from: { id: 24, first_name: "Олег" },
    })).status,
    200,
  );
  const admin = await jsonRequest(
    `http://127.0.0.1:${chatPort}/admin/conversations/1/messages`,
    { headers: { "x-api-key": "admin-test" } },
  );
  assert.equal(admin.body.messages.at(-1).task_status, "failed");

  assert.equal((await webhook(explicitMessage)).status, 200);
  assert.equal(crmRequests.at(-1).sourceRef, "telegram:chat:-10:msg:2");
  const retried = await jsonRequest(
    `http://127.0.0.1:${chatPort}/admin/conversations/1/messages`,
    { headers: { "x-api-key": "admin-test" } },
  );
  assert.equal(retried.body.messages[0].task_status, "duplicate");

  const webConversation = await jsonRequest(
    `http://127.0.0.1:${chatPort}/conversations`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Чат клиента" }),
    },
  );
  const adminReply = await jsonRequest(
    `http://127.0.0.1:${chatPort}/admin/conversations/` +
      `${webConversation.body.id}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "admin-test" },
      body: JSON.stringify({ text: "#задача Подготовить предложение" }),
    },
  );
  assert.equal(adminReply.status, 201);
  assert.equal(crmRequests.at(-1).source, "chat");
  assert.match(crmRequests.at(-1).sourceRef, /^chat:conversation:2:msg:\d+$/);

  const requestCount = crmRequests.length;
  const emptyAdminTask = await jsonRequest(
    `http://127.0.0.1:${chatPort}/admin/conversations/` +
      `${webConversation.body.id}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "admin-test" },
      body: JSON.stringify({ text: "#задача" }),
    },
  );
  assert.equal(emptyAdminTask.status, 201);
  assert.equal(crmRequests.length, requestCount);
});

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

function waitFor(check, timeout = 8_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started >= timeout) {
        clearInterval(timer);
        reject(new Error("Истекло время ожидания условия"));
      }
    }, 20);
  });
}

async function startChat(t, environment) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-polling-"));
  const probe = http.createServer();
  await listen(probe);
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(
    process.execPath,
    ["--experimental-sqlite", "-r", "./webhook-test-fetch.js", "server.js"],
    {
      cwd: __dirname,
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_PATH: path.join(directory, "chat.sqlite"),
        API_KEY: "operator-test",
        CHAT_ADMIN_KEY: "admin-test",
        TELEGRAM_BOT_TOKEN: "bot-test",
        TELEGRAM_WEBHOOK_SECRET: "hook-test",
        TELEGRAM_OWNER_ID: "1",
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Чат слушает")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`chat exited ${code}: ${stderr}`)));
  });
  t.after(async () => {
    child.kill("SIGTERM");
    if (child.exitCode === null) {
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { child, port, stderr: () => stderr };
}

test("polling processes updates like webhook, advances offset, and retries network errors", async (t) => {
  const update = {
    update_id: 105,
    message: {
      message_id: 55,
      text: "#задача Обновить баннер",
      chat: { id: -10, type: "group", title: "Клиенты" },
      from: { id: 22, first_name: "Анна" },
    },
  };
  const telegramCalls = [];
  const crmCalls = [];
  let failFirstPoll = true;
  let delivered = false;
  const mock = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("content-type", "application/json");
    if (request.url === "/telegram") {
      telegramCalls.push(body);
      if (body.timeout === 30) {
        if (failFirstPoll) {
          failFirstPoll = false;
          request.socket.destroy();
          return;
        }
        const result = delivered ? [] : [update];
        delivered = true;
        response.end(JSON.stringify({ ok: true, result }));
        return;
      }
      response.end(JSON.stringify({ ok: true, result: {} }));
      return;
    }
    crmCalls.push(body);
    response.statusCode = 201;
    response.end(JSON.stringify({ task: { id: 701 } }));
  });
  await listen(mock);
  t.after(() => new Promise((resolve) => mock.close(resolve)));
  const mockUrl = `http://127.0.0.1:${mock.address().port}`;

  const webhook = await startChat(t, {
    CRM_TASKS_URL: `${mockUrl}/tasks`,
    CRM_API_KEY: "crm-test",
    MOCK_TELEGRAM_URL: `${mockUrl}/telegram`,
    TELEGRAM_POLLING: "0",
  });
  const webhookResponse = await fetch(
    `http://127.0.0.1:${webhook.port}/telegram/webhook`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "hook-test",
      },
      body: JSON.stringify(update),
    },
  );
  assert.equal(webhookResponse.status, 200);
  await waitFor(() => crmCalls.length === 1 && telegramCalls.some((call) => call.text));
  const webhookTask = crmCalls[0];
  const webhookConfirmation = telegramCalls.find((call) => call.text);

  telegramCalls.length = 0;
  const polling = await startChat(t, {
    CRM_TASKS_URL: `${mockUrl}/tasks`,
    CRM_API_KEY: "crm-test",
    MOCK_TELEGRAM_URL: `${mockUrl}/telegram`,
    TELEGRAM_POLLING: "1",
  });
  await waitFor(() => crmCalls.length === 2 && telegramCalls.some((call) => call.offset === 106));

  assert.deepEqual(crmCalls[1], webhookTask);
  assert.deepEqual(telegramCalls.find((call) => call.text), webhookConfirmation);
  assert.deepEqual(telegramCalls[0], {});
  assert.equal(Object.hasOwn(telegramCalls[0], "drop_pending_updates"), false);
  assert.ok(telegramCalls.some((call) => call.timeout === 30 && !Object.hasOwn(call, "offset")));
  assert.ok(telegramCalls.some((call) => call.timeout === 30 && call.offset === 106));
  assert.match(polling.stderr(), /Ошибка Telegram polling:/);
  assert.equal(polling.child.exitCode, null);
});

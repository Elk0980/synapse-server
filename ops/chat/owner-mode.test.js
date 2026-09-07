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

async function request(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("owner mode skips contact intake and leaves the visitor flow unchanged", async (t) => {
  const crmRequests = [];
  let hasSummaryData = true;
  const crm = http.createServer((request, response) => {
    crmRequests.push({ method: request.method, url: request.url });
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url.startsWith("/dashboard")) {
      return response.end(JSON.stringify({
        summary: hasSummaryData
          ? { total: 12, sales: 3, revenue: 125000 }
          : { total: 0, sales: 0, revenue: 0 },
      }));
    }
    if (request.url.startsWith("/tasks/summary")) {
      return response.end(JSON.stringify(hasSummaryData
        ? { inbox: 2, planned: 1, inProgress: 1, done: 5 }
        : { inbox: 0, planned: 0, inProgress: 0, done: 0 }));
    }
    response.statusCode = 404;
    return response.end(JSON.stringify({ error: "not found" }));
  });
  await listen(crm);

  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-owner-"));
  const probe = http.createServer();
  await listen(probe);
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ["--experimental-sqlite", "server.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: path.join(directory, "chat.sqlite"),
      API_KEY: "",
      CHAT_API_KEY: "owner-secret",
      CRM_URL: `http://127.0.0.1:${crm.address().port}/leads`,
      CRM_API_KEY: "crm-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
    await new Promise((resolve) => crm.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  const ownerHeaders = { "x-api-key": "owner-secret" };
  const ownerConversation = await request(
    `${base}/conversations`,
    {},
    ownerHeaders,
  );
  assert.equal(ownerConversation.status, 201);
  assert.equal(ownerConversation.body.owner, true);
  assert.match(ownerConversation.body.reply, /чем помочь по проекту/i);

  const ownerReply = await request(
    `${base}/conversations/${ownerConversation.body.id}/messages`,
    { text: "Я Владислав, мой телефон +7 999 123-45-67. Нужен план проекта." },
    ownerHeaders,
  );
  assert.equal(ownerReply.status, 201);
  assert.equal(ownerReply.body.owner, true);
  assert.match(ownerReply.body.reply, /Заявки: 12/);
  assert.match(ownerReply.body.reply, /Задачи: 4/);
  assert.match(ownerReply.body.reply, /Сделки: 3/);
  assert.match(ownerReply.body.reply, /Выручка: 125.?000 ₽/);
  assert.deepEqual(crmRequests.map(({ method }) => method), ["GET", "GET"]);

  hasSummaryData = false;
  const emptyOwnerReply = await request(
    `${base}/conversations/${ownerConversation.body.id}/messages`,
    { text: "А сейчас?" },
    ownerHeaders,
  );
  assert.equal(emptyOwnerReply.status, 201);
  assert.equal((emptyOwnerReply.body.reply.match(/нет данных/gi) || []).length, 4);

  const visitorConversation = await request(`${base}/conversations`, {});
  assert.equal(visitorConversation.body.owner, false);
  assert.match(visitorConversation.body.reply, /как я могу к вам обращаться/i);
  const visitorReply = await request(
    `${base}/conversations/${visitorConversation.body.id}/messages`,
    { text: "Сколько стоит внедрение?" },
    { authorization: `Bearer ${visitorConversation.body.visitorToken}` },
  );
  assert.equal(visitorReply.body.owner, false);
  assert.match(visitorReply.body.reply, /как к вам обращаться/i);
  assert.equal(crmRequests.length, 4);
});

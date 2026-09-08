"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { mkdtemp, rm } = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const copy = require("./consent-texts.json");

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }

test("private Telegram consents are explicit, auditable and protected", async (t) => {
  const telegram = [];
  const mock = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    telegram.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, result: {} }));
  });
  await listen(mock);
  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-consent-"));
  const databasePath = path.join(directory, "chat.sqlite");
  const probe = http.createServer(); await listen(probe);
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ["--experimental-sqlite", "-r", "./webhook-test-fetch.js", "server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), DATABASE_PATH: databasePath, API_KEY: "api",
      TELEGRAM_BOT_TOKEN: "bot", TELEGRAM_WEBHOOK_SECRET: "hook", CONSENT_SERVICE_KEY: "cabinet",
      MOCK_TELEGRAM_URL: `http://127.0.0.1:${mock.address().port}/telegram` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = ""; child.stderr.on("data", (chunk) => { errors += chunk; });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("Чат слушает")) resolve(); });
    child.once("exit", (code) => reject(new Error(`chat exited ${code}: ${errors}`)));
  });
  t.after(async () => { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => mock.close(resolve)); await rm(directory, { recursive: true, force: true }); });

  const webhook = (body) => fetch(`http://127.0.0.1:${port}/telegram/webhook`, { method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "hook" },
    body: JSON.stringify(body) });
  const from = { id: 77, first_name: "Анна", last_name: "Иванова" };
  await webhook({ message: { message_id: 1, chat: { id: 77, type: "private" }, from, text: "/start" } });
  let db = new DatabaseSync(databasePath);
  assert.equal(db.prepare("SELECT count(*) total FROM consent_events").get().total, 0, "/start is not consent");
  assert.equal(telegram.at(-1).reply_markup.keyboard[0][0].request_contact, true);
  await webhook({ message: { message_id: 2, chat: { id: 77, type: "private" }, from, text: "+79990000000" } });
  assert.equal(db.prepare("SELECT count(*) total FROM telegram_clients").get().total, 0, "typed phone is ignored");
  await webhook({ message: { message_id: 3, chat: { id: 77, type: "private" }, from,
    contact: { user_id: 77, phone_number: "+79990000000" } } });
  const consentMessages = telegram.slice(-3);
  assert.equal(consentMessages.length, 3);
  for (const [index, kind] of ["personal_data", "messages", "terms"].entries()) {
    const shown = consentMessages[index];
    await webhook({ callback_query: { id: `cb-${index}`, from,
      data: `consent:${kind}:${copy.version}`, message: { chat: { id: 77, type: "private" }, text: shown.text } } });
  }
  const rows = db.prepare("SELECT * FROM consent_events ORDER BY id").all();
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.text, copy.texts[row.kind]);
    assert.equal(row.text_sha256, crypto.createHash("sha256").update(row.text).digest("hex"));
    assert.equal(row.text_version, copy.version);
    assert.equal(row.phone, "+79990000000"); assert.equal(row.name, "Анна Иванова");
  }
  await webhook({ message: { message_id: 4, chat: { id: 77, type: "private" }, from, text: "стоп" } });
  await webhook({ message: { message_id: 5, chat: { id: 77, type: "private" }, from, text: "отозвать" } });
  assert.deepEqual(db.prepare("SELECT kind, granted FROM consent_events ORDER BY id DESC LIMIT 2").all().map((row) => ({ ...row })),
    [{ kind: "personal_data", granted: 0 }, { kind: "messages", granted: 0 }]);
  for (const [messageId, text] of [
    [6, "/стоп"], [7, "/СТОП@SynapseBot"], [8, "/stop"], [9, "/StOp@synapse_bot"],
  ]) {
    await webhook({ message: { message_id: messageId, chat: { id: 77, type: "private" }, from, text } });
  }
  assert.equal(db.prepare("SELECT count(*) total FROM consent_events WHERE kind = 'messages' AND granted = 0").get().total, 5);
  for (const [messageId, text] of [
    [10, "/отозвать"], [11, "/ОТОЗВАТЬ@SynapseBot"], [12, "/revoke"], [13, "/ReVoKe@synapse_bot"],
  ]) {
    await webhook({ message: { message_id: messageId, chat: { id: 77, type: "private" }, from, text } });
  }
  assert.equal(db.prepare("SELECT count(*) total FROM consent_events WHERE kind = 'personal_data' AND granted = 0").get().total, 5);
  const denied = await fetch(`http://127.0.0.1:${port}/internal/consents?telegram_id=77`);
  assert.equal(denied.status, 401);
  const allowed = await fetch(`http://127.0.0.1:${port}/internal/consents?phone=${encodeURIComponent("+79990000000")}`,
    { headers: { "x-service-key": "cabinet" } });
  assert.equal(allowed.status, 200);
  const result = await allowed.json();
  assert.equal(result.clients[0].consents.messages.granted, false);
  assert.equal(result.clients[0].consents.personal_data.granted, false);
  assert.equal(result.clients[0].consents.terms.granted, true);
  db.close();
});

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

test("private Telegram chat accepts every consent revocation spelling", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-consent-"));
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
      CHAT_API_KEY: "test-key",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
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
    await rm(directory, { recursive: true, force: true });
  });

  for (const [index, text] of [
    "стоп",
    "/стоп",
    "отозвать",
    "/отозвать",
    "/stop",
    "/revoke",
    "СТОП",
    "/Отозвать@SynapseBot",
    "/STOP@synapse_bot",
    "/ReVoKe@SynapseBot",
  ].entries()) {
    const response = await fetch(`http://127.0.0.1:${port}/telegram/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret",
      },
      body: JSON.stringify({
        update_id: index,
        message: {
          message_id: index + 1,
          chat: { id: 42, type: "private" },
          text,
        },
      }),
    });
    assert.equal(response.status, 200, text);
    assert.deepEqual(await response.json(), {
      ok: true,
      consent: "revoked",
    }, text);
  }
});

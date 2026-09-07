#!/usr/bin/env node
"use strict";

const { readFile } = require("node:fs/promises");
const path = require("node:path");

const apiKey = process.env.CHAT_ADMIN_KEY || "";
const baseUrl = process.env.CHAT_INTERNAL_URL || `http://127.0.0.1:${process.env.PORT || "8080"}`;
const seedPath = path.join(__dirname, "seed-client-tasks.json");
const dryRun = process.argv.includes("--dry-run");

async function request(method, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${method} ${pathname}: ${response.status} ${result.error || "ошибка"}`);
  return result;
}

async function main() {
  if (!apiKey) throw new Error("CHAT_ADMIN_KEY не задан в окружении контейнера");
  let seed;
  try {
    seed = await readFile(seedPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        `Файл с задачами не найден: ${seedPath}. ` +
        "Создайте его рядом со скриптом, скопировав seed-client-tasks.example.json в seed-client-tasks.json.",
      );
    }
    throw error;
  }
  const tasks = JSON.parse(seed);
  if (!Array.isArray(tasks)) throw new Error("seed-client-tasks.json должен содержать массив");
  const current = (await request("GET", "/client-tasks")).tasks;
  const byKey = new Map(current.map((task) => [`${task.company}\0${task.title}`, task]));
  for (const item of tasks) {
    const payload = {
      company: item.company, title: item.title, why: item.why,
      instruction: item.instruction, link: item.link || null,
      due: item.due || null, assignee: item.assignee || "client",
    };
    const existing = byKey.get(`${item.company}\0${item.title}`);
    if (existing) {
      if (!dryRun) await request("PATCH", `/client-tasks/${existing.id}`, payload);
      console.log(`${dryRun ? "будет обновлено" : "обновлено"}: ${item.company} — ${item.title}`);
    } else {
      if (!dryRun) {
        const created = await request("POST", "/client-tasks", payload);
        byKey.set(`${item.company}\0${item.title}`, created.task);
      }
      console.log(`${dryRun ? "будет создано" : "создано"}: ${item.company} — ${item.title}`);
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

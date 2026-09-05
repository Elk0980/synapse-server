"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { detectTask } = require("./task-intake");

const telegramVisitor = { authorType: "visitor", channel: "telegram" };

test("explicit task markers and titles", () => {
  const cases = [
    ["#задача Сделать отчёт", "Сделать отчёт"],
    ["ЗАДАЧА: Обновить цены", "Обновить цены"],
    ["/task publish news", "publish news"],
    ["/task@helper_bot publish news", "publish news"],
    ["/задача@helper_bot: Исправить форму", "Исправить форму"],
  ];
  for (const [text, title] of cases) {
    assert.deepEqual(detectTask(text, telegramVisitor), {
      kind: "explicit",
      title,
      priority: "normal",
    });
  }
});

test("explicit title uses only the first line and at most 200 characters", () => {
  const suffix = "я".repeat(220);
  const result = detectTask(`#задача ${suffix}\nописание`, telegramVisitor);
  assert.equal(result.title, suffix.slice(0, 200));
});

test("request phrases create heuristic tasks for Telegram visitors", () => {
  const phrases = [
    "сделайте пожалуйста баннер на главной",
    "Нужно добавить новый телефон в контакты",
    "Можно ли обновить фотографии сотрудников",
    "Хочу чтобы форма открывалась быстрее",
    "Давайте настроим новую рекламную кампанию",
  ];
  for (const text of phrases) {
    assert.equal(detectTask(text, telegramVisitor).kind, "heuristic", text);
  }
});

test("ordinary question is not a task", () => {
  const result = detectTask("Здравствуйте, сколько стоит массаж?", telegramVisitor);
  assert.equal(result.kind, null);
});

test("marker must be a complete token", () => {
  assert.equal(detectTask("задачами займёмся позже", telegramVisitor).kind, null);
  assert.equal(
    detectTask("Задача выполнена, спасибо всем", telegramVisitor).kind,
    null,
  );
});

test("short request is not a task", () => {
  assert.equal(detectTask("надо лого", telegramVisitor).kind, null);
});

test("owner text requires an explicit marker", () => {
  const context = { authorType: "owner", channel: "telegram" };
  assert.equal(detectTask("Нужно обновить большой баннер", context).kind, null);
  assert.equal(detectTask("#задача Обновить баннер", context).kind, "explicit");
});

test("web visitors are treated as leads, not heuristic tasks", () => {
  const context = { authorType: "visitor", channel: "web" };
  assert.equal(detectTask("Срочно сделайте новый баннер", context).kind, null);
  assert.equal(detectTask("#задача Сделать баннер", context).kind, "explicit");
});

test("urgent priority follows the task rules", () => {
  assert.equal(
    detectTask("#задача Срочно заменить телефон", telegramVisitor).priority,
    "urgent",
  );
  assert.equal(
    detectTask("Форма не работает уже несколько дней", telegramVisitor).priority,
    "urgent",
  );
  assert.equal(
    detectTask("Нужно обновить обычный текст", telegramVisitor).priority,
    "normal",
  );
});

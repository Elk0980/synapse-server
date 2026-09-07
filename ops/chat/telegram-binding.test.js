"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { bindingError, parseBindingCommand } = require("./telegram-binding");

test("разбирает /привязать по тексту без Telegram entities", () => {
  assert.deepEqual(parseBindingCommand("/привязать alvi"), {
    type: "bind", company: "alvi", argument: "alvi",
  });
  assert.deepEqual(parseBindingCommand(" /ПРИВЯЗАТЬ@Synapse_SB_Bot   AvOkAdO  "), {
    type: "bind", company: "avokado", argument: "avokado",
  });
  assert.deepEqual(parseBindingCommand("/привязать    palitra"), {
    type: "bind", company: "palitra", argument: "palitra",
  });
});

test("возвращает неизвестную компанию для содержательного ответа", () => {
  assert.deepEqual(parseBindingCommand("/привязать romashka"), {
    type: "bind", company: null, argument: "romashka",
  });
  assert.deepEqual(parseBindingCommand("/привязать"), {
    type: "bind", company: null, argument: "",
  });
});

test("разбирает команду проверки и игнорирует адресованную другому боту", () => {
  assert.deepEqual(parseBindingCommand(" /ПРИВЯЗКА@SYNAPSE_SB_BOT "), { type: "status" });
  assert.equal(parseBindingCommand("/привязать@other_bot alvi"), null);
});

test("объясняет отсутствие настроенного владельца вместо молчания", () => {
  const command = parseBindingCommand("/привязать alvi");
  assert.equal(
    bindingError(command, "", "123"),
    "Владелец Synapse не настроен: задайте TELEGRAM_OWNER_ID",
  );
});

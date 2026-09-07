"use strict";

const CLIENT_COMPANIES = ["alvi", "avokado", "palitra"];
const BOT_USERNAME = "synapse_sb_bot";

function parseBindingCommand(text) {
  if (typeof text !== "string") return null;
  const match = text.match(/^\s*\/(привязать|привязка)(?:@([\w]+))?(?:\s+(.*?))?\s*$/iu);
  if (!match || (match[2] && match[2].toLowerCase() !== BOT_USERNAME)) return null;
  const command = match[1].toLowerCase();
  const argument = (match[3] || "").trim().toLowerCase();
  if (command === "привязка") return argument ? null : { type: "status" };
  return {
    type: "bind",
    company: CLIENT_COMPANIES.includes(argument) ? argument : null,
    argument,
  };
}

function bindingError(command, ownerId, senderId) {
  if (command?.type !== "bind") return null;
  if (!String(ownerId || "").trim())
    return "Владелец Synapse не настроен: задайте TELEGRAM_OWNER_ID";
  if (String(senderId || "") !== String(ownerId))
    return "Команда доступна только владельцу Synapse";
  if (!command.company)
    return "Неизвестная компания. Допустимые: alvi, avokado, palitra";
  return null;
}

module.exports = { BOT_USERNAME, CLIENT_COMPANIES, bindingError, parseBindingCommand };

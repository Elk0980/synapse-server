"use strict";

const REQUEST_PATTERN = new RegExp(
  "(?:сделай(?:те)?|нужно|надо|добавь(?:те)?|убери(?:те)?|" +
    "поменяй(?:те)?|замени(?:те)?|исправь(?:те)?|поправь(?:те)?|" +
    "обнови(?:те)?|запусти(?:те)?|настрой(?:те)?|можно ли|хочу чтобы|" +
    "давайте|прошу|срочно|не работает|не открывается)",
  "iu",
);
const EXPLICIT_PATTERN = new RegExp(
  "^(?:#задача(?=\\s|:|$)\\s*:?|задача:|" +
    "\\/(?:task|задача)(?:@\\w+)?(?=\\s|:|$)\\s*:?)" +
    "[\\s\\u00a0]*",
  "iu",
);

function oneLine(text, maximum) {
  return text.split(/\r?\n/, 1)[0].replace(/\s+/gu, " ").trim().slice(0, maximum);
}

function detectTask(text, { authorType, channel }) {
  if (typeof text !== "string") return { kind: null, title: "", priority: "normal" };
  const explicit = text.match(EXPLICIT_PATTERN);
  const urgent = /(?:срочно|не работает)/iu.test(text);
  if (explicit) {
    return {
      kind: "explicit",
      title: oneLine(text.slice(explicit[0].length), 200),
      priority: /срочно/iu.test(text) ? "urgent" : "normal",
    };
  }
  const normalized = text.replace(/\s+/gu, " ").trim();
  const eligible = channel === "telegram" && authorType !== "owner";
  if (!eligible || normalized.length < 12 || !REQUEST_PATTERN.test(normalized)) {
    return { kind: null, title: "", priority: "normal" };
  }
  return {
    kind: "heuristic",
    title: normalized.slice(0, 120),
    priority: urgent ? "urgent" : "normal",
  };
}

module.exports = { detectTask };

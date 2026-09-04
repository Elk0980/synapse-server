"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TIME_ZONE,
  parseQuietHours,
  isQuietTime,
  prepareTelegramPayload,
} = require("./quiet-hours");

const defaults = parseQuietHours({});

function at(iso) {
  return new Date(iso);
}

test("defaults are 22:00-09:00", () => {
  assert.equal(defaults.start, "22:00");
  assert.equal(defaults.end, "09:00");
  assert.equal(TIME_ZONE, "Europe/Moscow");
});

test("default interval has exact Moscow boundaries", () => {
  const cases = [
    ["2026-01-15T18:59:59Z", false, "21:59:59"],
    ["2026-01-15T19:00:00Z", true, "22:00:00"],
    ["2026-01-15T20:59:59Z", true, "23:59:59"],
    ["2026-01-15T21:00:00Z", true, "00:00:00"],
    ["2026-01-16T05:59:59Z", true, "08:59:59"],
    ["2026-01-16T06:00:00Z", false, "09:00:00"],
    ["2026-01-16T09:00:00Z", false, "12:00:00"],
  ];
  for (const [iso, expected, label] of cases) {
    assert.equal(isQuietTime(at(iso), defaults), expected, label);
  }
});

test("Moscow conversion is identical on winter and summer dates in 2026", () => {
  assert.equal(isQuietTime(at("2026-01-15T19:00:00Z"), defaults), true);
  assert.equal(isQuietTime(at("2026-07-15T19:00:00Z"), defaults), true);
  assert.equal(isQuietTime(at("2026-01-16T06:00:00Z"), defaults), false);
  assert.equal(isQuietTime(at("2026-07-16T06:00:00Z"), defaults), false);
});

test("host TZ does not affect Moscow result", () => {
  const originalTimezone = process.env.TZ;
  try {
    process.env.TZ = "Pacific/Honolulu";
    const honolulu = isQuietTime(at("2026-07-15T19:00:00Z"), defaults);
    process.env.TZ = "Asia/Tokyo";
    const tokyo = isQuietTime(at("2026-07-15T19:00:00Z"), defaults);
    assert.equal(honolulu, true);
    assert.equal(tokyo, true);
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

test("an interval across midnight supports custom minutes", () => {
  const settings = parseQuietHours({
    TELEGRAM_SILENT_START: "23:30",
    TELEGRAM_SILENT_END: "07:15",
  });
  assert.equal(isQuietTime(at("2026-01-15T20:29:59Z"), settings), false);
  assert.equal(isQuietTime(at("2026-01-15T20:30:00Z"), settings), true);
  assert.equal(isQuietTime(at("2026-01-16T04:14:59Z"), settings), true);
  assert.equal(isQuietTime(at("2026-01-16T04:15:00Z"), settings), false);
});

test("an interval within one day is half-open", () => {
  const settings = parseQuietHours({
    TELEGRAM_SILENT_START: "01:00",
    TELEGRAM_SILENT_END: "03:00",
  });
  assert.equal(isQuietTime(at("2026-01-15T21:59:59Z"), settings), false);
  assert.equal(isQuietTime(at("2026-01-15T22:00:00Z"), settings), true);
  assert.equal(isQuietTime(at("2026-01-15T23:59:59Z"), settings), true);
  assert.equal(isQuietTime(at("2026-01-16T00:00:00Z"), settings), false);
});

test("empty settings use defaults", () => {
  assert.deepEqual(
    parseQuietHours({
      TELEGRAM_SILENT_START: "",
      TELEGRAM_SILENT_END: "",
    }),
    defaults,
  );
});

test("invalid non-empty settings identify only the invalid variable", () => {
  for (const value of ["22", "9:00", "24:00", "22:60", "night"]) {
    assert.throws(
      () => parseQuietHours({ TELEGRAM_SILENT_START: value }),
      (error) => {
        assert.match(error.message, /TELEGRAM_SILENT_START/);
        assert.doesNotMatch(error.message, /process\.env/);
        return true;
      },
      value,
    );
  }
  assert.throws(
    () => parseQuietHours({ TELEGRAM_SILENT_END: "text" }),
    /TELEGRAM_SILENT_END/,
  );
});

test("equal boundaries are rejected", () => {
  assert.throws(
    () =>
      parseQuietHours({
        TELEGRAM_SILENT_START: "10:30",
        TELEGRAM_SILENT_END: "10:30",
      }),
    /TELEGRAM_SILENT_START.*TELEGRAM_SILENT_END/,
  );
});

test("night sendMessage is copied and forced silent without losing fields", () => {
  const payload = {
    chat_id: "123",
    text: "Hello",
    parse_mode: "HTML",
    disable_notification: false,
  };
  const prepared = prepareTelegramPayload(
    "sendMessage",
    payload,
    at("2026-01-15T19:00:00Z"),
    defaults,
  );
  assert.notStrictEqual(prepared, payload);
  assert.deepEqual(prepared, {
    chat_id: "123",
    text: "Hello",
    parse_mode: "HTML",
    disable_notification: true,
  });
  assert.equal(payload.disable_notification, false);
});

test("day sendMessage without notification field stays unchanged", () => {
  const payload = { chat_id: "123", text: "Hello", protect_content: true };
  const prepared = prepareTelegramPayload(
    "sendMessage",
    payload,
    at("2026-01-16T09:00:00Z"),
    defaults,
  );
  assert.notStrictEqual(prepared, payload);
  assert.deepEqual(prepared, payload);
  assert.equal(Object.hasOwn(prepared, "disable_notification"), false);
});

test("other Telegram methods are copied without changes at night", () => {
  const payload = { chat_id: "123", message_id: 42 };
  const prepared = prepareTelegramPayload(
    "deleteMessage",
    payload,
    at("2026-01-15T19:00:00Z"),
    defaults,
  );
  assert.notStrictEqual(prepared, payload);
  assert.deepEqual(prepared, payload);
});

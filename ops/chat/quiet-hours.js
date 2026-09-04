"use strict";

const TIME_ZONE = "Europe/Moscow";
const DEFAULT_START = "22:00";
const DEFAULT_END = "09:00";
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const moscowTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function parseBoundary(value, variable, defaultValue) {
  const resolved = value === undefined || value === "" ? defaultValue : value;
  if (typeof resolved !== "string" || !TIME_PATTERN.test(resolved)) {
    throw new Error(`${variable} должен иметь формат HH:MM`);
  }
  const [hour, minute] = resolved.split(":").map(Number);
  return { value: resolved, minutes: hour * 60 + minute };
}

function parseQuietHours(environment = {}) {
  const start = parseBoundary(
    environment.TELEGRAM_SILENT_START,
    "TELEGRAM_SILENT_START",
    DEFAULT_START,
  );
  const end = parseBoundary(
    environment.TELEGRAM_SILENT_END,
    "TELEGRAM_SILENT_END",
    DEFAULT_END,
  );
  if (start.minutes === end.minutes) {
    throw new Error("TELEGRAM_SILENT_START и TELEGRAM_SILENT_END не должны совпадать");
  }
  return {
    start: start.value,
    end: end.value,
    startMinutes: start.minutes,
    endMinutes: end.minutes,
  };
}

function moscowMinutes(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError("date должен быть корректным Date");
  }
  const parts = Object.fromEntries(
    moscowTimeFormatter
      .formatToParts(date)
      .filter((part) => part.type === "hour" || part.type === "minute")
      .map((part) => [part.type, Number(part.value)]),
  );
  return parts.hour * 60 + parts.minute;
}

function isQuietTime(date, settings) {
  const minutes = moscowMinutes(date);
  if (settings.startMinutes < settings.endMinutes) {
    return minutes >= settings.startMinutes && minutes < settings.endMinutes;
  }
  return minutes >= settings.startMinutes || minutes < settings.endMinutes;
}

function prepareTelegramPayload(method, payload, date, settings) {
  const prepared = { ...payload };
  if (method === "sendMessage" && isQuietTime(date, settings)) {
    prepared.disable_notification = true;
  }
  return prepared;
}

module.exports = {
  TIME_ZONE,
  parseQuietHours,
  isQuietTime,
  prepareTelegramPayload,
};

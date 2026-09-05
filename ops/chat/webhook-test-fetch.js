"use strict";

const nativeFetch = global.fetch;

global.fetch = (input, options) => {
  const url = String(input);
  if (url.startsWith("https://api.telegram.org/") && process.env.MOCK_TELEGRAM_URL) {
    return nativeFetch(process.env.MOCK_TELEGRAM_URL, options);
  }
  return nativeFetch(input, options);
};

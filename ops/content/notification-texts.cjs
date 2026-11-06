'use strict';

const { isProxy } = require('node:util').types;

// Fixed public-copy contract from notification-copy-spec.json (schema 1).
// No project data, defaults, runtime fallback, IO or authorization lives here.
const LIMITS = Object.freeze(Object.assign(Object.create(null), {
  installTitle: 160,
  notificationTitle: 160,
  installClientText: 2000,
  installStaffText: 2000,
  installedText: 2000,
  installButton: 120,
  installHelpButton: 120,
  installBusyText: 120,
  deviceHeading: 160,
  enableButton: 120,
  disableButton: 120,
  laterButton: 120,
  neverButton: 120,
  pushUnavailableText: 2000,
  iosInstallText: 2000,
  permissionDeniedText: 2000,
  subscribedText: 2000,
  unsubscribedText: 2000,
  permissionPromptText: 2000,
  unconfirmedText: 2000,
  subscribeErrorText: 2000,
  closeLabel: 120,
  iosStep1: 400,
  iosStep2: 400,
  iosStep3: 400,
  iosStep4: 400,
  androidStep1: 400,
  androidStep2: 400,
  androidStep3: 400,
  desktopStep1: 400,
  desktopStep2: 400,
  desktopStep3: 400,
  guideExampleText: 400,
  guideImageButton: 120,
  guideSourceLabel: 120,
  guideBackButton: 120
}));

const MAX_UTF8_BYTES = 65536;
const FORBIDDEN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f<>]/u;
const MULTILINE_WHITESPACE = /[\t\n\r]/u;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function invalid() {
  // Deliberately omit input values, keys, project metadata and nested details.
  throw Object.assign(new Error('Некорректные тексты уведомлений'), {
    status: 400,
    code: 'INVALID_NOTIFICATION_TEXTS'
  });
}

function plainDescriptors(value) {
  // isProxy runs before reflection, including for revoked proxies. Do not run
  // traps, accessors, toJSON or other input-provided code while validating.
  if (value === null || typeof value !== 'object' || isProxy(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)
      || !own(descriptor, 'value') || descriptor.enumerable !== true) invalid();
  }
  return descriptors;
}

/** Validate an explicitly present stored notificationTexts object and copy it. */
function validateNotificationTexts(value) {
  const descriptors = plainDescriptors(value);
  const copy = Object.create(null);
  for (const key of Object.keys(descriptors)) {
    if (!own(LIMITS, key)) invalid();
    const text = descriptors[key].value;
    if (typeof text !== 'string' || Array.from(text).length > LIMITS[key]
      || FORBIDDEN_TEXT.test(text)
      || (LIMITS[key] < 400 && MULTILINE_WHITESPACE.test(text))) invalid();
    copy[key] = text;
  }
  // Serialize only the newly created string-only dictionary, never the input.
  // Count the complete JSON map, including escaping and key overhead.
  if (Buffer.byteLength(JSON.stringify(copy), 'utf8') > MAX_UTF8_BYTES) invalid();
  return copy;
}

/** Project only schema, revision and validated copy; never return a board. */
function projectNotificationTexts(project) {
  const descriptors = plainDescriptors(project);
  if (!own(descriptors, 'schema') || descriptors.schema.value !== 1
    || !own(descriptors, 'revision')
    || !Number.isSafeInteger(descriptors.revision.value)
    || descriptors.revision.value < 0) invalid();
  const notificationTexts = own(descriptors, 'notificationTexts')
    ? validateNotificationTexts(descriptors.notificationTexts.value)
    : Object.create(null);
  // Private values are not traversed, serialized, coerced or copied.
  return { schema: 1, revision: descriptors.revision.value, notificationTexts };
}

module.exports = { validateNotificationTexts, projectNotificationTexts };

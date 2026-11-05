'use strict';

const { isProxy } = require('node:util').types;
const { projectNotificationTexts } = require('./notification-texts.cjs');

const DOCUMENT_KEY = 'project-forms/palitra-love/palitra-orders';
const SELECT_LATEST = 'SELECT version, body FROM documents WHERE key = ? ORDER BY version DESC LIMIT 1';
const MAX_BODY_BYTES = 1024 * 1024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function unavailable() {
  throw Object.assign(new Error('Тексты уведомлений временно недоступны'), {
    status: 503,
    code: 'NOTIFICATION_COPY_UNAVAILABLE'
  });
}

function plainDescriptors(value) {
  if (value === null || typeof value !== 'object' || isProxy(value)) unavailable();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)
      || !own(descriptor, 'value') || descriptor.enumerable !== true) unavailable();
  }
  return descriptors;
}

function rowRevision(value) {
  // SQLite normally supplies a number. Canonical decimal strings and bigint
  // also work without coercing objects, booleans, null or executable valueOf.
  if (typeof value !== 'number' && typeof value !== 'bigint'
    && !(typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value))) unavailable();
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) unavailable();
  return revision;
}

/** Read one fixed document and expose only the validated public copy. */
function createNotificationCopyHttp(options = {}) {
  let latest;
  try {
    const { db } = options;
    if (!db || typeof db.prepare !== 'function') unavailable();
    latest = db.prepare(SELECT_LATEST);
    if (!latest || typeof latest.get !== 'function') unavailable();
  } catch {
    unavailable();
  }

  function readModel() {
    try {
      const row = latest.get(DOCUMENT_KEY);
      if (row === undefined || row === null) {
        return { schema: 1, revision: 0, appTitle: 'Palitra Love заказы', frames: [] };
      }
      const rowFields = plainDescriptors(row);
      if (!own(rowFields, 'version') || !own(rowFields, 'body')) unavailable();
      const revision = rowRevision(rowFields.version.value);
      const body = rowFields.body.value;
      if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) unavailable();
      const modelFields = plainDescriptors(JSON.parse(body));
      // Match the private API: the document row version is authoritative. A
      // stale body revision is never returned, and parsed/private values stay
      // unvisited. Construct data properties without spreading input values.
      modelFields.revision = { value: revision, enumerable: true, configurable: true, writable: true };
      const model = Object.create(null, modelFields);
      return model;
    } catch {
      // No DB/parser/validation error, cause or stored data crosses this edge.
      unavailable();
    }
  }

  return Object.freeze({ read: () => { try { return projectNotificationTexts(readModel()); } catch { unavailable(); } }, readVisual: () => projectVisual(readModel()) });
}

module.exports = { createNotificationCopyHttp };

'use strict';

// Pure public visual projection. No IO, serialization hooks, authorization or runtime bindings.
const visualIsProxy = require('node:util').types.isProxy;
const VISUAL_BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const VISUAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const VISUAL_TEXT_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f<>]/u;
const VISUAL_ROLES = ['client', 'staff', 'admin'];
const VISUAL_KINDS = ['landing', 'orders', 'history', 'detail', 'chat', 'review', 'menu', 'editor', 'reports', 'website', 'custom'];
const VISUAL_TYPES = ['hero', 'button', 'text', 'website', 'helpform', 'order', 'chat', 'input', 'form', 'status', 'customer', 'sales', 'contactnotice'];
const VISUAL_INPUTS = ['text', 'textarea', 'tel', 'email', 'number', 'select', 'checkbox'];
const VISUAL_CHANNELS = ['telegram', 'whatsapp', 'max', 'call', 'vk'];
const VISUAL_PARTS = ['name', 'channel', 'contact', 'hint'];
const VISUAL_FONTS = ['system', 'inter', 'roboto', 'open-sans', 'montserrat', 'nunito-sans', 'lora'];
const VISUAL_WEBSITE_HOSTS = ['palitra-love.ru', 'palitra-love-draft-1.synapsebusiness.ru'];
const visualOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function visualUnavailable() {
  throw Object.assign(new Error('Оформление приложения временно недоступно'), {
    status: 503, code: 'VISUAL_PROJECTION_UNAVAILABLE'
  });
}

function visualRecord(value, budget) {
  if (value === null || typeof value !== 'object' || visualIsProxy(value)) visualUnavailable();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) visualUnavailable();
  if (++budget.nodes > 25000) visualUnavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length > 2000) visualUnavailable();
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || VISUAL_BAD_KEYS.has(key) || !visualOwn(descriptor, 'value')
      || descriptor.enumerable !== true) visualUnavailable();
  }
  return descriptors;
}

function visualArray(value, max, budget) {
  if (value === null || typeof value !== 'object' || visualIsProxy(value)
    || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) visualUnavailable();
  const length = Object.getOwnPropertyDescriptor(value, 'length').value;
  if (length > max || ++budget.nodes > 25000) visualUnavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== length + 1) visualUnavailable();
  const result = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[index];
    if (!descriptor || !visualOwn(descriptor, 'value') || descriptor.enumerable !== true) visualUnavailable();
    result.push(descriptor.value);
  }
  return result;
}

function visualText(value, max, budget) {
  if (typeof value !== 'string' || value.length > max || VISUAL_TEXT_BAD.test(value)) visualUnavailable();
  budget.bytes += Buffer.byteLength(value, 'utf8');
  if (budget.bytes > 524288) visualUnavailable();
  return value;
}
function visualId(value) {
  if (typeof value !== 'string' || !VISUAL_ID.test(value) || VISUAL_BAD_KEYS.has(value)) visualUnavailable();
  return value;
}
function visualTarget(value) {
  if (value === '' || value === '@site' || value === '@works') return value;
  return visualId(value);
}
function visualEnum(value, allowed) { if (!allowed.includes(value)) visualUnavailable(); return value; }
function visualBool(value) { if (typeof value !== 'boolean') visualUnavailable(); return value; }
function visualNumber(value, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
    || (integer && !Number.isSafeInteger(value))) visualUnavailable();
  return value;
}
function visualOptional(descriptors, output, key, project) {
  if (visualOwn(descriptors, key)) output[key] = project(descriptors[key].value);
}
function visualRequired(descriptors, key) {
  if (!visualOwn(descriptors, key)) visualUnavailable();
  return descriptors[key].value;
}
function visualTexts(descriptors, output, keys, budget, max = 4000) {
  for (const key of keys) visualOptional(descriptors, output, key, (value) => visualText(value, max, budget));
}
function visualBooleans(descriptors, output, keys) {
  for (const key of keys) visualOptional(descriptors, output, key, visualBool);
}
function visualEnumArray(value, allowed, max, budget) {
  const result = visualArray(value, max, budget).map((item) => visualEnum(item, allowed));
  if (new Set(result).size !== result.length) visualUnavailable();
  return result;
}

function visualUrl(value, budget, website = false) {
  const text = visualText(value, 2048, budget);
  if (text === '') return '';
  if (!/^https?:\/\//i.test(text) || /[\s\\]/u.test(text)) visualUnavailable();
  const parsed = new URL(text);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || !parsed.hostname) visualUnavailable();
  if (website && (parsed.protocol !== 'https:' || parsed.port
    || !VISUAL_WEBSITE_HOSTS.includes(parsed.hostname))) visualUnavailable();
  return text;
}

function visualStyle(value, budget) {
  const d = visualRecord(value, budget), out = {};
  visualOptional(d, out, 'font', (v) => visualEnum(v, VISUAL_FONTS));
  visualOptional(d, out, 'size', (v) => visualNumber(v, 10, 72));
  visualBooleans(d, out, ['bold', 'italic', 'underline']);
  visualOptional(d, out, 'align', (v) => visualEnum(v, ['left', 'center', 'right', 'justify']));
  visualOptional(d, out, 'lineHeight', (v) => visualNumber(v, 1, 2.5));
  visualOptional(d, out, 'color', (v) => {
    if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) visualUnavailable();
    return v;
  });
  return out;
}
function visualStyles(value, fields, budget) {
  const d = visualRecord(value, budget), out = {};
  for (const key of fields) visualOptional(d, out, key, (v) => visualStyle(v, budget));
  return out;
}

function visualFreeLayout(value, budget) {
  const d = visualRecord(value, budget), out = {
    enabled: visualBool(visualRequired(d, 'enabled')),
    width: visualNumber(visualRequired(d, 'width'), 1, 20000),
    height: visualNumber(visualRequired(d, 'height'), 1, 20000), items: {}
  };
  const items = visualRecord(visualRequired(d, 'items'), budget), ids = Object.keys(items);
  if (ids.length > 1000) visualUnavailable();
  for (const id of ids) {
    visualId(id);
    const box = visualRecord(items[id].value, budget), next = {};
    for (const key of ['x', 'y', 'width', 'height']) {
      next[key] = visualNumber(visualRequired(box, key), ['width', 'height'].includes(key) ? 1 : 0, 20000);
    }
    out.items[id] = next;
  }
  return out;
}

function visualOptions(value, budget) {
  return visualArray(value, 50, budget).map((item) => {
    if (typeof item === 'string') return visualText(item, 1000, budget);
    const d = visualRecord(item, budget), out = {};
    visualTexts(d, out, ['label', 'value'], budget, 1000);
    if (!visualOwn(out, 'label') && !visualOwn(out, 'value')) visualUnavailable();
    return out;
  });
}
function visualFields(value, budget) {
  const seen = new Set();
  return visualArray(value, 30, budget).map((item) => {
    const d = visualRecord(item, budget), out = {
      id: visualId(visualRequired(d, 'id')),
      type: visualEnum(visualRequired(d, 'type'), VISUAL_INPUTS)
    };
    if (seen.has(out.id)) visualUnavailable(); seen.add(out.id);
    visualTexts(d, out, ['label', 'placeholder'], budget, 1000);
    visualBooleans(d, out, ['required', 'hidden']);
    visualOptional(d, out, 'options', (v) => visualOptions(v, budget));
    return out;
  });
}

function visualBlock(value, frameId, budget) {
  const d = visualRecord(value, budget);
  // This one legacy literal is read only to remove the block; review never crosses the public edge.
  if (visualOwn(d, 'review') && d.review.value === 'remove') return null;
  if (visualOwn(d, 'presentationHidden') && visualBool(d.presentationHidden.value)) return null;
  const out = {
    id: visualId(visualRequired(d, 'id')),
    type: visualEnum(visualRequired(d, 'type'), VISUAL_TYPES)
  };
  visualOptional(d, out, 'presentationHidden', visualBool);
  const fields = new Set();
  function text(keys, max) { visualTexts(d, out, keys, budget, max); for (const key of keys) fields.add(key); }
  switch (out.type) {
    case 'hero': text(['title', 'subtitle']); break;
    case 'text': text(['title', 'text'], 8000); break;
    case 'button':
      text(['label'], 1000);
      visualOptional(d, out, 'action', (v) => visualEnum(v, ['page', 'link']));
      visualOptional(d, out, 'url', (v) => visualUrl(v, budget));
      visualOptional(d, out, 'orderGroup', (v) => visualEnum(v, ['active', 'history']));
      break;
    case 'website':
      text(['label'], 1000);
      // Legacy boards also store preview PNGs here. They are not runtime iframe bindings.
      // Only the one permitted local catalogue source crosses this edge; all other src values stay private.
      if (visualOwn(d, 'src')) {
        const v = d.src.value;
        if (typeof v === 'string' && /^assets\/catalog-mobile\.html(?:\?[A-Za-z0-9_.~%=&-]{1,256})?$/.test(v)) out.src = v;
      }
      visualOptional(d, out, 'url', (v) => visualUrl(v, budget, true));
      visualOptional(d, out, 'presentation', (v) => visualEnum(v, ['', 'mobile-site']));
      break;
    case 'helpform':
      text(['title', 'subtitle', 'toggleLabel', 'nameLabel', 'messengerLabel', 'contactLabel', 'submitLabel', 'hint', 'namePlaceholder', 'contactPlaceholder']);
      visualBooleans(d, out, ['collapsible', 'phoneOnly', 'nameRequired', 'contactRequired']);
      // r191 predates the explicitly requested production two-field behavior. Explicit false wins.
      if (frameId === 'K01' && !visualOwn(d, 'phoneOnly')) out.phoneOnly = true;
      visualOptional(d, out, 'channels', (v) => visualEnumArray(v, VISUAL_CHANNELS, 5, budget));
      for (const key of ['hiddenParts', 'partOrder']) visualOptional(d, out, key, (v) => visualEnumArray(v, VISUAL_PARTS, 4, budget));
      visualOptional(d, out, 'contactPlaceholders', (v) => {
        const entries = visualRecord(v, budget), result = {};
        for (const channel of VISUAL_CHANNELS) visualOptional(entries, result, channel, (text) => visualText(text, 1000, budget));
        return result;
      });
      visualOptional(d, out, 'fields', (v) => visualFields(v, budget));
      break;
    case 'form':
      text(['title', 'subtitle', 'submitLabel']);
      visualOptional(d, out, 'fields', (v) => visualFields(v, budget));
      break;
    case 'input':
      text(['label', 'placeholder'], 1000);
      visualOptional(d, out, 'inputType', (v) => visualEnum(v, VISUAL_INPUTS));
      visualOptional(d, out, 'required', visualBool);
      visualOptional(d, out, 'options', (v) => visualOptions(v, budget));
      break;
    case 'chat': text(['title', 'placeholder'], 1000); break;
    case 'order': case 'status': case 'customer': case 'sales': text(['title']); break;
    case 'contactnotice': text(['title', 'text']); break;
    default: visualUnavailable();
  }
  if (['button', 'helpform', 'form', 'order', 'chat', 'customer'].includes(out.type)) visualOptional(d, out, 'target', visualTarget);
  if (out.fields) for (const field of out.fields) fields.add('field:' + field.id);
  visualOptional(d, out, 'textStyles', (v) => visualStyles(v, fields, budget));
  visualOptional(d, out, 'freeLayout', (v) => visualFreeLayout(v, budget));
  return out;
}

function visualCategory(value, budget) {
  const d = visualRecord(value, budget), out = {};
  visualTexts(d, out, ['label'], budget, 1000);
  visualOptional(d, out, 'icon', (v) => visualEnum(v, ['gift', 'heart', 'star', 'birthday', 'baby', 'event']));
  visualOptional(d, out, 'target', visualTarget);
  visualOptional(d, out, 'textStyles', (v) => visualStyles(v, ['label'], budget));
  return out;
}
function visualFrame(value, budget) {
  const d = visualRecord(value, budget), out = {
    id: visualId(visualRequired(d, 'id')),
    role: visualEnum(visualRequired(d, 'role'), VISUAL_ROLES),
    kind: visualEnum(visualRequired(d, 'kind'), VISUAL_KINDS),
    blocks: []
  };
  visualTexts(d, out, ['title', 'eyebrow', 'menuLabel'], budget, 1000);
  visualOptional(d, out, 'device', (v) => visualEnum(v, ['mobile', 'desktop']));
  visualOptional(d, out, 'presentation', (v) => visualEnum(v, ['', 'celebration']));
  visualOptional(d, out, 'photoSrc', (v) => {
    if (v !== 'assets/k01-celebration-bg.png') visualUnavailable(); return v;
  });
  visualBooleans(d, out, ['hidden', 'menuVisible']);
  visualOptional(d, out, 'menuOrder', (v) => visualNumber(v, -20000, 20000));
  visualOptional(d, out, 'orderTabs', (v) => {
    const tabs = visualRecord(v, budget), result = {};
    for (const key of ['active', 'history']) visualOptional(tabs, result, key, visualTarget);
    return result;
  });
  visualOptional(d, out, 'categories', (v) => visualArray(v, 3, budget).map((item) => visualCategory(item, budget)));
  visualOptional(d, out, 'freeLayout', (v) => visualFreeLayout(v, budget));
  const ids = new Set();
  for (const item of visualArray(visualRequired(d, 'blocks'), 200, budget)) {
    const block = visualBlock(item, out.id, budget);
    if (block === null) continue;
    if (ids.has(block.id)) visualUnavailable(); ids.add(block.id); out.blocks.push(block);
  }
  budget.blocks += out.blocks.length;
  if (budget.blocks > 2000) visualUnavailable();
  return out;
}

function visualMenu(value, budget) {
  const d = visualRecord(value, budget), out = {};
  visualOptional(d, out, 'id', visualId);
  visualOptional(d, out, 'type', (v) => visualEnum(v, ['menu']));
  visualTexts(d, out, ['title'], budget, 1000);
  visualOptional(d, out, 'textStyles', (v) => visualStyles(v, ['title'], budget));
  const ids = new Set();
  out.items = visualArray(visualRequired(d, 'items'), 200, budget).map((item) => {
    const fields = visualRecord(item, budget), next = {
      id: visualId(visualRequired(fields, 'id')), target: visualTarget(visualRequired(fields, 'target'))
    };
    if (ids.has(next.id)) visualUnavailable(); ids.add(next.id);
    visualTexts(fields, next, ['label'], budget, 1000);
    visualOptional(fields, next, 'hidden', visualBool);
    visualOptional(fields, next, 'textStyles', (v) => visualStyles(v, ['label'], budget));
    return next;
  });
  return out;
}

/** Only plain visual data crosses this boundary. All rejection details remain generic. */
function projectVisual(project) {
  try {
    const budget = { nodes: 0, bytes: 0, blocks: 0 }, d = visualRecord(project, budget);
    if (visualRequired(d, 'schema') !== 1) visualUnavailable();
    const revision = visualNumber(visualRequired(d, 'revision'), 0, Number.MAX_SAFE_INTEGER, true);
    const visual = { appTitle: visualText(visualRequired(d, 'appTitle'), 200, budget), frames: [], menus: {} };
    const ids = new Set();
    for (const value of visualArray(visualRequired(d, 'frames'), 200, budget)) {
      const frame = visualFrame(value, budget);
      if (ids.has(frame.id)) visualUnavailable(); ids.add(frame.id); visual.frames.push(frame);
    }
    if (visualOwn(d, 'menus')) {
      const menus = visualRecord(d.menus.value, budget);
      for (const role of VISUAL_ROLES) visualOptional(menus, visual.menus, role, (v) => visualMenu(v, budget));
    }
    return { schema: 1, revision, visual };
  } catch {
    visualUnavailable();
  }
}

// This assignment also works when Root appends this source to the existing HTTP module.
module.exports.projectVisual = projectVisual;

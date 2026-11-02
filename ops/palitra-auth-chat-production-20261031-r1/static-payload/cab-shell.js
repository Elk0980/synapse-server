/* Common refresh/back buttons, including already mounted and late legacy DOM. */
(function (root) {
 'use strict';
 if(root.PalitraActionIcons?.version==='v1')return;
 const paths={refresh:['M3 11a9 9 0 0 1 15-6.7L21 7','M21 3v4h-4','M21 13a9 9 0 0 1-15 6.7L3 17','M3 21v-4h4'],back:['M15 5l-7 7 7 7']};
 function icon(doc,kind){const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');for(const[k,v]of Object.entries({viewBox:'0 0 24 24',width:'22',height:'22',fill:'none',stroke:'currentColor','stroke-width':'2','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false','data-action-symbol':kind}))svg.setAttribute(k,v);for(const d of paths[kind]){const p=doc.createElementNS(svg.namespaceURI,'path');p.setAttribute('d',d);svg.append(p);}return svg;}
 function install(doc){if(!doc||doc.documentElement.dataset.actionIconsInstalled==='v1')return()=>{};doc.documentElement.dataset.actionIconsInstalled='v1';let dead=false,pending=false;
  function scan(){pending=false;if(dead)return;for(const b of doc.querySelectorAll('button')){const label=b.getAttribute('aria-label')||b.getAttribute('title')||b.textContent.trim();const kind=/^Обновить(?:\s|$)/u.test(label)?'refresh':/^(?:Назад|Закрыть контент и вернуться|← Мои чаты)$/u.test(label)||b.id==='pc-back'||b.classList.contains('app-back')?'back':b.dataset.actionIcon;if(!paths[kind])continue;if(b.querySelector(':scope > svg[data-action-symbol="'+kind+'"]'))continue;const text=label|| (kind==='back'?'Назад':'Обновить');b.setAttribute('aria-label',text);if(!b.title)b.title=text;b.dataset.actionIcon=kind;b.classList.add('app-action-icon');const old=doc.createElement('span');old.className='app-action-icon__original';old.setAttribute('aria-hidden','true');while(b.firstChild)old.append(b.firstChild);b.append(icon(doc,kind),old);}}
  const observer=new root.MutationObserver(()=>{if(!pending&&!dead){pending=true;root.queueMicrotask(scan);}});scan();observer.observe(doc.documentElement,{childList:true,subtree:true});return()=>{dead=true;observer.disconnect();};
 }
 const api=Object.freeze({version:'v1',icon,install});if(typeof module==='object'&&module.exports)module.exports=api;else{Object.defineProperty(root,'PalitraActionIcons',{value:api});if(root.document.readyState==='loading')root.document.addEventListener('DOMContentLoaded',()=>install(root.document),{once:true});else install(root.document);}
})(typeof window==='undefined'?globalThis:window);

/* Safe UI update offers. No storage, sends, auth changes or automatic navigation. */
(function (global, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.defineProperty(global, 'PalitraSessionUpdate', { value: api, configurable: false, writable: false });
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const BUILD = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
  const BLOCKERS = new Set(['draft', 'form', 'file', 'pending', 'busy', 'typing', 'protected', 'unverified']);
  function marker(text) {
    if (typeof text !== 'string' || text.length > 1048576) return null;
    const matches = [...text.matchAll(/\/\* PALITRA_UI_BUILD:([A-Za-z0-9][A-Za-z0-9_.-]{0,95}) \*\//g)];
    return matches.length === 1 ? matches[0][1] : null;
  }
  function scriptPath(location) {
    if (!location) return null;
    if (['https://palitra-love.ru', 'https://palitra-love-draft-1.synapsebusiness.ru'].includes(location.origin) && location.pathname === '/love-app/shop.html') return '/love-app/shell.js';
    if (location.origin === 'https://synapse.synapsebusiness.ru' && location.pathname === '/cabinet/palitra-orders/cabinet.html') return '/cabinet/palitra-orders/shell.js';
    return null;
  }
  function safety(readSafety) {
    try {
      const values = readSafety();
      if (!Array.isArray(values) || values.length > 16 || values.some(v => typeof v !== 'string' || !BLOCKERS.has(v))) return ['unverified'];
      return [...new Set(values)];
    } catch (_) { return ['unverified']; }
  }
  function dirtyValue(value, depth = 0) {
    if (value === null || value === undefined || value === false || value === '') return false;
    if (typeof value === 'string' || typeof value === 'number' || value === true) return true;
    if (depth >= 4 || typeof value !== 'object') return true;
    if (Array.isArray(value)) return value.some(v => dirtyValue(v, depth + 1));
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return true;
    return Object.values(value).some(v => dirtyValue(v, depth + 1));
  }
  function snapshotForm(form) {
    return Object.freeze({ name: form.name, contact: form.contact, channel: form.channel, consent: form.consent });
  }
  function acknowledgedForm(form, snapshot) {
    return Boolean(snapshot && form.receipt && !form.attempt && !form.busy &&
      ['name', 'contact', 'channel', 'consent'].every(key => form[key] === snapshot[key]));
  }
  function collectBlockers(snapshot) {
    const s = snapshot || {}, out = [];
    if (s.verified !== true) out.push('unverified');
    if (s.drafts && [...s.drafts.values()].some(v => dirtyValue(v))) out.push('draft');
    // An explicit empty/false custom-field choice can differ from its original default.
    if (s.fieldDrafts && [...s.fieldDrafts.values()].some(v => v && Object.keys(v).length)) out.push('form');
    const f = s.form || {};
    const defaultChannel = typeof s.formDefaultChannel === 'string' ? s.formDefaultChannel : 'telegram';
    if ((!acknowledgedForm(f, s.formSnapshot) && (f.name || f.contact || f.consent || f.channel && f.channel !== defaultChannel)) || f.attempt) out.push('form');
    if (s.pending && s.pending.size || f.attempt && f.attempt.unknown) out.push('pending');
    if (s.inflight && s.inflight.size || f.busy) out.push('busy');
    if (s.hasFile) out.push('file');
    if (s.typing) out.push('typing');
    if (s.protectedSurface) out.push('protected');
    return [...new Set(out)];
  }
  function create({ window: win, document: doc, buildId, readSafety, onState = () => {}, onReturn = () => {}, pollMs = 60000, timeoutMs = 8000, clock = () => Date.now() } = {}) {
    if (!win || !doc || !BUILD.test(buildId || '') || typeof readSafety !== 'function' || typeof win.fetch !== 'function' || typeof win.AbortController !== 'function') throw new TypeError('Invalid update observer');
    const path = scriptPath(win.location);
    if (!path) throw new TypeError('Unsupported application entry');
    pollMs = Number.isFinite(pollMs) ? Math.max(30000, Math.min(300000, pollMs)) : 60000;
    timeoutMs = Number.isFinite(timeoutMs) ? Math.max(1000, Math.min(15000, timeoutMs)) : 8000;
    let stopped = false, suspended = false, timer = null, controller = null, checking = null;
    let nextBuild = null, lastCheck = -Infinity, navigating = false;
    let state = Object.freeze({ available: false, blocked: false, blockers: Object.freeze([]), nextBuild: null });
    function publish() {
      const blockers = safety(readSafety);
      const next = { available: Boolean(nextBuild), blocked: blockers.length > 0, blockers: Object.freeze(blockers), nextBuild };
      if (JSON.stringify(next) !== JSON.stringify(state)) {
        state = Object.freeze(next);
        try { onState(state); } catch (_) { /* UI failure never navigates or mutates application data. */ }
      }
      return state;
    }
    const now = () => clock();
    function clearTimer() { if (timer !== null) win.clearTimeout(timer); timer = null; }
    function arm() {
      clearTimer();
      if (stopped || suspended || doc.hidden || navigating) return;
      timer = win.setTimeout(() => { timer = null; void check(); }, pollMs);
    }
    async function readBuild(signal) {
      const response = await win.fetch(path, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal, headers: { Accept: 'application/javascript' } });
      if (!response.ok || response.redirected) return null;
      const type = String(response.headers && response.headers.get('content-type') || '');
      if (!/^(?:application|text)\/(?:javascript|x-javascript|ecmascript)(?:\s*;|$)/i.test(type)) return null;
      const declared = Number(response.headers && response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > 1048576) return null;
      return marker(await response.text());
    }
    function check() {
      publish();
      if (stopped || suspended || doc.hidden || navigating) return Promise.resolve(state);
      if (checking) return checking;
      if (now() - lastCheck < 30000) { arm(); return Promise.resolve(state); }
      lastCheck = now();
      const own = new win.AbortController(); controller = own;
      checking = (async () => {
        let deadline;
        try {
          const timedOut = new Promise(resolve => { deadline = win.setTimeout(() => { own.abort(); resolve(null); }, timeoutMs); });
          const remote = await Promise.race([readBuild(own.signal).catch(() => null), timedOut]);
          // A BFCache suspension/disposal invalidates even a fetch mock/transport that ignores abort.
          if (!stopped && !suspended && controller === own && !own.signal.aborted && remote) nextBuild = remote === buildId ? null : remote;
        } finally {
          if (deadline !== undefined) win.clearTimeout(deadline);
          if (controller === own) controller = null;
          checking = null;
          if (!stopped) publish();
          arm();
        }
        return state;
      })();
      return checking;
    }
    function requestReload(event) {
      if (stopped || suspended || navigating || doc.hidden || !nextBuild || !event || event.isTrusted !== true) return false;
      if (win.navigator && win.navigator.userActivation && win.navigator.userActivation.isActive !== true) return false;
      // Read again synchronously in the same user action: a new draft/file/send may have appeared since the offer.
      if (publish().blocked) return false;
      navigating = true; clearTimer();
      if (controller) controller.abort();
      win.location.reload();
      return true;
    }
    function returned() {
      if (stopped || doc.hidden) return;
      suspended = false;
      try { onReturn(); } catch (_) { /* Geometry must never trigger reset/navigation. */ }
      publish(); void check();
    }
    function hidden() {
      if (doc.hidden) { clearTimer(); if (controller) controller.abort(); }
      else returned();
    }
    function pagehide(event) {
      clearTimer(); suspended = true;
      if (controller) controller.abort();
      if (!event || !event.persisted) dispose();
    }
    function pageshow(event) { if (event && event.persisted) returned(); }
    function dispose() {
      if (stopped) return;
      stopped = true; clearTimer(); if (controller) controller.abort();
      doc.removeEventListener('visibilitychange', hidden);
      win.removeEventListener('pagehide', pagehide); win.removeEventListener('pageshow', pageshow);
    }
    doc.addEventListener('visibilitychange', hidden);
    win.addEventListener('pagehide', pagehide); win.addEventListener('pageshow', pageshow);
    arm();
    return Object.freeze({ check, refreshSafety: publish, requestReload, dispose, getState: () => state });
  }
  function mountOffer({ document: doc, parent, observer } = {}) {
    if (!doc || !parent || !observer) throw new TypeError('Invalid update offer');
    const box = doc.createElement('details'), summary = doc.createElement('summary'), message = doc.createElement('p'), update = doc.createElement('button');
    box.className = 'card palitra-session-update'; box.hidden = true;
    box.setAttribute('aria-label', 'Обновление приложения');
    summary.className = 'palitra-session-update__summary'; summary.textContent = 'Обновление интерфейса';
    message.className = 'hint'; message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    update.type = 'button'; update.className = 'app-btn app-btn--small'; update.textContent = 'Обновить интерфейс';
    const clicked = event => observer.requestReload(event);
    update.addEventListener('click', clicked); box.append(summary, message, update); parent.append(box);
    function paint(state = observer.getState()) {
      box.hidden = !state.available;
      message.textContent = state.blocked
        ? 'Доступно обновление. В этой вкладке есть ввод или незавершённое действие. Обновление отложено, чтобы их сохранить.'
        : 'Доступно обновление интерфейса. Можно обновить страницу, когда вам удобно.';
      update.disabled = state.blocked;
    }
    paint();
    function place(target = parent, before = null) {
      if (box.parentNode !== target) target.insertBefore(box, before);
    }
    return Object.freeze({ paint, place, dispose: () => { update.removeEventListener('click', clicked); box.remove(); } });
  }
  return Object.freeze({ marker, scriptPath, safety, dirtyValue, snapshotForm, acknowledgedForm, collectBlockers, create, mountOffer });
});

/* Pure help-form fields contract. No DOM, transport, storage or form mutation. */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PalitraRequestFields = factory();
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const MAX_FIELDS = 30, MAX_OPTIONS = 50, MAX_TEXT = 1000, MAX_COMMENT = 1000;
  const TYPES = new Set(['text', 'textarea', 'tel', 'email', 'number', 'select', 'checkbox']);
  const FIELD_KEYS = new Set(['id', 'type', 'label', 'placeholder', 'required', 'hidden', 'options']);
  const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
  const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
  const SINGLE_BAD = /[\u0000-\u001f\u007f-\u009f]/u;
  const MULTI_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
  // HTML input[type=number], step=any: decimal floating point, not JS hex/Infinity.
  const NUMBER = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  // HTML's single-address e-mail grammar; a local host is valid (no invented dot rule).
  const EMAIL = /^[a-zA-Z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const failures = new WeakSet();
  const problem = (id, code, message) => ({ id, code, message });
  const error = (id, code, message) => { const failure = problem(id, code, message); failures.add(failure); throw failure; };
  const fail = (caught) => ({ ok: false, fields: [], errors: [failures.has(caught)
    ? caught : problem(null, 'MALFORMED', 'Не удалось проверить поля формы.')] });

  function record(value, allowed, id, limit) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) error(id, 'MALFORMED', 'Неверный объект поля формы.');
    const keys = Reflect.ownKeys(value);
    if (keys.length > limit) error(id, 'MALFORMED', 'Слишком много свойств поля формы.');
    const descriptors = Object.getOwnPropertyDescriptors(value), out = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string' || BAD_KEYS.has(key) || allowed && !allowed.has(key)) error(id, 'UNKNOWN_PROPERTY', 'Неизвестное свойство поля формы.');
      const d = descriptors[key];
      if (!d || !own(d, 'value') || !d.enumerable) error(id, 'MALFORMED', 'Ожидалось обычное значение поля формы.');
      out[key] = d.value;
    }
    return out;
  }

  function array(value, max, id) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length > max) error(id, 'MALFORMED', 'Неверный список полей или вариантов.');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== value.length + 1) error(id, 'MALFORMED', 'Неверный список полей или вариантов.');
    const out = [];
    for (let i = 0; i < value.length; i++) {
      const d = descriptors[String(i)];
      if (!d || !own(d, 'value') || !d.enumerable) error(id, 'MALFORMED', 'Неверный элемент списка.');
      out.push(d.value);
    }
    return out;
  }

  function metadata(value, id) {
    if (typeof value !== 'string' || value.length > MAX_TEXT || SINGLE_BAD.test(value) || /[<>]/u.test(value)) {
      error(id, 'FIELD_TEXT', 'Подпись, подсказка или вариант поля содержит недопустимый текст.');
    }
    return value;
  }

  function normalize(raw) {
    const fields = [], ids = new Set();
    for (const entry of array(raw === undefined ? [] : raw, MAX_FIELDS, null)) {
      const f = record(entry, FIELD_KEYS, null, FIELD_KEYS.size);
      if (typeof f.id !== 'string' || !ID.test(f.id) || BAD_KEYS.has(f.id) || ids.has(f.id)) error(null, 'FIELD_ID', 'Нужны уникальные идентификаторы полей.');
      const id = f.id;
      ids.add(id);
      if (!TYPES.has(f.type)) error(id, 'FIELD_TYPE', 'Неизвестный тип поля.');
      for (const key of ['required', 'hidden']) if (own(f, key) && typeof f[key] !== 'boolean') error(id, 'FIELD_BOOLEAN', 'Неверная настройка поля.');
      const options = [], seen = new Set();
      if (own(f, 'options')) for (const item of array(f.options, MAX_OPTIONS, id)) {
        let option;
        if (typeof item === 'string') option = metadata(item, id);
        else {
          const obj = record(item, new Set(['label', 'value']), id, 2);
          if (!own(obj, 'label') && !own(obj, 'value')) error(id, 'FIELD_OPTION', 'У варианта нет подписи или значения.');
          if (own(obj, 'label')) metadata(obj.label, id);
          if (own(obj, 'value')) metadata(obj.value, id);
          option = obj.label ?? obj.value;
        }
        option = option.trim();
        if (!option) continue; // Matches editor optionsOf: label ?? value, trim, omit empty.
        if (seen.has(option)) error(id, 'DUPLICATE_OPTION', 'Варианты списка не должны повторяться.');
        seen.add(option); options.push(option);
      }
      const field = { id, type: f.type, label: own(f, 'label') ? metadata(f.label, id) : 'Поле',
        placeholder: own(f, 'placeholder') ? metadata(f.placeholder, id) : '', required: f.required === true, options: Object.freeze(options) };
      // Validate the full configuration before omitting a hidden field.
      if (f.hidden !== true) fields.push(Object.freeze(field));
    }
    return { fields: Object.freeze(fields), ids };
  }

  function normalizeFields(raw) {
    try { return { ok: true, fields: normalize(raw).fields, errors: [] }; }
    catch (caught) { return fail(caught); }
  }

  function validateAndFormat(raw, values = Object.create(null), opts = {}) {
    const errors = [], lines = [];
    let normalized, input, maxLength;
    try {
      normalized = normalize(raw);
      input = record(values, null, null, MAX_FIELDS);
      for (const key of Object.keys(input)) if (!normalized.ids.has(key)) error(key, 'UNKNOWN_VALUE', 'Поле больше не входит в эту форму. Обновите форму и сверьте введённые данные.');
      const options = record(opts, new Set(['maxLength']), null, 1);
      maxLength = own(options, 'maxLength') ? options.maxLength : MAX_COMMENT;
      if (!Number.isSafeInteger(maxLength) || maxLength < 0 || maxLength > MAX_COMMENT) error(null, 'COMMENT_LIMIT', 'Недопустимое ограничение длины комментария.');
    } catch (caught) { return { ok: false, errors: fail(caught).errors, comment: '' }; }
    for (const field of normalized.fields) {
      const { id, type, required } = field, present = own(input, id), value = input[id];
      const label = field.label.trim() || id;
      if (type === 'checkbox') {
        if (!present) { if (required) errors.push(problem(id, 'REQUIRED', label + ': поставьте флажок.')); continue; }
        if (typeof value !== 'boolean') { errors.push(problem(id, 'VALUE_TYPE', label + ': ожидался флажок.')); continue; }
        if (required && value !== true) { errors.push(problem(id, 'REQUIRED', label + ': поставьте флажок.')); continue; }
        lines.push(label + ': ' + (value ? 'Да' : 'Нет'));
        continue;
      }
      if (!present) { if (required) errors.push(problem(id, 'REQUIRED', label + ': заполните поле.')); continue; }
      if (typeof value !== 'string') { errors.push(problem(id, 'VALUE_TYPE', label + ': ожидался текст.')); continue; }
      const normalizedValue = value.replace(/\r\n?/g, '\n');
      if ((type === 'textarea' ? MULTI_BAD : SINGLE_BAD).test(normalizedValue)) {
        errors.push(problem(id, 'VALUE_CONTROL', label + ': уберите недопустимые управляющие символы.')); continue;
      }
      const entered = normalizedValue.trim();
      if (!entered) { if (required) errors.push(problem(id, 'REQUIRED', label + ': заполните поле.')); continue; }
      if (entered.length > MAX_COMMENT) { errors.push(problem(id, 'VALUE_TOO_LONG', label + ': значение длиннее 1000 символов.')); continue; }
      if (type === 'email' && !EMAIL.test(entered)) { errors.push(problem(id, 'EMAIL', label + ': укажите корректную электронную почту.')); continue; }
      if (type === 'number' && (!NUMBER.test(entered) || !Number.isFinite(Number(entered)))) {
        errors.push(problem(id, 'NUMBER', label + ': укажите конечное десятичное число.')); continue;
      }
      // No pattern is imposed by input[type=tel]. Core phone/contact validation is separate.
      if (type === 'select' && !field.options.includes(entered)) { errors.push(problem(id, 'SELECT', label + ': выберите вариант из списка.')); continue; }
      lines.push(label + ': ' + entered.replace(/\n/g, '\n  '));
    }
    if (errors.length) return { ok: false, errors, comment: '' };
    const comment = lines.join('\n');
    if (comment.length > maxLength) return { ok: false, errors: [problem(null, 'COMMENT_TOO_LONG',
      'Ответы вместе с подписями длиннее допустимого комментария (' + maxLength + ' символов). Сократите их; введённые данные сохранены в форме.')], comment: '' };
    return { ok: true, errors: [], comment };
  }

  return Object.freeze({ version: 1, MAX_FIELDS, MAX_OPTIONS, MAX_COMMENT, normalizeFields, validateAndFormat });
}));

/* Shared, bounded free layout (Zero Block style). Editors persist only the returned numeric model.
   No network, no storage, no style strings from the model: only finite numbers become inline px values. */
(function (global) {
  'use strict';
  const MAX = 20000, MAX_ITEMS = 1000, MIN_SIZE = 8, DRAG_THRESHOLD = 4, STACK_GAP = 12;
  const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
  const KEYS = ['x', 'y', 'width', 'height'];
  const INTERACTIVE = 'input,textarea,select,option,[draggable="true"],[contenteditable=""],[contenteditable="true"]';
  const bindings = new WeakMap();
  const noop = function () {};
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const fnToString = Function.prototype.toString;
  const NATIVE_OBJECT = /^function Object\(\) \{\s*\[native code\]\s*\}$/;
  /* The built-in Object.prototype of some realm (this page, an iframe, a VM): it has no prototype of its own and its
     data property `constructor` is the native Object function whose `prototype` points back to it. A hand-made
     null-root prototype (Object.create(Object.create(null))), a class or a bound/proxied constructor does not pass. */
  function realmObjectPrototype(proto) {
    if (Object.getPrototypeOf(proto) !== null) return false;
    const ctor = field(proto, 'constructor');
    if (typeof ctor !== 'function' || field(ctor, 'prototype') !== proto || field(ctor, 'name') !== 'Object') return false;
    try { return NATIVE_OBJECT.test(fnToString.call(ctor)); } catch (_) { return false; }
  }
  // Plain data: an ordinary Object of any realm or an explicit Object.create(null); arrays, classes, custom prototypes refused.
  function plain(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === null || realmObjectPrototype(proto);
  }
  // Only an own data property counts. Inherited values and accessors give undefined; a getter is never invoked.
  function field(object, key) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && own(descriptor, 'value') ? descriptor.value : undefined;
  }
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const clamp = (v, min, max = MAX) => Math.min(max, Math.max(min, v));
  const round = (v) => Math.round(v * 1000) / 1000;
  function item(v) {
    if (!plain(v)) return null;
    const box = {};
    for (const key of KEYS) { const value = field(v, key); if (!finite(value)) return null; box[key] = value; }
    return { x: round(clamp(box.x, 0)), y: round(clamp(box.y, 0)), width: round(clamp(box.width, 1)), height: round(clamp(box.height, 1)) };
  }
  // anyEnabled: also read a switched-off layout (its boxes are kept for re-enabling and for hidden objects).
  function read(value, anyEnabled) {
    if (!plain(value)) return null;
    const enabled = field(value, 'enabled'), width = field(value, 'width'), height = field(value, 'height'), raw = field(value, 'items');
    if (!(enabled === true || (anyEnabled && enabled === false)) || !finite(width) || !finite(height) || width <= 0 || height <= 0 || !plain(raw)) return null;
    const ids = Object.keys(raw);
    if (ids.length > MAX_ITEMS) return null;
    const items = {};
    for (const id of ids) {
      const box = ID.test(id) ? item(field(raw, id)) : null;
      if (!box) return null;
      Object.defineProperty(items, id, { value: box, enumerable: true, writable: true, configurable: true });
    }
    return { enabled: true, width: round(clamp(width, 1)), height: round(clamp(height, 1)), items };
  }
  const normalize = (value) => read(value, false);
  function clone(value) {
    const copy = { enabled: value.enabled, width: value.width, height: value.height, items: {} };
    for (const [id, box] of Object.entries(value.items)) copy.items[id] = { ...box };
    return copy;
  }
  function updateItem(value, id, patch) {
    const next = normalize(value);
    if (!next || typeof id !== 'string' || !ID.test(id) || !own(next.items, id) || !plain(patch)) return null;
    const changes = {};
    for (const key of Object.keys(patch)) {
      const v = field(patch, key);
      if (!KEYS.includes(key) || !finite(v)) return null;
      changes[key] = v;
    }
    next.items[id] = item({ ...next.items[id], ...changes });
    next.height = Math.min(MAX, Math.max(next.height, next.items[id].y + next.items[id].height));
    return next;
  }
  function children(root) {
    const found = new Map();
    for (const child of Array.from(root.children || [])) {
      const id = child.getAttribute('data-free-id');
      if (!id || !ID.test(id) || found.has(id)) continue;
      found.set(id, child);
    }
    return found;
  }
  /* Content box of a container in its own CSS pixels plus the external visual scale (zoomed stage, transformed parent). */
  function frameOf(root) {
    if (!root || typeof root.getBoundingClientRect !== 'function') return null;
    const rect = root.getBoundingClientRect(), outer = root.offsetWidth || root.clientWidth;
    const s = outer > 0 && rect.width > 0 ? rect.width / outer : 0;
    if (!(s > 0)) return null;
    let pl = 0, pt = 0, pr = 0;
    try {
      const view = (root.ownerDocument && root.ownerDocument.defaultView) || global;
      const cs = view.getComputedStyle(root);
      pl = parseFloat(cs.paddingLeft) || 0; pt = parseFloat(cs.paddingTop) || 0; pr = parseFloat(cs.paddingRight) || 0;
    } catch (_) { /* synthetic DOM without computed styles: no padding */ }
    const width = (root.clientWidth || 0) - pl - pr;
    if (!(width > 0)) return null;
    return { s, width, left: rect.left + ((root.clientLeft || 0) + pl) * s, top: rect.top + ((root.clientTop || 0) + pt) * s,
      scrollLeft: root.scrollLeft || 0, scrollTop: root.scrollTop || 0 };
  }
  // Rendered box of a node in content-box units, clipped horizontally into the canvas; null when not rendered.
  function boxOf(frame, node) {
    if (!node || typeof node.getBoundingClientRect !== 'function') return null;
    const r = node.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    const left = (r.left - frame.left) / frame.s + frame.scrollLeft, top = (r.top - frame.top) / frame.s + frame.scrollTop;
    const x = Math.max(0, left), right = Math.min(frame.width, left + r.width / frame.s);
    if (!(right - x >= 1)) return null;
    return item({ x, y: Math.max(0, top), width: right - x, height: r.height / frame.s });
  }
  /* Measures exactly where the given nodes are now, relative to the container's content box. Call it on the normal
     (non-free) layout before moving nodes into a scene, so the first free render has no jump. Items of the previous
     layout that are not rendered now (hidden objects) are kept and rescaled when the canvas width changed. */
  function captureNodes(container, entries, previous) {
    const frame = frameOf(container);
    if (!frame) return null;
    const prior = read(previous, true);
    const items = {};
    if (prior) {
      const ratio = frame.width / prior.width;
      for (const [id, box] of Object.entries(prior.items)) items[id] = ratio === 1 ? { ...box }
        : item({ x: box.x * ratio, y: box.y * ratio, width: box.width * ratio, height: box.height * ratio });
    }
    for (const [id, node] of Array.from(entries || [])) {
      if (typeof id !== 'string' || !ID.test(id)) continue;
      const box = boxOf(frame, node);
      if (box) items[id] = box;
    }
    let height = 1;
    for (const box of Object.values(items)) height = Math.max(height, box.y + box.height);
    return normalize({ enabled: true, width: frame.width, height: Math.min(MAX, height), items });
  }
  function capture(root, previous) {
    if (!root || typeof root.getBoundingClientRect !== 'function') return null;
    return captureNodes(root, children(root), previous);
  }
  // Numeric custom properties let decoration (the K01 categories strip) reach the screen edge that its box touches.
  const ROOT_STYLE = ['position', 'height', '--free-scale', '--free-offset'];
  const ITEM_STYLE = ['position', 'left', 'top', 'width', 'height', 'margin', 'max-width', 'min-width', 'max-height', 'min-height', 'box-sizing', 'transform', 'transform-origin',
    '--free-left', '--free-right'];
  // A child that must take exactly the object's box (the real button inside an editor wrapper, a form's open/close button).
  const FILL_STYLE = ['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'box-sizing', 'flex-shrink'];
  const RESIZE_DIRS = Object.freeze([['nw', 'вверх и влево'], ['n', 'вверх'], ['ne', 'вверх и вправо'], ['e', 'вправо'], ['se', 'вниз и вправо'], ['s', 'вниз'],
    ['sw', 'вниз и влево'], ['w', 'влево']]);
  // Per-object minimum size from data-free-min (e.g. 44 for buttons), otherwise MIN_SIZE.
  function minOf(node) {
    const raw = node && node.getAttribute ? node.getAttribute('data-free-min') : null;
    const value = raw !== null && /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
    return value >= 1 && value <= 400 ? value : MIN_SIZE;
  }
  // Resize from any edge/corner: the opposite edge stays where it was; never below the minimum, never left/above the canvas.
  function resized(box, dir, dx, dy, min) {
    let { x, y, width, height } = box;
    if (dir.includes('e')) width = Math.max(min, width + dx);
    if (dir.includes('s')) height = Math.max(min, height + dy);
    if (dir.includes('w')) { const right = x + width; const nx = clamp(x + dx, 0, Math.max(0, right - min)); width = Math.max(min, right - nx); x = nx; }
    if (dir.includes('n')) { const bottom = y + height; const ny = clamp(y + dy, 0, Math.max(0, bottom - min)); height = Math.max(min, bottom - ny); y = ny; }
    return { x, y, width, height };
  }
  function saveStyles(node, keys) {
    return keys.map((key) => [key, node.style.getPropertyValue(key), node.style.getPropertyPriority(key)]);
  }
  function restoreStyles(node, saved) {
    for (const [key, value, priority] of saved) {
      if (value) node.style.setProperty(key, value, priority); else node.style.removeProperty(key);
    }
  }
  /* bind({ root, layout, editing, onChange, onSelect, onComplete, complete, maxScale, selected }) → dispose().
     complete:true places direct children that have a stable id but no saved box (a new block, a part shown again,
     a product-only object) below the existing items, in memory; onComplete(layout) lets an editor persist that.
     maxScale caps proportional scaling; a capped canvas is centred. */
  function bind(options = {}) {
    const { root, layout, editing = false, onChange, onSelect, onComplete } = options || {};
    if (!root || !root.style || typeof root.getBoundingClientRect !== 'function') return noop;
    const old = bindings.get(root); if (old) old();
    let current = normalize(layout);
    if (!current) return noop;
    const autoComplete = options.complete === true;
    const maxScale = finite(options.maxScale) && options.maxScale > 0 ? options.maxScale : Infinity;
    const doc = root.ownerDocument || global.document;
    const records = new Map(), controls = new Map();
    const originalRoot = saveStyles(root, ROOT_STYLE), hadRootClass = root.classList.contains('free-layout-root');
    const hadEditingClass = root.classList.contains('free-layout-editing');
    let disposed = false, observer = null, active = null, pending = null, scale = 1, offset = 0, completed = false, completionQueued = false;
    let selected = typeof options.selected === 'string' ? options.selected : '';
    let clickGuard = null;
    root.classList.add('free-layout-root');
    if (editing) root.classList.add('free-layout-editing');
    root.style.setProperty('position', 'relative');
    function adopt(id, node) {
      const fills = Array.from(node.querySelectorAll ? node.querySelectorAll('[data-free-fill]') : []).map((fill) => ({ fill, saved: saveStyles(fill, FILL_STYLE) }));
      records.set(id, { node, saved: saveStyles(node, ITEM_STYLE), fills, min: minOf(node) });
      if (!editing) return;
      const control = doc.createElement('div'); control.className = 'free-layout-controls';
      control.setAttribute('data-free-control', id);
      const add = (mode, dir, label, text) => {
        const handle = doc.createElement('button'); handle.type = 'button';
        handle.className = `free-layout-handle free-layout-handle--${mode}`; handle.setAttribute('data-free-handle', mode);
        if (dir) handle.setAttribute('data-free-dir', dir);
        handle.setAttribute('aria-label', label); handle.setAttribute('title', `${label}. Стрелки — 1 пиксель, Shift — 10.`);
        handle.textContent = text; control.appendChild(handle);
      };
      add('move', '', 'Переместить элемент', '✥');
      for (const [dir, words] of RESIZE_DIRS) add('resize', dir, `Изменить размер: край ${words}`, '');
      controls.set(id, control); root.appendChild(control);
    }
    for (const [id, node] of children(root)) if (own(current.items, id)) adopt(id, node);
    function geometry(width) {
      const s = Math.min(width / current.width, maxScale);
      return { s, offset: Math.max(0, (width - current.width * s) / 2) };
    }
    // New objects get their natural size and are stacked under the rendered items; existing boxes never move.
    function completeMissing(width) {
      if (!autoComplete || completed) return;
      const missing = Array.from(children(root)).filter(([id]) => !own(current.items, id));
      if (!missing.length) { completed = true; return; }
      const frame = frameOf(root);
      if (!frame) return;
      completed = true;
      const { s, offset: off } = geometry(width);
      let y = 0;
      for (const [id] of records) { const box = current.items[id]; if (box) y = Math.max(y, box.y + box.height + STACK_GAP); }
      const next = clone(current), adopted = [];
      for (const [id, node] of missing) {
        if (Object.keys(next.items).length >= MAX_ITEMS) break;
        const box = boxOf(frame, node);
        if (!box) continue;
        const placed = item({ x: Math.max(0, (box.x - off) / s), y, width: Math.max(MIN_SIZE, box.width / s), height: Math.max(1, box.height / s) });
        if (!placed) continue;
        next.items[id] = placed; y = placed.y + placed.height + STACK_GAP;
        next.height = Math.min(MAX, Math.max(next.height, placed.y + placed.height));
        adopted.push([id, node]);
      }
      if (!adopted.length) return;
      current = normalize(next);
      for (const [id, node] of adopted) adopt(id, node);
      if (typeof onComplete === 'function' && !completionQueued) {
        completionQueued = true;
        Promise.resolve().then(() => { completionQueued = false; if (!disposed) onComplete(clone(current)); });
      }
    }
    function render() {
      if (disposed) return;
      const width = root.clientWidth;
      if (!(width > 0)) return;
      completeMissing(width);
      ({ s: scale, offset } = geometry(width));
      let height = current.height;
      for (const [id] of records) { const box = current.items[id]; if (box) height = Math.max(height, box.y + box.height); }
      root.style.setProperty('height', `${round(Math.min(MAX, height) * scale)}px`);
      root.style.setProperty('--free-scale', String(round(scale) || 1)); root.style.setProperty('--free-offset', `${round(offset)}px`);
      for (const [id, record] of records) {
        const box = current.items[id]; if (!box) continue;
        const style = record.node.style;
        style.setProperty('position', 'absolute'); style.setProperty('left', `${round(offset + box.x * scale)}px`);
        style.setProperty('top', `${round(box.y * scale)}px`); style.setProperty('width', `${box.width}px`);
        style.setProperty('height', `${box.height}px`); style.setProperty('margin', '0');
        style.setProperty('max-width', 'none'); style.setProperty('min-width', '0'); style.setProperty('max-height', 'none'); style.setProperty('min-height', '0');
        style.setProperty('box-sizing', 'border-box');
        style.setProperty('transform-origin', '0 0'); style.setProperty('transform', `scale(${scale})`);
        style.setProperty('--free-left', `${box.x}px`); style.setProperty('--free-right', `${round(current.width - box.x - box.width)}px`);
        for (const { fill } of record.fills) {
          fill.style.setProperty('width', '100%'); fill.style.setProperty('height', '100%'); fill.style.setProperty('min-width', '0'); fill.style.setProperty('min-height', '0');
          fill.style.setProperty('max-width', 'none'); fill.style.setProperty('max-height', 'none'); fill.style.setProperty('box-sizing', 'border-box'); fill.style.setProperty('flex-shrink', '0');
        }
        const control = controls.get(id);
        if (control) {
          control.style.setProperty('left', `${round(offset + box.x * scale)}px`); control.style.setProperty('top', `${round(box.y * scale)}px`);
          control.style.setProperty('width', `${round(box.width * scale)}px`); control.style.setProperty('height', `${round(box.height * scale)}px`);
          control.classList.toggle('is-selected', id === selected);
          // Only the selected object's resize handles are in the tab order; every move handle stays reachable.
          for (const handle of control.querySelectorAll('[data-free-handle="resize"]')) handle.tabIndex = id === selected ? 0 : -1;
        }
      }
    }
    function select(id) {
      if (selected === id) return;
      selected = id; render();
      if (typeof onSelect === 'function') onSelect(id);
    }
    function emit() { if (!disposed && typeof onChange === 'function') onChange(clone(current)); }
    function addGestureListeners() {
      global.addEventListener('pointermove', move, { capture: true, passive: false });
      global.addEventListener('pointerup', end, true); global.addEventListener('pointercancel', cancel, true);
      global.addEventListener('keydown', escape, true);
    }
    function removeGestureListeners() {
      global.removeEventListener('pointermove', move, true); global.removeEventListener('pointerup', end, true);
      global.removeEventListener('pointercancel', cancel, true); global.removeEventListener('keydown', escape, true);
    }
    // The click that ends a real drag must not also press the dragged button or toggle a form.
    function swallowNextClick() {
      if (clickGuard) global.removeEventListener('click', clickGuard, true);
      clickGuard = (event) => { event.preventDefault(); event.stopPropagation(); };
      global.addEventListener('click', clickGuard, true);
      const guard = clickGuard;
      global.setTimeout(() => { global.removeEventListener('click', guard, true); if (clickGuard === guard) clickGuard = null; }, 0);
    }
    function finish(commit) {
      if (pending) { pending = null; if (!active) removeGestureListeners(); }
      if (!active) return;
      const gesture = active; active = null; removeGestureListeners();
      try { gesture.capture.releasePointerCapture(gesture.pointerId); } catch (_) {}
      if (!commit) current = gesture.before;
      render();
      if (gesture.changed) swallowNextClick();
      if (commit && gesture.changed) emit();
    }
    function start(id, mode, pointerId, clientX, clientY, captureNode, dir = 'se') {
      const rect = root.getBoundingClientRect(), externalScale = rect.width / (root.offsetWidth || root.clientWidth);
      const ratio = scale * externalScale;
      if (!(ratio > 0)) return false;
      active = { id, mode, dir, pointerId, clientX, clientY, ratio, before: clone(current), changed: false, capture: captureNode, min: (records.get(id) || {}).min || MIN_SIZE };
      try { captureNode.setPointerCapture(pointerId); } catch (_) {}
      return true;
    }
    function move(event) {
      if (disposed) return;
      if (pending && !active && event.pointerId === pending.pointerId) {
        if (Math.hypot(event.clientX - pending.clientX, event.clientY - pending.clientY) < DRAG_THRESHOLD) return;
        const { id, pointerId, clientX, clientY, node } = pending; pending = null;
        if (!start(id, 'move', pointerId, clientX, clientY, node)) { removeGestureListeners(); return; }
      }
      if (!active || event.pointerId !== active.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      const dx = (event.clientX - active.clientX) / active.ratio;
      const dy = (event.clientY - active.clientY) / active.ratio;
      const initial = active.before.items[active.id];
      const patch = active.mode === 'resize' ? resized(initial, active.dir, dx, dy, active.min)
        : { x: clamp(initial.x + dx, 0, Math.max(0, active.before.width - MIN_SIZE)), y: clamp(initial.y + dy, 0) };
      const next = updateItem(active.before, active.id, patch);
      if (!next) return;
      current = next;
      const box = current.items[active.id]; current.height = Math.min(MAX, Math.max(active.before.height, box.y + box.height));
      active.changed = KEYS.some((key) => box[key] !== initial[key]); render();
    }
    function end(event) {
      if (pending && !active && event.pointerId === pending.pointerId) {
        // A click without a drag only selects; the move handle then takes arrow keys (not when a field was clicked).
        const { id, focusHandle } = pending; finish(false);
        const handle = focusHandle && controls.get(id) ? controls.get(id).querySelector('[data-free-handle="move"]') : null;
        if (handle) { try { handle.focus({ preventScroll: true }); } catch (_) { handle.focus(); } }
        return;
      }
      if (!active || event.pointerId !== active.pointerId) return;
      move(event); finish(true);
    }
    function cancel(event) {
      if (pending && event.pointerId === pending.pointerId) { finish(false); return; }
      if (active && event.pointerId === active.pointerId) { event.stopPropagation(); finish(false); }
    }
    function escape(event) {
      if (event.key !== 'Escape' || !(active || pending)) return;
      event.preventDefault(); event.stopPropagation(); finish(false);
    }
    function ownHandle(target) {
      const handle = target && target.closest ? target.closest('[data-free-handle]') : null;
      const control = handle && handle.parentNode;
      return control && control.parentNode === root && controls.get(control.getAttribute('data-free-control')) === control ? handle : null;
    }
    function down(event) {
      if (disposed || active || pending || (event.button !== undefined && event.button !== 0)) return;
      const nearestRoot = event.target && event.target.closest ? event.target.closest('.free-layout-root') : null;
      if (nearestRoot && nearestRoot !== root) return;
      const handle = ownHandle(event.target);
      if (!handle) {
        const node = event.target && event.target.closest ? event.target.closest('[data-free-id]') : null;
        if (!node || node.parentNode !== root || !records.has(node.getAttribute('data-free-id'))) return;
        const id = node.getAttribute('data-free-id');
        select(id);
        // Zero Block style: drag the object itself; fields, selects and native drag handles keep their own behaviour.
        const interactive = event.target.closest(INTERACTIVE);
        if (interactive && node.contains(interactive)) return;
        pending = { id, node, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, focusHandle: true };
        addGestureListeners();
        return;
      }
      const id = handle.parentNode.getAttribute('data-free-control'), mode = handle.getAttribute('data-free-handle');
      const dir = RESIZE_DIRS.some(([d]) => d === handle.getAttribute('data-free-dir')) ? handle.getAttribute('data-free-dir') : 'se';
      event.preventDefault(); event.stopPropagation();
      if (!start(id, mode, event.pointerId, event.clientX, event.clientY, handle, dir)) return;
      addGestureListeners();
      select(id);
    }
    function key(event) {
      const handle = ownHandle(event.target);
      if (!handle || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Escape') { finish(false); return; }
      const id = handle.parentNode.getAttribute('data-free-control'), box = current.items[id], step = event.shiftKey ? 10 : 1;
      const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
      const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -step : step;
      const resize = handle.getAttribute('data-free-handle') === 'resize';
      let patch;
      if (resize) {
        // Arrows move the edge(s) this handle stands for; a corner handle takes both axes.
        const dir = handle.getAttribute('data-free-dir') || 'se', min = (records.get(id) || {}).min || MIN_SIZE;
        const axisDir = horizontal ? (dir.includes('w') ? 'w' : dir.includes('e') ? 'e' : '') : (dir.includes('n') ? 'n' : dir.includes('s') ? 's' : '');
        if (!axisDir) return;
        patch = resized(box, axisDir, horizontal ? delta : 0, horizontal ? 0 : delta, min);
      } else patch = { [horizontal ? 'x' : 'y']: box[horizontal ? 'x' : 'y'] + delta };
      const next = updateItem(current, id, patch);
      if (!next) return;
      const unchanged = KEYS.every((k) => next.items[id][k] === box[k]);
      current = next; current.height = Math.min(MAX, Math.max(current.height, next.items[id].y + next.items[id].height));
      select(id); render();
      if (!unchanged) emit();
    }
    if (editing) {
      root.addEventListener('pointerdown', down, true); root.addEventListener('keydown', key, true);
    }
    render();
    if (typeof global.ResizeObserver === 'function') { observer = new global.ResizeObserver(render); observer.observe(root); }
    function dispose() {
      if (disposed) return;
      finish(false); disposed = true;
      if (observer) observer.disconnect();
      if (editing) { root.removeEventListener('pointerdown', down, true); root.removeEventListener('keydown', key, true); }
      removeGestureListeners();
      for (const control of controls.values()) control.remove();
      for (const record of records.values()) { restoreStyles(record.node, record.saved); for (const { fill, saved } of record.fills) restoreStyles(fill, saved); }
      restoreStyles(root, originalRoot);
      if (!hadRootClass) root.classList.remove('free-layout-root');
      if (!hadEditingClass) root.classList.remove('free-layout-editing');
      if (bindings.get(root) === dispose) bindings.delete(root);
    }
    bindings.set(root, dispose); return dispose;
  }
  /* One button-link policy for the editor and the app: only an absolute http:// or https:// URL with a host, without
     credentials, whitespace, control characters or backslashes. Everything else (relative, scheme-relative,
     «https:host», javascript:, data:, file:, mailto: …) gives ''. */
  const ABSOLUTE_HTTP = /^https?:\/\/[^/\\?#@]/i;
  const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\\\s]/;
  function safeUrl(value) {
    if (typeof value !== 'string') return '';
    const source = value.trim();
    if (!source || source.length > 2048 || !ABSOLUTE_HTTP.test(source) || FORBIDDEN_CHARS.test(source)) return '';
    let url;
    try { url = new URL(source); } catch (_) { return ''; }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return '';
    return url.href;
  }
  global.SynapseButtonLink = Object.freeze({ version: 1, safeUrl });
  global.SynapseFreeLayout = Object.freeze({ version: 4, normalize, capture, captureNodes, updateItem, bind,
    limits: Object.freeze({ max: MAX, maxItems: MAX_ITEMS, minSize: MIN_SIZE }) });
})(window);

/* Palitra Love: editable texts of the install / notification windows (project root `notificationTexts`).
   Shared by the editor and the app (browser global SynapseNotificationCopy) and by Node checks (CommonJS).
   Canon: notification-copy-spec.json from Root (schema 1, SHA256 65b393d37ecbc829fa8e28e647f49d1d1ecdc23580be827ae86186ae9eaae20a):
   36 keys with exact defaults, labels and maxLength; unknown keys rejected; '' preserved; fallback to the default only for an
   absent or null key on read; a stored null is rejected on validation; total ≤ 65536 UTF-8 bytes of the JSON of the whole map.
   Characters: LF/CR/TAB allowed only in 400/2000 fields, forbidden in 120/160 fields; every other C0/C1 control and < > rejected.
   Text is rendered with textContent only — no HTML, links or actions. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.SynapseNotificationCopy = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const KEYS = Object.freeze([
    "installTitle",
    "notificationTitle",
    "installClientText",
    "installStaffText",
    "installedText",
    "installButton",
    "installHelpButton",
    "installBusyText",
    "deviceHeading",
    "enableButton",
    "disableButton",
    "laterButton",
    "neverButton",
    "pushUnavailableText",
    "iosInstallText",
    "permissionDeniedText",
    "subscribedText",
    "unsubscribedText",
    "permissionPromptText",
    "unconfirmedText",
    "subscribeErrorText",
    "closeLabel",
    "iosStep1",
    "iosStep2",
    "iosStep3",
    "iosStep4",
    "androidStep1",
    "androidStep2",
    "androidStep3",
    "desktopStep1",
    "desktopStep2",
    "desktopStep3",
    "guideExampleText",
    "guideImageButton",
    "guideSourceLabel",
    "guideBackButton"]);
  const DEFAULTS = Object.freeze({
    installTitle: "Заказ всегда под рукой",
    notificationTitle: "Уведомления Palitra Love",
    installClientText: "Добавьте Palitra Love на главный экран, чтобы возвращаться в чат и отслеживать заказ. Это необязательно.",
    installStaffText: "Закрепите приложение, чтобы быстро открывать заказы и переписку.",
    installedText: "Приложение уже открыто с главного экрана. Выберите, хотите ли получать уведомления на этом устройстве.",
    installButton: "Установить приложение",
    installHelpButton: "Как добавить на главный экран",
    installBusyText: "Подтвердите в браузере…",
    deviceHeading: "Уведомления на этом устройстве",
    enableButton: "Включить уведомления",
    disableButton: "Отключить уведомления",
    laterButton: "Позже",
    neverButton: "Больше не предлагать",
    pushUnavailableText: "Push-уведомления пока не подключены. Заказы и сообщения проверяйте в приложении. Установка сама по себе push не включает.",
    iosInstallText: "Для push на iPhone/iPad сначала добавьте приложение на экран Домой и откройте его оттуда (iOS/iPadOS 16.4 или новее).",
    permissionDeniedText: "Уведомления запрещены в браузере. Откройте настройки этого сайта → «Уведомления» и разрешите их, если хотите получать push.",
    subscribedText: "Уведомления подключены на этом устройстве.",
    unsubscribedText: "Уведомления отключены на этом устройстве.",
    permissionPromptText: "Подтвердите разрешение браузера.",
    unconfirmedText: "Подписка не подтверждена сервером. Push пока не включён.",
    subscribeErrorText: "Не удалось подключить уведомления. Можно продолжить без них.",
    closeLabel: "Закрыть предложение",
    iosStep1: "Откройте эту страницу в Safari. Если вы пришли из Telegram или другой соцсети, откройте ссылку во внешнем браузере Safari.",
    iosStep2: "Нажмите «Ещё» (…) внизу справа, затем «Поделиться». В другом виде Safari кнопка «Поделиться» может быть сразу на панели.",
    iosStep3: "Выберите «На экран Домой». Если пункта нет, прокрутите список действий ниже.",
    iosStep4: "Оставьте «Открывать как веб-приложение» включённым, нажмите «Добавить». Открывайте Palitra Love с нового значка.",
    androidStep1: "Откройте страницу в Chrome и нажмите меню ⋮ вверху справа.",
    androidStep2: "Выберите «Установить приложение» или «Добавить на главный экран». Название пункта зависит от версии Chrome.",
    androidStep3: "Подтвердите установку и открывайте Palitra Love с нового значка.",
    desktopStep1: "Откройте меню браузера ⋮ или ….",
    desktopStep2: "Выберите «Установить приложение» или «Приложения» → «Установить этот сайт как приложение».",
    desktopStep3: "Подтвердите установку и открывайте Palitra Love с нового значка.",
    guideExampleText: "Пример интерфейса; название сайта и пункты меню могут отличаться. У вас будет Palitra Love.",
    guideImageButton: "Увеличить изображение",
    guideSourceLabel: "Официальная инструкция",
    guideBackButton: "Вернуться к шагам"});
  const LABELS = Object.freeze({
    installTitle: "Заголовок установки",
    notificationTitle: "Заголовок уведомлений",
    installClientText: "Текст установки для клиента",
    installStaffText: "Текст установки для сотрудника",
    installedText: "Текст установленного приложения",
    installButton: "Кнопка установки",
    installHelpButton: "Кнопка инструкции",
    installBusyText: "Ожидание установки",
    deviceHeading: "Заголовок устройства",
    enableButton: "Кнопка включения",
    disableButton: "Кнопка отключения",
    laterButton: "Кнопка позже",
    neverButton: "Кнопка больше не предлагать",
    pushUnavailableText: "Push недоступен",
    iosInstallText: "Установка перед Push на iPhone",
    permissionDeniedText: "Разрешение запрещено",
    subscribedText: "Подключено",
    unsubscribedText: "Отключено",
    permissionPromptText: "Запрос разрешения",
    unconfirmedText: "Подписка не подтверждена",
    subscribeErrorText: "Ошибка подключения",
    closeLabel: "Подпись закрытия",
    iosStep1: "iPhone — шаг 1",
    iosStep2: "iPhone — шаг 2",
    iosStep3: "iPhone — шаг 3",
    iosStep4: "iPhone — шаг 4",
    androidStep1: "Android — шаг 1",
    androidStep2: "Android — шаг 2",
    androidStep3: "Android — шаг 3",
    desktopStep1: "Компьютер — шаг 1",
    desktopStep2: "Компьютер — шаг 2",
    desktopStep3: "Компьютер — шаг 3",
    guideExampleText: "Подпись примеров",
    guideImageButton: "Кнопка увеличения скриншота",
    guideSourceLabel: "Ссылка на источник",
    guideBackButton: "Кнопка возврата из изображения"});
  const MAX_LENGTH = Object.freeze({ installTitle: 160, notificationTitle: 160, installClientText: 2000, installStaffText: 2000, installedText: 2000, installButton: 120, installHelpButton: 120, installBusyText: 120, deviceHeading: 160, enableButton: 120, disableButton: 120, laterButton: 120, neverButton: 120, pushUnavailableText: 2000, iosInstallText: 2000, permissionDeniedText: 2000, subscribedText: 2000, unsubscribedText: 2000, permissionPromptText: 2000, unconfirmedText: 2000, subscribeErrorText: 2000, closeLabel: 120, iosStep1: 400, iosStep2: 400, iosStep3: 400, iosStep4: 400, androidStep1: 400, androidStep2: 400, androidStep3: 400, desktopStep1: 400, desktopStep2: 400, desktopStep3: 400, guideExampleText: 400, guideImageButton: 120, guideSourceLabel: 120, guideBackButton: 120 });
  const MAX_UTF8_BYTES = 65536;
  // Editor grouping only (derived from maxLength): 160 titles, 120 buttons, 2000 texts, 400 steps.
  const GROUP_BY_LIMIT = { 160: 'title', 120: 'button', 2000: 'text', 400: 'step' };
  const GROUP_OF = Object.freeze(Object.fromEntries(KEYS.map((key) => [key, GROUP_BY_LIMIT[MAX_LENGTH[key]]])));
  const GROUPS = Object.freeze(Object.fromEntries(['title', 'button', 'text', 'step'].map((group) => [group, Object.freeze(KEYS.filter((key) => GROUP_OF[key] === group))])));
  const LIMITS = Object.freeze({ title: 160, button: 120, text: 2000, step: 400, totalBytes: MAX_UTF8_BYTES });
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  // Same plain-data contract as the free layout: ordinary Object of any realm or Object.create(null); own data properties only.
  function field(object, key) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && own(descriptor, 'value') ? descriptor.value : undefined;
  }
  function plain(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    if (proto === null) return true;
    if (Object.getPrototypeOf(proto) !== null) return false;
    const ctor = field(proto, 'constructor');
    if (typeof ctor !== 'function' || field(ctor, 'prototype') !== proto || field(ctor, 'name') !== 'Object') return false;
    try { return /^function Object\(\) \{\s*\[native code\]\s*\}$/.test(Function.prototype.toString.call(ctor)); } catch (_) { return false; }
  }
  const length = (s) => Array.from(s).length;   // characters = Unicode code points (JSON Schema maxLength semantics)
  const utf8 = (s) => { let n = 0; for (const ch of s) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; } return n; };
  const SINGLE_LINE_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f<>]/;
  const MULTI_LINE_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f<>]/;   // TAB \u0009, LF \u000a, CR \u000d allowed
  /* One value for one key: '' when valid, otherwise a Russian reason. */
  function checkValue(key, value) {
    if (!own(MAX_LENGTH, key)) return 'Неизвестное поле';
    if (typeof value !== 'string') return 'Значение должно быть текстом';
    const max = MAX_LENGTH[key], multi = max === 400 || max === 2000;
    if (length(value) > max) return `Не длиннее ${max} символов`;
    if (/[<>]/.test(value)) return 'Символы < и > недопустимы: только обычный текст, без HTML';
    if ((multi ? MULTI_LINE_FORBIDDEN : SINGLE_LINE_FORBIDDEN).test(value)) return multi ? 'Недопустимые управляющие символы' : 'Без переносов строк, табуляции и управляющих символов';
    return '';
  }
  const totalBytes = (map) => utf8(JSON.stringify(map));
  /* Strict check of a stored/written object: absent → ok (all defaults); unknown keys, null values, accessors → errors. */
  function validate(input) {
    if (input === undefined) return { ok: true, value: null, errors: [] };
    if (!plain(input)) return { ok: false, value: null, errors: [{ key: '', message: 'notificationTexts должен быть простым объектом' }] };
    const errors = [], value = {};
    for (const key of Object.keys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!own(MAX_LENGTH, key)) { errors.push({ key, message: 'Неизвестное поле' }); continue; }
      if (!descriptor || !own(descriptor, 'value')) { errors.push({ key, message: 'Только обычное значение (не вычисляемое)' }); continue; }
      if (descriptor.value === null) { errors.push({ key, message: 'null не сохраняется: удалите поле, чтобы вернуть стандартный текст' }); continue; }
      const message = checkValue(key, descriptor.value);
      if (message) errors.push({ key, message }); else value[key] = descriptor.value;
    }
    if (!errors.length) {
      const total = totalBytes(value);
      if (total > MAX_UTF8_BYTES) errors.push({ key: '', message: `Все тексты вместе не больше ${MAX_UTF8_BYTES} байт UTF-8 (сейчас ${total})` });
    }
    return errors.length ? { ok: false, value: null, errors } : { ok: true, value, errors: [] };
  }
  /* Next stored object after editing one key: a string is stored as is ('' included); undefined removes the key (default).
     An invalid stored object (unknown keys, null, …) makes the editor read-only, so nothing foreign is overwritten. */
  function withValue(input, key, next) {
    const current = validate(input);
    if (!current.ok) return { ok: false, value: null, errors: current.errors };
    const value = { ...(current.value || {}) };
    if (next === undefined) delete value[key];
    else {
      const message = checkValue(key, next);
      if (message) return { ok: false, value: null, errors: [{ key, message }] };
      value[key] = next;
    }
    const checked = validate(value);
    return checked.ok ? { ok: true, value: Object.keys(value).length ? value : null, errors: [] } : checked;
  }
  /* Texts to show: every key present; a valid stored string wins ('' stays ''); absent or null → default. An invalid
     value of a known key also shows the default (the app never renders an unchecked string). */
  function resolve(input) {
    const out = {};
    const source = plain(input) ? input : null;
    for (const key of KEYS) {
      const value = source ? field(source, key) : undefined;
      out[key] = typeof value === 'string' && !checkValue(key, value) ? value : DEFAULTS[key];
    }
    return Object.freeze(out);
  }
  return Object.freeze({ version: 2, specSchema: 1, KEYS, GROUPS, GROUP_OF, LIMITS, MAX_LENGTH, MAX_UTF8_BYTES, DEFAULTS, LABELS, checkValue, validate, withValue,
    resolve, totalBytes, utf8Length: utf8 });
});


/* Read-only visual settings. Native identities, transports and bindings stay in the frozen shell. */
(function (global) {
  'use strict';
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const plain = v => v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
  const frameKeys = ['title','eyebrow','presentation','photoSrc','hidden','menuVisible','menuLabel','menuOrder','orderTabs','categories','freeLayout'];
  const blockKeys = ['id','type','title','subtitle','text','label','placeholder','target','orderGroup','action','url','src','presentation','toggleLabel','nameLabel','messengerLabel','contactLabel','submitLabel','hint','namePlaceholder','contactPlaceholder','contactPlaceholders','collapsible','phoneOnly','nameRequired','contactRequired','channels','hiddenParts','partOrder','fields','inputType','required','options','textStyles','freeLayout','presentationHidden'];
  const roles = ['client','staff','admin'];
  const kinds = ['landing','orders','history','detail','chat','review','menu','editor','reports','website','custom'];
  const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v) && !['__proto__','prototype','constructor'].includes(v);
  function picked(value, keys) { const out = {}; for (const key of keys) if (own(value,key)) out[key] = value[key]; return out; }
  function options(value) { return Array.isArray(value) ? value.slice(0,50).map(v=>typeof v === 'string' ? v : plain(v) ? picked(v,['label','value']) : '').filter(v=>v !== '') : []; }
  function styles(value) {
    const out={}; if (!plain(value)) return out;
    for (const key of Object.keys(value)) if (/^(?:title|subtitle|text|label|placeholder|toggleLabel|nameLabel|messengerLabel|contactLabel|submitLabel|hint|namePlaceholder|contactPlaceholder|field:[A-Za-z0-9_.:-]+)$/.test(key) && plain(value[key]))
      out[key]=picked(value[key],['font','size','bold','italic','underline','align','color','lineHeight']);
    return out;
  }
  function layout(value) {
    const out=picked(plain(value)?value:{},['enabled','width','height']);out.items={};
    if (plain(value) && plain(value.items)) for(const key of Object.keys(value.items)) if(id(key) && plain(value.items[key])) out.items[key]=picked(value.items[key],['x','y','width','height']);
    return out;
  }
  function nested(out) {
    if (own(out,'fields')) out.fields=Array.isArray(out.fields)?out.fields.slice(0,30).filter(plain).map(f=>{
      const field=picked(f,['id','type','label','placeholder','required','hidden']);if(own(f,'options'))field.options=options(f.options);return field;
    }):[];
    if(own(out,'options'))out.options=options(out.options);
    if(own(out,'textStyles'))out.textStyles=styles(out.textStyles);
    if(own(out,'freeLayout'))out.freeLayout=layout(out.freeLayout);
    if(own(out,'contactPlaceholders'))out.contactPlaceholders=picked(plain(out.contactPlaceholders)?out.contactPlaceholders:{},['telegram','whatsapp','max','call','vk']);
    if(own(out,'orderTabs'))out.orderTabs=picked(plain(out.orderTabs)?out.orderTabs:{},['active','history']);
    if(own(out,'categories'))out.categories=Array.isArray(out.categories)?out.categories.slice(0,3).filter(plain).map(c=>nested(picked(c,['label','icon','target','textStyles']))):[];
    return out;
  }
  function merge(base, packet) {
    if (!plain(base) || !Array.isArray(base.frames) || !plain(packet) || packet.schema !== 1 || !Number.isSafeInteger(packet.revision) || packet.revision < 0 || !plain(packet.visual)) throw new Error('Invalid visual settings');
    const v = packet.visual;
    if (typeof v.appTitle !== 'string' || v.appTitle.length > 400 || !Array.isArray(v.frames) || !v.frames.length || v.frames.length > 200 || JSON.stringify(v).length > 1048576) throw new Error('Invalid visual settings');
    const ids = new Set(), frames = v.frames.map(f => {
      if (!plain(f) || !id(f.id) || ids.has(f.id) || !roles.includes(f.role) || !kinds.includes(f.kind) || !Array.isArray(f.blocks) || f.blocks.length > 200) throw new Error('Invalid visual frame');
      ids.add(f.id);
      const old = base.frames.find(b => b.id === f.id), blockIds = new Set();
      const blocks = f.blocks.map(b => {
        if (!plain(b) || !id(b.id) || blockIds.has(b.id) || typeof b.type !== 'string') throw new Error('Invalid visual block');
        blockIds.add(b.id);
        const previous = old && old.blocks && old.blocks.find(x => x.id === b.id);
        // Incoming data cannot replace source/bindings or grant a new transport.
        return { ...(previous || {}), ...nested(picked(b, blockKeys)) };
      });
      return { ...(old || { id:f.id, role:f.role, kind:f.kind, device:f.device === 'desktop' ? 'desktop' : 'mobile' }), ...nested(picked(f, frameKeys)), blocks };
    });
    const menus = {};
    if (plain(v.menus)) for (const role of roles) {
      const menu = v.menus[role];
      if (!plain(menu) || !Array.isArray(menu.items) || menu.items.length > 200) continue;
      menus[role] = { ...nested(picked(menu,['id','type','title','textStyles'])), items:menu.items.filter(plain).map(i=>nested(picked(i,['id','label','target','hidden','textStyles']))) };
    }
    return { ...base, appTitle:v.appTitle, frames, menus };
  }
  async function load(base, host, win) {
    if (!host || host.mode !== 'native' || host.verified !== true || !host.transport || host.transport.kind !== 'native' || !win.location || typeof win.fetch !== 'function') return base;
    const origin = win.location.origin;
    const path = origin === 'https://synapse.synapsebusiness.ru' ? '/content/palitra/design' : ['https://palitra-love.ru','https://palitra-love-draft-1.synapsebusiness.ru'].includes(origin) ? '/love-app/design.json' : null;
    if (!path) return base;
    const controller = new win.AbortController();
    let timer;
    const fallback = new Promise(resolve => { timer=win.setTimeout(()=>{controller.abort();resolve(base);},3000); });
    const request = (async()=>{
      try {
        const response=await win.fetch(path,{method:'GET',credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal});
        if (!response.ok) return base;
        const raw=await response.text(); if (raw.length>1048576) return base;
        return merge(base,JSON.parse(raw));
      } catch (_) { return base; }
    })();
    try { return await Promise.race([request,fallback]); } finally { win.clearTimeout(timer); }
  }
  global.PalitraSafeVisual=Object.freeze({merge,load});
})(typeof window === 'undefined' ? globalThis : window);

/* Palitra Love Заказы — мобильная оболочка поверх существующих контрактов Synapse (14.10.2026).
   Экраны, подписи и порядок блоков — из снимка макета (PALITRA_DESIGN, только оформление/навигация). Данные — только
   через SynapseBridge и внедрённый host: в локальном предпросмотре это in-memory mock (index.html). Оболочка сама не
   создаёт native-транспорт, не читает fetch, не держит БД/таймеров/опроса. Роль экранов выводится из ответов
   backend (whoami / portal actor); переключатель «Предпросмотр» есть только у mock-хоста и выбирает набор fixture. */
'use strict';

(() => {
  const ROOT_BRIDGE = window.SynapseBridge, HOST = window.PalitraShellHost;
  let B = ROOT_BRIDGE;
  const Companies = window.SynapseCompanies;
  const multiCompany = Boolean(Companies && HOST?.selectCompany && document.documentElement.dataset.entry === 'cabinet');
  let activeCompany = 'palitra-love', companyContext = null;
  const companyForms = new Map();
  const SalonReports = window.SynapseCustomerReports;
  const salonQueries = new Map();
  let reportNavigation = null;
  let salonReportView = null, salonReportKey = '', initialSalonReport = null, salonEntryError = '';
  // PALITRA_SOURCE_REPORT_BEGIN
  const SOURCE_REPORT_LABELS=Object.freeze({vk:'ВКонтакте',telegram:'Telegram',instagram:'Instagram',youtube:'YouTube',tiktok:'TikTok',other:'Другая ссылка',unknown:'Без метки'});
  function sourceReportRange(now=Date.now()) { return {from:new Date(now-30*86400000).toISOString(),until:new Date(now).toISOString()}; }
  function checkedSourceReport(data,query) {
    const object=v=>v && typeof v==='object' && !Array.isArray(v),stamp=v=>typeof v==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString()===v;
    const count=n=>Number.isSafeInteger(n)&&n>=0,fail=()=>{throw new Error('Не удалось проверить статистику источников. Обновите отчёт.');};
    if(!object(data)||data.schema!=='palitra-attribution/v1'||data.companyCode!=='palitra-love'||!['ready','empty','not_observed'].includes(data.status)||!stamp(data.startedAt)||!stamp(data.asOf)||!stamp(data.from)||!stamp(data.until)||data.from!==query.from||data.until!==query.until||data.from>data.until||data.until>data.asOf||Date.parse(data.until)-Date.parse(data.from)>366*86400000||!object(data.coverage)||data.coverage.visits!=='consented_only'||data.coverage.leads!=='new_accepted_only'||data.coverage.historicalVisits!=='not_backfilled'||!Array.isArray(data.sources)||data.sources.length!==7)fail();
    const known=data.status!=='not_observed',seen=new Set(),totals={visits:0,leads:0,linkedLeads:0};
    if(data.startedAt>data.asOf || known!==(data.until>data.startedAt))fail();
    for(const row of data.sources) {
      if(!object(row)||!Object.prototype.hasOwnProperty.call(SOURCE_REPORT_LABELS,row.source)||seen.has(row.source))fail();seen.add(row.source);
      for(const key of Object.keys(totals)){if(known?!count(row[key]):row[key]!==null)fail();if(known){totals[key]+=row[key];if(!count(totals[key]))fail();}}
      if(known&&row.linkedLeads>row.leads)fail();
    }
    if(known){if(!object(data.totals)||Object.keys(totals).some(k=>data.totals[k]!==totals[k]))fail();if(data.status==='empty'&&Object.values(totals).some(n=>n!==0)||data.status==='ready'&&!totals.visits&&!totals.leads)fail();}
    else if(data.totals!==null)fail();
    return data;
  }
  function createSourceReport({h,win,read,help,isCurrent}) {
    const element=h('section',{class:'card source-report','aria-label':'Источники клиентов'});
    let request=null,serial=0,disposed=false;
    function paint({mode,data,query}={}) {
      const refresh=h('button',{type:'button',class:'app-btn app-btn--ghost',disabled:mode==='loading',onclick:()=>{void load();},text:'Обновить'});
      const rows=[h('div',{class:'source-report__header'},h('h2',{class:'text__title',text:'Источники клиентов'}),help?.('Переходы учитываются только после согласия на аналитику, обращения — с момента запуска учёта. «Связано с переходом» — обращения с подтверждённым переходом. Метка ссылки не доказывает рекламный источник. Процент конверсии здесь не рассчитывается.','О статистике источников'),refresh)];
      if(query)rows.push(h('p',{class:'source-report__period',text:'За 30 дней · '+new Date(query.from).toLocaleDateString('ru-RU')+' — '+new Date(query.until).toLocaleDateString('ru-RU')}));
      if(mode==='loading')rows.push(h('p',{class:'app-empty',role:'status',text:'Загружаем источники…'}));
      else if(mode!=='ready')rows.push(h('p',{class:mode==='error'?'app-error':'app-empty',role:mode==='error'?'alert':'status',text:mode==='not-started'?'Учёт источников ещё не запущен':mode==='missing'?'Статистика источников сейчас недоступна. Обновите интерфейс.':'Не удалось загрузить источники. Попробуйте обновить отчёт.'}));
      else {
        if(data.status==='not_observed')rows.push(h('p',{class:'app-empty',text:'Нет данных за этот период.'}));
        const bySource=new Map(data.sources.map(row=>[row.source,row]));
        rows.push(h('ul',{class:'source-report__rows'},Object.entries(SOURCE_REPORT_LABELS).map(([key,label])=>{
          const row=bySource.get(key),metric=(name,value)=>h('div',{},h('dt',{text:name}),h('dd',{text:value===null?'Нет данных':String(value)}));
          return h('li',{},h('h3',{text:label}),h('dl',{},metric('Переходы',row.visits),metric('Обращения',row.leads),metric('Связано с переходом',row.linkedLeads)));
        })));
      }
      element.replaceChildren(...rows);
    }
    async function load() {
      const id=++serial;request?.abort();request=new win.AbortController();const signal=request.signal,query=sourceReportRange();
      if(typeof read!=='function'){paint({mode:'missing',query});return;}
      paint({mode:'loading',query});
      try { const data=checkedSourceReport(await read({...query,signal}),query);if(!disposed&&!signal.aborted&&id===serial&&isCurrent())paint({mode:'ready',data,query}); }
      catch(error){if(!disposed&&!signal.aborted&&id===serial&&isCurrent())paint({mode:error.status===503&&['ATTRIBUTION_NOT_READY','ATTRIBUTION_SCHEMA'].includes(error.code)?'not-started':'error',query});}
    }
    void load();
    return {element,refresh:load,dispose(){disposed=true;serial++;request?.abort();}};
  }
  // PALITRA_SOURCE_REPORT_END

  let sourceReportView=null, sourceReportKey='';
  let responseReportView = null, responseReportKey = '';
  let contentTasksView = null, contentTasksKey = '', contentTasksOverlay = null;
  function contentTasksAllowed() { return document.documentElement.dataset.entry === 'cabinet' && activeCompany === 'palitra-love' && Boolean(state.role && state.role !== 'client' && auth.cabinet?.member && (auth.cabinet.role === 'owner' || auth.cabinet.permissions.includes('autoposting.view'))); }
  function contentCreateAllowed() { return contentTasksAllowed() && Boolean(auth.cabinet.role === 'owner' || auth.cabinet.permissions.includes('autoposting.edit')); }
  function contentApproveAllowed() { return contentCreateAllowed() && Boolean(auth.cabinet.role === 'owner' || auth.cabinet.permissions.includes('autoposting.approve')); }
  function contentOwnerAllowed() { return contentCreateAllowed() && auth.cabinet.role === 'owner'; }
  function disposeContentTasks() {
    const opened = contentTasksOverlay; contentTasksOverlay = null;
    if (opened) {
      document.removeEventListener('keydown', opened.keydown, true);
      document.removeEventListener('focusin', opened.focusin, true);
      opened.element.remove();
      for (const saved of opened.background) for (const name of ['inert', 'aria-hidden']) {
        if (saved[name] === null) saved.node.removeAttribute(name); else saved.node.setAttribute(name, saved[name]);
      }
    }
    contentTasksView?.dispose(); contentTasksView = null; contentTasksKey = '';
  }
  function closeContentTasks() {
    const opened = contentTasksOverlay; if (!opened) return;
    disposeContentTasks();
    if (opened.binding === managerBinding() && contentTasksAllowed()) {
      if (opened.returnFocus?.isConnected) opened.returnFocus.focus({ preventScroll: true });
      scheduleChatRefresh();
    }
  }
  function showContentTasks(trigger) {
    if (!contentTasksAllowed() || contentTasksOverlay) return;
    const returnFocus = ui.body.querySelector('.chat__input') || document.querySelector('.app-burger') || trigger;
    state.menuOpen = false; state.works = false; state.installOpen = false;
    ui.overlay.replaceChildren(); document.querySelector('.app-burger')?.setAttribute('aria-expanded', 'false');
    if (screenType(frameById(state.frameId)) === 'content-tasks') { ui.body.querySelector('button')?.focus(); return; }
    const close = h('button', { type: 'button', class: 'app-btn app-btn--ghost', 'aria-label': 'Закрыть контент и вернуться', text: 'Назад', onclick: closeContentTasks });
    const element = h('div', { class: 'content-tasks-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Контент', tabindex: '-1' },
      h('div', { class: 'content-tasks-dialog__surface' }, h('div', { class: 'content-tasks-dialog__head' }, h('strong', { text: 'Контент' }), close),
        h('div', { class: 'content-tasks-dialog__body' }, contentTasksScreen())));
    const background = [...document.querySelectorAll('.shell, #toast')].map(node => ({ node, inert: node.getAttribute('inert'), 'aria-hidden': node.getAttribute('aria-hidden') }));
    const focusable = () => [...element.querySelectorAll('button:not(:disabled),a[href],select:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter(node => !node.hidden);
    const keydown = event => {
      if (element.querySelector('[data-content-copy-dialog],[data-content-composer-dialog],.content-calendar-modal,[data-content-material-dialog],[data-content-plan-dialog]') && ['Escape','Tab'].includes(event.key)) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeContentTasks(); }
      else if (event.key === 'Tab') {
        const nodes = focusable(), first = nodes[0], last = nodes[nodes.length - 1];
        if (!first) { event.preventDefault(); element.focus(); }
        else if (event.shiftKey && (!element.contains(document.activeElement) || document.activeElement === first)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (!element.contains(document.activeElement) || document.activeElement === last)) { event.preventDefault(); first.focus(); }
      }
    };
    const focusin = event => { if (!element.contains(event.target)) close.focus({ preventScroll: true }); };
    contentTasksOverlay = { element, background, returnFocus, binding: managerBinding(), keydown, focusin };
    for (const saved of background) { saved.node.setAttribute('inert', ''); saved.node.setAttribute('aria-hidden', 'true'); }
    document.body.append(element); document.addEventListener('keydown', keydown, true); document.addEventListener('focusin', focusin, true);
    stopChatRefresh(); if (managerHome()) abortManagerRead(); close.focus({ preventScroll: true });
  }
  function toggleMenu() {
    state.menuOpen = !state.menuOpen; state.works = false; state.installOpen = false;
    if (state.menuOpen && managerAllowed()) void orderReads.read();
    ui.overlay.replaceChildren(state.menuOpen ? roleMenu() : '');
    renderCompanyNav();
    document.querySelector('.app-burger')?.setAttribute('aria-expanded', String(state.menuOpen));
  }
  function contentTasksScreen() {
    if (!contentTasksAllowed()) return h('p', { class: 'app-empty', text: 'Нет подтверждённого доступа к контенту компании.' });
    if (!window.PalitraContentTasksUI || typeof HOST.contentTasks?.read !== 'function') return h('p', { class: 'app-error', role: 'alert', text: 'Контент сейчас недоступен. Обновите интерфейс.' });
    const key = managerBinding();
    if (contentTasksKey !== key) disposeContentTasks();
    if (!contentTasksView) {
      contentTasksKey = key;
      const contentGuard = kind => {
        const allowed = kind === 'owner' ? contentOwnerAllowed() : kind === 'approve' ? contentApproveAllowed() : kind === 'write' ? contentCreateAllowed() : contentTasksAllowed();
        if (key !== managerBinding() || !allowed) throw Object.assign(Error('CONTENT_CONTEXT_CHANGED'), {status:403,definitive:true,contextChanged:true});
      };
      const contentCall = async (method, args, kind = 'read') => {
        contentGuard(kind);
        if (typeof HOST.contentTasks[method] !== 'function') throw Object.assign(Error('CONTENT_METHOD_UNAVAILABLE'), {definitive:true});
        const value = await HOST.contentTasks[method](...args);
        try { contentGuard(kind); } catch (error) { if (kind !== 'read') { error.unknown = true; error.definitive = false; } throw error; }
        return value;
      };
      const composerRead = (method, args, options) => contentCall(method, options === undefined ? [args] : [args,options], method === 'readContext' ? 'read' : 'write');
      contentTasksView = window.PalitraContentTasksUI.create({ document, window,
        canEdit: contentCreateAllowed(), canApprove: contentApproveAllowed(), canOwner: contentOwnerAllowed(),
        readPost: (...args) => contentCall('readPost', args),
        readPosts: (...args) => contentCall('readPosts', args),
        updatePost: (...args) => contentCall('updatePost', args, 'write'),
        performPostAction: (id,action,body,options) => contentCall('performPostAction', [id,action,body,options], ['approve','reject'].includes(action) ? 'approve' : 'write'),
        readMentor: (...args) => contentCall('readMentor', args),
        readPlanVersion: (...args) => contentCall('readPlanVersion', args),
        readBriefVersion: (...args) => contentCall('readBriefVersion', args),
        saveMentorPlan: (...args) => contentCall('saveMentorPlan', args, 'write'),
        decidePlanVariants: (...args) => contentCall('decidePlanVariants', args, 'owner'),
        transferPlanVariants: (...args) => contentCall('transferPlanVariants', args, 'write'),
        canCreate: contentCreateAllowed() && ['readContext','uploadAsset','saveDraft'].every(method => typeof HOST.contentTasks[method] === 'function'),
        readContext: options => composerRead('readContext', options),
        uploadAsset: (file, options) => composerRead('uploadAsset', file, options),
        saveDraft: (body, options) => composerRead('saveDraft', body, options),
        read: async ({ date, signal }) => {
        const value = typeof HOST.contentTasks.readDay === 'function' ? await HOST.contentTasks.readDay({ date, signal }).catch(error => { if(error.status===404) return HOST.contentTasks.read({ signal }); throw error; }) : await HOST.contentTasks.read({ signal });
        if (signal.aborted || key !== managerBinding() || !contentTasksAllowed()) throw new Error('CONTENT_CONTEXT_CHANGED');
        return value;
      }, duplicate: async (...args) => { if(key!==managerBinding()||!contentTasksAllowed()) throw Object.assign(Error('CONTENT_CONTEXT_CHANGED'),{definitive:true}); return HOST.contentTasks.duplicate(...args); }, lookup: async (...args) => { if(key!==managerBinding()||!contentTasksAllowed()) throw Error('CONTENT_CONTEXT_CHANGED'); return HOST.contentTasks.lookup(...args); }, onUnauthorized: error => endSession('cabinet',error.message) });
    }
    return contentTasksView.element;
  }
  function responseReportAllowed() { return document.documentElement.dataset.entry === 'cabinet' && activeCompany === 'palitra-love' && state.role !== 'client' && Boolean(auth.cabinet?.member && caps()['native.orders']); }
  function disposeResponseReport() { disposeSourceReport(); responseReportView?.dispose(); responseReportView = null; responseReportKey = ''; }
  function responseReportScreen() {
    if (!window.PalitraResponseReportUI || typeof HOST.responseReport?.read !== 'function') return h('p', { class: 'app-error', role: 'alert', text: 'Отчёт сейчас недоступен. Обновите интерфейс.' });
    const key = managerBinding();
    if (responseReportKey !== key) disposeResponseReport();
    if (!responseReportView) {
      responseReportKey = key;
      responseReportView = window.PalitraResponseReportUI.create({ document, window, read: async ({ signal }) => {
        const value = await HOST.responseReport.read({ signal });
        if (signal.aborted || key !== managerBinding() || !responseReportAllowed()) throw new Error('REPORT_CONTEXT_CHANGED');
        return value;
      } });
    }
    return responseReportView.element;
  }
  try { initialSalonReport = SalonReports?.entry(location.hash); } catch (error) { salonEntryError = error.message; }
  const salonAllowed = () => Boolean(auth.cabinet?.member && (auth.cabinet.role === 'owner' || auth.cabinet.permissions?.includes('analytics.view')));
  function disposeSalonReports() { salonReportView?.dispose(); salonReportView = null; salonReportKey = ''; }
  function salonReportHash(query) { return '#reports?' + new URLSearchParams({ company: activeCompany, mode: query.mode, month: query.month, ...(query.day ? { day: query.day } : {}) }); }
  function salonReportScreen() {
    const key = `${actorKey()}|${tickets.epoch}`;
    if (!SalonReports || !HOST?.customerReports) return [h('p', { class: 'app-empty', text: 'Отчёты ещё не подключены.' })];
    if (salonReportView && salonReportKey !== key) disposeSalonReports();
    if (!salonReportView) {
      salonReportKey = key;
      salonReportView = SalonReports.create({ document, window, companyCode: activeCompany, query: salonQueries.get(activeCompany),
        request: (query, options) => HOST.customerReports.request(query, options),
        onQuery: query => { salonQueries.set(activeCompany, query); try { history.replaceState(null, '', salonReportHash(query)); reportNavigation?.remember(location.hash); } catch (_) {} },
        onUnauthorized: error => endSession('cabinet', error.message) });
    }
    try { history.replaceState(null, '', salonReportHash(salonReportView.query())); reportNavigation?.remember(location.hash); } catch (_) {}
    return [salonReportView.element];
  }
  let DESIGN = window.PALITRA_DESIGN;
  const $ = (id) => document.getElementById(id);
  const ui = { header: $('header'), body: $('body'), overlay: $('overlay'), toast: $('toast') };
  const freeLayoutPending = [], freeLayoutDisposers = [];
  const freeLayoutAvailable = () => Boolean(window.SynapseFreeLayout && typeof window.SynapseFreeLayout.bind === 'function');
  function freeLayoutModel(layout) {
    if (!freeLayoutAvailable() || typeof window.SynapseFreeLayout.normalize !== 'function') return null;
    try { return window.SynapseFreeLayout.normalize(layout); } catch (_) { return null; }
  }
  function queueFreeLayout(root, layout) {
    const model = freeLayoutModel(layout);
    if (model) freeLayoutPending.push({ root, layout: model });
  }
  function disposeFreeLayouts() {
    while (freeLayoutDisposers.length) { try { freeLayoutDisposers.pop()(); } catch (_) { /* прежний scope уже удалён */ } }
    freeLayoutPending.length = 0;
  }
  function mountFreeLayouts() {
    const mounts = freeLayoutPending.splice(0);
    if (!freeLayoutAvailable()) return;
    for (const mount of mounts) {
      try {
        // Только чтение: числовой макет редактора, новые объекты без рамки — под остальными (в памяти), без увеличения сверх 1:1.
        const dispose = window.SynapseFreeLayout.bind({ ...mount, editing: false, complete: true, maxScale: 1 });
        if (typeof dispose === 'function') freeLayoutDisposers.push(dispose);
      } catch (_) { /* некорректный макет не меняет права и не блокирует форму */ }
    }
  }
  /* Меню ролей. Источник — визуальная модель редактора: project.menus[role] (после явной правки меню), иначе
     прежние стандартные пункты с frame.menuVisible/menuLabel/menuOrder — та же формула, что в редакторе
     (LOCAL_BOARD/dist/app.js defaultMenuItems/effectiveMenu/visibleMenuItems). Пункт меню — только навигация:
     цель обязана быть существующей нескрытой страницей той же роли; доступ к экрану ограничивают права backend. */
  const DEFAULT_MENU = {
    client: [['Каталог', 'K02'], ['Ваши заказы', 'K04'], ['Оставить отзыв', 'K08']],
    staff: [['Фото', 'S06'], ['Каталог редактор', 'S07'], ['Заказы', 'S02']],
    admin: [['Фото', 'A06'], ['Каталог редактор', 'A07'], ['Заказы', 'A02'], ['Отчёты', 'A08']],
  };
  const MENU_HOME = { client: 'K01', staff: 'S01', admin: 'A01' };
  const MENU_HOME_LABEL = { client: 'Главная', staff: 'Главное меню', admin: 'Главное меню' };
  const ROLE_LABEL = { client: 'Клиент', staff: 'Сотрудник', admin: 'Админ' };
  const MENU_TITLE = { client: 'Пользователь', staff: 'Сотрудник', admin: 'Админ' };
  const FORM_CHANNELS = [['telegram', 'Telegram', 'text', 'Номер телефона или @никнейм'], ['whatsapp', 'WhatsApp', 'tel', 'Номер телефона'], ['max', 'MAX', 'text', 'Номер или ссылка MAX'],
    ['call', 'Звонок', 'tel', 'Номер телефона'], ['vk', 'ВКонтакте', 'text', 'Ссылка или имя профиля']];
  const CHANNEL_LABEL = { telegram: 'Telegram', telegram_id: 'Telegram', whatsapp: 'WhatsApp', max: 'MAX', phone: 'Телефон', call: 'Звонок', vk: 'ВКонтакте', instagram: 'Instagram' };
  const PROOF_LABEL = { 'installed-read': 'установлено ранее (чтение подтверждено)', 'accepted-local': 'принято локально, native0', 'reviewed-not-enabled': 'проверено, включение не подтверждено' };

  /* ---------- DOM ---------- */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = String(value);
      else if (key === 'value') el.value = String(value);
      else if (key === 'checked' || key === 'disabled' || key === 'readOnly' || key === 'selected') el[key] = Boolean(value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  function icon(d, size = 20) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' })) el.setAttribute(k, String(v));
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    for (const [k, v] of Object.entries({ d, fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) p.setAttribute(k, v);
    el.append(p);
    return el;
  }
  const chevron = () => { const el = icon('M6 9l6 6 6-6'); el.classList.add('chev'); return el; };
  // PALITRA_APP_HELP_BEGIN: only reviewed, static explanations; never data, errors or consent.
  const appHelpTexts = new Set([
    'Фото работ ведутся штатным редактором фото сайта; здесь они не копируются.',
    'Продолжим в чате. Контакт пригодится, если не сможем связаться здесь.',
    'Нажатие не отмечает, что связь состоялась или клиент ответил.',
    'Palitra Love · данные существующей CRM за выбранный период по московскому времени. Заявки сайта и этапы доставки ведутся в разделе «Заказы».',
    'Каталог и цены — на сайте магазина; копий товаров и фото здесь нет.',
    'Права, CSRF и сохранение — внутри штатного редактора.',
    'Статус обработки отделён от доставки уведомления.',
    'Можно несколько слов: «выписка мальчик». Цена — цифрами: 9270.',
    '(можно несколько; товар останется одним, без копий)',
    'Так товар называется на сайте, в корзине и в заявке.',
    '7720 → «7 720 руб.»; копейки через запятую. Пусто — «Цена уточняется». Текст («от 5000») сохранится как есть, но корзина его не посчитает.',
    'Показывается покупателю в карточке товара.',
    'Что входит в набор. Можно по строкам.',
    'Необязательно. Служебная строка «Цена из публикации…» на сайте не показывается.',
    'Перетащите фото мышью или пальцем. С клавиатуры: стрелки — сдвиг (с Shift — крупнее), «+» и «−» — масштаб, Home — по центру. Сам файл фото не меняется.',
    'Внутренние разделы прайса и старые адреса /catalog/…. Каждый товар лежит в одном разделе; поводы на сайте выбираются в карточке товара. «Показать на сайте» добавляет раздел в каталог сайта как категорию с тем же названием.',
    'Временная подборка собирает товары выбранных категорий на время праздника. Товары и обычные категории не меняются и не удаляются; вне дат подборки на сайте нет.',
    'Товар из нескольких выбранных категорий показывается в подборке один раз.',
    'Для сцены нужны три кадра: для компьютера (горизонтальный, на сайте 16:9), для планшета (горизонтальный, 4:3) и для телефона (вертикальный). Тексты, кнопки и смена сцен не меняются.',
    'При замене фото у этой карточки отключается прежний ролик, чтобы не показывать чужой набор. Новое фото плавно движется, как у карточки «День рождения мужчины». Остальные карточки не меняются.',
    'Меняется только фото и его подпись. Ссылки, суммы и надписи остаются прежними.',
    'Первые 4 фото видны сразу, остальные открываются кнопкой «Показать ещё» (если фото 4 или меньше, кнопки нет). В галерее остаётся хотя бы одно фото. Фото, убранное из показа, остаётся в хранилище материалов, и его можно вернуть.',
    'Порядок категорий на главной задаётся в редакторе прайса',
    'Внутренний раздел (старые адреса /catalog/…). Поводы на сайте выбираются выше.',
    'По одному пункту в строке. Сайт это поле сейчас не показывает.',
    'Можно продолжить переписку в Telegram — она останется и здесь.',
    '«На сайте» ставится только после проверки работающей страницы: нужны ссылка и дата. Статус работы «Отменено» оставляет задачу видимой, но исправлением она не считается — даже если раньше была опубликована.',
    'Ожидается объект с полями schemaVersion, asOf и tasks. Уже существующие задачи обновляются по их идентификатору реестра, копии не создаются.',
    'В режиме «По обращению» начните сообщение с «Хью». В режиме замены Хью участвует в обсуждении проекта.',
    'У одного собственника может быть несколько сайтов в одной переписке. Метка сайта у задачи принимается только из этого списка.'
  ]);
  const appHelp = (()=>{
    let opened=null,sequence=0,scanQueued=false;
    function close(restore=false) {
      if(!opened)return;const old=opened;opened=null;clearTimeout(old.timer);
      old.button.setAttribute('aria-expanded','false');old.pop.remove();
      window.removeEventListener('resize',old.position);window.removeEventListener('scroll',old.position,true);
      window.visualViewport?.removeEventListener('resize',old.position);window.visualViewport?.removeEventListener('scroll',old.position);
      if(restore && old.button.isConnected)old.button.focus({preventScroll:true});
    }
    function helpPosition(anchor,pop,viewport,composer) {
      const gap=8,left=viewport.left+gap,right=viewport.right-gap,top=viewport.top+gap;
      const bottom=Math.max(top+1,Math.min(viewport.bottom-gap,composer?.top>top?composer.top-gap:Infinity));
      const width=Math.max(1,Math.min(320,right-left)),height=Math.max(1,bottom-top);
      const x=Math.min(Math.max(left,anchor.left),Math.max(left,right-width));
      const below=anchor.bottom+gap,above=anchor.top-gap-pop.height;
      const y=below+pop.height<=bottom?below:above>=top?above:Math.min(Math.max(top,below),Math.max(top,bottom-Math.min(pop.height,height)));
      return {left:x,top:y,width,maxHeight:height};
    }
    function button(text,label='Пояснение') {
      const copy=text==='Права, CSRF и сохранение — внутри штатного редактора.'?'Доступ и сохранение изменений проверяются в редакторе.':text;
      const id='app-help-'+(++sequence),trigger=h('button',{type:'button',class:'app-help__trigger','aria-label':label,'aria-expanded':'false','aria-controls':id,text:'?'});
      trigger.addEventListener('click',event=>{
        if(opened?.button===trigger){close();return;}close();
        const pop=h('section',{id,class:'app-help__popover',role:'region','aria-label':label},h('p',{text:copy}),h('button',{type:'button',class:'app-help__close','aria-label':'Закрыть пояснение',text:'×',onclick:()=>close(pop.contains(document.activeElement))}));
        const position=()=>{
          if(!trigger.isConnected){close();return;}
          const v=window.visualViewport,l=v?.offsetLeft||0,t=v?.offsetTop||0;
          // Measure after setting the phone-safe width so wrapping cannot extend below the composer.
          pop.style.width=Math.max(1,Math.min(320,(v?.width||window.innerWidth)-16))+'px';
          const composer=document.querySelector('.chat__dock, .chat__compose, #pc-compose, .pc-compose-row, [data-pc-compose]')?.getBoundingClientRect();
          const r=helpPosition(trigger.getBoundingClientRect(),pop.getBoundingClientRect(),{left:l,top:t,right:l+(v?.width||window.innerWidth),bottom:t+(v?.height||window.innerHeight)},composer);
          Object.assign(pop.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',maxHeight:r.maxHeight+'px'});
        };
        (trigger.closest('dialog[open]') || document.body).append(pop);trigger.setAttribute('aria-expanded','true');
        opened={button:trigger,pop,position,timer:setTimeout(()=>close(pop.contains(document.activeElement)),6000)};
        position();window.addEventListener('resize',position);window.addEventListener('scroll',position,true);
        window.visualViewport?.addEventListener('resize',position);window.visualViewport?.addEventListener('scroll',position);
        if(event.detail===0)pop.querySelector('button').focus({preventScroll:true});
      });
      return h('span',{class:'app-help'},trigger);
    }
    function scan(root=document) {
      if(typeof activeCompany!=='undefined' && activeCompany!=='palitra-love')return;
      for(const node of root.querySelectorAll('p,small')) {
        const text=node.textContent.trim();
        const scheduleText='Сообщение уйдёт в чат проекта и в связанную Telegram-группу в указанное время. До отправки его можно изменить или отменить.';
        const staticTemplate=/^Основное и до \d+ дополнительных\. JPEG, PNG или WebP до 8 МБ; файл загружается как есть, без уменьшения\. «Настроить кадр» меняет только то, как фото стоит в рамке\.$/.test(text) || /^До \d+ категорий в этом порядке\. Остальные покупатель видит по кнопке «Показать ещё»\. Товары при этом не меняются\.$/.test(text);
        if(node.closest('.app-help, .app-help__popover, .chat__msg, .pc-messages, .pc-message-text, .pc-msg__text, .pc-scheduled-item, .pc-personas, #pc-contact, #pc-welcome, [role="log"], [role="alert"], [role="status"]') || node.querySelector('button,input,textarea,select,a') || (!appHelpTexts.has(text)&&!staticTemplate&&text!==scheduleText))continue;
        if(text===scheduleText) {
          node.textContent='Сообщение уйдёт в чат проекта и в связанную Telegram-группу в указанное время.';
          node.append(' ',button('До отправки его можно изменить или отменить.','О запланированном сообщении'));continue;
        }
        const label=node.closest('label'),fieldLabel=label?.querySelector('span')?.textContent.trim();
        const help=button(node.textContent.trim(),fieldLabel?'Пояснение к полю «'+fieldLabel+'»':'Пояснение');
        if(node.id==='pc-telegram-state') {
          // This existing paragraph is updated by the chat renderer. Keep its target identity alive.
          help.append(h('span',{class:'app-help__description',text}));node.replaceChildren(help);continue;
        }
        // Design text styles and layout anchor stay on this small help control.
        for(const [key,value]of Object.entries(node.dataset))help.dataset[key]=value;
        if(node.id)help.append(h('span',{id:node.id,class:'app-help__description',text}));
        node.replaceWith(help);
        if(label) {
          // Keep one form-grid item and the original label/control; never nest another button in a label.
          const group=h('div',{class:'app-help__field'});label.replaceWith(group);group.append(label,help);
        }
      }
      if(opened && !opened.button.isConnected)close();
    }
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&opened){event.preventDefault();close(opened.pop.contains(document.activeElement));}});
    document.addEventListener('pointerdown',event=>{if(opened&&!opened.pop.contains(event.target)&&!opened.button.contains(event.target))close();});
    const observer=new MutationObserver(()=>{if(!scanQueued){scanQueued=true;queueMicrotask(()=>{scanQueued=false;scan();});}});
    observer.observe(document.body,{childList:true,subtree:true});
    scan();
    return Object.freeze({button,scan,close,helpPosition});
  })();
  Object.defineProperty(window,'PalitraHelp',{value:appHelp,writable:false});
  // PALITRA_APP_HELP_END

  let toastTimer = 0;
  function toast(text) {
    ui.toast.textContent = text; ui.toast.hidden = false;
    // Reveal send/access errors in the header without focusing or scrolling message history.
    const top = ui.toast.closest('.chat__top');
    if (top) top.scrollTop = 0;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 3600);
  }
  const str = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}` : ''; };

  /* ---------- макет ---------- */
  const CLIENT_ORDER_CHAT_FRAME = 'K_CURRENT_ORDER_CHAT';
  const SITE_CHAT_FRAME = 'K_SITE_CHAT';
  const WIDGET_SETTINGS_FRAME = 'A_SITE_CHAT_SETTINGS';
  const STAFF_CHAT_FRAMES = Object.freeze({ admin: 'A_SITE_CHATS', staff: 'S_SITE_CHATS' });
  const TEAM_CHAT_FRAMES = Object.freeze({ admin: 'A_TEAM_CHAT', staff: 'S_TEAM_CHAT' });
  const SITE_TOOLS_FRAMES = Object.freeze({admin:'A_SITE_TOOLS',staff:'S_SITE_TOOLS'});
  const SETTINGS_FRAMES = Object.freeze({admin:'A_APP_SETTINGS',staff:'S_APP_SETTINGS'});
  const teamChatAllowed = () => state.role !== 'client' && Boolean(auth.cabinet && ['owner','editor'].includes(auth.cabinet.role) && Companies.available(auth.cabinet).some(p => p.code === activeCompany));
  const frames = () => {
    const existing = DESIGN ? DESIGN.frames : [];
    const builtins = [
      ...(activeCompany==='palitra-love'?Object.entries(SITE_TOOLS_FRAMES).map(([role,id])=>({id,role,kind:'site-tools',device:'phone',title:'Сайт',blocks:[]})):[]),
      ...(activeCompany==='palitra-love'?Object.entries(SETTINGS_FRAMES).map(([role,id])=>({id,role,kind:'app-settings',device:'phone',title:'Настройки',blocks:[]})):[]),
      { id: CLIENT_ORDER_CHAT_FRAME, role: 'client', kind: 'client-current-orders', device: 'phone', title: 'Чат по текущему заказу', blocks: [] },
      { id: 'A10', role: 'admin', kind: 'workflow', device: 'phone', title: 'Автоответ и этапы', blocks: [] },
      { id: WIDGET_SETTINGS_FRAME, role: 'admin', kind: 'widget-settings', device: 'phone', title: 'Чат на сайте', blocks: [] },
      { id: SITE_CHAT_FRAME, role: 'client', kind: 'site-chat', device: 'phone', title: 'Чат с Palitra Love', blocks: [] },
      ...Object.entries(STAFF_CHAT_FRAMES).map(([role, id]) => ({ id, role, kind: 'chat-list', device: 'phone', title: 'Чаты', blocks: [] })),
      ...Object.entries(TEAM_CHAT_FRAMES).map(([role,id]) => ({id,role,kind:'team-chat',device:'phone',title:'Рабочий чат',blocks:[]})),
      ...(contentTasksAllowed() ? ['admin', 'staff'].map(role => ({ id: role === 'admin' ? 'A_CONTENT_TASKS' : 'S_CONTENT_TASKS', role, kind: 'content-tasks', device: 'mobile', title: 'Контент', blocks: [] })) : [])
    ];
    const list = [...existing, ...builtins.filter(f => !existing.some(old => old.id === f.id))];
    if (activeCompany === 'palitra-love') {
      if (responseReportAllowed()) for (const role of ['staff', 'admin']) if (!list.some(f => f.role === role && f.kind === 'reports' && f.hidden !== true)) list.push({ id: role === 'staff' ? 'S_REPORTS' : 'A_REPORTS', role, kind: 'reports', device: 'mobile', title: 'Отчёты', menuVisible: true, blocks: [] });
      return list.map(frame => frame.id === 'A10' && state.role === 'staff' && workflowSettingsAllowed() ? { ...frame, role: 'staff', title: 'Настройки' } : frame);
    }
    if (!salonAllowed()) return list;
    for (const role of ['staff', 'admin']) if (!list.some(f => f.role === role && f.kind === 'reports' && f.hidden !== true))
      list.push({ id: role === 'staff' ? 'S_REPORTS' : 'A_REPORTS', role, kind: 'reports', device: 'mobile', title: 'Отчёты', menuVisible: true, blocks: [] });
    return list.map(frame => {
      if (frame.id !== MENU_HOME[frame.role]) return frame;
      const report = list.find(f => f.role === frame.role && f.kind === 'reports' && f.hidden !== true);
      if (!report || frame.blocks.some(b => b.type === 'button' && b.target === report.id)) return frame;
      return { ...frame, blocks: [...frame.blocks, { id: `${frame.id}-studio-reports`, type: 'button', label: 'Отчёты', target: report.id }] };
    });
  };
  const frameById = (id) => frames().find((f) => f.id === id) || null;
  const blocks = (frame, type) => (frame ? frame.blocks.filter((b) => !type || b.type === type) : []);
  const mobileFrame = (role, kind) => frames().find((f) => f.role === role && f.kind === kind && f.device !== 'desktop') || null;
  function ordersFrames(role) { const a = mobileFrame(role, 'orders'); const t = a && a.orderTabs; return t ? { active: frameById(t.active), history: frameById(t.history) } : { active: a, history: mobileFrame(role, 'history') }; }
  const FONT = { system: "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif", inter: "'Inter', system-ui, sans-serif", roboto: "'Roboto', system-ui, sans-serif",
    'open-sans': "'Open Sans', system-ui, sans-serif", montserrat: "'Montserrat', system-ui, sans-serif", 'nunito-sans': "'Nunito Sans', system-ui, sans-serif", lora: "'Lora', Georgia, serif" };
  // Оформление текста — только allowlist редактора: шрифт из списка, размер 10–72, B/I/U, выравнивание, #rrggbb, интервал 1–2.5.
  function applyStyle(s, el) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return el;
    if (Object.prototype.hasOwnProperty.call(FONT, s.font)) el.style.fontFamily = FONT[s.font];
    if (Number.isFinite(s.size) && s.size >= 10 && s.size <= 72) el.style.fontSize = `${Math.round(s.size)}px`;
    if (typeof s.bold === 'boolean') el.style.fontWeight = s.bold ? '700' : '400';
    if (typeof s.italic === 'boolean') el.style.fontStyle = s.italic ? 'italic' : 'normal';
    if (typeof s.underline === 'boolean') el.style.textDecoration = s.underline ? 'underline' : 'none';
    if (['left', 'center', 'right', 'justify'].includes(s.align)) el.style.textAlign = s.align;
    if (typeof s.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.color)) el.style.color = s.color;
    if (Number.isFinite(s.lineHeight) && s.lineHeight >= 1 && s.lineHeight <= 2.5) el.style.lineHeight = String(s.lineHeight);
    return el;
  }
  const styleOf = (holder, field) => (holder && holder.textStyles && typeof holder.textStyles === 'object' && Object.prototype.hasOwnProperty.call(holder.textStyles, field) ? holder.textStyles[field] : null);
  /* ---------- меню из модели ---------- */
  const visibleFrame = (id, role) => { const f = typeof id === 'string' ? frameById(id) : null; return f && f.role === role && f.hidden !== true && f.device !== 'desktop' ? f : null; };
  function defaultMenuItems(role) {
    const defaults = [...(frameById(MENU_HOME[role]) ? [[MENU_HOME_LABEL[role], MENU_HOME[role]]] : []), ...(DEFAULT_MENU[role] || [])];
    const items = defaults.filter(([, id]) => { const f = visibleFrame(id, role); return f && f.menuVisible !== false; });
    for (const f of frames()) if (f.role === role && f.hidden !== true && f.menuVisible === true && !items.some(([, id]) => id === f.id)) items.push([f.title, f.id]);
    const rank = (entry) => (Number.isFinite(frameById(entry[1]).menuOrder) ? frameById(entry[1]).menuOrder : items.findIndex(([, id]) => id === entry[1]));
    return items.map(([label, id]) => [typeof frameById(id).menuLabel === 'string' ? frameById(id).menuLabel : label, id]).sort((a, b) => rank(a) - rank(b));
  }
  function effectiveMenu(role) {
    const menus = DESIGN && DESIGN.menus && typeof DESIGN.menus === 'object' ? DESIGN.menus : null;
    const stored = menus && Object.prototype.hasOwnProperty.call(menus, role) ? menus[role] : null;
    if (stored && typeof stored === 'object' && !Array.isArray(stored) && Array.isArray(stored.items)) return { explicit: true, menu: stored };
    return { explicit: false, menu: { id: `menu:${role}`, type: 'menu', title: MENU_TITLE[role], items: defaultMenuItems(role).map(([label, target]) => ({ id: `menu:${role}:${target}`, label, target, hidden: false })) } };
  }
  // Видимые пункты: стабильный строковый id без повторов, не скрыт, цель — нескрытая страница той же роли.
  function visibleMenuItems(role) {
    if (role === 'client' && activeCompany === 'palitra-love') {
      const orders = ordersFrames('client').active;
      return [['Главная', MENU_HOME.client], ['Чат по текущему заказу', CLIENT_ORDER_CHAT_FRAME], ['Каталог', 'K02'], ['Оставить отзыв', 'K08'], ['Ваши заказы', orders && orders.id]]
        .filter(([, target]) => visibleFrame(target, role)).map(([label, target]) => ({ id: `client-order-menu:${target}`, label, target }));
    }
    const seen = new Set();
    const visible = effectiveMenu(role).menu.items.filter((item) => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || seen.has(item.id) || item.hidden === true) return false;
      if (!visibleFrame(item.target, role)) return false;
      seen.add(item.id);
      return true;
    });
    if (activeCompany !== 'palitra-love' && salonAllowed()) {
      const report = mobileFrame(role, 'reports');
      if (report && !visible.some(item => item.target === report.id)) visible.push({ id: `studio-reports:${role}`, label: 'Отчёты', target: report.id });
    }
    if (responseReportAllowed()) {
      const report = mobileFrame(role, 'reports');
      if (report && !visible.some(item => item.target === report.id)) visible.push({ id: `response-reports:${role}`, label: 'Отчёты', target: report.id });
    }
    if (contentTasksAllowed()) {
      const content = mobileFrame(role, 'content-tasks');
      if (content && visibleFrame(content.id, role) && !visible.some(item => item.target === content.id)) visible.push({ id: `content-tasks:${role}`, label: 'Контент', target: content.id });
    }
    if (activeCompany === 'palitra-love' && ['staff','admin'].includes(role)) {
      const prefix=role==='admin'?'A':'S';
      const entries=[['Заказы',MENU_HOME[role]],['Сайт',SITE_TOOLS_FRAMES[role]],['Прайс',prefix+'07']];
      const report=mobileFrame(role,'reports'), content=mobileFrame(role,'content-tasks');
      if(report)entries.push(['Отчёты',report.id]);if(content)entries.push(['Контент',content.id]);
      if(teamChatAllowed())entries.push(['Рабочий чат',TEAM_CHAT_FRAMES[role]]);
      entries.push(['Настройки',SETTINGS_FRAMES[role]]);
      return entries.filter(([,target])=>visibleFrame(target,role)).map(([label,target])=>({id:'palitra-main:'+role+':'+target,label,target}));
    }
    return visible;
  }
  function homeFrame(role) {
    if (visibleFrame(MENU_HOME[role], role)) return MENU_HOME[role];
    const first = visibleMenuItems(role)[0];
    if (first) return first.target;
    const any = frames().find((f) => f.role === role && f.hidden !== true && f.device !== 'desktop');
    return any ? any.id : null;
  }
  function applyTextStyles(block, root) {
    const styles = block.textStyles && typeof block.textStyles === 'object' ? block.textStyles : null;
    if (!styles) return;
    for (const el of root.querySelectorAll('[data-text-field]')) applyStyle(styleOf(block, el.dataset.textField), el);
  }

  /* ---------- host, auth, мост ---------- */
  const preview = Boolean(HOST && HOST.mode === 'preview' && HOST.service);
  const auth = { preview: '', cabinetSession: false, portalSession: false, cabinet: null, portal: null, account: null, chat: null, guest: false, e1Native: false };
  const tickets = B.createTickets();
  let bridge = null;
  if (preview) bridge = B.createBridge({ transport: B.createMockTransport(HOST.service), getAuth: () => auth });
  else if (HOST && HOST.mode === 'native' && HOST.transport && HOST.transport.kind === 'native' && HOST.verified === true) {
    // Только проверенный host Root (разрешённый origin, identity/CSRF/session) может передать native-транспорт.
    bridge = B.createBridge({ transport: HOST.transport, getAuth: () => auth });
  }
  const caps = () => B.capabilities(auth);
  function uiRole() {
    if ((auth.portal && auth.portal.role === 'owner') || (auth.cabinet && auth.cabinet.member && auth.cabinet.role === 'owner')) return 'admin';
    if ((auth.portal && auth.portal.role === 'admin') || (auth.cabinet && auth.cabinet.member)) return 'staff';
    if (auth.portal || auth.account || auth.guest) return 'client';
    return '';
  }
  const workflow = window.PalitraWorkflowUI ? window.PalitraWorkflowUI.create({ document, window, request: HOST && HOST.workflow ? HOST.workflow.request : null, memoUpload: HOST?.workflow?.memoUpload || null, onUnauthorized: (error) => endSession('cabinet', error.message), onChanged: orderId => managerOrderChanged(orderId), onState: () => sessionUpdateObserver?.refreshSafety() }) : null;
  function workflowSettingsAllowed() { return document.documentElement.dataset.entry === 'cabinet' && activeCompany === 'palitra-love' && state.role !== 'client' && Boolean(auth.cabinet?.member && workflow?.canWrite()); }
  function workflowIdentity() { if (workflow) workflow.setIdentity({ key: actorKey(), role: activeCompany === 'palitra-love' && auth.cabinet ? auth.cabinet.role : 'client', member: activeCompany === 'palitra-love' && Boolean(auth.cabinet && auth.cabinet.member), permissions: activeCompany === 'palitra-love' && auth.cabinet ? auth.cabinet.permissions : [] }); }
  const actorKey = () => `${activeCompany}|` + (auth.cabinet ? `cabinet:${auth.cabinet.userId}` : '') + (auth.portal ? `|portal:${auth.portal.id}` : '') + (auth.account ? `|account:${auth.account.opaque}` : '');
  // Files share this exact native identity and epoch; no independent session or transport.
  let attachmentUI = !preview && bridge && HOST.attachments && B.createAttachmentClient && window.PalitraAttachmentsUI
    ? window.PalitraAttachmentsUI.create({ document, window, client: B.createAttachmentClient({ transport: HOST.attachments, getAuth: () => auth }),
      onUnauthorized: (error) => endSession(auth.cabinet ? 'cabinet' : 'account', error.message) }) : null;
  let attachmentComposer = null;
  let nativeDetailChatReturn = null;
  const chatAdviceDisclosure = new Map();

  /* ---------- состояние ---------- */
  const state = { role: '', frameId: null, params: {}, menuOpen: false, works: false, error: '', notice: '', authError: '', authLoading: Boolean(bridge),
    bootstrap: null, native: null, detail: null, links: null, chat: null, legacyOrder: null, chatBlocked: null, summary: null, crmReport: null, reportRange: null, reportDraft: null, reportLoading: false, clientThread: null, clientThreads: null, clientThreadsBefore: null, clientThreadLinked: false };
  // A read-only full-scope DTO supplies counts and ordering; no inference from a partial chat page.
  let managerAttention = { filter: 'in_work', data: null, items: [], loading: false, error: '', request: null };
  // PALITRA_ORDER_READ_CONTROLLER_BEGIN
  const orderReadPositive = value => Number.isSafeInteger(value) && value > 0;
  function checkedOrderUnread(value) {
    const plain = row => row && typeof row === 'object' && !Array.isArray(row);
    const count = n => Number.isSafeInteger(n) && n >= 0;
    if (!plain(value) || value.schema !== 'palitra-order-unread/v1' || value.companyCode !== 'palitra-love' ||
        typeof value.asOf !== 'string' || !Number.isFinite(Date.parse(value.asOf)) || !count(value.unreadMessages) || !Array.isArray(value.items)) throw new Error('Счётчик сообщений не подтверждён.');
    const seen = new Set(); let sum = 0;
    for (const item of value.items) {
      if (!plain(item) || typeof item.ref !== 'string' || !/^(order|thread|legacy):[1-9]\d*$/.test(item.ref) || !orderReadPositive(Number(item.ref.split(':')[1])) || seen.has(item.ref) || !orderReadPositive(item.unreadMessages)) throw new Error('Счётчик сообщений не подтверждён.');
      seen.add(item.ref); sum += item.unreadMessages;
      if (!Number.isSafeInteger(sum)) throw new Error('Счётчик сообщений не подтверждён.');
    }
    if (sum !== value.unreadMessages) throw new Error('Счётчик сообщений не подтверждён.');
    return value;
  }
  function createOrderReadController({ host, allowed, binding, changed = () => {} }) {
    let identity = '', data = null, status = 'unavailable', request = null, serial = 0;
    const acknowledged = new Map(), pending = new Map();
    const clear = () => { request?.controller.abort(); request = null; serial++; data = null; status = 'unavailable'; acknowledged.clear(); pending.clear(); };
    function current() {
      const next = allowed() ? binding() : '';
      if (identity !== next) { clear(); identity = next; }
      return Boolean(next);
    }
    function notify() { changed(); }
    async function read() {
      if (!current()) { notify(); return null; }
      const api = host();
      if (!api || typeof api.read !== 'function') { data = null; status = 'unavailable'; notify(); return null; }
      request?.controller.abort();
      const saved = identity, token = ++serial, controller = new AbortController(); request = { token, controller };
      if (!data) status = 'loading';
      try {
        const value = checkedOrderUnread(await api.read({ signal: controller.signal }));
        if (!current() || identity !== saved || request?.token !== token || controller.signal.aborted) return null;
        data = value; status = 'ready'; request = null; notify(); return value;
      } catch (_) {
        if (!current() || identity !== saved || request?.token !== token || controller.signal.aborted) return null;
        data = null; status = 'unavailable'; request = null; notify(); return null;
      }
    }
    function count(ref = null) {
      if (!current() || status !== 'ready' || !data) return null;
      return ref === null ? data.unreadMessages : data.items.find(item => item.ref === ref)?.unreadMessages || 0;
    }
    async function ack(body) {
      if (!current() || !body || !['thread','legacy'].includes(body.kind) || !orderReadPositive(body.id) || !orderReadPositive(body.throughMessageId)) return null;
      const api = host(); if (!api || typeof api.ack !== 'function') return null;
      const key = body.kind + ':' + body.id, saved = identity;
      if ((acknowledged.get(key) || 0) >= body.throughMessageId || (pending.get(key) || 0) >= body.throughMessageId) return null;
      pending.set(key, body.throughMessageId);
      try {
        const value = await api.ack({ kind: body.kind, id: body.id, throughMessageId: body.throughMessageId });
        if (!current() || identity !== saved) return null;
        if (!value || value.ok !== true || value.schema !== 'palitra-order-unread/v1' || value.companyCode !== 'palitra-love' || value.kind !== body.kind || value.id !== body.id || !orderReadPositive(value.throughMessageId) || value.throughMessageId < body.throughMessageId || !Number.isSafeInteger(value.unreadMessages) || value.unreadMessages < 0) throw new Error('Прочтение не подтверждено.');
        acknowledged.set(key, Math.max(acknowledged.get(key) || 0, value.throughMessageId));
        // A fresh server summary owns the counter. No optimistic decrement or zero.
        await read(); return value;
      } catch (_) { return null; }
      finally { if (identity === saved && pending.get(key) === body.throughMessageId) pending.delete(key); }
    }
    return Object.freeze({ read, ack, count, reset() { clear(); identity = ''; notify(); }, status() { current(); return status; } });
  }
  function orderReadMessageIdentity(message, target, conversation) {
    const author = message && (message.author || message.authorType);
    if (!message || message.direction !== 'in' || !['customer','client'].includes(author) || !orderReadPositive(message.id)) return null;
    const kind = conversation ? 'thread' : target && target.ns, id = conversation ? message.threadId : target && target.id;
    return ['thread','legacy'].includes(kind) && orderReadPositive(id) ? { kind, id, throughMessageId: message.id } : null;
  }
  function latestVisibleOrderReads(rows, clip) {
    const values = new Map();
    for (const { identity, rect } of rows) {
      // Read the end of the bubble before acknowledging it, including long messages.
      if (!identity || !rect || rect.width <= 0 || rect.height <= 0 || rect.bottom <= clip.top || rect.bottom > clip.bottom + 1 || rect.top >= clip.bottom || rect.right <= clip.left || rect.left >= clip.right) continue;
      const key = identity.kind + ':' + identity.id, previous = values.get(key);
      if (!previous || previous.throughMessageId < identity.throughMessageId) values.set(key, identity);
    }
    return [...values.values()];
  }
  function managerEntrySource(item) {
    // These are record/channel kinds, never inferred advertising attribution.
    const source=item?.source,entryLabels={site_order:'Заявка',site_chat:'Чат сайта',telegram:'Telegram',unknown:'Источник не указан'};
    const entry = source && entryLabels[source.entryKind] || (item?.kind === 'order' ? 'Заявка' : item?.kind === 'web-thread' ? 'Чат сайта' : item?.kind === 'legacy-dialog' ? 'Telegram' : 'Источник не указан');
    const labels={vk:'ВКонтакте',telegram:'Telegram',instagram:'Instagram',youtube:'YouTube',tiktok:'TikTok',other:'другая ссылка'};
    // The recorded URL label is a fact about the link, not proof of the external referrer.
    return source && ['recorded','legacy_order'].includes(source.basis) && labels[source.trafficSource] ? entry+' · метка '+labels[source.trafficSource] : entry;
  }
  // PALITRA_ORDER_READ_CONTROLLER_END

  const orderReads = createOrderReadController({host:()=>HOST?.orderRead,allowed:()=>managerAllowed(),binding:()=>managerBinding(),changed:()=>updateOrderUnreadBadges()});
  let orderReadIntent = null, orderReadPaint = 0;
  function orderUnreadBadge(ref = null) {
    const n = orderReads.count(ref);
    return h('span',{class:'notification-count',hidden:n===null || n===0,dataset:{orderUnreadKey:ref || 'global'},'aria-label':n===null?'Непрочитанные сообщения пока недоступны':`Непрочитанных сообщений: ${n}`,text:n===null?'':String(n)});
  }
  function updateOrderUnreadBadges() {
    for (const node of document.querySelectorAll('[data-order-unread-key]')) {
      const n=orderReads.count(node.dataset.orderUnreadKey==='global'?null:node.dataset.orderUnreadKey);
      node.hidden=n===null || n===0; node.textContent=n===null?'':String(n);
      node.setAttribute('aria-label',n===null?'Непрочитанные сообщения пока недоступны':`Непрочитанных сообщений: ${n}`);
    }
    updateManagerCaseUnreadBadges();
  }
  function staffReadContext() { return managerAllowed() && screenType(frameById(state.frameId))==='chat' && state.chat && !state.error && !blockedConversation() ? managerBinding()+'|'+state.frameId+'|'+str(state.params.chat) : ''; }
  function requestShownOrderRead() { const key=staffReadContext(); if(key) { orderReadIntent=key; scheduleShownOrderRead(); } }
  function scheduleShownOrderRead() {
    if(!orderReadIntent || orderReadPaint) return;
    if(state.error) { orderReadIntent=null; return; }
    if(!staffReadContext()) return; // Await the manually opened conversation, never create intent from polling.
    orderReadPaint=requestAnimationFrame(()=>requestAnimationFrame(()=>{
      orderReadPaint=0;const intent=orderReadIntent;orderReadIntent=null;
      if(!intent || intent!==staffReadContext() || document.hidden || !document.hasFocus() || state.menuOpen || state.installOpen || state.works || contentTasksOverlay) return;
      const list=ui.body.querySelector('.chat__list'); if(!list || !list.isConnected) return;
      const r=list.getBoundingClientRect(), v=window.visualViewport;
      const dock=ui.body.querySelector('.chat__dock')?.getBoundingClientRect();
      const clip={top:Math.max(r.top,v?.offsetTop || 0),bottom:Math.min(r.bottom,dock?.top ?? Infinity,(v?.offsetTop || 0)+(v?.height || window.innerHeight)),left:Math.max(r.left,v?.offsetLeft || 0),right:Math.min(r.right,(v?.offsetLeft || 0)+(v?.width || window.innerWidth))};
      const rows=[...list.querySelectorAll('[data-read-message]')].map(node=>{
        const rect=node.getBoundingClientRect(),x=Math.min(clip.right-1,Math.max(clip.left+1,(rect.left+rect.right)/2)),y=rect.bottom-1;
        const hit=y>=clip.top && y<clip.bottom ? document.elementFromPoint(x,y) : null;
        return {identity:hit && node.contains(hit)?{kind:node.dataset.readKind,id:Number(node.dataset.readTarget),throughMessageId:Number(node.dataset.readMessage)}:null,rect};
      });
      for(const identity of latestVisibleOrderReads(rows,clip)) void orderReads.ack(identity);
    }));
  }
  for(const name of ['pointerdown','keydown','wheel','touchmove']) document.addEventListener(name,event=>{if(event.isTrusted && ui.body.contains(event.target)) requestShownOrderRead();},{passive:true});
  window.addEventListener('focus',event=>{if(event.isTrusted)requestShownOrderRead();});
  const managerSnapshots = new Map();
  let managerLegacyLink = null; // Only a validated queue row can establish this in-memory relation.
  const managerChannelDisclosure = new Map();
  function managerAllowed() {
    return document.documentElement.dataset.entry === 'cabinet' && activeCompany === 'palitra-love' && state.role !== 'client' && Boolean(state.role && auth.cabinet && auth.cabinet.member && caps()['native.orders']);
  }
  function managerHome(frame = frameById(state.frameId)) { return managerAllowed() && frame && frame.id === MENU_HOME[state.role]; }
  function resetManagerAttention() {
    if (managerAttention.request) managerAttention.request.controller.abort();
    managerAttention = { filter: 'in_work', data: null, items: [], loading: false, error: '', request: null };
    managerSnapshots.clear();
    managerLegacyLink = null;
    managerChannelDisclosure.clear();
    orderReadIntent=null; orderReads.reset();
  }
  function abortManagerRead() {
    if (managerAttention.request) managerAttention.request.controller.abort();
    managerAttention.request = null; managerAttention.loading = false;
  }
  function managerBinding() { return `${tickets.epoch}|${actorKey()}|${auth.cabinet && auth.cabinet.role}|${JSON.stringify(auth.cabinet && auth.cabinet.permissions)}`; }
  async function readManagerAttention({ more = false, filter = managerAttention.filter } = {}) {
    if (!managerAllowed() || document.hidden) return;
    void orderReads.read();
    if (!['all','in_work','refused','completed','attention'].includes(filter) || more && filter !== managerAttention.filter) return;
    if (more && (managerAttention.loading || !managerAttention.data?.nextCursor)) return;
    if (managerAttention.request) managerAttention.request.controller.abort();
    const previous = managerAttention, binding = managerBinding(), controller = new AbortController();
    const request = { controller, binding }, cursor = more ? previous.data.nextCursor : undefined;
    const cached = managerSnapshots.get(filter), retained = more || previous.filter === filter && previous.data ? previous : cached?.binding === binding ? cached : null;
    managerAttention = { filter, data: retained?.data || null, items: retained?.items || [], loading: true, error: '', request };
    if (managerHome()) render();
    scheduleChatRefresh();
    const live = () => managerAllowed() && managerBinding() === binding && managerAttention.request === request && !controller.signal.aborted;
    try {
      if (!HOST.managerAttention || typeof HOST.managerAttention.read !== 'function') throw new Error('Список клиентов сейчас недоступен. Попробуйте обновить его.');
      const data = await HOST.managerAttention.read({ view: 'display-v3', limit: 30, ...(cursor ? { cursor } : {}), filter, signal: controller.signal });
      if (!live()) return;
      // The host validates every row/ref. Check the envelope again before replacing this company/role's view.
      if (!data || !['palitra-manager-attention/v1','palitra-manager-attention/display-v3'].includes(data.schema) || data.companyCode !== activeCompany || data.scopeKey !== 'palitra' || data.filter !== filter || data.partial !== false || !Array.isArray(data.items) || !data.counts || !['total', 'attention', 'unanswered', 'firstContact', 'inWork', 'refused', 'completed'].every(k => Number.isSafeInteger(data.counts[k]) && data.counts[k] >= 0) || data.counts.total !== data.counts.inWork + data.counts.refused + data.counts.completed || !data.items.every(item => ['in_work','refused','completed'].includes(item.group) && (!['in_work','refused','completed'].includes(filter) || item.group === filter)) || !Number.isFinite(Date.parse(data.asOf))) throw new Error('Не удалось проверить список клиентов. Обновите его.');
      if (more && (data.schema !== previous.data.schema || data.sourceRevision !== previous.data.sourceRevision || data.asOf !== previous.data.asOf || ['total','attention','unanswered','firstContact','inWork','refused','completed'].some(key => data.counts[key] !== previous.data.counts[key]))) throw new Error('Состав списка изменился. Обновите его с начала.');
      // Keyset pagination is not a database snapshot: the latest returned row wins a duplicate.
      const byKey = new Map((more ? previous.items : []).map(item => [item.key,item]));
      for (const item of data.items) byKey.set(item.key,item);
      const items = [...byKey.values()], countKey = {all:'total',attention:'attention',in_work:'inWork',refused:'refused',completed:'completed'}[filter];
      const sourceKeys = new Set(), sourceRefs = new Set();
      for(const item of items)for(const member of managerDisplayMembers(item)){if(sourceKeys.has(member.key))throw new Error('Состав списка изменился. Обновите его с начала.');sourceKeys.add(member.key);for(const ref of [...member.threadRefs,...member.dialogRefs]){if(sourceRefs.has(ref))throw new Error('Состав списка изменился. Обновите его с начала.');sourceRefs.add(ref);}}
      if (items.length > data.counts[countKey] || [['in_work','inWork'],['refused','refused'],['completed','completed']].some(([group,key]) => items.filter(item => item.group === group).length > data.counts[key])) throw new Error('Состав списка изменился. Обновите его с начала.');
      managerAttention = { filter, data, items, loading: false, error: '', request: null };
      managerSnapshots.set(filter, { binding, data, items });
    } catch (failure) {
      if (!live()) return;
      const accessLost = failure && (failure.status === 401 || failure.status === 403);
      if (accessLost) { managerSnapshots.clear(); managerLegacyLink = null; managerChannelDisclosure.clear(); }
      managerAttention = { filter, data: accessLost ? null : retained?.data || null, items: accessLost ? [] : retained?.items || [], loading: false, error: 'Не удалось обновить список заявок. Повторите обновление.', request: null };
      if (failure && failure.status === 401) { endSession('cabinet', failure.message); return; }
    }
    if (managerHome()) render();
  }
  function managerOrderChanged() {
    // A successful mutation invalidates all old pages. Background reads never repaint a chat/composer.
    if (!managerAllowed()) return;
    managerSnapshots.clear();
    if (document.hidden) { abortManagerRead(); managerAttention.data = null; managerAttention.items = []; }
    else void readManagerAttention();
  }
  function managerDuration(seconds) {
    if (seconds < 60) return 'меньше минуты';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} мин`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours} ч ${minutes % 60} мин` : `${Math.floor(hours / 24)} д ${hours % 24} ч`;
  }
  function managerDate(value) { return new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  function managerChannels(item) {
    return [...(Array.isArray(item.threadRefs) ? item.threadRefs : []), ...(Array.isArray(item.dialogRefs) ? item.dialogRefs : [])]
      .map(value => B.parseRef(value)).filter(ref => ref && (ref.ns === 'thread' || ref.ns === 'legacy'));
  }
  function trustedManagerLegacy(order, chat) {
    return managerAllowed() && managerLegacyLink && managerLegacyLink.binding === managerBinding() && managerLegacyLink.order === B.refKey(order) && managerLegacyLink.chat === B.refKey(chat);
  }
  // PALITRA_MANAGER_DISPLAY_MEMBERS_BEGIN: each order keeps its typed refs and actions.
  function managerDisplayMembers(item) {
    return item?.display?.schema==='palitra-attention-display/v3'?item.display.members:[item];
  }
  function managerCaseAttention(item) {
    return item?.display?.schema==='palitra-attention-display/v3'?item.display.attention:item;
  }
  function managerCaseOrderCount(item) { return managerDisplayMembers(item).filter(source=>source.orderRef).length; }
  function managerCaseUnread(item) {
    let total=0;const seen=new Set();
    for(const source of managerDisplayMembers(item)){
      if(seen.has(source.key))return null;seen.add(source.key);
      const n=orderReads.count(source.key);if(n===null||!Number.isSafeInteger(n)||n<0)return null;
      total+=n;if(!Number.isSafeInteger(total))return null;
    }
    return total;
  }
  function managerCaseUnreadBadge(item) {
    const n=managerCaseUnread(item);
    return h('span',{class:'notification-count',hidden:n===null||n===0,dataset:{managerUnreadCase:item.key},
      'aria-label':n===null?'Непрочитанные сообщения пока недоступны':`Непрочитанных сообщений: ${n}`,text:n===null?'':String(n)});
  }
  function updateManagerCaseUnreadBadges() {
    for(const node of document.querySelectorAll('[data-manager-unread-case]')){
      const item=managerAttention.items.find(item=>item.key===node.dataset.managerUnreadCase),n=item?managerCaseUnread(item):null;
      node.hidden=n===null||n===0;node.textContent=n===null?'':String(n);
      node.setAttribute('aria-label',n===null?'Непрочитанные сообщения пока недоступны':`Непрочитанных сообщений: ${n}`);
    }
  }
  function managerLinkedSources(item) { return managerDisplayMembers(item).filter(source=>source.key!==item.key); }
  function managerLinkedSourceRows(item) {
    const sources=managerDisplayMembers(item);if(sources.length<2)return null;
    const key='case:'+item.display.groupKey,orders=managerCaseOrderCount(item);
    return h('details',{class:'manager-client__channels',open:managerChannelDisclosure.get(key)===true,dataset:{managerLinkedSources:''},
      ontoggle:event=>{if(event.currentTarget.isConnected)managerChannelDisclosure.set(key,event.currentTarget.open);}},
      h('summary',{text:orders?`Заказы · ${orders} и переписка`:`Переписки · ${sources.length}`}),
      ...sources.map(source=>{
        const stage=source.stage||source.nativeStage,channels=managerChannels(source);
        const label=source.orderRef?`Заявка №${B.parseRef(source.orderRef,'native-order')?.id||''}`:'Переписка без заявки';
        return h('div',{class:'manager-client__linked-source',dataset:{managerSourceRow:source.key}},
          h('button',{type:'button',class:'app-btn app-btn--ghost',dataset:{managerSource:source.key},onclick:()=>openManagerClient(item,null,source.key)},label,orderUnreadBadge(source.key)),
          stage?h('span',{class:'manager-client__stage',text:`Этап: «${stage.label}»`}):h('span',{class:'manager-client__stage',text:'Этап ещё не начат'}),
          source.completionPending===true?h('span',{class:'manager-client__pending-completion',text:'Проверьте оплату и выдачу'}):null,
          h('span',{class:'manager-client__date',text:`С ${managerDate(source.basisAt)}`}),
          channels.length>1?h('div',{class:'manager-client__channels'},...channels.map(ref=>h('button',{
            type:'button',class:'app-btn app-btn--ghost',dataset:{managerMemberChannel:source.key,managerSourceChannel:B.refKey(ref)},
            onclick:()=>openManagerClient(item,B.refKey(ref),source.key),text:`${ref.ns==='thread'?'Чат сайта':'Переписка в боте'} №${ref.id}`}))):null);
      }));
  }
  // PALITRA_MANAGER_DISPLAY_MEMBERS_END

  function openManagerClient(item, selectedRef = null, sourceKey = null) {
    if (!managerAllowed() || !managerAttention.items.includes(item)) return;
    const members=managerDisplayMembers(item),attention=managerCaseAttention(item);
    const requested=sourceKey===null&&selectedRef===null&&attention.reason==='unanswered'?attention.attentionRef:null;
    const source=sourceKey===null?(requested?members.find(member=>[...member.threadRefs,...member.dialogRefs].includes(requested)):item):members.find(member=>member.key===sourceKey);
    if(!source){toast('Не удалось проверить источник переписки. Обновите список.');return;}
    const order=source.orderRef&&B.parseRef(source.orderRef,'native-order'),channels=managerChannels(source);
    const selected=selectedRef||requested||(sourceKey===null?source.threadRef||source.dialogRef:source.reason==='unanswered'?source.attentionRef:source.threadRef||source.dialogRef);
    const chat=selected&&channels.find(ref=>B.refKey(ref)===selected);
    if(selected&&!chat||source.reason==='unanswered'&&!selected){toast('Не удалось проверить нужную переписку. Обновите список клиентов.');return;}
    const target=chat?mobileFrame(state.role,'chat'):order?mobileFrame(state.role,'detail'):null;
    if(!target||target.hidden===true||!screenAllowed(target)){toast('Этот диалог недоступен для вашей роли.');return;}
    managerLegacyLink=chat?.ns==='legacy'&&order?{binding:managerBinding(),order:B.refKey(order),chat:B.refKey(chat)}:null;
    open(target.id,{...(chat?{chat:B.refKey(chat)}:{}),...(order?{order:B.refKey(order)}:{})});
  }
  function managerRefreshIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key,value] of Object.entries({ viewBox:'0 0 24 24', width:'22', height:'22', fill:'none', stroke:'currentColor', 'stroke-width':'2', 'stroke-linecap':'round', 'stroke-linejoin':'round', 'aria-hidden':'true', focusable:'false' })) svg.setAttribute(key,value);
    for (const d of ['M3 11a9 9 0 0 1 15-6.7L21 7','M21 3v4h-4','M21 13a9 9 0 0 1-15 6.7L3 17','M3 21v-4h4']) { const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d',d); svg.appendChild(path); }
    return svg;
  }
  function managerWorkspace() {
    const m = managerAttention, data = m.data, counts = data && data.counts;
    const groups = [['all', 'Все обращения', 'total'], ['in_work', 'В работе', 'inWork'], ['refused', 'Отказ', 'refused'], ['completed', 'Завершённые', 'completed']];
    const filters = h('div', { id: 'manager-request-filters', class: 'manager-workspace__filters', role: 'group', 'aria-label': 'Группы обращений', dataset: { managerRequestFilters: '' } },
      ...groups.map(([filter, label, count]) => h('button', { type: 'button', class: `app-btn${m.filter === filter ? '' : ' app-btn--ghost'}`, 'aria-pressed': String(m.filter === filter), dataset: { managerFilter: filter }, onclick: () => { if (managerAttention.filter !== filter) void readManagerAttention({ filter }); } }, label, counts ? ` · ${counts[count]}` : '')));
    const rows = m.items.map(item => {
      const attention=managerCaseAttention(item),reason=attention.reason==='unanswered'?'Ждёт ответа':attention.reason==='first-contact'?'Связаться':null;
      const cardStage = item.stage || item.nativeStage;
      const stageAge = cardStage && cardStage.since && data ? Math.max(0, Math.floor((Date.parse(data.asOf) - Date.parse(cardStage.since)) / 1000)) : null;
      const channels = managerChannels(item);
      const label = item.customerLabel?.trim() || (item.orderRef ? `Клиент №${B.parseRef(item.orderRef, 'native-order')?.id}` : item.threadRef ? `Клиент чата №${B.parseRef(item.threadRef, 'thread')?.id}` : item.dialogRef ? `Диалог №${B.parseRef(item.dialogRef, 'legacy')?.id}` : 'Клиент');
      return h('article', { class: 'manager-client', dataset: { managerDisplayGroup: item.display?.groupKey || item.key } }, h('button', { type: 'button', class: 'manager-client__open', dataset: { managerClient: item.key }, onclick: () => openManagerClient(item) },
        h('span', { class: 'manager-client__heading' }, h('strong', { text: label }), h('span',{class:'manager-client__source',text:managerEntrySource(item)}), managerCaseUnreadBadge(item), managerDisplayMembers(item).length>1?h('span',{class:'muted',text:managerCaseOrderCount(item)?`Заказов: ${managerCaseOrderCount(item)}`:`Переписок: ${managerDisplayMembers(item).length}`}):item.orderRef?h('span',{class:'muted',text:`№${B.parseRef(item.orderRef,'native-order')?.id||''}`}):null),
        reason ? h('span', { class: 'manager-client__attention', text: `${reason} · ${managerDuration(attention.ageSeconds)}` }) : h('span', { class: 'manager-client__quiet', text: managerLinkedSources(item).length ? 'В общей переписке нет ожидающего ответа' : 'В переписке нет ожидающего ответа' }),
        h('span', { class: 'manager-client__date', text: `С ${managerDate(attention.basisAt)}` }),
        managerDisplayMembers(item).length>1?h('span',{class:'manager-client__stage',text:'Этапы и действия — внутри каждого заказа'}):cardStage ? h('span', { class: 'manager-client__stage', text: `На этапе «${item.group === 'refused' ? 'Отказ' : cardStage.label}»${stageAge === null ? '' : ` · ${managerDuration(stageAge)}`}${cardStage.since ? ` · с ${managerDate(cardStage.since)}` : ''}` }) : h('span', { class: 'manager-client__stage', text: 'Этап ещё не начат' }),
        managerDisplayMembers(item).some(source=>source.completionPending===true) ? h('span', { class: 'manager-client__pending-completion', text: 'Проверьте оплату и выдачу' }) : null),
        managerDisplayMembers(item).length===1&&channels.length > 1 ? h('details', { class: 'manager-client__channels', open: managerChannelDisclosure.get(item.key) === true,
          ontoggle: event => { if (event.currentTarget.isConnected) managerChannelDisclosure.set(item.key, event.currentTarget.open); } }, h('summary', { text: `Переписки · ${channels.length}` }),
          ...channels.map(ref => h('button', { type: 'button', class: 'app-btn app-btn--ghost', dataset: { managerChannel: B.refKey(ref) }, onclick: () => openManagerClient(item, B.refKey(ref)), text: `${ref.ns === 'thread' ? 'Чат сайта' : 'Переписка в боте'} №${ref.id}` }))) : null, managerLinkedSourceRows(item));
    });
    return h('section', { class: 'manager-workspace', 'aria-label': 'Заказы' },
      h('div', { class: 'manager-workspace__heading' }, h('h1', {}, 'Заказы', orderUnreadBadge()), h('button', { type: 'button', class: 'app-btn app-btn--ghost manager-workspace__refresh', disabled: m.loading, 'aria-label': 'Обновить заказы', title: 'Обновить заказы', dataset: { managerRefresh: '' }, onclick: () => { void readManagerAttention(); } }, managerRefreshIcon())),
      counts ? h('div', { class: 'manager-workspace__counts', 'aria-label': 'Требуют внимания во всём списке' }, h('span', { text: `Без ответа · ${counts.unanswered}` }), h('span', { text: `Связаться · ${counts.firstContact}` })) : null,
      filters, data ? h('p', { class: 'manager-workspace__asof', text: `По состоянию на ${managerDate(data.asOf)}` }) : null,
      m.error ? h('p', { class: 'app-error', role: 'alert', text: m.error }) : null,
      m.loading && !rows.length ? h('p', { role: 'status', text: 'Загружаем заказы…' }) : null,
      h('div', { class: 'manager-workspace__list' }, rows),
      data && !rows.length ? h('p', { class: 'app-empty', text: ({ all:'Заявок пока нет.', in_work:'Заявок в работе пока нет.', refused:'Отказов пока нет.', completed:'Завершённых заявок пока нет.', attention:'Сейчас нет клиентов, ожидающих ответа или связи.' })[m.filter] }) : null,
      data?.nextCursor ? h('button', { type: 'button', class: 'app-btn app-btn--ghost', disabled: m.loading, dataset: { managerMore: '' }, onclick: () => { void readManagerAttention({ more: true }); }, text: m.loading ? 'Загружаем…' : 'Ещё заявки' }) : null);

  }
  // Черновики — только память страницы, ключ: актор + typed сущность. Смена/отзыв identity их очищает.
  const drafts = new Map();
  const fieldDrafts = new Map();
  const draftKey = (kind, ref) => `${actorKey()}#${kind}#${ref ? B.refKey(ref) : 'none'}`;
  const pendingSends = new Map();   // актор+сущность → { requestId, body, unknown }
  // F2: отправки «в полёте» по ключу актор+typed сущность: повторный клик/Enter/submit во время await не создаёт вторую.
  const inflight = new Set();
  /* PALITRA_UI_BUILD:synapse-company-app-20261031-case-products-r1 */
  const SESSION_UI_BUILD = 'synapse-company-app-20261031-case-products-r1';
  let sessionUpdateObserver = null, sessionUpdateOffer = null, sessionOpaqueDirty = false, sessionConfirmedForm = null;
  const sessionFileSafety = new Map(); // booleans only; never store/serialize a file, caption or request body here.
  const sessionFormDefaults = new Map(); // actor/company -> rendered channel enum, never entered form values.
  function sessionUpdateSafety() {
    const reportDirty = state.reportDraft && state.reportRange &&
      (state.reportDraft.from !== state.reportRange.from || state.reportDraft.to !== state.reportRange.to);
    return window.PalitraSessionUpdate.collectBlockers({
      verified: !state.authLoading && Boolean(state.role), drafts, fieldDrafts, pending: pendingSends, inflight, form, formSnapshot: sessionConfirmedForm,
      formDefaultChannel: sessionFormDefaults.get(actorKey()) || 'telegram',
      hasFile: [...sessionFileSafety.values()].some(Boolean), typing: typingNow(),
      protectedSurface: sessionOpaqueDirty || Boolean(workflow?.hasPendingOrderAction?.()) || frameSlots.size > 0 || Boolean(reportDirty) || Boolean(document.querySelector('[aria-modal="true"]'))
    });
  }
  function sessionInputChanged(event) {
    const target = event.target;
    // These existing editors keep private drafts/pending operations without a public dirty API.
    // Stay conservative even after leaving them. Identity revocation already clears their state.
    if (target && target.closest && !target.closest('[data-workflow-manual], [data-workflow-manual-action]') && target.closest('[data-widget-settings], [data-workflow], [data-workflow-order], [data-questionnaire], [data-enable-push], [data-disable-push], [data-install]')) sessionOpaqueDirty = true;
    queueMicrotask(() => sessionUpdateObserver?.refreshSafety());
  }
  // Подтверждённые backend счётчики (0, если не подключено или ответа не было). В модель макета не пишутся.
  const counts = { orders: 0 };
  // Начальное состояние формы K01. Смена/отзыв identity возвращает к нему ВСЁ (ввод, попытку, квитанцию прежнего клиента);
  // ошибка проверки или сети в той же identity ввод не трогает.
  const initialForm = () => ({ name: '', channel: 'telegram', contact: '', consent: false, expanded: false, status: '', message: '', busy: false, attempt: null, receipt: null });
  const form = initialForm();
  const utm = (() => { try { return B.sanitizeUtm(Object.fromEntries(new URLSearchParams(location.search))); } catch (_) { return {}; } })();
  if (location.search) { try { history.replaceState(null, '', location.pathname + location.hash); } catch (_) { /* не обязательно */ } }

  /* ---------- навигация: экран + typed параметры, «Назад» без обрезки истории ---------- */
  const nav = [];
  let initialWorkflowRoute = location.hash === '#A10' ? 'A10' : location.hash === `#${WIDGET_SETTINGS_FRAME}` ? WIDGET_SETTINGS_FRAME : Object.values(TEAM_CHAT_FRAMES).includes(location.hash.slice(1)) ? location.hash.slice(1) : null;
  // A customer chat entry is only a typed pointer, never an identity or grant.
  // The existing conversation reader proves the seed and returns its shared scope.
  function notificationChatEntry(hash) {
    const route = /^#chat\?(.+)$/.exec(hash || '');
    if (!route) return null;
    try {
      const params = new URLSearchParams(route[1]), keys = [...params.keys()];
      if (!params.has('thread') || new Set(keys).size !== keys.length || keys.some(key => key !== 'thread' && key !== 'order') || !/^[1-9]\d{0,14}$/.test(params.get('thread'))) return null;
      const chat = B.makeRef('thread', B.parsePositiveId(params.get('thread')));
      const order = params.has('order') ? B.parseRef(params.get('order'), 'native-order') : null;
      return chat && (!params.has('order') || order) ? { chat, ...(order ? { order } : {}) } : null;
    } catch (_) { return null; }
  }
  function customerChatEntry(hash) {
    const alias = notificationChatEntry(hash);
    if (alias) return { chat: alias.chat, ...(alias.order ? { site: alias.order } : {}) };
    // open() writes the actual client chat frame id; preserve that same screen on reload.
    const frame = mobileFrame('client', 'chat');
    const route = /^#([^?]+)\?(.+)$/.exec(hash || '');
    if (!frame || !route || route[1] !== frame.id) return null;
    try {
      const params = new URLSearchParams(route[2]), keys = [...params.keys()];
      if (!params.has('chat') || new Set(keys).size !== keys.length || keys.some((key) => key !== 'chat' && key !== 'site')) return null;
      const chat = B.parseRef(params.get('chat'), 'thread');
      const site = params.has('site') ? B.parseRef(params.get('site'), 'native-order') : null;
      return chat && (!params.has('site') || site) ? { chat, ...(site ? { site } : {}) } : null;
    } catch (_) { return null; }
  }
  // Save the pointer before asynchronous identity/design loading can replace the URL.
  // It never carries identity, company membership or permission to read a conversation.
  function staffChatTarget(hash) {
    const route = /^#([^?]+)(?:\?|$)/.exec(hash || ''), frame = route && frameById(route[1]);
    return Boolean(route && (route[1] === 'chat' || frame && ['admin', 'staff'].includes(frame.role) && screenType(frame) === 'chat'));
  }
  function staffChatEntry(hash, role = state.role) {
    const alias = notificationChatEntry(hash), aliasFrame = alias && ['admin', 'staff'].includes(role) ? mobileFrame(role, 'chat') : null;
    if (aliasFrame && screenType(aliasFrame) === 'chat') return { frameId: aliasFrame.id, chat: alias.chat, ...(alias.order ? { order: alias.order } : {}) };
    const route = /^#([^?]+)\?(.+)$/.exec(hash || '');
    if (!route) return null;
    const frame = frameById(route[1]);
    if (!frame || !['admin', 'staff'].includes(frame.role) || screenType(frame) !== 'chat') return null;
    try {
      const params = new URLSearchParams(route[2]), keys = [...params.keys()];
      if (!params.has('chat') || new Set(keys).size !== keys.length || keys.some(key => key !== 'chat' && key !== 'order')) return null;
      const chat = B.parseRef(params.get('chat'));
      const order = params.has('order') ? B.parseRef(params.get('order'), 'native-order') : null;
      return chat && ['thread', 'legacy'].includes(chat.ns) && (!params.has('order') || order)
        ? { frameId: frame.id, chat, ...(order ? { order } : {}) } : null;
    } catch (_) { return null; }
  }
  let initialStaffChatHash = location.hash;
  let initialResponseReportHash = location.hash;
  let initialContentTasksHash = location.hash;
  let initialCustomerChat = customerChatEntry(location.hash);
  let initialSiteChat = location.hash === `#${SITE_CHAT_FRAME}`;
  let initialClientOrders = location.hash === `#${CLIENT_ORDER_CHAT_FRAME}`;
  // A typed order pointer carries no access. Revalidate role/membership before opening;
  // retain only this pointer across the existing same-origin Synapse login roundtrip.
  const FOLLOWUP_NAV_KEY = 'palitra-pending-native-order-v1';
  function nativeOrderEntry(hash) {
    const match = /^#(?:A04|S04)\?order=(native-order(?::|%3A)[1-9]\d{0,15})(?:&details=1)?$/i.exec(hash || '');
    if (!match) return null;
    try { return B.parseRef(decodeURIComponent(match[1]), 'native-order'); } catch (_) { return null; }
  }
  let initialNativeOrder = nativeOrderEntry(location.hash);
  let initialNativeDetails = Boolean(initialNativeOrder && /&details=1$/.test(location.hash));
  if (!preview) {
    try {
      if (initialNativeOrder) sessionStorage.setItem(FOLLOWUP_NAV_KEY, B.refKey(initialNativeOrder));
      else if (!location.hash) initialNativeOrder = B.parseRef(sessionStorage.getItem(FOLLOWUP_NAV_KEY), 'native-order');
    } catch (_) { /* Navigation still works in the current authenticated page. */ }
  }
  const entryKey = (id, params) => `${id}?${new URLSearchParams(params).toString()}`;
  const contextKey = () => `${tickets.epoch}|${actorKey()}|${entryKey(state.frameId, state.params)}|${state.reportRange ? `${state.reportRange.from}/${state.reportRange.to}` : ''}`;
  const canGoBack = () => nav.some((e) => frameById(e.id) && entryKey(e.id, e.params) !== entryKey(state.frameId, state.params));
  const paramRef = (name, ns) => (state.params[name] ? B.parseRef(state.params[name], ns) : null);
  // An entry is navigation or one return from the background, never a data poll.
  let clientChatEntrySerial = 0, clientChatEntry = null, clientChatAway = false;
  const clientChatBoundary = () => JSON.stringify([actorKey(), tickets.epoch, activeCompany]);
  function clientChatEntryKind(frame = frameById(state.frameId)) {
    if (preview || !bridge || activeCompany !== 'palitra-love' || state.role !== 'client' || !caps()['customer.chat']) return '';
    const kind = screenType(frame);
    return kind === 'chat' || kind === 'site-chat' ? kind : '';
  }
  function beginClientChatEntry(frame) {
    const kind = clientChatEntryKind(frame);
    clientChatEntry = kind ? { serial: ++clientChatEntrySerial, boundary: clientChatBoundary(), kind, threadId: null } : null;
    clientChatAway = false;
    if (kind === 'chat') {
      // refresh sets checking synchronously; offers cannot flash a stale subscription state.
      const push = window.PalitraPushService;
      if (push && typeof push.refresh === 'function') {
        try { Promise.resolve(push.refresh()).catch(() => {}); } catch (_) { /* The adapter owns its readonly status error. */ }
      }
    }
  }
  function clientChatOffers(thread, data, own) {
    const entry = clientChatEntry, id = thread && B.parsePositiveId(thread.id);
    if (!entry || entry.kind !== 'chat' || entry.boundary !== clientChatBoundary() || !clientChatEntryKind() || id === null || id === undefined || !workflow || typeof workflow.clientChatOffers !== 'function') return null;
    if (entry.threadId === null) entry.threadId = id;
    if (entry.threadId !== id) return null;
    const completed = Boolean(confirmedClientOrder(own, thread, data) && data.orderLifecycle && data.orderLifecycle.orderId === own.orderRef.id && data.orderLifecycle.completed === true);
    return workflow.clientChatOffers({ entryKey: JSON.stringify([actorKey(), tickets.epoch, activeCompany, id, entry.serial]), conversationKey: `thread:${id}`, completed });
  }
  function repaintClientChatEntry() {
    const chat = ui.body.querySelector('.chat'), thread = state.clientThread, data = state.chat;
    if (!chat || !thread || !data || !Array.isArray(state.clientThreads)) return;
    const panel = clientChatOffers(thread, data, state.clientThreads.find(row => B.sameRef(row.ref, thread)));
    const previous = chat.querySelector('[data-client-chat-offers]');
    if (previous) { if (panel && panel !== previous) previous.replaceWith(panel); else if (!panel) previous.remove(); }
    else if (panel) {
      let context = chat.querySelector('.chat__context');
      if (!context) { context = h('div', { class: 'chat__context' }); const top = chat.querySelector('.chat__top'); if (top) top.append(context); else chat.insertBefore(context, chat.querySelector('.chat__list')); }
      context.prepend(panel);
    }
    scheduleChatGeometry();
  }
  function returnToClientChat() {
    if (!clientChatAway || document.hidden || document.visibilityState === 'hidden') return;
    clientChatAway = false;
    const frame = frameById(state.frameId);
    if (!clientChatEntryKind(frame)) return;
    beginClientChatEntry(frame);
    if (clientChatEntry.kind === 'site-chat') deliverSiteChatEntry();
    else repaintClientChatEntry(); // Keep the live composer, selected File and caret attached.
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden || document.visibilityState === 'hidden') clientChatAway = true; else returnToClientChat(); });
  window.addEventListener('pagehide', () => { clientChatAway = true; });
  window.addEventListener('pageshow', returnToClientChat);
  function open(id, params = {}, { back = false, replace = false } = {}) {
    const frame = frameById(id);
    if (contentTasksOverlay) disposeContentTasks();
    if (salonReportView) { salonQueries.set(activeCompany, salonReportView.query()); disposeSalonReports(); }
    if (!frame) { toast(`Экран ${id || '—'} не найден в макете`); return; }
    if (frame.role !== state.role) { toast('Этот экран для другой роли'); return; }
    if (frame.hidden === true) { toast('Страница убрана в редакторе'); return; }
    if (screenType(frame) !== 'reports') disposeResponseReport();
    if (screenType(frame) !== 'content-tasks') disposeContentTasks();
    if (managerAttention.request && !managerHome(frame)) abortManagerRead();
    if (managerLegacyLink && (managerLegacyLink.binding !== managerBinding() || params.order !== managerLegacyLink.order || !(screenType(frame) === 'chat' && params.chat === managerLegacyLink.chat || screenType(frame) === 'detail' && params.details === '1'))) managerLegacyLink = null;
    const next = entryKey(id, params), current = state.frameId ? entryKey(state.frameId, state.params) : '';
    if (!back && !replace && current && current !== next) {
      const top = nav[nav.length - 1];
      if (!top || entryKey(top.id, top.params) !== current) nav.push({ id: state.frameId, params: { ...state.params } });
    }
    const oldOrder = state.params.order, oldChat = state.params.chat;
    const oldFrame = frameById(state.frameId), oldThread = paramRef('chat', 'thread'), oldLegacy = paramRef('chat', 'legacy'), oldNativeOrder = paramRef('order', 'native-order');
    const permissionKey = JSON.stringify([auth.cabinet && auth.cabinet.role, ...((auth.cabinet && auth.cabinet.permissions) || []).slice().sort()]);
    const sameBoundary = value => value && value.epoch === tickets.epoch && value.actor === actorKey() && value.company === activeCompany && value.permissions === permissionKey && caps()['native.orders'];
    const provenThread = oldThread && state.chat && state.chat.thread && state.chat.thread.id === oldThread.id && oldNativeOrder && state.chat.thread.orderId === oldNativeOrder.id;
    const provenLegacy = oldLegacy && oldNativeOrder && state.legacyOrder && B.sameRef(state.legacyOrder, oldNativeOrder);
    const toDetails = activeCompany === 'palitra-love' && screenType(oldFrame) === 'chat' && screenType(frame) === 'detail' && params.details === '1' && params.order === oldOrder && (provenThread || provenLegacy) && caps()['native.orders'];
    if (toDetails) nativeDetailChatReturn = { epoch: tickets.epoch, actor: actorKey(), company: activeCompany, permissions: permissionKey, order: oldOrder, chat: oldChat };
    const fromDetails = screenType(oldFrame) === 'detail' && state.params.details === '1' && screenType(frame) === 'chat' && sameBoundary(nativeDetailChatReturn) && params.order === nativeDetailChatReturn.order && params.chat === nativeDetailChatReturn.chat;
    const preserveChatFile = Boolean(toDetails && sameBoundary(nativeDetailChatReturn) || fromDetails);
    if (!preserveChatFile || fromDetails) nativeDetailChatReturn = null;
    state.frameId = id; state.params = { ...params };
    orderReadIntent = null;
    if (managerAllowed() && screenType(frameById(id)) === 'chat') orderReadIntent = managerBinding()+'|'+id+'|'+str(state.params.chat); state.menuOpen = false; state.works = false; state.installOpen = false; state.error = ''; state.notice = '';
    if (attachmentUI) { if (preserveChatFile) attachmentUI.clearViews(); else attachmentUI.unmount(); } attachmentComposer = null;
    earlierRead = null; earlierThreadsRead = null; staffAdviceRead = null; clientOrdersEarlierRead = null; state.chatBlocked = null;
    tickets.bumpNav();
    beginClientChatEntry(frame);
    if (screenType(frame) === 'reports') { state.summary = null; state.crmReport = null; state.reportLoading = true; }
    // Данные другой сущности не показываются ни мгновения: до ответа — «Загрузка…».
    if (params.order !== oldOrder) { state.detail = null; state.links = null; }
    if (params.chat !== oldChat || params.order !== oldOrder) { state.chat = null; state.legacyOrder = null; }
    try { history.replaceState(null, '', `#${next.replace(/\?$/, '')}`); reportNavigation?.remember(location.hash); } catch (_) { /* адрес не обязателен */ }
    stopChatRefresh();
    render({ fresh: true });
    loadScreen();
  }
  function goBack() {
    while (nav.length) {
      const e = nav.pop();
      if (frameById(e.id) && entryKey(e.id, e.params) !== entryKey(state.frameId, state.params)) { open(e.id, e.params, { back: true }); return; }
    }
    render();
  }
  function go(target, params = {}) {
    if (target === '@site') return openLinkNotice('site.open');
    if (target === '@works') { state.works = true; render(); return; }
    if (!target) { toast('Это действие пока не подключено'); return; }
    const frame = frameById(target);
    if (frame && frame.role === state.role) open(target, params); else toast('Этот экран для другой роли');
  }
  function openLinkNotice(name) { toast(`Откроется по ссылке: ${B.linkUrl(name)}`); }


  function preferredKey(who) { return `synapse-app-company-v1:${String(who.userId)}`; }
  function readPreferredCompany(who) { try { return sessionStorage.getItem(preferredKey(who)); } catch (_) { return null; } }
  function renderCompanyNav() {
    if (!multiCompany || !companyContext) return;
    const snapshot = companyContext.snapshot();
    const panels = [$('desktop-nav')?.querySelector('.app-menu__panel'), ui.overlay.querySelector('.app-menu > .app-menu__panel')].filter(Boolean);
    // Only the verified staff company list belongs in the menu footer. Nothing
    // is appended below a conversation or exposed to a customer role.
    for (const old of $('phone').querySelectorAll('[data-company-nav]')) if (!panels.includes(old.parentNode)) old.remove();
    for (const parent of panels) Companies.renderNav({ document, parent,
      state: !state.role || state.role === 'client' ? { ...snapshot, companies: [] } : snapshot,
      select: code => { void companyContext.choose(code).catch(error => { toast(error.message); renderCompanyNav(); }); } });
  }
  function activateCompany(profile, who, options = {}) {
    disposeContentTasks();
    disposeResponseReport();
    disposeSalonReports();
    if (!profile) {
      clearIdentityData({ preserveCompanyContext: true }); auth.cabinet = null; state.role = ''; state.frameId = null; render(); return;
    }
    const sameActor = auth.cabinet && String(who.userId) === auth.cabinet.userId;
    if (!options.initial || activeCompany !== profile.code || (auth.cabinet && !sameActor)) {
      clearTimeout(toastTimer); toastTimer = 0; ui.toast.hidden = true; ui.toast.textContent = '';
      if (!sameActor) clearIdentityData({ preserveCompanyContext: true });
      else {
        companyForms.set(`${auth.cabinet.userId}#${activeCompany}`, { ...form });
        resetManagerAttention();
        nativeDetailChatReturn = null; chatAdviceDisclosure.clear(); state.legacyOrder = null;
        disposeFreeLayouts(); tickets.bumpEpoch(); stopChatRefresh(); destroyFrames();
        attachmentUI?.setIdentity({ key: '', epoch: tickets.epoch }); attachmentUI?.unmount();
        attachmentComposer = null; earlierRead = null; earlierThreadsRead = null; staffAdviceRead = null;
        moreSiteChats = null; siteChatHeadRead = null; nav.length = 0; counts.orders = 0;
        Object.assign(state, { bootstrap: null, native: null, detail: null, links: null, chat: null, chatBlocked: null, summary: null, crmReport: null,
          reportRange: null, reportDraft: null, reportLoading: false, clientThread: null, clientThreads: null, clientThreadsBefore: null,
          clientThreadLinked: false, siteChatThreads: null, siteChatThreadsBefore: null, error: '', menuOpen: false, works: false, installOpen: false, params: {} });
        sessionFileSafety.clear(); sessionOpaqueDirty = false; sessionConfirmedForm = null;
      }
    }
    activeCompany = profile.code; B = ROOT_BRIDGE.forCompany(profile.code);
    bridge = B.createBridge({ transport: HOST.selectCompany(profile.code), getAuth: () => auth });
    auth.cabinet = B.parseIdentity(who); auth.e1Native = profile.code === 'palitra-love' && HOST.e1Native === true;
    if (typeof HOST.acceptCabinetCsrf === 'function') HOST.acceptCabinetCsrf(auth.cabinet.csrfToken);
    attachmentUI = profile.code === 'palitra-love' && HOST.attachments && window.PalitraAttachmentsUI
      ? window.PalitraAttachmentsUI.create({ document, window, client: B.createAttachmentClient({ transport: HOST.attachments, getAuth: () => auth }),
        onUnauthorized: error => endSession('cabinet', error.message) }) : null;
    Object.assign(form, companyForms.get(`${auth.cabinet.userId}#${profile.code}`) || initialForm());
    try { sessionStorage.setItem(preferredKey(who), profile.code); } catch (_) { /* selection carries no access */ }
    document.title = `${profile.name} — приложение`;
    workflowIdentity();
    if (!options.initial) { state.role = uiRole(); state.frameId = null; open(homeFrame(state.role), {}, { replace: true }); refreshCounts(tickets.epoch); }
  }
  if (multiCompany) companyContext = Companies.create({
    verifyIdentity: () => bridge.call('staff.identity'),
    beforeSwitch: () => sessionUpdateSafety().filter(reason => !['draft', 'typing'].includes(reason)),
    activate: activateCompany, changed: renderCompanyNav,
  });

  /* ---------- вход и смена identity ---------- */
  function clearIdentityData({ preserveCompanyContext = false } = {}) {
    clientChatEntry = null; clientChatAway = false;
    disposeContentTasks();
    disposeResponseReport();
    resetManagerAttention();
    clientOrderAccess = null; clientOrdersEarlierRead = null;
    nativeDetailChatReturn = null; chatAdviceDisclosure.clear(); state.legacyOrder = null;
    disposeSalonReports(); salonQueries.clear();
    companyForms.clear();
    if (companyContext && !preserveCompanyContext) companyContext.revoke();
    disposeFreeLayouts();
    tickets.bumpEpoch();
    if (attachmentUI) attachmentUI.setIdentity({ key: '', epoch: tickets.epoch }); attachmentComposer = null;
    drafts.clear(); chatScroll.clear(); chatFollowNext.clear(); chatPrepend.clear(); pendingSends.clear(); inflight.clear(); counts.orders = 0;
    earlierRead = null; earlierThreadsRead = null; staffAdviceRead = null;
    if (workflow) workflow.setIdentity({ key: '', role: '', member: false, permissions: [] });
    Object.assign(form, initialForm());
    fieldDrafts.clear();
    sessionFileSafety.clear(); sessionFormDefaults.clear(); sessionOpaqueDirty = false; sessionConfirmedForm = null;
    stopChatRefresh();
    destroyFrames();   // F6: прежний редактор не появляется после смены/отзыва identity
    moreSiteChats = null; siteChatHeadRead = null;
    Object.assign(state, { bootstrap: null, native: null, detail: null, links: null, chat: null, chatBlocked: null, summary: null, crmReport: null, reportRange: null, reportDraft: null, reportLoading: false, clientThread: null, clientThreads: null, clientThreadsBefore: null, clientThreadLinked: false, siteChatThreads: null, siteChatThreadsBefore: null, error: '' });
    state.installOpen = false;
    nav.length = 0;
  }
  function endSession(space, message) {
    auth[space] = null;
    if (space === 'cabinet') auth.cabinetSession = false;
    if (space === 'portal') auth.portalSession = false;
    if (space === 'account') { auth.account = null; auth.chat = null; }
    clearIdentityData();
    state.authLoading = false;
    state.authError = message || 'Сессия завершена. Войдите штатно и откройте приложение заново.';
    state.role = uiRole(); state.frameId = null;
    if (state.role && homeFrame(state.role)) open(homeFrame(state.role), {}, { replace: true }); else render();
  }
  async function signIn(previewRole) {
    if (!bridge) return;
    let epoch = tickets.epoch + 1;
    let shopProbe = false, portalAvailable = false;
    clearIdentityData();
    state.authLoading = true; state.authError = ''; state.role = ''; state.frameId = null;
    render();
    if (preview) {
      // Предпросмотр: набор синтетических сессий mock (не права и не native identity).
      const p = HOST.service.PREVIEW[previewRole];
      Object.assign(auth, { preview: previewRole || '', cabinetSession: Boolean(p && p.cabinet), portalSession: Boolean(p && p.portal), cabinet: null, portal: null,
        account: p && p.account ? { ...p.account } : null, chat: null, guest: false });
    } else {
      // Native: только флаги наличия сессий от доверенного host (getAuthContext); роли и identity — из ответов whoami/bootstrap.
      let ctx = {};
      try { ctx = typeof HOST.getAuthContext === 'function' ? HOST.getAuthContext() || {} : {}; } catch (_) { ctx = {}; }
      const account = ctx.account && B.accountRef(ctx.account.opaque) ? { opaque: ctx.account.opaque } : null;
      Object.assign(auth, { preview: '', cabinetSession: ctx.cabinetSession === true, portalSession: ctx.portalSession === true, cabinet: null, portal: null,
        account, chat: null, guest: ctx.guest === true && !account, e1Native: HOST.e1Native === true });
      shopProbe = ctx.shopSession === true; portalAvailable = ctx.portalAvailable === true;
    }
    state.authError = '';
    const staffEntryAttempt = Boolean(auth.cabinetSession && staffChatTarget(initialStaffChatHash));
    const live = () => tickets.epoch === epoch;
    try {
      // Native магазин: существующая сессия аккаунта (гость или вошедший). Имя/контакт формы правом не являются.
      if (!preview && shopProbe) {
        const session = B.parseAccountSession(await bridge.call('account.session')); if (!live()) return;
        auth.account = { opaque: session.opaque }; auth.guest = !session.signedIn;
        if (typeof HOST.acceptAccountCsrf === 'function') HOST.acceptAccountCsrf(session.csrf);
        // Заказы покупателя — через штатный crm-session (только вошедший покупатель и включённый CRM host-флаг).
        if (session.signedIn && portalAvailable) auth.portalSession = true;
      }
      if (auth.cabinetSession) {
        const who = await bridge.call('staff.identity'); if (!live()) return;
        if (multiCompany) {
          if (salonEntryError) throw Object.assign(new Error(salonEntryError), { status: 403 });
          // The pointer selects a company only after whoami; it never grants access.
          if (staffEntryAttempt) {
            if (!staffChatEntry(initialStaffChatHash, 'admin') && !staffChatEntry(initialStaffChatHash, 'staff')) throw Object.assign(new Error('Ссылка на чат некорректна. Откройте исходное уведомление.'), { status: 403 });
            const palitraBridge = ROOT_BRIDGE.forCompany('palitra-love'), identity = palitraBridge.parseIdentity(who);
            if (!identity.member || !palitraBridge.capabilities({ cabinet: identity })['native.orders']) throw Object.assign(new Error('Нет доступа к чату Палитры для этого рабочего аккаунта'), { status: 403 });
          }
          const preferred = initialSalonReport ? initialSalonReport.company : staffEntryAttempt ? 'palitra-love' : readPreferredCompany(who);
          if (initialSalonReport && !who.companies?.some(c => (typeof c === 'string' ? c : c.id) === preferred)) throw Object.assign(new Error('Нет доступа к компании из ссылки отчёта'), { status: 403 });
          const selected = companyContext.initialize(who, preferred);
          if (!selected) throw Object.assign(new Error('Нет доступных компаний для приложения'), { status: 403 });
          activateCompany(selected, who, { initial: true }); epoch = tickets.epoch;
        } else auth.cabinet = B.parseIdentity(who);
        // CSRF кабинета — только транспорту host (память), не в state/URL/манифест.
        if (!preview && typeof HOST.acceptCabinetCsrf === 'function') HOST.acceptCabinetCsrf(auth.cabinet.csrfToken);
      }
      if (auth.portalSession) { const data = await bridge.call('portal.bootstrap'); if (!live()) return; auth.portal = B.parsePortalActor(data); state.bootstrap = data; }
      if (auth.account && B.accountRef(auth.account.opaque)) {
        // parseAccountSession подтверждает и guest-session: чат создаёт штатный backend для своей cookie/CSRF-сессии.
        // Выключенный E/отказ — chat.ready=false; произвольный guest-флаг сессию и права на чат не создаёт.
        let session = null;
        try { session = await bridge.call('customer.chat.session', { body: {} }); } catch (failure) { if (!live()) return; if (failure.status === 401) throw failure; session = null; }
        if (!live()) return;
        const csrf = session && session.ok === true && typeof session.csrfToken === 'string' ? session.csrfToken : '';
        auth.chat = { ready: Boolean(session && session.ok === true && (preview || csrf)) };
        if (!preview && typeof HOST.acceptChatSession === 'function') HOST.acceptChatSession(csrf);
      }
    } catch (error) {
      if (!live()) return;
      state.authError = error.code === 'NATIVE_DISABLED' ? 'Приложение временно недоступно. Попробуйте обновить страницу позже.' : error.message;
      if (error.status === 401) Object.assign(auth, { cabinetSession: false, portalSession: false, cabinet: null, portal: null });
    }
    state.authLoading = false;
    state.role = uiRole();
    nav.length = 0; state.frameId = null;
    // Стартовые ссылки настроек: роль и членство уже подтверждены backend.
    const reportEntry = initialSalonReport; initialSalonReport = null;
    if (reportEntry) salonQueries.set(reportEntry.company, reportEntry.query);
    const requestedWorkflow = initialWorkflowRoute; initialWorkflowRoute = false;
    workflowIdentity();
    const requestedTeam = Object.values(TEAM_CHAT_FRAMES).includes(requestedWorkflow) && teamChatAllowed() && visibleFrame(requestedWorkflow, state.role);
    const destination = requestedTeam ? requestedWorkflow : requestedWorkflow && visibleFrame(requestedWorkflow, state.role) && (requestedWorkflow === 'A10' ? workflowSettingsAllowed() : state.role === 'admin' && workflow && workflow.isOwner()) ? requestedWorkflow : homeFrame(state.role);
    const requestedSiteChat = initialSiteChat; initialSiteChat = false;
    const requestedClientOrders = initialClientOrders; initialClientOrders = false;
    const requestedOrder = initialNativeOrder, requestedDetails = initialNativeDetails, detail = state.role && state.role !== 'client' ? mobileFrame(state.role, 'detail') : null;
    const requestedChat = initialCustomerChat, customerChat = state.role === 'client' && caps()['customer.chat'] ? mobileFrame('client', 'chat') : null;
    const requestedStaffChat = staffChatEntry(initialStaffChatHash), staffChat = requestedStaffChat && visibleFrame(requestedStaffChat.frameId, state.role);
    const restoreStaffChat = activeCompany === 'palitra-love' && staffChat && ['admin', 'staff'].includes(state.role) && screenType(staffChat) === 'chat' && screenAllowed(staffChat);
    const requestedResponseReport = /^#[A-Za-z0-9_-]+$/.test(initialResponseReportHash || '') && visibleFrame(initialResponseReportHash.slice(1), state.role);
    const restoreResponseReport = responseReportAllowed() && requestedResponseReport && screenType(requestedResponseReport) === 'reports' && screenAllowed(requestedResponseReport);
    const requestedContentTasks = /^#[A-Za-z0-9_-]+$/.test(initialContentTasksHash || '') && visibleFrame(initialContentTasksHash.slice(1), state.role);
    const restoreContentTasks = contentTasksAllowed() && requestedContentTasks && screenType(requestedContentTasks) === 'content-tasks' && screenAllowed(requestedContentTasks);
    // Keep a refused pointer intact; do not fall back to another company's home.
    if (staffEntryAttempt && !restoreStaffChat) {
      state.authError = state.authError || 'Чат Палитры недоступен для этого рабочего входа';
      render(); return;
    }
    if (state.role) {
      initialNativeOrder = null;
      initialNativeDetails = false;
      initialCustomerChat = null;
      initialStaffChatHash = null;
      initialResponseReportHash = null;
      initialContentTasksHash = null;
      if (!preview) { try { sessionStorage.removeItem(FOLLOWUP_NAV_KEY); } catch (_) {} }
    }
    if (reportEntry && state.role && salonAllowed()) {
      const reportFrame = frames().filter(f => f.role === state.role).find(f => screenType(f) === 'reports' && f.hidden !== true);
      if (reportFrame) open(reportFrame.id, {}, { replace: true }); else { state.authError = 'Экран отчётов недоступен для этого входа'; render(); }
    } else if (!requestedWorkflow && restoreContentTasks) open(requestedContentTasks.id, {}, { replace: true });
    else if (!requestedWorkflow && restoreResponseReport) open(requestedResponseReport.id, {}, { replace: true });
    else if (!requestedWorkflow && requestedStaffChat && restoreStaffChat)
      open(staffChat.id, { chat: B.refKey(requestedStaffChat.chat), ...(requestedStaffChat.order ? { order: B.refKey(requestedStaffChat.order) } : {}) }, { replace: true });
    else if (!requestedWorkflow && requestedOrder && detail && detail.hidden !== true && caps()['native.orders'])
      open(detail.id, { order: B.refKey(requestedOrder), ...(requestedDetails ? { details: '1' } : {}) }, { replace: true });
    else if (!requestedWorkflow && requestedChat && customerChat && customerChat.hidden !== true)
      open(customerChat.id, { chat: B.refKey(requestedChat.chat), ...(requestedChat.site ? { site: B.refKey(requestedChat.site) } : {}) }, { replace: true });
    else if (!requestedWorkflow && requestedClientOrders && activeCompany === 'palitra-love' && state.role === 'client' && visibleFrame(CLIENT_ORDER_CHAT_FRAME, 'client')) open(CLIENT_ORDER_CHAT_FRAME, {}, { replace: true });
    else if (!requestedWorkflow && requestedSiteChat && state.role === 'client' && caps()['customer.chat']) open(SITE_CHAT_FRAME, {}, { replace: true });
    else if (state.role && destination) open(destination, {}, { replace: true }); else render();
    refreshCounts(epoch);   // после определения роли по ответам backend
  }

  /* Счётчик уведомлений у пунктов «заказы»: только подтверждённый unread backend.
     Клиент — 0 (в E webchat и CRM нет unread); owner кабинета — legacy aggregate client-bot.unread. Заявки/work=new — не unread.
     Нет подключения или ответа — 0. Ничего не пишется в макет. */
  async function refreshCounts(epoch) {
    if (managerAllowed()) { await orderReads.read(); return; }
    if (!bridge) return;
    const c = caps();
    let n = 0;
    try {
      // В E-чате и CRM нет серверного unread/read cursor — у клиента 0. Число заявок/work=new — не unread.
      // Сотрудник (owner кабинета): единственный подтверждённый aggregate — legacy unread GET /content/palitra/client-bot.
      if (state.role && state.role !== 'client' && c['native.orders']) n = B.parseUnread(await bridge.call('legacy.bot.summary'));
    } catch (_) { n = 0; }
    if (epoch !== tickets.epoch) return;
    counts.orders = n;
    render();
  }

  /* Общая лента — только явно запрошенный серверный scope. Состав не выводится из имени, телефона или соседней заявки. */
  const CONVERSATION_PAGE = 50;
  let earlierRead = null, earlierThreadsRead = null, staffAdviceRead = null;
  const staffAdvisoryAccess = () => !preview && state.role !== 'client' && Boolean(auth.cabinet && auth.cabinet.member && caps()['native.orders'] && caps()['native.threads'] === true);
  const conversationScopeFailure = (failure) => Boolean(failure && (failure.status === 404 || failure.status === 409 || failure.status === 410));
  function blockedConversation() { return state.chatBlocked && state.chatBlocked.key === contextKey() ? state.chatBlocked : null; }
  function invalidateConversation(seed, reason) {
    const old = state.chat, retained = blockedConversation();
    const sameSeed = old && seed && (seed.ns === 'thread' ? old.seedThread?.id === seed.id : seed.ns === 'legacy' && old.dialog?.id === seed.id);
    const uploads = sameSeed ? old.uploads : retained && seed && retained.seed.id === seed.id && retained.seed.ns === seed.ns ? retained.uploads : null;
    // Keep the exact local composer record, but never retain revoked messages, names, attachment links or choice pages.
    state.chatBlocked = seed && ['thread','legacy'].includes(seed.ns) ? { seed, uploads, key: contextKey(), reason: reason || 'Доступ к переписке изменился. Обновите её для проверки.' } : null;
    state.chat = null; state.clientThread = null; state.clientThreadLinked = false; state.clientThreads = []; state.clientThreadsBefore = null;
    if (seed?.ns === 'legacy') {
      state.legacyOrder = null; state.siteChatThreads = null; state.siteChatThreadsBefore = null;
      abortManagerRead(); managerLegacyLink = null; managerSnapshots.clear(); managerChannelDisclosure.clear();
      managerAttention.data = null; managerAttention.items = [];
    }
    earlierRead = null; earlierThreadsRead = null; staffAdviceRead = null;
    // Older in-flight reads cannot restore the invalidated cache. Draft/send/file identities are untouched.
    tickets.bumpNav(); stopChatRefresh(); render();
  }
  function blockedChatView(blocked) {
    return chatView({ name: 'Переписка временно недоступна', subtitle: blocked.reason, messages: [], mine: [], blocked: true,
      draft: draftKey('chat', blocked.seed), max: blocked.seed.ns === 'legacy' ? 8000 : 4000, placeholder: 'Черновик сохранён. Сначала обновите переписку.', send: () => {},
      attachmentTarget: blocked.seed, uploads: blocked.uploads });
  }
  function ownThreadPage(data, before = null) {
    if (!data || !Array.isArray(data.threads) || data.threads.length > 100) throw new Error('Сервер не подтвердил список ваших переписок.');
    const threads = data.threads.map((t) => {
      if (!t || typeof t.id !== 'number' || B.parsePositiveId(t.id) === null || !(t.orderId === null || typeof t.orderId === 'number' && B.parsePositiveId(t.orderId) !== null) || (before !== null && t.id >= before)) throw new Error('Сервер не подтвердил список ваших переписок.');
      return { ref: B.makeRef('thread', t.id), orderRef: t.orderId === null ? null : B.makeRef('native-order', t.orderId) };
    });
    const nextBefore = data.nextBefore == null ? null : data.nextBefore;
    if (nextBefore !== null && (typeof nextBefore !== 'number' || B.parsePositiveId(nextBefore) === null || !threads.some((t) => t.ref.id === nextBefore) || (before !== null && nextBefore >= before))) throw new Error('Сервер не подтвердил страницу ваших переписок.');
    return { threads, nextBefore };
  }
  /* Client home reads only direct own grants. No order status is inferred from a thread. */
  let clientOrderAccess = null, clientOrdersEarlierRead = null;
  const clientOrderBinding = () => `${tickets.epoch}|${activeCompany}|${actorKey()}`;
  const clientHome = (frame = frameById(state.frameId)) => activeCompany === 'palitra-love' && state.role === 'client' && frame && frame.id === MENU_HOME.client;
  const clientOrderSurface = frame => activeCompany === 'palitra-love' && state.role === 'client' && frame && (clientHome(frame) || ['orders', 'client-current-orders'].includes(screenType(frame)));
  function currentClientOrders() { return clientOrderAccess && clientOrderAccess.binding === clientOrderBinding() ? clientOrderAccess : null; }
  function clientOrderPage(data, before = null) {
    const page = ownThreadPage(data, before), ids = new Set();
    for (const thread of page.threads) { if (ids.has(thread.ref.id)) throw new Error('Сервер не подтвердил список ваших заявок.'); ids.add(thread.ref.id); }
    return { threads: page.threads, nextBefore: page.nextBefore };
  }
  function openClientOrderThread(thread) {
    const own = currentClientOrders(), frame = mobileFrame('client', 'chat');
    if (!caps()['customer.chat'] || !own || own.unavailable || !frame || !thread || !own.threads.some(item => B.sameRef(item.ref, thread.ref) && (item.orderRef === null && thread.orderRef === null || B.sameRef(item.orderRef, thread.orderRef)))) return;
    open(frame.id, { chat: B.refKey(thread.ref), ...(thread.orderRef ? { site: B.refKey(thread.orderRef) } : {}) });
  }
  function openCurrentClientChat() {
    const own = currentClientOrders();
    if (own && !own.unavailable && own.nextBefore === null && own.threads.length === 1) openClientOrderThread(own.threads[0]);
    else open(CLIENT_ORDER_CHAT_FRAME);
  }
  async function loadEarlierClientOrders() {
    const own = currentClientOrders();
    if (!clientOrderSurface(frameById(state.frameId)) || !caps()['customer.chat'] || !own || own.unavailable || own.nextBefore === null || clientOrdersEarlierRead) return;
    const key = contextKey(), binding = clientOrderBinding(), before = own.nextBefore, ticket = tickets.take(key), pending = { ticket };
    clientOrdersEarlierRead = pending; render();
    try {
      const page = clientOrderPage(await bridge.call('customer.chat.threads.page', { body: { before, limit: 30 } }), before);
      if (!tickets.live(ticket, key) || binding !== clientOrderBinding() || !tickets.accept(ticket, 'clientOrderAccess')) return;
      const unique = new Map(own.threads.map(thread => [thread.ref.id, thread])); for (const thread of page.threads) unique.set(thread.ref.id, thread);
      clientOrderAccess = { binding, threads: [...unique.values()], nextBefore: page.nextBefore, unavailable: false };
    } catch (failure) {
      if (!tickets.live(ticket, key) || binding !== clientOrderBinding()) return;
      if (failure.status === 401 || failure.code === 'SESSION_ENDED') { endSession('account', failure.message); return; }
      if (failure.status === 403) clientOrderAccess = { binding, threads: [], nextBefore: null, unavailable: true };
      else toast('Не удалось загрузить более ранние заказы. Уже открытые заявки сохранены.');
    } finally { if (clientOrdersEarlierRead === pending) { clientOrdersEarlierRead = null; render(); } }
  }
  function clientOrdersPanel() {
    const own = currentClientOrders(), box = h('section', { class: 'client-order-entry card', dataset: { clientOrderEntry: '' }, 'aria-label': 'Ваш заказ и переписка' },
      h('h2', { class: 'text__title', text: 'Ваш заказ и переписка' }));
    if (!own) { box.append(h('p', { class: 'muted', role: 'status', text: 'Проверяем ваши заказы…' })); return box; }
    if (own.threads.length) {
      box.append(h('p', { class: 'muted', text: own.threads.length === 1 && own.nextBefore === null ? 'Вернитесь в вашу переписку.' : 'Выберите заказ или переписку.' }));
      for (const thread of own.threads) box.append(h('button', { type: 'button', class: 'client-order-entry__item', dataset: { ...(thread.orderRef ? { clientOrder: B.refKey(thread.orderRef) } : {}), clientThread: B.refKey(thread.ref) }, onclick: () => openClientOrderThread(thread) },
        h('strong', { text: thread.orderRef ? `Заявка №${thread.orderRef.id}` : 'Переписка с Palitra Love' }), h('span', { text: 'Открыть переписку', class: 'client-order-entry__action' })));
    } else if (own.unavailable) box.append(h('p', { class: 'muted', role: 'status', text: 'Не удалось загрузить ваши заказы и переписку. Попробуйте обновить список.' }));
    else box.append(h('details', { class: 'client-order-entry__recovery' }, h('summary', { text: 'Уже оформили заказ?' }),
      h('p', { class: 'muted', text: 'Здесь пока нет заказов и переписки. Если вы уже писали нам, откройте чат в браузере, где общались раньше.' })));
    if (caps()['portal.customer']) {
      const target = ordersFrames('client').active;
      if (target) box.append(h('button', { type: 'button', class: 'app-btn', dataset: { clientPortalOrders: '' }, onclick: () => open(target.id || target), text: 'Ваши заказы' }));
    }
    if (own.nextBefore !== null) box.append(h('button', { type: 'button', class: 'app-btn app-btn--ghost', disabled: Boolean(clientOrdersEarlierRead), dataset: { clientOrdersEarlier: '' }, onclick: loadEarlierClientOrders, text: clientOrdersEarlierRead ? 'Загружаем…' : 'Более ранние заказы' }));
    if (!own.threads.length && caps()['customer.chat']) box.append(h('button', { type: 'button', class: 'app-btn app-btn--ghost', onclick: () => open(SITE_CHAT_FRAME), text: 'Открыть чат с Palitra Love' }));
    box.append(h('button', { type: 'button', class: 'app-btn app-btn--ghost', dataset: { clientOrdersRefresh: '' }, onclick: () => { clientOrderAccess = null; render(); loadScreen(); }, text: 'Обновить заказы' }));
    return box;
  }

  async function loadEarlierThreads() {
    if (earlierThreadsRead || state.clientThreadsBefore == null) return;
    const before = state.clientThreadsBefore, key = contextKey(), ticket = tickets.take(key), pending = { ticket }; earlierThreadsRead = pending; render();
    try {
      const page = ownThreadPage(await bridge.call('customer.chat.threads.page', { body: { before, limit: 30 } }), before);
      if (!tickets.live(ticket, contextKey()) || !tickets.accept(ticket, 'clientThreads') || !tickets.accept(ticket, 'clientThreadsBefore')) return;
      const unique = new Map((state.clientThreads || []).map((t) => [t.ref.id, t]));
      for (const thread of page.threads) unique.set(thread.ref.id, thread);
      state.clientThreads = [...unique.values()]; state.clientThreadsBefore = page.nextBefore;
    } catch (failure) {
      if (!tickets.live(ticket, contextKey())) return;
      if (failure.status === 401 || failure.status === 403 || failure.code === 'SESSION_ENDED') { endSession('account', failure.message); return; }
      if (conversationScopeFailure(failure)) {
        if (tickets.accept(ticket, 'chat') && tickets.accept(ticket, 'clientThreads')) invalidateConversation(paramRef('chat', 'thread') || state.clientThread, failure.message);
        return;
      }
      toast(failure.message);
    } finally {
      if (earlierThreadsRead === pending) { earlierThreadsRead = null; if (tickets.live(ticket, contextKey())) render(); }
    }
  }
  function conversationPage(data, seed, before = null, adviceAfter = null) {
    const bad = () => { throw new Error('Сервер не подтвердил общую переписку. Обновите её.'); };
    if (!data || !seed || seed.ns !== 'thread' || !data.thread || data.thread.id !== seed.id || !data.seedThread || data.seedThread.id !== seed.id ||
      !(data.seedThread.orderId === null || typeof data.seedThread.orderId === 'number' && B.parsePositiveId(data.seedThread.orderId) !== null) || data.thread.orderId !== data.seedThread.orderId ||
      !data.composeThread || data.composeThread.id !== seed.id || data.composeThread.orderId !== data.seedThread.orderId || !data.scope || data.scope.view !== 'conversation-v1' ||
      !['session-grants', 'single-thread'].includes(data.scope.kind) || typeof data.scope.limited !== 'boolean' || !/^[a-f0-9]{64}$/.test(data.scope.key || '') ||
      !Array.isArray(data.messages) || data.messages.length > CONVERSATION_PAGE) bad();
    const seen = new Set();
    for (const message of data.messages) {
      if (!message || typeof message.id !== 'number' || B.parsePositiveId(message.id) === null || seen.has(message.id) ||
        typeof message.threadId !== 'number' || B.parsePositiveId(message.threadId) === null ||
        !(message.orderId === null || typeof message.orderId === 'number' && B.parsePositiveId(message.orderId) !== null) || (before !== null && message.id >= before)) bad();
      seen.add(message.id);
    }
    const messages = data.messages.slice().sort((a, b) => a.id - b.id), cursor = data.nextBefore == null ? null : data.nextBefore;
    if (cursor !== null && (typeof cursor !== 'number' || B.parsePositiveId(cursor) === null || !messages.length || cursor !== messages[0].id || (before !== null && cursor >= before))) bad();
    // An untrusted/client/legacy response can never inject a staff card into the shared feed.
    let staffAdvisories = null;
    if (staffAdvisoryAccess() && Object.prototype.hasOwnProperty.call(data, 'staffAdvisories')) {
      try { staffAdvisories = B.parseStaffAdvisories(data.staffAdvisories, data.scope.key, adviceAfter); }
      catch (failure) {
        if (failure.code !== 'STAFF_ADVISORIES_INVALID') throw failure;
        // Optional current advice must not hide an independently validated ordinary history.
        staffAdvisories = { schema: 1, scopeKey: data.scope.key, status: 'unavailable', items: [], nextAfterThreadId: null };
      }
    }
    return { ...data, messages, nextBefore: cursor, staffAdvisories, customerContact: staffAdvisoryAccess() ? safeThreadContact(data, seed.id) : null };
  }
  function mergeConversation(previous, page, older = false) {
    const same = previous && previous.seedThread && previous.seedThread.id === page.seedThread.id && previous.scope && previous.scope.key === page.scope.key;
    if (!same) return { ...page, historyReset: Boolean(previous) };
    if (older) {
      const byId = new Map(page.messages.map((m) => [m.id, m]));
      for (const message of previous.messages) byId.set(message.id, message);
      return { ...previous, messages: [...byId.values()].sort((a, b) => a.id - b.id), nextBefore: page.nextBefore };
    }
    // Latest page must overlap the old window. A burst larger than one page must not create a hidden gap.
    const previousIds = new Set(previous.messages.map((m) => m.id)), overlap = page.messages.some((m) => previousIds.has(m.id));
    if (page.nextBefore === null || !overlap) return { ...page, historyReset: !overlap && previous.messages.length > 0 };
    const first = page.messages[0].id, retained = previous.messages.filter((m) => m.id < first);
    return { ...page, messages: [...retained, ...page.messages], nextBefore: retained.length ? previous.nextBefore : page.nextBefore };
  }
  function readConversation(seed, before = null, adviceAfter = null) {
    const paging = { limit: CONVERSATION_PAGE, ...(before === null ? {} : { before }), ...(adviceAfter === null ? {} : { adviceAfter }) };
    return state.role === 'client'
      ? bridge.call('customer.chat.conversation', { body: { threadId: seed.id, ...paging } })
      : bridge.call('thread.conversation', { ref: seed, query: paging });
  }
  async function loadEarlier(seed) {
    const current = state.chat;
    if (earlierRead || !current || !current.scope || current.nextBefore === null || !current.seedThread || current.seedThread.id !== seed.id) return;
    const key = contextKey(), ticket = tickets.take(key), before = current.nextBefore;
    const pending = { key, seed: seed.id, ticket }; earlierRead = pending; render();
    try {
      const page = conversationPage(await readConversation(seed, before), seed, before);
      if (!tickets.live(ticket, contextKey()) || !tickets.accept(ticket, 'chat')) return;
      if (!state.chat || state.chat.scope.key !== page.scope.key || state.chat.seedThread.id !== seed.id) {
        state.chat = null; render(); await loadScreen({ refresh: true }); return;
      }
      const list = ui.body.querySelector('.chat__list');
      if (list) chatPrepend.set(list.dataset.draft, { top: list.scrollTop, height: list.scrollHeight });
      state.chat = mergeConversation(state.chat, page, true);
    } catch (failure) {
      if (!tickets.live(ticket, contextKey())) return;
      if (failure.status === 401 || failure.status === 403 || failure.code === 'SESSION_ENDED') { endSession(state.role === 'client' ? 'account' : 'cabinet', failure.message); return; }
      if (conversationScopeFailure(failure)) { if (tickets.accept(ticket, 'chat')) invalidateConversation(seed, failure.message); return; }
      if (failure.code === 'STAFF_ADVISORIES_INVALID' && state.chat) state.chat = { ...state.chat, staffAdvisories: null };
      toast(failure.message);
    } finally {
      if (earlierRead === pending) { earlierRead = null; if (tickets.live(ticket, contextKey())) render(); }
    }
  }

  async function loadMoreStaffAdvice(seed) {
    const current = state.chat, advice = current && current.staffAdvisories;
    if (!staffAdvisoryAccess() || staffAdviceRead || !seed || seed.ns !== 'thread' || !current || !current.seedThread || current.seedThread.id !== seed.id || !advice || advice.scopeKey !== current.scope.key || advice.nextAfterThreadId === null) return;
    const key = contextKey(), ticket = tickets.take(key), after = advice.nextAfterThreadId;
    const pending = { key, advice }; staffAdviceRead = pending; render();
    try {
      const page = conversationPage(await readConversation(seed, null, after), seed, null, after);
      if (!tickets.live(ticket, contextKey()) || staffAdviceRead !== pending || !staffAdvisoryAccess()) return;
      if (!state.chat || state.chat.staffAdvisories !== advice) return; // A normal refresh has already replaced current advice.
      if (page.scope.key !== current.scope.key || !page.staffAdvisories) { invalidateConversation(seed); return; }
      const byKey = new Map((page.staffAdvisories.status === 'ready' ? advice.items : []).map(item => [item.key, item]));
      for (const item of page.staffAdvisories.items) byKey.set(item.key, item);
      state.chat = { ...state.chat, staffAdvisories: { ...page.staffAdvisories, items: [...byKey.values()].sort((a, b) => a.basisAt.localeCompare(b.basisAt) || a.key.localeCompare(b.key)) } };
    } catch (failure) {
      if (!tickets.live(ticket, contextKey()) || staffAdviceRead !== pending) return;
      if (failure.status === 401 || failure.status === 403 || failure.code === 'SESSION_ENDED') { endSession('cabinet', failure.message); return; }
      if (conversationScopeFailure(failure)) { invalidateConversation(seed, failure.message); return; }
      if (failure.code === 'STAFF_ADVISORIES_INVALID' && state.chat) state.chat = { ...state.chat, staffAdvisories: null };
      toast(failure.message);
    } finally {
      if (staffAdviceRead === pending) { staffAdviceRead = null; if (tickets.live(ticket, contextKey())) render(); }
    }
  }

  /* ---------- загрузка: билет контекста проверяется до любого присваивания ---------- */
  async function loadScreen({ refresh = false } = {}) {
    if (!bridge) return;
    if (managerHome()) { await readManagerAttention(); return; }
    const key = contextKey(), ticket = tickets.take(key);
    const frame = frameById(state.frameId);
    const type = screenType(frame), role = state.role, c = caps();
    const order = paramRef('order'), chat = paramRef('chat');
    const next = {};
    let error = '', ownSiteChatHead = null, missingLegacyRead = false;
    try {
      if (clientOrderSurface(frame)) {
        const binding = clientOrderBinding();
        if (!c['customer.chat']) next.clientOrderAccess = { binding, threads: [], nextBefore: null, unavailable: true };
        else {
          try { next.clientOrderAccess = { binding, ...clientOrderPage(await bridge.call('customer.chat.threads.page', { body: { limit: 30 } })), unavailable: false }; }
          catch (failure) {
            if (failure.status === 401 || failure.code === 'SESSION_ENDED') throw failure;
            next.clientOrderAccess = { binding, threads: [], nextBefore: null, unavailable: true };
          }
        }
      }
      if (type === 'orders' || (type === 'detail' && order && (order.ns === 'crm-order' || order.ns === 'crm-inquiry') && role === 'client')) {
        if (c['portal.staff'] || c['portal.customer']) next.bootstrap = await bridge.call('portal.bootstrap');
        if (role !== 'client' && c['native.orders']) next.native = await bridge.call('native.orders.list', { query: { limit: 50 } });
      }
      if (type === 'detail' && order) {
        if (order.ns === 'crm-order' && (role === 'client' ? c['portal.customer'] : c['portal.staff'])) next.detail = B.parseCrmOrder(await bridge.call('portal.order.detail', { ref: order }), order);
        if (order.ns === 'native-order' && c['native.orders']) {
          const list = await bridge.call('native.orders.list', { query: { limit: 50 } });
          next.native = list;
          let row = Array.isArray(list.orders) ? list.orders.find((o) => o.id === order.id) : null;
          if (!row) { const exact = await bridge.call('native.order.read', { ref: order }); row = exact && exact.order && exact.order.id === order.id ? exact.order : null; }
          next.detail = row ? { native: row } : { missing: true };
          if (row) next.links = B.parseOrderLinks(await bridge.call('native.order.dialog', { ref: order }));
        }
      }
      if (type === 'chat') {
        if (role === 'client' && c['customer.chat']) {
          const data = await bridge.call('customer.chat.threads', { body: {} });
          const page = ownThreadPage(data), own = page.threads;
          next.clientThreads = own;
          next.clientThreadsBefore = page.nextBefore;
          if (!refresh && order && order.ns === 'crm-order' && c['portal.customer']) next.detail = B.parseCrmOrder(await bridge.call('portal.order.detail', { ref: order }), order);
          const known = refresh ? state.detail : next.detail;
          // Выбор: явно выбранный typed thread из своих; иначе — только подтверждённая связь siteOrderId → thread.orderId. Никакого «первого».
          // Ссылка на native-заявку: явная (квитанция/карточка заявки) или siteOrderId CRM-заказа, если backend его отдаёт.
          const siteParam = paramRef('site', 'native-order');
          const site = siteParam || (known && typeof known.siteOrderId === 'number' ? B.makeRef('native-order', known.siteOrderId) : null);
          // Явный старый thread проверяет сервер; связь с заявкой проверяем по его подтверждённому orderId.
          let picked = chat && chat.ns === 'thread' ? null : site ? own.find((t) => t.orderRef && B.sameRef(t.orderRef, site)) : null;
          let conversation = null;
          if (chat && chat.ns === 'thread') {
            if (preview) {
              // Existing synthetic mock has a single-thread DTO, not a production conversation proof.
              picked = own.find((t) => B.sameRef(t.ref, chat) && (!site || B.sameRef(t.orderRef, site))) || null;
            } else {
              // The server validates this exact grant, including old seeds beyond the first list page.
              const proven = conversationPage(await readConversation(chat), chat), orderId = proven.seedThread.orderId;
              if (!site || orderId === site.id) {
                picked = { ref: chat, orderRef: orderId === null ? null : B.makeRef('native-order', orderId) }; conversation = proven;
                if (!own.some((t) => B.sameRef(t.ref, chat))) own.push(picked);
              }
            }
          }
          next.clientThreadMismatch = Boolean(chat && chat.ns === 'thread' && !picked);
          next.clientThread = picked ? picked.ref : null;
          next.clientThreadLinked = Boolean(picked && site && picked.orderRef && B.sameRef(picked.orderRef, site));
          next.chat = picked ? preview ? conversation || await bridge.call('customer.chat.messages', { body: { threadId: picked.ref.id } }) : mergeConversation(state.chat, conversation || conversationPage(await readConversation(picked.ref), picked.ref)) : null;
        } else if (chat && (chat.ns === 'legacy' || chat.ns === 'thread')) {
          if (chat.ns === 'legacy') {
            try { next.chat = await bridge.call('legacy.read', { ref: chat }); }
            catch (failure) { missingLegacyRead = failure?.status === 404 || failure?.status === 410; throw failure; }
          } else next.chat = preview ? await bridge.call('thread.read', { ref: chat }) : mergeConversation(state.chat, conversationPage(await readConversation(chat), chat));
          if (!tickets.live(ticket, key)) return;
          next.legacyOrder = null;
          if (activeCompany === 'palitra-love' && chat.ns === 'legacy' && order && order.ns === 'native-order' && c['native.orders']) {
            if (trustedManagerLegacy(order, chat)) next.legacyOrder = order;
            else {
              const links = B.parseOrderLinks(await bridge.call('native.order.dialog', { ref: order }));
              if (!links.error && B.sameRef(links.legacy, chat)) next.legacyOrder = order;
            }
            if (next.legacyOrder) {
              try {
                const exact = await bridge.call('native.order.read', { ref: order });
                if (!tickets.live(ticket, key)) return;
                if (exact?.order?.id === order.id) next.chat = { ...next.chat, nativeOrder: exact.order };
              } catch (failure) {
                if (failure.status === 401 || failure.status === 403 || failure.code === 'SESSION_ENDED') throw Object.assign(new Error(failure.message || 'Доступ к заявке изменился'), { status: failure.status, code: 'SESSION_ENDED', space: 'cabinet' });
              }
            }
          }
          if (chat.ns === 'thread') {
            // A name belongs to this fresh canonical thread/order pair, never an order URL parameter or old card cache.
            next.chat = { ...next.chat, clientName: '' };
            const nativeThread = next.chat.thread;
            const nativeId = nativeThread && typeof nativeThread.orderId === 'number' ? B.parsePositiveId(nativeThread.orderId) : null;
            if (nativeThread && nativeThread.id === chat.id && nativeId !== null) {
              try {
                const exact = await bridge.call('native.order.read', { ref: B.makeRef('native-order', nativeId) });
                if (!tickets.live(ticket, key)) return;
                const name = exact && exact.order && exact.order.id === nativeId ? exact.order.name : null;
                if (exact?.order?.id === nativeId) next.chat.nativeOrder = exact.order;
                if (typeof name === 'string' && name.trim() && name.length <= 200 && !/[\x00-\x1f\x7f]/.test(name)) next.chat.clientName = name.trim();
              } catch (failure) {
                if (failure.status === 401 || failure.status === 403 || failure.code === 'SESSION_ENDED') throw Object.assign(new Error(failure.message || 'Доступ к чату изменился'), { status: failure.status, code: 'SESSION_ENDED', space: 'cabinet' });
                // Missing/unavailable name does not block an otherwise authorized chat. No stale name fallback.
              }
            }
          }
        }
      }
      if (type === 'chat-list' && role !== 'client' && c['native.orders']) {
        if (refresh && (siteChatHeadRead || moreSiteChats)) return;
        ownSiteChatHead = {}; siteChatHeadRead = ownSiteChatHead;
        if (!refresh) { moreSiteChats = null; render(); }
        const page = staffCompanyChatPage(await bridge.call(companyChatListOperation(), { query: { limit: 30 } }));
        if (siteChatHeadRead !== ownSiteChatHead) return;
        const merged = refresh ? mergeStaffThreadHead(state.siteChatThreads, state.siteChatThreadsBefore, page) : page;
        next.siteChatThreads = merged.threads; next.siteChatThreadsBefore = merged.nextBefore;
      }
      if (type === 'reports' && activeCompany === 'palitra-love') {
        if (c['cabinet.summary']) { const range = currentReportRange(); next.crmReport = B.parseCrmSummary(await bridge.call('cabinet.crm.summary', { query: range }), range); }
        else if (c['portal.summary']) next.summary = await bridge.call('portal.summary');
      }
    } catch (failure) {
      if (!tickets.live(ticket, key)) return;   // поздняя ошибка прежнего экрана не показывается
      if (failure.status === 401 || failure.code === 'SESSION_ENDED' || (failure.status === 403 && (type === 'chat' || type === 'chat-list'))) { endSession(type === 'chat-list' ? 'cabinet' : failure.space || spaceOf(type, order, chat), failure.message); return; }
      if (!preview && type === 'chat' && (chat?.ns === 'legacy' ? missingLegacyRead : (!chat || chat.ns === 'thread') && conversationScopeFailure(failure))) {
        if (tickets.accept(ticket, 'chat')) invalidateConversation(chat && ['thread','legacy'].includes(chat.ns) ? chat : state.clientThread, failure.message);
        return;
      }
      error = failure.message;
      if (failure.code === 'STAFF_ADVISORIES_INVALID' && type === 'chat' && state.chat) next.chat = { ...state.chat, staffAdvisories: null };
      if (failure.status === 404 && type === 'detail') next.detail = { missing: true };
    }
    if (!tickets.live(ticket, key)) return;     // поздний ответ A после перехода к B — не применяется и не рисуется
    if (ownSiteChatHead && siteChatHeadRead === ownSiteChatHead) siteChatHeadRead = null;
    if (type === 'chat' && Object.prototype.hasOwnProperty.call(next, 'chat')) { next.chatBlocked = null; staffAdviceRead = null; }
    if (type === 'reports') { next.reportLoading = false; if (error) { next.crmReport = null; next.summary = null; } }
    for (const [field, value] of Object.entries({ ...next, error })) if (tickets.accept(ticket, field)) { if (field === 'clientOrderAccess') clientOrderAccess = value; else state[field] = value; }
    if (activeCompany === 'palitra-love' && !error && type === 'detail' && role !== 'client' && order && order.ns === 'native-order' && state.params.details !== '1' && next.detail && next.detail.native && next.links && !next.links.error) {
      const target = mobileFrame(role, 'chat'), linked = next.links.thread || next.links.legacy;
      if (linked && target && target.hidden !== true && screenAllowed(target)) { open(target.id, { chat: B.refKey(linked), order: B.refKey(order) }, { replace: true }); return; }
    }
    render();
    if (managerAllowed()) void orderReads.read(); // Read-only counter refresh never marks a conversation read.
    scheduleChatRefresh();   // один управляемый таймер на открытый чат (только native-host с chatAutoRefresh)
  }

  /* ---------- перечитывание открытой переписки ----------
     Повтор загрузки — только при ошибке. Автоматически — раз в 5 с, только если доверенный native-host явно
     выдал chatAutoRefresh (network && e1Native), открыт чат, страница видима. Один таймер на контекст чата: переход,
     смена/отзыв identity и скрытие страницы его снимают. Только существующие чтения (threads/messages, thread.read,
     legacy.read) через тот же loadScreen с билетами; заявок и сообщений не отправляет. Это не бизнес-таймер 300 с. */
  const CHAT_REFRESH_MS = 5000;
  const autoChatRefresh = !preview && Boolean(HOST && HOST.mode === 'native' && HOST.chatAutoRefresh === true);
  let chatTimer = null, chatRefreshing = false, composing = false, lastChatInput = 0;
  function chatOpenNow() {
    if (blockedConversation()) return false;
    if (!bridge || !state.role || screenType(frameById(state.frameId)) !== 'chat') return false;
    if (state.role === 'client') return Boolean(caps()['customer.chat'] && state.clientThread);
    const ref = paramRef('chat');
    return Boolean(ref && (ref.ns === 'thread' || ref.ns === 'legacy') && caps()['native.orders']);
  }
  function readRefreshOpenNow() {
    if (managerHome()) return true;
    if (chatOpenNow()) return true;
    if (!bridge || !state.role || state.role === 'client' || !caps()['native.orders']) return false;
    const type = screenType(frameById(state.frameId)), ref = paramRef('order');
    return type === 'orders' || type === 'chat-list' || (type === 'detail' && ref && ref.ns === 'native-order');
  }
  function stopChatRefresh() { if (chatTimer) clearTimeout(chatTimer); chatTimer = null; }
  // Идёт набор (IME или ввод в поле чата только что): опрос откладывается, поле не пересоздаётся посреди набора.
  const typingNow = () => composing || (document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('chat__input') && Date.now() - lastChatInput < 1500);
  function scheduleChatRefresh() {
    stopChatRefresh();
    const attentionRefresh = managerHome() && !preview && HOST?.mode === 'native' && typeof HOST.managerAttention?.read === 'function';
    if ((!autoChatRefresh && !attentionRefresh) || document.hidden || contentTasksOverlay || !readRefreshOpenNow()) return;
    const key = contextKey();
    chatTimer = setTimeout(() => {
      chatTimer = null;
      if (key !== contextKey() || document.hidden || contentTasksOverlay || !readRefreshOpenNow()) return;
      if (managerHome() && managerAttention.loading) { scheduleChatRefresh(); return; }
      if (screenType(frameById(state.frameId)) === 'chat-list' && (siteChatHeadRead || moreSiteChats)) { scheduleChatRefresh(); return; }
      const active = document.activeElement;
      if (typingNow() || (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) && (screenType(frameById(state.frameId)) !== 'chat' || active.closest('[data-workflow-order]')))) { scheduleChatRefresh(); return; }
      loadScreen({ refresh: true });
    }, managerHome() ? 15000 : CHAT_REFRESH_MS);
  }
  async function refreshChat() {
    if (chatRefreshing || (!chatOpenNow() && !blockedConversation() && !(state.error && state.role && screenType(frameById(state.frameId)) === 'chat'))) return;
    chatRefreshing = true; render();
    try { await loadScreen({ refresh: true }); } finally { chatRefreshing = false; render(); }
  }
  document.addEventListener('visibilitychange', () => {
    if (contentTasksOverlay) { stopChatRefresh(); if (managerHome()) abortManagerRead(); return; }
    if (document.hidden) { stopChatRefresh(); if (managerHome()) abortManagerRead(); }
    else if (managerHome()) { if (!managerAttention.loading) void readManagerAttention(); }
    else if (clientOrderSurface(frameById(state.frameId))) { clientOrderAccess = null; render(); void loadScreen(); }
    else scheduleChatRefresh();
  });
  function resumeVisibleReads() {
    scheduleChatGeometry();
    if (contentTasksOverlay) return;
    if (responseReportAllowed() && screenType(frameById(state.frameId)) === 'reports') { disposeResponseReport(); render(); }
    if (contentTasksAllowed() && screenType(frameById(state.frameId)) === 'content-tasks') { disposeContentTasks(); render(); }
    if (managerHome() && !document.hidden && !managerAttention.loading) void readManagerAttention();
    else if (!document.hidden && clientOrderSurface(frameById(state.frameId))) { clientOrderAccess = null; render(); void loadScreen(); }
    else scheduleChatRefresh();
    salonReportView?.refresh();
  }
  const spaceOf = (type, order, chat) => (state.role === 'client' && type === 'chat' ? 'account' : type === 'reports' && caps()['cabinet.summary'] ? 'cabinet' : chat ? 'cabinet' : order && order.ns === 'native-order' ? 'cabinet' : 'portal');
  function screenType(frame) {
    if (!frame) return '';
    if (frame.id === 'A10') return 'workflow';
    if (frame.id === WIDGET_SETTINGS_FRAME) return 'widget-settings';
    if (frame.kind === 'orders' || frame.kind === 'history') return 'orders';
    if (frame.kind === 'editor') return /фото/i.test(frame.title) || frame.id.endsWith('06') ? 'photos' : 'catalog';
    return frame.kind || 'generic';
  }

  /* Chat geometry follows the visible viewport without rebuilding the composer or its files. */
  const chatScroll = new Map(), chatFollowNext = new Set(), chatPrepend = new Map();
  let chatGeometryFrame = 0, chatGeometryObserver = null;
  function rememberChatScroll(list) {
    if (!list || !list.dataset.draft || chatFollowNext.has(list.dataset.draft)) return;
    chatScroll.set(list.dataset.draft, { top: list.scrollTop, bottom: list.scrollHeight - list.clientHeight - list.scrollTop < 48 });
  }
  function followOwnMessage(draft) { chatFollowNext.add(draft); chatScroll.set(draft, { top: 0, bottom: true }); }
  function placeChatOrderPanel(chat) {
    const panel = ui.body.querySelector('[data-workflow-order]'), top = chat && chat.querySelector('.chat__top');
    if (!panel || !top) return;
    const wide = typeof window.matchMedia === 'function' ? window.matchMedia('(min-width:1024px)').matches : window.innerWidth >= 1024;
    // Keep the same workflow controls. On a phone, all context shares one bounded header scroller.
    const parent = wide && !panel.classList.contains('workflow--compact') ? ui.body : top;
    if (panel.parentNode !== parent) parent.insertBefore(panel, parent === ui.body ? chat : panel.classList.contains('workflow--compact') ? top.querySelector('.chat__head')?.nextSibling || null : top.querySelector('.chat__head'));
  }
  function scheduleChatGeometry() {
    if (chatGeometryFrame) return;
    chatGeometryFrame = requestAnimationFrame(() => {
      chatGeometryFrame = 0;
      const shell = document.querySelector('.shell'), list = ui.body.querySelector('.chat__list');
      if (!shell) return;
      const viewport = window.visualViewport, active = document.activeElement;
      const editable = active && (active.matches('textarea:not(:disabled):not([readonly]),input:not(:disabled):not([readonly]):not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=hidden]),[contenteditable=true]'));
      const inChat = list || state.role === 'client' && screenType(frameById(state.frameId)) === 'site-chat' || screenType(frameById(state.frameId)) === 'team-chat';
      // A retained keyboard-sized VisualViewport must not pin a reopened, unfocused chat to half the screen.
      // CSS owns the full dynamic viewport; only an actively edited field needs the keyboard viewport override.
      if (inChat && editable && shell.contains(active) && viewport && viewport.scale === 1 && Number.isFinite(viewport.height) && viewport.height > 0 && Number.isFinite(viewport.offsetTop) && viewport.offsetTop >= 0) {
        shell.style.setProperty('--chat-viewport-height', `${Math.round(viewport.height * 100) / 100}px`);
        shell.style.setProperty('--chat-viewport-top', `${Math.round(viewport.offsetTop * 100) / 100}px`);
      } else {
        shell.style.removeProperty('--chat-viewport-height'); shell.style.removeProperty('--chat-viewport-top');
      }
      const visibleHeight = shell.getBoundingClientRect().height || window.innerHeight;
      shell.classList.toggle('shell--chat-short', Boolean(inChat && visibleHeight > 0 && visibleHeight <= 440));
      if (list) placeChatOrderPanel(list.closest('.chat'));
      const prepend = list && chatPrepend.get(list.dataset.draft);
      if (list && prepend) { list.scrollTop = prepend.top + Math.max(0, list.scrollHeight - prepend.height); chatPrepend.delete(list.dataset.draft); rememberChatScroll(list); }
      else if (list && (!chatScroll.has(list.dataset.draft) || chatScroll.get(list.dataset.draft).bottom)) list.scrollTop = list.scrollHeight;
    });
  }
  function observeChatGeometry(chat) {
    if (chatGeometryObserver) { chatGeometryObserver.disconnect(); chatGeometryObserver = null; }
    if (!chat) return;
    if (typeof ResizeObserver === 'function') {
      chatGeometryObserver = new ResizeObserver(scheduleChatGeometry);
      for (const item of [ui.header, chat.querySelector('.chat__dock'), chat.querySelector('.chat__list'), chat.querySelector('.chat__top')]) if (item) chatGeometryObserver.observe(item);
    }
  }
  window.addEventListener('resize', scheduleChatGeometry, { passive: true });
  document.addEventListener('focusin', scheduleChatGeometry);
  document.addEventListener('focusout', scheduleChatGeometry);
  document.addEventListener('visibilitychange', scheduleChatGeometry);
  window.addEventListener('pageshow', scheduleChatGeometry);
  window.visualViewport?.addEventListener('resize', scheduleChatGeometry, { passive: true });
  window.visualViewport?.addEventListener('scroll', scheduleChatGeometry, { passive: true });

  /* ---------- отрисовка ---------- */
  function render({ fresh = false } = {}) {
    // The read-only dialog retains the exact live chat DOM, including its File input.
    if (contentTasksOverlay) {
      if (contentTasksAllowed() && contentTasksOverlay.binding === managerBinding()) return;
      disposeContentTasks();
    }
    disposeFreeLayouts();
    const active = document.activeElement;
    const focusKey = active && active.dataset ? active.dataset.focus : '';
    const caret = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const top = ui.body.scrollTop;
    const threadAnchor = top > 0 && ui.body.dataset.screenType === 'chat-list' ? [...ui.body.querySelectorAll('[data-thread]')].map(node => ({ key: node.dataset.thread, offset: node.getBoundingClientRect().top - ui.body.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom - ui.body.getBoundingClientRect().top })).find(item => item.bottom > 0) : null;
    const oldList = ui.body.querySelector('.chat__list');
    rememberChatScroll(oldList);
    workflowIdentity();
    if (attachmentUI) { attachmentUI.setIdentity({ key: actorKey(), epoch: tickets.epoch }); attachmentUI.clearViews(); }
    attachmentComposer = null;
    renderHeader();
    const frame = frameById(state.frameId);
    if (salonReportView && (screenType(frame) !== 'reports' || activeCompany === 'palitra-love' || !salonAllowed())) disposeSalonReports();
    const phone = $('phone');
    if (phone) {
      phone.dataset.role = state.role || '';
      phone.dataset.hasSlot = String(Boolean(state.role && frame && activeSlot(frame)));
      phone.classList.toggle('phone--site-chat', Boolean(frame && (state.role === 'client' && screenType(frame) === 'site-chat' || screenType(frame) === 'team-chat')));
      ui.body.dataset.screenType = screenType(frame);
      ui.body.dataset.layout = managerHome(frame) ? 'manager' : frame && state.role !== 'client' && frame.id === MENU_HOME[state.role] ? 'dashboard' : '';
      if (bridge && state.role === 'client' && frame && frame.presentation === 'celebration') phone.classList.add('phone--celebration');
      else phone.classList.remove('phone--celebration');
    }
    const content = !DESIGN ? [h('p', { class: 'app-error', text: 'Нет снимка макета.' })]
      : !bridge ? [notConnected()]
        : state.authLoading ? [h('p', { class: 'app-empty', role: 'status', 'aria-live': 'polite', text: 'Открываем Palitra Love…' })]
          : !state.role ? [h('div', { class: 'app-empty' }, h('p', { text: state.authError || 'Вход не подтверждён. Откройте приложение штатно.' }), loginLink())]
          : screen(frame);
    ui.body.replaceChildren(...content.filter(child => child !== null && child !== undefined && child !== false));
    const activeChat = ui.body.querySelector('.chat');
    ui.body.classList.toggle('app-body--chat', Boolean(activeChat));
    ui.body.classList.toggle('app-body--staff-chat', activeCompany === 'palitra-love' && Boolean(activeChat) && state.role !== 'client');
    document.querySelector('.shell')?.classList.toggle('shell--chat', Boolean(activeChat) || Boolean(frame && (state.role === 'client' && screenType(frame) === 'site-chat' || screenType(frame) === 'team-chat')));
    if (activeChat) {
      // Hints/questionnaire belong above messages; the message composer always ends the column.
      const context = h('div', { class: 'chat__context' });
      for (const child of [...ui.body.children]) {
        if (child === activeChat || child.matches('[data-onboarding-popup], [data-workflow-order]')) continue;
        context.append(child);
      }
      if (context.childElementCount) activeChat.insertBefore(context, activeChat.querySelector('.chat__list'));
      const top = h('div', { class: 'chat__top' });
      for (const child of [...activeChat.children]) if (child.matches('.chat__head, .chat__refresh, .chat__context')) top.append(child);
      activeChat.prepend(top);
      placeChatOrderPanel(activeChat);
    }
    // Reuse live status/update nodes above history; never overlay the bottom composer.
    const noticeHost = activeChat ? activeChat.querySelector('.chat__top') : document.body;
    if (ui.toast && ui.toast.parentNode !== noticeHost) {
      if (activeChat) noticeHost.prepend(ui.toast); else noticeHost.append(ui.toast);
    }
    const embeddedChat = frame && activeSlot(frame) && ['site-chat', 'team-chat'].includes(screenType(frame));
    if (embeddedChat) {
      const host = ensureFrameHost();
      let updateHost = host.querySelector('.frame-update-host');
      if (!updateHost) { updateHost = h('div', { class: 'frame-update-host' }); host.prepend(updateHost); }
      sessionUpdateOffer?.place(updateHost);
    } else sessionUpdateOffer?.place(activeChat ? noticeHost : ui.body, activeChat ? ui.toast.nextSibling : ui.body.firstChild);
    observeChatGeometry(activeChat);
    mountFreeLayouts();
    showFrame(state.role && frame ? activeSlot(frame) : null);
    ui.overlay.replaceChildren(state.menuOpen ? roleMenu() : '', state.works ? worksSheet() : '', state.installOpen ? installSheet() : '');
    renderDesktopNav();
    renderCompanyNav();
    if (!fresh) ui.body.scrollTop = top;
    if (!fresh && threadAnchor && ui.body.dataset.screenType === 'chat-list') {
      const anchor = [...ui.body.querySelectorAll('[data-thread]')].find(node => node.dataset.thread === threadAnchor.key);
      if (anchor) ui.body.scrollTop += anchor.getBoundingClientRect().top - ui.body.getBoundingClientRect().top - threadAnchor.offset;
    }
    const newList = ui.body.querySelector('.chat__list');
    if (newList) {
      const saved = chatScroll.get(newList.dataset.draft);
      newList.scrollTop = !saved || saved.bottom || chatFollowNext.has(newList.dataset.draft) ? newList.scrollHeight : saved.top;
      chatFollowNext.delete(newList.dataset.draft);
    }
    if (newList) { const input = ui.body.querySelector('.chat__input'); if (input) sizeChatInput(input); }
    scheduleChatGeometry();
    scheduleShownOrderRead();
    window.PalitraHelp?.scan(ui.body);
    sessionUpdateObserver?.refreshSafety();
    if (focusKey) {
      const el = ui.body.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`);
      if (el) { el.focus(); if (caret && typeof el.setSelectionRange === 'function') { try { el.setSelectionRange(caret[0], caret[1]); } catch (_) { /* поле без выделения */ } } }
    }
  }
  // Вход кабинета и покупателя раздельный: origin/entry подтверждает host, права — только backend.
  const loginLink = () => {
    const cabinetEntry = !preview && HOST && HOST.mode === 'native' && HOST.verified === true &&
      HOST.origin === B.ORIGINS.synapse && window.location.origin === B.ORIGINS.synapse && document.documentElement.dataset.entry === 'cabinet';
    return h('a', { class: 'app-btn app-btn--ghost',
      href: cabinetEntry ? `${B.ORIGINS.synapse}/cabinet.html?next=%2Fcabinet%2Fpalitra-orders%2Fcabinet.html` : `${B.ORIGINS.shop}/account/login?next=%2Flove-app%2Fshop.html`,
      target: cabinetEntry ? '_self' : '_blank', rel: 'noopener noreferrer',
      text: cabinetEntry ? 'Войти в Синапс' : 'Войти или зарегистрироваться на сайте Palitra Love ↗' });
  };
  function notConnected() {
    return h('section', { class: 'card' }, h('h2', { class: 'text__title', text: 'Подключение не настроено' }),
      h('p', { text: 'Откройте приложение по рабочей ссылке Palitra Love. Если оно не загружается, попробуйте обновить страницу позже.' }));
  }
  function renderHeader() {
    const person = auth.cabinet && (auth.cabinet.displayName || auth.cabinet.name || auth.cabinet.login) || auth.portal && auth.portal.name || '';
    const frame = frameById(state.frameId);
    // replaceChildren converts null to a visible text node; filter optional header children first.
    ui.header.replaceChildren(...[
      h('button', { type: 'button', class: 'app-burger', 'aria-label': 'Меню', 'aria-expanded': String(state.menuOpen), onclick: toggleMenu }, h('span'), h('span'), h('span')),
      h('button', { type: 'button', class: 'app-back', 'aria-label': 'Назад', title: 'Назад', hidden: !canGoBack(), onclick: goBack }, icon('M15 5l-7 7 7 7', 22)),
      h('span', { class: 'app-title', text: multiCompany && auth.cabinet ? Companies.profile(activeCompany)?.name || 'Компании' : DESIGN ? str(DESIGN.appTitle) || 'Palitra Love заказы' : 'Palitra Love заказы' }),
      state.role && frame ? h('span', { class: 'app-page-title', text: managerHome(frame) ? 'Заказы' : str(frame.title) }) : null,
      state.role ? h('span', { class: 'app-identity' }, person ? h('strong', { text: str(person) }) : null, h('span', { text: ROLE_LABEL[state.role] || '' })) : null,
      preview ? h('span', { class: 'app-mode', title: 'Синтетические данные, без сети', text: 'Предпросмотр' }) : null].filter((child) => child !== null && child !== undefined && child !== false));
  }
  // Desktop uses the same current role menu and handlers; a new sidebar grants no extra access.
  function renderDesktopNav() {
    const phone = $('phone');
    if (!phone) return;
    let sidebar = $('desktop-nav');
    if (!sidebar) { sidebar = h('nav', { id: 'desktop-nav', class: 'app-sidebar', 'aria-label': 'Основная навигация' }); phone.append(sidebar); }
    sidebar.hidden = !state.role;
    if (!state.role) { sidebar.replaceChildren(); return; }
    const panel = roleMenu().querySelector('.app-menu__panel');
    for (const button of panel.querySelectorAll('.is-current')) button.setAttribute('aria-current', 'page');
    sidebar.replaceChildren(panel);
  }
  function capabilityList() {
    const c = caps();
    const rows = [['Заявки с сайта (native)', c['native.orders']], ['Чат сайта E/R1', c['native.threads'] === 'accepted-local' ? 'принят локально, native0' : c['native.threads']],
      ['CRM (сотрудник)', c['portal.staff']], ['CRM (покупатель)', c['portal.customer']], ['Отчёты собственника', c['portal.summary']],
      ['Редактор каталога', c['editor.catalog']], ['Редактор фото', c['editor.photos'] === 'delegated' ? 'проверит сам редактор' : c['editor.photos']],
      ['Чат покупателя', c['customer.chat'] ? (preview ? 'предпросмотр (native0)' : true) : false], ['Напоминание через 5 мин', 'серверная связка не подключена']];
    return h('ul', { class: 'caps' }, rows.map(([label, value]) => h('li', { class: `caps__item${value === true ? ' is-on' : value ? ' is-partial' : ''}` },
      h('span', { text: label }), h('span', { class: 'caps__state', text: value === true ? 'подключено' : value ? String(value) : 'не подключено' }))));
  }
  // Какому праву backend соответствует экран: пункт меню не даёт доступа, а только ведёт на экран.
  function screenAllowed(frame) {
    const c = caps(), type = screenType(frame), staff = state.role !== 'client';
    if (type === 'client-current-orders' || type === 'orders' && activeCompany === 'palitra-love' && !staff) return state.role === 'client' && activeCompany === 'palitra-love';
    if (type === 'site-tools' || type === 'app-settings') return activeCompany === 'palitra-love' && staff && Boolean(auth.cabinet?.member);
    if (type === 'content-tasks') return contentTasksAllowed();
    if (type === 'workflow') return workflowSettingsAllowed();
    if (type === 'widget-settings') return activeCompany === 'palitra-love' && Boolean(workflow && workflow.isOwner());
    if (type === 'site-chat') return !staff && c['customer.chat'] === true;
    if (type === 'team-chat') return teamChatAllowed();
    if (type === 'chat-list') return staff && Boolean(c['native.orders']);
    if (type === 'photos') return Boolean(c['editor.photos']);
    if (type === 'catalog') return Boolean(c['editor.catalog']);
    if (type === 'reports') return activeCompany !== 'palitra-love' ? salonAllowed() : responseReportAllowed() || c['cabinet.summary'] === true || c['portal.summary'] === true;
    if (type === 'orders' || type === 'detail') return staff ? Boolean(c['native.orders'] || c['portal.staff']) : c['portal.customer'] === true;
    if (type === 'chat') return staff ? Boolean(c['native.orders']) : c['customer.chat'] === true;
    return true;
  }
  function roleMenu() {
    const role = state.role;
    const { menu } = role ? effectiveMenu(role) : { menu: null };
    const items = role ? visibleMenuItems(role) : [];
    const orders = role ? ordersFrames(role) : {};
    // Пустая строка названия/пункта сохраняется как есть; отсутствующее название — подпись роли.
    const title = menu && typeof menu.title === 'string' ? menu.title : role ? MENU_TITLE[role] : 'Нет входа';
    return h('div', { class: 'app-menu', role: 'dialog', 'aria-label': 'Меню', dataset: { menu: menu ? str(menu.id) : '' } },
      h('div', { class: 'app-menu__panel' },
        applyStyle(styleOf(menu, 'title'), h('p', { class: 'app-menu__role', text: title })),
        items.map((item) => {
          const target = item.target, frame = frameById(target);
          const current = target === state.frameId || (orders.active && target === orders.active.id && orders.history && state.frameId === orders.history.id);
          const allowed = screenAllowed(frame);
          return applyStyle(styleOf(item, 'label'), h('button', { type: 'button', class: `app-menu__item${current ? ' is-current' : ''}${allowed ? '' : ' is-locked'}`, dataset: { menuItem: item.id },
            disabled: !allowed, 'aria-disabled': allowed ? null : 'true', title: allowed ? null : 'Нет подтверждённого доступа',
            onclick: (event) => { if (!allowed) return; if (screenType(frame) === 'content-tasks') { showContentTasks(event.currentTarget); return; } if (target === CLIENT_ORDER_CHAT_FRAME) { state.menuOpen = false; openCurrentClientChat(); return; } state.menuOpen = false; open(target); } },
          h('span', { class: 'app-menu__label', text: typeof item.label === 'string' ? item.label : '' }), allowed ? (state.role === 'client' && activeCompany === 'palitra-love' ? null : countBadge(target)) : h('span', { class: 'app-menu__lock', text: state.role === 'client' && !auth.portal ? 'нужен вход' : 'нет доступа' })));
        }),
        role === 'client' && activeCompany !== 'palitra-love' && caps()['customer.chat'] && !items.some(item => item.target === SITE_CHAT_FRAME)
          ? h('button', { type: 'button', class: 'app-menu__item', onclick: () => open(SITE_CHAT_FRAME) }, 'Чат') : null,
        activeCompany !== 'palitra-love' && role !== 'client' && caps()['native.orders'] && !items.some(item => item.target === STAFF_CHAT_FRAMES[role])
          ? h('button', { type: 'button', class: 'app-menu__item', onclick: () => open(STAFF_CHAT_FRAMES[role]) }, 'Чаты') : null,
        activeCompany !== 'palitra-love' && teamChatAllowed() ? h('button',{type:'button',class:'app-menu__item',onclick:()=>{state.menuOpen=false;open(TEAM_CHAT_FRAMES[role]);}},'Рабочий чат') : null,
        activeCompany !== 'palitra-love' && workflowSettingsAllowed() && !items.some((item) => item.target === 'A10') ? h('button', { type: 'button', class: 'app-menu__item', onclick: () => { state.menuOpen = false; open('A10'); } }, 'Настройки') : null,
        activeCompany !== 'palitra-love' && workflow && workflow.isOwner() && !items.some((item) => item.target === WIDGET_SETTINGS_FRAME) ? h('button', { type: 'button', class: 'app-menu__item', onclick: () => { state.menuOpen = false; open(WIDGET_SETTINGS_FRAME); } }, 'Чат на сайте') : null,
        workflow && (activeCompany !== 'palitra-love' || role === 'client') ? h('button', { type: 'button', class: 'app-menu__item', onclick: () => { state.menuOpen = false; state.installOpen = true; render(); } }, 'Установка и уведомления') : null,
        // Покупатель без входа: обычный вход/регистрация существующего сайта (не создаём аккаунт и не авторизуем по форме).
        role === 'client' && !auth.portal ? loginLink() : null,
        preview ? h('div', { class: 'app-menu__demo' }, h('p', { class: 'app-menu__demo-title', text: 'Доступ в предпросмотре' }), capabilityList(),
          preview ? [h('p', { class: 'app-menu__demo-title', text: 'Предпросмотр: набор синтетических сессий — не вход и не права' }),
            h('div', { class: 'seg', role: 'group', 'aria-label': 'Предпросмотр' }, Object.entries(HOST.service.PREVIEW).map(([id, p]) =>
              h('button', { type: 'button', class: 'seg__btn', 'aria-pressed': String(auth.preview === id), text: p.label, onclick: () => { state.menuOpen = false; signIn(id); } })))] : null) : null),
      h('button', { type: 'button', class: 'app-menu__shade', 'aria-label': 'Закрыть меню', onclick: () => { state.menuOpen = false; render(); } }));
  }
  function sectionRoute(label,id) {
    const frame=visibleFrame(id,state.role), allowed=Boolean(frame && screenAllowed(frame));
    return h('button',{type:'button',class:'app-btn app-btn--ghost',disabled:!allowed,onclick:()=>{if(allowed)open(id);}},label);
  }
  function siteToolsScreen() {
    const prefix=state.role==='admin'?'A':'S',url=safeButtonUrl(B.linkUrl('site.open'));
    return h('section',{class:'settings-tree'},h('h1',{text:'Сайт'}),url?h('a',{class:'app-btn app-btn--ghost',href:url,target:'_blank',rel:'noopener noreferrer',text:'Открыть сайт ↗'}):null,
      sectionRoute('Редактор фотографий на сайте',prefix+'06'),sectionRoute('Редактор прайса на сайте',prefix+'07'));
  }
  function appSettingsScreen() {
    return h('section',{class:'settings-tree'},h('h1',{},'Настройки ',window.PalitraHelp?.button('Настройки чата сайта и уведомлений на этом устройстве открываются отдельно. Памятка клиенту находится в настройках заказов.','О настройках')),
      workflow?.isOwner()?sectionRoute('Чат на сайте',WIDGET_SETTINGS_FRAME):null,
      workflowSettingsAllowed()?sectionRoute('Заказы: автоответ, этапы и памятка','A10'):null,
      workflow?h('details',{class:'settings-tree__section'},h('summary',{text:'Установка и уведомления'}),workflow.onboardingPanel(state.role,'login',{force:true,embedded:true})):null);
  }
  function installSheet() {
    return h('div', { class: 'app-sheet', role: 'dialog', 'aria-label': 'Установка и уведомления' },
      h('div', { class: 'app-sheet__head' }, h('strong', { text: 'Установка и уведомления' }), h('button', { type: 'button', class: 'app-sheet__close', 'aria-label': 'Закрыть', text: '×', onclick: () => { state.installOpen = false; render(); } })),
      activeCompany === 'palitra-love' && workflow ? workflow.onboardingPanel(state.role, state.role === 'client' ? 'chat' : 'login', { force: true }) : null);
  }
  function worksSheet() {
    return h('div', { class: 'app-sheet', role: 'dialog', 'aria-label': 'Наши работы' },
      h('div', { class: 'app-sheet__head' }, h('strong', { text: 'Наши работы' }), h('button', { type: 'button', class: 'app-sheet__close', 'aria-label': 'Закрыть', text: '×', onclick: () => { state.works = false; render(); } })),
      h('p', { class: 'app-sheet__note', text: 'Фото работ ведутся штатным редактором фото сайта; здесь они не копируются.' }));
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (state.menuOpen || state.works || state.installOpen)) { state.menuOpen = false; state.works = false; state.installOpen = false; render(); } });

  function screen(frame) {
    if (!frame) return [h('p', { class: 'app-empty', text: 'Экран не найден.' })];
    const out = [];
    if (state.authError) out.push(h('p', { class: 'app-error', role: 'alert', text: state.authError }));
    if (state.error) out.push(h('p', { class: 'app-error', role: 'alert', text: state.error }));
    const type = screenType(frame);
    if (type === 'chat' && state.error && !state.chat && !blockedConversation()) out.push(h('button', { type: 'button', class: 'chat__order chat__refresh chat__retry', dataset: { chatRefresh: 'retry' }, disabled: chatRefreshing, onclick: () => refreshChat(), text: chatRefreshing ? 'Загружаем…' : 'Повторить загрузку' }));
    // Мягкая подсказка после входа: настройки устройства и подписки остаются прежними.
    if (workflow && activeCompany === 'palitra-love' && ['staff', 'admin'].includes(state.role) && frame.id === MENU_HOME[state.role])
      out.push(workflow.onboardingPanel(state.role, 'login', { embedded: true }));
    if (clientHome(frame)) out.push(clientOrdersPanel());
    if (managerHome(frame)) out.push(managerWorkspace());
    else if (type === 'site-tools') out.push(siteToolsScreen());
    else if (type === 'app-settings') out.push(appSettingsScreen());
    else if (type === 'client-current-orders') out.push(clientOrdersPanel());
    else if (type === 'site-chat') { if (!caps()['customer.chat']) out.push(h('p', { class: 'app-empty', text: 'Не удалось открыть чат. Обновите страницу.' })); }
    else if (type === 'team-chat') { if(!teamChatAllowed()) out.push(h('p',{class:'app-error',text:'Нет подтверждённого доступа к рабочему чату.'})); }
    else if (type === 'chat-list') out.push(...staffThreadsScreen(frame));
    else if (type === 'workflow') {
      if (workflowSettingsAllowed()) {
        if (workflow.isOwner()) out.push(h('button', { type: 'button', class: 'app-btn app-btn--ghost', onclick: () => open(WIDGET_SETTINGS_FRAME) }, 'Чат на сайте →'), workflow.settingsPanel());
        if (typeof workflow.completionSettingsPanel === 'function') out.push(workflow.completionSettingsPanel());
      } else out.push(h('p', { class: 'hint', text: 'Нет подтверждённого доступа к настройкам.' }));
    }
    else if (type === 'widget-settings') { if (workflow && workflow.widgetSettingsPanel) out.push(workflow.widgetSettingsPanel()); else out.push(h('p', { class: 'hint', text: 'Настройки чата ещё не подключены. Обновите интерфейс.' })); }
    else if (type === 'orders') out.push(...ordersScreen(frame));
    else if (type === 'detail') out.push(...(state.role === 'client' ? clientDetail(frame) : staffDetail(frame)));
    else if (type === 'chat') out.push(...(state.role === 'client' ? clientChat(frame) : staffChat(frame)));
    else if (type === 'review') out.push(...reviewScreen(frame));
    else if (type === 'photos') out.push(...editorScreen(frame, 'editor.photos.open'));
    else if (type === 'catalog') out.push(...editorScreen(frame, 'editor.catalog.open'));
    else if (type === 'reports') out.push(...reportsScreen(frame));
    else if (type === 'content-tasks') out.push(contentTasksScreen());
    else if (type === 'website') out.push(...frame.blocks.map((b) => (b.type === 'website' ? (b.label ? h('p', { class: 'muted', text: str(b.label) }) : null) : genericBlock(b))).filter(Boolean));
    else {
      let visual = frame.blocks.map(genericBlock).filter(Boolean);
      const freelyPlaced = Boolean(freeLayoutModel(frame.freeLayout));
      if (frame.presentation === 'celebration') {
        visual.forEach(decorateCelebrationButton);
        if (typeof frame.eyebrow === 'string') visual.unshift(h('p', { class: 'celebration-eyebrow', dataset: { freeId: 'frame:eyebrow' }, text: frame.eyebrow }));
        const categories = Array.isArray(frame.categories) ? frame.categories.slice(0, 3) : [];
        const categoryNodes = categories.map((item, index) => h('button', {
          type: 'button', class: 'celebration-category', dataset: { categoryTarget: str(item.target), freeId: `frame:category:${index}` }, onclick: () => go(item.target),
        }, celebrationIcon(item.icon || ['gift', 'heart', 'star'][index]), applyStyle(styleOf(item, 'label'), h('span', { text: str(item.label) }))));
        if (categoryNodes.length) visual.push(...(freelyPlaced ? [h('div', { class: 'celebration-backdrop', 'aria-hidden': 'true', dataset: { freeId: 'frame:categories' } }), ...categoryNodes]
          : [h('div', { class: 'celebration-categories' }, categoryNodes)]));
      }
      if (freelyPlaced) {
        const scope = h('div', { class: 'frame-free-scene' }, visual);
        queueFreeLayout(scope, frame.freeLayout);
        visual = [scope];
      }
      out.push(...visual);
    }
    // Installation/settings remain available in the menu; clients are the manager's main work surface.
    return out;
  }

  // Оформление K01 меняет только представление: поля и обработчики заявки остаются существующими.
  function celebrationIcon(kind) {
    const paths = {
      gift: ['M10 18h20v15H10z', 'M8 13h24v5H8z', 'M20 13v20', 'M20 13c-8 0-10-8-5-8 4 0 5 8 5 8z', 'M20 13c8 0 10-8 5-8-4 0-5 8-5 8z'],
      heart: ['M20 32S6 23 6 14c0-8 10-10 14-3 4-7 14-5 14 3 0 9-14 18-14 18z'],
      star: ['M20 5l4 10 11 1-8 7 2 11-9-6-9 6 2-11-8-7 11-1z'],
      birthday: ['M10 31h20v-10H10z','M12 21v-6h16v6','M15 15V9m5 6V8m5 7V9','M10 26h20'],
      baby: ['M10 14h19a10 10 0 0 1-10 12h-1a10 10 0 0 1-8-12z','M20 14V7a9 9 0 0 1 9 7','M10 14H7l-3-5','M15 27v3m10-4v4','M13 32h4m6 0h4'],
      event: ['M10 18h20v15H10z','M8 13h24v5H8z','M20 13v20','M20 13c-8 0-10-8-5-8 4 0 5 8 5 8z','M20 13c8 0 10-8 5-8-4 0-5 8-5 8z'],
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of Object.entries({ class: 'celebration-category__icon', viewBox: '0 0 40 40', width: '40', height: '40', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(k, v);
    for (const d of paths[kind] || paths.star) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      for (const [k, v] of Object.entries({ d, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.15', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) p.setAttribute(k, v);
      svg.append(p);
    }
    return svg;
  }
  function decorateCelebrationButton(block) {
    const button = block.classList.contains('app-btn') ? block : block.querySelector('.helpform-toggle');
    if (!button) return;
    button.classList.add('celebration-cta');
    const oldChevron = button.querySelector('.chev');
    if (oldChevron) oldChevron.remove();
    const leading = icon(button.classList.contains('helpform-toggle') ? 'M12 3l2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4z' : 'M5 8h14l1 13H4z M8 8V6a4 4 0 0 1 8 0v2', 20);
    leading.classList.add('celebration-cta__icon');
    const arrow = icon('M4 12h16m-6-6 6 6-6 6', 20);
    arrow.classList.add('celebration-cta__arrow');
    button.replaceChildren(leading, ...button.childNodes, arrow);
  }

  /* ---------- обычные блоки макета ---------- */
  function genericBlock(block) {
    let el = null;
    if (block.type === 'hero') el = h('div', { class: 'hero' }, h('h1', { class: 'hero__title', dataset: { textField: 'title' }, text: str(block.title).trim() }),
      block.subtitle ? h('p', { class: 'hero__sub', dataset: { textField: 'subtitle' }, text: str(block.subtitle) }) : null);
    else if (block.type === 'button') el = buttonBlock(block);
    else if (block.type === 'text') el = (block.title || block.text) ? h('div', { class: 'text' }, block.title ? h('h2', { class: 'text__title', dataset: { textField: 'title' }, text: str(block.title) }) : null,
      block.text ? h('p', { class: 'text__body', dataset: { textField: 'text' }, text: str(block.text) }) : null) : null;
    else if (block.type === 'helpform') el = helpForm(block);
    else if (block.type === 'input') el = extraFormFields(block, true);
    else if (block.type === 'form') el = unboundForm(block);
    if (el) {
      el.classList.add('blk'); el.dataset.freeId = str(block.id); applyTextStyles(block, el);
      // Свободное размещение: кнопки и кнопка раскрытия формы не меньше 44 px (то же правило, что в редакторе).
      if (block.type === 'button' || block.type === 'helpform' && block.collapsible === true) el.dataset.freeMin = '44';
    }
    return el;
  }
  // Контурный кружок с количеством — у целей вида «заказы» (как в редакторе: kind === 'orders'). Число — только из counts.
  const ordersTarget = (target) => { const f = typeof target === 'string' ? frameById(target) : null; return Boolean(f && f.kind === 'orders'); };
  function countBadge(target) {
    if (managerAllowed()) return target === MENU_HOME[state.role] ? orderUnreadBadge() : null;
    if (!ordersTarget(target)) return null;
    return h('span', { class: 'notification-count', dataset: { notificationSource: 'orders.unread' }, 'aria-label': `Уведомлений по заказам: ${counts.orders}`, text: String(counts.orders) });
  }
  // Единая политика ссылок кнопки — в общем модуле (тот же код в редакторе). Без модуля ссылка не создаётся (кнопка disabled).
  function safeButtonUrl(value) {
    const policy = window.SynapseButtonLink;
    return policy && typeof policy.safeUrl === 'function' ? policy.safeUrl(value) : '';
  }
  function buttonBlock(block, onclick = null, extra = '') {
    // В принятом снимке у этой кнопки A01 цель пуста; явные переходы редактора сохраняем.
    const target = !block.target && block.id === 'A01-b-mv8glw8qa' && state.frameId === 'A01' && state.role === 'admin' && workflow && workflow.isOwner() ? 'A10' : block.target;
    const label = block.label === undefined || block.label === null ? 'Кнопка' : str(block.label);
    // Явная ссылка — только обычный переход по нажатию; специальные native-действия сохраняют переданный обработчик.
    if (!onclick && block.action === 'link') {
      const url = safeButtonUrl(block.url);
      const content = h('span', { class: 'app-btn__label', dataset: { textField: 'label' }, text: label });
      return url ? h('a', { class: `app-btn${extra}`, href: url, target: '_blank', rel: 'noopener noreferrer' }, content)
        : h('button', { type: 'button', class: `app-btn${extra}`, disabled: true, 'aria-disabled': 'true', title: 'Ссылка не задана или указана неверно. Укажите полный адрес http:// или https://.' }, content);
    }
    const badge = countBadge(target);
    return h('button', { type: 'button', class: `app-btn${extra}${badge ? ' has-notification-count' : ''}`, onclick: onclick || (() => go(target)) },
      h('span', { class: 'app-btn__label', dataset: { textField: 'label' }, text: label }), badge);
  }

  /* ---------- форма K01 → shop.request.create (kind=request) ---------- */
  function fieldDraft(block) {
    const key = `${actorKey()}#${state.frameId}#${str(block.id)}`;
    if (!fieldDrafts.has(key)) fieldDrafts.set(key, Object.create(null));
    return fieldDrafts.get(key);
  }
  function extraFormFields(block, single = false) {
    const api = window.PalitraRequestFields;
    const fields = single ? [{ id: block.id, type: block.inputType || 'text', required: block.required === true,
      ...(block.label === undefined ? {} : { label: block.label }),
      ...(block.placeholder === undefined ? {} : { placeholder: block.placeholder }),
      ...(block.options === undefined ? {} : { options: block.options }) }] : block.fields || [];
    const checked = api && api.normalizeFields(fields);
    if (!checked || !checked.ok) return h('p', { class: 'form-status is-error', role: 'status', text: 'Не удалось открыть поля формы. Проверьте их настройки в редакторе.' });
    const values = fieldDraft(block), box = h('div', { class: 'form-fields' });
    for (const field of checked.fields) {
      const id = `extra-${str(block.id)}-${field.id}`;
      const value = Object.hasOwn(values, field.id) ? values[field.id] : '';
      const save = (next) => Object.defineProperty(values, field.id, { value: next, enumerable: true, writable: true, configurable: true });
      const label = h('span', { class: 'field__label', dataset: { textField: single ? 'label' : `field:${field.id}` }, text: field.label });
      const mark = field.required ? h('span', { class: 'form-fields__required', 'aria-hidden': 'true', text: ' *' }) : null;
      const props = { id, class: 'app-input form-fields__control', required: field.required, autocomplete: 'off',
        placeholder: field.placeholder, value: typeof value === 'string' ? value : '',
        dataset: { formField: field.id, focus: id }, oninput: (event) => save(event.target.value) };
      let control;
      if (field.type === 'checkbox') {
        control = h('input', { id, type: 'checkbox', required: field.required, checked: value === true,
          dataset: { formField: field.id, focus: id }, onchange: (event) => save(event.target.checked) });
        box.append(h('div', { class: 'form-fields__field form-fields__field--checkbox' },
          h('label', { class: 'form-fields__checkbox', for: id }, control, h('span', {}, label, mark))));
        continue;
      }
      if (field.type === 'textarea') control = h('textarea', { ...props, rows: 3 });
      else if (field.type === 'select') control = h('select', { id, class: props.class, required: field.required,
        dataset: props.dataset, onchange: (event) => save(event.target.value) },
        h('option', { value: '', selected: !field.options.includes(value), text: field.placeholder || 'Выберите вариант' }),
        field.options.map((option) => h('option', { value: option, selected: value === option, text: option })));
      else control = h('input', { ...props, type: field.type, ...(field.type === 'number' ? { step: 'any' } : {}) });
      if (single) control.dataset.textField = 'placeholder';
      box.append(h('div', { class: 'form-fields__field' }, h('label', { class: 'field form-fields__label', for: id }, label, mark), control));
    }
    return box;
  }
  function unboundForm(block) {
    return h('form', { class: 'helpform custom-form', onsubmit: (event) => event.preventDefault() },
      block.title ? h('h2', { class: 'text__title', dataset: { textField: 'title' }, text: str(block.title) }) : null,
      block.subtitle ? h('p', { class: 'helpform__sub', dataset: { textField: 'subtitle' }, text: str(block.subtitle) }) : null,
      extraFormFields(block),
      h('button', { type: 'button', class: 'app-btn', disabled: true, 'aria-disabled': 'true' },
        h('span', { class: 'app-btn__label', dataset: { textField: 'submitLabel' }, text: str(block.submitLabel) })),
      h('p', { class: 'form-status', role: 'status', text: 'Отправка этой формы ещё не подключена. Введённые данные остаются на этой странице.' }));
  }
  function helpForm(block) {
    const phoneOnly = block.phoneOnly === true;
    const allowedParts = ['name', 'channel', 'contact', 'hint'];
    const partOrder = [];
    for (const part of [...(Array.isArray(block.partOrder) ? block.partOrder : []), ...allowedParts])
      if (allowedParts.includes(part) && !partOrder.includes(part)) partOrder.push(part);
    const hidden = new Set(Array.isArray(block.hiddenParts) ? block.hiddenParts.filter((part) => allowedParts.includes(part)) : []);
    if (phoneOnly) { hidden.add('channel'); hidden.add('hint'); }
    const fixedPhone = hidden.has('channel');
    const selectedChannels = fixedPhone ? FORM_CHANNELS.filter(([id]) => id === 'call')
      : Array.isArray(block.channels) ? FORM_CHANNELS.filter(([id]) => block.channels.includes(id)) : FORM_CHANNELS;
    const enabledChannels = selectedChannels.length ? selectedChannels : FORM_CHANNELS.slice(0, 1);
    if (!fixedPhone && !enabledChannels.some(([id]) => id === form.channel)) {
      const pristineChannel = form.channel === (sessionFormDefaults.get(actorKey()) || 'telegram');
      form.channel = enabledChannels[0][0];
      if (pristineChannel) sessionFormDefaults.set(actorKey(), form.channel);
    }
    const text = (key, fallback) => block[key] === undefined || block[key] === null ? fallback : str(block[key]);
    const channel = () => enabledChannels.find((c) => c[0] === (fixedPhone ? 'call' : form.channel)) || enabledChannels[0];
    const oldContactLabel = text('contactLabel', fixedPhone ? 'Номер телефона' : 'Контакт');
    const contactLabel = fixedPhone && ['Контакт', 'Ваш контакт'].includes(oldContactLabel.trim()) ? 'Номер телефона' : oldContactLabel;
    const contactPlaceholder = () => {
      const configured = block.contactPlaceholder ?? (block.contactPlaceholders && block.contactPlaceholders[channel()[0]]);
      return configured === undefined || configured === null ? channel()[3] : str(configured);
    };
    const contact = h('input', { id: 'help-contact', class: 'app-input', type: channel()[2], placeholder: contactPlaceholder(), value: form.contact, autocomplete: fixedPhone ? 'tel' : 'off', maxlength: fixedPhone ? '32' : '100',
      dataset: { focus: 'help-contact', field: 'K01-b6.contact', freeId: 'contactInput' }, oninput: (e) => { form.contact = e.target.value; } });
    const parts = {
      name: [h('label', { class: 'field', for: 'help-name', dataset: { freeId: 'nameLabel' } }, h('span', { class: 'field__label', dataset: { textField: 'nameLabel' }, text: text('nameLabel', 'Имя') })),
        h('input', { id: 'help-name', class: 'app-input', type: 'text', maxlength: '80', autocomplete: 'off', placeholder: text('namePlaceholder', ''), value: form.name, dataset: { focus: 'help-name', field: 'K01-b6.name', freeId: 'nameInput' }, oninput: (e) => { form.name = e.target.value; } })],
      channel: [h('label', { class: 'field', for: 'help-channel', dataset: { freeId: 'channelLabel' } }, h('span', { class: 'field__label', dataset: { textField: 'messengerLabel' }, text: text('messengerLabel', 'Канал связи') })),
        h('select', { id: 'help-channel', class: 'app-input', dataset: { focus: 'help-channel', field: 'K01-b6.channel', freeId: 'channelInput' }, onchange: (e) => {
          form.channel = e.target.value; const c = channel(); contact.type = c[2]; contact.placeholder = contactPlaceholder();
        } }, enabledChannels.map(([id, label]) => h('option', { value: id, selected: id === form.channel, text: label })))],
      contact: [h('label', { class: 'field', for: 'help-contact', dataset: { freeId: 'contactLabel' } }, h('span', { class: 'field__label', dataset: { textField: 'contactLabel' }, text: contactLabel })), contact],
      hint: [h('p', { class: 'helpform__hint', dataset: { textField: 'hint', freeId: 'hint' }, text: text('hint', 'Продолжим в чате. Контакт пригодится, если не сможем связаться здесь.') })],
    };
    const extrasNode = !phoneOnly && Array.isArray(block.fields) && block.fields.length ? extraFormFields(block) : null;
    if (extrasNode) extrasNode.dataset.freeId = 'extras';
    const controls = [block.title ? h('h2', { class: 'text__title', dataset: { textField: 'title', freeId: 'title' }, text: str(block.title) }) : null,
      block.subtitle ? h('p', { class: 'helpform__sub', dataset: { textField: 'subtitle', freeId: 'subtitle' }, text: str(block.subtitle) }) : null,
      partOrder.flatMap((part) => hidden.has(part) ? [] : part === 'hint' ? [extrasNode, ...parts[part]] : parts[part]),
      hidden.has('hint') ? extrasNode : null,
      h('label', { class: 'check', dataset: { freeId: 'consent' } }, h('input', { type: 'checkbox', id: 'help-consent', checked: form.consent, dataset: { focus: 'help-consent', field: 'K01-b6.consent' }, onchange: (e) => { form.consent = e.target.checked; } }),
        h('span', { text: 'Согласен(на) на обработку персональных данных для связи по заявке' })),
      h('button', { type: 'submit', class: 'app-btn', disabled: form.busy, dataset: { freeId: 'submit', freeMin: '44' } }, h('span', { class: 'app-btn__label', dataset: { textField: 'submitLabel' }, text: text('submitLabel', 'Отправить') }))];
    let formContent = controls;
    if (freeLayoutModel(block.freeLayout)) {
      formContent = h('div', { class: 'form-free-scene' }, controls);
      queueFreeLayout(formContent, block.freeLayout);
    }
    const body = h('form', { class: 'helpform', novalidate: true, dataset: { block: str(block.id) }, onsubmit: (e) => { e.preventDefault(); submitRequest(block); } }, formContent,
      h('p', { class: `form-status${form.status ? ` is-${form.status}` : ''}`, role: 'status', text: form.message }),
      form.receipt ? receiptActions(form.receipt) : null,
      form.receipt && preview ? h('p', { class: 'muted', text: 'Предпросмотр: заявка создана в памяти страницы, на сервер ничего не отправлено.' }) : null);
    if (block.collapsible !== true) return body;
    const panel = h('div', { class: 'helpform-panel', id: 'help-panel', hidden: !form.expanded }, body);
    const toggle = h('button', { type: 'button', class: 'app-btn helpform-toggle', 'aria-expanded': String(form.expanded), 'aria-controls': 'help-panel', dataset: { freeFill: '', freePart: 'toggle' },
      onclick: () => { form.expanded = !form.expanded; panel.hidden = !form.expanded; toggle.setAttribute('aria-expanded', String(form.expanded)); } },
    h('span', { class: 'helpform-toggle__label', dataset: { textField: 'toggleLabel' }, text: text('toggleLabel', 'Подобрать индивидуально') }), chevron());
    return h('div', { class: 'helpform-wrap' }, toggle, panel);
  }
  // Причина, по которой общая заявка сейчас не отправляется (или '' — можно).
  function sharedGate() {
    if (!auth.account || !B.accountRef(auth.account.opaque)) return 'Не удалось открыть сессию Palitra Love. Обновите страницу и попробуйте снова. Введённые данные сохранены в форме.';
    if (!auth.chat || !auth.chat.ready) return 'Чат сайта сейчас не готов — общая заявка с перепиской не отправляется. Данные сохранены в форме.';
    return '';
  }
  // Действия после квитанции: экран заказов и точный чат этой заявки (thread из квитанции, сверка с orderId — при открытии).
  function receiptActions(receipt) {
    const orders = ordersFrames('client').active, chat = mobileFrame('client', 'chat');
    return h('div', { class: 'ins-actions' },
      orders && caps()['portal.customer'] ? h('button', { type: 'button', class: 'app-btn app-btn--ghost', onclick: () => open(orders.id) }, 'Ваша заявка') : null,
      chat && receipt.thread ? h('button', { type: 'button', class: 'app-btn', dataset: { receiptChat: B.refKey(receipt.thread) },
        onclick: () => open(chat.id, { chat: B.refKey(receipt.thread), site: B.refKey(receipt.order) }) }, 'Чат') : null);
  }
  // Перечитать собственные данные покупателя после записи (bootstrap и чаты), без новой отправки.
  async function reread(epoch) {
    if (!bridge || epoch !== tickets.epoch) return;
    try { if (caps()['portal.customer']) { const data = await bridge.call('portal.bootstrap'); if (epoch === tickets.epoch) { tickets.commitNow('bootstrap'); state.bootstrap = data; } } } catch (_) { /* покажет экран заказов */ }
    if (epoch === tickets.epoch) render();
  }
  async function submitRequest(block = {}) {
    if (form.busy) return;
    // Тот же requestId — только для той же попытки: неизвестный исход повторяется тем же телом; изменённая форма — новая попытка.
    const fixedPhone = block.phoneOnly === true || Array.isArray(block.hiddenParts) && block.hiddenParts.includes('channel');
    const values = { name: form.name, channel: fixedPhone ? 'call' : form.channel, contact: form.contact, consent: form.consent };
    const extra = block.phoneOnly === true ? { ok: true, comment: '' }
      : window.PalitraRequestFields && window.PalitraRequestFields.validateAndFormat(block.fields || [], fieldDraft(block));
    if (!extra || !extra.ok) {
      form.status = 'error'; form.message = extra && extra.errors.length ? extra.errors.map((error) => error.message).join(' ') : 'Не удалось проверить дополнительные поля. Введённые данные сохранены.';
      render(); return;
    }
    if (extra.comment) values.comment = extra.comment;
    const previous = form.attempt;
    const candidate = B.buildShopRequest(values, { requestId: previous ? previous.body.requestId : B.newRequestId(), utm, page: '/' });
    // Черновик формы не меняется: при блокировке значения остаются в полях.
    if (!candidate.ok) { form.status = 'error'; form.message = candidate.reasons.join(' '); render(); return; }
    let attempt;
    if (previous && B.fingerprintOf(previous.body) === B.fingerprintOf(candidate.body)) attempt = previous;          // та же попытка — тот же requestId
    else if (previous && previous.unknown) { form.status = 'error'; form.message = 'Исход прошлой отправки неизвестен: сначала повторите её без изменений.'; render(); return; }
    else attempt = { body: previous ? { ...candidate.body, requestId: B.newRequestId() } : candidate.body, unknown: false };
    // Общая заявка: подтверждённая cookie/CSRF-сессия магазина (включая гостя) и готовый собственный чат сайта.
    const gate = sharedGate();
    if (gate) { form.status = 'error'; form.message = gate; render(); return; }
    form.attempt = attempt; form.busy = true; form.status = ''; form.message = 'Отправляем…'; render();
    const sessionSubmittedForm = window.PalitraSessionUpdate ? window.PalitraSessionUpdate.snapshotForm(form) : null;
    const epoch = tickets.epoch, submittedFrame = state.frameId;
    try {
      const data = await bridge.call('shop.request.create', { body: attempt.body });
      if (epoch !== tickets.epoch) return;
      let receipt;
      try { receipt = B.parseShopReceipt(data, attempt.body.requestId); }
      catch (_) { throw Object.assign(new Error('Ответ не подтвердил заявку — исход неизвестен'), { code: 'UNKNOWN_OUTCOME' }); }
      form.receipt = receipt;
      form.attempt = null; form.status = 'ok';
      sessionConfirmedForm = sessionSubmittedForm;
      form.message = receipt.chatMissing
        ? `Заявка №${receipt.order.id} записана, но сервер не подтвердил переписку к ней. Повторно не отправляем${caps()['portal.customer'] ? ' — проверьте «Ваши заказы».' : '. Менеджер видит заявку; переписка пока не подтверждена.'}`
        : `Заявка №${receipt.order.id} принята${receipt.duplicate ? ' (повтор той же заявки, без дубля)' : ''}. Переписка с менеджером — в «Чат».`;
      // Чат открываем только из подтверждённой квитанции этой заявки; навигация во время отправки не перехватывается.
      const selectedTarget = block.target ? frameById(block.target) : mobileFrame('client', 'chat');
      if (selectedTarget && selectedTarget.role === 'client' && selectedTarget.hidden !== true && state.role === 'client' && state.frameId === submittedFrame) {
        if (selectedTarget.kind === 'chat') {
          if (receipt.thread) open(selectedTarget.id, { chat: B.refKey(receipt.thread), site: B.refKey(receipt.order) });
        } else if (visibleFrame(selectedTarget.id, 'client')) open(selectedTarget.id);
      }
      reread(epoch);   // перечитать backend: список заявок и чаты — источник истины, не форма
    } catch (error) {
      if (epoch !== tickets.epoch) return;
      if (error.code === 'UNKNOWN_OUTCOME') { attempt.unknown = true; form.status = 'error'; form.message = `${error.message}. Нажмите ещё раз — уйдёт та же заявка с тем же номером запроса.`; }
      else { form.attempt = error.status === 409 ? null : attempt; form.status = 'error'; form.message = error.message; }
    } finally { if (epoch === tickets.epoch) { form.busy = false; render(); } }
  }

  /* ---------- менеджер фреймов: один iframe/placeholder на функцию ----------
     Встраивание — только same-origin Synapse для редакторов при подключённом host; каталог/сайт магазина — другой
     origin: обычная ссылка. В предпросмотре чужие страницы не загружаются, показывается placeholder. */
  /* F6: слоты живут в постоянном контейнере рядом с телом экрана (не внутри него): обычный переход меняет только
     видимость, iframe не отсоединяется и его browsing context не пересоздаётся. Смена/отзыв identity уничтожает
     контейнер и кэш — прежний редактор после смены пользователя не появляется. */
  const frameSlots = new Map();
  let frameHost = null;
  function ensureFrameHost() {
    if (frameHost && frameHost.parentNode) return frameHost;
    frameHost = h('div', { class: 'frame-host', id: 'frame-host', hidden: true });
    const phone = ui.body.parentNode;
    if (phone) phone.append(frameHost);
    return frameHost;
  }
  function destroyFrames() {
    // Выгрузить прежние редакторы (about:blank) и убрать контейнер целиком; следующий вход создаст новые.
    for (const { node } of frameSlots.values()) for (const f of node.querySelectorAll('iframe')) f.setAttribute('src', 'about:blank');
    frameSlots.clear();
    if (frameHost) { frameHost.replaceChildren(); frameHost.remove(); }
    frameHost = null;
  }
  function activeSlot(frame) {
    const type = screenType(frame), c = caps();
    if (type === 'site-chat') return state.role === 'client' && c['customer.chat'] ? 'customer.chat.open' : null;
    if (type === 'team-chat') return teamChatAllowed() ? 'team.chat.open' : null;
    if (type === 'photos') return c['editor.photos'] ? 'editor.photos.open' : null;
    if (type === 'catalog') return c['editor.catalog'] ? 'editor.catalog.open' : null;
    if (type === 'website' && blocks(frame, 'website').length) return state.role === 'client' ? 'catalog.open' : 'site.open';
    return null;
  }
  function showFrame(name) {
    if (!name && !frameHost) return;
    const host = ensureFrameHost();
    if (name && !frameSlots.has(name)) host.append(frameSlot(name));
    for (const [key, slot] of frameSlots) slot.node.hidden = key !== name;
    host.hidden = !name;
    if (name === 'customer.chat.open') deliverSiteChatEntry();
  }
  function deliverSiteChatEntry() {
    const entry = clientChatEntry, slot = frameSlots.get('customer.chat.open');
    if (!entry || entry.kind !== 'site-chat' || entry.boundary !== clientChatBoundary() || clientChatEntryKind() !== 'site-chat' || !slot || !slot.ready || !slot.frame || slot.node.hidden || document.hidden) return;
    const key = JSON.stringify([entry.boundary, entry.serial]);
    if (slot.deliveredEntry === key) return;
    try {
      const target = slot.frame.contentWindow;
      if (!target || target.location.origin !== window.location.origin) return;
      target.postMessage({ type: 'palitra:client-chat-entry' }, window.location.origin);
      slot.deliveredEntry = key;
    } catch (_) { /* A cross-origin or unready frame receives no entry signal. */ }
  }
  function frameSlot(name, caption = '') {
    if (frameSlots.has(name)) return frameSlots.get(name).node;
    const team = name === 'team.chat.open';
    const link = team ? {origin:'synapse',path:'team-chat.html?company='+encodeURIComponent(activeCompany),title:'Рабочий чат'} : B.LINKS[name];
    const url = team ? B.ORIGINS.synapse+'/cabinet/palitra-orders/'+link.path : B.linkUrl(name);
    const isChat = name === 'customer.chat.open';
    const sameOrigin = !preview && HOST && HOST.origin === B.ORIGINS[link.origin] &&
      (link.origin === 'synapse' || isChat && HOST.verified === true && document.documentElement.dataset.entry === 'shop' && document.documentElement.dataset.auth === 'site' && window.location.origin === B.ORIGINS.shop);
    let node;
    if (sameOrigin && team) {
      node=h('div',{class:'slot slot--chat slot--team',dataset:{slot:name}},h('iframe',{class:'slot__frame',title:link.title,src:link.path,referrerpolicy:'same-origin'}));
    } else if (sameOrigin && isChat) {
      // The persistent slot is hidden on navigation; never detach/recreate its browsing context or File.
      const frame = h('iframe', { class: 'slot__frame', title: link.title, src: link.path, referrerpolicy: 'same-origin', dataset: { sharedChat: 'true' } });
      frame.addEventListener('load', () => { const slot = frameSlots.get(name); if (!slot || slot.frame !== frame) return; slot.ready = true; deliverSiteChatEntry(); });
      node = h('div', { class: 'slot slot--chat', dataset: { slot: name } }, frame);
    } else if (sameOrigin) {
      const frame = h('iframe', { class: 'slot__frame', title: link.title, src: link.path, referrerpolicy: 'same-origin' });
      const fallback = h('p', { class: 'slot__fallback', hidden: true }, 'Редактор нельзя показать внутри приложения. ', h('a', { href: link.path, target: '_blank', rel: 'noopener noreferrer', text: 'Открыть в новой вкладке' }));
      frame.addEventListener('load', () => {
        let ok = false;
        try { ok = frame.contentWindow.location.origin === window.location.origin; } catch (_) { ok = false; }   // только проверка origin, DOM не читается
        fallback.hidden = ok; frame.hidden = !ok;
      });
      node = h('div', { class: 'slot', dataset: { slot: name } }, h('a', { class: 'app-btn app-btn--ghost app-btn--small', href: url, target: '_blank', rel: 'noopener noreferrer', text: 'Открыть редактор отдельно ↗' }), frame, fallback);
    } else {
      node = h('div', { class: 'slot slot--placeholder', dataset: { slot: name } },
        h('p', { class: 'slot__title', text: preview ? `${link.title} — существующий экран Synapse (в предпросмотре не загружается)` : link.title }),
        caption ? h('p', { class: 'muted', text: caption }) : null,
        h('a', { class: `app-btn app-btn--ghost${link.origin === 'synapse' ? ' app-btn--small' : ''}`, href: url, target: '_blank', rel: 'noopener noreferrer', text: link.origin === 'shop' ? 'Открыть на сайте Palitra Love ↗' : 'Открыть редактор отдельно ↗' }),
        h('p', { class: 'muted', text: link.origin === 'shop' ? 'Каталог и цены — на сайте магазина; копий товаров и фото здесь нет.' : 'Права, CSRF и сохранение — внутри штатного редактора.' }));
    }
    frameSlots.set(name, { node, link: name, ...(sameOrigin && isChat ? { frame: node.querySelector('[data-shared-chat]'), ready: false, deliveredEntry: null } : {}) });
    return node;
  }
  function editorScreen(frame, linkName) {
    const c = caps();
    const allowed = linkName === 'editor.catalog.open' ? c['editor.catalog'] : c['editor.photos'];
    const texts = blocks(frame, 'text').map(block=>activeCompany!=='palitra-love'?genericBlock(block):h('div',{class:'editor-help'},block.title?h('h2',{class:'text__title',text:block.title}):null,block.text?window.PalitraHelp?.button(block.text):null)).filter(Boolean);
    if (!allowed) return [...texts, h('p', { class: 'hint', text: 'Нет подтверждённого доступа кабинета Synapse к этому редактору.' })];
    return texts;   // сам редактор — в постоянном слоте frame-host (showFrame)
  }

  /* ---------- заказы: «Активные / История» ---------- */
  function crmOrders() { return state.bootstrap && Array.isArray(state.bootstrap.orders) ? state.bootstrap.orders.filter((o) => B.parsePositiveId(o.id) !== null) : null; }
  const FOLLOWUP_ALERT = 'Клиент не написал в чат. Свяжитесь удобным для него способом';
  function contactDue(o) { const f = o && o.nativeContactFollowup; return Boolean(caps()['native.orders'] && state.role !== 'client' && f && f.orderRef === `native-order:${o.id}` && /^thread:[1-9]\d*$/.test(f.threadRef) && f.state === 'due'); }
  function nativeOrders() { return state.native && Array.isArray(state.native.orders) ? state.native.orders.filter((o) => B.parsePositiveId(o.id) !== null) : null; }
  const crmHistory = (o) => o.status === 'done' || o.status === 'cancelled';
  const nativeHistory = (o) => ['done', 'cancelled'].includes(o.work && o.work.status);
  function ordersScreen(frame) {
    if (activeCompany === 'palitra-love' && state.role === 'client' && !caps()['portal.customer']) return [clientOrdersPanel()];
    const { active, history } = ordersFrames(state.role);
    const c = caps(), staff = state.role !== 'client';
    const tab = (group) => blocks(frame, 'button').find((b) => b.orderGroup === group);
    const detail = mobileFrame(state.role, 'detail');
    const out = [];
    for (const [group, target] of [['active', active], ['history', history]]) {
      if (!target) continue;
      const openNow = frame.id === target.id;
      const configuredLabel = (tab(group) || {}).label;
      const label = configuredLabel === undefined || configuredLabel === null ? (group === 'active' ? 'Активные' : 'История') : str(configuredLabel);
      out.push(h('button', { type: 'button', class: 'order-toggle', 'aria-expanded': String(openNow), onclick: () => { if (!openNow) open(target.id); } }, h('span', { class: 'order-toggle__label', text: label }), chevron()));
      if (!openNow) continue;
      const isHistory = group === 'history';
      const sections = [];
      const crm = crmOrders();
      if (staff ? c['portal.staff'] : c['portal.customer']) {
        const list = crm === null ? null : crm.filter((o) => crmHistory(o) === isHistory);
        sections.push(h('div', { class: 'order-section' }, staff ? h('p', { class: 'order-section__title', text: 'Заказы CRM' }) : null,
          list === null ? h('p', { class: 'app-empty', text: 'Загрузка…' }) : list.length ? list.map((o) => orderCard({
            ref: B.makeRef('crm-order', o.id), name: staff ? o.name : (auth.portal && auth.portal.name), title: `Заказ №${o.id}`, status: o.stageLabel || '', details: o.wishes, nextAction: staff ? o.nextAction : '',
          }, detail)) : h('p', { class: 'app-empty', text: isHistory ? 'Здесь появятся выполненные заказы.' : 'Активных заказов нет.' })));
      } else if (!staff) sections.push(h('p', { class: 'hint', text: 'Заказы видны после штатного входа в аккаунт магазина или через бот Palitra.' }), loginLink());
      // Собственные заявки (простая форма — CRM inquiry до оформления заказа): отдельно от заказов CRM, только из bootstrap.requests.
      if (!staff && !isHistory && c['portal.customer'] && state.bootstrap) {
        const requests = B.parsePortalRequests(state.bootstrap);
        if (requests.length) sections.unshift(h('div', { class: 'order-section' }, h('p', { class: 'order-section__title', text: 'Ваши заявки' }),
          requests.map((r) => orderCard({ ref: r.ref, name: auth.portal && auth.portal.name, title: r.site ? `Заявка №${r.site.id}` : `Обращение №${r.ref.id}`,
            status: 'Получена', details: r.site ? 'Менеджер свяжется с вами в переписке по этой заявке.' : 'Связь заявки с перепиской сервер пока не передаёт.' }, detail))));
      }
      if (staff && !isHistory && c['portal.staff'] && state.bootstrap && Array.isArray(state.bootstrap.inquiries)) {
        const inquiries = state.bootstrap.inquiries.filter((q) => q && typeof q.id === 'number' && B.parsePositiveId(q.id) !== null && q.status === 'open');
        if (inquiries.length) sections.push(h('div', { class: 'order-section' }, h('p', { class: 'order-section__title', text: 'Обращения CRM' }),
          inquiries.map((q) => {
            const site = typeof q.siteOrderId === 'number' ? B.makeRef('native-order', q.siteOrderId) : null;
            const card = { ref: B.makeRef('crm-inquiry', q.id), name: str(q.name), title: site ? `Обращение №${q.id} · заявка сайта №${site.id}` : `Обращение №${q.id}`, status: str(q.sourceLabel), details: str(q.summary) };
            // Карточка ведёт к той же native-заявке (заявки и переписка — только owner кабинета); иначе — статичная.
            return site && c['native.orders'] ? h('button', { type: 'button', class: 'order', dataset: { ref: B.refKey(card.ref) }, onclick: () => open(detail.id, { order: B.refKey(site) }) },
              orderCard(card, null, { button: false }).childNodes) : orderCard(card, null, { button: false });
          })));
      }
      if (staff) {
        if (c['native.orders']) {
          const nat = nativeOrders();
          const list = nat === null ? null : nat.filter((o) => nativeHistory(o) === isHistory);
          sections.push(h('div', { class: 'order-section' }, h('p', { class: 'order-section__title', text: `Заявки с сайта${list && list.some(contactDue) ? ' · связаться: ' + list.filter(contactDue).length : ''}` }),
            list === null ? h('p', { class: 'app-empty', text: 'Загрузка…' }) : list.length ? list.map((o) => orderCard({
              ref: B.makeRef('native-order', o.id), name: o.name, title: `Заявка сайта №${o.id}`, status: B.WORK_LABELS[o.work && o.work.status] || 'Новая', details: o.comment, nextAction: contactDue(o) ? FOLLOWUP_ALERT : null,
            }, detail)) : h('p', { class: 'app-empty', text: 'Нет заявок в этом списке.' })));
        } else sections.push(h('p', { class: 'hint', text: 'Заявки и переписка доступны участнику Palitra Love с правом просмотра CRM.' }));
        if (B.COMPANY_CODE === 'palitra-love' && !c['portal.staff']) sections.push(h('p', { class: 'hint', text: 'CRM Palitra: нет подтверждённой сессии сотрудника portal.' }));
      }
      out.push(h('div', { class: 'order-group', role: 'region', 'aria-label': label }, sections));
    }
    for (const b of blocks(frame, 'button')) { if (b.orderGroup) continue; const t = frameById(b.target); if (t && t.kind === 'detail') continue; out.push(buttonBlock(b)); }
    return out;
  }
  function orderCard(o, detail, { button = true } = {}) {
    const kids = [o.name ? h('span', { class: 'order__client', text: o.name }) : null,
      h('span', { class: 'order__head' }, h('strong', { text: o.title }), o.status ? h('span', { class: 'order__status', text: o.status }) : null),
      h('span', { class: 'order__ns', text: o.ref.ns === 'native-order' ? 'заявка с сайта' : o.ref.ns === 'crm-inquiry' ? 'заявка (до оформления заказа)' : 'заказ CRM' }),
      o.nextAction ? h('span', { class: 'order__stage', text: `Следующий шаг: ${o.nextAction}` }) : null,
      o.details ? h('span', { class: 'order__details', text: o.details }) : null,
      button ? h('span', { class: 'order__more', text: 'Открыть →' }) : null];
    return button && detail ? h('button', { type: 'button', class: 'order', dataset: { ref: B.refKey(o.ref) }, onclick: () => open(detail.id, { order: B.refKey(o.ref) }) }, kids)
      : h('div', { class: 'order order--static', dataset: { ref: B.refKey(o.ref) } }, kids);
  }

  /* ---------- заказ клиента (CRM portal customer) ---------- */
  function clientDetail(frame) {
    const inquiry = paramRef('order', 'crm-inquiry');
    if (inquiry) return clientRequestDetail(frame, inquiry);
    const ref = paramRef('order', 'crm-order');
    if (!ref) return [h('p', { class: 'app-empty', text: 'Откройте заказ из списка.' })];
    const d = state.detail;
    if (!d) return [h('p', { class: 'app-empty', text: 'Загрузка…' })];
    if (d.missing) return [h('p', { class: 'app-empty', text: 'Заказ не найден.' })];
    const chat = mobileFrame('client', 'chat');
    return frame.blocks.map((b) => {
      if (b.type === 'status') return h('section', { class: 'statuses' }, h('h2', { class: 'text__title', text: str(b.title) || 'Статус' }), h('p', { class: 'status is-active', text: d.stageLabel || '' }),
        Array.isArray(d.history) && d.history.length ? h('ul', { class: 'history' }, d.history.map((x) => h('li', { text: `${fmtDate(x.createdAt)} · ${x.label}` }))) : null);
      if (b.type === 'order') return orderCard({ ref, name: auth.portal && auth.portal.name, title: `Заказ №${ref.id}`, status: d.stageLabel, details: d.wishes }, null, { button: false });
      if (b.type === 'button') { const t = frameById(b.target); if (chat && t && t.kind === 'chat') return buttonBlock(b, () => open(chat.id, { order: B.refKey(ref) }), ' app-btn--big'); return buttonBlock(b); }
      return genericBlock(b);
    }).filter(Boolean);
  }

  function clientRequestDetail(frame, ref) {
    if (!state.bootstrap) return [h('p', { class: 'app-empty', text: 'Загрузка…' })];
    const r = B.parsePortalRequests(state.bootstrap).find((x) => B.sameRef(x.ref, ref));
    if (!r) return [h('p', { class: 'app-empty', text: 'Заявка не найдена.' })];
    const chat = mobileFrame('client', 'chat');
    return frame.blocks.map((b) => {
      if (b.type === 'status') return h('section', { class: 'statuses' }, h('h2', { class: 'text__title', text: str(b.title) || 'Статус' }), h('p', { class: 'status is-active', text: 'Заявка получена' }),
        h('p', { class: 'muted', text: 'Заказ оформит менеджер после согласования; этапы появятся здесь.' }));
      if (b.type === 'order') return orderCard({ ref, name: auth.portal && auth.portal.name, title: r.site ? `Заявка №${r.site.id}` : `Обращение №${ref.id}`, status: 'Получена', details: fmtDate(r.createdAt) }, null, { button: false });
      if (b.type === 'button') {
        const t = frameById(b.target);
        if (chat && t && t.kind === 'chat') {
          // Чат — только по ссылке на собственную native-заявку; доступ проверит E grant и совпадение thread.orderId.
          const button = buttonBlock(b, r.site ? () => open(chat.id, { order: B.refKey(ref), site: B.refKey(r.site) }) : () => {}, ' app-btn--big');
          if (!r.site) button.disabled = true;
          return h('div', { class: 'blk' }, button, r.site ? null : h('p', { class: 'muted', text: 'Связь этой заявки с перепиской сервер не передаёт — чат здесь не открывается.' }));
        }
        return buttonBlock(b);
      }
      return genericBlock(b);
    }).filter(Boolean);
  }

  /* ---------- карточка сотрудника: CRM или заявка сайта ---------- */
  function staffDetail(frame) {
    const ref = paramRef('order');
    if (!ref || (ref.ns !== 'crm-order' && ref.ns !== 'native-order')) return [h('p', { class: 'app-empty', text: 'Откройте заказ из списка заказов.' })];
    // Прямой адрес не обходит права: без подтверждённого доступа карточка не запрашивается.
    if (ref.ns === 'native-order' && !caps()['native.orders']) return [h('p', { class: 'hint', text: 'Нет подтверждённого доступа к CRM Palitra Love.' })];
    if (ref.ns === 'crm-order' && !caps()['portal.staff']) return [h('p', { class: 'hint', text: 'Карточка CRM доступна сотруднику с подтверждённой сессией portal.' })];
    const d = state.detail;
    if (!d) return [h('p', { class: 'app-empty', text: 'Загрузка…' })];
    if (d.missing) return [h('p', { class: 'app-empty', text: 'Заказ не найден.' })];
    return ref.ns === 'crm-order' ? crmDetail(frame, ref, d) : nativeDetail(frame, ref, d.native);
  }
  function directContact(channel, contact) {
    const target = B.contactLink(channel, contact);
    const label = `Связаться · ${CHANNEL_LABEL[channel] || channel}`;
    const box = h('div', { class: 'contact' }, h('p', { class: 'contact__value' }, h('span', { class: 'muted', text: `${CHANNEL_LABEL[channel] || channel}: ` }), h('span', { class: 'contact__raw', text: str(contact) })));
    if (!target) box.append(h('button', { type: 'button', class: 'app-btn app-btn--ghost', disabled: true, text: label }), h('p', { class: 'contact__hint', text: 'Контакт не распознан для ссылки — свяжитесь вручную.' }));
    else if (target.kind === 'copy') box.append(h('button', { type: 'button', class: 'app-btn app-btn--ghost', text: `${label} (копировать)`, onclick: () => (preview ? toast('Предпросмотр: контакт подготовлен к копированию') : copyText(target.text)) }));
    else box.append(h('a', { class: 'app-btn app-btn--ghost contact__btn', href: target.href, ...(target.kind === 'url' ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
      onclick: (e) => { if (preview) { e.preventDefault(); toast(`Предпросмотр: подготовлено ${target.href}`); } } }, label));
    box.append(h('p', { class: 'contact__hint', text: 'Нажатие не отмечает, что связь состоялась или клиент ответил.' }));
    return box;
  }
  function copyText(text) {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') { toast('Копирование недоступно — выделите контакт вручную.'); return; }
    navigator.clipboard.writeText(text).then(() => toast('Контакт скопирован'), () => toast('Не удалось скопировать — выделите контакт вручную.'));
  }
  function crmDetail(frame, ref, d) {
    const staffChatFrame = mobileFrame(state.role, 'chat');
    const stages = B.CRM_STAGES, index = stages.indexOf(d.stage);
    const next = index >= 0 ? stages[index + 1] : null;
    const noteKey = draftKey('note', ref);
    const out = [orderCard({ ref, name: d.name, title: `Заказ №${ref.id}`, status: d.stageLabel, details: d.wishes }, null, { button: false })];
    if (d.customer) out.push(h('section', { class: 'customer' }, h('p', { class: 'customer__title', text: 'Клиент' }), h('p', { class: 'customer__name', text: str(d.customer.name) }),
      directContact(d.customer.channel, d.customer.contact)));
    out.push(h('section', { class: 'sales' }, h('h2', { class: 'text__title', text: 'Этап заказа (сервер CRM)' }),
      h('ol', { class: 'sales__chips' }, stages.map((s, i) => h('li', { class: `sales__chip${i < index ? ' is-done' : ''}${i === index ? ' is-current' : ''}`, text: B.CRM_STAGE_LABELS[s] }))),
      d.nextAction ? h('p', { class: 'sales__hint' }, h('strong', { text: 'Что сделать: ' }), d.nextAction) : null,
      next && d.status === 'active' ? h('button', { type: 'button', class: 'app-btn', dataset: { action: 'stage-next' }, disabled: inflight.has(`stage:${draftKey('stage', ref)}`), onclick: () => crmStage(ref, d, next) }, `Перейти к этапу «${B.CRM_STAGE_LABELS[next]}»`) : null,
      h('p', { class: 'muted', text: 'Доступен только следующий этап; условия (состав, оплата, фото, дата) проверяет сервер.' })));
    out.push(h('section', { class: 'customer' }, h('label', { class: 'field', for: 'note-text' }, h('span', { class: 'field__label', text: 'Заметка к заказу' })),
      h('textarea', { id: 'note-text', class: 'app-input', rows: '2', maxlength: '2000', value: drafts.get(noteKey) || '', dataset: { focus: `note-${B.refKey(ref)}` }, oninput: (e) => { drafts.set(noteKey, e.target.value); } }),
      h('button', { type: 'button', class: 'app-btn app-btn--small app-btn--ghost', text: 'Сохранить заметку', onclick: () => crmNote(ref) }),
      Array.isArray(d.notes) && d.notes.length ? h('ul', { class: 'customer__notes' }, d.notes.map((n) => h('li', {}, h('span', { class: 'customer__note-ch', text: `${str(n.author)} · ${fmtDate(n.createdAt)}` }), h('span', { text: str(n.text) })))) : null));
    out.push(notifyCard(d));
    // Номер заказа CRM не превращается в номер заявки/диалога: чат — только по серверной связи siteOrderId.
    const site = B.makeRef('native-order', d.siteOrderId);
    for (const b of blocks(frame, 'button')) {
      const t = frameById(b.target);
      if (!(t && t.kind === 'chat')) continue;
      const detail = mobileFrame(state.role, 'detail');
      const button = buttonBlock(b, site && detail ? () => open(detail.id, { order: B.refKey(site) }) : () => {}, ' app-btn--big');
      if (!site || !caps()['native.orders'] || !staffChatFrame) button.disabled = true;
      out.push(h('div', { class: 'blk' }, button, h('p', { class: 'muted', text: site ? `Переписка — в заявке сайта №${site.id}.` : 'У заказа CRM нет связанной заявки сайта: переписка здесь не открывается.' })));
    }
    return out;
  }
  function notifyCard(d) {
    const status = d.notification && typeof d.notification.status === 'string' ? d.notification.status : 'not_configured';
    const first = d.firstReply && typeof d.firstReply === 'object' ? d.firstReply : null;
    return h('section', { class: 'notice' }, h('span', { class: 'notice__badge', text: 'Уведомления' }),
      h('p', { text: `Уведомление команды: ${status === 'not_configured' ? 'не настроено' : status}` }),
      h('p', { class: 'muted', text: first ? `Ожидание ответа клиента: до ${fmtDate(first.dueAt)} · ${str(first.state)}` : '«5 минут без сообщения клиента» — отдельная серверная связка в существующем планировщике, пока не подключена. Оболочка своего таймера не ведёт.' }));
  }
  async function crmAction(ref, body, success, lockKey) {
    if (inflight.has(lockKey)) return false;   // F2: второй клик во время await — без второго действия
    inflight.add(lockKey);
    const epoch = tickets.epoch, key = contextKey();
    let done = false;
    try {
      const pending = bridge.call('portal.order.action', { ref, body }, { order: state.detail });
      render();   // кнопка этапа недоступна, пока ждём ответ
      const data = await pending;
      if (epoch !== tickets.epoch) return false;
      const receipt = B.parseCrmAction(data, ref);   // F1: { ok, replayed, order } того же crm-order:N
      if (key === contextKey()) { tickets.commitNow('detail'); state.detail = receipt.order; }
      pendingSends.delete(lockKey);
      toast(receipt.replayed ? `${success} (повтор без дубля)` : success);
      done = true;
    } catch (error) {
      if (epoch !== tickets.epoch) return false;
      if (error.status === 401) { endSession('portal', error.message); return false; }
      if (error.code === 'UNKNOWN_OUTCOME' || error.code === 'BAD_RESPONSE') { const p = pendingSends.get(lockKey); if (p) p.unknown = true; }
      else pendingSends.delete(lockKey);
      toast(error.message);
      if (error.status === 409 && key === contextKey()) loadScreen();   // свежие данные, ввод сохраняется
    } finally { if (epoch === tickets.epoch) { inflight.delete(lockKey); render(); } }
    return done;
  }
  function crmStage(ref, d, next) {
    // Тот же requestId для той же попытки (этот заказ, version, следующий этап), пока исход не подтверждён.
    const lockKey = `stage:${draftKey('stage', ref)}`;
    const p = pendingSends.get(lockKey);
    const body = p && p.version === d.version && p.next === next ? p.body : { requestId: B.newRequestId(), action: 'stage', version: d.version, value: next };
    pendingSends.set(lockKey, { body, version: d.version, next, unknown: false });
    crmAction(ref, body, `Этап: ${B.CRM_STAGE_LABELS[next]}`, lockKey);
  }
  function crmNote(ref) {
    const key = draftKey('note', ref), text = (drafts.get(key) || '').trim();
    if (!text) { toast('Напишите заметку'); return; }
    const pendKey = `note:${key}`;
    if (inflight.has(pendKey)) return;
    const pending = pendingSends.get(pendKey);
    const body = pending && pending.text === text ? pending.body : { requestId: B.newRequestId(), action: 'note', text };
    pendingSends.set(pendKey, { text, body });
    crmAction(ref, body, 'Заметка сохранена', pendKey).then((ok) => { if (ok && state.detail && Array.isArray(state.detail.notes) && state.detail.notes.some((n) => n.text === text)) { drafts.delete(key); render(); } });
  }
  function nativeFollowupCard(f) {
    let text = 'Для этой заявки автоматическое напоминание не зарегистрировано.';
    if (f && f.notification) {
      const n = f.notification;
      if (f.state === 'answered') text = 'Клиент ответил в чате. Напоминание отменено.';
      else if (f.state === 'handled') text = 'Связь с клиентом подтверждена. Напоминание отменено.';
      else if (!n.enabled) text = 'Автоматическое напоминание через 5 минут пока выключено.';
      else if (!n.registered) text = 'Для этой заявки автоматическое напоминание не зарегистрировано.';
      else if (n.state === 'emitted') text = 'Напоминание передано в отправку. Это не подтверждает, что менеджер его увидел.';
      else if (n.state === 'stopped') text = 'Напоминание остановлено: состояние заявки или связь с клиентом изменились.';
      else if (f.state === 'due') text = 'Клиент не ответил. Напоминание ожидает доступного получателя уведомлений.';
      else text = 'Если клиент не ответит в чате, через 5 минут после формы менеджер получит напоминание.';
    }
    return h('section', { class: 'card' }, h('h3', { text: 'Напоминание о связи' }), h('p', { class: 'muted', text }));
  }
  // PALITRA_PRODUCT_VIEW_BEGIN
  function nativeProductContents(order) {
    if (activeCompany !== 'palitra-love') return null;
    const items = order && order.items;
    const unavailable = () => h('p', { class: 'app-error', text: 'Состав заявки сейчас недоступен.' });
    if (!Array.isArray(items) || items.length > 30) return unavailable();
    if (!items.length) return null;
    const asset = /^\/api\/assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,194}\.(?:avif|gif|jpe?g|png|webp)$/i;
    const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
    const seen = new Set();
    for (const item of items) {
      if (!item || !text(item.id,80) || !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(item.id) || seen.has(item.id) || !text(item.title,120) || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 20 ||
          item.price !== null && (!Number.isSafeInteger(item.price) || item.price < 0 || item.price > 10 ** 13)) return unavailable();
      seen.add(item.id);
    }
    const money = value => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 }).format(value / 100);
    return h('section', { class: 'blk', dataset: { orderProducts: String(order.id) } }, h('h3', { class: 'text__title', text: 'Состав заказа' }), items.map(item => {
      const p = item.product;
      const valid = p && p.schema === 'palitra-order-product/v1' && (p.priceVersion === null || Number.isSafeInteger(p.priceVersion) && p.priceVersion > 0) &&
        [['categoryId',80],['categoryTitle',120],['composition',1000],['description',1000],['note',300]].every(([key,max])=>text(p[key],max)) &&
        Array.isArray(p.photos) && p.photos.length <= 6 && p.photos.every(src=>typeof src === 'string' && asset.test(src));
      const rows = [h('strong', { text: `${item.title} × ${item.qty}` }), h('p', { text: item.price === null ? 'Цена уточняется' : money(item.price * item.qty) }),
        h('p', { class: 'muted', text: `Артикул: ${item.id}` })];
      if (!valid) rows.push(h('p', { class: 'muted', text: p ? 'Дополнительные сведения о товаре сейчас недоступны.' : 'Описание и фото не были сохранены при оформлении этой заявки.' }));
      else {
        if (p.categoryTitle) rows.push(h('p', { text: `Категория: ${p.categoryTitle}` }));
        if (p.composition) rows.push(h('p', { text: `Состав: ${p.composition}` }));
        if (p.description && p.description !== p.composition) rows.push(h('p', { text: p.description }));
        if (p.note) rows.push(h('p', { text: p.note }));
        rows.push(...p.photos.map((src, index) => h('a', { href: `https://palitra-love.ru${src}`, target: '_blank', rel: 'noopener noreferrer', text: `Фото ${index + 1} · ${item.title}` })));
      }
      return h('article', { class: 'card', dataset: { orderProduct: item.id }, style: 'overflow-wrap:anywhere;' }, rows);
    }));
  }
  // PALITRA_PRODUCT_VIEW_END

  function nativeDetail(frame, ref, o) {
    const links = state.links;
    const stagePanel = workflow ? workflow.orderPanel(ref.id) : null;
    const chatFrame = mobileFrame(state.role, 'chat');
    const status = o.work && o.work.status || 'new';
    const out = [orderCard({ ref, name: o.name, title: `Заявка сайта №${ref.id}`, status: B.WORK_LABELS[status], details: o.comment }, null, { button: false }),
      h('section', { class: 'customer' }, h('p', { class: 'customer__title', text: 'Клиент' }), h('p', { class: 'customer__name', text: str(o.name) }), contactDue(o) ? h('p', { class: 'hint', role: 'status', text: FOLLOWUP_ALERT }) : null, directContact(o.contactChannel, o.contact)),
      h('section', { class: 'sales' }, h('label', { class: 'field', for: 'work-status' }, h('span', { class: 'field__label', text: 'Обработка заявки' })),
        h('select', { id: 'work-status', class: 'app-input', disabled: !caps()['native.write'], dataset: { focus: 'work-status' }, onchange: (e) => nativeWork(ref, e.target.value, status) },
          B.WORK_STATUSES.map((s) => h('option', { value: s, selected: s === status, text: B.WORK_LABELS[s] }))),
        h('p', { class: 'muted', text: 'Статус обработки отделён от доставки уведомления.' }),
        Object.entries(B.CHECKLIST_ITEMS).map(([item, label]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: Boolean(o.checklist && o.checklist[item]), disabled: !caps()['native.write'], dataset: { focus: `check-${item}` },
          onchange: (e) => nativeChecklist(ref, item, e.target.checked, o.checklist ? o.checklist.revision : 0) }), h('span', { text: label }))))];
    if (links && links.error) out.push(h('p', { class: 'app-error', text: links.error }));
    const chatButtons = [];
    if (chatFrame && links && links.thread) chatButtons.push(h('button', { type: 'button', class: 'app-btn app-btn--big', dataset: { chat: B.refKey(links.thread) }, onclick: () => open(chatFrame.id, { chat: B.refKey(links.thread), order: B.refKey(ref) }) }, 'Чат клиента (сайт)'));
    if (chatFrame && links && links.legacy) chatButtons.push(h('button', { type: 'button', class: `app-btn${links.thread ? ' app-btn--ghost' : ' app-btn--big'}`, dataset: { chat: B.refKey(links.legacy) }, onclick: () => open(chatFrame.id, { chat: B.refKey(links.legacy), order: B.refKey(ref) }) }, links.thread ? 'Прежняя переписка в боте (отдельная история)' : 'Чат клиента (бот)'));
    if (links && !links.thread && !links.legacy && !links.error) chatButtons.push(h('p', { class: 'muted', text: 'У этой заявки нет переписки.' }));
    if (!links) chatButtons.push(h('p', { class: 'muted', text: 'Проверяем переписку…' }));
    if (stagePanel) out.splice(1, 0, stagePanel);
    const products = nativeProductContents(o); if (products) out.push(products);
    out.push(h('div', { class: 'blk' }, chatButtons), nativeFollowupCard(o.nativeContactFollowup));
    return out;
  }
  async function nativeWrite(name, ref, body, success) {
    if (!caps()['native.write']) { toast('Нет права изменять CRM.'); return; }
    const epoch = tickets.epoch, key = contextKey();
    try {
      await bridge.call(name, { ref, body });
      if (epoch !== tickets.epoch) return;
      toast(success);
      managerOrderChanged(ref.id);
    } catch (error) {
      if (epoch !== tickets.epoch) return;
      if (error.status === 401) { endSession('cabinet', error.message); return; }
      toast(error.message);
    }
    if (key === contextKey()) loadScreen();   // точное состояние — повторным чтением
  }
  const nativeWork = (ref, status, expected) => nativeWrite('native.order.work', ref, { status, expected }, `Статус: ${B.WORK_LABELS[status]}`);
  const nativeChecklist = (ref, item, checked, revision) => nativeWrite('native.order.checklist', ref, { item, checked, revision: Number.isSafeInteger(revision) ? revision : 0 }, 'Отметка сохранена');

  function safeThreadContact(data, threadId) {
    const contact = data && data.customerContact;
    if (!auth.cabinet || !caps()['native.orders'] || !data.thread || data.thread.id !== threadId || !contact ||
      Object.keys(contact).sort().join(',') !== 'phone,providedAt' || typeof contact.phone !== 'string' || !/^\+[1-9]\d{9,14}$/.test(contact.phone) ||
      typeof contact.providedAt !== 'string' || contact.providedAt.length > 40 || !Number.isFinite(Date.parse(contact.providedAt))) return null;
    return { phone: contact.phone, providedAt: contact.providedAt };
  }
  function companyChatListOperation() { return activeCompany === 'palitra-love' ? 'thread.list.page' : 'legacy.list.page'; }
  function staffCompanyChatPage(data, before = null) {
    if (activeCompany === 'palitra-love') return staffThreadPage(data, before);
    if (!data || !Array.isArray(data.dialogs) || data.dialogs.length > 100) throw new Error('Не удалось загрузить список переписок.');
    return staffThreadPage({ threads: data.dialogs, nextBefore: data.nextCursor }, before);
  }
  function staffThreadPage(data, before = null) {
    if (!data || !Array.isArray(data.threads) || data.threads.length > 100) throw new Error('Не удалось загрузить список чатов.');
    let last = before === null ? Infinity : before;
    const threads = data.threads.map(row => {
      if (!row || typeof row.id !== 'number' || B.parsePositiveId(row.id) === null || row.id >= last ||
        !(row.orderId === null || typeof row.orderId === 'number' && B.parsePositiveId(row.orderId) !== null) ||
        typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))) throw new Error('Не удалось проверить список чатов.');
      last = row.id;
      return { id: row.id, orderId: row.orderId, createdAt: row.createdAt, lastMessageAt: typeof row.lastMessageAt === 'string' && Number.isFinite(Date.parse(row.lastMessageAt)) ? row.lastMessageAt : null };
    });
    const cursor = data.nextBefore == null ? null : data.nextBefore;
    if (cursor !== null && (!threads.length || cursor !== threads[threads.length - 1].id)) throw new Error('Не удалось проверить продолжение списка чатов.');
    return { threads, nextBefore: cursor };
  }
  function mergeStaffThreadHead(previous, before, page) {
    if (!Array.isArray(previous) || !previous.length || page.nextBefore === null) return page;
    // The new head proves the range down to its cursor; older loaded pages stay visible.
    // Preserve the old continuation only when the new range overlaps the already read head.
    // Otherwise read the intervening gap first, without dropping the retained older rows.
    const threads = [...page.threads, ...previous.filter(row => row.id < page.nextBefore)].sort((a,b) => b.id-a.id);
    const overlaps = previous[0].id >= page.nextBefore && (before === null || page.nextBefore >= before);
    return { threads, nextBefore: overlaps ? before : page.nextBefore };
  }
  let moreSiteChats = null, siteChatHeadRead = null;
  async function loadMoreSiteChats() {
    const before = state.siteChatThreadsBefore;
    if (moreSiteChats || siteChatHeadRead || before === null || !caps()['native.orders'] || screenType(frameById(state.frameId)) !== 'chat-list') return;
    const key = contextKey(), ticket = tickets.take(key), pending = {}, priorRows = state.siteChatThreads; moreSiteChats = pending; render();
    try {
      const page = staffCompanyChatPage(await bridge.call(companyChatListOperation(), { query: { before, limit: 30 } }), before);
      if (!tickets.live(ticket, contextKey()) || moreSiteChats !== pending || siteChatHeadRead || state.siteChatThreads !== priorRows || !caps()['native.orders'] || !tickets.accept(ticket, 'siteChatThreads') || !tickets.accept(ticket, 'siteChatThreadsBefore')) return;
      const map = new Map((state.siteChatThreads || []).map(row => [row.id, row]));
      for (const row of page.threads) map.set(row.id, row);
      state.siteChatThreads = [...map.values()].sort((a,b) => b.id-a.id); state.siteChatThreadsBefore = page.nextBefore;
    } catch (failure) {
      if (!tickets.live(ticket, contextKey())) return;
      if (failure.status === 401 || failure.status === 403) { endSession('cabinet', failure.message); return; }
      toast(failure.message);
    } finally { if (moreSiteChats === pending) { moreSiteChats = null; if (tickets.live(ticket, contextKey())) render(); } }
  }
  function staffThreadsScreen(frame) {
    if (!caps()['native.orders'] || state.role === 'client') return [h('p', { class: 'app-empty', text: 'Нет доступа к чатам.' })];
    const chat = mobileFrame(state.role, 'chat'), rows = state.siteChatThreads, namespace = activeCompany === 'palitra-love' ? 'thread' : 'legacy';
    return [h('h2', { class: 'text__title', text: activeCompany === 'palitra-love' ? 'Переписки с сайта' : 'Переписки' }),
      state.error || !autoChatRefresh ? h('button', { class: 'app-btn app-btn--ghost', type: 'button', dataset: { chatListRefresh: state.error ? 'retry' : 'manual' }, disabled:Boolean(siteChatHeadRead || moreSiteChats), onclick: () => loadScreen({refresh:true}), text: state.error ? 'Повторить загрузку' : 'Обновить переписки' }) : null,
      rows === null || rows === undefined ? h('p', { class: 'app-empty', text: 'Загрузка…' }) : !rows.length ? h('p', { class: 'app-empty', text: 'Переписок пока нет.' }) :
        rows.map(row => h('button', { type: 'button', class: 'order', disabled: !chat, dataset: { thread: `${namespace}:${row.id}` },
          onclick: () => { if (chat) open(chat.id, {chat:`${namespace}:${row.id}`, ...(row.orderId === null ? {} : {order:`native-order:${row.orderId}`})}); } },
          h('strong', {text:activeCompany === 'palitra-love' ? (row.orderId === null ? `Чат сайта №${row.id}` : `Общий чат · заявка №${row.orderId}`) : (row.orderId === null ? `Переписка №${row.id}` : `Переписка · заявка №${row.orderId}`)}),
          h('span', {class:'muted',text:fmtDate(row.lastMessageAt || row.createdAt)}))),
      state.siteChatThreadsBefore != null ? h('button', {class:'app-btn app-btn--ghost',type:'button',disabled:Boolean(moreSiteChats || siteChatHeadRead),onclick:loadMoreSiteChats,text:moreSiteChats?'Загружаем…':'Более ранние переписки'}) : null].flat().filter(Boolean);
  }

  /* ---------- переписка сотрудника: legacy:N и thread:N — разные истории ---------- */
  function staffOrderContents(data, ref, order, detail, frame) {
    const contents = [], native = data.nativeOrder;
    if (native && order && native.id === order.id) {
      const products = nativeProductContents(native); if (products) contents.push(products);
      if (native.comment) contents.push(h('p', { class: 'workflow__order-comment', text: native.comment }));
      if (native.contact) contents.push(directContact(native.contactChannel, native.contact));
    } else if (order) contents.push(h('p', { class: 'muted', text: 'Сведения заявки сейчас недоступны.' }));
    const contact = ref.ns === 'thread' ? safeThreadContact(data, ref.id) : null;
    if (contact && (!native || native.contact !== contact.phone)) contents.push(h('p', {}, 'Телефон клиента: ', h('a', { href: `tel:${contact.phone}`, text: contact.phone })));
    if (order && detail) contents.push(h('button', { type: 'button', class: 'chat__order', text: `Заявка №${order.id}`, onclick: () => open(detail.id, { order: B.refKey(order), details: '1' }) }));
    const advice = ref.ns === 'thread' ? staffAdviceRows(data, ref) : [];
    if (advice.length) contents.push(h('h4', { text: 'Хью · подсказки по заявке' }), ...advice);
    contents.push(...blocks(frame, 'text').map(genericBlock));
    return contents;
  }
  function staffChat(frame) {
    const ref = paramRef('chat');
    if (!ref || (ref.ns !== 'legacy' && ref.ns !== 'thread')) return [h('p', { class: 'app-empty', text: 'Откройте переписку из карточки заявки.' })];
    if (!caps()['native.orders']) return [h('p', { class: 'hint', text: 'Нет подтверждённого доступа к переписке CRM Palitra Love.' })];
    const data = state.chat;
    const blocked = blockedConversation();
    if (blocked && B.sameRef(blocked.seed, ref)) return [blockedChatView(blocked)];
    if (!data) return [h('p', { class: 'app-empty', text: 'Загрузка…' })];
    const order = ref.ns === 'thread' ? data.thread && B.parsePositiveId(data.thread.orderId) !== null ? B.makeRef('native-order', data.thread.orderId) : null : activeCompany === 'palitra-love' ? state.legacyOrder : paramRef('order', 'native-order'), detail = mobileFrame(state.role, 'detail');
    const name = ref.ns === 'legacy' ? data.dialog && data.dialog.name : data.clientName;
    const kind = ref.ns === 'legacy' ? { max: 8000, op: 'legacy.reply', label: 'Ответ клиенту в Telegram' } : { max: 4000, op: 'thread.reply', label: 'Ответ клиенту (чат сайта)' };
    const darya = activeCompany === 'palitra-love';
    const detailsContent = () => staffOrderContents(data, ref, order, detail, frame);
    const fallbackKey = `details#${draftKey('chat', ref)}#${data.scope?.key || ''}`;
    const workflowTarget = order ? order.id : darya && ref.ns==='thread' ? `thread:${ref.id}` : null;
    const stagePanel = workflowTarget && workflow ? workflow.orderPanel(workflowTarget, { compact: darya, detailsContent: darya ? detailsContent : null }) : darya ? h('details', { class: 'workflow__details workflow__chat-only', open: chatAdviceDisclosure.get(fallbackKey) === true,
      ontoggle: event => { if (event.currentTarget.isConnected) chatAdviceDisclosure.set(fallbackKey, event.currentTarget.open); } }, h('summary', { text: order ? `Заявка №${order.id} · подробности и история` : 'Переписка · подробности и история' }), detailsContent()) : null;
    const contact = ref.ns === 'thread' ? safeThreadContact(data, ref.id) : null;
    const contactText = contact ? h('a', { href: `tel:${contact.phone}`, text: contact.phone }) : null;
    const contactPanel = contact && !darya ? h('p', { class: 'chat-customer-contact' }, 'Телефон клиента: ', contactText) : null;
    return [stagePanel, contactPanel, chatView({ name: str(name) || (ref.ns === 'thread' ? `Клиент чата №${ref.id}` : `Диалог №${ref.id}`), readOnly: !caps()['native.write'] || Boolean(B.COMPANY_CODE && B.COMPANY_CODE !== 'palitra-love'), subtitle: darya ? '' : ref.ns === 'legacy' ? (B.COMPANY_CODE && B.COMPANY_CODE !== 'palitra-love' ? 'Переписка в боте · только просмотр' : 'Переписка в боте') : preview ? 'Чат сайта · Предпросмотр' : `Общий чат клиента${order ? ` · Ответ по заявке №${order.id}` : ''}`, messages: data.messages, mine: ['operator', 'manager', 'owner'], conversation: ref.ns === 'thread' && !preview ? data : null, hideStaffAdvice: darya,
      orderButton: !darya && order && detail ? { label: `Заявка №${order.id}`, go: () => open(detail.id, { order: B.refKey(order) }) } : null,
      draft: draftKey('chat', ref), max: kind.max, placeholder: kind.label, send: () => staffReply(ref, kind), attachmentTarget: ref, uploads: data.uploads }),
    ref.ns === 'thread' && auth.e1Native !== true ? h('p', { class: 'muted', text: 'Переписка сейчас недоступна. Свяжитесь с клиентом выбранным им способом.' }) : null,
    ...(darya ? [] : blocks(frame, 'text').map(genericBlock))].filter(Boolean);
  }
  const PALITRA_CHAT_AVATAR = 'https://synapse.synapsebusiness.ru/content/publishing-assets/palitra-love/ec50ad5bcef0a3e0521fa0238cd68628.webp';
  function chatMessageAvatar(author, name) {
    if (activeCompany === 'palitra-love' && ['shop', 'operator', 'manager', 'owner'].includes(author)) {
      return h('span', { class: 'chat__avatar chat__avatar--palitra', 'aria-hidden': 'true' },
        icon('M20 21v-2a7 7 0 0 0-14 0v2M13 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8', 18),
        h('img', { class: 'chat__avatar-image', src: PALITRA_CHAT_AVATAR, alt: '', width: '720', height: '1280', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', onerror: (event) => event.currentTarget.remove() }));
    }
    const label = chatAuthorLabel(author) || 'Участник';
    const words = str((author === 'client' || author === 'customer') && name ? name : label).match(/[\p{L}\p{N}]+/gu) || [];
    const initials = words.slice(0, 2).map((word) => Array.from(word)[0]).join('').toLocaleUpperCase('ru-RU') || '?';
    return h('span', { class: 'chat__avatar', 'aria-hidden': 'true', text: initials });
  }
  function chatMessageTime(message) {
    // Both native and legacy message DTOs use createdAt. Never substitute the time of rendering.
    const value = message.createdAt;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return h('time', { class: 'chat__time', datetime: date.toISOString(), title: fmtDate(date), text: pad(date.getHours()) + ':' + pad(date.getMinutes()) });
  }
  const HUGH_CHAT_AVATAR = 'https://synapse.synapsebusiness.ru/brand/hugh-icon-32.png';
  function staffAdviceRows(conversation, seed) {
    const advice = conversation && conversation.staffAdvisories;
    if (!staffAdvisoryAccess() || !seed || seed.ns !== 'thread' || !conversation || !conversation.seedThread || conversation.seedThread.id !== seed.id || !advice || advice.scopeKey !== conversation.scope.key) return [];
    const key = contextKey(), scope = advice.scopeKey;
    const live = (item) => staffAdvisoryAccess() && key === contextKey() && state.chat && state.chat.scope && state.chat.scope.key === scope && state.chat.staffAdvisories && state.chat.staffAdvisories.items.some(current => current === item);
    const rows = advice.items.map(item => {
      const row = h('div', { class: 'chat__msg is-theirs chat__advice', dataset: { staffAdvice: item.key } },
        h('div', { class: 'chat__message-head' }, h('span', { class: 'chat__avatar chat__avatar--hugh', 'aria-hidden': 'true', text: 'Х', },
          h('img', { src: HUGH_CHAT_AVATAR, alt: '', width: '26', height: '26', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', onerror: event => event.currentTarget.remove() })),
          h('span', { class: 'chat__meta', text: 'Хью · Заявка №' + item.orderId })),
        h('span', { class: 'chat__staff-only', text: 'Только сотрудникам' }),
        h('span', { class: 'chat__text', text: item.text }));
      const buttons = h('div', { class: 'chat__advice-actions' });
      for (const action of item.actions) {
        if (action.kind === 'order') {
          const ref = B.parseRef(action.ref, 'native-order'), detail = mobileFrame(state.role, 'detail');
          if (ref && detail) buttons.append(h('button', { type: 'button', class: 'chat__order', text: 'Воронка · Заявка №' + ref.id, onclick: () => { if (live(item)) open(detail.id, { order: B.refKey(ref), details: '1' }); } }));
        } else if (action.kind === 'contact') {
          const target = B.contactLink(action.channel, action.value), label = action.channel === 'phone' ? 'Позвонить: ' + action.value : (CHANNEL_LABEL[action.channel] || action.channel) + ': ' + action.value;
          if (target && target.kind === 'copy') buttons.append(h('button', { type: 'button', class: 'chat__order', text: label + ' · Копировать', onclick: () => { if (live(item)) copyText(target.text); } }));
          else if (target) buttons.append(h('a', { class: 'chat__order', href: target.href, ...(target.kind === 'url' ? { target: '_blank', rel: 'noopener noreferrer' } : {}), text: label, onclick: event => { if (!live(item)) event.preventDefault(); } }));
        }
      }
      row.append(buttons, h('span', { class: 'chat__advice-state', text: 'Актуальная подсказка', title: 'Основание: ' + fmtDate(item.basisAt) }));
      return row;
    });
    if (advice.status === 'unavailable') rows.push(h('p', { class: 'chat__advice-unavailable', text: 'Подсказки временно недоступны. Обновите переписку.' }));
    else if (advice.nextAfterThreadId !== null) rows.push(h('button', { type: 'button', class: 'chat__order chat__advice-more', disabled: Boolean(staffAdviceRead && staffAdviceRead.key === key), text: staffAdviceRead && staffAdviceRead.key === key ? 'Загружаем…' : 'Ещё подсказки', onclick: () => { if (staffAdvisoryAccess() && key === contextKey()) void loadMoreStaffAdvice(seed); } }));
    return rows;
  }
  // The original message text stays intact; only an exact backend automatic-reply marker may select its display projection.
  function chatMessageText(message) {
    const automatic = message && message.automaticReplyKind === 'order-received' && message.direction === 'out' &&
      (message.author === 'shop' && message.channel === 'shop' || message.author === 'manager' && message.source === 'app');
    return automatic && typeof message.displayText === 'string' && message.displayText.trim() && message.displayText.length <= 1000 ? message.displayText : str(message.text);
  }
  function chatView({ name, subtitle, messages, mine, orderButton, draft, max, placeholder, send, readOnly = false, blocked = false, attachmentTarget = null, uploads = null, conversation = null, hideStaffAdvice = false }) {
    const list = h('div', { class: 'chat__list', role: 'log', 'aria-label': 'Переписка', 'aria-live': 'polite', dataset: { draft }, onscroll: (e) => rememberChatScroll(e.currentTarget), onload: scheduleChatGeometry }, (Array.isArray(messages) ? messages : []).map((m) => {
      const author = m.author || m.authorType; // Native thread and existing legacy DTO use different field names.
      const row = h('div', { class: `chat__msg ${mine.includes(author) ? 'is-mine' : 'is-theirs'}` },
        h('div', { class: 'chat__message-head' }, chatMessageAvatar(author, name),
          h('span', { class: 'chat__meta', text: `${chatAuthorLabel(author)}${conversation ? m.orderId === null ? ' · Переписка без номера заявки' : ` · Заявка №${m.orderId}` : ''}` })),
        h('span', { class: 'chat__text', text: chatMessageText(m) }));
      const shownRead = orderReadMessageIdentity(m, attachmentTarget, conversation);
      if (state.role !== 'client' && shownRead) Object.assign(row.dataset,{readKind:shownRead.kind,readTarget:String(shownRead.id),readMessage:String(shownRead.throughMessageId)});
      const source = conversation ? B.makeRef('thread', m.threadId) : attachmentTarget;
      if (attachmentUI && source) attachmentUI.mountAttachments({ container: row, target: source, attachments: m.attachments });
      const sentAt = chatMessageTime(m);
      if (sentAt) row.append(sentAt);
      return row;
    }));
    const adviceRows = hideStaffAdvice ? [] : staffAdviceRows(conversation, attachmentTarget);
    if (adviceRows.length) {
      const key = draft + '#' + conversation.scope.key;
      list.append(h('details', { class: 'chat__advice-panel', open: chatAdviceDisclosure.get(key) === true, ontoggle: event => { if (event.currentTarget.isConnected) chatAdviceDisclosure.set(key, event.currentTarget.open); } },
        h('summary', { text: 'Подсказки по заявкам' }), ...adviceRows));
    }
    // Only the authenticated Palitra staff entry can mount the server's existing advice.
    // The customer history and its message/cursor identities are unchanged.
    if (staffAdvisoryAccess() && activeCompany === 'palitra-love' && attachmentTarget?.ns === 'thread' && conversation?.thread?.id === attachmentTarget.id && workflow?.orderResponseAdvice) {
      const adviceOrderId = B.parsePositiveId(conversation.thread.orderId) || `thread:${attachmentTarget.id}`;
      if (adviceOrderId !== null) {
        const reminder = workflow.orderResponseAdvice(adviceOrderId, attachmentTarget.id);
        if (reminder) list.append(reminder);
      }
    }
    list.addEventListener('load', scheduleChatGeometry, true);
    list.addEventListener('error', scheduleChatGeometry, true);
    const input = h('textarea', { class: 'app-input chat__input', disabled: readOnly || blocked, rows: '1', maxlength: String(max), placeholder: 'Написать сообщение', value: drafts.get(draft) || '', 'aria-label': 'Написать сообщение', dataset: { focus: `chat-${draft}` },
      oninput: (e) => { drafts.set(draft, e.target.value); lastChatInput = Date.now(); sizeChatInput(e.target); },
      oncompositionstart: () => { composing = true; }, oncompositionend: () => { composing = false; lastChatInput = Date.now(); }, onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !composing && e.keyCode !== 229) { e.preventDefault(); if (!readOnly && !blocked) send(); } } });
    const fileBox = h('fieldset', { class: 'chat__files', disabled: blocked, style: 'border:0;padding:0;margin:0;min-width:0' });
    const submit = h('button', { type: 'submit', class: 'app-btn app-btn--small', 'aria-label': 'Отправить', 'aria-busy': String(inflight.has(draft)), disabled: readOnly || blocked || inflight.has(draft), text: inflight.has(draft) ? 'Отправляется…' : 'Отправить' });
    let picker = null;
    const syncPicker = (value) => {
      if (!picker) return;
      picker.disabled = readOnly || blocked || inflight.has(draft) || !value || value.sending || value.preparing;
      fileBox.hidden = !fileBox.querySelector('.attachments__name')?.textContent && !fileBox.querySelector('.attachments__status')?.textContent && !value?.pending;
    };
    if (attachmentUI && attachmentTarget) {
      const key = contextKey(), epoch = tickets.epoch;
      const controller = attachmentUI.mountComposer({ container: fileBox, target: attachmentTarget,
        uploads: blocked ? uploads : readOnly || inflight.has(draft) || pendingSends.has(draft) ? null : uploads, getCaption: () => drafts.get(draft) || '',
        onState: (value) => { if (epoch !== tickets.epoch) return; sessionFileSafety.set(draft, !value || typeof value.blockingText !== 'boolean' || value.blockingText); sessionUpdateObserver?.refreshSafety(); submit.disabled = readOnly || blocked || inflight.has(draft) || !value || value.sending || value.preparing; submit.setAttribute('aria-busy', String(Boolean(inflight.has(draft) || value && (value.sending || value.preparing)))); submit.textContent = value && value.sending ? 'Отправляется…' : 'Отправить'; syncPicker(value); },
        onCommitted: ({ capturedCaption }) => {
          if (epoch !== tickets.epoch) return;
          if ((drafts.get(draft) || '') === capturedCaption) drafts.delete(draft);
          managerOrderChanged();
          followOwnMessage(draft);
          queueMicrotask(() => { if (epoch === tickets.epoch && key === contextKey() && !blockedConversation()) void loadScreen(); });
        } });
      attachmentComposer = { draft, controller };
      // Keep the original picker and its controller; only move its button beside the input.
      picker = fileBox.querySelector('.attachments__button');
      if (picker) {
        picker.className += ' chat__attach';
        picker.setAttribute('aria-label', 'Прикрепить файл');
        picker.setAttribute('title', 'Прикрепить файл');
        picker.replaceChildren(icon('m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.9-9.9a4 4 0 0 1 5.66 5.66l-9.91 9.9a2 2 0 0 1-2.83-2.83l9.2-9.19', 22));
        syncPicker(controller.getState());
      }
    }
    return h('div', { class: 'chat' },
      h('div', { class: 'chat__head' }, h('div', { class: 'chat__who' }, h('strong', { class: 'chat__client', text: name || 'Клиент' }), subtitle ? h('span', { class: 'chat__title', text: subtitle }) : null),
        orderButton ? h('button', { type: 'button', class: 'chat__order', onclick: orderButton.go }, orderButton.label) : null),
      blocked || state.error || conversation && conversation.staffAdvisories && conversation.staffAdvisories.status === 'unavailable' ? h('button', { type: 'button', class: 'chat__order chat__refresh chat__retry', dataset: { chatRefresh: 'retry' }, disabled: chatRefreshing, onclick: () => refreshChat() }, chatRefreshing ? 'Загружаем…' : 'Повторить загрузку') : null,
      conversation && conversation.scope.limited ? h('p', { class: 'hint chat__refresh', text: 'Показана подтверждённая переписка этой заявки. Связь с другими переписками пока не подтверждена.' }) : null,
      conversation && conversation.historyReset && conversation.nextBefore !== null ? h('p', { class: 'hint chat__refresh', text: 'Переписка обновлена. Более ранние сообщения можно загрузить кнопкой «Ранее».' }) : null,
      conversation && conversation.nextBefore !== null ? h('button', { type: 'button', class: 'chat__order chat__refresh chat__earlier', disabled: Boolean(earlierRead && earlierRead.key === contextKey()), onclick: () => loadEarlier(attachmentTarget) }, earlierRead && earlierRead.key === contextKey() ? 'Загружаем…' : 'Ранее') : null,
      list, h('div', { class: 'chat__dock' }, fileBox, h('form', { class: 'chat__compose', novalidate: true, onsubmit: (e) => { e.preventDefault(); if (!readOnly && !blocked && !composing) send(); } }, picker, input, submit)));
  }
  function sizeChatInput(input) {
    input.style.height = 'auto';
    input.style.height = `${Math.max(44, Math.min(input.scrollHeight, 112))}px`;
    scheduleChatGeometry();
  }
  function chatAuthorLabel(author) {
    return author === 'shop' && activeCompany !== 'palitra-love' ? Companies.profile(activeCompany)?.name || 'Компания' : CHANNEL_AUTHOR[author] || str(author);
  }
  const CHANNEL_AUTHOR = { client: 'Клиент', customer: 'Клиент', operator: 'Менеджер', manager: 'Менеджер', owner: 'Владелец', shop: 'Palitra Love', system: 'Бот' };
  async function sendWithReceipt({ draft, op, ref, bodyFor, receiptKind, receiptTarget, space }) {
    const blocked = blockedConversation();
    if (blocked && B.sameRef(blocked.seed, receiptTarget)) { toast('Сначала обновите переписку для проверки доступа. Черновик и прежняя попытка сохранены.'); return; }
    const epochAtSend = tickets.epoch, contextAtSend = contextKey();
    if (attachmentComposer && attachmentComposer.draft === draft) {
      const result = await attachmentComposer.controller.interceptSend(drafts.get(draft) || '');
      if (result.handled || epochAtSend !== tickets.epoch || contextAtSend !== contextKey()) return;
      const changed = blockedConversation();
      if (changed && B.sameRef(changed.seed, receiptTarget)) return;
    }
    if (inflight.has(draft)) return;   // F2: эта отправка уже в полёте — второй клик/Enter/submit ничего не создаёт
    const text = (drafts.get(draft) || '').trim();
    if (!text) return;
    const pend = pendingSends.get(draft);
    // Неизвестный исход: тот же requestId и то же тело; новая отправка не считается проверкой первой.
    const body = pend && pend.unknown ? pend.body : bodyFor(text, B.newRequestId());
    if (pend && pend.unknown && pend.text !== text) { toast('Исход прошлой отправки неизвестен: повторите её без изменений текста.'); return; }
    pendingSends.set(draft, { body, text, unknown: false });
    inflight.add(draft);
    const epoch = tickets.epoch, key = contextKey();
    try {
      const pending = bridge.call(op, ref ? { ref, body } : { body });
      render();   // кнопка «Отправляется…» недоступна, пока ждём ответ
      const data = await pending;
      if (epoch !== tickets.epoch) return;
      if (!B.receiptOk(receiptKind, receiptTarget, data)) throw Object.assign(new Error('Ответ сервера не подтвердил отправку — исход неизвестен'), { code: 'UNKNOWN_OUTCOME' });
      drafts.delete(draft); pendingSends.delete(draft); followOwnMessage(draft);
      managerOrderChanged();
      if (key === contextKey() && !blockedConversation()) loadScreen();
    } catch (error) {
      if (epoch !== tickets.epoch) return;
      if (error.status === 401) { endSession(space, error.message); return; }
      if (error.code === 'UNKNOWN_OUTCOME') pendingSends.set(draft, { body, text, unknown: true });
      else pendingSends.delete(draft);
      toast(error.message);
    } finally { if (epoch === tickets.epoch) inflight.delete(draft); }
    render();
  }
  function staffReply(ref, kind) {
    if (!caps()['native.write']) { toast('Нет права отвечать клиенту.'); return; }
    sendWithReceipt({ draft: draftKey('chat', ref), op: kind.op, ref, bodyFor: (text, requestId) => ({ requestId, text }), receiptKind: ref.ns, receiptTarget: ref, space: 'cabinet' });
  }

  function confirmedClientOrder(own, thread, data) {
    return activeCompany === 'palitra-love' && own && own.orderRef && own.orderRef.ns === 'native-order' &&
      B.parsePositiveId(own.orderRef.id) !== null && B.sameRef(own.ref, thread) &&
      ['thread', 'seedThread', 'composeThread'].every(key => data && data[key] && data[key].id === thread.id && data[key].orderId === own.orderRef.id);
  }
  /* ---------- чат покупателя (E/R1 предпросмотр) ---------- */
  function clientChat(frame) {
    const c = caps();
    const chatBlock = blocks(frame, 'chat')[0] || {};
    if (!c['customer.chat']) return [h('div', { class: 'app-empty' }, h('p', { text: 'Чат сейчас недоступен. Обновите страницу в том же браузере, где оставили заявку.' })), ...blocks(frame, 'text').map(genericBlock).filter(Boolean)];
    const threads = state.clientThreads, thread = state.clientThread, data = state.chat;
    const blocked = blockedConversation();
    if (blocked) return [blockedChatView(blocked)];
    if (!threads) return [h('p', { class: 'app-empty', text: 'Загрузка…' })];
    const order = paramRef('order', 'crm-order') || paramRef('order', 'crm-inquiry'), site = paramRef('site', 'native-order');
    const detail = mobileFrame('client', 'detail'), self = mobileFrame('client', 'chat');
    if (!thread) {
      const why = state.clientThreadMismatch
        ? 'Эта переписка не найдена среди ваших чатов в текущей сессии или относится к другой заявке — она не открыта. Выберите свою переписку из списка.'
        : site ? `Переписка по заявке №${site.id} в текущей сессии чата не найдена. Доступ к чату даёт только сессия, в которой заявка отправлена.`
          : order ? `Связь заказа №${order.id} с чатом сервер не подтвердил — откройте нужную переписку сами.` : 'Откройте переписку по нужной заявке.';
      // Нет подтверждённой связи заказа с чатом: явный выбор своего чата; отправки до выбора нет.
      return [h('section', { class: 'card' }, h('h2', { class: 'text__title', text: 'Выберите переписку' }),
        h('p', { class: `muted${state.clientThreadMismatch ? ' is-error' : ''}`, dataset: { chatGate: state.clientThreadMismatch ? 'mismatch' : site ? 'no-thread' : 'choose' }, text: why }),
        threads.length ? threads.map((t) => h('button', { type: 'button', class: 'app-btn app-btn--ghost', dataset: { thread: B.refKey(t.ref) },
          onclick: () => open(self.id, { ...(order && site && B.sameRef(t.orderRef, site) ? { order: B.refKey(order) } : {}), ...(t.orderRef ? { site: B.refKey(t.orderRef) } : {}), chat: B.refKey(t.ref) }) },
        t.orderRef ? `Общий чат · заявка сайта №${t.orderRef.id}` : `Переписка №${t.ref.id}`)) : h('p', { class: 'app-empty', text: 'Переписки пока нет.' }),
        state.clientThreadsBefore != null ? h('button', { type: 'button', class: 'app-btn app-btn--ghost', disabled: Boolean(earlierThreadsRead), onclick: loadEarlierThreads, text: earlierThreadsRead ? 'Загружаем…' : 'Более ранние заявки' }) : null),
      ...blocks(frame, 'text').map(genericBlock).filter(Boolean)];
    }
    if (!data) return [h('p', { class: 'app-empty', text: 'Загрузка…' })];
    const own = threads.find((t) => B.sameRef(t.ref, thread));
    const questionnaire = workflow && !confirmedClientOrder(own, thread, data) ? workflow.questionnairePanel(B.refKey(thread), data.autoReplyQuestions, async (text) => {
      const key = draftKey('chat', thread);
      if (attachmentComposer && attachmentComposer.draft === key && attachmentComposer.controller.getState().blockingText) throw new Error('Сначала завершите отправку выбранного файла или проверьте прежнюю попытку.');
      if ((drafts.get(key) || '').trim()) throw new Error('В поле сообщения уже есть текст. Сначала отправьте его или закончите редактирование.');
      drafts.set(key, text);
      await sendWithReceipt({ draft: key, op: 'customer.chat.send', ref: null, bodyFor: (bodyText, requestId) => ({ threadId: thread.id, requestId, text: bodyText }), receiptKind: 'chat', receiptTarget: thread, space: 'account' });
      if (drafts.has(key)) throw new Error('Ответы ещё не подтверждены сервером. Проверьте поле сообщения и повторите ту же отправку.');
    }) : null;
    return [clientChatOffers(thread, data, own), questionnaire, chatView({ name: auth.portal ? auth.portal.name : 'Вы', subtitle: preview ? 'Чат сайта · Предпросмотр' : own && own.orderRef ? `Общий чат · Заявка сайта №${own.orderRef.id}` : 'Общий чат с Palitra Love', messages: data.messages, mine: ['customer'], conversation: preview ? null : data,
      orderButton: order && detail && state.clientThreadLinked ? { label: order.ns === 'crm-inquiry' && own && own.orderRef ? `Заявка №${own.orderRef.id}` : `Заказ №${order.id}`, go: () => open(detail.id, { order: B.refKey(order) }) } : null,
      draft: draftKey('chat', thread), max: 4000, placeholder: chatBlock.placeholder === undefined || chatBlock.placeholder === null ? 'Сообщение' : str(chatBlock.placeholder), send: () => sendWithReceipt({ draft: draftKey('chat', thread), op: 'customer.chat.send', ref: null,
        bodyFor: (text, requestId) => ({ threadId: thread.id, requestId, text }), receiptKind: 'chat', receiptTarget: thread, space: 'account' }) , attachmentTarget: thread, uploads: data.uploads }),
    preview ? h('p', { class: 'muted', text: 'Предпросмотр чата сайта E/R1: синтетические сообщения, native0.' }) : null, ...blocks(frame, 'text').map(genericBlock).filter(Boolean)].filter(Boolean);
  }

  /* ---------- отзыв и отчёты ---------- */
  function reviewScreen(frame) {
    return [h('p', { class: 'hint', text: 'Отправка отзыва пока недоступна. Вы можете написать менеджеру в чате заказа.' }),
      ...blocks(frame, 'input').map((b) => h('label', { class: 'field' }, h('span', { class: 'field__label', text: str(b.label) }), h('input', { class: 'app-input', type: 'text', placeholder: str(b.placeholder), disabled: true }))),
      ...blocks(frame, 'button').map((b) => h('button', { type: 'button', class: 'app-btn app-btn--ghost', disabled: true, text: str(b.label) }))];
  }
  // Период существующей CRM считается по московскому деловому дню, как сервер rangeDate.
  function currentReportRange() {
    if (!state.reportRange) {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const first = new Date(`${today}T12:00:00Z`); first.setUTCDate(first.getUTCDate() - 29);
      state.reportRange = { from: first.toISOString().slice(0, 10), to: today };
      state.reportDraft = { ...state.reportRange };
    }
    return state.reportRange;
  }
  function cabinetReportScreen(frame) {
    const range = currentReportRange(), draft = state.reportDraft || range, report = state.crmReport;
    const from = h('input', { type: 'date', class: 'app-input', required: true, value: draft.from, dataset: { focus: 'crm-report-from' }, oninput: (e) => { state.reportDraft = { ...(state.reportDraft || range), from: e.target.value }; } });
    const to = h('input', { type: 'date', class: 'app-input', required: true, value: draft.to, dataset: { focus: 'crm-report-to' }, oninput: (e) => { state.reportDraft = { ...(state.reportDraft || range), to: e.target.value }; } });
    const filter = h('form', { class: 'card', 'aria-label': 'Период сводки CRM', onsubmit: (event) => {
      event.preventDefault();
      try { const q = B.crmReportQuery({ from: from.value, to: to.value }); state.reportRange = { from: q.from, to: q.to }; state.reportDraft = { ...state.reportRange }; open(frame.id, {}, { replace: true }); }
      catch (failure) { state.error = failure.message; state.crmReport = null; state.reportLoading = false; tickets.bumpNav(); render(); }
    } }, h('label', { class: 'field' }, h('span', { class: 'field__label', text: 'С даты (МСК)' }), from), h('label', { class: 'field' }, h('span', { class: 'field__label', text: 'По дату (МСК)' }), to),
      h('button', { class: 'app-btn', type: 'submit', disabled: state.reportLoading, text: state.reportLoading ? 'Загрузка…' : 'Показать сводку' }));
    const out = [h('h2', { class: 'text__title', text: 'Сводка CRM' }), h('p', { class: 'hint', text: 'Palitra Love · данные существующей CRM за выбранный период по московскому времени. Заявки сайта и этапы доставки ведутся в разделе «Заказы».' }), filter];
    if (state.reportLoading) return [...out, h('p', { class: 'app-empty', role: 'status', text: 'Загружаем сводку CRM…' })];
    if (!report) return [...out, h('p', { class: 'hint', text: state.error ? 'Сводка не загружена. Проверьте период и попробуйте снова.' : 'Выберите период и нажмите «Показать сводку».' })];
    const row = (label, value) => [h('dt', { text: label }), h('dd', { text: String(value) })];
    const money = (value) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 }).format(value);
    out.push(h('section', { class: 'card' }, h('h3', { class: 'text__title', text: `${report.from} — ${report.to} · МСК` }), h('dl', { class: 'report' }, row('Выручка CRM', money(report.revenue)), row('Посещения сайта', report.visits), row('Переходы', report.clicks)), h('p', { class: 'hint', text: 'Расходы и ROMI для отдельной компании в этой сводке недоступны.' })));
    if (!report.sourceStats.length) out.push(h('p', { class: 'app-empty', text: 'В CRM нет данных за выбранный период.' }));
    for (const source of report.sourceStats) out.push(h('section', { class: 'card' }, h('h3', { class: 'text__title', text: source.source || 'Источник не указан' }), h('dl', { class: 'report' }, row('Обращения CRM', source.leads), row('Записаны', source.booked), row('Посетили', source.visited), row('Продажи CRM', source.sales), row('Выручка CRM', money(source.revenue)), row('Посещения сайта', source.visits), row('Переходы', source.clicks))));
    return out;
  }
  function sourceReportAllowed() { return activeCompany==='palitra-love' && document.documentElement.dataset.entry==='cabinet' && state.role!=='client' && Boolean(auth.cabinet?.member && (auth.cabinet.role==='owner' || auth.cabinet.permissions?.includes('crm.view'))); }
  function disposeSourceReport() { sourceReportView?.dispose();sourceReportView=null;sourceReportKey=''; }
  function sourceReportScreen() {
    const key=managerBinding();if(sourceReportKey!==key)disposeSourceReport();
    if(!sourceReportView){sourceReportKey=key;sourceReportView=createSourceReport({h,win:window,read:HOST?.attributionReport?.read,help:(...args)=>window.PalitraHelp?.button(...args),isCurrent:()=>sourceReportAllowed()&&key===managerBinding()&&screenType(frameById(state.frameId))==='reports'});}
    return sourceReportView.element;
  }
  function reportsScreen(frame) { return [sourceReportAllowed()?sourceReportScreen():null,...existingReportsScreen(frame)].filter(Boolean); }
  function existingReportsScreen(frame) {
    if (activeCompany === 'palitra-love' && responseReportAllowed() && workflow?.canRead()) {
      return [typeof workflow.funnelReportPanel === 'function' ? workflow.funnelReportPanel() : null, caps()['cabinet.summary'] || caps()['portal.summary'] ? h('details', { class: 'card' }, h('summary', { text: 'Финансовая сводка CRM' }), financeReportsScreen(frame)) : null].filter(Boolean);
    }
    return financeReportsScreen(frame);
  }
  function financeReportsScreen(frame) {
    if (activeCompany !== 'palitra-love') return salonAllowed() ? salonReportScreen() : [h('p', { class: 'app-empty', text: 'Нет доступа к отчётам этой компании.' })];
    if (caps()['cabinet.summary']) return cabinetReportScreen(frame);
    const texts = blocks(frame, 'text').map(genericBlock).filter(Boolean);
    if (!caps()['portal.summary']) return [...texts, h('p', { class: 'hint', text: 'Отчёты доступны собственнику после входа в его аккаунт. Если вы уже вошли, обновите страницу.' })];
    const s = state.summary;
    if (!s) return [...texts, h('p', { class: 'app-empty', text: 'Загрузка…' })];
    const row = (k, v) => [h('dt', { text: k }), h('dd', { text: String(v) })];
    return [...texts, h('section', { class: 'card' }, h('h2', { class: 'text__title', text: 'Сводка CRM' }), h('dl', { class: 'report' },
      row('Активные заказы', s.orders.active), row('Выполнены', s.orders.done), row('Отменены', s.orders.cancelled), row('Просрочены', s.orders.overdue),
      ...B.CRM_STAGES.map((st) => row(B.CRM_STAGE_LABELS[st], (s.orders.byStage || {})[st] ?? 0)),
      ...Object.entries(s.bySource30d || {}).map(([k, v]) => row(`Источник 30 дн.: ${k}`, v))))];
  }

  /* ---------- запуск ---------- */
  window.addEventListener('pagehide', (event) => {
    stopChatRefresh(); abortManagerRead();
    disposeResponseReport();
    disposeContentTasks();
    // BFCache retains this same document and its in-memory drafts/files/bindings.
    if (event.persisted) return;
    disposeSalonReports(); disposeFreeLayouts(); if (attachmentUI) attachmentUI.unmount(); attachmentComposer = null;
  });
  if (!preview && HOST && HOST.mode === 'native' && HOST.verified === true && window.PalitraSessionUpdate) {
    sessionUpdateObserver = window.PalitraSessionUpdate.create({ window, document, buildId: SESSION_UI_BUILD,
      readSafety: sessionUpdateSafety,
      onState: (value) => sessionUpdateOffer?.paint(value),
      onReturn: resumeVisibleReads
    });
    sessionUpdateOffer = window.PalitraSessionUpdate.mountOffer({ document, parent: document.body, observer: sessionUpdateObserver });
    for (const name of ['input', 'change', 'click', 'compositionend']) document.addEventListener(name, sessionInputChanged, true);
    window.addEventListener('pagehide', (event) => {
      if (event.persisted) return;
      for (const name of ['input', 'change', 'click', 'compositionend']) document.removeEventListener(name, sessionInputChanged, true);
      sessionUpdateOffer?.dispose();
    });
  } else window.addEventListener('pageshow', (event) => {
    if (event.persisted) resumeVisibleReads();
  });
  if (multiCompany && Companies?.createReportNavigation && SalonReports?.entry) {
    reportNavigation = Companies.createReportNavigation({
      parse: SalonReports.entry, initialHash: location.hash, readBlockers: sessionUpdateSafety,
      replaceHash: hash => history.replaceState(null, '', hash || location.pathname),
      reload: () => location.reload(), onBlocked: message => toast(message)
    });
    const followReportLink = () => reportNavigation.observe(location.hash);
    window.addEventListener('hashchange', followReportLink);
    window.addEventListener('popstate', followReportLink);
    window.addEventListener('pagehide', event => {
      if (event.persisted) return;
      reportNavigation.dispose();
      window.removeEventListener('hashchange', followReportLink);
      window.removeEventListener('popstate', followReportLink);
    });
  }
  render();
  if (bridge && preview) signIn(HOST.initialPreview && HOST.service.PREVIEW[HOST.initialPreview] ? HOST.initialPreview : 'client');
  else if (bridge) window.PalitraSafeVisual.load(DESIGN, HOST, window).then((visual) => { DESIGN = visual; signIn(''); });
  // Доверенный host сообщает о смене/отзыве identity (выход, другой пользователь): новая эпоха, данные/черновики/фреймы очищаются.
  if (bridge && !preview && typeof HOST.onAuthChange === 'function') HOST.onAuthChange(() => signIn(''));
  window.PalitraShellDebug = preview ? Object.freeze({ state, auth, nav, drafts, frameSlots, signIn, open }) : undefined;
})();

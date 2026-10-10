/*
 * Palitra Love — приложение команды и покупателя.
 * Демо (index.html): вымышленные данные, участник выбирается переключателем (заголовок X-Demo-Actor).
 * Рабочий вход (miniapp.html — Telegram, site.html — аккаунт сайта): запросы только через window.PalitraSession;
 * личность и роль определяет сервер, права проверяются на каждом запросе.
 * Каждое изменение отправляется с одним requestId: если ответ потерян, «Проверить сохранение» повторяет
 * то же тело — сервер не выполнит действие дважды.
 */
'use strict';

(() => {
  const LIVE = document.documentElement.dataset.mode === 'integration';
  const session = LIVE ? window.PalitraSession || null : null;
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

  // ---------- Справочники ----------
  const STAGES = ['new', 'agreeing', 'awaiting_payment', 'preparing', 'photo', 'delivering', 'done'];
  const STAGE_STAFF = { new: 'Новый', agreeing: 'Согласование', awaiting_payment: 'Ждём оплату', preparing: 'Готовим', photo: 'Фото клиенту', delivering: 'Доставка', done: 'Выполнен' };
  const STAGE_CUSTOMER = {
    new: ['Заказ получен', 'Менеджер посмотрит заказ и свяжется с вами.'],
    agreeing: ['Уточняем детали', 'Согласовываем состав, дату и способ получения.'],
    awaiting_payment: ['Ждём оплату', 'Менеджер пришлёт ссылку на оплату.'],
    preparing: ['Готовим заказ', 'Собираем ваш заказ. Скоро здесь появится фото.'],
    photo: ['Посмотрите фото', 'Подтвердите, что всё нравится, или попросите изменить.'],
    delivering: ['Заказ в пути', 'Заказ передан в доставку или ждёт вас на выдаче.'],
    done: ['Заказ выполнен', 'Спасибо, что выбрали Palitra Love!'],
  };
  const SOURCE = { site: ['Сайт', 'globe'], telegram: ['Telegram', 'telegram'], instagram: ['Instagram', 'instagram'], call: ['Звонок', 'phone'] };
  const CONTACT = {
    phone: { label: 'Телефон', icon: 'phone', placeholder: '+7 900 000-00-00', inputmode: 'tel', hint: 'Номер с кодом страны или 8.' },
    whatsapp: { label: 'WhatsApp', icon: 'chat', placeholder: '+7 900 000-00-00', inputmode: 'tel', hint: 'Номер, привязанный к WhatsApp.' },
    telegram: { label: 'Telegram', icon: 'telegram', placeholder: '@username', inputmode: 'text', hint: 'Ник в Telegram, например @palitra_client.' },
    instagram: { label: 'Профиль', icon: 'instagram', placeholder: '@имя или ссылка на профиль', inputmode: 'text', hint: 'Можно вставить ссылку instagram.com/…' },
    max: { label: 'MAX', icon: 'chat', placeholder: 'Телефон или ссылка в MAX', inputmode: 'text', hint: 'Номер или ссылка https://…' },
  };
  const ROLE = { owner: 'собственник', admin: 'администратор', customer: 'покупатель' };
  const MARKETING = { unknown: 'Не спрашивали', granted: 'Согласился', declined: 'Отказался' };
  const FULFILLMENT = { delivery: 'Доставка', pickup: 'Самовывоз', courier: 'Курьер клиента' };
  const DEMO_ACTORS = ['varvara', 'darya', 'vlad', 'customer'];
  const MAX_PHOTO_SIDE = 1600;

  // ---------- Иконки ----------
  const ICONS = {
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    chart: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".8" fill="currentColor" stroke="none"/>',
    telegram: '<path d="M21.2 4.3 2.9 11.4c-.8.3-.8 1.4 0 1.7l4.6 1.6 1.8 5.5c.2.7 1.1.9 1.6.4l2.6-2.5 4.7 3.5c.6.4 1.4.1 1.6-.6l3.2-14c.2-.8-.6-1.4-1.3-1.1z"/><path d="m7.5 14.7 9.7-6.6-6.5 7.2"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/>',
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/>',
    calendar: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.5-4.5L6 21"/>',
    camera: '<path d="M14.5 4h-5L7.5 6.5h-3a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2h15a2 2 0 0 0 2-2V8.5a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3.5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6.5 15h4"/>',
    leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12.5M12 16.2h.01"/>',
    lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>',
    truck: '<path d="M2 6.5h11v10H2z"/><path d="M13 10h4.5l3.5 3.5v3h-8"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
    flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
    note: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    gift: '<rect x="3" y="8" width="18" height="13" rx="2"/><path d="M12 8v13M3 12h18M12 8c-1.5-3-5-4-5-1.5S10 8 12 8zm0 0c1.5-3 5-4 5-1.5S14 8 12 8z"/>',
    balloon: '<ellipse cx="12" cy="9" rx="6" ry="7"/><path d="M12 16l-1.2 2h2.4zM12 18c0 2-2 2-2 4"/>',
  };
  const icon = (name, cls = '') => `<svg class="i${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
  const ART = '<svg class="art" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><ellipse cx="9" cy="8" rx="4.5" ry="5.5"/><ellipse cx="16" cy="9.5" rx="3.6" ry="4.4"/><path d="M9 13.5c0 3 3 3 3 7M16 13.9c0 2.4-2.5 2.6-4 6.6"/></svg>';

  // ---------- Утилиты ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const desktop = window.matchMedia('(min-width: 960px)');
  const isDesktop = () => desktop.matches;
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt0 = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
  const fmt2 = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (k) => (Number.isFinite(Number(k)) && k !== null ? (Number(k) % 100 === 0 ? fmt0 : fmt2).format(Number(k) / 100) : '');
  const plural = (n, f) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? f[2] : b > 1 && b < 5 ? f[1] : b === 1 ? f[0] : f[2]; };
  const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').trim();
  const time = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };
  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    const b = window.crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  const initials = (name) => { const p = String(name || '').trim().split(/\s+/).filter((x) => /[\p{L}\p{N}]/u.test(x)); return p.length ? p.slice(0, 2).map((x) => x[0].toUpperCase()).join('') : ''; };
  const tone = (s) => { let h = 0; for (const ch of String(s || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 5; };
  function avatar(name, source, size = '') {
    const ini = initials(name);
    const cls = ini ? `av-${tone(name)}` : `src-${source || 'site'}`;
    return `<span class="avatar ${cls}${size ? ` avatar-${size}` : ''}" aria-hidden="true">${ini ? esc(ini) : icon((SOURCE[source] || SOURCE.site)[1])}</span>`;
  }
  const today = () => (state.boot && state.boot.options && state.boot.options.today) || ymd(new Date());
  function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  function addDays(dateStr, n) { const [y, m, d] = dateStr.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); }
  function dayDiff(dateStr) { const p = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }; return Math.round((p(dateStr) - p(today())) / 86400000); }
  function relDay(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return '';
    const diff = dayDiff(dateStr);
    if (diff === 0) return 'Сегодня';
    if (diff === 1) return 'Завтра';
    if (diff === -1) return 'Вчера';
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  function dueText(due) {
    if (!due) return '';
    const day = relDay(due.date);
    return due.time && due.time !== '23:59' ? `${day}, ${due.time}` : day;
  }
  function whenText(iso) {
    const t = time(iso);
    if (!t) return '';
    const d = new Date(t), now = new Date();
    const mins = (now - d) / 60000;
    if (mins >= 0 && mins < 1) return 'только что';
    if (mins >= 1 && mins < 60) return `${Math.floor(mins)} мин назад`;
    const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (ymd(d) === ymd(now)) return `сегодня, ${hm}`;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (ymd(d) === ymd(y)) return `вчера, ${hm}`;
    return `${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, ${hm}`;
  }
  function haptic(kind = 'light') { try { if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred(kind); } catch (_) { /* необязательный отклик */ } }

  // ---------- Состояние ----------
  function initialActor() {
    try { const v = sessionStorage.getItem('palitra-demo-actor'); if (DEMO_ACTORS.includes(v)) return v; } catch (_) { /* недоступно */ }
    return 'varvara';
  }
  const state = {
    actor: LIVE ? 'session' : initialActor(),
    seq: 0,
    boot: null, loading: true, bootError: '', ended: false,
    tab: null,
    filter: { inquiries: 'open', orders: 'active' },
    search: { inquiries: '', orders: '', customers: '' },
    selected: { inquiries: null, orders: null, customers: null, mine: null },
    showDetail: false,
    cache: { inquiry: new Map(), order: new Map(), customer: new Map() },
    detailError: {},
    busy: {}, errors: {}, pending: {}, drafts: {},
    sheet: null,
    summary: null, email: null, summaryError: '',
    shop: null,
  };
  const el = {
    actor: $('#actorSelect'), who: $('#who'), tabs: $('#tabs'), main: $('#main'), list: $('#list'), detail: $('#detail'),
    toast: $('#toast'), photo: $('#photoInput'), sheet: $('#sheet'), sheetBody: $('#sheetBody'),
  };
  const role = () => (state.boot && state.boot.actor ? state.boot.actor.role : null);
  const isOwner = () => role() === 'owner';
  const isCustomer = () => role() === 'customer';
  const me = () => (state.boot && state.boot.actor) || {};
  const list = (key) => (state.boot && Array.isArray(state.boot[key]) ? state.boot[key] : []);
  const price = () => list('price');
  const staffList = () => list('staff');
  const options = () => (state.boot && state.boot.options) || { intervals: { delivery: [], pickup: [], courier: [] }, sourceChannels: {}, basis: {} };
  const findIn = (key, id) => list(key).find((x) => String(x.id) === String(id));
  const findPrice = (id) => price().find((p) => String(p.id) === String(id));

  // ---------- API ----------
  class ApiError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }
  function statusText(status) {
    if (status === 403) return 'Для вашей роли это действие недоступно.';
    if (status === 404) return 'Запись не найдена. Обновите список.';
    if (status === 409) return 'Данные уже изменились. Карточка обновлена — проверьте и повторите.';
    if (status === 413) return 'Файл слишком большой.';
    if (status === 429) return 'Слишком много попыток. Подождите несколько минут.';
    if (status >= 500) return 'Сервер не смог выполнить действие. Попробуйте ещё раз.';
    if (status === 0) return 'Нет связи с сервером.';
    return 'Не удалось выполнить действие. Проверьте данные.';
  }
  async function api(path, { method = 'GET', body } = {}) {
    if (LIVE) {
      if (!session) throw new ApiError('Не удалось открыть приложение. Откройте его заново.', 401, 'ended');
      try { return await session.request(path, { method, body }); }
      catch (e) { const s = e && Number.isInteger(e.status) ? e.status : 0; throw new ApiError((e && e.message) || statusText(s), s, e && e.code); }
    }
    const headers = { Accept: 'application/json', 'X-Demo-Actor': state.actor };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try { res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin', cache: 'no-store' }); }
    catch (_) { throw new ApiError('Нет связи с сервером. Введённые данные сохранены — попробуйте ещё раз.', 0); }
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    // Успешный статус с нечитаемым ответом: запись могла выполниться — исход неизвестен.
    if (res.ok && (!data || typeof data !== 'object')) throw new ApiError('Ответ сервера не удалось прочитать.', res.status, 'unreadable');
    if (!res.ok || !data || data.error) throw new ApiError((data && typeof data.error === 'string' && data.error) || statusText(res.status), res.status, data && data.code);
    return data;
  }
  // Неизвестный исход записи: нет связи, ошибка сервера или нечитаемый ответ на успешный статус.
  // ended_unknown — запись уже ушла на сервер, а сессию тем временем завершил другой запрос: исход неизвестен,
  // попытка остаётся под ключом участника, который её отправил, и проверяется после его нового входа.
  const uncertain = (e) => e.status === 0 || e.status >= 500 || e.code === 'unreadable' || e.code === 'network' || e.code === 'ended_unknown';

  /* ---------- Неподтверждённые отправки ----------
     Если исход записи неизвестен, запрос (путь, тело и его requestId) сохраняется в sessionStorage этого
     окна под ключом текущего участника. Закрытие листа, Escape или перезагрузка не создают новый requestId:
     «Проверить сохранение» повторяет то же тело, и сервер не выполнит действие второй раз.
     Токены и ответы сервера не сохраняются; записи другого участника не читаются. */
  const UNSENT_TTL = 24 * 3600 * 1000;
  const ACTION_LABELS = { plan: 'План', note: 'Заметка', consent: 'Отметка о рассылке', stage: 'Смена этапа', reopen: 'Открытие обращения',
    approve_photo: 'Подтверждение фото', request_photo_change: 'Просьба изменить фото', payment: 'Отметка оплаты', photo: 'Фото заказа',
    close: 'Закрытие обращения', convert: 'Оформление заказа', items: 'Состав заказа', details: 'Получение заказа', cancel: 'Отмена заказа' };
  // Память окна — отдельная для каждого участника (ключ — id участника, подтверждённый сервером в bootstrap).
  // Хранилище и память никогда не подставляют записи одного участника другому.
  const unsentMemory = new Map();
  const unsentInflight = new Set(); // отправляются прямо сейчас — строку «Проверить сохранение» не показываем
  const unsentKey = () => (me().id ? `palitra-unsent:${LIVE ? 'live' : 'demo'}:${me().id}` : null);
  function unsentRead(key) {
    if (!key) return [];
    let list = unsentMemory.has(key) ? unsentMemory.get(key) : [];
    try { const raw = sessionStorage.getItem(key); if (raw !== null) list = JSON.parse(raw); } catch (_) { /* недоступно — память этого участника */ }
    return (Array.isArray(list) ? list : []).filter((a) => a && typeof a.id === 'string' && Date.now() - a.at < UNSENT_TTL);
  }
  const unsentList = () => unsentRead(unsentKey());
  function unsentWrite(key, list) {
    if (!key) return;
    unsentMemory.set(key, list);
    try { sessionStorage.setItem(key, JSON.stringify(list)); } catch (_) { /* переполнено/недоступно — остаётся в памяти окна */ }
  }
  /** Запомнить попытку ДО отправки: возвращает ключ участника, под которым её потом удалить. */
  function unsentSave(entry) {
    const key = unsentKey();
    if (!key) return null;
    unsentWrite(key, [...unsentRead(key).filter((a) => a.id !== entry.id), { ...entry, at: Date.now() }].slice(-10));
    return key;
  }
  function unsentDrop(id, key = unsentKey()) { if (id && key) unsentWrite(key, unsentRead(key).filter((a) => a.id !== id)); }
  /** Отправка с предварительной записью попытки: запись остаётся, пока сервер не подтвердит результат. */
  async function guardedPost(path, body, entry) {
    const id = body && body.requestId;
    const key = id ? unsentSave({ id, path, body, ...entry }) : null;
    unsentInflight.add(id);
    try {
      const res = await api(path, { method: 'POST', body });
      unsentDrop(id, key); // подтверждённый успех
      return res;
    } catch (e) {
      // Подтверждённый отказ сервера — попытка не выполнена, запись больше не нужна; неизвестный исход — остаётся.
      if (!(uncertain(e) && e.code !== 'ended')) unsentDrop(id, key);
      throw e;
    } finally { unsentInflight.delete(id); }
  }
  function unsentLabel(path, body) {
    if (path === '/api/inquiries') return 'Новое обращение';
    if (path === '/api/orders') return body && body.items && body.items.length ? 'Заказ' : 'Заявка';
    const m = /\/api\/(inquiries|orders)\/(\d+)\/action$/.exec(path);
    return `${ACTION_LABELS[body && body.action] || 'Изменение'}${m ? ` · ${m[1] === 'orders' ? 'заказ' : 'обращение'} №${m[2]}` : ''}`;
  }
  function unsentHtml() {
    const list = unsentList().filter((a) => !unsentInflight.has(a.id));
    if (!list.length) return '';
    return `<section class="banner banner-gold unsent" role="region" aria-label="Неподтверждённые сохранения">${icon('alert')}<div>
      <strong>Не удалось подтвердить сохранение</strong>
      <span>Проверка повторит ту же отправку — дубля не будет.</span>
      <ul class="unsent-list">${list.map((a) => `<li><span>${esc(a.label)}</span>
        <button type="button" class="btn btn-secondary" id="unsent-${esc(a.id)}" data-action="unsent-check" data-id="${esc(a.id)}"${state.busy[`unsent:${a.id}`] ? ' aria-disabled="true"' : ''}>${busyLabel(`unsent:${a.id}`, 'Проверить сохранение', 'refresh')}</button>
        <button type="button" class="btn btn-link" data-action="unsent-drop" data-id="${esc(a.id)}">Больше не проверять</button></li>`).join('')}</ul>
      </div></section>`;
  }
  async function unsentCheck(id) {
    const a = unsentList().find((x) => x.id === id);
    const key = `unsent:${id}`;
    if (!a || state.busy[key] || unsentInflight.has(id)) return;
    state.busy[key] = true; render();
    const seq = state.seq;
    const owner = unsentKey();
    unsentInflight.add(id);
    try {
      const res = await api(a.path, { method: 'POST', body: a.body });
      unsentDrop(id, owner);
      if (seq !== state.seq) return;
      afterSave(a.kind, res, a);
      toast(res.replayed || res.duplicate ? 'Уже было сохранено — повтор не создан.' : 'Сохранено.');
      loadBoot({ quiet: true });
    } catch (e) {
      const refused = !(uncertain(e) && e.code !== 'ended');
      if (refused) unsentDrop(id, owner);
      if (seq !== state.seq) return;
      if (!refused) toast('Сервер по-прежнему не подтвердил сохранение. Попробуйте позже.', true);
      else toast(`Не сохранено: ${e.message || statusText(e.status)}`, true);
    } finally { unsentInflight.delete(id); if (seq === state.seq) { delete state.busy[key]; render(); } }
  }
  /** Что сделать после подтверждённого сохранения — по виду действия (работает и для восстановленной попытки). */
  function afterSave(kind, res) {
    if (res.inquiry) setCache('inquiry', res.inquiry);
    if (res.order) setCache('order', res.order);
    if (kind === 'inquiry-new' && res.inquiry) {
      state.tab = 'inquiries'; state.filter.inquiries = 'open'; state.search.inquiries = ''; select('inquiries', res.inquiry.id);
    } else if (kind === 'convert' && res.orderId) {
      state.tab = 'orders'; state.filter.orders = 'active'; select('orders', res.orderId);
    } else if (kind === 'shop') {
      state.shop = null; state.tab = 'mine';
      if (res.orderId) { state.selected.mine = res.orderId; loadDetail('order', res.orderId, { force: true }); }
    }
  }

  async function loadBoot({ quiet = false } = {}) {
    const seq = state.seq;
    if (!state.boot && !quiet) { state.loading = true; render(); }
    try {
      const data = await api('/api/bootstrap');
      if (seq !== state.seq) return;
      state.boot = data;
      state.loading = false; state.bootError = '';
      const tabs = tabDefs().map((t) => t.id);
      if (!tabs.includes(state.tab)) state.tab = isCustomer() ? (list('orders').length ? 'mine' : 'shop') : 'inquiries';
      render();
    } catch (e) {
      if (seq !== state.seq) return;
      state.loading = false;
      if (e.status === 401 && LIVE) { state.ended = true; state.bootError = e.message; }
      if (!state.boot) state.bootError = e.message; else if (!quiet) toast(e.message, true);
      render();
    }
  }
  async function loadDetail(kind, id, { force = false } = {}) {
    const key = `${kind}:${id}`;
    if (!force && state.cache[kind].has(String(id))) return;
    const seq = state.seq;
    delete state.detailError[key];
    try {
      const path = kind === 'inquiry' ? `/api/inquiries/${id}` : kind === 'order' ? `/api/orders/${id}` : `/api/customers/${id}`;
      const data = await api(path);
      if (seq !== state.seq) return;
      state.cache[kind].set(String(id), kind === 'customer' ? data : data[kind]);
    } catch (e) {
      if (seq !== state.seq) return;
      state.detailError[key] = e.message;
    }
    render();
  }
  function setCache(kind, value) { if (value && value.id !== undefined) state.cache[kind].set(String(value.id), value); }

  /* Изменение с защитой от двойного нажатия и потери ответа. key — что именно сохраняется. */
  async function mutate({ key, path, body, ok, done, fail }) {
    if (state.busy[key]) return false;
    const seq = state.seq;
    state.busy[key] = true;
    delete state.errors[key];
    render();
    let success = false;
    try {
      // Попытка записывается ДО отправки и удаляется только после подтверждённого результата.
      const res = await guardedPost(path, body, { kind: 'action', label: unsentLabel(path, body) });
      if (seq !== state.seq) return false;
      delete state.pending[key];
      success = true;
      if (done) done(res);
      if (ok) toast(res.replayed || res.duplicate ? 'Уже сохранено ранее — повтор не создан.' : ok);
      loadBoot({ quiet: true });
    } catch (e) {
      if (seq !== state.seq) return false;
      if (uncertain(e) && e.code !== 'ended') {
        state.pending[key] = { path, body, ok, done };
        state.errors[key] = 'Не удалось подтвердить сохранение. Нажмите «Проверить сохранение» — повтор не создаст дубль.';
      } else {
        delete state.pending[key];
        state.errors[key] = e.message || statusText(e.status);
        if (fail) fail(e);
      }
    } finally {
      if (seq === state.seq) { delete state.busy[key]; render(); }
    }
    return success;
  }
  function retry(key) { const p = state.pending[key]; if (p) mutate({ key, ...p }); }

  // ---------- Рендер ----------
  function withFocus(fn) {
    const a = document.activeElement;
    const id = a && a.id;
    let s = null, e = null;
    try { s = a.selectionStart; e = a.selectionEnd; } catch (_) { /* нет выделения */ }
    fn();
    if (id && document.activeElement !== a) {
      const n = document.getElementById(id);
      if (n && n !== a && !n.closest('[hidden]')) {
        n.focus({ preventScroll: true });
        try { if (s !== null && s !== undefined) n.setSelectionRange(s, e); } catch (_) { /* не текст */ }
      }
    }
  }
  function render() { withFocus(() => { renderWho(); renderTabs(); renderMain(); if (state.sheet) renderSheet(); }); syncBackButton(); }
  function focusSoon(id) { requestAnimationFrame(() => { const n = id && document.getElementById(id); if (n) n.focus({ preventScroll: true }); }); }

  function renderWho() {
    const a = state.boot && state.boot.actor;
    el.who.innerHTML = a ? `<span class="who-pill"${LIVE ? '' : ' title="Демонстрационный участник, не настоящий вход"'}>${avatar(a.name, 'site')}<span class="who-text"><span class="who-name">${esc(a.name)}</span><span class="who-role">${esc(ROLE[a.role] || '')}</span></span></span>` : '';
  }
  function tabDefs() {
    if (!state.boot) return [];
    if (isCustomer()) return [{ id: 'shop', label: 'Заказать', icon: 'gift' }, { id: 'mine', label: 'Мои заказы', icon: 'bag', badge: list('orders').filter((o) => o.stage === 'photo' && o.photo && !o.photo.approved && !o.photo.changeRequested && o.status === 'active').length }];
    const overdue = list('inquiries').filter((i) => i.overdue).length + list('orders').filter((o) => o.overdue).length;
    const tabs = [
      { id: 'inquiries', label: 'Обращения', icon: 'inbox', badge: list('inquiries').filter((i) => i.status === 'open' && (i.overdue || !i.assignee)).length },
      { id: 'orders', label: 'Заказы', icon: 'bag', badge: list('orders').filter((o) => o.overdue).length },
      { id: 'customers', label: 'Клиенты', icon: 'users' },
    ];
    if (isOwner()) tabs.push({ id: 'summary', label: 'Сводка', icon: 'chart', badge: overdue ? 0 : 0 });
    return tabs;
  }
  function renderTabs() {
    const tabs = tabDefs();
    el.tabs.hidden = !tabs.length;
    el.tabs.innerHTML = tabs.map((t) => `<button type="button" class="tab" id="tab-${t.id}" data-action="tab" data-tab="${t.id}"${state.tab === t.id ? ' aria-current="page"' : ''}>
      ${icon(t.icon)}<span>${esc(t.label)}</span>${t.badge ? `<span class="tab-badge"><span class="sr-only">, требуют внимания: </span>${t.badge}</span>` : ''}</button>`).join('');
  }

  function renderMain() {
    const m = el.main;
    if (!state.boot) {
      m.classList.add('single'); m.classList.remove('show-detail');
      el.list.innerHTML = state.loading ? `<div class="page-head"><div class="skeleton"></div></div><div class="cards">${'<div class="skeleton"></div>'.repeat(3)}</div>` : bootErrorHtml();
      el.detail.innerHTML = '';
      return;
    }
    const single = isCustomer() || state.tab === 'summary';
    m.classList.toggle('single', single && !(isCustomer() && state.tab === 'mine' && state.selected.mine));
    if (isCustomer()) { renderCustomer(); return; }
    if (state.tab === 'summary') { m.classList.remove('show-detail'); el.list.innerHTML = summaryHtml(); el.detail.innerHTML = ''; return; }
    const kind = { inquiries: 'inquiry', orders: 'order', customers: 'customer' }[state.tab];
    ensureSelection(kind);
    m.classList.toggle('show-detail', Boolean(state.showDetail && state.selected[state.tab]) && !isDesktop());
    el.list.innerHTML = listHtml();
    el.detail.innerHTML = detailHtml(kind);
  }
  function ensureSelection(kind) {
    const tab = state.tab;
    const items = currentList();
    // Только что созданной карточки ещё нет в списке (он обновится следом) — выбор сбрасывается,
    // только если карточку не удалось открыть.
    const sel = state.selected[tab];
    if (sel && !findIn(tab, sel) && state.detailError[`${kind}:${sel}`]) state.selected[tab] = null;
    if (!state.selected[tab] && isDesktop() && items[0]) { state.selected[tab] = items[0].id; loadDetail(kind, items[0].id); }
    if (!state.selected[tab]) state.showDetail = false;
  }
  function bootErrorHtml() {
    if (LIVE && state.ended) {
      const close = tg && typeof tg.close === 'function' ? `<button type="button" class="btn btn-primary" data-action="close-app">${icon('x')}Закрыть приложение</button>` : '';
      return emptyHtml('Нужно открыть приложение заново', state.bootError || 'Сессия завершена.', close);
    }
    return emptyHtml('Не удалось загрузить данные', state.bootError || 'Сервер не ответил.', `<button type="button" class="btn btn-primary" data-action="retry-boot">${icon('refresh')}Повторить</button>`);
  }
  const emptyHtml = (title, text, action = '') => `<div class="empty">${ART}<h2 class="empty-title">${esc(title)}</h2><p class="empty-text">${esc(text)}</p>${action}</div>`;
  const chipSource = (s) => { const v = SOURCE[s]; return v ? `<span class="chip">${icon(v[1])}${esc(v[0])}</span>` : ''; };
  const errorHtml = (key) => {
    const err = state.errors[key];
    if (!err) return '';
    const again = state.pending[key] ? `<button type="button" class="btn btn-quiet" data-action="retry" data-key="${esc(key)}">${icon('refresh')}Проверить сохранение</button>` : '';
    return `<div class="inline-error" role="alert">${icon('alert')}<span>${esc(err)}</span></div>${again}`;
  };
  const busyLabel = (key, label, ic) => (state.busy[key] ? '<span class="spin" aria-hidden="true"></span>Сохраняем…' : `${ic ? icon(ic) : ''}${esc(label)}`);
  const aBusy = (key) => (state.busy[key] ? ' aria-disabled="true"' : '');

  // ---------- Списки команды ----------
  function currentList() {
    const tab = state.tab;
    const q = norm(state.search[tab] || '');
    const match = (hay) => !q || norm(hay).includes(q) || (q.replace(/\D/g, '').length >= 3 && String(hay).replace(/\D/g, '').includes(q.replace(/\D/g, '')));
    if (tab === 'customers') return list('customers').filter((c) => match(`${c.name} ${c.contact}`));
    if (tab === 'inquiries') {
      const f = state.filter.inquiries;
      const myId = me().id;
      return list('inquiries').filter((i) => match(`${i.name} ${i.contact} ${i.summary} ${i.id}`)).filter((i) => {
        if (f === 'open') return i.status === 'open';
        if (f === 'mine') return i.status === 'open' && i.assignee && i.assignee.id === myId;
        if (f === 'overdue') return i.overdue;
        return true;
      }).sort((a, b) => (b.overdue - a.overdue) || ((a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1)) || (time(b.activityAt) - time(a.activityAt)));
    }
    const f = state.filter.orders;
    return list('orders').filter((o) => match(`${o.name} ${o.customer ? o.customer.contact : ''} ${o.id} ${(o.items || []).map((i) => i.title).join(' ')}`)).filter((o) => {
      if (f === 'active') return o.status === 'active';
      if (f === 'today') return o.status === 'active' && o.deliveryDate === today();
      if (f === 'done') return o.status === 'done';
      if (f === 'cancelled') return o.status === 'cancelled';
      return true;
    }).sort((a, b) => (b.overdue - a.overdue) || ((a.deliveryDate || '9999') < (b.deliveryDate || '9999') ? -1 : (a.deliveryDate || '9999') > (b.deliveryDate || '9999') ? 1 : 0) || (b.id - a.id));
  }
  function listHtml() {
    const tab = state.tab;
    const items = currentList();
    const head = {
      inquiries: ['Обращения', 'Имя, контакт или суть'],
      orders: ['Заказы', 'Имя, номер или товар'],
      customers: ['Клиенты', 'Имя или контакт'],
    }[tab];
    let filters = '';
    let primary = '';
    let note = '';
    if (tab === 'inquiries') {
      const all = list('inquiries');
      const n = { open: all.filter((i) => i.status === 'open').length, mine: all.filter((i) => i.status === 'open' && i.assignee && i.assignee.id === me().id).length, overdue: all.filter((i) => i.overdue).length };
      filters = segs('inquiries', [['open', 'Открытые', n.open], ['mine', 'Мои', n.mine], ['overdue', 'Просрочено', n.overdue, n.overdue > 0], ['all', 'Все']]);
      primary = `<button type="button" class="btn btn-primary btn-block" id="btn-add-inquiry" data-action="add-inquiry">${icon('plus')}Добавить обращение</button>`;
      const ch = state.boot.channels || {};
      const off = [ch.instagram !== 'connected' ? 'Instagram' : '', ch.telegram !== 'connected' ? 'Telegram' : ''].filter(Boolean);
      if (off.length) note = `<p class="block-note">${icon('alert')}<span>${off.join(' и ')} пока не ${off.length > 1 ? 'подключены' : 'подключён'}: такие обращения добавляйте вручную — кратко, с итогом разговора.</span></p>`;
    } else if (tab === 'orders') {
      const all = list('orders');
      filters = segs('orders', [['active', 'В работе', all.filter((o) => o.status === 'active').length], ['today', 'Сегодня', all.filter((o) => o.status === 'active' && o.deliveryDate === today()).length],
        ['done', 'Выполнены'], ['cancelled', 'Отменены']]);
    }
    const greeting = tab === 'inquiries' ? `<p class="eyebrow">${esc(hello())}, ${esc(me().name || '')}</p>` : '';
    const body = items.length ? `<ul class="cards">${items.map((x) => `<li>${tab === 'customers' ? customerCard(x) : tab === 'inquiries' ? inquiryCard(x) : orderCard(x)}</li>`).join('')}</ul>` : emptyList(tab);
    return `<div class="page-head">${greeting}<div class="title-row"><h1 class="page-title">${head[0]}</h1><span class="count">${items.length || ''}</span></div>
      ${primary}${note}
      <div class="search">${icon('search')}<label class="sr-only" for="search-${tab}">Поиск</label><input id="search-${tab}" type="text" inputmode="search" data-search="${tab}" value="${esc(state.search[tab])}" placeholder="${head[1]}" autocomplete="off" enterkeyhint="search"></div>
      ${filters}</div>${unsentHtml()}${body}`;
  }
  function hello() { const h = new Date().getHours(); return h >= 5 && h < 12 ? 'Доброе утро' : h < 18 && h >= 12 ? 'Добрый день' : h >= 18 && h < 23 ? 'Добрый вечер' : 'Доброй ночи'; }
  function segs(scope, defs) {
    return `<div class="segments" role="group" aria-label="Фильтр">${defs.map(([id, label, n, alert]) => `<button type="button" class="seg${alert ? ' is-alert' : ''}" id="f-${scope}-${id}" data-action="filter" data-scope="${scope}" data-filter="${id}" aria-pressed="${state.filter[scope] === id}">${esc(label)}${n ? `<span class="n">${n}</span>` : ''}</button>`).join('')}</div>`;
  }
  function emptyList(tab) {
    if (norm(state.search[tab])) return emptyHtml('Ничего не нашлось', 'Попробуйте часть имени, номера телефона или ника.');
    if (tab === 'inquiries') return state.filter.inquiries === 'overdue' ? emptyHtml('Просроченных нет', 'Все сроки соблюдены.') : emptyHtml('Новых обращений нет', 'Когда клиент напишет или позвонит, добавьте обращение — кнопка выше.');
    if (tab === 'customers') return emptyHtml('Клиентов пока нет', 'Клиент появится после первого обращения или заказа.');
    return emptyHtml({ active: 'Заказов в работе нет', today: 'На сегодня ничего', done: 'Выполненных пока нет', cancelled: 'Отменённых нет' }[state.filter.orders] || 'Заказов нет', 'Заказ оформляется из обращения.');
  }
  const dueChip = (item) => (item.due ? `<span class="chip ${item.overdue ? 'chip-red' : 'chip-gold'}">${icon(item.overdue ? 'alert' : 'clock')}${item.overdue ? 'Просрочено · ' : ''}${esc(dueText(item.due))}</span>` : '');
  function inquiryCard(i) {
    const sel = String(state.selected.inquiries) === String(i.id);
    const title = i.name || (i.customer && i.customer.name) || i.contact;
    const status = i.status === 'converted' ? `<span class="chip chip-olive">${icon('bag')}Заказ №${esc(i.orderId)}</span>` : i.status === 'closed' ? '<span class="chip">Закрыто</span>' : '';
    const who = i.status === 'open' ? (i.assignee ? `<span class="chip">${icon('user')}${esc(i.assignee.name)}</span>` : '<span class="chip chip-rose">Без ответственного</span>') : '';
    return `<button type="button" class="card-item${sel ? ' is-selected' : ''}${i.overdue ? ' is-alert' : ''}" id="item-inquiries-${i.id}" data-action="select" data-tab="inquiries" data-id="${i.id}"${sel ? ' aria-current="true"' : ''}>
      ${avatar(i.name, i.source)}
      <span class="ci-body">
        <span class="ci-top"><span class="ci-title">${esc(title)}</span><span class="ci-side">${esc(whenShort(i.activityAt))}</span></span>
        <span class="ci-text">${esc(i.nextStep ? `→ ${i.nextStep}` : i.summary)}</span>
        <span class="ci-meta">${chipSource(i.source)}${status}${who}${i.status === 'open' ? dueChip(i) : ''}</span>
      </span></button>`;
  }
  function whenShort(iso) {
    const t = time(iso); if (!t) return '';
    const d = new Date(t);
    return ymd(d) === ymd(new Date()) ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  }
  function stageChip(o) {
    if (o.status === 'cancelled') return '<span class="chip chip-red">Отменён</span>';
    if (o.status === 'done') return `<span class="chip chip-ok">${icon('check')}Выполнен</span>`;
    return `<span class="chip chip-ink">${esc(STAGE_STAFF[o.stage] || o.stage)}</span>`;
  }
  function payChip(o) {
    if (o.payment === 'paid') return `<span class="chip chip-ok">${icon('check')}Оплачен</span>`;
    if (o.payment === 'deposit') return '<span class="chip chip-gold">Предоплата</span>';
    return o.status === 'active' ? '<span class="chip">Не оплачен</span>' : '';
  }
  function orderCard(o) {
    const sel = String(state.selected.orders) === String(o.id);
    const date = o.deliveryDate ? `<span class="chip${o.deliveryDate === today() && o.status === 'active' ? ' chip-blue' : ''}">${icon('calendar')}${esc(relDay(o.deliveryDate))}${o.deliveryInterval && o.deliveryDate === today() ? ` · ${esc(o.deliveryInterval.split(' ')[0])}` : ''}</span>` : '';
    const items = (o.items || []).map((i) => (i.qty > 1 ? `${i.title} × ${i.qty}` : i.title)).join(', ') || 'Состав ещё не выбран';
    return `<button type="button" class="card-item${sel ? ' is-selected' : ''}${o.overdue ? ' is-alert' : ''}" id="item-orders-${o.id}" data-action="select" data-tab="orders" data-id="${o.id}"${sel ? ' aria-current="true"' : ''}>
      ${avatar(o.name, o.source)}
      <span class="ci-body">
        <span class="ci-top"><span class="ci-title">${esc(o.name || (o.customer && o.customer.contact) || `Заказ №${o.id}`)}</span><span class="ci-side">${esc(money(o.knownTotal))}</span></span>
        <span class="ci-text">№ ${o.id} · ${esc(items)}</span>
        <span class="ci-meta">${stageChip(o)}${date}${payChip(o)}${o.status === 'active' ? dueChip(o) : ''}</span>
      </span></button>`;
  }
  function customerCard(c) {
    const sel = String(state.selected.customers) === String(c.id);
    const ch = CONTACT[c.channel] || CONTACT[{ telegram_id: 'telegram', instagram_id: 'instagram' }[c.channel]] || CONTACT.phone;
    return `<button type="button" class="card-item${sel ? ' is-selected' : ''}" id="item-customers-${c.id}" data-action="select" data-tab="customers" data-id="${c.id}"${sel ? ' aria-current="true"' : ''}>
      ${avatar(c.name, c.channel === 'instagram' || c.channel === 'instagram_id' ? 'instagram' : c.channel === 'telegram' || c.channel === 'telegram_id' ? 'telegram' : 'call')}
      <span class="ci-body">
        <span class="ci-top"><span class="ci-title">${esc(c.name || c.contact)}</span><span class="ci-side">${esc(whenShort(c.activityAt))}</span></span>
        <span class="ci-text">${icon(ch.icon, 'sr-only')}${esc(c.contact)}</span>
        <span class="ci-meta"><span class="chip">${c.inquiryCount} ${plural(c.inquiryCount, ['обращение', 'обращения', 'обращений'])}</span>${c.orderCount ? `<span class="chip chip-olive">${c.orderCount} ${plural(c.orderCount, ['заказ', 'заказа', 'заказов'])}</span>` : ''}</span>
      </span></button>`;
  }

  // ---------- Деталь (команда) ----------
  function detailHtml(kind) {
    const tab = state.tab;
    const id = state.selected[tab];
    if (!id) return isDesktop() ? `<div class="empty">${ART}<p class="empty-text">Выберите карточку в списке.</p></div>` : '';
    const back = `<button type="button" class="back" id="btn-back" data-action="back">${icon('back')}${esc({ inquiries: 'Обращения', orders: 'Заказы', customers: 'Клиенты' }[tab])}</button>`;
    const data = state.cache[kind].get(String(id));
    const err = state.detailError[`${kind}:${id}`];
    if (!data) {
      if (err) return `${back}${emptyHtml('Не удалось открыть карточку', err, `<button type="button" class="btn btn-primary" data-action="reload-detail" data-kind="${kind}" data-id="${id}">${icon('refresh')}Повторить</button>`)}`;
      return `${back}<div class="detail"><div class="skeleton"></div><div class="skeleton"></div></div>`;
    }
    if (kind === 'inquiry') return back + inquiryDetail(data);
    if (kind === 'order') return back + orderDetail(data);
    return back + customerDetail(data);
  }
  function heroHtml({ name, source, contact, contactLabel, chips, sub }) {
    return `<section class="hero"><div class="hero-top">${avatar(name, source, 'lg')}<div>
      <h2 class="hero-name" id="detail-title" tabindex="-1">${esc(name || contact || 'Без имени')}</h2>
      <p class="hero-sub">${contact ? `<span>${esc(contact)}</span>` : ''}${contactLabel ? `<span class="muted">${esc(contactLabel)}</span>` : ''}${sub ? `<span class="muted">${esc(sub)}</span>` : ''}</p>
      </div></div><div class="hero-chips">${chips}</div></section>`;
  }
  function inquiryDetail(i) {
    const key = `inquiry:${i.id}`;
    const name = i.name || (i.customer && i.customer.name) || '';
    const chips = `${chipSource(i.source)}${i.status === 'converted' ? `<span class="chip chip-olive">Заказ №${esc(i.orderId)}</span>` : i.status === 'closed' ? '<span class="chip">Закрыто</span>' : '<span class="chip chip-blue">Открыто</span>'}${i.overdue ? '<span class="chip chip-red">Просрочено</span>' : ''}`;
    let next;
    if (i.status === 'open') {
      next = `<section class="next${i.overdue ? ' is-alert' : ''}" aria-labelledby="next-t"><p class="next-label" id="next-t">${i.overdue ? 'Срок прошёл' : 'Следующий шаг'}</p>
        <p class="next-text">${esc(i.nextStep || 'Связаться с клиентом и оформить заказ')}${i.due ? ` · ${esc(dueText(i.due))}` : ''}</p>
        <button type="button" class="btn btn-primary btn-block" id="primary-cta" data-action="convert" data-id="${i.id}">${icon('bag')}Оформить заказ</button></section>`;
    } else if (i.status === 'converted') {
      next = `<section class="next is-quiet"><p class="next-label">Обращение оформлено</p><p class="next-text">Заказ №${esc(i.orderId)}</p>
        <button type="button" class="btn btn-primary btn-block" id="primary-cta" data-action="open-order" data-id="${i.orderId}">${icon('bag')}Открыть заказ</button></section>`;
    } else {
      next = `<section class="next is-quiet"><p class="next-label">Обращение закрыто</p><p class="next-text">${esc(i.closeReason || '')}</p>
        ${i.origin === 'manual' ? `<button type="button" class="btn btn-link" data-action="reopen" data-id="${i.id}">${icon('refresh')}Открыть снова</button>` : '<p class="muted">Новое сообщение клиента создаст новое обращение.</p>'}${errorHtml(`${key}:reopen`)}</section>`;
    }
    const conversation = i.conversation === 'connected'
      ? (Array.isArray(i.channelMessages) && i.channelMessages.length
        ? `<ol class="msgs">${i.channelMessages.map((m) => `<li class="msg${m.direction === 'out' ? ' out' : ''}">${esc(m.text || kindText(m.kind))}${m.deleted ? ' <span class="muted">(удалено клиентом)</span>' : ''}<span class="msg-meta">${esc(m.authorLabel || '')} · ${esc(whenText(m.sentAt))}${m.edited ? ' · изменено' : ''}</span></li>`).join('')}</ol>`
        : '<p class="muted">Сообщения не загрузились.</p>')
        + `<p class="block-note">${icon('lock')}<span>Ответить клиенту из приложения пока нельзя — отвечайте в ${esc(SOURCE[i.source] ? SOURCE[i.source][0] : 'канале')}.</span></p>`
      : i.conversation === 'manual_summary'
        ? `<p class="block-note">${icon('alert')}<span>Переписка в ${esc(i.source === 'call' ? 'звонке' : SOURCE[i.source][0])} сюда не подключена — здесь краткий итог, записанный сотрудником.</span></p>`
        : `<p class="block-note">${icon('globe')}<span>Заявка с сайта${i.siteOrderId ? ` №${esc(i.siteOrderId)}` : ''}. Текст клиента — выше.</span></p>`;
    return `<article class="detail" aria-labelledby="detail-title">
      ${heroHtml({ name, source: i.source, contact: i.contact, contactLabel: i.contactChannelLabel, chips, sub: whenText(i.createdAt) })}
      ${next}
      <section class="block"><h3 class="block-title">${icon('chat')}Суть обращения</h3><p class="text-block">${esc(i.summary)}</p>
        ${i.outcome ? `<div class="note"><span class="staff-only">${icon('lock')}Только команда</span><p class="text-block">${esc(i.outcome)}</p><span class="msg-meta">Итог разговора</span></div>` : ''}
        <dl class="facts"><div class="fact">${icon('flag')}<dt>Как обратился</dt><dd>${esc(i.basisLabel)}</dd></div>
        <div class="fact">${icon('mail')}<dt>Рассылка</dt><dd>${esc(MARKETING[i.marketingConsent] || '')}${i.consentRecordedBy ? ` <span class="muted">· отметил(а) ${esc(i.consentRecordedBy)}</span>` : ''}</dd></div></dl>
        ${i.status !== 'closed' ? consentSegs(i) : ''}
        ${conversation}</section>
      ${i.status !== 'closed' ? planBlock('inquiry', i) : ''}
      ${notesBlock('inquiry', i)}
      ${i.status === 'open' ? `<div class="block-actions"><button type="button" class="btn btn-quiet" data-action="close-inquiry" data-id="${i.id}">${icon('x')}Закрыть без заказа</button></div>` : ''}
      ${notificationNotes(i)}
      ${historyBlock(i.history)}
    </article>`;
  }
  function kindText(kind) { return { photo: 'Фото', voice: 'Голосовое сообщение', video: 'Видео', document: 'Файл', sticker: 'Стикер' }[kind] || 'Вложение'; }
  function consentSegs(i) {
    const key = `inquiry:${i.id}:consent`;
    return `<div class="field"><span class="legend">Отметка о рассылке <span class="optional">— только со слов клиента</span></span>
      <div class="segments wrap" role="radiogroup" aria-label="Рассылка">${Object.entries(MARKETING).map(([k, v]) => `<button type="button" class="seg" role="radio" aria-checked="${i.marketingConsent === k}" data-action="consent" data-id="${i.id}" data-value="${k}"${aBusy(key)}>${esc(v)}</button>`).join('')}</div>
      <p class="hint">Согласие на обработку данных для заказа — отдельно. Здесь только рассылки и напоминания.</p>${errorHtml(key)}</div>`;
  }
  function planBlock(kind, item) {
    const key = `${kind}:${item.id}:plan`;
    const d = (f, fallback) => (state.drafts[`${key}:${f}`] !== undefined ? state.drafts[`${key}:${f}`] : fallback);
    const assignee = d('assignee', item.assignee ? item.assignee.id : '');
    const date = d('date', item.due ? item.due.date : '');
    const timeV = d('time', item.due && item.due.time !== '23:59' ? item.due.time : '');
    const staff = staffList();
    const inactive = item.assignee && item.assignee.inactive ? `<option value="${esc(item.assignee.id)}" selected>${esc(item.assignee.name)}</option>` : '';
    return `<section class="block" aria-labelledby="plan-${key}"><h3 class="block-title" id="plan-${key}">${icon('flag')}Кто и когда<span class="staff-only">${icon('lock')}Клиент не видит</span></h3>
      <div class="field"><label for="p-${kind}-${item.id}-who">Ответственный</label>
        <select id="p-${kind}-${item.id}-who" data-draft="${key}:assignee"><option value="">Пока никто</option>${inactive}${staff.map((s) => `<option value="${esc(s.id)}"${assignee === s.id ? ' selected' : ''}>${esc(s.name)}${s.id === me().id ? ' (я)' : ''} — ${esc(ROLE[s.role])}</option>`).join('')}</select></div>
      <div class="field"><label for="p-${kind}-${item.id}-step">Следующий шаг</label>
        <input id="p-${kind}-${item.id}-step" type="text" maxlength="300" data-draft="${key}:step" value="${esc(d('step', item.nextStep || ''))}" placeholder="Например: перезвонить и уточнить цвета"></div>
      <div class="field"><span class="legend">Срок</span>
        <div class="row-quick">${[['Сегодня', 0], ['Завтра', 1], ['Через 2 дня', 2]].map(([l, n]) => `<button type="button" class="seg" data-action="quick-due" data-key="${key}" data-date="${addDays(today(), n)}" aria-pressed="${date === addDays(today(), n)}">${l}</button>`).join('')}</div>
        <div class="row-2"><input id="p-${kind}-${item.id}-date" type="date" aria-label="Дата срока" data-draft="${key}:date" value="${esc(date)}"><input id="p-${kind}-${item.id}-time" type="time" aria-label="Время срока" data-draft="${key}:time" value="${esc(timeV)}"></div></div>
      <button type="button" class="btn btn-secondary btn-block" id="p-${kind}-${item.id}-save" data-action="save-plan" data-kind="${kind}" data-id="${item.id}"${aBusy(key)}>${busyLabel(key, 'Сохранить план', 'check')}</button>
      ${errorHtml(key)}</section>`;
  }
  function notesBlock(kind, item) {
    const key = `${kind}:${item.id}:note`;
    const notes = Array.isArray(item.notes) ? item.notes : [];
    return `<section class="block"><h3 class="block-title">${icon('note')}Заметки команды<span class="staff-only">${icon('lock')}Клиент не видит</span></h3>
      ${notes.length ? `<ol class="msgs">${notes.map((n) => `<li class="note">${esc(n.text)}<span class="msg-meta">${esc(n.author)} · ${esc(whenText(n.createdAt))}</span></li>`).join('')}</ol>` : ''}
      <div class="field"><label class="sr-only" for="n-${kind}-${item.id}">Новая заметка</label>
        <textarea id="n-${kind}-${item.id}" rows="2" maxlength="2000" data-draft="${key}:text" placeholder="Что важно знать команде">${esc(state.drafts[`${key}:text`] || '')}</textarea></div>
      <button type="button" class="btn btn-quiet" id="n-${kind}-${item.id}-save" data-action="save-note" data-kind="${kind}" data-id="${item.id}"${aBusy(key)}>${busyLabel(key, 'Добавить заметку', 'plus')}</button>
      ${errorHtml(key)}</section>`;
  }
  function historyBlock(history, customer = false) {
    const h = Array.isArray(history) ? history : [];
    if (!h.length) return '';
    return `<section class="block"><details class="history"><summary>${icon('history')}История<span class="count">${h.length}</span></summary>
      <ol class="timeline">${h.slice().reverse().map((x) => `<li class="tl"><span>${esc(x.label)}<span class="tl-meta">${!customer && x.actor ? `${esc(x.actor)} · ` : ''}${esc(whenText(x.createdAt))}</span></span></li>`).join('')}</ol></details></section>`;
  }

  // ---------- Заказ (команда) ----------
  function orderPrimary(o) {
    if (o.status !== 'active') return null;
    const missingDetails = !o.deliveryDate || !o.deliveryInterval || (o.fulfillment === 'delivery' && !o.deliveryAddress);
    switch (o.stage) {
      case 'new': return { kind: 'stage', value: 'agreeing', label: 'Начать согласование', icon: 'chat' };
      case 'agreeing': return (!o.items.length || o.unknownCount) ? { kind: 'items', label: o.items.length ? 'Уточнить состав и цену' : 'Выбрать состав', icon: 'bag' }
        : { kind: 'stage', value: 'awaiting_payment', label: 'Согласовано — ждём оплату', icon: 'check' };
      case 'awaiting_payment': return o.payment === 'unpaid' ? { kind: 'payment', label: 'Отметить оплату', icon: 'card' } : { kind: 'stage', value: 'preparing', label: 'Начать подготовку', icon: 'gift' };
      case 'preparing': return o.photo ? { kind: 'stage', value: 'photo', label: 'Показать фото клиенту', icon: 'image' } : { kind: 'photo', label: 'Прикрепить фото', icon: 'camera' };
      case 'photo': return o.photo && o.photo.changeRequested ? { kind: 'photo', label: 'Заменить фото', icon: 'camera' }
        : missingDetails ? { kind: 'details', label: 'Указать дату, время и адрес', icon: 'calendar' } : { kind: 'stage', value: 'delivering', label: o.fulfillment === 'delivery' ? 'Передать в доставку' : 'Готов к выдаче', icon: 'truck' };
      case 'delivering': return o.payment !== 'paid' ? { kind: 'payment', label: 'Отметить полную оплату', icon: 'card' }
        : { kind: 'stage', value: 'done', label: o.fulfillment === 'delivery' ? 'Заказ доставлен' : 'Заказ выдан', icon: 'check' };
      default: return null;
    }
  }
  function stepper(o, labels = STAGE_STAFF) {
    const idx = STAGES.indexOf(o.stage);
    const done = o.status === 'done';
    return `<div class="block"><ol class="stepper" aria-label="Этапы заказа">${STAGES.map((s, n) => `<li class="step${n < idx || done ? ' is-done' : n === idx ? ' is-current' : ''}"${n === idx ? ' aria-current="step"' : ''}><span class="sr-only">${esc(labels[s] || s)}</span></li>`).join('')}</ol>
      <p class="stage-line">Этап ${idx + 1} из ${STAGES.length} · <strong>${esc(o.status === 'cancelled' ? 'Отменён' : labels[o.stage] || o.stage)}</strong></p></div>`;
  }
  function itemsHtml(o) {
    const items = o.items || [];
    return `${items.length ? `<ul class="lines">${items.map((i) => `<li class="line"><span class="ln-title">${esc(i.title)}</span><span class="ln-qty">× ${esc(i.qty)}</span><span class="ln-sum">${i.price === null ? 'уточняется' : esc(money(i.price * i.qty))}</span></li>`).join('')}</ul>` : '<p class="muted">Состав ещё не выбран.</p>'}
      <div class="total"><span>Итого${o.unknownCount ? ' по известным ценам' : ''}</span><strong>${esc(money(o.knownTotal))}</strong></div>`;
  }
  function fulfillmentFacts(o, customer = false) {
    const rows = [['truck', 'Получение', o.fulfillmentLabel || FULFILLMENT[o.fulfillment] || ''],
      ['calendar', 'Дата', o.deliveryDate ? `${relDay(o.deliveryDate)}${o.deliveryInterval ? `, ${o.deliveryInterval}` : ''}` : 'не указана'],
      ['pin', o.fulfillment === 'delivery' ? 'Адрес' : 'Где', o.deliveryAddress || 'не указан']];
    if (o.wishes) rows.push(['chat', customer ? 'Пожелания' : 'Пожелания клиента', o.wishes]);
    return `<dl class="facts">${rows.map(([ic, k, v]) => `<div class="fact">${icon(ic)}<dt>${esc(k)}</dt><dd class="text-block">${esc(v)}</dd></div>`).join('')}</dl>`;
  }
  function paymentText(o) {
    if (o.payment === 'paid') return `Оплачен полностью · ${money(o.paidKopecks)}`;
    if (o.payment === 'deposit') return `Предоплата ${money(o.paidKopecks)} из ${money(o.knownTotal)}`;
    return 'Оплаты пока нет';
  }
  function orderDetail(o) {
    const key = `order:${o.id}`;
    const p = orderPrimary(o);
    const active = o.status === 'active';
    const canItems = active && ['new', 'agreeing', 'awaiting_payment'].includes(o.stage) && !o.paidKopecks;
    const canDetails = active && ['new', 'agreeing', 'awaiting_payment', 'preparing', 'photo'].includes(o.stage);
    const name = o.name || (o.customer && o.customer.name) || '';
    const chips = `${chipSource(o.source)}<span class="chip">№ ${o.id}</span>${stageChip(o)}${payChip(o)}${o.overdue ? '<span class="chip chip-red">Просрочено</span>' : ''}`;
    let next = '';
    if (o.status === 'cancelled') {
      next = `<div class="banner banner-red">${icon('x')}<div><strong>Заказ отменён</strong><span>${esc(o.cancelReason)}</span>${o.paidKopecks ? `<span>Оплачено ${esc(money(o.paidKopecks))} — состояние оплаты сохранено, решите возврат отдельно.</span>` : ''}</div></div>`;
    } else if (o.status === 'done') {
      next = `<div class="banner banner-ok">${icon('check')}<div><strong>Заказ выполнен</strong><span>Клиент видит памятку по уходу за шарами.</span></div></div>`;
    } else {
      const alertText = o.photo && o.photo.changeRequested ? `Клиент просит: «${o.photoChangeText}»` : '';
      next = `<section class="next${o.overdue ? ' is-alert' : ''}"><p class="next-label">${o.overdue ? 'Срок прошёл' : 'Сейчас'}</p>
        <p class="next-text">${esc(o.nextStep || o.nextAction)}${o.due ? ` · ${esc(dueText(o.due))}` : ''}</p>
        ${alertText ? `<p>${esc(alertText)}</p>` : ''}
        ${p ? `<button type="button" class="btn btn-primary btn-block" id="primary-cta" data-action="order-primary" data-id="${o.id}"${aBusy(`${key}:stage`)}${aBusy(`${key}:photo`)}>${busyLabel(`${key}:stage`, p.label, p.icon)}</button>` : ''}
        ${errorHtml(`${key}:stage`)}${errorHtml(`${key}:photo`)}</section>`;
    }
    const photo = o.photo ? `<figure class="photo"><img src="${esc(o.photo.url || '')}" alt="Фото заказа №${o.id}">
        <figcaption>${o.photo.approved ? `<span class="chip chip-ok">${icon('check')}Клиент подтвердил</span>` : o.photo.changeRequested ? '<span class="chip chip-red">Клиент просит изменить</span>' : o.stage === 'preparing' ? '<span class="chip">Клиент ещё не видит</span>' : '<span class="chip chip-gold">Ждём ответа клиента</span>'}${LIVE ? '' : '<span class="muted">Только локально</span>'}</figcaption></figure>` : '<p class="muted">Фото появится на этапе подготовки. JPEG, PNG или WebP.</p>';
    return `<article class="detail" aria-labelledby="detail-title">
      ${heroHtml({ name, source: o.source, contact: o.customer ? o.customer.contact : '', contactLabel: o.customer ? o.customer.channelLabel : '', chips, sub: whenText(o.createdAt) })}
      ${stepper(o)}
      ${next}
      <section class="block"><h3 class="block-title">${icon('bag')}Состав</h3>${itemsHtml(o)}
        ${canItems ? `<button type="button" class="btn btn-quiet" data-action="edit-items" data-id="${o.id}">${icon('bag')}Изменить состав</button>` : ''}</section>
      <section class="block"><h3 class="block-title">${icon('truck')}Получение</h3>${fulfillmentFacts(o)}
        ${canDetails ? `<button type="button" class="btn btn-quiet" data-action="edit-details" data-id="${o.id}">${icon('calendar')}Изменить</button>` : ''}</section>
      <section class="block"><h3 class="block-title">${icon('card')}Оплата</h3><p>${esc(paymentText(o))}</p>
        ${active && o.payment !== 'paid' && o.stage !== 'done' && !(p && p.kind === 'payment') ? `<button type="button" class="btn btn-quiet" data-action="payment" data-id="${o.id}">${icon('card')}Отметить оплату</button>` : ''}
        <p class="hint">Отметка для команды — деньги в приложении не принимаются.</p></section>
      ${['preparing', 'photo', 'delivering', 'done'].includes(o.stage) || o.photo ? `<section class="block"><h3 class="block-title">${icon('image')}Фото готового заказа</h3>${photo}
        ${active && ['preparing', 'photo'].includes(o.stage) && o.photo && !(p && p.kind === 'photo') ? `<button type="button" class="btn btn-quiet" data-action="pick-photo" data-id="${o.id}"${aBusy(`${key}:photo`)}>${icon('camera')}Заменить фото</button>` : ''}</section>` : ''}
      ${active ? planBlock('order', o) : ''}
      ${notesBlock('order', o)}
      ${active ? `<div class="block-actions"><button type="button" class="btn btn-danger" data-action="cancel-order" data-id="${o.id}">${icon('x')}Отменить заказ</button>
        <button type="button" class="btn btn-link" data-action="open-inquiry" data-id="${o.inquiryId}">${icon('inbox')}Исходное обращение</button></div>` : `<div class="block-actions"><button type="button" class="btn btn-link" data-action="open-inquiry" data-id="${o.inquiryId}">${icon('inbox')}Исходное обращение</button></div>`}
      ${notificationNotes(o)}
      ${historyBlock(o.history)}
    </article>`;
  }
  const TEAM_TEXT = { ready: 'Новые обращения из Instagram, Telegram и звонков приходят менеджеру в Telegram',
    disabled: 'Не подключены: менеджеру в Telegram ничего не отправляется, обращения только в приложении',
    no_recipient: 'Менеджер для уведомлений не привязан — сообщения не отправляются',
    transport_unavailable: 'Отправка через бот на сервере не подключена — сообщения не отправляются',
    not_configured: 'Не подключены: менеджеру в Telegram ничего не отправляется' };
  const PRIMARY_LABEL = { site_queue: 'Уведомление команде (заявка сайта)', team_telegram: 'Уведомление менеджеру в Telegram', telegram_ingest: 'Уведомление команде о сообщении Telegram' };
  function primaryText(p) {
    if (p.status === 'not_configured' || p.status === 'not_registered') return 'не настроено';
    if (p.status === 'pending' && p.availability && p.availability !== 'ready') return 'ждёт подключения — пока не отправлено';
    return { pending: 'в очереди', sending: 'отправляется', sent: 'доставлено', error: 'не отправлено', uncertain: 'результат неизвестен — повтор не выполняется' }[p.status] || p.status;
  }
  function notificationNotes(item) {
    const out = [];
    if (item.primaryNotification) out.push(`<p class="block-note">${icon('telegram')}<span>${esc(PRIMARY_LABEL[item.primaryNotification.channel] || 'Уведомление команде')}: ${esc(primaryText(item.primaryNotification))}</span></p>`);
    if (item.notification) out.push(`<p class="block-note">${icon('mail')}<span>Резервная почта: ${esc(notifyText(item.notification))}</span></p>`);
    return out.join('');
  }
  function notifyText(n) {
    return { not_registered: 'не требовалась', waiting_primary: 'ждёт ответа Telegram', suppressed: 'не понадобилась — Telegram доставил', pending: n.availability === 'ready' ? 'в очереди' : 'не отправлена — почта не настроена',
      sending: 'отправляется', sent: 'отправлена', uncertain: 'результат отправки неизвестен — повтор не выполняется', error: 'ошибка отправки', not_configured: 'не настроена' }[n.status] || n.status;
  }
  function customerDetail(data) {
    const c = data.customer;
    const src = c.channel === 'instagram' || c.channel === 'instagram_id' ? 'instagram' : c.channel === 'telegram' || c.channel === 'telegram_id' ? 'telegram' : 'call';
    const manual = ['phone', 'whatsapp', 'telegram', 'instagram'].includes(c.channel);
    return `<article class="detail" aria-labelledby="detail-title">
      ${heroHtml({ name: c.name, source: src, contact: c.contact, contactLabel: c.channelLabel, chips: `<span class="chip">с ${esc(new Date(time(c.createdAt)).toLocaleDateString('ru-RU'))}</span>`, sub: '' })}
      ${c.sameNameCount ? `<div class="banner banner-gold">${icon('alert')}<div>Есть ещё ${c.sameNameCount} ${plural(c.sameNameCount, ['клиент', 'клиента', 'клиентов'])} с таким же именем. Это разные контакты — карточки не объединяются автоматически.</div></div>` : ''}
      ${manual ? `<button type="button" class="btn btn-primary btn-block" data-action="add-inquiry-for" data-id="${c.id}">${icon('plus')}Новое обращение</button>` : ''}
      <section class="block"><h3 class="block-title">${icon('bag')}Заказы</h3>${data.orders.length ? `<ul class="cards">${data.orders.map((o) => `<li>${orderCard(o)}</li>`).join('')}</ul>` : '<p class="muted">Заказов пока нет.</p>'}</section>
      <section class="block"><h3 class="block-title">${icon('inbox')}Обращения</h3>${data.inquiries.length ? `<ul class="cards">${data.inquiries.map((i) => `<li>${inquiryCard(i)}</li>`).join('')}</ul>` : '<p class="muted">Обращений нет.</p>'}</section>
    </article>`;
  }

  // ---------- Сводка собственника ----------
  function summaryHtml() {
    const s = state.summary;
    const e = state.email;
    if (!s) return `<div class="page-head"><h1 class="page-title">Сводка</h1></div>${state.summaryError ? emptyHtml('Сводка не загрузилась', state.summaryError, `<button type="button" class="btn btn-primary" data-action="load-summary">${icon('refresh')}Повторить</button>`) : '<div class="skeleton"></div>'}`;
    const stat = (n, label, alert) => `<div class="stat${alert && n ? ' is-alert' : ''}"><b>${esc(n)}</b><span>${esc(label)}</span></div>`;
    const ch = s.channels || {};
    const chRow = (ic, title, text, chip) => `<div class="channel">${icon(ic)}<div><strong>${esc(title)}</strong><span class="muted">${esc(text)}</span></div>${chip}</div>`;
    const emailState = !e ? 'загружается' : { unconfigured: 'Адрес не указан — письма не отправляются', disabled: e.runtimeEnabled ? 'Выключена в настройках' : 'Отправка писем на сервере ещё не подключена', transport_unavailable: 'Почтовый сервер не подключён — письма не отправляются', ready: 'Готова к отправке резервных писем' }[e.availability] || e.availability;
    const key = 'settings:email';
    const d = (f, v) => (state.drafts[`${key}:${f}`] !== undefined ? state.drafts[`${key}:${f}`] : v);
    return `<div class="page-head"><p class="eyebrow">Только для собственников</p><h1 class="page-title">Сводка</h1></div>
      <div class="detail">
      <div class="stats">${stat(s.inquiries.open, 'открытых обращений')}${stat(s.inquiries.overdue + s.orders.overdue, 'просрочено', true)}${stat(s.inquiries.unassigned, 'без ответственного', true)}
        ${stat(s.orders.active, 'заказов в работе')}${stat(s.orders.today, 'на сегодня')}${stat(money(s.paidKopecks), 'отмечено оплат')}</div>
      ${s.paidCancelledKopecks ? `<div class="banner banner-gold">${icon('card')}<div>В отменённых заказах отмечено оплат на ${esc(money(s.paidCancelledKopecks))} — проверьте возвраты.</div></div>` : ''}
      <section class="block"><h3 class="block-title">${icon('inbox')}Откуда обращения · 30 дней</h3>
        <dl class="facts">${Object.entries(s.bySource30d || {}).map(([k, n]) => `<div class="fact">${icon((SOURCE[k] || SOURCE.site)[1])}<dt>${esc((SOURCE[k] || [k])[0])}</dt><dd>${esc(n)}</dd></div>`).join('')}</dl></section>
      <section class="block"><h3 class="block-title">${icon('chat')}Каналы</h3>
        ${chRow('telegram', 'Telegram', ch.telegram === 'connected' ? 'Входящие сообщения попадают в обращения' : 'Не подключён: сообщения сюда не попадают', ch.telegram === 'connected' ? '<span class="chip chip-ok">Подключён</span>' : '<span class="chip">Не подключён</span>')}
        ${chRow('instagram', 'Instagram', ch.instagram === 'connected' ? 'Входящие Direct попадают в обращения' : 'Не подключён: обращения добавляются вручную', ch.instagram === 'connected' ? '<span class="chip chip-ok">Подключён</span>' : '<span class="chip">Не подключён</span>')}
        ${chRow('phone', 'Звонки', 'Записываются вручную кнопкой «Добавить обращение»', '<span class="chip">Вручную</span>')}
        ${chRow('telegram', 'Уведомления команде', TEAM_TEXT[ch.teamTelegram] || TEAM_TEXT.not_configured, ch.teamTelegram === 'ready' ? '<span class="chip chip-ok">Готовы</span>' : '<span class="chip">Не отправляются</span>')}
        ${chRow('mail', 'Резервная почта', emailState, e && e.availability === 'ready' ? '<span class="chip chip-ok">Готова</span>' : '<span class="chip">Не отправляет</span>')}</section>
      <section class="block"><h3 class="block-title">${icon('mail')}Резервная почта</h3>
        <p class="muted">Если Telegram команды не подтвердит уведомление о новом обращении, собственнику уйдёт короткое письмо без контактов клиента. Сохранённый адрес ещё не означает, что письма доставляются.</p>
        ${e ? `<div class="field"><label for="email-addr">Адрес собственника</label><input id="email-addr" type="email" inputmode="email" autocomplete="email" maxlength="254" data-draft="${key}:email" value="${esc(d('email', e.email))}" placeholder="name@example.ru"></div>
        <label class="toggle" for="email-on"><span>Отправлять резервные письма</span><input id="email-on" type="checkbox" data-draft="${key}:enabled"${d('enabled', e.enabled) === true || d('enabled', e.enabled) === 'true' ? ' checked' : ''}></label>
        <p class="hint">Состояние: ${esc(emailState)}${e.lastSentAt ? ` · последнее письмо ${esc(whenText(e.lastSentAt))}` : ''}</p>
        <button type="button" class="btn btn-secondary btn-block" id="email-save" data-action="save-email"${aBusy(key)}>${busyLabel(key, 'Сохранить', 'check')}</button>${errorHtml(key)}
        ${e.failedKnown ? `<div class="banner banner-gold">${icon('alert')}<div><strong>Не отправлено писем: ${esc(e.failedKnown)}</strong><span>Почтовый сервер подтвердил, что они не ушли (например, из-за адреса). Исправьте адрес и отправьте их заново.</span>
          ${e.availability === 'ready' ? `<button type="button" class="btn btn-secondary" id="email-retry" data-action="email-retry"${aBusy(key)}>${icon('refresh')}Отправить заново</button>` : ''}</div></div>` : ''}
        ${e.unknownResult ? `<p class="block-note">${icon('alert')}<span>Результат отправки неизвестен: ${esc(e.unknownResult)}. Такие письма не повторяются автоматически — проверьте почту.</span></p>` : ''}` : '<div class="skeleton"></div>'}</section>
      <section class="block"><h3 class="block-title">${icon('users')}Команда Palitra</h3>
        ${s.staff && s.staff.length ? `<ul class="team">${s.staff.map((m) => `<li>${avatar(m.name, 'site')}<div><strong>${esc(m.name)}</strong><span class="muted">${esc(ROLE[m.role])}</span></div></li>`).join('')}</ul>` : '<p class="muted">Сотрудники ещё не подключены.</p>'}
        <p class="block-note">${icon('lock')}<span>Права выдаются только на сервере после проверки аккаунта — не по имени и не по нику.</span></p></section>
      </div>`;
  }
  async function loadSummary() {
    const seq = state.seq;
    state.summaryError = '';
    try {
      const [s, e] = await Promise.all([api('/api/summary'), api('/api/settings/email')]);
      if (seq !== state.seq) return;
      state.summary = s; state.email = e;
    } catch (err) { if (seq === state.seq) state.summaryError = err.message; }
    if (seq === state.seq) render();
  }

  // ---------- Покупатель ----------
  function renderCustomer() {
    const m = el.main;
    m.classList.remove('show-detail');
    if (state.tab === 'shop') { m.classList.add('single'); el.list.innerHTML = shopHtml(); el.detail.innerHTML = ''; return; }
    const orders = list('orders').slice().sort((a, b) => b.id - a.id);
    const requests = list('requests');
    const id = state.selected.mine;
    if (id && findIn('orders', id)) {
      m.classList.add('single');
      const data = state.cache.order.get(String(id));
      const err = state.detailError[`order:${id}`];
      el.list.innerHTML = `<button type="button" class="back" data-action="mine-back">${icon('back')}Мои заказы</button>${data ? customerOrder(data) : err ? emptyHtml('Не удалось открыть заказ', err, `<button type="button" class="btn btn-primary" data-action="reload-detail" data-kind="order" data-id="${id}">${icon('refresh')}Повторить</button>`) : '<div class="skeleton"></div>'}`;
      el.detail.innerHTML = '';
      return;
    }
    m.classList.add('single');
    el.list.innerHTML = `<div class="page-head"><h1 class="page-title">Мои заказы</h1></div>${unsentHtml()}
      ${requests.length ? `<div class="detail">${requests.map((r) => `<div class="banner banner-blue">${icon('check')}<div><strong>Заявка №${esc(r.id)} получена</strong><span>Менеджер свяжется с вами и поможет с выбором.</span></div></div>`).join('')}</div>` : ''}
      ${orders.length ? `<ul class="cards">${orders.map((o) => `<li><button type="button" class="card-item" data-action="mine-open" data-id="${o.id}">${avatar('', 'site')}<span class="ci-body">
        <span class="ci-top"><span class="ci-title">Заказ №${o.id}</span><span class="ci-side">${esc(money(o.knownTotal))}</span></span>
        <span class="ci-text">${esc(o.status === 'cancelled' ? 'Заказ отменён' : STAGE_CUSTOMER[o.stage][0])}</span>
        <span class="ci-meta">${o.deliveryDate ? `<span class="chip">${icon('calendar')}${esc(relDay(o.deliveryDate))}</span>` : ''}${o.stage === 'photo' && o.photo && !o.photo.approved && !o.photo.changeRequested && o.status === 'active' ? '<span class="chip chip-gold">Посмотрите фото</span>' : ''}</span>
        </span></button></li>`).join('')}</ul>` : requests.length ? '' : emptyHtml('Пока нет заказов', 'Когда вы оформите заказ, здесь появятся этапы, фото и памятка.', `<button type="button" class="btn btn-primary" data-action="tab" data-tab="shop">${icon('gift')}Заказать</button>`)}`;
    el.detail.innerHTML = '';
  }
  function customerOrder(o) {
    const key = `order:${o.id}`;
    const [title, text] = o.status === 'cancelled' ? ['Заказ отменён', 'Если это ошибка, свяжитесь с менеджером.'] : STAGE_CUSTOMER[o.stage];
    const photo = o.photo ? `<section class="block"><h3 class="block-title">${icon('image')}Фото вашего заказа</h3>
      <figure class="photo"><img src="${esc(o.photo.url || '')}" alt="Фото вашего заказа №${o.id}"></figure>
      ${o.photo.approved ? `<div class="banner banner-ok">${icon('check')}<div>Вы подтвердили фото</div></div>` : o.photo.changeRequested ? `<div class="banner banner-gold">${icon('refresh')}<div>Вы попросили изменить — менеджер пришлёт новое фото</div></div>`
        : o.status === 'active' && o.stage === 'photo' ? `<button type="button" class="btn btn-primary btn-block" id="approve-photo" data-action="approve-photo" data-id="${o.id}"${aBusy(`${key}:approve`)}>${busyLabel(`${key}:approve`, 'Фото нравится', 'check')}</button>
          <button type="button" class="btn btn-quiet btn-block" data-action="photo-change" data-id="${o.id}">${icon('refresh')}Попросить изменить</button>${errorHtml(`${key}:approve`)}` : ''}</section>` : '';
    return `<article class="detail customer" aria-labelledby="detail-title">
      <section class="hero"><p class="eyebrow">Заказ № ${o.id}${o.createdAt ? ` · ${esc(whenText(o.createdAt))}` : ''}</p>
        <h1 class="big-stage" id="detail-title" tabindex="-1">${esc(title)}</h1><p class="lead">${esc(text)}</p></section>
      ${o.status !== 'cancelled' ? stepper(o, Object.fromEntries(Object.entries(STAGE_CUSTOMER).map(([k, v]) => [k, v[0]]))) : ''}
      ${o.guide ? `<section class="block guide"><h3 class="block-title">${icon('leaf')}Памятка по уходу</h3><p class="text-block">${esc(o.guide)}</p></section>` : ''}
      ${photo}
      <section class="block"><h3 class="block-title">${icon('bag')}Состав</h3>${itemsHtml(o)}</section>
      <section class="block"><h3 class="block-title">${icon('truck')}Получение</h3>${fulfillmentFacts(o, true)}</section>
      <section class="block"><h3 class="block-title">${icon('card')}Оплата</h3><p>${esc(o.payment === 'paid' ? 'Оплачено' : o.payment === 'deposit' ? `Предоплата ${money(o.paidKopecks)}` : 'Менеджер пришлёт ссылку на оплату')}</p></section>
      ${historyBlock(o.history, true)}
    </article>`;
  }
  function newShop() {
    // Неподтверждённый заказ этого покупателя восстанавливается с тем же телом и requestId.
    const prior = unsentList().find((a) => a.kind === 'shop' && a.snapshot);
    if (prior) return { ...prior.snapshot, items: prior.snapshot.items || [], errors: {}, busy: false, uncertain: true, attempt: prior.body, requestId: prior.id,
      error: 'Прошлая отправка заказа не подтверждена. Нажмите «Проверить сохранение» — второй заказ не создастся.' };
    const f = { requestId: uuid(), name: me().name && !/пример/i.test(me().name) ? me().name : '', contactChannel: 'telegram', contact: '', items: [], fulfillment: 'delivery', date: '', interval: '', address: '', wishes: '', consent: false, attempt: null, uncertain: false, busy: false, error: '', errors: {} };
    if (!LIVE && /пример/i.test(me().name || '')) f.name = 'Анна';
    return f;
  }
  function shopHtml() {
    if (!state.shop) state.shop = newShop();
    const f = state.shop;
    const c = CONTACT[f.contactChannel] || CONTACT.phone;
    const errs = f.errors;
    const inv = (k) => (errs[k] ? ' aria-invalid="true"' : '');
    const err = (k) => (errs[k] ? `<p class="field-error" id="e-${k}">${esc(errs[k])}</p>` : '');
    const estimate = f.items.reduce((s, it) => { const p = findPrice(it.id); return s + (p && p.priceKopecks !== null ? p.priceKopecks * it.qty : 0); }, 0);
    const lock = f.busy || f.uncertain ? ' disabled' : '';
    const intervals = options().intervals[f.fulfillment] || [];
    return `<div class="page-head"><p class="eyebrow">Palitra Love · Подольск и Москва</p><h1 class="page-title">Заказать</h1>
      <p class="lead">Выберите набор — или просто опишите, что хочется: менеджер поможет подобрать.</p></div>${unsentHtml()}
      <form class="form" id="shopForm" novalidate>
      ${f.error ? `<div class="inline-error" role="alert">${icon('alert')}<span>${esc(f.error)}</span></div>` : ''}
      <fieldset class="field"${lock}><legend>Наборы</legend>${pricePicker(f.items, 'shop')}</fieldset>
      <fieldset class="field"${lock}><legend>Как получить</legend>${fulfillmentSegs(f.fulfillment, 'shop')}
        ${f.fulfillment !== 'delivery' ? `<p class="hint">${esc(options().pickupPoint || '')}, ежедневно 09:00–21:00.</p>` : '<p class="hint">Подольск — от 350 ₽, Москва — от 650 ₽. Точную стоимость менеджер рассчитает по адресу.</p>'}</fieldset>
      ${f.items.length ? `<div class="row-2"${lock ? ' hidden' : ''}><div class="field"><label for="s-date">Дата</label><input id="s-date" type="date" data-shop="date" min="${today()}" value="${esc(f.date)}"${inv('date')}>${err('date')}</div>
        <div class="field"><label for="s-int">Время</label><select id="s-int" data-shop="interval"${inv('interval')}><option value="">Выберите</option>${intervals.map((v) => `<option${f.interval === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>${err('interval')}</div></div>
        ${f.fulfillment === 'delivery' ? `<div class="field"><label for="s-addr">Адрес доставки</label><input id="s-addr" type="text" data-shop="address" maxlength="300" autocomplete="street-address" value="${esc(f.address)}" placeholder="Город, улица, дом, подъезд"${inv('address')}${lock}>${err('address')}</div>` : ''}` : ''}
      <div class="field"><label for="s-name">Имя</label><input id="s-name" type="text" data-shop="name" maxlength="80" autocomplete="name" value="${esc(f.name)}"${inv('name')}${lock}>${err('name')}</div>
      <fieldset class="field"${lock}><legend>Как с вами связаться</legend>
        <div class="segments wrap" role="radiogroup" aria-label="Способ связи">${['telegram', 'phone', 'whatsapp', 'max'].map((k) => `<button type="button" class="seg" role="radio" aria-checked="${f.contactChannel === k}" data-action="shop-channel" data-value="${k}">${esc(k === 'phone' ? 'Позвонить' : CONTACT[k].label)}</button>`).join('')}</div>
        <input id="s-contact" type="text" inputmode="${c.inputmode}" data-shop="contact" maxlength="100" value="${esc(f.contact)}" placeholder="${esc(f.contactChannel === 'phone' ? '+7 900 000-00-00' : c.placeholder)}" aria-label="Контакт"${inv('contact')}>${err('contact')}</fieldset>
      <div class="field"><label for="s-wish">Пожелания <span class="optional">необязательно</span></label><textarea id="s-wish" data-shop="wishes" rows="3" maxlength="900" placeholder="Цвета, надпись, повод"${lock}>${esc(f.wishes)}</textarea></div>
      <label class="check"><input type="checkbox" id="s-consent" data-shop="consent"${f.consent ? ' checked' : ''}${inv('consent')}${lock}><span>Согласен(на) на обработку контактных данных для связи по этому заказу</span></label>${err('consent')}
      <div class="form-foot">${f.items.length ? `<p class="estimate"><span>Предварительно</span><strong>≈ ${esc(money(estimate))}</strong></p>` : ''}
        <button type="submit" class="btn btn-primary btn-block" id="shopSubmit"${f.busy ? ' aria-disabled="true"' : ''}>${f.busy ? '<span class="spin" aria-hidden="true"></span>Сохраняем…' : `${icon('check')}${f.uncertain ? 'Проверить сохранение' : f.items.length ? 'Оформить заказ' : 'Оставить заявку'}`}</button>
        <p class="hint">Итог и наличие подтвердит менеджер. Оплата — по ссылке менеджера после согласования.</p></div>
      </form>`;
  }

  // ---------- Общие элементы форм ----------
  function pricePicker(picked, scope) {
    const items = price();
    if (!items.length) return '<p class="muted">Прайс пока пуст.</p>';
    const groups = new Map();
    for (const p of items) { const k = p.category || 'Другое'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
    return `<div class="price-list">${[...groups].map(([cat, list2]) => `<section class="price-group"><h3>${esc(cat)}</h3>${list2.map((p) => {
      const it = picked.find((x) => x.id === p.id);
      const q = it ? it.qty : 0;
      return `<div class="price-row${q ? ' is-picked' : ''}"><span class="pr-main"><span class="pr-title">${esc(p.title)}</span><span class="pr-price">${p.priceKopecks === null ? 'цена уточняется' : esc(money(p.priceKopecks))}</span></span>
        ${q ? `<span class="qty" role="group" aria-label="Количество: ${esc(p.title)}"><button type="button" class="qty-btn" id="q-${scope}-${esc(p.id)}-m" data-action="qty" data-scope="${scope}" data-id="${esc(p.id)}" data-delta="-1" aria-label="Меньше">${icon('minus')}</button><output>${q}</output><button type="button" class="qty-btn" id="q-${scope}-${esc(p.id)}-p" data-action="qty" data-scope="${scope}" data-id="${esc(p.id)}" data-delta="1" aria-label="Больше"${q >= 20 ? ' disabled' : ''}>${icon('plus')}</button></span>`
          : `<button type="button" class="btn btn-secondary" id="q-${scope}-${esc(p.id)}-add" data-action="qty" data-scope="${scope}" data-id="${esc(p.id)}" data-delta="1" aria-label="Добавить: ${esc(p.title)}">${icon('plus')}Добавить</button>`}</div>`;
    }).join('')}</section>`).join('')}</div>`;
  }
  function fulfillmentSegs(current, scope) {
    return `<div class="choice-grid" role="radiogroup" aria-label="Способ получения">${[['delivery', 'Доставка', 'truck'], ['pickup', 'Самовывоз', 'pin'], ['courier', 'Курьер клиента', 'user']].map(([k, l, ic]) => `<button type="button" class="choice" role="radio" aria-checked="${current === k}" data-action="fulfillment" data-scope="${scope}" data-value="${k}">${icon(ic)}${esc(l)}</button>`).join('')}</div>`;
  }
  function changeQty(scope, id, delta) {
    const target = scope === 'shop' ? state.shop : state.sheet;
    if (!target || target.busy || target.uncertain) return;
    const items = target.items;
    const i = items.findIndex((x) => x.id === id);
    const q = Math.max(0, Math.min(20, (i >= 0 ? items[i].qty : 0) + delta));
    if (q === 0 && i >= 0) items.splice(i, 1); else if (i >= 0) items[i].qty = q; else if (q > 0 && findPrice(id)) items.push({ id, qty: q });
    render();
    focusSoon(document.getElementById(`q-${scope}-${id}-p`) ? `q-${scope}-${id}-p` : `q-${scope}-${id}-add`);
  }

  // ---------- Листы ----------
  const sheetTarget = (s) => `${s.kind}:${s.inquiryId || s.orderId || 'new'}`;
  function openSheet(sheet, focusId) {
    // Если прошлая такая же отправка не подтверждена — открыть именно её (то же тело и requestId), а не новую.
    const target = sheetTarget(sheet);
    const prior = unsentList().find((a) => a.kind === sheet.kind && a.target === target && a.snapshot);
    if (prior) {
      state.sheet = { ...sheet, ...prior.snapshot, busy: false, errors: {}, uncertain: true, requestId: prior.id,
        attempt: { path: prior.path, body: prior.body, ok: prior.ok }, error: 'Прошлая отправка не подтверждена. Нажмите «Проверить сохранение» — повтор не создаст дубль.' };
      // Комментарий к фото относится к тому снимку, который был показан при отправке (его версия — в теле запроса).
      // Если фото с тех пор заменили, текущий снимок не выдаётся за прошлый: картинка скрыта, есть явная пометка.
      if (sheet.kind === 'photo-change' && prior.body && prior.body.photoVersion !== sheet.photoVersion) {
        state.sheet.photoUrl = '';
        state.sheet.photoStale = true;
      }
    } else {
      state.sheet = { busy: false, uncertain: false, error: '', errors: {}, attempt: null, requestId: uuid(), ...sheet };
    }
    renderSheet();
    if (!el.sheet.open) el.sheet.showModal();
    focusSoon(prior ? 'sheetSubmit' : focusId);
  }
  // Закрыть можно и при неизвестном исходе: попытка уже сохранена и видна в списке «Проверить сохранение».
  function closeSheet() {
    if (state.sheet && state.sheet.busy) return;
    state.sheet = null;
    if (el.sheet.open) el.sheet.close();
    render();
  }
  /** После 409 — свежая карточка и её версия в листе; содержимое показывается сотруднику перед повтором. */
  async function refreshSheet(s) {
    const kind = s.orderId ? 'order' : s.inquiryId ? 'inquiry' : null;
    if (!kind) return;
    const id = s.orderId || s.inquiryId;
    await loadDetail(kind, id, { force: true });
    if (state.sheet !== s) return;
    const fresh = state.cache[kind].get(String(id));
    if (!fresh) return;
    if (s.version !== undefined) s.version = fresh.version;
    // Безопасная политика: лист перезаполняется актуальными данными карточки, правка сотрудника НЕ переносится молча
    // на новую версию — её нужно внести заново, глядя на свежие значения. Иначе повтор затёр бы чужое изменение.
    const changed = [];
    const note = (label, mine, now) => { if (String(mine ?? '') !== String(now ?? '')) changed.push(`${label}: ваше «${mine || '—'}», сейчас «${now || '—'}»`); };
    if (s.kind === 'photo-change') {
      const replaced = !fresh.photo || fresh.photo.version !== s.photoVersion;
      s.photoVersion = fresh.photo ? fresh.photo.version : null;
      s.photoUrl = fresh.photo ? fresh.photo.url || '' : '';
      s.photoStale = false;
      // Комментарий писался к прежнему снимку — к новому он не отправляется.
      s.comment = '';
      s.error = replaced ? 'Фото обновилось — посмотрите новый снимок выше. Если нужно что-то изменить, напишите заново.'
        : 'Данные заказа изменились. Проверьте фото и напишите комментарий ещё раз.';
      if (fresh.status !== 'active' || fresh.stage !== 'photo') s.error = 'Фото уже согласовано или заказ изменился — закройте окно и посмотрите заказ.';
      renderSheet();
      return;
    }
    if (fresh.status && fresh.status !== 'active' && fresh.status !== 'open') {
      s.error = `${s.error} Карточка уже ${fresh.status === 'done' ? 'выполнена' : fresh.status === 'cancelled' ? 'отменена' : fresh.status === 'converted' ? 'оформлена в заказ' : 'закрыта'}.`;
      renderSheet();
      return;
    }
    if (s.kind === 'details') {
      note('Получение', FULFILLMENT[s.fulfillment], FULFILLMENT[fresh.fulfillment]);
      note('Дата', s.date, fresh.deliveryDate); note('Время', s.interval, fresh.deliveryInterval);
      if (fresh.fulfillment === 'delivery') note('Адрес', s.address, fresh.deliveryAddress);
      note('Пожелания', s.wishes, fresh.wishes);
      Object.assign(s, { fulfillment: fresh.fulfillment, date: fresh.deliveryDate || '', interval: fresh.deliveryInterval || '',
        address: fresh.fulfillment === 'delivery' ? fresh.deliveryAddress || '' : '', wishes: fresh.wishes || '' });
    } else if (s.kind === 'items') {
      const fmt = (items) => items.map((i) => `${(findPrice(i.id) || i).title || i.id} × ${i.qty}`).join(', ');
      note('Состав', fmt(s.items), fmt(fresh.items || []));
      s.items = (fresh.items || []).filter((i) => findPrice(i.id)).map((i) => ({ id: i.id, qty: i.qty }));
    } else if (s.kind === 'payment') {
      note('Оплата', '', paymentText(fresh));
      Object.assign(s, { value: 'paid', amount: '' });
    }
    s.error = `Пока окно было открыто, карточку изменил другой сотрудник. В окне теперь актуальные данные — ваши правки не сохранены, внесите их заново.${changed.length ? ` ${changed.join('; ')}.` : ''}`;
    renderSheet();
  }
  function sheetHead(title, sub) {
    return `<div class="sheet-grip" aria-hidden="true"></div><div class="sheet-head"><div><h2 class="sheet-title" id="sheetTitle">${esc(title)}</h2>${sub ? `<p class="sheet-sub">${esc(sub)}</p>` : ''}</div>
      <button type="button" class="icon-btn" data-action="close-sheet" aria-label="Закрыть">${icon('x')}</button></div>`;
  }
  function sheetFoot(label, ic) {
    const s = state.sheet;
    return `<div class="form-foot">${s.error ? `<div class="inline-error" role="alert">${icon('alert')}<span>${esc(s.error)}</span></div>` : ''}
      <button type="submit" class="btn btn-primary btn-block" id="sheetSubmit"${s.busy ? ' aria-disabled="true"' : ''}>${s.busy ? '<span class="spin" aria-hidden="true"></span>Сохраняем…' : `${icon(s.uncertain ? 'refresh' : ic)}${esc(s.uncertain ? 'Проверить сохранение' : label)}`}</button></div>`;
  }
  const sv = (f) => (state.sheet[f] ?? '');
  const sInv = (k) => (state.sheet.errors[k] ? ' aria-invalid="true"' : '');
  const sErr = (k) => (state.sheet.errors[k] ? `<p class="field-error">${esc(state.sheet.errors[k])}</p>` : '');
  function renderSheet() {
    const s = state.sheet;
    if (!s) return;
    const lock = s.busy || s.uncertain ? ' disabled' : '';
    let html = '';
    if (s.kind === 'inquiry-new') {
      const channels = options().sourceChannels[s.source] || ['phone'];
      const c = CONTACT[s.contactChannel] || CONTACT.phone;
      const basis = options().basis || {};
      html = `${sheetHead('Новое обращение', 'Запишите кратко — полную переписку здесь хранить не нужно')}
        <form class="form" data-form="sheet" novalidate><fieldset class="form"${lock}>
        <fieldset class="field"><legend>Откуда</legend><div class="choice-grid" role="radiogroup" aria-label="Источник">${['instagram', 'telegram', 'call'].map((k) => `<button type="button" class="choice" role="radio" aria-checked="${s.source === k}" data-action="sheet-source" data-value="${k}">${icon(SOURCE[k][1])}${esc(SOURCE[k][0])}</button>`).join('')}</div></fieldset>
        <fieldset class="field"><legend>Контакт клиента</legend>
          ${channels.length > 1 ? `<div class="segments wrap" role="radiogroup" aria-label="Вид контакта">${channels.map((k) => `<button type="button" class="seg" role="radio" aria-checked="${s.contactChannel === k}" data-action="sheet-channel" data-value="${k}">${esc(k === 'phone' ? 'Телефон' : CONTACT[k].label)}</button>`).join('')}</div>` : ''}
          <input id="sh-contact" type="text" inputmode="${c.inputmode}" data-sheet="contact" maxlength="200" value="${esc(sv('contact'))}" placeholder="${esc(c.placeholder)}" aria-label="Контакт"${sInv('contact')}>
          <p class="hint">${esc(c.hint)} Без контакта обращение не сохраняется.</p>${sErr('contact')}</fieldset>
        <div class="field"><label for="sh-name">Имя <span class="optional">если уже знаете</span></label><input id="sh-name" type="text" data-sheet="name" maxlength="80" value="${esc(sv('name'))}"></div>
        <div class="field"><label for="sh-sum">Суть обращения</label><textarea id="sh-sum" data-sheet="summary" rows="3" maxlength="1000" placeholder="Что хочет клиент: повод, бюджет, дата"${sInv('summary')}>${esc(sv('summary'))}</textarea>${sErr('summary')}</div>
        <div class="field"><label for="sh-out">Итог разговора <span class="staff-only">${icon('lock')}Только команда</span></label><textarea id="sh-out" data-sheet="outcome" rows="2" maxlength="2000" placeholder="Что договорились, что отправили">${esc(sv('outcome'))}</textarea></div>
        <fieldset class="field"><legend>Как клиент обратился</legend><div class="segments wrap" role="radiogroup" aria-label="Основание">${Object.entries(basis).map(([k, v]) => `<button type="button" class="seg" role="radio" aria-checked="${s.basis === k}" data-action="sheet-set" data-field="basis" data-value="${k}">${esc(v)}</button>`).join('')}</div>${sErr('basis')}</fieldset>
        <fieldset class="field"><legend>Рассылки и напоминания</legend><div class="segments wrap" role="radiogroup" aria-label="Рассылка">${Object.entries(MARKETING).map(([k, v]) => `<button type="button" class="seg" role="radio" aria-checked="${s.marketingConsent === k}" data-action="sheet-set" data-field="marketingConsent" data-value="${k}">${esc(v)}</button>`).join('')}</div>
          <p class="hint">Отмечайте «Согласился» только если клиент сам это сказал.</p></fieldset>
        ${sheetPlanFields()}
        </fieldset>${sheetFoot('Сохранить обращение', 'check')}</form>`;
    } else if (s.kind === 'convert' || s.kind === 'details' || s.kind === 'items') {
      const intervals = options().intervals[s.fulfillment] || [];
      const showItems = s.kind !== 'details';
      const showDetails = s.kind !== 'items';
      const estimate = s.items ? s.items.reduce((sum, it) => { const p = findPrice(it.id); return sum + (p && p.priceKopecks !== null ? p.priceKopecks * it.qty : 0); }, 0) : 0;
      const title = { convert: 'Оформить заказ', items: 'Состав заказа', details: 'Получение' }[s.kind];
      const sub = { convert: 'Из этого обращения — новая заявка не создаётся', items: 'Цены — из действующего прайса', details: 'Дата, время и адрес' }[s.kind];
      html = `${sheetHead(title, sub)}<form class="form" data-form="sheet" novalidate><fieldset class="form"${lock}>
        ${showItems ? `<fieldset class="field"><legend>Состав${s.kind === 'convert' ? ' <span class="optional">можно уточнить позже</span>' : ''}</legend>${pricePicker(s.items, 'sheet')}${sErr('items')}</fieldset>` : ''}
        ${showDetails ? `<fieldset class="field"><legend>Как получить</legend>${fulfillmentSegs(s.fulfillment, 'sheet')}${s.fulfillment !== 'delivery' ? `<p class="hint">${esc(options().pickupPoint || '')}, 09:00–21:00.</p>` : ''}</fieldset>
        <div class="row-2"><div class="field"><label for="sh-date">Дата</label><input id="sh-date" type="date" data-sheet="date" min="${today()}" value="${esc(sv('date'))}"${sInv('date')}>${sErr('date')}</div>
          <div class="field"><label for="sh-int">Время</label><select id="sh-int" data-sheet="interval"><option value="">Пока не знаем</option>${intervals.map((v) => `<option${s.interval === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}${s.interval && !intervals.includes(s.interval) ? `<option selected>${esc(s.interval)}</option>` : ''}</select></div></div>
        ${s.fulfillment === 'delivery' ? `<div class="field"><label for="sh-addr">Адрес доставки <span class="optional">можно позже</span></label><input id="sh-addr" type="text" data-sheet="address" maxlength="300" value="${esc(sv('address'))}" placeholder="Город, улица, дом, подъезд"></div>` : ''}
        <div class="field"><label for="sh-wish">Пожелания клиента <span class="optional">видно клиенту</span></label><textarea id="sh-wish" data-sheet="wishes" rows="2" maxlength="1000" placeholder="Цвета, надпись, повод">${esc(sv('wishes'))}</textarea></div>` : ''}
        </fieldset>${showItems && s.items.length ? `<p class="estimate"><span>Предварительно</span><strong>≈ ${esc(money(estimate))}</strong></p>` : ''}${sheetFoot(s.kind === 'convert' ? 'Создать заказ' : 'Сохранить', 'check')}</form>`;
    } else if (s.kind === 'payment') {
      const o = state.cache.order.get(String(s.orderId)) || {};
      html = `${sheetHead('Отметить оплату', `Заказ №${s.orderId} · итог ${money(o.knownTotal)}`)}<form class="form" data-form="sheet" novalidate><fieldset class="form"${lock}>
        <div class="choice-grid" role="radiogroup" aria-label="Вид оплаты">${[['paid', 'Полностью'], ['deposit', 'Предоплата']].map(([k, l]) => `<button type="button" class="choice" role="radio" aria-checked="${s.value === k}" data-action="sheet-set" data-field="value" data-value="${k}">${icon(k === 'paid' ? 'check' : 'card')}${l}</button>`).join('')}</div>
        ${s.value === 'deposit' ? `<div class="field"><label for="sh-amount">Сумма предоплаты, ₽</label><input id="sh-amount" type="text" inputmode="decimal" data-sheet="amount" value="${esc(sv('amount'))}"${sInv('amount')}>${sErr('amount')}</div>` : `<p class="lead">Будет отмечено ${esc(money(o.knownTotal))}.</p>`}
        <p class="hint">Только отметка для команды: деньги в приложении не принимаются.</p></fieldset>${sheetFoot('Отметить оплату', 'card')}</form>`;
    } else if (s.kind === 'cancel' || s.kind === 'close') {
      const order = s.kind === 'cancel';
      const o = order ? state.cache.order.get(String(s.orderId)) || {} : {};
      html = `${sheetHead(order ? 'Отменить заказ' : 'Закрыть обращение', order ? `Заказ №${s.orderId}` : 'Без оформления заказа')}<form class="form" data-form="sheet" novalidate><fieldset class="form"${lock}>
        <div class="field"><label for="sh-reason">Причина</label><input id="sh-reason" type="text" data-sheet="reason" maxlength="300" value="${esc(sv('reason'))}" placeholder="${order ? 'Например: клиент передумал' : 'Например: только узнавал цену'}"${sInv('reason')}>${sErr('reason')}</div>
        <div class="row-quick">${(order ? ['Клиент передумал', 'Не успеваем к дате', 'Дубль заказа'] : ['Только узнавал цену', 'Не ответил', 'Уже заказал']).map((r) => `<button type="button" class="seg" data-action="sheet-set" data-field="reason" data-value="${esc(r)}">${esc(r)}</button>`).join('')}</div>
        ${order && o.paidKopecks ? `<div class="banner banner-gold">${icon('card')}<div>Оплачено ${esc(money(o.paidKopecks))}. Отметка оплаты сохранится — возврат решается отдельно.</div></div>` : ''}
        ${order ? '<p class="hint">Отменённый заказ нельзя будет изменить.</p>' : ''}</fieldset>
        <div class="form-foot">${s.error ? `<div class="inline-error" role="alert">${icon('alert')}<span>${esc(s.error)}</span></div>` : ''}
        <button type="submit" class="btn btn-block ${order ? 'btn-danger' : 'btn-primary'}" id="sheetSubmit"${s.busy ? ' aria-disabled="true"' : ''}>${s.busy ? '<span class="spin" aria-hidden="true"></span>Сохраняем…' : `${icon(s.uncertain ? 'refresh' : 'x')}${s.uncertain ? 'Проверить сохранение' : order ? 'Отменить заказ' : 'Закрыть обращение'}`}</button></div></form>`;
    } else if (s.kind === 'photo-change') {
      html = `${sheetHead('Что изменить на фото?', 'Менеджер увидит ваш комментарий')}<form class="form" data-form="sheet" novalidate><fieldset class="form"${lock}>
        ${s.photoUrl ? `<figure class="photo"><img id="sh-photo" src="${esc(s.photoUrl)}" alt="Фото, к которому относится комментарий" data-version="${esc(s.photoVersion || '')}"></figure>` : ''}
        ${s.photoStale ? `<p class="block-note" id="sh-photo-stale">${icon('alert')}<span>Этот комментарий вы писали к прошлой фотографии. С тех пор менеджер загрузил новую — нажмите «Проверить сохранение», и окно покажет, что произошло с прошлой отправкой.</span></p>` : ''}
        <div class="field"><label for="sh-comment">Комментарий</label><textarea id="sh-comment" data-sheet="comment" rows="3" maxlength="500" placeholder="Например: добавить больше золотых шаров"${sInv('comment')}>${esc(sv('comment'))}</textarea>${sErr('comment')}</div>
        </fieldset>${sheetFoot('Отправить менеджеру', 'chat')}</form>`;
    }
    el.sheetBody.innerHTML = html;
  }
  function sheetPlanFields() {
    const s = state.sheet;
    return `<div class="field"><label for="sh-who">Ответственный</label><select id="sh-who" data-sheet="assigneeId"><option value="">Пока никто</option>${staffList().map((m) => `<option value="${esc(m.id)}"${s.assigneeId === m.id ? ' selected' : ''}>${esc(m.name)}${m.id === me().id ? ' (я)' : ''}</option>`).join('')}</select></div>
      <div class="field"><label for="sh-step">Следующий шаг</label><input id="sh-step" type="text" data-sheet="nextStep" maxlength="300" value="${esc(sv('nextStep'))}" placeholder="Например: отправить примеры"></div>
      <div class="field"><span class="legend">Срок</span><div class="row-quick">${[['Сегодня', 0], ['Завтра', 1]].map(([l, n]) => `<button type="button" class="seg" data-action="sheet-set" data-field="dueDate" data-value="${addDays(today(), n)}" aria-pressed="${s.dueDate === addDays(today(), n)}">${l}</button>`).join('')}</div>
        <div class="row-2"><input id="sh-due" type="date" aria-label="Дата срока" data-sheet="dueDate" value="${esc(sv('dueDate'))}"><input id="sh-due-t" type="time" aria-label="Время срока" data-sheet="dueTime" value="${esc(sv('dueTime'))}"></div></div>`;
  }
  function dueValue(date, timeV) { return date ? (timeV ? `${date}T${timeV}` : date) : null; }

  /* Отправка листа: один requestId на попытку; при неизвестном исходе повтор с тем же телом. */
  async function submitSheet() {
    const s = state.sheet;
    if (!s || s.busy) return;
    let path, body, ok, done;
    if (!s.uncertain) {
      s.errors = {}; s.error = '';
      const built = buildSheet(s);
      if (!built) { renderSheet(); return; }
      ({ path, body, ok, done } = built);
      s.attempt = { path, body, ok, done };
    } else ({ path, body, ok, done } = s.attempt);
    s.busy = true; renderSheet(); haptic('light');
    const seq = state.seq;
    // Снимок полей листа (без фото и служебных полей) — чтобы восстановить ту же попытку после закрытия/перезагрузки.
    const snapshot = Object.fromEntries(Object.entries(s).filter(([k, v]) => typeof v !== 'function'
      && !['busy', 'attempt', 'error', 'errors', 'uncertain', 'photoUrl', 'photoStale'].includes(k)));
    try {
      // Попытка записывается ДО отправки (guardedPost) и удаляется только после подтверждённого результата.
      const res = await guardedPost(path, body, { ok, kind: s.kind, target: sheetTarget(s), snapshot, label: unsentLabel(path, body) });
      if (seq !== state.seq) return;
      if (state.sheet === s) { s.busy = false; state.sheet = null; if (el.sheet.open) el.sheet.close(); }
      if (done) done(res); else afterSave(s.kind, res);
      toast(res.replayed || res.duplicate ? 'Уже сохранено ранее — повтор не создан.' : ok);
      loadBoot({ quiet: true });
    } catch (e) {
      if (seq !== state.seq) return;
      s.busy = false;
      if (uncertain(e) && e.code !== 'ended') {
        s.uncertain = true;
        s.error = 'Не удалось подтвердить сохранение. Нажмите «Проверить сохранение» — повтор не создаст дубль. Лист можно закрыть: проверка останется в списке.';
      } else {
        // Сервер подтвердил отказ: ничего не сохранено, можно исправить и отправить новой попыткой.
        s.uncertain = false; s.attempt = null; s.requestId = uuid();
        s.error = e.message || statusText(e.status);
        if (e.status === 409) refreshSheet(s);
      }
      if (state.sheet === s) { renderSheet(); focusSoon('sheetSubmit'); } else render();
    }
  }
  function buildSheet(s) {
    const E = s.errors;
    if (s.kind === 'inquiry-new') {
      if (!String(s.contact || '').trim()) E.contact = 'Укажите контакт: без него обращение не сохранить.';
      if (!String(s.summary || '').trim()) E.summary = 'Опишите суть обращения.';
      if (!s.basis) E.basis = 'Отметьте, как клиент обратился.';
      if (Object.keys(E).length) return null;
      const body = { requestId: s.requestId, source: s.source, contactChannel: s.contactChannel, contact: s.contact.trim(), name: (s.name || '').trim(), summary: s.summary.trim(),
        outcome: (s.outcome || '').trim(), basis: s.basis, marketingConsent: s.marketingConsent, assigneeId: s.assigneeId || null, nextStep: (s.nextStep || '').trim(), dueAt: dueValue(s.dueDate, s.dueTime) };
      return { path: '/api/inquiries', body, ok: 'Обращение сохранено.', done: (res) => { setCache('inquiry', res.inquiry); state.tab = 'inquiries'; state.filter.inquiries = 'open'; state.search.inquiries = ''; select('inquiries', res.inquiry.id); } };
    }
    if (s.kind === 'convert' || s.kind === 'details' || s.kind === 'items') {
      if (s.kind === 'items' && !s.items.length) { E.items = 'Выберите хотя бы одну позицию.'; return null; }
      if (s.date && s.date < today()) { E.date = 'Дата не может быть в прошлом.'; return null; }
      const details = { fulfillment: s.fulfillment, deliveryDate: s.date || '', deliveryInterval: s.interval || '', deliveryAddress: s.fulfillment === 'delivery' ? (s.address || '').trim() : '', wishes: (s.wishes || '').trim() };
      if (s.kind === 'convert') {
        return { path: `/api/inquiries/${s.inquiryId}/action`, body: { requestId: s.requestId, action: 'convert', version: s.version, items: s.items, ...details }, ok: 'Заказ оформлен.',
          done: (res) => { setCache('inquiry', res.inquiry); if (res.orderId) { state.tab = 'orders'; state.filter.orders = 'active'; select('orders', res.orderId); } } };
      }
      const body = s.kind === 'items' ? { requestId: s.requestId, action: 'items', version: s.version, items: s.items } : { requestId: s.requestId, action: 'details', version: s.version, ...details };
      return { path: `/api/orders/${s.orderId}/action`, body, ok: s.kind === 'items' ? 'Состав сохранён.' : 'Получение сохранено.', done: (res) => setCache('order', res.order) };
    }
    if (s.kind === 'payment') {
      const o = state.cache.order.get(String(s.orderId)) || {};
      let amount = o.knownTotal;
      if (s.value === 'deposit') {
        const v = Number(String(s.amount || '').replace(/\s/g, '').replace(',', '.'));
        if (!Number.isFinite(v) || v <= 0) { E.amount = 'Укажите сумму предоплаты.'; return null; }
        amount = Math.round(v * 100);
        if (amount >= o.knownTotal) { E.amount = 'Предоплата должна быть меньше суммы заказа.'; return null; }
      }
      return { path: `/api/orders/${s.orderId}/action`, body: { requestId: s.requestId, action: 'payment', version: s.version, value: s.value, amountKopecks: amount }, ok: 'Оплата отмечена.', done: (res) => setCache('order', res.order) };
    }
    if (s.kind === 'cancel' || s.kind === 'close') {
      if (!String(s.reason || '').trim()) { E.reason = 'Укажите причину.'; return null; }
      return s.kind === 'cancel'
        ? { path: `/api/orders/${s.orderId}/action`, body: { requestId: s.requestId, action: 'cancel', version: s.version, reason: s.reason.trim() }, ok: 'Заказ отменён.', done: (res) => setCache('order', res.order) }
        : { path: `/api/inquiries/${s.inquiryId}/action`, body: { requestId: s.requestId, action: 'close', version: s.version, reason: s.reason.trim() }, ok: 'Обращение закрыто.', done: (res) => setCache('inquiry', res.inquiry) };
    }
    if (s.kind === 'photo-change') {
      if (!String(s.comment || '').trim()) { E.comment = 'Напишите, что изменить.'; return null; }
      return { path: `/api/orders/${s.orderId}/action`, body: { requestId: s.requestId, action: 'request_photo_change', photoVersion: s.photoVersion, comment: s.comment.trim() }, ok: 'Комментарий отправлен менеджеру.', done: (res) => setCache('order', res.order) };
    }
    return null;
  }

  // ---------- Действия ----------
  function select(tab, id) {
    state.selected[tab] = id;
    state.showDetail = true;
    const kind = { inquiries: 'inquiry', orders: 'order', customers: 'customer' }[tab];
    render();
    loadDetail(kind, id, { force: true });
    if (!isDesktop()) window.scrollTo({ top: 0 });
    requestAnimationFrame(() => { const t = $('#detail-title'); if (t) t.focus({ preventScroll: true }); });
  }
  function back() {
    if (isCustomer()) { state.selected.mine = null; render(); return; }
    state.showDetail = false;
    render();
    const id = state.selected[state.tab];
    requestAnimationFrame(() => { const n = document.getElementById(`item-${state.tab}-${id}`); if (n) n.focus({ preventScroll: true }); });
  }
  function openAddInquiry(prefill = {}) {
    const source = prefill.source || 'instagram';
    openSheet({ kind: 'inquiry-new', source, contactChannel: (options().sourceChannels[source] || ['phone'])[0], contact: '', name: '', summary: '', outcome: '',
      basis: source === 'call' ? 'incoming_call' : 'incoming_message', marketingConsent: 'unknown', assigneeId: me().id || '', nextStep: '', dueDate: today(), dueTime: '', ...prefill }, 'sh-contact');
  }
  function openConvert(id) {
    const i = state.cache.inquiry.get(String(id));
    if (!i) return;
    openSheet({ kind: 'convert', inquiryId: i.id, version: i.version, items: [], fulfillment: 'delivery', date: '', interval: '', address: '', wishes: '',
      refresh: () => loadDetail('inquiry', i.id, { force: true }) });
  }
  function orderAction(o, body, okText, key) {
    return mutate({ key, path: `/api/orders/${o.id}/action`, body: { requestId: uuid(), version: o.version, ...body }, ok: okText,
      done: (res) => { setCache('order', res.order); render(); }, fail: (e) => { if (e.status === 409) loadDetail('order', o.id, { force: true }); } });
  }
  function runOrderPrimary(id) {
    const o = state.cache.order.get(String(id));
    if (!o) return;
    const p = orderPrimary(o);
    if (!p) return;
    haptic('medium');
    if (p.kind === 'stage') {
      const key = `order:${o.id}:stage`;
      if (state.pending[key]) { retry(key); return; }
      orderAction(o, { action: 'stage', value: p.value }, 'Этап сохранён.', key);
    } else if (p.kind === 'payment') openPayment(o);
    else if (p.kind === 'photo') pickPhoto(o.id);
    else if (p.kind === 'items') openItems(o);
    else if (p.kind === 'details') openDetails(o);
  }
  function openPayment(o) { openSheet({ kind: 'payment', orderId: o.id, version: o.version, value: 'paid', amount: '', refresh: () => loadDetail('order', o.id, { force: true }) }); }
  function openItems(o) {
    openSheet({ kind: 'items', orderId: o.id, version: o.version, items: (o.items || []).filter((i) => findPrice(i.id)).map((i) => ({ id: i.id, qty: i.qty })), refresh: () => loadDetail('order', o.id, { force: true }) });
  }
  function openDetails(o) {
    openSheet({ kind: 'details', orderId: o.id, version: o.version, fulfillment: o.fulfillment, date: o.deliveryDate || '', interval: o.deliveryInterval || '',
      address: o.fulfillment === 'delivery' ? o.deliveryAddress || '' : '', wishes: o.wishes || '', refresh: () => loadDetail('order', o.id, { force: true }) }, 'sh-date');
  }
  let photoTarget = null;
  function pickPhoto(id) { photoTarget = id; el.photo.value = ''; el.photo.click(); }
  // Фото с телефона уменьшается до 1600 px и JPEG: быстрее загрузка и меньше 3 МБ.
  // Файл читается в data:-адрес (FileReader), а не blob:: CSP страниц разрешает только img-src 'self' data:,
  // и blob:-картинка в Chrome не загрузилась бы. CSP при этом не расширяется.
  const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  const MAX_PHOTO_INPUT = 25 * 1024 * 1024; // исходник с телефона; после уменьшения — до ~3 МБ
  function readPhotoFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const failRead = () => reject(new Error('Не удалось прочитать фото. Выберите файл ещё раз.'));
      reader.onerror = failRead;
      reader.onabort = failRead;
      reader.onload = () => {
        const value = reader.result;
        // Тип в data:-адресе должен совпасть с выбранным файлом (картинка, а не произвольные данные).
        if (typeof value === 'string' && value.startsWith(`data:${file.type};base64,`) && value.length > `data:${file.type};base64,`.length) resolve(value);
        else failRead();
      };
      reader.readAsDataURL(file);
    });
  }
  function decodePhoto(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { img.onload = img.onerror = null; resolve(img); };
      img.onerror = () => { img.onload = img.onerror = null; reject(new Error('Не удалось открыть фото. Попробуйте другой снимок.')); };
      img.src = src;
    });
  }
  async function preparePhoto(file) {
    if (!file || !PHOTO_TYPES.includes(file.type)) throw new Error('Выберите фото JPEG, PNG или WebP.');
    if (!(file.size > 0)) throw new Error('Файл пустой. Выберите другое фото.');
    if (file.size > MAX_PHOTO_INPUT) throw new Error('Фото слишком большое: выберите снимок до 25 МБ.');
    let source = await readPhotoFile(file);
    let img = await decodePhoto(source);
    const canvas = document.createElement('canvas');
    try {
      if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) throw new Error('Не удалось открыть фото. Попробуйте другой снимок.');
      const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Не удалось подготовить фото на этом устройстве.');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/jpeg', 0.86);
      if (typeof data !== 'string' || !data.startsWith('data:image/jpeg;base64,')) throw new Error('Не удалось подготовить фото на этом устройстве.');
      if (data.length > 4200000) throw new Error('Фото слишком большое.');
      return data;
    } finally {
      // Освобождаем память: исходник и холст больше не нужны.
      canvas.width = 0; canvas.height = 0;
      img = null; source = null;
    }
  }
  async function onPhoto() {
    const file = el.photo.files && el.photo.files[0];
    const id = photoTarget; photoTarget = null;
    if (!file || !id) return;
    const o = state.cache.order.get(String(id));
    if (!o) return;
    const key = `order:${o.id}:photo`;
    try {
      const dataUrl = await preparePhoto(file);
      orderAction(o, { action: 'photo', dataUrl }, 'Фото сохранено.', key);
    } catch (e) { state.errors[key] = e.message; render(); }
  }
  function savePlan(kind, id) {
    const item = state.cache[kind].get(String(id));
    if (!item) return;
    const key = `${kind}:${id}:plan`;
    if (state.pending[key]) { retry(key); return; }
    const d = (f, v) => (state.drafts[`${key}:${f}`] !== undefined ? state.drafts[`${key}:${f}`] : v);
    const date = d('date', item.due ? item.due.date : '');
    const timeV = d('time', item.due && item.due.time !== '23:59' ? item.due.time : '');
    const body = { requestId: uuid(), action: 'plan', version: item.version, assigneeId: d('assignee', item.assignee ? item.assignee.id : '') || null,
      nextStep: String(d('step', item.nextStep || '')).trim(), dueAt: dueValue(date, timeV) };
    mutate({ key, path: `/api/${kind === 'inquiry' ? 'inquiries' : 'orders'}/${id}/action`, body, ok: 'План сохранён.',
      done: (res) => { setCache(kind, res[kind]); for (const k of Object.keys(state.drafts)) if (k.startsWith(`${key}:`)) delete state.drafts[k]; },
      fail: (e) => {
        if (e.status !== 409) return;
        // Черновик плана не переносится на новую версию: поля покажут свежие данные другого сотрудника.
        for (const k of Object.keys(state.drafts)) if (k.startsWith(`${key}:`)) delete state.drafts[k];
        state.errors[key] = 'Пока вы редактировали, план изменил другой сотрудник. Показаны актуальные данные — внесите правку заново.';
        loadDetail(kind, id, { force: true });
      } });
  }
  function saveNote(kind, id) {
    const key = `${kind}:${id}:note`;
    if (state.pending[key]) { retry(key); return; }
    const text = String(state.drafts[`${key}:text`] || '').trim();
    if (!text) { state.errors[key] = 'Напишите текст заметки.'; render(); return; }
    mutate({ key, path: `/api/${kind === 'inquiry' ? 'inquiries' : 'orders'}/${id}/action`, body: { requestId: uuid(), action: 'note', text }, ok: 'Заметка добавлена.',
      done: (res) => { setCache(kind, res[kind]); delete state.drafts[`${key}:text`]; } });
  }
  function setConsent(id, value) {
    const i = state.cache.inquiry.get(String(id));
    if (!i || i.marketingConsent === value) return;
    const key = `inquiry:${id}:consent`;
    mutate({ key, path: `/api/inquiries/${id}/action`, body: { requestId: uuid(), action: 'consent', version: i.version, marketingConsent: value }, ok: 'Отметка сохранена.',
      done: (res) => setCache('inquiry', res.inquiry), fail: (e) => { if (e.status === 409) loadDetail('inquiry', id, { force: true }); } });
  }
  function reopen(id) {
    const i = state.cache.inquiry.get(String(id));
    if (!i) return;
    const key = `inquiry:${id}:reopen`;
    mutate({ key, path: `/api/inquiries/${id}/action`, body: { requestId: uuid(), action: 'reopen', version: i.version }, ok: 'Обращение снова открыто.', done: (res) => setCache('inquiry', res.inquiry) });
  }
  // retryFailed — явное повторное отправление писем, которые сервер подтвердил как НЕ отправленные (например, неверный адрес).
  async function saveEmail({ retryFailed = false } = {}) {
    const key = 'settings:email';
    if (state.busy[key] || !state.email) return;
    const d = (f, v) => (state.drafts[`${key}:${f}`] !== undefined ? state.drafts[`${key}:${f}`] : v);
    const email = String(d('email', state.email.email)).trim();
    const enabled = d('enabled', state.email.enabled) === true;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { state.errors[key] = 'Проверьте адрес почты.'; render(); return; }
    state.busy[key] = true; delete state.errors[key]; render();
    const seq = state.seq;
    try {
      const res = await api('/api/settings/email', { method: 'PUT', body: { email, enabled, ...(retryFailed ? { retryFailed: true } : {}) } });
      if (seq !== state.seq) return;
      state.email = res;
      for (const k of Object.keys(state.drafts)) if (k.startsWith(`${key}:`)) delete state.drafts[k];
      toast(retryFailed ? `Поставлено в очередь заново: ${res.recovered || 0}.`
        : res.deliveryEnabled ? 'Сохранено. Резервные письма будут отправляться.' : 'Сохранено. Письма пока не отправляются — см. состояние.');
    } catch (e) { if (seq === state.seq) state.errors[key] = e.message; }
    finally { if (seq === state.seq) { delete state.busy[key]; render(); } }
  }
  function approvePhoto(id) {
    const o = state.cache.order.get(String(id));
    if (!o || !o.photo) return;
    const key = `order:${id}:approve`;
    if (state.pending[key]) { retry(key); return; }
    haptic('medium');
    mutate({ key, path: `/api/orders/${id}/action`, body: { requestId: uuid(), action: 'approve_photo', photoVersion: o.photo.version }, ok: 'Спасибо! Фото подтверждено.',
      done: (res) => setCache('order', res.order), fail: (e) => { if (e.status === 409) loadDetail('order', id, { force: true }); } });
  }

  // Заказ покупателя: тот же контракт, что у формы сайта. Повтор после обрыва — с тем же телом.
  async function submitShop() {
    const f = state.shop;
    if (!f || f.busy) return;
    let body = f.attempt;
    if (!f.uncertain) {
      f.errors = {}; f.error = '';
      const E = f.errors;
      if (f.name.trim().length < 2) E.name = 'Укажите имя.';
      const contact = f.contact.trim();
      if (!contact) E.contact = 'Укажите контакт.';
      else if (f.contactChannel === 'telegram' && !/^@?[A-Za-z][A-Za-z0-9_]{4,31}$/.test(contact)) E.contact = 'Ник Telegram, например @username.';
      else if (['phone', 'whatsapp'].includes(f.contactChannel) && (contact.replace(/\D/g, '').length < 10 || !/^[+\d\s().-]+$/.test(contact))) E.contact = 'Номер телефона с кодом.';
      if (f.items.length) {
        if (!f.date) E.date = 'Выберите дату.';
        else if (f.date < today()) E.date = 'Дата не может быть в прошлом.';
        if (!f.interval) E.interval = 'Выберите время.';
        if (f.fulfillment === 'delivery' && !f.address.trim()) E.address = 'Укажите адрес.';
      }
      if (!f.consent) E.consent = 'Без согласия заказ не сохранить.';
      if (Object.keys(E).length) { render(); focusSoon({ name: 's-name', contact: 's-contact', date: 's-date', interval: 's-int', address: 's-addr', consent: 's-consent' }[Object.keys(E)[0]]); return; }
      const pickup = options().pickupPoint || '';
      const method = { delivery: 'Доставка', pickup: 'Самовывоз', courier: 'Курьер покупателя' }[f.fulfillment];
      const wishes = f.wishes.trim();
      body = { requestId: f.requestId, kind: f.items.length ? 'cart' : 'request', name: f.name.trim(), contactChannel: f.contactChannel,
        contact: f.contactChannel === 'telegram' ? `@${contact.replace(/^@/, '')}` : contact, items: f.items.map((i) => ({ id: i.id, qty: i.qty })),
        comment: f.items.length ? [`Способ получения: ${method}`, wishes].filter(Boolean).join('\n') : wishes, consent: true, page: `${location.origin}${location.pathname}` };
      if (f.items.length) Object.assign(body, { deliveryDate: f.date, deliveryInterval: f.interval,
        deliveryAddress: f.fulfillment === 'delivery' ? f.address.trim() : f.fulfillment === 'pickup' ? `Самовывоз: ${pickup}` : `Курьер покупателя: заберёт заказ, ${pickup}` });
      f.attempt = body;
    }
    f.busy = true; render(); haptic('medium');
    const seq = state.seq;
    const snapshot = Object.fromEntries(Object.entries(f).filter(([k]) => !['busy', 'attempt', 'error', 'errors', 'uncertain'].includes(k)));
    try {
      // Заказ записывается в «неподтверждённые» ДО отправки и удаляется только после ответа сервера.
      const res = await guardedPost('/api/orders', body, { kind: 'shop', target: 'shop:new', snapshot, label: unsentLabel('/api/orders', body) });
      if (seq !== state.seq || state.shop !== f) return;
      state.shop = null;
      await loadBoot({ quiet: true });
      if (seq !== state.seq) return;
      state.tab = 'mine';
      if (res.orderId) { state.selected.mine = res.orderId; loadDetail('order', res.orderId, { force: true }); }
      render();
      toast(res.duplicate ? 'Этот заказ уже был сохранён — повтор не создан.' : res.orderId ? 'Заказ сохранён. Менеджер свяжется с вами.' : 'Заявка сохранена. Менеджер свяжется с вами.');
    } catch (e) {
      if (seq !== state.seq || state.shop !== f) return;
      f.busy = false;
      if (uncertain(e) && e.code !== 'ended') {
        f.uncertain = true; f.error = 'Не удалось подтвердить сохранение. Нажмите «Проверить сохранение» — второй заказ не создастся.';
      } else { f.uncertain = false; f.attempt = null; f.requestId = uuid(); f.error = e.message || statusText(e.status); }
      render();
      focusSoon('shopSubmit');
    }
  }

  // ---------- Уведомления ----------
  function toast(text, error = false) {
    if (!text) return;
    const n = document.createElement('div');
    n.className = `toast-item${error ? ' is-error' : ''}`;
    n.innerHTML = `${icon(error ? 'alert' : 'check')}<span>${esc(text)}</span>`;
    el.toast.append(n);
    setTimeout(() => n.remove(), 3600);
  }
  function syncBackButton() {
    if (!tg || !tg.BackButton) return;
    try {
      const visible = Boolean(state.boot && !isDesktop() && ((isCustomer() && state.selected.mine) || (!isCustomer() && state.showDetail && state.selected[state.tab])));
      if (visible) tg.BackButton.show(); else tg.BackButton.hide();
    } catch (_) { /* старый клиент Telegram */ }
  }

  // ---------- События ----------
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-action]');
    if (!t || t.getAttribute('aria-disabled') === 'true') return;
    const a = t.dataset.action, id = t.dataset.id;
    switch (a) {
      case 'tab':
        state.tab = t.dataset.tab; state.showDetail = false;
        if (state.tab === 'summary') loadSummary();
        if (state.tab === 'mine') state.selected.mine = null;
        render(); window.scrollTo({ top: 0 }); break;
      case 'filter': state.filter[t.dataset.scope] = t.dataset.filter; render(); break;
      case 'select': select(t.dataset.tab, Number(id)); break;
      case 'back': back(); break;
      case 'retry-boot': loadBoot(); break;
      case 'reload-detail': loadDetail(t.dataset.kind, id, { force: true }); render(); break;
      case 'close-app': try { tg.close(); } catch (_) { /* недоступно */ } break;
      case 'retry': retry(t.dataset.key); break;
      case 'unsent-check': unsentCheck(id); break;
      case 'unsent-drop':
        unsentDrop(id);
        if (state.shop && state.shop.requestId === id) state.shop = null;
        for (const k of Object.keys(state.pending)) {
          if (state.pending[k].body && state.pending[k].body.requestId === id) { delete state.pending[k]; delete state.errors[k]; }
        }
        toast('Проверка убрана. Перед новой отправкой посмотрите список, чтобы не было дубля.');
        render(); break;
      case 'add-inquiry': openAddInquiry(); break;
      case 'add-inquiry-for': {
        const c = state.cache.customer.get(String(id));
        if (!c) break;
        const ch = c.customer.channel;
        const source = ch === 'instagram' ? 'instagram' : ch === 'telegram' ? 'telegram' : 'call';
        openAddInquiry({ source, contactChannel: ch, contact: c.customer.contact, name: c.customer.name, basis: 'repeat_customer' });
        break;
      }
      case 'convert': openConvert(id); break;
      case 'open-order': state.tab = 'orders'; state.filter.orders = 'all'; select('orders', Number(id)); break;
      case 'open-inquiry': state.tab = 'inquiries'; state.filter.inquiries = 'all'; select('inquiries', Number(id)); break;
      case 'close-inquiry': { const i = state.cache.inquiry.get(String(id)); if (i) openSheet({ kind: 'close', inquiryId: i.id, version: i.version, reason: '', refresh: () => loadDetail('inquiry', i.id, { force: true }) }, 'sh-reason'); break; }
      case 'reopen': reopen(id); break;
      case 'consent': setConsent(id, t.dataset.value); break;
      case 'quick-due': state.drafts[`${t.dataset.key}:date`] = t.dataset.date; render(); break;
      case 'save-plan': savePlan(t.dataset.kind, id); break;
      case 'save-note': saveNote(t.dataset.kind, id); break;
      case 'order-primary': runOrderPrimary(id); break;
      case 'edit-items': { const o = state.cache.order.get(String(id)); if (o) openItems(o); break; }
      case 'edit-details': { const o = state.cache.order.get(String(id)); if (o) openDetails(o); break; }
      case 'payment': { const o = state.cache.order.get(String(id)); if (o) openPayment(o); break; }
      case 'pick-photo': pickPhoto(id); break;
      case 'cancel-order': { const o = state.cache.order.get(String(id)); if (o) openSheet({ kind: 'cancel', orderId: o.id, version: o.version, reason: '', refresh: () => loadDetail('order', o.id, { force: true }) }, 'sh-reason'); break; }
      case 'load-summary': loadSummary(); break;
      case 'save-email': saveEmail(); break;
      case 'email-retry': saveEmail({ retryFailed: true }); break;
      case 'mine-open': state.selected.mine = Number(id); render(); loadDetail('order', id, { force: true }); window.scrollTo({ top: 0 }); break;
      case 'mine-back': state.selected.mine = null; render(); break;
      case 'approve-photo': approvePhoto(id); break;
      case 'photo-change': { const o = state.cache.order.get(String(id)); if (o && o.photo) openSheet({ kind: 'photo-change', orderId: o.id, photoVersion: o.photo.version, photoUrl: o.photo.url || '', comment: '', refresh: () => loadDetail('order', o.id, { force: true }) }, 'sh-comment'); break; }
      case 'qty': changeQty(t.dataset.scope, t.dataset.id, Number(t.dataset.delta)); break;
      case 'fulfillment': {
        const target = t.dataset.scope === 'shop' ? state.shop : state.sheet;
        if (!target || target.busy || target.uncertain) break;
        target.fulfillment = t.dataset.value;
        if (target.interval && !(options().intervals[target.fulfillment] || []).includes(target.interval)) target.interval = '';
        render(); break;
      }
      case 'shop-channel': if (state.shop && !state.shop.busy && !state.shop.uncertain) { state.shop.contactChannel = t.dataset.value; render(); focusSoon('s-contact'); } break;
      case 'close-sheet': closeSheet(); break;
      case 'sheet-source': {
        const s = state.sheet; if (!s || s.busy || s.uncertain) break;
        s.source = t.dataset.value;
        const allowed = options().sourceChannels[s.source] || ['phone'];
        if (!allowed.includes(s.contactChannel)) s.contactChannel = allowed[0];
        s.basis = s.source === 'call' ? 'incoming_call' : s.basis === 'incoming_call' ? 'incoming_message' : s.basis;
        renderSheet(); break;
      }
      case 'sheet-channel': if (state.sheet && !state.sheet.busy && !state.sheet.uncertain) { state.sheet.contactChannel = t.dataset.value; renderSheet(); focusSoon('sh-contact'); } break;
      case 'sheet-set': if (state.sheet && !state.sheet.busy && !state.sheet.uncertain) { state.sheet[t.dataset.field] = t.dataset.value; delete state.sheet.errors[t.dataset.field === 'dueDate' ? 'due' : t.dataset.field]; renderSheet(); } break;
      default: break;
    }
  });
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.dataset.search) { state.search[t.dataset.search] = t.value; const box = el.list; withFocus(() => { box.innerHTML = listHtml(); }); return; }
    if (t.dataset.draft) { state.drafts[t.dataset.draft] = t.type === 'checkbox' ? t.checked : t.value; return; }
    if (t.dataset.sheet && state.sheet) { state.sheet[t.dataset.sheet] = t.value; return; }
    if (t.dataset.shop && state.shop) { state.shop[t.dataset.shop] = t.type === 'checkbox' ? t.checked : t.value; if (state.shop.errors[t.dataset.shop]) { delete state.shop.errors[t.dataset.shop]; t.removeAttribute('aria-invalid'); } }
  });
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t === el.photo) { onPhoto(); return; }
    if (t.dataset.draft) state.drafts[t.dataset.draft] = t.type === 'checkbox' ? t.checked : t.value;
    if (t.dataset.sheet && state.sheet) state.sheet[t.dataset.sheet] = t.value;
    if (t.dataset.shop && state.shop) state.shop[t.dataset.shop] = t.type === 'checkbox' ? t.checked : t.value;
  });
  document.addEventListener('submit', (ev) => {
    if (ev.target.id === 'shopForm') { ev.preventDefault(); submitShop(); return; }
    if (ev.target.dataset.form === 'sheet') { ev.preventDefault(); submitSheet(); }
  });
  el.sheet.addEventListener('cancel', (ev) => { if (state.sheet && state.sheet.busy) ev.preventDefault(); else { state.sheet = null; render(); } });
  el.sheet.addEventListener('click', (ev) => { if (ev.target === el.sheet) closeSheet(); });
  desktop.addEventListener('change', () => render());
  if (tg && tg.BackButton) { try { tg.BackButton.onClick(() => back()); } catch (_) { /* старый клиент */ } }
  window.addEventListener('palitra:session-ended', () => {
    state.seq++; state.boot = null; state.ended = true; state.loading = false; state.sheet = null; state.shop = null;
    state.cache = { inquiry: new Map(), order: new Map(), customer: new Map() };
    state.bootError = 'Сессия завершена. Откройте приложение заново.';
    render();
  });
  if (el.actor) {
    el.actor.value = state.actor;
    el.actor.addEventListener('change', () => {
      state.actor = el.actor.value;
      try { sessionStorage.setItem('palitra-demo-actor', state.actor); } catch (_) { /* недоступно */ }
      state.seq++;
      Object.assign(state, { boot: null, loading: true, tab: null, showDetail: false, sheet: null, shop: null, summary: null, email: null, busy: {}, errors: {}, pending: {}, drafts: {} });
      state.selected = { inquiries: null, orders: null, customers: null, mine: null };
      state.cache = { inquiry: new Map(), order: new Map(), customer: new Map() };
      if (el.sheet.open) el.sheet.close();
      loadBoot();
    });
  }
  loadBoot();
})();

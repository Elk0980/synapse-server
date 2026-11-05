/* Съёмка (№98 · В): разбор сценария и расписание. Чистые функции без DOM и сети —
   общие для экрана, суфлёра и «Поделиться». Формат сценария (агент Б, полный вид плана):
   строка «Имя: реплика» — реплика актёра; «[…]», «Вставка:», «B-roll:» — вставка;
   «Реквизит:» — реквизит; остальное — действие. Без ролей — весь текст без выбора актёра. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SbShooting = root.SbShooting || {}).script = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  'use strict';
  const INSERT = /^(?:вставка|b-?roll|перебивка)\s*[:—-]\s*/i;
  const PROPS = /^реквизит\s*[:—-]\s*/i;
  const ACTION = /^(?:действие|кадр|план|титр|текст на экране|звук|музыка|хук)\s*[:—-]\s*/i;
  const LINE = /^([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9 .'’-]{0,39})\s*:\s*(.+)$/;
  const WEEKDAYS = ['', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
  const SHORT = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

  function parse(script, fallback = {}) {
    const frames = [], props = [], actors = [];
    const lines = String(script || '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);
    for (const raw of lines) {
      let match;
      if (PROPS.test(raw)) {
        const items = raw.replace(PROPS, '').split(/[,;]/).map((item) => item.trim()).filter(Boolean);
        props.push(...items);
        if (frames.length) frames[frames.length - 1].props.push(...items);
        continue;
      }
      if (/^\[.*\]$/.test(raw) || INSERT.test(raw)) {
        frames.push({type: 'insert', actor: '', text: raw.replace(/^\[|\]$/g, '').replace(INSERT, '').trim(), props: []});
      } else if (!ACTION.test(raw) && (match = LINE.exec(raw))) {
        const actor = match[1].trim();
        if (!actors.includes(actor)) actors.push(actor);
        frames.push({type: 'line', actor, text: match[2].trim(), props: []});
      } else {
        frames.push({type: 'action', actor: '', text: raw.replace(ACTION, '').trim() || raw, props: []});
      }
    }
    if (!frames.length) {
      if (fallback.hook) frames.push({type: 'action', actor: '', text: `Хук (первые 1–2 с): ${fallback.hook}`, props: []});
      if (fallback.topic) frames.push({type: 'action', actor: '', text: fallback.topic, props: []});
    }
    frames.forEach((frame, index) => { frame.n = index + 1; });
    return {frames, actors, props: [...new Set(props)], hasRoles: actors.length > 0, source: lines.length ? 'script' : 'hook'};
  }

  const day = (value) => {
    const time = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(time) ? new Date(time) : null;
  };
  const iso = (date) => date.toISOString().slice(0, 10);
  const isoWeekday = (date) => ((date.getUTCDay() + 6) % 7) + 1;

  /* Дедлайн = дата выхода − deadlineDays; день съёмки — последний из shootingWeekdays не позже
     дедлайна. Нет настроек — честно «не задано», а не выдуманная дата. */
  function schedule(publishDate, settings = {}) {
    const publish = day(publishDate);
    if (!publish) return {publishDate: '', deadline: '', shootDate: '', weekday: '', configured: false};
    const days = Number.isInteger(settings.deadlineDays) ? settings.deadlineDays : null;
    const weekdays = Array.isArray(settings.shootingWeekdays) ? settings.shootingWeekdays.filter((d) => d >= 1 && d <= 7) : [];
    const deadline = days === null ? null : new Date(publish.getTime() - days * 86400000);
    let shoot = null;
    if (deadline && weekdays.length) {
      for (let back = 0; back < 7; back += 1) {
        const candidate = new Date(deadline.getTime() - back * 86400000);
        if (weekdays.includes(isoWeekday(candidate))) { shoot = candidate; break; }
      }
    }
    return {publishDate: iso(publish), deadline: deadline ? iso(deadline) : '', shootDate: shoot ? iso(shoot) : '',
      weekday: shoot ? WEEKDAYS[isoWeekday(shoot)] : '', weekdayShort: shoot ? SHORT[isoWeekday(shoot)] : '',
      configured: days !== null && weekdays.length > 0};
  }

  /* Согласованные рилсы плана по порядку. Согласование — версия площадки approved или
     согласованная версия плана целиком; статус производства из PR 496, иначе из загрузок. */
  function reels(snapshot, uploads = {}) {
    const days = snapshot?.plan?.days || [];
    const approvedIdeas = new Set((snapshot?.variants || []).filter((v) => v.status === 'approved').map((v) => v.ideaId));
    const wholePlan = snapshot?.approval?.status === 'approved';
    const order = days.map((idea, index) => ({idea, index})).filter(({idea}) => idea.format === 'reel' && (wholePlan || approvedIdeas.has(idea.ideaId)));
    order.sort((a, b) => String(a.idea.date).localeCompare(String(b.idea.date)) || a.index - b.index);
    return order.map(({idea}, index) => {
      const stored = uploads[idea.ideaId] || {};
      const production = {shot: 'shot', editing: 'editing', draft: 'draft'}[idea.productionStatus];
      return {number: index + 1, idea, status: stored.manualStatus || production || stored.status || 'approved',
        takes: stored.takes || 0, drafts: stored.drafts || 0};
    });
  }

  const STATUS = {approved: 'согласовано', shot: 'снято', editing: 'в монтаже', draft: 'черновик'};

  /* Текст для актёра: его реплики жирным и с «▶ ИМЯ». bold — '**' (Telegram, MAX), '*' (WhatsApp)
     или '' (VK не размечает текст — остаётся только ▶). */
  function shareText(parsed, actor, {title = '', bold = '**'} = {}) {
    const out = [];
    if (title) out.push(title);
    if (actor) out.push(`Реплики: ${actor}`);
    if (out.length) out.push('');
    for (const frame of parsed.frames) {
      if (frame.type === 'line' && frame.actor === actor) out.push(`${bold}▶ ${actor.toUpperCase()}: ${frame.text}${bold}`);
      else if (frame.type === 'line') out.push(`${frame.actor}: ${frame.text}`);
      else if (frame.type === 'insert') out.push(`[Вставка: ${frame.text}]`);
      else out.push(`(${frame.text})`);
    }
    if (parsed.props.length) out.push('', `Реквизит: ${parsed.props.join(', ')}`);
    return out.join('\n');
  }

  return {parse, schedule, reels, shareText, STATUS, WEEKDAYS};
});

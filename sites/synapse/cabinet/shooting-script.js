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
  /* «Сценарий по секундам» из Google Таблицы (макет 07.11): «0–2 с | Кто | Реплика | В кадре | Действие | Титр»
     или время в начале строки. «ДО СЪЁМКИ: …» — подготовка, не сцена. */
  const TIME = /^(\d+(?:[.,]\d+)?(?:\s*[–—-]\s*\d+(?:[.,]\d+)?)?\s*с(?:ек)?\.?)(?:\s*[·|:—–-]\s*|\s+)/i;
  const BEFORE = /^до\s+съ[её]мки\s*[:—-]\s*/i;
  const SHOT = /^(?:в кадре|кадр)\s*[:—-]\s*/i;
  const TITLE = /^(?:титр|текст на экране)\s*[:—-]\s*/i;
  const NO_ACTOR = /^(?:—|-|–|нет)?$/i;

  function tableRow(raw) {
    const cells = raw.split('|').map((cell) => cell.trim());
    if (!TIME.test(`${cells[0]} `)) cells.unshift('');
    const [time, who, text, shot, action, title] = cells.map((cell) => cell || '');
    const actor = NO_ACTOR.test(who) ? '' : who;
    const type = actor && text ? 'line' : 'action';
    return {type, actor: type === 'line' ? actor : '', text: text || shot || action || title, props: [],
      time: time.replace(/\s*[|·:—–-]\s*$/, ''), shot, action, title};
  }

  function parse(script, fallback = {}) {
    const frames = [], props = [], actors = [], before = [];
    const lines = String(script || '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);
    for (const original of lines) {
      let match, raw = original;
      if (BEFORE.test(raw)) { before.push(raw.replace(BEFORE, '').trim()); continue; }
      if (raw.includes('|') && raw.split('|').length >= 3) {
        const frame = tableRow(raw);
        if (frame.type === 'line' && !actors.includes(frame.actor)) actors.push(frame.actor);
        frames.push(frame);
        continue;
      }
      const time = TIME.exec(raw);
      if (time) raw = raw.slice(time[0].length).trim();
      // «В кадре:» и «Титр:» сразу после сцены дополняют её, а не становятся отдельной сценой.
      const last = frames[frames.length - 1];
      if (!time && last && SHOT.test(raw) && !last.shot) { last.shot = raw.replace(SHOT, '').trim(); continue; }
      if (!time && last && TITLE.test(raw) && !last.title) { last.title = raw.replace(TITLE, '').trim(); continue; }
      const meta = {time: time ? time[1] : '', shot: '', action: '', title: ''};
      if (PROPS.test(raw)) {
        const items = raw.replace(PROPS, '').split(/[,;]/).map((item) => item.trim()).filter(Boolean);
        props.push(...items);
        if (frames.length) frames[frames.length - 1].props.push(...items);
        continue;
      }
      if (/^\[.*\]$/.test(raw) || INSERT.test(raw)) {
        frames.push({...meta, type: 'insert', actor: '', text: raw.replace(/^\[|\]$/g, '').replace(INSERT, '').trim(), props: []});
      } else if (!ACTION.test(raw) && (match = LINE.exec(raw))) {
        const actor = match[1].trim();
        if (!actors.includes(actor)) actors.push(actor);
        frames.push({...meta, type: 'line', actor, text: match[2].trim(), props: []});
      } else {
        frames.push({...meta, type: 'action', actor: '', text: raw.replace(ACTION, '').trim() || raw, props: []});
      }
    }
    if (!frames.length) {
      const empty = {time: '', shot: '', action: '', title: ''};
      if (fallback.hook) frames.push({...empty, type: 'action', actor: '', text: `Хук (первые 1–2 с): ${fallback.hook}`, props: []});
      if (fallback.topic) frames.push({...empty, type: 'action', actor: '', text: fallback.topic, props: []});
    }
    frames.forEach((frame, index) => { frame.n = index + 1; });
    return {frames, actors, props: [...new Set(props)], before, hasRoles: actors.length > 0, source: lines.length ? 'script' : 'hook'};
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

  /* Что снимается (№121). Видео-позиция плана: формат идеи или любой её версии — Reels или
     сторис (по стандарту материалов это ролики), площадка только для видео (TikTok, Shorts) либо
     у строки есть сценарий по ролям или «Кто снимает». Фото-пост без сценария в съёмку не идёт.
     Хью может поставить строке «Instagram / Reels» формат post/story — рилс от этого не теряется. */
  const VIDEO_FORMATS = new Set(['reel', 'story']);
  const VIDEO_PLATFORMS = new Set(['tiktok', 'youtube_shorts', 'youtube']);
  const FORMAT_LABEL = {reel: 'Рилс', story: 'Сторис', post: 'Пост', carousel: 'Карусель'};
  const filled = (value) => String(value ?? '').trim() !== '';
  function isVideo(idea = {}) {
    const versions = Object.entries(idea.variants && typeof idea.variants === 'object' ? idea.variants : {});
    const formats = [idea.format, ...versions.map(([, variant]) => variant?.format)].filter(Boolean);
    const platforms = [idea.platform, ...versions.map(([platform]) => platform)].filter(Boolean);
    return formats.some((format) => VIDEO_FORMATS.has(format)) || platforms.some((platform) => VIDEO_PLATFORMS.has(platform))
      || filled(idea.script) || filled(idea.filmingBy);
  }
  /* Подпись позиции: «Рилс», «Сторис»; пост/карусель со сценарием — «Видео», чтобы не путать с фото. */
  const kindLabel = (idea = {}) => VIDEO_FORMATS.has(idea.format) ? FORMAT_LABEL[idea.format] : 'Видео';

  /* Согласованные видео-позиции плана по порядку. Номер — номер строки в Контент-плане (№ в плане),
     а не порядковый среди отобранных. Согласование — версия площадки approved или согласованная
     версия плана целиком; статус производства из PR 496, иначе из загрузок. */
  function reels(snapshot, uploads = {}) {
    const days = snapshot?.plan?.days || [];
    const approvedIdeas = new Set((snapshot?.variants || []).filter((v) => v.status === 'approved').map((v) => v.ideaId));
    const wholePlan = snapshot?.approval?.status === 'approved';
    /* Этап с сервера (specs/209): идея дальше «сценария» (запланировано, снято, монтаж…) — уже в работе съёмки,
       даже если в плане не стоит галочка согласования (так было у ранних рилсов). */
    const PAST_SCRIPT = new Set(['planned', 'shot', 'editing', 'edit_review', 'edit_rework', 'ready', 'scheduled']);
    const order = days.map((idea, index) => ({idea, index})).filter(({idea}) => isVideo(idea) && (wholePlan || approvedIdeas.has(idea.ideaId) || PAST_SCRIPT.has(idea.stage)));
    order.sort((a, b) => String(a.idea.date).localeCompare(String(b.idea.date)) || a.index - b.index);
    return order.map(({idea, index}) => {
      const stored = uploads[idea.ideaId] || {};
      const production = {shot: 'shot', editing: 'editing', draft: 'draft'}[idea.productionStatus];
      return {number: index + 1, kind: kindLabel(idea), idea, status: stored.manualStatus || production || stored.status || 'approved',
        takes: stored.takes || 0, drafts: stored.drafts || 0};
    });
  }

  const STATUS = {approved: 'согласовано', shot: 'снято', editing: 'в монтаже', draft: 'черновик'};
  /* Этап общей цепочки CfKit (решение Влада 07.11; «Снимается» нет). Сервер съёмки знает только
     approved/shot/editing/draft: согласованный рилс ждёт съёмки — «Запланировано», загружен черновик
     монтажа — «Монтаж на согласовании». Если план однажды начнёт отдавать idea.stage, берётся он. */
  const STAGE = {approved: 'planned', shot: 'shot', editing: 'editing', draft: 'edit_review'};
  const STAGE_LABEL = {planned: 'Запланировано', shot: 'Отснято', editing: 'В монтаже', edit_review: 'Монтаж на согласовании',
    edit_rework: 'Монтаж на доработке', ready: 'Готово к выходу', scheduled: 'Запланировано к выходу', published: 'Опубликовано',
    publish_error: 'Ошибка публикации', unpublished: 'Снято с публикации'};
  const stageOf = (reel = {}) => (STAGE_LABEL[reel.idea?.stage] ? reel.idea.stage : STAGE[reel.status] || 'planned');
  /* На «Съёмке» только то, что ещё снимать и монтировать: опубликованное и снятое с публикации
     не показывается, готовое/запланированное к выходу — после даты выхода. Сегодняшняя дата — строкой YYYY-MM-DD. */
  function onShoot(reel, today) {
    const stage = stageOf(reel);
    if (stage === 'published' || stage === 'unpublished') return false;
    // Сервер ещё не отдал этап, но площадка уже вернула публикацию — рилс вышел, снимать нечего.
    if (!reel.idea?.stage && (reel.idea?.publications || []).some((item) => item?.status === 'published')) return false;
    if ((stage === 'ready' || stage === 'scheduled') && reel.idea?.date && reel.idea.date < today) return false;
    return true;
  }

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

  return {parse, schedule, reels, isVideo, kindLabel, shareText, STATUS, STAGE, STAGE_LABEL, stageOf, onShoot, WEEKDAYS};
});

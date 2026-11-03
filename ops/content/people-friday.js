'use strict';

// Чистое чтение DTO /media-mentor: модуль не хранит правила и ничего не отправляет.
const METRICS = Object.freeze(['pendingIdeas', 'approvedIdeas']);
const DAY_MS = 86400000;
const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };
const badSnapshot = () => { throw Object.assign(new Error('Некорректная сводка контент-плана'), { status: 502 }); };
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;

function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value ? at : null;
}

function localCalendar(now, timezone) {
  if (typeof timezone !== 'string' || !timezone || timezone !== timezone.trim()) invalid('Укажите часовой пояс правила');
  const at = now instanceof Date ? now.valueOf()
    : typeof now === 'number' ? now
      : typeof now === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(now) ? Date.parse(now) : NaN;
  if (!Number.isFinite(at)) invalid('Укажите точное время проверки');
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  } catch { invalid('Неизвестный часовой пояс правила'); }
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const localDate = `${values.year}-${values.month}-${values.day}`;
  const localDay = day(localDate);
  if (localDay === null) invalid('Дата проверки вне поддерживаемого диапазона');
  return { localDate, isFriday: new Date(localDay).getUTCDay() === 5 };
}

function nextWeekStart({ now, timezone } = {}) {
  const { localDate } = localCalendar(now, timezone);
  const at = day(localDate), weekday = new Date(at).getUTCDay();
  const nextMonday = new Date(at + (7 - ((weekday + 6) % 7)) * DAY_MS).toISOString().slice(0, 10);
  if (day(nextMonday) === null) invalid('Следующая неделя вне поддерживаемого диапазона');
  return nextMonday;
}

function fridaySummary(snapshot, { now, timezone, metric, weekStart } = {}) {
  if (!METRICS.includes(metric)) invalid('Выберите метрику pendingIdeas или approvedIdeas');
  const start = day(weekStart);
  if (start === null) invalid('Укажите дату начала семи дней: YYYY-MM-DD');
  const weekEnd = new Date(start + 6 * DAY_MS).toISOString().slice(0, 10);
  if (day(weekEnd) === null) invalid('Интервал вне поддерживаемого диапазона');
  const calendar = localCalendar(now, timezone);
  if (!object(snapshot) || typeof snapshot.companyCode !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(snapshot.companyCode)
    || !object(snapshot.brief) || !Number.isSafeInteger(snapshot.brief.revision) || snapshot.brief.revision < 0 || !Array.isArray(snapshot.variants)) badSnapshot();
  const result = {
    companyCode: snapshot.companyCode, ...calendar, timezone, weekStart, weekEnd, metric,
    pendingIdeas: 0, approvedIdeas: 0, count: 0, available: true, reason: ''
  };
  if (snapshot.plan === null) return result;
  const plan = snapshot.plan;
  if (!object(plan) || !positive(plan.revision) || !positive(plan.briefRevision) || !Array.isArray(plan.days)) badSnapshot();
  if (plan.briefRevision !== snapshot.brief.revision) return { ...result, available: false, reason: 'stale_brief' };

  // Решение берётся только для действующей ревизии конкретной версии площадки.
  const states = new Map();
  for (const state of snapshot.variants) {
    if (!object(state) || typeof state.ideaId !== 'string' || typeof state.platform !== 'string' || !positive(state.contentRevision)) badSnapshot();
    const key = JSON.stringify([state.ideaId, state.platform, state.contentRevision]);
    const previous = states.get(key);
    if (previous && (previous.status !== state.status || previous.decision !== state.decision || previous.approvable !== state.approvable)) badSnapshot();
    states.set(key, state);
  }
  const ideas = new Map();
  const current = new Map();
  for (const idea of plan.days) {
    if (!object(idea) || typeof idea.ideaId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(idea.ideaId)
      || day(idea.date) === null || !object(idea.variants)) badSnapshot();
    for (const [platform, variant] of Object.entries(idea.variants)) {
      if (!object(variant) || !positive(variant.contentRevision) || typeof variant.text !== 'string') badSnapshot();
      const pair = JSON.stringify([idea.ideaId, platform]);
      const prior = current.get(pair);
      if (prior !== undefined && prior !== variant.contentRevision) badSnapshot();
      current.set(pair, variant.contentRevision);
      if (variant.excluded === true || !variant.text.trim()) continue;
      const date = variant.plannedDate || idea.date;
      if (day(date) === null) badSnapshot();
      if (date < weekStart || date > weekEnd) continue;
      const state = states.get(JSON.stringify([idea.ideaId, platform, variant.contentRevision]));
      const item = ideas.get(idea.ideaId) || { allApproved: true, pending: false };
      // Отсутствующее/устаревшее решение нельзя считать согласованным или ожидающим.
      if (!state || state.approvable !== true) {
        item.allApproved = false;
        ideas.set(idea.ideaId, item);
        continue;
      }
      const approved = state.status === 'approved' && state.decision === 'approved';
      const pending = state.status === 'pending' && (state.decision === null || state.decision === 'withdrawn');
      const rejected = state.status === 'rejected' && state.decision === 'rejected';
      if (!approved && !pending && !rejected) badSnapshot();
      item.allApproved = item.allApproved && approved;
      item.pending = item.pending || pending;
      ideas.set(idea.ideaId, item);
    }
  }
  for (const idea of ideas.values()) {
    if (idea.allApproved) result.approvedIdeas++;
    if (idea.pending) result.pendingIdeas++;
  }
  result.count = result[metric];
  return result;
}

function fridayEvent(summary, { slot, minimum = 7, weekday = 5 } = {}) {
  if (!['morning', 'evening'].includes(slot)) invalid('Выберите утро или вечер проверки');
  if (!Number.isSafeInteger(minimum) || minimum < 1) invalid('Минимум должен быть положительным целым числом');
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) invalid('Выберите день недели от 0 до 6');
  if (!object(summary) || !METRICS.includes(summary.metric) || !Number.isSafeInteger(summary.count) || summary.count < 0
    || !Number.isSafeInteger(summary.approvedIdeas) || summary.approvedIdeas < 0
    || !Number.isSafeInteger(summary.pendingIdeas) || summary.pendingIdeas < 0
    || summary.count !== summary[summary.metric] || typeof summary.available !== 'boolean'
    || day(summary.localDate) === null || day(summary.weekStart) === null || day(summary.weekEnd) === null
    || typeof summary.companyCode !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(summary.companyCode)) invalid('Некорректный результат проверки пятницы');
  if (!summary.available || new Date(day(summary.localDate)).getUTCDay() !== weekday || slot === 'evening' && summary.count >= minimum) return null;
  const title = 'Контент-план на согласование';
  return {
    companyCode: summary.companyCode, localDate: summary.localDate, slot, metric: summary.metric,
    count: summary.count, approvedIdeas: summary.approvedIdeas, pendingIdeas: summary.pendingIdeas,
    minimum, weekday, weekStart: summary.weekStart, weekEnd: summary.weekEnd,
    title, body: `Согласовано ${summary.approvedIdeas} из ${minimum}, на согласовании ${summary.pendingIdeas}.`,
    // Получатель дополняется очередью; смена явного интервала/метрики имеет свой ключ.
    eventKey: `people-friday:${summary.companyCode}:${summary.localDate}:${slot}:${summary.metric}:${summary.weekStart}`
  };
}

module.exports = { fridaySummary, fridayEvent, nextWeekStart };

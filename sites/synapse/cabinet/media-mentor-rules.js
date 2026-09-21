(() => {
  'use strict';
  /* Механические правила курса «Аудитория через короткий контент» — те, что проверяются
     кодом и не требуют ни модели, ни человека (раздел 10 конспекта курса).
     Здесь только расписание и состав плана. Решения — для кого снимать, запуск аккаунта,
     перезапуск, истории — принимает человек; система про них напоминает, но не судит.

     Чего этот модуль НЕ делает: не обещает просмотры и глубину просмотра. Пороги курса —
     условия площадки, а не наше обязательство клиенту. */
  const sb = window.SbCabinet = window.SbCabinet || {};

  /* Короткий вертикальный контент на набор аудитории. Остальные форматы живут
     по другим правилам: пост и карусель публикуются в любой день. */
  const SHORT_FORMATS = ['reel'];
  const REACH_ROLE = 'reach';
  /* Воскресенье, вторник, четверг. Два дня подряд курс запрещает прямо,
     пятница и суббота названы худшими днями. */
  const GOOD_DAYS = [0, 2, 4];
  const WORST_DAYS = [5, 6];
  const DAY_NAMES = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  const REACH_PER_WEEK = 3;
  /* Форматов немного и посильных: лучше несколько, которые выполняются регулярно,
     чем широкий набор, который срывается. */
  const MAX_FORMATS = 4;

  const parseDate = (value) => {
    const time = Date.parse(`${String(value || '')}T00:00:00Z`);
    return Number.isFinite(time) ? new Date(time) : null;
  };
  const dayIndex = (date) => date.getUTCDay();
  /* Неделя считается от воскресенья, а не от понедельника. Курс ставит ролики
     в порядке вс → вт → чт, и при отсчёте от понедельника воскресенье уезжало бы
     в прошлую неделю: три ролика одного цикла считались бы за два разных. */
  const weekKey = (date) => {
    const shifted = new Date(date.getTime());
    shifted.setUTCDate(shifted.getUTCDate() - shifted.getUTCDay());
    return shifted.toISOString().slice(0, 10);
  };
  const human = (value) => {
    const date = parseDate(value);
    return date ? date.toLocaleDateString('ru-RU') : String(value || '');
  };

  const isReach = (item) => SHORT_FORMATS.includes(item.format) && item.role === REACH_ROLE;

  /* Замечания двух видов. «Нарушение» — правило курса нарушено прямо и это видно из плана.
     «Напоминание» — решение за человеком, план сам по себе не ошибочен. */
  function review(plan) {
    const issues = [];
    const add = (level, date, text) => issues.push({level, date: date || null, text});
    const days = Array.isArray(plan?.days) ? plan.days : [];
    if (!days.length) return {issues, checked: 0, ok: false, reason: 'План пуст: проверять нечего'};

    const dated = days
      .map((item) => ({item, date: parseDate(item.date)}))
      .filter((entry) => entry.date)
      .sort((a, b) => a.date - b.date);

    const reach = dated.filter((entry) => isReach(entry.item));

    for (const entry of reach) {
      const index = dayIndex(entry.date);
      if (WORST_DAYS.includes(index)) {
        add('violation', entry.item.date,
          `${human(entry.item.date)} — ${DAY_NAMES[index]}: курс называет этот день худшим для роликов на набор.`);
      } else if (!GOOD_DAYS.includes(index)) {
        add('warning', entry.item.date,
          `${human(entry.item.date)} — ${DAY_NAMES[index]}: по курсу ролики на набор ставятся в воскресенье, вторник и четверг.`);
      }
    }

    for (let i = 1; i < reach.length; i += 1) {
      const gap = (reach[i].date - reach[i - 1].date) / 86400000;
      if (gap === 1) {
        add('violation', reach[i].item.date,
          `${human(reach[i - 1].item.date)} и ${human(reach[i].item.date)} — два дня подряд: ` +
          'по курсу такие ролики набирают заметно хуже.');
      }
    }

    const byWeek = new Map();
    for (const entry of reach) {
      const key = weekKey(entry.date);
      byWeek.set(key, (byWeek.get(key) || 0) + 1);
    }
    for (const [key, count] of byWeek) {
      if (count > REACH_PER_WEEK) {
        add('warning', key, `Неделя с ${human(key)}: роликов на набор ${count}, ` +
          `по курсу регулярный режим — ${REACH_PER_WEEK} в неделю.`);
      }
    }

    /* Пустая неделя внутри плана — это пропуск публикаций, а курс запрещает их пропускать.
       Недели считаются по всему окну плана, а не только по тем, где что-то стоит. */
    if (dated.length) {
      const weeks = new Set();
      const cursor = new Date(dated[0].date.getTime());
      const last = dated[dated.length - 1].date;
      while (cursor <= last) {
        weeks.add(weekKey(cursor));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      for (const key of weeks) {
        if (!byWeek.get(key)) {
          add('warning', key, `Неделя с ${human(key)}: ни одного ролика на набор. ` +
            'Пропускать публикации курс не разрешает.');
        }
      }
    }

    const formats = new Set(days.map((item) => item.format).filter(Boolean));
    if (formats.size > MAX_FORMATS) {
      add('warning', null, `Форматов в плане ${formats.size}. Курс советует не больше ${MAX_FORMATS}: ` +
        'лучше несколько, которые выполняются регулярно, чем широкий набор, который срывается.');
    }

    const noRole = dated.filter((entry) => !entry.item.role);
    for (const entry of noRole) {
      add('violation', entry.item.date,
        `${human(entry.item.date)}: у публикации нет роли. Публикация без роли не планируется.`);
    }

    if (!reach.length) {
      add('warning', null, 'В плане нет ни одного ролика на набор аудитории: ' +
        'короткий контент — единственный источник новых людей.');
    }

    return {issues, checked: days.length, ok: issues.length === 0, reason: ''};
  }

  /* Напоминания о решениях человека: система их не проверяет и не считает ошибкой плана.
     Они нужны, чтобы правила курса не забывались между брифом и съёмкой. */
  const REMINDERS = Object.freeze([
    'Ролик 6–42 секунды, лучше до 30. Текст — только в начале, максимум три строки.',
    'В рилс субтитры не нужны, в историях обязательны.',
    'Описание по площадкам разное: в TikTok нейтральное, в Instagram работает на просмотр, на YouTube длинное.',
    'Публикуйте руками в 14:30 по времени аудитории: автопубликацию курс не советует.',
    'Истории — это продажи, ролики — набор. Одно другим не заменяется.',
    'Снимайте на две недели вперёд: пропускать публикации нельзя.',
  ]);

  sb.mediaMentorRules = {review, REMINDERS, GOOD_DAYS, WORST_DAYS, REACH_PER_WEEK, MAX_FORMATS};
})();

(() => {
  'use strict';
  /* Заявка на материалы: по позициям плана, где исходник не выбран, показывает, что снять
     или сгенерировать, и даёт готовый промт.

     Модель здесь не вызывается вообще: требования к материалу однозначно выводятся из формата
     позиции и СТАНДАРТА МАТЕРИАЛОВ. Платить за то, что считается правилом, незачем.

     Источник требований — AI_HANDOFF/STANDART_MATERIALOV (Стандарт материалов).md:
     раздел 2 (разрешения сцен), раздел 3 (видео), раздел 6 (апскейл не выше 1,5×),
     раздел 7 (что обязано быть в промте), раздел 9а (модель Gemini 3.1 Pro, режим «Изображения»).
     Правила видео — AI_HANDOFF/VIDEO_PREFLIGHT: 0.6 (пачкой, в разных чатах, параллельно)
     и 0.7 (первый и последний кадр описываются и прикладываются картинками).

     Чего модуль НЕ делает: не генерирует, не ходит в сеть, не обещает автоматической
     доставки файла. Материал приносит человек и загружает существующим приёмом файлов. */
  const sb = window.SbCabinet = window.SbCabinet || {};

  /* Геометрия и безопасные зоны — по площадкам, а не по одному формату.
     Интерфейс площадки перекрывает часть кадра: кнопки, подписи, аватар. Титры и ключевой
     объект, попавшие под них, клиент просто не увидит, и переснимать придётся заново.

     Безопасные зоны заданы долями кадра, а не пикселями: доля переживает смену разрешения.
     Каждая запись помечена, подтверждена ли она источником. Там, где точных данных нет,
     стоит запас по самой строгой из известных площадок и `confirmed: false` — выдавать
     догадку за факт нельзя.

     Источники (проверено 19.09.2026):
     - TikTok, Instagram Reels и Stories, YouTube Shorts, Facebook Reels — сводка
       postplanify.com/blog/social-media-safe-zones-2026-complete-guide;
     - ВКонтакте — lab-business.ru/razmery-izobrazheniy-vk-i-socseti: точных пикселей
       источник не даёт, сказано «не ставить смысловой текст в нижние 15–20% кадра»;
     - Telegram — подтверждённых зон нет: в ленте канала интерфейс кадр не перекрывает. */
  const SAFE = (top, bottom, left, right, source, confirmed = true) =>
    Object.freeze({top, bottom, left, right, source, confirmed});
  // Самая строгая из известных: годится, когда площадка неизвестна или данных по ней нет.
  const SAFE_UNIVERSAL = SAFE(0.11, 0.20, 0.06, 0.11, 'запас по самой строгой из известных площадок', false);
  const SAFE_NONE = SAFE(0, 0, 0, 0, 'интерфейс кадр не перекрывает', true);

  const VERTICAL = {ratio: '9:16', master: '2160 × 3840', web: '1080 × 1920'};
  const HORIZONTAL = {ratio: '16:9', master: '3840 × 2160', web: '1920 × 1080'};
  // Ленточные форматы площадок: в стандарте материалов их нет, поэтому они помечаются
  // beyondStandard и выносятся владельцу отдельной строкой, а не применяются молча.
  const PORTRAIT_4_5 = {ratio: '4:5', master: '2160 × 2700', web: '1080 × 1350', beyondStandard: true};
  const SQUARE = {ratio: '1:1', master: '2160 × 2160', web: '1080 × 1080', beyondStandard: true};

  const VIDEO = 'video', IMAGE = 'image';
  const PLATFORMS = Object.freeze({
    vk: {label: 'ВКонтакте',
      story: {kind: VIDEO, geometry: VERTICAL, safe: SAFE(0.10, 0.20, 0.06, 0.10,
        'ВКонтакте: источник даёт только «нижние 15–20%», верх и бока взяты с запасом', false)},
      reel: {kind: VIDEO, geometry: VERTICAL, safe: SAFE(0.10, 0.20, 0.06, 0.10,
        'ВКонтакте: источник даёт только «нижние 15–20%», верх и бока взяты с запасом', false)},
      post: {kind: IMAGE, geometry: PORTRAIT_4_5, safe: SAFE_NONE},
      carousel: {kind: IMAGE, geometry: SQUARE, safe: SAFE_NONE}},
    telegram: {label: 'Telegram',
      story: {kind: VIDEO, geometry: VERTICAL, safe: SAFE_UNIVERSAL},
      reel: {kind: VIDEO, geometry: VERTICAL, safe: SAFE_UNIVERSAL},
      post: {kind: IMAGE, geometry: HORIZONTAL, safe: SAFE_NONE},
      carousel: {kind: IMAGE, geometry: SQUARE, safe: SAFE_NONE}},
    instagram: {label: 'Instagram',
      story: {kind: VIDEO, geometry: VERTICAL, safe: SAFE(0.052, 0.104, 0, 0,
        'Instagram Stories: сверху 100 px, снизу 200 px при 1080 × 1920')},
      reel: {kind: VIDEO, geometry: VERTICAL, safe: SAFE(0.109, 0.161, 0, 0.078,
        'Instagram Reels: сверху 210 px, снизу 310 px, справа 84 px при 1080 × 1920')},
      post: {kind: IMAGE, geometry: PORTRAIT_4_5, safe: SAFE_NONE},
      carousel: {kind: IMAGE, geometry: SQUARE, safe: SAFE_NONE}},
    tiktok: {label: 'TikTok',
      story: {kind: VIDEO, geometry: VERTICAL, safe: SAFE(0.056, 0.167, 0.056, 0.111,
        'TikTok: сверху 108 px, снизу 320 px, слева 60 px, справа 120 px при 1080 × 1920')},
      reel: {kind: VIDEO, geometry: VERTICAL, safe: SAFE(0.056, 0.193, 0.056, 0.111,
        'TikTok: снизу 370 px для рекламных роликов — берём больший запас')},
      post: {kind: IMAGE, geometry: VERTICAL, safe: SAFE(0.056, 0.167, 0.056, 0.111,
        'TikTok: лента вертикальная, у картинки те же перекрытия, что у ролика')},
      carousel: {kind: IMAGE, geometry: VERTICAL, safe: SAFE(0.056, 0.167, 0.056, 0.111,
        'TikTok: лента вертикальная, у картинки те же перекрытия, что у ролика')}},
    youtube: {label: 'YouTube',
      story: {kind: VIDEO, geometry: VERTICAL, safe: SAFE(0.063, 0.156, 0, 0.089,
        'YouTube Shorts: сверху 120 px, снизу 300 px, справа 96 px при 1080 × 1920')},
      reel: {kind: VIDEO, geometry: VERTICAL, safe: SAFE(0.063, 0.188, 0, 0.089,
        'YouTube Shorts: снизу до 360 px при раскрытом описании — берём больший запас')},
      post: {kind: IMAGE, geometry: HORIZONTAL, safe: SAFE_NONE},
      carousel: {kind: IMAGE, geometry: HORIZONTAL, safe: SAFE_NONE}},
  });
  const FORMAT_LABELS = Object.freeze({post: 'Пост', story: 'Сторис', reel: 'Reels', carousel: 'Карусель'});

  // Кто в кадре — следствие того, что клиент про себя сказал в брифе, а не нашего желания.
  const COMFORT_SUBJECT = Object.freeze({
    on_camera: 'человек в кадре, лицо видно',
    hands_only: 'только руки и процесс, лицо в кадр не попадает',
    voice_only: 'человека в кадре нет, показывается процесс или результат',
    off_camera: 'человека в кадре нет, показывается процесс или результат',
    unknown: 'человека в кадре нет: готовность к съёмке в брифе не выяснена',
  });
  const UPSCALE_NOTE = 'Не увеличивать готовый материал больше чем в 1,5 раза — ' +
    'это предел стандарта. Если вышло мелко, просить у генератора максимальное качество, ' +
    'а не растягивать потом.';

  const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

  /* Площадка неизвестна — требования не выдумываются: берётся вертикаль с самым строгим
     запасом и это прямо помечается, чтобы человек проверил перед съёмкой. */
  function requirement(day) {
    const label = FORMAT_LABELS[day.format];
    if (!label) return null;
    const platform = PLATFORMS[day.platform];
    const rule = platform ? platform[day.format] : null;
    if (!rule) {
      return {label, kind: VIDEO, ...VERTICAL, safe: SAFE_UNIVERSAL,
        platformLabel: day.platform, platformKnown: false};
    }
    return {label, kind: rule.kind, ...rule.geometry, safe: rule.safe,
      platformLabel: platform.label, platformKnown: true};
  }

  const pct = (value) => `${Math.round(value * 100)}%`;
  /* Требование к безопасной зоне словами: генератор понимает доли кадра лучше, чем пиксели,
     которых он всё равно не знает. */
  function safeZoneLine(need) {
    const s = need.safe;
    if (!s.top && !s.bottom && !s.left && !s.right) return '';
    const parts = [];
    if (s.top) parts.push(`сверху ${pct(s.top)}`);
    if (s.bottom) parts.push(`снизу ${pct(s.bottom)}`);
    if (s.left) parts.push(`слева ${pct(s.left)}`);
    if (s.right) parts.push(`справа ${pct(s.right)}`);
    return `Ключевой объект и любые надписи держать вне краёв, которые закрывает интерфейс: ${parts.join(', ')}. ` +
      'Эти края должны оставаться фоном — там будут кнопки и подписи площадки.';
  }

  /* Промт для картинки. Раздел 7 стандарта требует прямо назвать соотношение сторон,
     разрешение, фон и запас по краям — поэтому они стоят в тексте, а не подразумеваются. */
  function imagePrompt(day, need, brief) {
    const subject = COMFORT_SUBJECT[brief?.shootingComfort?.level] || COMFORT_SUBJECT.unknown;
    return [
      `Кадр для публикации: ${clean(day.topic, 300)}.`,
      day.hook ? `Смысл кадра: ${clean(day.hook, 300)}.` : '',
      brief?.product ? `Что показываем: ${clean(brief.product, 300)}.` : '',
      `В кадре: ${subject}.`,
      `Публикуется в ${need.platformLabel}.`,
      `Соотношение сторон строго ${need.ratio}, разрешение не ниже ${need.master}, формат PNG без потерь.`,
      'Фон однотонный контрастный. Объект целиком, с запасом по краям — ничего не обрезано.',
      safeZoneLine(need),
      'Максимальное доступное качество. Без текста и надписей на изображении.',
      'Без логотипов и брендов, которых нет в исходных материалах компании.',
    ].filter(Boolean).join(' ');
  }

  /* Промт для видео. Раздел 0.7 VIDEO_PREFLIGHT обязателен: две фразы про первый и последний
     кадр и две приложенные картинки. Без них ролик заказывать нельзя. */
  function videoPrompt(day, need, brief) {
    const subject = COMFORT_SUBJECT[brief?.shootingComfort?.level] || COMFORT_SUBJECT.unknown;
    return [
      `Вертикальный ролик для публикации: ${clean(day.topic, 300)}.`,
      day.hook ? `Смысл: ${clean(day.hook, 300)}.` : '',
      `В кадре: ${subject}.`,
      `Публикуется в ${need.platformLabel}.`,
      `Соотношение сторон строго ${need.ratio}, разрешение не ниже ${need.web}, без звука.`,
      safeZoneLine(need),
      'Одна непрерывная траектория камеры, без склеек и без смены плана.',
      'FIRST FRAME must exactly match the first attached image.',
      'LAST FRAME must exactly match the second attached image.',
    ].filter(Boolean).join(' ');
  }

  function howTo(need) {
    return need.kind === 'video'
      ? ['Генерация видео — только gemini.google.com/u/1/ (рабочий аккаунт). Адрес без u/1 — личный аккаунт, там генерации видео нет.',
        'Режим: «+» → «Создание видео». Отправка надёжнее по Enter из поля ввода.',
        'Роликов несколько — открыть столько же чатов и запустить все подряд. Ждать один ролик, чтобы начать следующий, запрещено.',
        'Первый и последний кадр сначала сделать картинками и приложить к запросу.',
        'Соотношение сторон выбирается в интерфейсе генератора: текстовая просьба «сделай 9:16» игнорируется.']
      : ['Модель Gemini 3.1 Pro, не Flash-Lite: Flash-Lite хуже держит требования к формату и разрешению.',
        'Режим «Изображения» под полем ввода должен быть включён.',
        'Нужно несколько картинок — столько же чатов параллельно.',
        'Если вернулся коллаж или JPEG вместо раздельных PNG — резать по позам и пересохранять, увеличивая не больше чем в 1,5 раза.'];
  }

  function fileName(day, need) {
    const topic = clean(day.topic, 40).toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-').replace(/^-|-$/g, '') || 'kadr';
    const size = need.master.replace(/\s|×/g, 'x').replace(/xx+/g, 'x');
    return `${topic}_${day.platform || 'platform'}_${day.date}_${size}.${need.kind === 'video' ? 'mp4' : 'png'}`;
  }

  /* Заявка строится только по позициям без исходника: там, где материал уже выбран,
     просить нечего. Позиция с неизвестным форматом пропускается с причиной — выдумывать
     требования к формату, которого нет в словаре, нельзя. */
  function build(plan, brief) {
    const items = [], skipped = [], warnings = [];
    for (const day of (plan && Array.isArray(plan.days) ? plan.days : [])) {
      if (day.assetId) continue;
      const need = requirement(day);
      if (!need) { skipped.push(`${day.date}: формат «${day.format}» не описан в стандарте материалов`); continue; }
      if (!need.platformKnown) warnings.push(`${day.date}: площадка «${day.platform}» не описана — ` +
        'взят самый строгий запас по краям, перед съёмкой проверьте требования площадки вручную');
      if (need.beyondStandard) warnings.push(`${day.date}: ${need.platformLabel} ждёт ${need.ratio}, ` +
        'а в стандарте материалов такого формата нет — нужно решение владельца, добавлять ли его');
      if (!need.safe.confirmed && (need.safe.top || need.safe.bottom)) {
        warnings.push(`${day.date}: безопасная зона ${need.platformLabel} точными данными не подтверждена — ` +
          `${need.safe.source}`);
      }
      items.push({date: day.date, platform: day.platform, platformLabel: need.platformLabel,
        format: day.format, formatLabel: need.label,
        kind: need.kind, ratio: need.ratio, master: need.master, web: need.web,
        safe: need.safe, safeZone: safeZoneLine(need), beyondStandard: Boolean(need.beyondStandard),
        topic: clean(day.topic, 300), fileName: fileName(day, need),
        prompt: need.kind === 'video' ? videoPrompt(day, need, brief) : imagePrompt(day, need, brief),
        howTo: howTo(need), upscaleNote: UPSCALE_NOTE});
    }
    const videos = items.filter((item) => item.kind === 'video').length;
    return {items, skipped, videos, warnings: [...new Set(warnings)],
      // Лимит аккаунта на видео известен и мал: молчать о нём — значит запланировать провал.
      batchNote: videos > 2
        ? `Роликов в заявке: ${videos}. Лимит рабочего аккаунта — примерно два ролика в окно, ` +
          'окно возвращается через 3–4 часа. Пакет планируется под лимит, а не под желание.'
        : '',
      notice: 'Заявка составлена по стандарту материалов и не обращается к модели. ' +
        'Генерация и съёмка выполняются отдельно; готовый файл загружается в карточку вручную.'};
  }

  sb.mediaMentorMaterials = {build, requirement, imagePrompt, videoPrompt, safeZoneLine, PLATFORMS};
  if (typeof module === 'object' && module.exports) module.exports = sb.mediaMentorMaterials;
})();

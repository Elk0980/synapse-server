(() => {
  'use strict';
  /* Бриф компании и контент-план на 7–14 дней. Публикация не выполняется. Согласование конкретной
     версии плана — решение по тексту, а не разрешение публиковать. Всё, что приходит с сервера,
     выводится как текст.
     Подсказка плана: модель предлагает позиции, человек подставляет их в форму и сохраняет сам.
     Ни одна позиция не попадает в план и в согласование без явного действия человека. */
  const sb = window.SbCabinet = window.SbCabinet || {};
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const PATH = '/media-mentor';
  // Подсказка живёт в сервисе content рядом с провайдерами, а не за прокси CRM.
  const SUGGEST_PATH = '/content/media-mentor-suggest';
  const ANALYZE_PATH = '/content/media-mentor-analyze';
  const REVIEW_PATH = '/content/media-mentor-review';
  const isoDay = (shiftDays) => new Date(Date.now() + shiftDays * 86400000).toISOString().slice(0, 10);
  const localToday = () => {const value = new Date(); return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;};
  const STATUS = {absent: 'План ещё не составлен', pending: 'Ждёт согласования',
    approved: 'Согласовано', rejected: 'Отклонено', needs_reapproval: 'Нужно пересогласовать'};
  const CARD_STATUS = {plan: 'Только в плане', draft: 'Черновик', scheduled: 'Запланирован',
    publishing: 'Отправляется', published: 'Опубликован', failed: 'Ошибка отправки',
    needs_review: 'Нужна проверка', cancelled: 'Отменён', unknown: 'Статус неизвестен'};
  const transferredDay = (data, index) => index >= 0 && data.transfer?.current?.planRevision === data.plan?.revision
    ? data.transfer.current.items.find((row) => row.dayIndex === index) : null;
  const dayStatus = (draft) => !draft ? 'plan' : Object.hasOwn(CARD_STATUS, draft.cardStatus) ? draft.cardStatus : 'unknown';
  /* Материал может иметь карточки двух происхождений: прежнюю — по номеру дня — и по одной
     на согласованную версию площадки. Обе показываются вместе, один и тот же номер карточки
     не задваивается, а состояние берётся самое продвинутое: черновик не должен затирать уже
     опубликованное или неизвестное — иначе интерфейс скажет, что отправлять ещё нечего. */
  const STATUS_RANK = {plan: 0, cancelled: 1, draft: 2, failed: 3, scheduled: 4,
    publishing: 5, needs_review: 6, unknown: 7, published: 8};
  const variantDrafts = (data, item) => (item && item.ideaId && data.variantTransfer
    ? (data.variantTransfer.items || []).filter((row) => row.ideaId === item.ideaId) : []);
  function cardsFor(data, index, item) {
    const out = new Map();
    const legacy = transferredDay(data, index);
    if (legacy) out.set(legacy.postId, {...legacy, origin: 'day', platform: legacy.planPlatform});
    for (const row of variantDrafts(data, item)) if (!out.has(row.postId)) out.set(row.postId, {...row, origin: 'variant'});
    return [...out.values()];
  }
  const cardsStatus = (cards) => (cards.length
    ? cards.map(dayStatus).reduce((best, next) => (STATUS_RANK[next] > STATUS_RANK[best] ? next : best))
    : 'plan');
  const cardsMedia = (cards) => cards.find((card) => card.hasMedia) || null;
  // Площадки, у которых у этой идеи есть версия. По ним фильтруется план: идея в Telegram
  // с версией для ВКонтакте обязана находиться по фильтру «ВКонтакте».
  /* Согласование ведётся ОДНИМ путём — по версиям площадок. Прежнее решение по плану целиком
     оставило бы два независимых ответа на один вопрос: наверху «8 из 8 согласовано», внизу
     «ждёт согласования» со своими кнопками. Поэтому для плана, у которого сервер отдаёт
     состояния версий, прежний блок превращается в архив: данные, история и медиа остаются
     читаемыми, но второго набора кнопок нет. */
  const variantAware = (data) => Boolean(data.plan) && Array.isArray(data.variants);
  const rowPlatforms = (item) => {
    const list = Object.keys(item.variants || {});
    return list.length ? list : [item.platform].filter(Boolean);
  };
  const day = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value).split('-').reverse().join('.') : '—');
  const moment = (value) => (value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleDateString('ru-RU', {day: '2-digit', month: '2-digit', year: 'numeric'}) : '—');
  const canRead = (ctx) => ctx.identity?.role === 'owner' || ctx.identity?.permissions?.includes('autoposting.view');
  const canEdit = (ctx) => ctx.identity?.role === 'owner' || ctx.identity?.permissions?.includes('autoposting.edit');
  const canDecide = (ctx) => ctx.identity?.role === 'owner';
  const newId = () => (window.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random()}`).replace(/-/g, '').slice(0, 12);
  const options = (list, selected) => list.map((item) =>
    `<option value="${esc(item.id)}"${item.id === selected ? ' selected' : ''}>${esc(item.label)}</option>`).join('');
  let epoch = 0;

  const journeyStages = [
    {icon: '🌱', title: 'Возникла потребность', thought: 'Что-то изменилось. Что мне теперь делать?',
      influence: 'Своя ситуация и слова других людей.',
      media: 'Замечаем вопросы в сообщениях и комментариях.',
      action: 'Собираем реальные ситуации в бриф, выделяем аудиторию.', lever: 'Какие вопросы повторяются.'},
    {icon: '💡', title: 'Понял свою задачу', thought: 'Похоже, это про меня. В чём причина?',
      influence: 'Простое объяснение без давления.',
      media: 'Даём короткий пост или видео с узнаваемым примером.',
      action: 'Проверяем, совпадает ли тема с целью клиента.', lever: 'Целевой охват и досмотры.'},
    {icon: '🔎', title: 'Ищет варианты', thought: 'Какие у меня есть пути?',
      influence: 'Полезные ответы и ясные различия.',
      media: 'Делаем рубрику и версии для нужных соцсетей.',
      action: 'Связываем темы с продуктом и контент-планом.', lever: 'Сохранения и переходы.'},
    {icon: '🤝', title: 'Сравнивает и доверяет', thought: 'Почему я могу вам доверять?',
      influence: 'Люди, процесс, факты и ограничения.',
      media: 'Показываем лицо специалиста, кейсы и ход работы.',
      action: 'Сверяем каждое доказательство с источником в брифе.', lever: 'Вопросы по делу и обращения.'},
    {icon: '💬', title: 'Решает обратиться', thought: 'Как сделать первый безопасный шаг?',
      influence: 'Понятные условия и удобная связь.',
      media: 'Даём конкретное предложение и способ обратиться.',
      action: 'Согласуем материал и канал, затем связываем обращение с CRM.', lever: 'Заявки и скорость ответа.'},
    {icon: '✅', title: 'Получает результат', thought: 'Оправдались ли мои ожидания?',
      influence: 'Качество услуги и сопровождения.',
      media: 'С согласия клиента рассказываем о результате.',
      action: 'Сверяем обращение, сделку и обратную связь.', lever: 'Сделки, отзывы и повторные обращения.'},
  ];

  function journeyMarkup(data) {
    const fields = data.brief.fields;
    const context = [
      {label: 'Вопросы людей', value: fields.pains.join('; ')},
      {label: 'Аудитория', value: fields.audience},
      {label: 'Продукт', value: fields.product},
      {label: 'Пример доказательства', value: fields.confirmedFacts.find((fact) => fact.approvedForContent === true)?.statement},
      {label: 'Предложение и условия', value: fields.product},
      {label: 'Цель компании', value: fields.goal},
    ];
    return `<section class="card mentor-journey" aria-label="Путь клиента">
      <h2>Путь клиента: от потребности до результата</h2>
      <p>Идите по стрелкам. Ниже видно, что думает человек, где работают соцсети и что делает команда.</p>
      <ol class="mentor-journey-track" aria-label="Шесть шагов клиента">${journeyStages.map((stage, index) =>
    `<li><button type="button" data-journey-target="mentor-journey-step-${index + 1}"><span class="mentor-track-icon" aria-hidden="true">${stage.icon}</span>
        <span class="mentor-track-number">Шаг ${index + 1}</span><strong>${esc(stage.title)}</strong></button></li>`).join('')}</ol>
      <button type="button" class="mentor-journey-example-link" data-journey-target="mentor-property-example">Разобрать на примере недвижимости: 10 шагов ↓</button>
      <ol class="mentor-journey-grid">${journeyStages.map((stage, index) => `<li id="mentor-journey-step-${index + 1}">
        <div class="mentor-journey-heading">
          <span class="mentor-journey-number">${index + 1}</span>
          <span class="mentor-journey-icon" aria-hidden="true">${stage.icon}</span>
          <strong>${esc(stage.title)}</strong>
        </div>
        <div class="mentor-journey-flow">
          <div class="mentor-journey-lane mentor-journey-person">
            <span class="mentor-journey-role">👤 Думает человек</span>
            <div class="mentor-journey-character"><img src="/cabinet/mentor-person.svg" alt="" width="80" height="80" loading="lazy">
              <p class="mentor-journey-thought">«${esc(stage.thought)}»</p></div>
          </div>
          <span class="mentor-journey-arrow mentor-journey-arrow-one" aria-hidden="true"></span>
          <div class="mentor-journey-lane mentor-journey-media">
            <span class="mentor-journey-role">📣 Контент и соцсети</span>
            <p>${esc(stage.media)}</p>
          </div>
          <span class="mentor-journey-arrow mentor-journey-arrow-two" aria-hidden="true"></span>
          <div class="mentor-journey-lane mentor-journey-system">
            <span class="mentor-journey-role">⚙️ Команда и Synapse</span>
            <p>${esc(stage.action)}</p>
          </div>
        </div>
        <div class="mentor-journey-outcome"><span>📊 Проверяем: ${esc(stage.lever)}</span>
          <details><summary>Почему это работает и что известно из брифа</summary>
            <p>Влияет: ${esc(stage.influence)}</p>
            <p>${esc(context[index].label)}: ${context[index].value ? esc(context[index].value) : 'Пока не выяснено'}</p></details>
        </div>
      </li>`).join('')}</ol>
      <p class="mentor-note">Это схема работы, а не статус подключения и не обещание мгновенных продаж.
        Факты из брифа и реальные результаты проверяем отдельно для каждого продукта.</p>
    </section>`;
  }

  const propertyJourney = [
    {phase: 'interest', icon: '🌴', title: 'Пока не ищет', thought: 'Я просто живу своей жизнью.',
      channel: 'Истории о жизни, короткие видео, рекомендации.',
      help: 'Узнаём, какие мечты и вопросы действительно есть у людей.'},
    {phase: 'interest', icon: '✨', title: 'Замечает идею', thought: 'А если жить или инвестировать в Таиланде?',
      channel: 'Соцсети и видео дают первый понятный пример.',
      help: 'Показываем реальный опыт, а не обещаем лёгкую покупку.'},
    {phase: 'study', icon: '🎯', title: 'Определяет цель', thought: 'Мне для жизни или дохода? Сколько могу потратить?',
      channel: 'Разборы сценариев, расходов и бюджета.',
      help: 'Уточняем цель и считаем полную стоимость.'},
    {phase: 'study', icon: '📚', title: 'Изучает правила', thought: 'Какие документы, платежи и риски?',
      channel: 'Статья, памятка, ответы специалиста.',
      help: 'Проверяем факты и честно отмечаем ограничения.'},
    {phase: 'study', icon: '🗺️', title: 'Выбирает район', thought: 'Где мне будет удобно?',
      channel: 'Карта, видео районов, сравнение условий жизни.',
      help: 'Сопоставляем район с задачей и бюджетом.'},
    {phase: 'study', icon: '🏢', title: 'Сравнивает объекты', thought: 'Что лучше и чем отличаются застройщики?',
      channel: 'Каталог, разборы объектов, проверенные кейсы.',
      help: 'Сравниваем цену, документы, сроки и расходы.'},
    {phase: 'decision', icon: '🔎', title: 'Выбирает 2–3 объекта', thought: 'Вот два-три объекта, которые подходят.',
      channel: 'Подборка на сайте, поиск, сохранённые материалы.',
      help: 'Готовим короткое сравнение без давления.'},
    {phase: 'decision', icon: '💬', title: 'Задаёт вопрос', thought: 'Кто ответит и что будет после заявки?',
      channel: 'Форма, мессенджер или звонок.',
      help: 'Передаём запрос менеджеру и фиксируем ответ в CRM.'},
    {phase: 'decision', icon: '🧾', title: 'Проверяет и решает', thought: 'Покажите объект, условия и документы.',
      channel: 'Консультация, просмотр, переговоры.',
      help: 'Организуем проверку условий и сопровождение сделки.'},
    {phase: 'after', icon: '🤝', title: 'Сделка и сопровождение', thought: 'Когда передадут объект и кто поможет потом?',
      channel: 'Менеджер, документы, поддержка после сделки.',
      help: 'Фиксируем условия и сопровождаем передачу в срок по договору.'},
  ];
  const propertyPhases = [
    {id: 'interest', label: 'Интерес', range: '1–2'},
    {id: 'study', label: 'Изучение', range: '3–6'},
    {id: 'decision', label: 'Выбор и сделка', range: '7–9'},
    {id: 'after', label: 'Сделка и сервис', range: '10'},
  ];
  const propertyChannels = [
    {name: 'Соцсети и короткие видео', phases: ['interest', 'study', 'decision'], role: 'Знакомят, объясняют и отвечают на сомнения.'},
    {name: 'Сайт, статьи и SEO', phases: ['study', 'decision'], role: 'Дают ответы и варианты.'},
    {name: 'Поисковая реклама', phases: ['decision'], role: 'Встречает готовый запрос.'},
    {name: 'Повторный показ и рассылка', phases: ['study', 'decision'], role: 'Возвращают к сравнению при согласии человека.'},
    {name: 'Форма, звонок, мессенджер', phases: ['decision'], role: 'Принимают вопрос.'},
    {name: 'Менеджер и CRM', phases: ['decision', 'after'], role: 'Помогают проверить и сопровождают.'},
    {name: 'Сервис и рекомендации', phases: ['after'], role: 'Поддерживают после сделки.'},
  ];

  const relocationJourney = [
    {phase: 'interest', icon: '🌴', title: 'Мечтает о перемене', thought: 'А каково жить в Таиланде?',
      channel: 'Истории Влада, Лены и Сергея в коротких видео.', help: 'Показываем личный опыт без обещания, что у всех будет так же.'},
    {phase: 'interest', icon: '💡', title: 'Задаёт первый вопрос', thought: 'Реально ли переехать мне?',
      channel: 'Пост с частыми вопросами и честными ограничениями.', help: 'Разделяем бытовые вопросы, документы и бюджет.'},
    {phase: 'study', icon: '🧮', title: 'Считает деньги', thought: 'Сколько нужно на первые месяцы?',
      channel: 'Разбор реальных категорий расходов.', help: 'Просим вводные: состав семьи, район и запас денег.'},
    {phase: 'study', icon: '📄', title: 'Изучает документы', thought: 'Какие правила действуют для меня?',
      channel: 'Памятка с датой и ссылками на официальные правила.', help: 'Проверяем актуальные требования; не обещаем визу или статус.'},
    {phase: 'study', icon: '🏠', title: 'Выбирает район и жильё', thought: 'Где будет удобно жить?',
      channel: 'Видео районов, карта и сравнение вариантов.', help: 'Сопоставляем быт, бюджет, транспорт и задачи семьи.'},
    {phase: 'study', icon: '🛒', title: 'Представляет обычный день', thought: 'Как там с едой, врачом, школой и услугами?',
      channel: 'Серия бытовых историй от людей на месте.', help: 'Отвечаем на конкретные вопросы, отмечаем неизвестное.'},
    {phase: 'decision', icon: '⚖️', title: 'Сравнивает сценарии', thought: 'Что делать самому, а где нужна помощь?',
      channel: 'Чек-лист самостоятельных шагов и сопровождения.', help: 'Объясняем объём возможной услуги и границы ответственности.'},
    {phase: 'decision', icon: '💬', title: 'Обращается', thought: 'Можно обсудить мой случай?',
      channel: 'Форма или мессенджер с понятным следующим шагом.', help: 'Фиксируем запрос по переезду отдельно от туризма и недвижимости.'},
    {phase: 'decision', icon: '🗓️', title: 'Составляет план', thought: 'Что и когда готовить?',
      channel: 'Консультация и персональный список вопросов.', help: 'Согласуем порядок действий и проверяем цены и условия до обещаний.'},
    {phase: 'after', icon: '🤝', title: 'Переезжает и адаптируется', thought: 'К кому обратиться после приезда?',
      channel: 'Практические подсказки и поддержка по договорённости.', help: 'Собираем обратную связь, исправляем пробелы в материалах.'},
  ];
  const tourismJourney = [
    {phase: 'interest', icon: '☀️', title: 'Хочет отдохнуть', thought: 'Хочу поездку без лишней суеты.',
      channel: 'Короткие видео о Паттайе и реальном маршруте.', help: 'Показываем разные типы отдыха без обещания идеальной поездки.'},
    {phase: 'interest', icon: '📅', title: 'Выбирает время', thought: 'Когда и на сколько дней ехать?',
      channel: 'Сезонные подсказки с датой и оговорками.', help: 'Выясняем даты и состав путешественников.'},
    {phase: 'study', icon: '👨‍👩‍👧', title: 'Определяет свой отдых', thought: 'Нам важнее экскурсии или спокойствие?',
      channel: 'Подборки для разных запросов.', help: 'Записываем темп, возраст, ограничения и интересы.'},
    {phase: 'study', icon: '💰', title: 'Считает бюджет', thought: 'Сколько будет стоить вся поездка?',
      channel: 'Понятный разбор статей расходов.', help: 'Уточняем границы бюджета и включённые услуги.'},
    {phase: 'study', icon: '✈️', title: 'Думает о прилёте', thought: 'Кто встретит и как добраться?',
      channel: 'Видео пути от аэропорта и частые вопросы.', help: 'Проверяем доступность транспорта и условия партнёра.'},
    {phase: 'study', icon: '🗺️', title: 'Выбирает маршрут', thought: 'Что посмотреть без перегруза?',
      channel: 'Карта, пример дня и экскурсии.', help: 'Составляем посильный маршрут с запасом времени.'},
    {phase: 'decision', icon: '🔍', title: 'Сравнивает варианты', thought: 'Что включено и кому доверять?',
      channel: 'Проверяемые описания и отзывы с разрешением.', help: 'Показываем цену, условия отмены и ограничения до оплаты.'},
    {phase: 'decision', icon: '💬', title: 'Оставляет запрос', thought: 'Можно подобрать поездку под нас?',
      channel: 'Форма, звонок или мессенджер.', help: 'Сергей получает запрос и уточняет необходимые детали.'},
    {phase: 'decision', icon: '✅', title: 'Подтверждает план', thought: 'Всё ли готово к вылету?',
      channel: 'Подтверждение маршрута и контактов.', help: 'Сверяем брони, встречу, оплату и контакты исполнителей.'},
    {phase: 'after', icon: '🌟', title: 'Отдыхает и делится опытом', thought: 'Помогут ли, если план изменится?',
      channel: 'Связь во время поездки и отзыв после.', help: 'Решаем вопросы по согласованной услуге и собираем обратную связь.'},
  ];
  const commonPhases = [
    {id: 'interest', label: 'Интерес', range: '1–2'},
    {id: 'study', label: 'Разбор вариантов', range: '3–6'},
    {id: 'decision', label: 'Решение и обращение', range: '7–9'},
    {id: 'after', label: 'Опыт и поддержка', range: '10'},
  ];
  const relocationChannels = [
    {name: 'Личные истории и короткие видео', phases: ['interest', 'study'], role: 'Помогают представить жизнь на месте.'},
    {name: 'Памятки и сайт', phases: ['study', 'decision'], role: 'Собирают проверенные шаги и ограничения.'},
    {name: 'Форма и мессенджер', phases: ['decision'], role: 'Принимают личный вопрос.'},
    {name: 'Консультация и CRM', phases: ['decision', 'after'], role: 'Хранят договорённости и следующий шаг.'},
  ];
  const tourismChannels = [
    {name: 'Видео и соцсети', phases: ['interest', 'study'], role: 'Показывают маршрут и помогают выбрать отдых.'},
    {name: 'Сайт и условия поездки', phases: ['study', 'decision'], role: 'Дают состав услуги, цену и ограничения.'},
    {name: 'Форма и мессенджер', phases: ['decision'], role: 'Передают запрос Сергею.'},
    {name: 'Менеджер и сопровождение', phases: ['decision', 'after'], role: 'Подтверждают детали и помогают во время поездки.'},
  ];

  function propertyExampleMarkup(ctx) {
    const company = ctx.identity?.companies?.find((item) => item.id === ctx.selectedProjectId);
    const isTaiSabai = /тай\s*сабай|taisabai/i.test(`${ctx.selectedProjectId || ''} ${company?.name || ''}`);
    const examples = [
      {id: 'mentor-property-example', title: 'Недвижимость · 10 шагов', journey: propertyJourney,
        phases: propertyPhases, channels: propertyChannels,
        returnNote: 'При выборе объекта человек часто возвращается к районам, документам и бюджету.'},
      {id: 'mentor-relocation-example', title: 'Переезд · 10 шагов', journey: relocationJourney,
        phases: commonPhases, channels: relocationChannels,
        returnNote: 'До переезда человек возвращается к бюджету, документам и условиям жизни; правила нужно перепроверять.'},
      {id: 'mentor-tourism-example', title: 'Туризм · 10 шагов', journey: tourismJourney,
        phases: commonPhases, channels: tourismChannels,
        returnNote: 'Путешественник может менять даты и маршрут; наличие услуг и цены проверяются заново.'},
    ];
    const shown = isTaiSabai ? examples : examples.slice(0, 1);
    return `<section class="mentor-example-section" aria-label="Примеры воронок">
      <div class="mentor-example-nav">${shown.map((example) => `<button type="button"
        data-journey-target="${example.id}">${esc(example.title)} ↓</button>`).join('')}</div>
      ${shown.map((example) => `<details id="${example.id}"
      class="card mentor-property-example"${isTaiSabai && example.id === 'mentor-property-example' ? ' open' : ''}>
      <summary>Пример: ${example.title}</summary>
      <p class="mentor-note">Учебная воронка. Каналы — возможные инструменты, а не статус подключения.
        Конкретное предложение, цену и права на материалы подтверждаем перед публикацией.</p>
      <div class="mentor-property-phases" aria-label="Четыре части пути">${example.phases.map((phase) =>
    `<span data-phase="${phase.id}"><strong>${phase.label}</strong><small>Шаги ${phase.range}</small></span>`).join('')}</div>
      <ol class="mentor-property-stages">${example.journey.map((stage, index) => `<li data-phase="${stage.phase}">
        <div class="mentor-property-step"><b>${index + 1}</b><span aria-hidden="true">${stage.icon}</span>
          <strong>${esc(stage.title)}</strong></div>
        <div><small>👤 Человек</small><p>«${esc(stage.thought)}»</p></div>
        <div><small>📣 Где встречает нас</small><p>${esc(stage.channel)}</p></div>
        <div><small>🤝 Что делаем</small><p>${esc(stage.help)}</p></div>
      </li>`).join('')}</ol>
      <p class="mentor-property-return">↩ ${esc(example.returnNote)}</p>
      <h3>Где помогает каждый канал</h3>
      <div class="mentor-property-channels">${example.channels.map((item) => `<div>
        <strong>${esc(item.name)}</strong><span>${esc(item.role)}</span>
        <div>${item.phases.map((phase) => `<small data-phase="${phase}">${esc(example.phases.find((part) => part.id === phase).label)}</small>`).join('')}</div>
      </div>`).join('')}</div>
    </details>`).join('')}</section>`;
  }

  function briefMarkup(data, edit) {
    const fields = data.brief.fields, vocabulary = data.vocabulary;
    const readOnlyList = (items, render) => (items.length
      ? `<ul class="mentor-list">${items.map(render).join('')}</ul>` : '<p class="mentor-note">Не заполнено</p>');
    if (!edit) {
      return `<dl class="mentor-brief-view">
        <div><dt>Цель</dt><dd>${esc(fields.goal) || '—'}</dd></div>
        <div><dt>Продукт</dt><dd>${esc(fields.product) || '—'}</dd></div>
        <div><dt>Аудитория</dt><dd>${esc(fields.audience) || '—'}</dd></div>
        <div><dt>Боли клиента</dt><dd>${readOnlyList(fields.pains, (item) => `<li>${esc(item)}</li>`)}</dd></div>
        <div><dt>Что можем доказать клиенту</dt><dd>${readOnlyList(fields.confirmedFacts,
    (item) => `<li>${esc(item.statement)}<br><span class="mentor-note">Источник: ${esc(item.source)} · ${item.approvedForContent === true ? 'разрешён для контента' : 'только внутренняя справка'}</span></li>`)}</dd></div>
        <div><dt>Что у вас уже есть · необязательно</dt><dd>${readOnlyList(fields.assets,
    (item) => `<li>${esc(item.title)} · ${esc(item.kind)}${item.note ? `<br><span class="mentor-note">${esc(item.note)}</span>` : ''}</li>`)}</dd></div>
        <div><dt>Комфорт съёмки</dt><dd>${esc(vocabulary.shootingComfort.find((level) => level.id === fields.shootingComfort.level)?.label || fields.shootingComfort.level)}${fields.shootingComfort.notes ? `<br><span class="mentor-note">${esc(fields.shootingComfort.notes)}</span>` : ''}</dd></div>
        <div><dt>Площадки</dt><dd>${fields.platforms.map((id) =>
    esc(vocabulary.platforms.find((item) => item.id === id)?.label || id)).join(', ') || '—'}</dd></div></dl>`;
    }
    return `<form id="mentor-brief-form" class="crm-form mentor-form">
      <input type="hidden" name="revision" value="${esc(data.brief.revision)}">
      <label class="wide">Цель<small class="mentor-note">Зачем: выберем измеримый итог, ради которого ведём соцсети, а не просто число постов.</small><textarea name="goal" rows="2" maxlength="2000">${esc(fields.goal)}</textarea></label>
      <label class="wide">Продукт<small class="mentor-note">Зачем: отделим подтверждённое предложение от идеи и не пообещаем клиенту лишнего.</small><textarea name="product" rows="2" maxlength="2000">${esc(fields.product)}</textarea></label>
      <label class="wide">Аудитория<small class="mentor-note">Зачем: покажем разным людям те вопросы и примеры, которые относятся к их ситуации.</small><textarea name="audience" rows="2" maxlength="2000">${esc(fields.audience)}</textarea></label>
      <label class="wide">Боли клиента — по одной в строке<small class="mentor-note">Зачем: построим путь от реального вопроса к полезному ответу и предложению.</small><textarea name="pains" rows="3">${esc(fields.pains.join('\n'))}</textarea></label>
      <fieldset class="wide mentor-rows" data-rows="facts"><legend>Что можем доказать клиенту · необязательно</legend>
        <p class="mentor-note">Для собственника это поле необязательно. Если есть цена с датой, кейс с разрешением, документ, отзыв или личный опыт — укажите источник. Для публикаций отметьте отдельное разрешение; старые и внутренние записи в модель не попадут.</p>
        <div data-rows-body>${fields.confirmedFacts.map((fact) => factRow(fact)).join('')}</div>
        <button class="plain-button" type="button" data-add="facts">Добавить факт</button></fieldset>
      <fieldset class="wide mentor-rows" data-rows="assets"><legend>Что у вас уже есть · необязательно</legend>
        <p class="mentor-note">Например: «Фото кабинета на телефоне» или «Видео, как проходит работа». Это поможет команде использовать готовое и попросить только недостающее. Здесь достаточно описания словами — файлы не загружаются. Если ничего нет, пропустите.</p>
        <div data-rows-body>${fields.assets.map((asset) => assetRow(asset, vocabulary.assetKinds)).join('')}</div>
        <button class="plain-button" type="button" data-add="assets">Добавить описание</button></fieldset>
      <label>Общий ориентир по съёмке<small class="mentor-note">До личного опроса каждого участника это лишь ориентир: двигаемся без давления и никого не ставим в кадр без согласия.</small><select name="comfortLevel">${options(vocabulary.shootingComfort, fields.shootingComfort.level)}</select></label>
      <label class="wide">Общие ограничения съёмки<small class="mentor-note">Личные предпочтения каждого участника команды уточняем отдельно.</small><textarea name="comfortNotes" rows="2" maxlength="2000">${esc(fields.shootingComfort.notes)}</textarea></label>
      <fieldset class="wide mentor-platforms"><legend>Площадки компании</legend>
        <p class="mentor-note">Зачем: подготовим подходящий формат и работающий путь обращения для каждой доступной площадки.</p>
        ${vocabulary.platforms.map((platform) => `<label class="mentor-checkbox"><input type="checkbox" name="platform"
          value="${esc(platform.id)}"${fields.platforms.includes(platform.id) ? ' checked' : ''}>${esc(platform.label)}</label>`).join('')}</fieldset>
      <p class="mentor-note wide">Изменения брифа сохраняются новой версией. Готовый план сам не меняется:
        после сохранения проверьте его, обновите и согласуйте новую версию.</p>
      <div class="crm-actions wide"><button class="plain-button" type="submit">Сохранить бриф</button>
        <span id="mentor-brief-state" role="status"></span></div></form>`;
  }

  const factRow = (fact = {id: '', statement: '', source: ''}) => `<div class="mentor-row" data-row>
    <input type="hidden" data-field="id" value="${esc(fact.id)}">
    <label>Факт<input data-field="statement" maxlength="1000" required value="${esc(fact.statement)}"></label>
    <label>Источник<input data-field="source" maxlength="500" required value="${esc(fact.source)}"></label>
    <label class="mentor-fact-use"><input type="checkbox" data-fact-approved${fact.approvedForContent === true ? ' checked' : ''}>
      Можно использовать в контенте</label>
    <button class="plain-button" type="button" data-remove>Удалить</button></div>`;
  const assetRow = (asset = {id: '', title: '', kind: 'photo', note: ''}, kinds = []) => `<div class="mentor-row" data-row>
    <input type="hidden" data-field="id" value="${esc(asset.id)}">
    <label>Название<input data-field="title" maxlength="300" required value="${esc(asset.title)}"></label>
    <label>Тип<select data-field="kind">${options(kinds, asset.kind)}</select></label>
    <label>Заметка<input data-field="note" maxlength="1000" value="${esc(asset.note)}"></label>
    <button class="plain-button" type="button" data-remove>Удалить</button></div>`;

  function localMediaPreview(url) {
    if (typeof url !== 'string' || /[\u0000-\u0020\u007f]/.test(url)) return '';
    let parsed;
    try { parsed = new URL(url, window.location.href); }
    catch { return ''; }
    if (parsed.origin !== window.location.origin || !parsed.pathname.startsWith('/content/publishing-assets/')) return '';
    const src = esc(parsed.href);
    if (/\.(mp4|webm)$/i.test(parsed.pathname)) {
      return `<video controls preload="metadata" playsinline src="${src}" aria-label="Загруженный видеоматериал"></video>`;
    }
    if (/\.(jpe?g|png|webp)$/i.test(parsed.pathname)) {
      return `<img loading="lazy" src="${src}" alt="Загруженный материал">`;
    }
    return '';
  }

  /* ---------- Версии площадок ----------
     Одна идея — до семи независимых текстов, по одному на площадку. Показываются компактно:
     переключатели площадок в строку, открыт один текст. Раскрывать семь карточек на каждый
     из семи дней нельзя — это 49 развёрнутых блоков на экране.
     Плановая дата и время версии — ориентир контент-плана. Очередь публикации задаётся
     отдельно, в «Автопостинге», и об этом сказано прямо в интерфейсе. */
  const VARIANT_STATUS = {approved: 'согласовано', rejected: 'на доработку', pending: 'ждёт решения',
    empty: 'текста нет', excluded: 'не публикуем'};
  const PLAN_TIME_NOTE = 'Плановая дата и время версии — ориентир контент-плана, а не очередь ' +
    'публикации. Время отправки задаётся отдельно, в разделе «Автопостинг».';
  const DIRTY_NOTE = 'Сначала сохраните план: в форме есть несохранённые правки, и решение ' +
    'относилось бы к прежнему тексту.';
  // Кто смотрит раздел: решения по версиям принимает только владелец кабинета, как и решение
  // по плану целиком. Остальные видят тексты и состояния, но не кнопки.
  let viewer = {decide: false, edit: false};

  const variantPlatforms = (data) => data.vocabulary.platforms
    .filter((platform) => data.brief.fields.platforms.includes(platform.id));
  const variantStateOf = (data, ideaId, platform) => (data.variants || [])
    .find((state) => state.ideaId === ideaId && state.platform === platform) || null;
  const variantCardOf = (data, ideaId, platform) => (data.variantTransfer?.items || [])
    .find((item) => item.ideaId === ideaId && item.platform === platform) || null;

  function variantTab(platform, data, ideaId, active) {
    const state = variantStateOf(data, ideaId, platform.id);
    const label = state ? VARIANT_STATUS[state.status] || state.status : 'новая';
    return `<button type="button" class="mentor-variant-tab" data-variant-tab="${esc(platform.id)}"
      data-variant-state="${esc(state ? state.status : 'pending')}"
      aria-pressed="${active ? 'true' : 'false'}">${esc(platform.label)} · ${esc(label)}</button>`;
  }

  function variantPanel(platform, variant, data, item, index, hidden) {
    const vocabulary = data.vocabulary;
    const assets = [{id: '', label: 'Ничего не выбрано'},
      ...data.brief.fields.assets.map((asset) => ({id: asset.id, label: asset.title}))];
    const limit = (vocabulary.captionLimits || {})[platform.id] || null;
    const ideaId = item.ideaId || '';
    const state = variantStateOf(data, ideaId, platform.id);
    const card = variantCardOf(data, ideaId, platform.id);
    const decided = state && state.decision
      ? `<p class="mentor-note" data-variant-decision>${esc(VARIANT_STATUS[state.status] || state.status)}${state.reason ? ` · ${esc(state.reason)}` : ''}${state.actorName ? ` · ${esc(state.actorName)}` : ''}</p>`
      : '<p class="mentor-note" data-variant-decision>Решения по этой версии ещё нет.</p>';
    // Расписка переноса показывается у своей версии, а не по старому номеру дня.
    const transferred = card
      ? `<p class="mentor-note" data-variant-card="${esc(card.postId)}">Перенесено в черновик №${esc(card.postId)} · ${esc(card.cardStatus)}${card.hasMedia ? ' · медиа загружено' : ' · без медиа'}. Отправку и время задаёт «Автопостинг» после отдельного одобрения материала.</p>`
      : '<p class="mentor-note" data-variant-card="">В черновики ещё не переносилась.</p>';
    const actions = index >= 0 && ideaId
      ? (viewer.decide
        ? `<div class="mentor-variant-actions">
          <button type="button" class="plain-button" data-variant-decide="approved"
            data-variant-idea-id="${esc(ideaId)}" data-variant-platform="${esc(platform.id)}">Согласовать версию</button>
          <button type="button" class="plain-button" data-variant-decide="rejected"
            data-variant-idea-id="${esc(ideaId)}" data-variant-platform="${esc(platform.id)}">Вернуть на доработку</button>
          <button type="button" class="plain-button" data-variant-decide="withdrawn"
            data-variant-idea-id="${esc(ideaId)}" data-variant-platform="${esc(platform.id)}">Отозвать согласование</button>
          <label>Причина возврата (обязательна)<input data-variant-comment maxlength="2000" placeholder="Что исправить в этой версии"></label>
          <span data-variant-state-line role="status"></span>
        </div>`
        : '<p class="mentor-note" data-variant-readonly>Решения по версиям принимает владелец кабинета.</p>')
      : '<p class="mentor-note">Сначала сохраните план — затем версию можно согласовать.</p>';
    const editable = viewer.edit
      ? `<label data-variant-text-label>Текст для площадки «${esc(platform.label)}»${limit ? ` · до ${esc(limit)} символов` : ''}
          <textarea data-variant-field="text"${limit ? ` maxlength="${esc(limit)}"` : ''} rows="4">${esc(variant.text || '')}</textarea></label>
        <details class="mentor-day-more"><summary>Подробности версии</summary>
          <label>Зацепка<input data-variant-field="hook" maxlength="500" value="${esc(variant.hook || '')}"></label>
          <label>Формат<select data-variant-field="format"><option value="">Как у идеи</option>${options(vocabulary.formats, variant.format || '')}</select></label>
          <label>Что уже есть<select data-variant-field="assetId">${options(assets, variant.assetId || '')}</select></label>
          <label>Заметка наставника<textarea data-variant-field="mentorNote" rows="2" maxlength="2000">${esc(variant.mentorNote || '')}</textarea></label>
          <div class="mentor-day-selects">
            <label>Плановая дата<input data-variant-field="plannedDate" type="date" value="${esc(variant.plannedDate || '')}"></label>
            <label>Плановое время<input data-variant-field="plannedTime" type="time" value="${esc(variant.plannedTime || '')}"></label>
            <label>Часовой пояс<input data-variant-field="timezone" maxlength="64" placeholder="Например: Asia/Irkutsk" value="${esc(variant.timezone || '')}"></label>
          </div>
          <label class="mentor-inline"><input data-variant-field="excluded" type="checkbox"${variant.excluded ? ' checked' : ''}> Эту площадку не публикуем</label>
          <p class="mentor-note">${esc(PLAN_TIME_NOTE)}</p>
        </details>`
      // Только просмотр: текст версии всё равно виден — иначе читатель не знает, что согласуют.
      : `<p class="mentor-variant-read" data-variant-text>${variant.text ? esc(variant.text) : 'Текста пока нет.'}</p>
        ${variant.plannedDate || variant.plannedTime ? `<p class="mentor-note">Плановый выход: ${esc(variant.plannedDate || '—')} ${esc(variant.plannedTime || '')}. ${esc(PLAN_TIME_NOTE)}</p>` : ''}`;
    return `<div class="mentor-variant-panel" data-variant="${esc(platform.id)}" data-variant-idea="${esc(ideaId)}"
      ${hidden ? 'hidden' : ''}>${editable}${decided}${transferred}${actions}</div>`;
  }

  function variantsMarkup(item, data, index) {
    const platforms = variantPlatforms(data);
    const present = platforms.filter((platform) => Object.hasOwn(item.variants || {}, platform.id));
    // Основная площадка идеи открыта первой: у старого плана версия ровно одна, и она же основная.
    const active = present.find((platform) => platform.id === item.platform) || present[0] || null;
    const add = platforms.filter((platform) => !Object.hasOwn(item.variants || {}, platform.id));
    return `<div class="mentor-variants" data-variants="${esc(item.ideaId || '')}">
      <div class="mentor-variant-tabs" role="group" aria-label="Версии для площадок">
        <span data-variant-tabs>${present.map((platform) => variantTab(platform, data, item.ideaId, active && platform.id === active.id)).join('')}</span>
        ${viewer.edit && add.length ? `<select data-variant-add aria-label="Добавить площадку"><option value="">Добавить площадку…</option>${options(add, '')}</select>` : ''}
        ${index >= 0 && item.ideaId && viewer.decide ? `<button type="button" class="plain-button" data-variant-decide="approved"
          data-variant-idea-id="${esc(item.ideaId)}">Согласовать всю идею</button>
          <button type="button" class="plain-button" data-variant-decide="rejected"
          data-variant-idea-id="${esc(item.ideaId)}">Вернуть всю идею</button>
          <button type="button" class="plain-button" data-variant-decide="withdrawn"
          data-variant-idea-id="${esc(item.ideaId)}">Отозвать по всей идее</button>
          <label>Причина возврата всей идеи (обязательна)
            <input data-idea-comment maxlength="2000" placeholder="Что исправить во всей идее"></label>
          <span data-idea-state-line role="status"></span>` : ''}
      </div>
      <div data-variant-panels>${present.map((platform) => variantPanel(platform,
    item.variants[platform.id] || {}, data, item, index, !(active && platform.id === active.id))).join('')}</div>
      ${present.length ? '' : '<p class="mentor-note" data-variant-empty>Версий для площадок пока нет: добавьте площадку выше.</p>'}
    </div>`;
  }

  /* Решения и перенос по всему плану: один понятный путь рядом с планом, а не спрятанный
     в подробностях каждой идеи. Перенос создаёт независимые черновики — по одному на
     согласованную версию — и ничего не публикует. */
  function planVariantsMarkup(data) {
    const plan = data.plan;
    if (!plan) return '';
    const states = data.variants || [];
    const counts = states.reduce((acc, item) => ({...acc, [item.status]: (acc[item.status] || 0) + 1}), {});
    const transfer = data.variantTransfer || null;
    const stale = plan.briefRevision !== data.brief.revision;
    return `<section class="mentor-variants-plan" data-plan-variants>
      <h3>Версии площадок</h3>
      <p class="mentor-note" data-variant-counts>Всего версий: ${esc(states.length)} ·
        согласовано ${esc(counts.approved || 0)} · на доработку ${esc(counts.rejected || 0)} ·
        ждут решения ${esc(counts.pending || 0)} · без текста ${esc(counts.empty || 0)} ·
        не публикуем ${esc(counts.excluded || 0)}.</p>
      <p class="mentor-note">Согласование версии — решение по тексту плана. Разрешением опубликовать
        оно не является: материал в «Автопостинге» всё равно одобряется отдельно, вместе с его
        финальным текстом, медиа и каналом.</p>
      ${stale ? '<p class="mentor-warning" role="note">План составлен по прежней версии брифа. Обновите план и согласуйте версии заново.</p>' : ''}
      ${viewer.decide && !stale ? `<div class="mentor-variant-actions" data-plan-variant-actions>
        <button type="button" class="plain-button" data-variant-decide="approved" data-variant-scope="plan">Согласовать весь план</button>
        <button type="button" class="plain-button" data-variant-decide="rejected" data-variant-scope="plan">Вернуть весь план</button>
        <button type="button" class="plain-button" data-variant-decide="withdrawn" data-variant-scope="plan">Отозвать по всему плану</button>
        <label>Причина возврата (обязательна)<input data-plan-comment maxlength="2000" placeholder="Что исправить в плане"></label>
        <span data-plan-state-line role="status"></span>
      </div>` : `<p class="mentor-note">${viewer.decide ? '' : 'Решения по версиям принимает владелец кабинета.'}</p>`}
      ${viewer.edit ? `<div class="mentor-variant-actions">
        <button type="button" class="plain-button" data-variants-transfer
          ${transfer && transfer.canTransfer ? '' : 'disabled'}>Перенести согласованные версии в черновики</button>
        <span class="mentor-note" data-variants-transfer-note>${esc(transfer
    ? (transfer.canTransfer ? `Готовы к переносу: ${transfer.awaitingTransfer}. Создаются только черновики: ни публикаций, ни очереди, ни выбора каналов.`
      : transfer.blockedReason || 'Переносить пока нечего.')
    : 'Состояние переноса версий недоступно.')}</span>
        <span data-variants-transfer-state role="status"></span>
      </div>` : ''}
    </section>`;
  }

  function dayRow(item, data, index = -1, edit = true) {
    const fields = data.brief.fields, vocabulary = data.vocabulary;
    const platforms = vocabulary.platforms.filter((platform) => fields.platforms.includes(platform.id));
    const assets = [{id: '', label: 'Ничего не выбрано'}, ...fields.assets.map((asset) => ({id: asset.id, label: asset.title}))];
    // Карточки обоих происхождений: прежняя по дню и по одной на согласованную версию.
    const cards = cardsFor(data, index, item);
    const draft = cards[0] || null;
    const withMedia = cardsMedia(cards);
    const media = withMedia?.mediaUrls?.length ? localMediaPreview(withMedia.mediaUrls[0]) : '';
    const status = cardsStatus(cards);
    const action = {plan: edit ? 'Проверьте тему и дату. Если есть идея получше, предложите правку.' : 'Посмотрите тему и дату в плане.',
      draft: withMedia ? 'Проверьте подготовленный материал в «Автопостинге».' : 'Подготовьте фото или видео по теме. Его можно добавить ниже, в «Черновиках и файлах».',
      scheduled: 'Материал уже запланирован. Проверьте время выхода в «Автопостинге».',
      publishing: 'Идёт отправка. Проверьте результат в «Автопостинге».',
      published: 'Материал опубликован. Результаты можно посмотреть в статистике.',
      failed: 'Откройте «Автопостинг» и проверьте причину ошибки отправки.',
      needs_review: 'Откройте карточку в «Автопостинге» и проверьте результат отправки.',
      cancelled: 'Отправка отменена. Решите, нужен ли этот материал в плане.',
      unknown: 'Уточните состояние карточки в «Автопостинге».'}[status];
    const feedback = index < 0 ? [] : (data.feedback || []).filter((entry) => entry.dayIndex === index);
    const platformLabel = platforms.find((row) => row.id === item.platform)?.label || item.platform || 'Площадка';
    const formatLabel = vocabulary.formats.find((row) => row.id === item.format)?.label || item.format || 'Формат';
    return `<article class="mentor-row mentor-day" data-row data-day-index="${index}"
      data-idea-id="${esc(item.ideaId || '')}"
      ${index >= 0 ? `data-source-order="${index}"` : ''} data-plan-date="${esc(item.date)}"
      data-plan-platform="${esc(item.platform)}" data-plan-platforms="${esc(rowPlatforms(item).join(' '))}"
      data-card-status="${status}" data-card-ids="${esc(cards.map((card) => card.postId).join(' '))}">
      <div class="mentor-day-overview">
      <div class="mentor-day-preview" data-preview-format="${esc(item.format)}" aria-label="Макет публикации">
        <div class="mentor-day-preview-media">${media || '<span class="mentor-day-play" aria-hidden="true">▷</span><span>Медиа пока нет</span>'}</div>
      </div>
      <div class="mentor-day-summary">
        <p class="mentor-day-meta"><time data-preview-date>${item.date ? esc(day(item.date)) : 'Дата не выбрана'}</time> ·
          <span data-preview-platform>${esc(platformLabel)}</span> · <span data-preview-format-label>${esc(formatLabel)}</span></p>
        <h3 data-preview-topic>${esc(item.topic) || 'Новый материал'}</h3>
        <p class="mentor-day-status"><span>${cards.length
    ? `${cards.length > 1 ? `Карточек ${esc(cards.length)}: ` : 'Карточка '}${cards.map((card) => `№${esc(card.postId)}${card.platform ? ` (${esc(card.platform)})` : ''}`).join(', ')} · ${esc(CARD_STATUS[status].toLowerCase())} · ${withMedia ? 'медиа загружено' : 'без медиа'}`
    : 'Пока только в плане'}</span></p>
        <p class="mentor-day-action"><strong>Что сделать:</strong> ${esc(action)}</p>
        ${edit && !withMedia && cards.some((card) => card.cardStatus === 'draft')
    ? `<button type="button" class="plain-button" data-material-target="${esc(cards.find((card) => card.cardStatus === 'draft').postId)}">Добавить файл</button>` : ''}
      </div></div>
      <details class="mentor-day-details"${index < 0 ? ' open' : ''}><summary>${edit ? 'Подробности и правки' : 'Подробности материала'}${feedback.length ? ` · предложений: ${feedback.length}` : ''}</summary>
      ${edit ? `<div class="mentor-day-edit">
        ${draft ? '<p class="mentor-note">Дата и тема здесь относятся к плану. Уже созданную карточку и время выхода изменяйте в разделе «Автопостинг».</p>' : ''}
        <div class="mentor-day-selects">
          <label>Дата в плане<input data-field="date" type="date" required value="${esc(item.date)}"></label>
          <label>Площадка<select data-field="platform">${options(platforms, item.platform)}</select></label>
          <label>Формат<select data-field="format">${options(vocabulary.formats, item.format)}</select></label>
          <label>Задача материала<select data-field="role">${options(vocabulary.roles, item.role)}</select></label>
        </div>
        <label>Тема<input data-field="topic" maxlength="300" required value="${esc(item.topic)}"></label>
        ${variantsMarkup(item, data, index)}
        <div class="mentor-day-order">
          <button type="button" class="plain-button" data-move="up" aria-label="Выше в плане">↑ Выше</button>
          <button type="button" class="plain-button" data-move="down" aria-label="Ниже в плане">↓ Ниже</button>
          <span class="mentor-note" data-move-note role="status"></span>
        </div>
        <details class="mentor-day-more"><summary>Для команды · зацепка и задание</summary>
          <label>Зацепка<input data-field="hook" maxlength="500" value="${esc(item.hook)}"></label>
          <label>Что уже есть для материала<select data-field="assetId">${options(assets, item.assetId)}</select></label>
          <label>Заметка наставника<textarea data-field="mentorNote" rows="2" maxlength="2000">${esc(item.mentorNote)}</textarea></label>
        </details>
        ${index >= 0 ? `<div class="mentor-day-feedback">
          <strong>Предложения по этому материалу</strong>
          <div data-feedback-list="${index}">${feedback.length ? `<ul class="mentor-list">${feedback.map((entry) => `<li>${esc(entry.message)}
            <small>${esc(entry.actorName || 'Участник')} · ${esc(moment(entry.createdAt))}</small></li>`).join('')}</ul>`
    : '<p class="mentor-note">Предложений пока нет.</p>'}</div>
          <label>Что стоит изменить?<textarea data-feedback-input="${index}" rows="2" maxlength="1000" placeholder="Например: может, эта тема лучше подойдёт для продающего рилса?"></textarea></label>
          <button class="plain-button" type="button" data-feedback-send="${index}">Предложить правку</button>
          <span data-feedback-state="${index}" role="status"></span>
        </div>` : '<p class="mentor-note">Сначала сохраните материал, затем можно оставить предложение по нему.</p>'}
        <button class="plain-button" type="button" data-remove>Убрать материал</button>
      </div>` : `${variantsMarkup(item, data, index)}<dl class="mentor-brief-view"><div><dt>Задача материала</dt><dd>${esc(vocabulary.roles.find((role) => role.id === item.role)?.label || item.role)}</dd></div>
        ${item.hook ? `<div><dt>Зацепка</dt><dd>${esc(item.hook)}</dd></div>` : ''}
        <div><dt>Что уже есть</dt><dd>${esc(assets.find((asset) => asset.id === item.assetId)?.label || 'Не указано')}</dd></div>
        ${item.mentorNote ? `<div><dt>Задание</dt><dd>${esc(item.mentorNote)}</dd></div>` : ''}</dl>`}</details></article>`;
  }

  function planFilters(data) {
    // Состояния берутся по обоим происхождениям карточек: иначе список состояний
    // остался бы из одного «Только в плане», хотя черновики версий уже созданы.
    const states = [...new Set((data.plan?.days || []).map((item, index) => cardsStatus(cardsFor(data, index, item))))];
    if (!states.includes('plan')) states.unshift('plan');
    return `<div class="mentor-plan-filters" role="group" aria-label="Фильтры материалов">
      <label>Площадка<select data-plan-filter="platform"><option value="">Все площадки</option>${options(data.vocabulary.platforms, '')}</select></label>
      <label>Порядок<select data-plan-filter="order"><option value="nearest">Ближайшие сначала</option><option value="asc">Ранние даты сначала</option><option value="desc">Поздние даты сначала</option></select></label>
      <details class="mentor-extra-filters"><summary data-plan-extra-summary>Ещё фильтры</summary><div>
        <label>С даты<input type="date" data-plan-filter="from"></label>
        <label>По дату<input type="date" data-plan-filter="to"></label>
        <label>Состояние<select data-plan-filter="status"><option value="">Все состояния</option>${states.map((status) => `<option value="${status}">${CARD_STATUS[status]}</option>`).join('')}</select></label>
        <p class="mentor-note">Для одного дня выберите одинаковые даты.</p></div></details>
      <button type="button" class="plain-button" data-plan-reset hidden>Сбросить фильтры</button>
    </div><p class="mentor-note" data-plan-filter-state role="status"></p>
      <p class="mentor-filter-empty" data-plan-filter-empty hidden>По этим условиям материалов нет. Сбросьте фильтры или выберите другие даты.</p>`;
  }

  /* Проверка плана по механическим правилам курса. Считает отдельный модуль без модели
     и без сети; если его нет на странице, экран работает по-прежнему и о проверке молчит,
     а не показывает пустой зелёный блок — это было бы обещанием, которого никто не давал. */
  function rulesMarkup(plan) {
    const rules = sb.mediaMentorRules;
    if (!rules || !plan) return '';
    let result;
    try { result = rules.review(plan); }
    catch { return ''; }
    if (!result || !result.checked) return '';
    const reminders = `<details class="mentor-reminders" data-rules-reminders>
      <summary>Что курс оставляет на решение человека</summary>
      <ul class="mentor-list">${rules.REMINDERS.map((text) => `<li>${esc(text)}</li>`).join('')}</ul></details>`;
    if (!result.issues.length) {
      return `<section class="mentor-rules" data-rules><h3>Проверка по курсу</h3>
        <p class="mentor-note" data-rules-ok>Расписание и состав плана правилам курса не противоречат.
        Это проверка механических правил, а не обещание просмотров.</p>${reminders}</section>`;
    }
    // Три уровня различаются вслух: рекомендация курса по дню недели нарушением не называется.
    const LEVELS = {violation: 'Нарушение', recommendation: 'Рекомендация курса', warning: 'Стоит поправить'};
    const line = (item) => `<li data-rules-level="${esc(item.level)}">` +
      `<strong>${LEVELS[item.level] || LEVELS.warning}:</strong> ${esc(item.text)}</li>`;
    return `<section class="mentor-rules" data-rules><h3>Проверка по курсу</h3>
      <p class="mentor-note">Замечаний: ${esc(result.issues.length)}. Правила механические —
      расписание и состав плана. Оценку идеи и темы они не заменяют.</p>
      <ul class="mentor-list" data-rules-list>${result.issues.map(line).join('')}</ul>${reminders}</section>`;
  }

  function planMarkup(data, edit) {
    const plan = data.plan, vocabulary = data.vocabulary;
    const version = plan ? `<p class="mentor-note">Версия ${esc(plan.revision)} по брифу ${esc(plan.briefRevision)} ·
        ${esc(day(plan.startDate))} — ${esc(day(plan.endDate))} · ${esc(plan.windowDays)} дней · обновлён ${esc(moment(plan.updatedAt))}</p>` : '';
    const view = plan ? `${planVariantsMarkup(data)}${planFilters(data)}<div class="mentor-day-cards" data-plan-feed>${plan.days.map((item, index) => dayRow(item, data, index, false)).join('')}</div>`
      : '<p class="mentor-note">План ещё не составлен.</p>';
    const stale = plan && plan.briefRevision !== data.brief.revision
      ? `<p class="mentor-warning" role="note">Бриф сохранён как версия ${esc(data.brief.revision)}. Этот план остался по версии ${esc(plan.briefRevision)} и сам не перестроился. Проверьте материалы, сохраните новую версию плана и согласуйте её заново.</p>` : '';
    const rules = rulesMarkup(plan);
    const technical = plan ? `<details class="mentor-team"${rules.includes('data-rules-list') ? ' open' : ''}><summary>Для команды · версия и проверка расписания${rules.includes('data-rules-list') ? ' · есть замечания' : ''}</summary>${version}${rules}</details>` : '';
    const checked = `${stale}${plan ? '' : view}`;
    if (!edit) return `${stale}${view}${technical}`;
    if (!data.brief.revision) {
      return `${checked}${plan ? view : ''}<p class="mentor-note">Сначала сохраните бриф компании — план составляется по нему.</p>${technical}`;
    }
    if (!data.brief.fields.platforms.length) {
      return `${checked}${plan ? view : ''}<p class="mentor-note">Выберите площадки в брифе: без них план составить нельзя.</p>${technical}`;
    }
    const suggestion = `<details class="mentor-suggest-tools"${plan ? '' : ' open'}><summary>${plan ? 'Предложить другой план с помощью Хью' : 'Помочь составить первый план'}</summary>
      <section class="mentor-suggest wide" data-suggest>
      <h3>Подсказка плана</h3>
      <p class="mentor-note">Модель предложит позиции по брифу. Ничего не сохранится и не уйдёт
        на согласование: предложение нужно подставить в форму и проверить самому.</p>
      <label>Начало<input data-suggest-start type="date"></label>
      <label>Дней<select data-suggest-days>${Array.from({length: vocabulary.maxDays - vocabulary.minDays + 1},
  (unused, index) => vocabulary.minDays + index).map((value) =>
  `<option value="${value}"${value === vocabulary.minDays ? ' selected' : ''}>${value}</option>`).join('')}</select></label>
      <button class="plain-button" type="button" data-suggest-run>Предложить план</button>
      <span data-suggest-state role="status"></span>
      <div data-suggest-result></div>
    </section></details>`;
    return `${checked}${planFilters(data)}<form id="mentor-plan-form" class="crm-form mentor-form">
      <input type="hidden" name="planRevision" value="${esc(plan ? plan.revision : 0)}">
      <input type="hidden" name="briefRevision" value="${esc(data.brief.revision)}">
      ${planVariantsMarkup(data)}<div class="mentor-rows mentor-plan-editor wide" data-rows="days"><div class="mentor-day-cards" data-rows-body data-plan-feed>${(plan ? plan.days : []).map((item, index) => dayRow(item, data, index)).join('')}</div>
        <button class="plain-button" type="button" data-add="days">Добавить материал</button></div>
      <div class="crm-actions wide"><button class="plain-button" type="submit">Сохранить план</button>
        <span id="mentor-plan-state" role="status"></span></div></form>
      <p class="mentor-note">Сохраняется весь план, включая материалы за пределами фильтров. Сохранение не запускает публикации.</p>
      ${suggestion}${technical}<details class="mentor-team"><summary>Для команды · требования к плану</summary>
        <p class="mentor-note">План охватывает от ${esc(vocabulary.minDays)} до ${esc(vocabulary.maxDays)} дней подряд,
        не больше трёх материалов на дату. Фильтры меняют только отображение. Карточка показывает макет, а не готовую публикацию.</p></details>`;
  }

  function approvalMarkup(data, ctx) {
    const approval = data.approval, plan = data.plan;
    const decided = approval.decidedAt
      ? `<p class="mentor-note">Последнее решение: ${esc(approval.decision === 'approved' ? 'согласовано' : 'отклонено')} ·
         версия плана ${esc(approval.planRevision)} · ${esc(approval.actorName || '—')} · ${esc(moment(approval.decidedAt))}${approval.comment ? `<br>${esc(approval.comment)}` : ''}</p>`
      : '<p class="mentor-note">Решений по этой версии ещё нет.</p>';
    // Решать можно только по плану, составленному по текущей версии брифа.
    const canAct = canDecide(ctx) && !!plan && plan.briefRevision === data.brief.revision && !variantAware(data);
    if (variantAware(data)) {
      // Архив: прежние решения по плану целиком видны, но новых здесь не принимают.
      return `<details class="card mentor-approval mentor-archive" data-status="${esc(approval.status)}" data-legacy-approval>
        <summary>Архив · прежнее согласование плана целиком</summary>
        <p class="mentor-note">Согласование ведётся по версиям площадок — в блоке «Версии площадок»
          рядом с планом. Здесь только история прежних решений по плану целиком: новых решений
          этот блок не принимает, чтобы не было двух ответов на один вопрос.</p>
        <p class="mentor-note">Прежнее состояние: <strong>${esc(STATUS[approval.status] || approval.status)}</strong>${approval.reason ? ` · ${esc(approval.reason)}` : ''}</p>
        ${decided}
        ${data.approvals.length ? `<details><summary>История решений по плану (${esc(data.approvals.length)})</summary>
          <ol class="mentor-history">${data.approvals.map((item) => `<li>${esc(moment(item.decidedAt))} · версия ${esc(item.planRevision)} ·
            ${esc(item.decision === 'approved' ? 'согласовано' : 'отклонено')} · ${esc(item.actorName || '—')}${item.comment ? `<br>${esc(item.comment)}` : ''}</li>`).join('')}</ol></details>` : ''}
      </details>`;
    }
    return `<section class="card mentor-approval" data-status="${esc(approval.status)}">
      <h2>Согласование версии плана</h2>
      <p><strong>${esc(STATUS[approval.status] || approval.status)}</strong>${approval.reason ? ` · ${esc(approval.reason)}` : ''}</p>
      <p class="mentor-note">Согласование относится к конкретной версии плана и означает решение по тексту.
        Это не разрешение публиковать: ничего не отправляется и очередь публикаций не создаётся.</p>
      ${decided}
      ${canAct ? `<form id="mentor-decision-form" class="crm-form">
        <input type="hidden" name="planRevision" value="${esc(plan.revision)}">
        <input type="hidden" name="briefRevision" value="${esc(data.brief.revision)}">
        <label class="wide">Комментарий (обязателен при отклонении)<textarea name="comment" rows="2" maxlength="2000"></textarea></label>
        <div class="crm-actions wide"><button class="plain-button" type="submit" value="approved" name="decision">Согласовать версию</button>
          <button class="plain-button" type="submit" value="rejected" name="decision">Отклонить</button>
          <span id="mentor-decision-state" role="status"></span></div></form>`
    : `<p class="mentor-note">${canDecide(ctx) ? 'Сначала обновите план под свежий бриф.' : 'Решение принимает владелец кабинета.'}</p>`}
      ${data.approvals.length ? `<details><summary>История решений (${esc(data.approvals.length)})</summary>
        <ol class="mentor-history">${data.approvals.map((item) => `<li>${esc(moment(item.decidedAt))} · версия ${esc(item.planRevision)} ·
          ${esc(item.decision === 'approved' ? 'согласовано' : 'отклонено')} · ${esc(item.actorName || '—')}${item.comment ? `<br>${esc(item.comment)}` : ''}</li>`).join('')}</ol></details>` : ''}
    </section>`;
  }

  // Перенос согласованной версии плана в черновики автопостинга. Кнопка ничего не публикует
  // и ничего не ставит в очередь: об этом сказано рядом с ней, а не мелким шрифтом.
  function transferMarkup(data, ctx) {
    const state = data.transfer;
    if (!state) return '';
    const edit = canEdit(ctx);
    // Задание и исходник показываются прямо у черновика: искать их вручную не нужно.
    const done = state.current ? `<p>Перенесено ${esc(moment(state.current.transferredAt))} ·
        ${esc(state.current.postIds.length)} черновиков · ${esc(state.current.actorName || '—')} ·
        план v${esc(state.current.planRevision)}, бриф v${esc(state.current.briefRevision)}</p>
      <ul class="mentor-drafts" data-legacy-drafts>${state.current.items.map((item) => `<li>
        <details><summary>${esc(day(item.planDate))} · ${esc(item.planPlatform)} · черновик №${esc(item.postId)}</summary>
        <p><strong>${esc(item.topic)}</strong></p>
        <p class="mentor-note">Формат: ${esc(item.format || '—')} · роль: ${esc(item.role || '—')}${item.hook ? ` · зацепка: ${esc(item.hook)}` : ''}</p>
        ${item.mentorNote ? `<p class="mentor-note">Заметка наставника: ${esc(item.mentorNote)}</p>` : ''}
        ${item.asset ? `<p class="mentor-asset"><span>Исходник из брифа (описание словами):</span> ${esc(item.asset.title)} · ${esc(item.asset.kind)}${item.asset.note ? `<br>${esc(item.asset.note)}` : ''}
          <br><span class="mentor-note">Это описание, а не загруженный файл: материал нужно добавить отдельно.</span></p>`
    : '<p class="mentor-note">Исходник в плане не указан.</p>'}
        <p class="mentor-material" data-has-media="${item.hasMedia ? 'yes' : 'no'}">
          <span>Материал:</span> ${item.hasMedia ? `добавлен · файлов ${esc(item.mediaCount)}` : 'не добавлен'}</p>
        ${edit ? `<label class="mentor-upload">Добавить свой материал (фото JPEG, PNG, WebP или видео MP4, WebM)
          <input type="file" data-material-file="${esc(item.postId)}"
            accept="image/jpeg,image/png,image/webp,video/mp4,video/webm"></label>
          <button class="plain-button" type="button" data-material-add="${esc(item.postId)}"
            data-post-revision="${esc(item.postRevision)}">Загрузить и приложить к карточке</button>
          <span data-material-state="${esc(item.postId)}" role="status"></span>` : ''}
        <button class="plain-button" type="button" data-brief-context="${esc(item.postId)}">Показать бриф этой версии</button>
        <div data-brief-context-body="${esc(item.postId)}"></div></details></li>`).join('')}</ul>` : '';
    /* Черновики версий площадок — та же карточка автопостинга, тот же приём файлов.
       Номер карточки не задваивается с прежней расписки по дням. */
    const legacyIds = new Set(state.current ? state.current.postIds : []);
    const variantItems = (data.variantTransfer?.items || []).filter((item) => !legacyIds.has(item.postId));
    const byVariant = variantItems.length ? `<p>Черновики версий площадок: ${esc(variantItems.length)}.</p>
      <ul class="mentor-drafts" data-variant-drafts>${variantItems.map((item) => `<li>
        <details><summary>${esc(day(item.planDate))} · ${esc(item.platform)} · черновик №${esc(item.postId)} · ${esc(CARD_STATUS[dayStatus(item)].toLowerCase())}</summary>
        <p class="mentor-note">Идея ${esc(item.ideaId)} · версия содержимого ${esc(item.contentRevision)} ·
          план v${esc(item.planRevision)}, бриф v${esc(item.briefRevision)}${item.plannedDate ? ` · плановый выход ${esc(day(item.plannedDate))}${item.plannedTime ? ` ${esc(item.plannedTime)}` : ''}` : ''}.</p>
        <p class="mentor-material" data-has-media="${item.hasMedia ? 'yes' : 'no'}">
          <span>Материал:</span> ${item.hasMedia ? `добавлен · файлов ${esc(item.mediaCount)}` : 'не добавлен'}</p>
        ${edit && item.cardStatus === 'draft' ? `<label class="mentor-upload">Добавить свой материал (фото JPEG, PNG, WebP или видео MP4, WebM)
          <input type="file" data-material-file="${esc(item.postId)}"
            accept="image/jpeg,image/png,image/webp,video/mp4,video/webm"></label>
          <button class="plain-button" type="button" data-material-add="${esc(item.postId)}"
            data-post-revision="${esc(item.postRevision)}">Загрузить и приложить к карточке</button>
          <span data-material-state="${esc(item.postId)}" role="status"></span>`
    : '<p class="mentor-note">Эта карточка уже вышла из состояния черновика — работайте с ней в «Автопостинге», чтобы не переписать её результат.</p>'}
        <button class="plain-button" type="button" data-variant-context="${esc(item.postId)}"
          data-variant-context-plan="${esc(item.planRevision)}" data-variant-context-brief="${esc(item.briefRevision)}"
          data-variant-context-idea="${esc(item.ideaId)}" data-variant-context-platform="${esc(item.platform)}">Показать задание и бриф этой версии</button>
        <div data-variant-context-body="${esc(item.postId)}"></div>
        </details></li>`).join('')}</ul>` : '';
    return `<section class="card mentor-transfer" data-can="${state.canTransfer ? 'yes' : 'no'}">
      <h2>Черновики и файлы</h2>
      <p class="mentor-note">После согласования плана создайте карточки и добавьте фото или видео. Готовые карточки появятся в разделе <a href="#autoposting">«Материалы»</a>.</p>
      ${variantAware(data) ? `<p class="mentor-note" data-variant-transfer-here>Перенос выполняется в блоке «Версии площадок»
        рядом с планом — по одному черновику на согласованную версию. Здесь показаны уже созданные
        черновики и приём файлов к ним.</p>${byVariant}` : ''}
      <details class="mentor-team"><summary>Для команды · перенос и ограничения</summary>
      <p class="mentor-note">${esc(state.notice)}</p>
      <p class="mentor-note">Остаются незаполненными: ${state.leavesUnfilled.map((item) => esc(item)).join(' · ')}.</p>
      <p class="mentor-note">${esc(state.repeatProtection)}: повтор по той же версии вернёт те же черновики.</p>
      </details>
      ${state.current ? `<p class="mentor-note">${esc(state.materialNotice)} Без файла ждут заданий: ${esc(state.awaitingMaterial)}.</p>` : ''}
      ${state.newVersionNotice ? `<p class="mentor-warning" role="note">${esc(state.newVersionNotice)}</p>` : ''}
      ${done}
      ${variantAware(data) ? '' : edit && state.canTransfer ? `<form id="mentor-transfer-form" class="crm-form">
        <input type="hidden" name="planRevision" value="${esc(state.planRevision)}">
        <input type="hidden" name="briefRevision" value="${esc(state.briefRevision)}">
        <div class="crm-actions wide"><button class="plain-button" type="submit">Перенести план в черновики</button>
          <span id="mentor-transfer-state" role="status"></span></div></form>`
    : `<p class="mentor-note">${esc(edit ? state.blockedReason : 'Подготовить карточки поможет ответственный за материалы.')}</p>`}
      ${state.history.length ? `<details data-legacy-transfer-history><summary>${variantAware(data) ? 'Архив · прошлые переносы плана целиком' : 'Прошлые переносы'} (${esc(state.history.length)})</summary>
        <ol class="mentor-history">${state.history.map((item) => `<li>Версия плана ${esc(item.planRevision)} ·
          ${esc(item.dayCount)} дней · ${esc(moment(item.transferredAt))} · ${esc(item.actorName || '—')}</li>`).join('')}</ol></details>` : ''}
    </section>`;
  }

  /* Заявка на материалы считается на месте из уже загруженных плана и брифа:
     ни запроса к серверу, ни обращения к модели здесь нет. */
  function materialsMarkup(data) {
    const builder = sb.mediaMentorMaterials;
    if (!builder || !data.plan) return '';
    // У текущей версии уже может быть загружен файл, даже если описание в брифе
    // не выбрано. Убираем повторную просьбу только из списка задач, сам план не меняем.
    // Файл мог прийти к карточке любого происхождения — по дню или по версии площадки.
    const preparationPlan = {...data.plan, days: data.plan.days.map((item, index) =>
      cardsMedia(cardsFor(data, index, item)) ? {...item, assetId: item.assetId || 'uploaded-material'} : item)};
    const request = builder.build(preparationPlan, data.brief.fields);
    if (!request.items.length && !request.skipped.length) return '';
    const rows = request.items.map((item, index) => `<li>
      <div class="mentor-material-task"><strong>${esc(item.topic)}</strong><span>${esc(day(item.date))} · ${esc(item.platformLabel)} · ${esc(item.formatLabel)}</span>
        <p>${item.kind === 'video' ? 'Подготовьте короткое видео по этой теме.' : 'Подберите или сделайте изображение по этой теме.'}</p></div>
      <details class="mentor-team"><summary>Для команды · требования и промпт</summary>
        <p>${item.kind === 'video' ? 'Видео' : 'Картинка'} ${esc(item.ratio)}, не ниже ${esc(item.master)}</p>
        ${item.safeZone ? `<p class="mentor-note">${esc(item.safeZone)}</p>` : ''}
        <textarea class="mentor-prompt" rows="5" readonly data-prompt="${index}">${esc(item.prompt)}</textarea>
        <button class="plain-button" type="button" data-prompt-copy="${index}">Скопировать промт</button>
        <span data-prompt-state="${index}" role="status"></span>
        <ul class="mentor-list">${item.howTo.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>
        <p class="mentor-note">${esc(item.upscaleNote)}</p>
        <p class="mentor-note">Имя файла по стандарту: ${esc(item.fileName)}</p>
      </details></li>`).join('');
    return `<section class="card mentor-materials"><h2>Что подготовить</h2>
      <p>Посмотрите темы и даты ниже. Подготовьте подходящее фото или видео сами либо передайте список человеку, который поможет.</p>
      <p class="mentor-note">Это список задач, файлы автоматически не создаются. Готовый файл можно добавить в «Черновиках и файлах», когда для материала создан черновик.</p>
      ${request.warnings.length ? `<ul class="mentor-list crm-warning" role="note">${request.warnings.map((line) =>
    `<li>${esc(line)}</li>`).join('')}</ul>` : ''}
      ${rows ? `<ol class="mentor-plan-list">${rows}</ol>` : ''}
      ${request.skipped.length ? `<details class="mentor-note"><summary>Не включено в список: ${request.skipped.length}</summary>
        <ul class="mentor-list">${request.skipped.map((line) => `<li>${esc(line)}</li>`).join('')}</ul></details>` : ''}
      <details class="mentor-team"><summary>Для команды · как подготовить материалы</summary>
        <p class="mentor-note">${esc(request.notice)}</p>${request.batchNote ? `<p class="mentor-note">${esc(request.batchNote)}</p>` : ''}</details></section>`;
  }

  function markup(data, ctx) {
    const edit = canEdit(ctx);
    // Роль читателя фиксируется на время сборки разметки: кнопки решений рисуются только владельцу,
    // а тексты версий видны и на чтение.
    viewer = {decide: canDecide(ctx), edit};
    return `<details class="card mentor-brief"${!data.brief.revision || !data.brief.fields.platforms.length ? ' open' : ''}><summary>О компании · бриф${data.brief.revision ? ' · сохранён' : ' · начните здесь'}</summary>
        <p class="mentor-note">Версия ${esc(data.brief.revision)}${data.brief.updatedAt ? ` · обновлён ${esc(moment(data.brief.updatedAt))}` : ''}.
          ${edit ? 'План составьте сами или возьмите подсказку модели и проверьте её.' : 'У вас только просмотр.'}</p>
        ${briefMarkup(data, edit)}
        ${edit && data.brief.revision ? `<section class="mentor-suggest" data-analyze>
          <h3>Разбор брифа</h3>
          <p class="mentor-note">Модель предложит позиционирование, рубрики и назовёт, каких сведений
            не хватает. Ничего не сохраняется: разбор нужен вам, а не системе.</p>
          <button class="plain-button" type="button" data-analyze-run>Разобрать бриф</button>
          <span data-analyze-state role="status"></span>
          <div data-analyze-result></div></section>` : ''}
        ${data.brief.history.length ? `<details><summary>История брифа (${esc(data.brief.history.length)})</summary>
          <ol class="mentor-history">${data.brief.history.map((item) => `<li>Версия ${esc(item.revision)} · ${esc(moment(item.createdAt))} ·
            ${esc(item.actorName || '—')}${item.reason ? `<br>${esc(item.reason)}` : ''}</li>`).join('')}</ol></details>` : ''}</details>
      <section class="card mentor-plan"><h2>Контент-план</h2>
        <p class="mentor-note">Выберите материал по дате. ${edit ? 'Для изменений или предложения откройте «Подробности и правки».' : 'Задание и пояснения — в «Подробностях материала».'}</p>
        ${planMarkup(data, edit)}
        ${data.plan && data.plan.history.length ? `<details><summary>История плана (${esc(data.plan.history.length)})</summary>
          <ol class="mentor-history">${data.plan.history.map((item) => `<li>Версия ${esc(item.revision)} по брифу ${esc(item.briefRevision)} ·
            ${esc(moment(item.createdAt))} · ${esc(item.actorName || '—')}</li>`).join('')}</ol></details>` : ''}</section>
      ${approvalMarkup(data, ctx)}${edit ? materialsMarkup(data) : ''}${transferMarkup(data, ctx)}
      ${edit ? `<details class="card mentor-review"><summary>Разбор результатов · что улучшить</summary>
        <section class="mentor-suggest" data-review>
          <p class="mentor-note">Модель посмотрит собранные цифры и предложит, что изменить в плане.
            Площадки, по которым статистика не собирается, в разбор не попадают: отсутствие данных —
            это не плохой результат. Ничего не меняется автоматически.</p>
          <label>С<input data-review-from type="date" value="${esc(isoDay(-29))}"></label>
          <label>По<input data-review-to type="date" value="${esc(isoDay(0))}"></label>
          <button class="plain-button" type="button" data-review-run>Разобрать результаты</button>
          <span data-review-state role="status"></span>
          <div data-review-result></div></section></details>` : ''}
      <details class="mentor-team mentor-methods"><summary>Как контент приводит к обращению · схема</summary>
        ${journeyMarkup(data)}${propertyExampleMarkup(ctx)}</details>`;
  }

  const rowValues = (row) => Object.fromEntries([...row.querySelectorAll('[data-field]')]
    .map((field) => [field.dataset.field, field.value.trim()]));
  // Полностью пустую строку, которую добавили и бросили, убираем до проверки полей:
  // иначе обязательное поле пустой строки не даст сохранить весь бриф.
  const pruneEmptyRows = (form) => form.querySelectorAll('[data-rows="facts"] [data-row],[data-rows="assets"] [data-row]')
    .forEach((row) => {
      const values = rowValues(row);
      if (Object.entries(values).every(([key, value]) => key === 'id' || key === 'kind' || !value)) row.remove();
    });

  function collectBrief(form) {
    const facts = [...form.querySelectorAll('[data-rows="facts"] [data-row]')]
      .map((element) => ({...rowValues(element), approved: element.querySelector('[data-fact-approved]').checked}))
      .filter((row) => row.statement || row.source)
      .map((row) => ({id: row.id || newId(), statement: row.statement, source: row.source,
        ...(row.approved ? {approvedForContent: true} : {})}));
    const assets = [...form.querySelectorAll('[data-rows="assets"] [data-row]')].map(rowValues)
      .filter((row) => row.title)
      .map((row) => ({id: row.id || newId(), title: row.title, kind: row.kind, note: row.note}));
    return {goal: form.elements.goal.value.trim(), product: form.elements.product.value.trim(),
      audience: form.elements.audience.value.trim(),
      pains: form.elements.pains.value.split('\n').map((line) => line.trim()).filter(Boolean),
      confirmedFacts: facts, assets,
      shootingComfort: {level: form.elements.comfortLevel.value, notes: form.elements.comfortNotes.value.trim()},
      platforms: [...form.querySelectorAll('input[name="platform"]:checked')].map((box) => box.value)};
  }
  // Порядок на экране меняется независимо от исходных индексов версии плана.
  // Скрытые фильтрами строки тоже отправляются; dayIndex обратной связи не перенумеровывается.
  /* Версии собираются со ВСЕХ панелей строки, включая скрытые переключателем: закрытая
     вкладка — это не удалённая версия, и терять её текст при сохранении нельзя. */
  const rowVariants = (row) => Object.fromEntries([...row.querySelectorAll('[data-variant]')]
    .map((panel) => [panel.dataset.variant, Object.fromEntries([...panel.querySelectorAll('[data-variant-field]')]
      .map((field) => [field.dataset.variantField,
        field.type === 'checkbox' ? field.checked : field.value.trim()]))]));
  const collectDays = (form) => [...form.querySelectorAll('[data-rows="days"] [data-row]')]
    .sort((a, b) => a.querySelector('[data-field="date"]').value.localeCompare(b.querySelector('[data-field="date"]').value)
      || Number(a.dataset.sourceOrder) - Number(b.dataset.sourceOrder))
    .map((row) => ({...rowValues(row), ideaId: row.dataset.ideaId || '', variants: rowVariants(row)}))
    .map((row) => ({date: row.date, platform: row.platform, format: row.format, role: row.role,
      topic: row.topic, hook: row.hook, assetId: row.assetId, mentorNote: row.mentorNote,
      // Пустой ideaId не передаётся: сервер выдаёт его сам при первом сохранении идеи.
      ...(row.ideaId ? {ideaId: row.ideaId} : {}),
      ...(Object.keys(row.variants).length ? {variants: row.variants} : {})}));

  function bind(container, node, ctx, data) {
    const code = ctx.selectedProjectId;
    const busy = (form, state) => form.querySelectorAll('button,input,select,textarea')
      .forEach((element) => { element.disabled = state; });
    const feed = node.querySelector('[data-plan-feed]');
    const filter = (name) => node.querySelector(`[data-plan-filter="${name}"]`);
    let nextSourceOrder = data.plan?.days.length || 0;
    const openParents = (element) => {
      for (let parent = element?.parentElement; parent && parent !== node; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS') parent.open = true;
      }
    };
    const applyPlanView = () => {
      if (!feed) return;
      const rows = [...feed.children];
      rows.forEach((row) => {if (!row.hasAttribute('data-source-order')) row.dataset.sourceOrder = String(nextSourceOrder++);});
      const from = filter('from').value, to = filter('to').value;
      const invalidRange = from && to && from > to;
      const platform = filter('platform').value, status = filter('status').value, order = filter('order').value;
      const today = localToday();
      const sortDate = (a, b) => {
        const left = a.dataset.planDate, right = b.dataset.planDate;
        if (!left || !right) return !left === !right ? 0 : !left ? 1 : -1;
        if (order === 'nearest') {
          const leftPast = left < today, rightPast = right < today;
          if (leftPast !== rightPast) return leftPast ? 1 : -1;
          return leftPast ? right.localeCompare(left) : left.localeCompare(right);
        }
        return order === 'desc' ? right.localeCompare(left) : left.localeCompare(right);
      };
      rows.sort((a, b) => sortDate(a, b) || Number(a.dataset.sourceOrder) - Number(b.dataset.sourceOrder));
      rows.forEach((row) => {
        const date = row.dataset.planDate;
        /* Фильтр площадки — по НАЛИЧИЮ версии для неё, а не по основной площадке идеи:
           идея в Telegram с версией для ВКонтакте обязана находиться по фильтру «ВКонтакте».
           Список площадок строки обновляется и для ещё не сохранённой добавленной версии. */
        const rowPlatformList = (row.dataset.planPlatforms || row.dataset.planPlatform || '').split(' ').filter(Boolean);
        row.hidden = Boolean(invalidRange || (platform && !rowPlatformList.includes(platform)) ||
          (status && row.dataset.cardStatus !== status) || (from && (!date || date < from)) || (to && (!date || date > to)));
        feed.append(row); // Перемещаем тот же узел: введённые поля, раскрытия и feedback не теряются.
      });
      const visible = rows.filter((row) => !row.hidden).length;
      node.querySelector('[data-plan-filter-state]').textContent = invalidRange
        ? 'Дата начала позже даты окончания. Исправьте диапазон или сбросьте фильтры.'
        : `Показано ${visible} из ${rows.length} материалов${from && from === to ? ` · ${day(from)}` : ''}.`;
      node.querySelector('[data-plan-filter-empty]').hidden = visible > 0 || rows.length === 0 || Boolean(invalidRange);
      node.querySelector('[data-plan-reset]').hidden = !(platform || from || to || status || order !== 'nearest');
      const extraCount = Number(Boolean(from || to)) + Number(Boolean(status));
      node.querySelector('[data-plan-extra-summary]').textContent = `Ещё фильтры${extraCount ? ` · выбрано ${extraCount}` : ''}`;
    };
    const resetFilters = () => {
      node.querySelectorAll('[data-plan-filter]').forEach((field) => {field.value = field.dataset.planFilter === 'order' ? 'nearest' : '';});
      applyPlanView();
    };
    node.querySelectorAll('[data-plan-filter]').forEach((field) => field.addEventListener('change', applyPlanView));
    node.querySelector('[data-plan-reset]')?.addEventListener('click', resetFilters);
    applyPlanView();
    const syncDayPreview = (row) => {
      if (!row?.classList.contains('mentor-day')) return;
      const field = (name) => row.querySelector(`[data-field="${name}"]`);
      const preview = row.querySelector('.mentor-day-preview');
      preview.dataset.previewFormat = field('format').value;
      row.querySelector('[data-preview-platform]').textContent = field('platform').selectedOptions[0]?.textContent || 'Площадка';
      row.querySelector('[data-preview-format-label]').textContent = field('format').selectedOptions[0]?.textContent || 'Формат';
      row.querySelector('[data-preview-date]').textContent = field('date').value ? day(field('date').value) : 'Дата не выбрана';
      row.querySelector('[data-preview-topic]').textContent = field('topic').value.trim() || 'Тема публикации';
      row.dataset.planDate = field('date').value;
      row.dataset.planPlatform = field('platform').value;
      syncRowPlatforms(row);
    };
    /* Площадки строки пересчитываются по фактическим панелям версий, включая только что
       добавленную и ещё не сохранённую. Основная площадка идеи добавляется, даже если
       версии для неё пока нет: иначе материал исчез бы из своего же фильтра. */
    function syncRowPlatforms(row) {
      if (!row) return;
      const list = [...row.querySelectorAll('[data-variant]')].map((panel) => panel.dataset.variant);
      const main = row.querySelector('[data-field="platform"]')?.value || row.dataset.planPlatform || '';
      if (main && !list.includes(main)) list.push(main);
      row.dataset.planPlatforms = list.filter(Boolean).join(' ');
    }
    const dayRows = node.querySelector('[data-rows="days"]');
    for (const type of ['input', 'change']) dayRows?.addEventListener(type, (event) => {
      if (event.target.matches('[data-field]')) {
        syncDayPreview(event.target.closest('[data-row]'));
        if (type === 'change' && ['date', 'platform'].includes(event.target.dataset.field)) applyPlanView();
      }
    });
    node.querySelectorAll('[data-journey-target]').forEach((button) => button.addEventListener('click', () => {
      const target = node.ownerDocument.getElementById(button.dataset.journeyTarget);
      if (target?.tagName === 'DETAILS') target.open = true;
      openParents(target);
      target?.scrollIntoView?.({block: 'start'});
    }));
    node.querySelectorAll('[data-material-target]').forEach((button) => button.addEventListener('click', () => {
      const target = node.querySelector(`[data-material-file="${button.dataset.materialTarget}"]`);
      if (!target) return;
      openParents(target);
      target.scrollIntoView?.({block: 'center'});
      target.focus();
    }));
    node.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => {
      const kind = button.dataset.add, body = button.closest('[data-rows]').querySelector('[data-rows-body]');
      const markupFor = kind === 'facts' ? factRow()
        : kind === 'assets' ? assetRow(undefined, data.vocabulary.assetKinds)
          : dayRow({date: '', platform: data.brief.fields.platforms[0] || '', format: 'post', role: 'reach',
            topic: '', hook: '', assetId: '', mentorNote: ''}, data);
      body.insertAdjacentHTML('beforeend', markupFor);
      const added = body.lastElementChild;
      added.querySelector('[data-remove]').addEventListener('click', (event) => {
        event.target.closest('[data-row]').remove(); applyPlanView();
      });
      syncDayPreview(added);
      // Новая строка получает те же обработчики, что и остальные: версии, порядок и решения
      // должны работать сразу, а не после перезагрузки раздела.
      added.querySelectorAll('[data-variants]').forEach(wireVariants);
      added.querySelectorAll('[data-move]').forEach(wireMove);
      if (kind === 'days') {resetFilters(); added.querySelector('[data-field="date"]').focus();}
    }));
    node.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click',
      (event) => {event.target.closest('[data-row]').remove(); applyPlanView();}));
    node.querySelectorAll('[data-feedback-send]').forEach((button) => button.addEventListener('click', async () => {
      const index = Number(button.dataset.feedbackSend), state = node.querySelector(`[data-feedback-state="${index}"]`);
      const input = node.querySelector(`[data-feedback-input="${index}"]`), message = input?.value.trim() || '';
      if (!message) { state.textContent = 'Напишите предложение.'; return; }
      button.disabled = true;
      state.textContent = 'Сохраняем предложение…';
      try {
        const saved = await ctx.crmQuery(`${PATH}/plan/feedback`, {companyCode: code},
          ctx.csrfOptions('POST', {planRevision: data.plan.revision, dayIndex: index, message}));
        if (ctx.selectedProjectId !== code || !button.isConnected || !node.contains(button)) return;
        // Не перерисовываем весь бриф/план: предложение не должно стирать правки
        // даты, темы и других полей, которые человек ещё не сохранил.
        if (saved.companyCode === String(code).toLowerCase() && saved.plan?.revision === data.plan.revision && Array.isArray(saved.feedback)) {
          const entries = saved.feedback.filter((entry) => entry.dayIndex === index);
          node.querySelector(`[data-feedback-list="${index}"]`).innerHTML = `<ul class="mentor-list">${entries.map((entry) =>
            `<li>${esc(entry.message)}<small>${esc(entry.actorName || 'Участник')} · ${esc(moment(entry.createdAt))}</small></li>`).join('')}</ul>`;
        }
        if (input.value.trim() === message) input.value = '';
        button.disabled = false;
        state.textContent = 'Предложение сохранено к текущей версии плана. Остальные правки ещё нужно сохранить.';
      } catch (error) {
        if (ctx.selectedProjectId !== code) return;
        button.disabled = false;
        state.textContent = error.message;
      }
    }));

    const submit = async (form, stateId, path, method, body) => {
      const state = node.querySelector(stateId);
      busy(form, true);
      state.textContent = 'Сохраняем…';
      try {
        await ctx.crmQuery(path, {companyCode: code}, ctx.csrfOptions(method, body));
        if (ctx.selectedProjectId !== code) return;
        await load(container, ctx);
      } catch (error) {
        if (ctx.selectedProjectId !== code) return;
        busy(form, false);
        state.textContent = error.message;
      }
    };
    node.querySelector('#mentor-brief-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      pruneEmptyRows(form);
      if (!form.reportValidity()) return;
      void submit(form, '#mentor-brief-state', `${PATH}/brief`, 'PUT',
        {revision: Number(form.elements.revision.value), brief: collectBrief(form)});
    });
    // Браузер проверяет поля до submit: сначала показываем скрытую карточку,
    // чтобы он мог сфокусировать поле. Незавершённый материал не удаляется.
    node.querySelector('#mentor-plan-form')?.addEventListener('invalid', (event) => {
      if (!event.target.closest('.mentor-day')) return;
      resetFilters();
      openParents(event.target);
      node.querySelector('#mentor-plan-state').textContent = 'Заполните выделенное поле материала. Все строки плана сохранены в форме; фильтры сброшены.';
    }, true);
    /* ---------- Версии площадок: переключение, добавление, порядок и адресные решения ---------- */
    const planForm = node.querySelector('#mentor-plan-form');
    /* Снимок сохранённого состава плана. По нему видно, есть ли в форме несохранённые правки:
       решение и перенос по невидимому серверу тексту молча принимать нельзя. */
    const savedPlan = planForm ? JSON.stringify(collectDays(planForm)) : null;
    const planDirty = () => Boolean(planForm) && JSON.stringify(collectDays(planForm)) !== savedPlan;
    const say = (element, message) => { if (element) element.textContent = message; };

    const platformLabelOf = (id) => (data.vocabulary.platforms.find((item) => item.id === id) || {}).label || id;
    const captionLimit = (id) => (data.vocabulary.captionLimits || {})[id] || null;

    /* Полноценное добавление площадки: своя вкладка, свой лимит, свои обработчики и пустые
       поля. Клонировать соседнюю версию нельзя — у неё чужой текст и чужой лимит. */
    function addVariant(block, platformId) {
      const panels = block.querySelector('[data-variant-panels]');
      const tabs = block.querySelector('[data-variant-tabs]');
      if (!panels || !tabs || block.querySelector(`[data-variant="${platformId}"]`)) return null;
      const ideaId = block.dataset.variants || '';
      const label = platformLabelOf(platformId), limit = captionLimit(platformId);
      const panel = node.ownerDocument.createElement('div');
      panel.className = 'mentor-variant-panel';
      panel.dataset.variant = platformId;
      panel.dataset.variantIdea = ideaId;
      panel.innerHTML = `<label data-variant-text-label>Текст для площадки «${esc(label)}»${limit ? ` · до ${esc(limit)} символов` : ''}
          <textarea data-variant-field="text"${limit ? ` maxlength="${esc(limit)}"` : ''} rows="4"></textarea></label>
        <details class="mentor-day-more"><summary>Подробности версии</summary>
          <label>Зацепка<input data-variant-field="hook" maxlength="500" value=""></label>
          <label>Формат<select data-variant-field="format"><option value="">Как у идеи</option>${options(data.vocabulary.formats, '')}</select></label>
          <label>Что уже есть<select data-variant-field="assetId">${options([{id: '', label: 'Ничего не выбрано'},
    ...data.brief.fields.assets.map((asset) => ({id: asset.id, label: asset.title}))], '')}</select></label>
          <label>Заметка наставника<textarea data-variant-field="mentorNote" rows="2" maxlength="2000"></textarea></label>
          <div class="mentor-day-selects">
            <label>Плановая дата<input data-variant-field="plannedDate" type="date" value=""></label>
            <label>Плановое время<input data-variant-field="plannedTime" type="time" value=""></label>
            <label>Часовой пояс<input data-variant-field="timezone" maxlength="64" placeholder="Например: Asia/Irkutsk" value=""></label>
          </div>
          <label class="mentor-inline"><input data-variant-field="excluded" type="checkbox"> Эту площадку не публикуем</label>
          <p class="mentor-note">${esc(PLAN_TIME_NOTE)}</p>
        </details>
        <p class="mentor-note" data-variant-decision>Решения по этой версии ещё нет.</p>
        <p class="mentor-note" data-variant-card="">В черновики ещё не переносилась.</p>
        <p class="mentor-note">Новая версия согласуется после сохранения плана.</p>`;
      panels.append(panel);
      const tab = node.ownerDocument.createElement('button');
      tab.type = 'button';
      tab.className = 'mentor-variant-tab';
      tab.dataset.variantTab = platformId;
      tab.dataset.variantState = 'pending';
      tab.setAttribute('aria-pressed', 'false');
      tab.textContent = `${label} · новая`;
      tabs.append(tab);
      block.querySelector('[data-variant-empty]')?.remove();
      wireTabs(block);
      showVariant(block, platformId);
      // Новая версия сразу попадает в фильтр площадок, ещё до сохранения плана.
      syncRowPlatforms(block.closest('[data-row]'));
      applyPlanView();
      return panel;
    }

    const showVariant = (block, platformId) => {
      block.querySelectorAll('[data-variant]').forEach((panel) => {
        panel.hidden = panel.dataset.variant !== platformId;
      });
      block.querySelectorAll('[data-variant-tab]').forEach((tab) => {
        tab.setAttribute('aria-pressed', tab.dataset.variantTab === platformId ? 'true' : 'false');
      });
    };
    // Обработчики вешаются заново после добавления версии: новая вкладка обязана работать сразу.
    function wireTabs(block) {
      block.querySelectorAll('[data-variant-tab]').forEach((tab) => {
        if (tab.dataset.variantWired) return;
        tab.dataset.variantWired = '1';
        tab.addEventListener('click', () => showVariant(block, tab.dataset.variantTab));
      });
    }
    function wireVariants(block) {
      wireTabs(block);
      const adder = block.querySelector('[data-variant-add]');
      if (adder && !adder.dataset.variantWired) {
        adder.dataset.variantWired = '1';
        adder.addEventListener('change', () => {
          const platformId = adder.value;
          if (!platformId) return;
          if (addVariant(block, platformId)) adder.querySelector(`option[value="${platformId}"]`)?.remove();
          adder.value = '';
          if (!adder.querySelector('option[value]:not([value=""])')) adder.hidden = true;
        });
      }
      block.querySelectorAll('[data-variant-decide]').forEach(wireDecision);
    }

    /* Адресное решение по версиям. Область называется явно: «весь план», «вся идея» и
       «эта версия» — разные утверждения, и одно другим здесь не подменяется. */
    function wireDecision(button) {
      if (button.dataset.variantWired) return;
      button.dataset.variantWired = '1';
      button.addEventListener('click', () => {
        if (!planForm) return;
        const decision = button.dataset.variantDecide;
        const scopeAttr = button.dataset.variantScope || '';
        const ideaId = button.dataset.variantIdeaId || '';
        const platform = button.dataset.variantPlatform || '';
        /* Поля причины и состояния выбираются ПО ОБЛАСТИ решения, а не поиском ближайшего
           подходящего узла. Раньше решение по всей идее брало первое поле внутри блока версий —
           то есть поле первой панели, даже скрытой: причину писали в открытой вкладке, а
           уходила пустая из скрытой, и ошибка появлялась там, где её не видно.
           У каждой области теперь своё имя поля, и вкладка на это не влияет. */
        const scopeFields = () => {
          if (scopeAttr !== 'plan' && platform) {
            const panel = button.closest('[data-variant]');
            return {comment: panel?.querySelector('[data-variant-comment]'),
              line: panel?.querySelector('[data-variant-state-line]')};
          }
          if (scopeAttr !== 'plan') {
            const block = button.closest('[data-variants]');
            return {comment: block?.querySelector('[data-idea-comment]'),
              line: block?.querySelector('[data-idea-state-line]')};
          }
          const block = button.closest('[data-plan-variants]');
          return {comment: block?.querySelector('[data-plan-comment]'),
            line: block?.querySelector('[data-plan-state-line]')};
        };
        const fields = scopeFields();
        const comment = fields.comment?.value.trim() || '';
        const line = fields.line;
        // Несохранённые правки: решение относилось бы к прежнему тексту — этого не допускаем.
        if (planDirty()) { say(line, DIRTY_NOTE); return; }
        if (decision === 'rejected' && !comment) {
          say(line, 'Укажите, что исправить: возврат без причины исполнителю ничего не говорит.');
          return;
        }
        const scope = scopeAttr === 'plan' ? 'plan' : (platform ? 'variants' : 'idea');
        void submit(planForm, '#mentor-plan-state', `${PATH}/plan/variants/decision`, 'POST',
          {planRevision: Number(planForm.elements.planRevision.value),
            briefRevision: Number(planForm.elements.briefRevision.value),
            scope, ...(scope === 'plan' ? {} : {ideaId}),
            ...(scope === 'variants' ? {platforms: [platform]} : {}), decision, comment});
      });
    }

    node.querySelectorAll('[data-variants]').forEach(wireVariants);
    node.querySelectorAll('[data-plan-variants] [data-variant-decide]').forEach(wireDecision);

    /* Перенос согласованных версий в независимые черновики. Ничего не публикует
       и в очередь не ставит: материал в «Автопостинге» одобряется отдельно. */
    node.querySelector('[data-variants-transfer]')?.addEventListener('click', () => {
      if (!planForm) return;
      const line = node.querySelector('[data-variants-transfer-state]');
      if (planDirty()) { say(line, DIRTY_NOTE); return; }
      void submit(planForm, '#mentor-plan-state', `${PATH}/plan/variants/transfer`, 'POST',
        {planRevision: Number(planForm.elements.planRevision.value),
          briefRevision: Number(planForm.elements.briefRevision.value)});
    });

    /* Порядок материалов в плане. Сервер держит дни по возрастанию даты, поэтому «выше» и
       «ниже» — это ОБМЕН КАЛЕНДАРНЫМИ ДАТАМИ с соседом, а не переброс строки. Так кнопка
       делает ровно то, что обещает, и сохранение не отвергается; окно плана не меняется,
       потому что набор дат остаётся прежним. */
    function wireMove(button) {
      if (button.dataset.moveWired) return;
      button.dataset.moveWired = '1';
      button.addEventListener('click', () => {
      const row = button.closest('[data-row]');
      const rows = [...(feed ? feed.children : [])];
      const at = rows.indexOf(row), to = button.dataset.move === 'up' ? at - 1 : at + 1;
      if (at < 0 || to < 0 || to >= rows.length) return;
      const neighbour = rows[to];
      const mine = row.querySelector('[data-field="date"]'), theirs = neighbour.querySelector('[data-field="date"]');
      if (!mine || !theirs) return;
      const keep = mine.value;
      /* Плановая дата версии. Если она совпадала с датой идеи, версия держалась за идею —
         и переезжает вместе с ней. Если версия задала СВОЮ, отличную дату, она остаётся как
         была: молча переписать заданное человеком нельзя. Но и промолчать тоже нельзя —
         об оставшихся датах сказано прямо под кнопками. */
      const carryDates = (target, fromDate, toDate) => {
        const stayed = [];
        for (const panel of target.querySelectorAll('[data-variant]')) {
          const field = panel.querySelector('[data-variant-field="plannedDate"]');
          if (!field || !field.value) continue;
          if (field.value === fromDate) field.value = toDate;
          else stayed.push(panel.dataset.variant);
        }
        return stayed;
      };
      const stayedHere = carryDates(row, keep, theirs.value);
      const stayedThere = carryDates(neighbour, theirs.value, keep);
      const stayed = [...new Set([...stayedHere, ...stayedThere])];
      const note = row.querySelector('[data-move-note]');
      if (note) {
        note.textContent = stayed.length
          ? `Материалы поменялись датами. У этих версий задана своя дата выхода, она не менялась: ${stayed.join(', ')}.`
          : 'Материалы поменялись датами вместе со своими версиями.';
      }
      mine.value = theirs.value;
      theirs.value = keep;
      row.dataset.planDate = mine.value;
      neighbour.dataset.planDate = theirs.value;
      const order = Number(row.dataset.sourceOrder);
      row.dataset.sourceOrder = neighbour.dataset.sourceOrder;
      neighbour.dataset.sourceOrder = String(order);
      for (const target of [row, neighbour]) {
        const label = target.querySelector('[data-preview-date]');
        if (label) label.textContent = target.querySelector('[data-field="date"]').value;
      }
      if (button.dataset.move === 'up') feed.insertBefore(row, neighbour);
      else feed.insertBefore(neighbour, row);
      });
    }
    node.querySelectorAll('[data-move]').forEach(wireMove);
    node.querySelector('#mentor-plan-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      if (!form.reportValidity()) return;
      void submit(form, '#mentor-plan-state', `${PATH}/plan`, 'PUT',
        {planRevision: Number(form.elements.planRevision.value),
          briefRevision: Number(form.elements.briefRevision.value), days: collectDays(form)});
    });
    /* Материал принимается существующим приёмом файлов автопостинга и прикладывается
       к той же карточке. Второго склада нет: загрузка идёт в /content/publishing-assets
       своей компании, а ссылка дописывается в mediaUrls карточки существующим маршрутом. */
    node.querySelectorAll('[data-material-add]').forEach((button) => button.addEventListener('click', async () => {
      const postId = button.dataset.materialAdd;
      const input = node.querySelector(`[data-material-file="${postId}"]`);
      const state = node.querySelector(`[data-material-state="${postId}"]`);
      const item = (data.transfer?.current?.items || []).find((row) => String(row.postId) === String(postId));
      const file = input?.files?.[0];
      if (!file) { state.textContent = 'Выберите файл материала.'; return; }
      button.disabled = true;
      state.textContent = 'Загружаем материал…';
      try {
        const uploaded = await ctx.apiJson(
          `${data.transfer.materialUploadPath}?companyCode=${encodeURIComponent(code)}`,
          {method: 'POST', body: file,
            headers: {'Content-Type': file.type, 'X-CSRF-Token': ctx.identity.csrfToken}});
        if (ctx.selectedProjectId !== code) return;
        await ctx.crmQuery(`/autoposting/posts/${encodeURIComponent(postId)}`, {companyCode: code},
          ctx.csrfOptions('PATCH', {revision: Number(button.dataset.postRevision),
            mediaUrls: [...(item ? item.mediaUrls : []), uploaded.url]}));
        if (ctx.selectedProjectId !== code) return;
        await load(container, ctx);
      } catch (error) {
        if (ctx.selectedProjectId !== code) return;
        button.disabled = false;
        state.textContent = error.message;
      }
    }));
    // Копирование промта: буфер обмена может быть недоступен, поэтому есть запасной путь.
    node.querySelectorAll('[data-prompt-copy]').forEach((button) => button.addEventListener('click', async () => {
      const index = button.dataset.promptCopy;
      const field = node.querySelector(`[data-prompt="${index}"]`);
      const state = node.querySelector(`[data-prompt-state="${index}"]`);
      try {
        await window.navigator.clipboard.writeText(field.value);
        state.textContent = 'Промт скопирован.';
      } catch {
        field.select();
        state.textContent = 'Буфер обмена недоступен: промт выделен, скопируйте вручную.';
      }
    }));
    /* Разбор результатов. Выводы и правки только показываются: план меняет человек руками. */
    node.querySelector('[data-review-run]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const state = node.querySelector('[data-review-state]');
      const result = node.querySelector('[data-review-result]');
      const from = node.querySelector('[data-review-from]').value;
      const to = node.querySelector('[data-review-to]').value;
      if (!from || !to) { state.textContent = 'Укажите обе даты периода.'; return; }
      if (from > to) { state.textContent = 'Начало периода позже его конца.'; return; }
      button.disabled = true;
      state.textContent = 'Считаем и спрашиваем модель…';
      result.innerHTML = '';
      try {
        const answer = await ctx.apiJson(`${REVIEW_PATH}?companyCode=${encodeURIComponent(code)}`,
          ctx.csrfOptions('POST', {from, to}));
        if (ctx.selectedProjectId !== code || !result.isConnected) return;
        button.disabled = false;
        state.textContent = '';
        const findings = (answer.findings || []).length
          ? `<h4>Что видно по цифрам</h4><ul class="mentor-list">${answer.findings.map((item) =>
            `<li>${esc(item.statement)}<br><span class="mentor-note">Опора: ${esc(item.basis)}</span></li>`).join('')}</ul>`
          : '';
        const changes = (answer.planChanges || []).length
          ? `<h4>Что предлагается в плане</h4><ul class="mentor-list">${answer.planChanges.map((item) =>
            `<li><strong>${esc(item.actionLabel)}</strong>${item.platform ? ` · ${esc(
              data.vocabulary.platforms.find((p) => p.id === item.platform)?.label || item.platform)}` : ''}${
              item.format ? ` · ${esc(data.vocabulary.formats.find((f) => f.id === item.format)?.label || item.format)}` : ''
            }<br>${esc(item.why)}</li>`).join('')}</ul>`
          : '';
        const questions = (answer.questions || []).length
          ? `<h4>Вопросы, на которые цифр не хватило</h4><ul class="mentor-list">${answer.questions.map((item) =>
            `<li>${esc(item)}</li>`).join('')}</ul>`
          : '';
        // Пропущенные площадки называем прямо: иначе человек решит, что по ним всё плохо.
        const skipped = (answer.skipped || []).length
          ? `<p class="mentor-note">Без данных за период, в разбор не вошли: ${answer.skipped.map((id) =>
            esc(data.vocabulary.platforms.find((p) => p.id === id)?.label || id)).join(', ')}.</p>`
          : '';
        const dropped = (answer.dropped || []).length
          ? `<details class="mentor-note"><summary>Отброшено: ${answer.dropped.length}</summary>
              <ul class="mentor-list">${answer.dropped.map((line) => `<li>${esc(line)}</li>`).join('')}</ul></details>`
          : '';
        result.innerHTML = answer.status === 'ok'
          ? `<p class="mentor-note">${esc(answer.notice)}</p>${findings}${changes}${questions}${skipped}${dropped}`
          : `<p class="mentor-note">${esc(answer.notice)}</p>${skipped}${questions}${dropped}`;
      } catch (error) {
        if (ctx.selectedProjectId !== code || !result.isConnected) return;
        button.disabled = false;
        state.textContent = error.message;
      }
    });
    /* Разбор брифа. Только показывается: ни позиционирование, ни рубрики никуда не записываются. */
    node.querySelector('[data-analyze-run]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const state = node.querySelector('[data-analyze-state]');
      const result = node.querySelector('[data-analyze-result]');
      button.disabled = true;
      state.textContent = 'Спрашиваем модель…';
      result.innerHTML = '';
      try {
        const answer = await ctx.apiJson(`${ANALYZE_PATH}?companyCode=${encodeURIComponent(code)}`,
          ctx.csrfOptions('POST', {}));
        if (ctx.selectedProjectId !== code || !result.isConnected) return;
        button.disabled = false;
        state.textContent = '';
        const rubrics = (answer.rubrics || []).length
          ? `<h4>Рубрики</h4><ul class="mentor-list">${answer.rubrics.map((item) =>
            `<li><strong>${esc(item.title)}</strong>${item.why ? ` — ${esc(item.why)}` : ''}${
              item.formats.length ? `<br><span class="mentor-note">Форматы: ${item.formats.map((id) =>
                esc(data.vocabulary.formats.find((f) => f.id === id)?.label || id)).join(', ')}</span>` : ''}</li>`).join('')}</ul>`
          : '';
        // Пробелы — вопросы к человеку, а не то, что модель имеет право додумать.
        const gaps = (answer.gaps || []).length
          ? `<h4>Чего не хватает в брифе</h4><ul class="mentor-list">${answer.gaps.map((item) =>
            `<li>${esc(item)}</li>`).join('')}</ul>`
          : '';
        const dropped = (answer.dropped || []).length
          ? `<details class="mentor-note"><summary>Отброшено: ${answer.dropped.length}</summary>
              <ul class="mentor-list">${answer.dropped.map((line) => `<li>${esc(line)}</li>`).join('')}</ul></details>`
          : '';
        result.innerHTML = answer.status === 'ok'
          ? `<p class="mentor-note">${esc(answer.notice)}</p>
             ${answer.positioning ? `<h4>Позиционирование</h4><p>${esc(answer.positioning)}</p>` : ''}
             ${answer.audience ? `<h4>Аудитория</h4><p>${esc(answer.audience)}</p>` : ''}
             ${rubrics}${gaps}${dropped}`
          : `<p class="mentor-note">${esc(answer.notice)}</p>${dropped}`;
      } catch (error) {
        if (ctx.selectedProjectId !== code || !result.isConnected) return;
        button.disabled = false;
        state.textContent = error.message;
      }
    });
    /* Подсказка плана. Предложение только показывается; в план оно попадает единственным
       способом — человек нажимает «Подставить в форму», проверяет строки и сохраняет форму сам. */
    const suggestRow = (item) => `<li><strong>${esc(day(item.date))}</strong> ·
      ${esc(data.vocabulary.platforms.find((p) => p.id === item.platform)?.label || item.platform)} ·
      ${esc(data.vocabulary.formats.find((f) => f.id === item.format)?.label || item.format)} ·
      ${esc(data.vocabulary.roles.find((r) => r.id === item.role)?.label || item.role)}<br>${esc(item.topic)}${
  item.hook ? `<br><span class="mentor-note">${esc(item.hook)}</span>` : ''}</li>`;
    let suggested = [];
    node.querySelector('[data-suggest-run]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const state = node.querySelector('[data-suggest-state]');
      const result = node.querySelector('[data-suggest-result]');
      const startDate = node.querySelector('[data-suggest-start]').value;
      const days = Number(node.querySelector('[data-suggest-days]').value);
      if (!startDate) { state.textContent = 'Укажите дату начала.'; return; }
      button.disabled = true;
      state.textContent = 'Спрашиваем модель…';
      result.innerHTML = '';
      try {
        const answer = await ctx.apiJson(`${SUGGEST_PATH}?companyCode=${encodeURIComponent(code)}`,
          ctx.csrfOptions('POST', {startDate, days}));
        if (ctx.selectedProjectId !== code || !result.isConnected) return;
        button.disabled = false;
        state.textContent = '';
        suggested = answer.status === 'ok' ? answer.items : [];
        const dropped = (answer.dropped || []).length
          ? `<details class="mentor-note"><summary>Отброшено моделью: ${answer.dropped.length}</summary>
              <ul class="mentor-list">${answer.dropped.map((line) => `<li>${esc(line)}</li>`).join('')}</ul></details>`
          : '';
        // Пустое предложение не выдаётся за план: показываем причину, а не молчим.
        result.innerHTML = suggested.length
          ? `<p class="mentor-note">${esc(answer.notice)}</p>
             <ol class="mentor-plan-list">${suggested.map(suggestRow).join('')}</ol>${dropped}
             <button class="plain-button" type="button" data-suggest-apply>Подставить в форму</button>`
          : `<p class="mentor-note">${esc(answer.notice)}</p>${dropped}`;
        result.querySelector('[data-suggest-apply]')?.addEventListener('click', () => {
          const body = node.querySelector('[data-rows="days"] [data-rows-body]');
          body.innerHTML = suggested.map((item) => dayRow(item, data)).join('');
          body.querySelectorAll('[data-remove]').forEach((remove) => remove.addEventListener('click',
            (removeEvent) => {removeEvent.target.closest('[data-row]').remove(); applyPlanView();}));
          resetFilters();
          state.textContent = 'Позиции подставлены. Проверьте их и нажмите «Сохранить план».';
        });
      } catch (error) {
        if (ctx.selectedProjectId !== code || !result.isConnected) return;
        button.disabled = false;
        state.textContent = error.message;
      }
    });
    // Бриф согласованной версии подгружается по требованию из неизменяемой версии.
    node.querySelectorAll('[data-brief-context]').forEach((button) => button.addEventListener('click', async () => {
      const postId = button.dataset.briefContext;
      const body = node.querySelector(`[data-brief-context-body="${postId}"]`);
      button.disabled = true;
      body.textContent = 'Загружаем бриф версии…';
      try {
        const info = await ctx.crmQuery(`${PATH}/plan/transfer/${encodeURIComponent(postId)}`, {companyCode: code});
        if (ctx.selectedProjectId !== code || !body.isConnected) return;
        const brief = info.brief;
        body.innerHTML = `<p class="mentor-note">${esc(info.notice)}</p>
          <dl class="mentor-brief-view">
            <div><dt>Цель</dt><dd>${esc(brief.goal) || '—'}</dd></div>
            <div><dt>Продукт</dt><dd>${esc(brief.product) || '—'}</dd></div>
            <div><dt>Аудитория</dt><dd>${esc(brief.audience) || '—'}</dd></div>
            <div><dt>Боли клиента</dt><dd>${brief.pains.length ? `<ul class="mentor-list">${brief.pains.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : '—'}</dd></div>
            <div><dt>Подтверждённые факты</dt><dd>${brief.confirmedFacts.length ? `<ul class="mentor-list">${brief.confirmedFacts.map((item) => `<li>${esc(item.statement)}<br><span class="mentor-note">Источник: ${esc(item.source)}</span></li>`).join('')}</ul>` : '—'}</dd></div>
            <div><dt>Комфорт съёмки</dt><dd>${esc(brief.shootingComfort.level)}${brief.shootingComfort.notes ? `<br><span class="mentor-note">${esc(brief.shootingComfort.notes)}</span>` : ''}</dd></div>
          </dl>`;
      } catch (error) {
        if (ctx.selectedProjectId !== code || !body.isConnected) return;
        button.disabled = false;
        body.textContent = error.message;
      }
    }));
    /* Контекст черновика версии. Прежний адрес /plan/transfer/{postId} знает только расписку
       по дням и для карточки версии ответил бы «не найдено», поэтому кнопка сюда не ведёт.
       Читаются уже существующие адреса неизменяемых версий плана и брифа, записанные в самой
       расписке: показывается СОХРАНЁННЫЙ исторический контекст, а не текущая правка формы.
       Идея ищется по ideaId; исходник — свой у версии, иначе унаследованный от идеи. */
    node.querySelectorAll('[data-variant-context]').forEach((button) => button.addEventListener('click', async () => {
      const postId = button.dataset.variantContext;
      const body = node.querySelector(`[data-variant-context-body="${postId}"]`);
      const ideaId = button.dataset.variantContextIdea, platform = button.dataset.variantContextPlatform;
      button.disabled = true;
      body.textContent = 'Загружаем сохранённую версию плана и брифа…';
      try {
        const [planVersion, briefVersion] = await Promise.all([
          ctx.crmQuery(`${PATH}/plan/versions/${encodeURIComponent(button.dataset.variantContextPlan)}`, {companyCode: code}),
          ctx.crmQuery(`${PATH}/brief/versions/${encodeURIComponent(button.dataset.variantContextBrief)}`, {companyCode: code}),
        ]);
        if (ctx.selectedProjectId !== code || !body.isConnected) return;
        const idea = (planVersion.days || []).find((row) => row.ideaId === ideaId) || null;
        const variant = idea && idea.variants ? idea.variants[platform] : null;
        const brief = briefVersion.fields || {};
        const assetId = (variant && variant.assetId) || (idea && idea.assetId) || '';
        const asset = assetId ? (brief.assets || []).find((row) => row.id === assetId) || null : null;
        if (!idea) {
          // У плана старого образца идей по идентификатору может не быть: врать об этом нельзя.
          body.innerHTML = '<p class="mentor-note">В сохранённой версии плана эта идея по идентификатору не найдена: ' +
            'план той версии составлялся без идентификаторов идей. Откройте версию плана целиком в истории.</p>';
          return;
        }
        body.innerHTML = `<p class="mentor-note">Это сохранённая версия плана v${esc(button.dataset.variantContextPlan)}
            и брифа v${esc(button.dataset.variantContextBrief)}, по которым карточка создана. Текущие правки формы сюда не попадают.</p>
          <dl class="mentor-brief-view">
            <div><dt>Тема</dt><dd>${esc(idea.topic) || '—'}</dd></div>
            <div><dt>Текст версии</dt><dd>${variant && variant.text ? esc(variant.text) : '—'}</dd></div>
            <div><dt>Формат</dt><dd>${esc((variant && variant.format) || idea.format || '—')}</dd></div>
            <div><dt>Задача материала</dt><dd>${esc(idea.role) || '—'}</dd></div>
            <div><dt>Зацепка</dt><dd>${esc((variant && variant.hook) || idea.hook || '—')}</dd></div>
            <div><dt>Заметка наставника</dt><dd>${esc((variant && variant.mentorNote) || idea.mentorNote || '—')}</dd></div>
            <div><dt>Исходник</dt><dd>${asset ? `${esc(asset.title)} · ${esc(asset.kind)}${asset.note ? `<br>${esc(asset.note)}` : ''}
              <br><span class="mentor-note">Это описание словами, а не загруженный файл.</span>` : 'в плане не указан'}</dd></div>
            <div><dt>Цель компании</dt><dd>${esc(brief.goal) || '—'}</dd></div>
            <div><dt>Аудитория</dt><dd>${esc(brief.audience) || '—'}</dd></div>
          </dl>`;
      } catch (error) {
        if (ctx.selectedProjectId !== code || !body.isConnected) return;
        button.disabled = false;
        body.textContent = error.message;
      }
    }));
    node.querySelector('#mentor-transfer-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      void submit(form, '#mentor-transfer-state', `${PATH}/plan/transfer`, 'POST',
        {planRevision: Number(form.elements.planRevision.value),
          briefRevision: Number(form.elements.briefRevision.value)});
    });
    const decision = node.querySelector('#mentor-decision-form');
    if (decision) {
      decision.addEventListener('submit', (event) => {
        event.preventDefault();
        const form = event.currentTarget, choice = event.submitter?.value || 'approved';
        const comment = form.elements.comment.value.trim();
        if (choice === 'rejected' && !comment) {
          node.querySelector('#mentor-decision-state').textContent = 'Укажите, что исправить в плане.';
          return;
        }
        void submit(form, '#mentor-decision-state', `${PATH}/plan/decision`, 'POST',
          {planRevision: Number(form.elements.planRevision.value),
            briefRevision: Number(form.elements.briefRevision.value), decision: choice, comment});
      });
    }
  }

  async function load(container, ctx) {
    const id = ++epoch, code = ctx.selectedProjectId;
    const node = container.querySelector('#mentor-content');
    if (!node) return;
    try {
      const data = await ctx.crmQuery(PATH, {companyCode: code});
      // Ответ прежней компании не рисуется: бриф и план не смешиваются между компаниями.
      if (id !== epoch || ctx.selectedProjectId !== code || !node.isConnected) return;
      if (data.companyCode !== String(code).toLowerCase()) throw new Error('Ответ другой компании');
      node.innerHTML = markup(data, ctx);
      bind(container, node, ctx, data);
    } catch (error) {
      if (id === epoch && node.isConnected) {
        node.innerHTML = `<p class="crm-error" role="alert">Не удалось загрузить бриф и план: ${esc(error.message)}</p>`;
      }
    }
  }

  function render(container, ctx) {
    if (!canRead(ctx)) {
      container.innerHTML = '<div class="content-header"><h1>Бриф и план</h1></div>' +
        '<div class="card"><p>Раздел доступен по праву «Автопостинг: просмотр». Обратитесь к владельцу кабинета.</p></div>';
      return;
    }
    container.innerHTML = `<div class="content-header"><h1>Бриф и план</h1>
      <p>Расскажите о компании, выберите темы на 7–14 дней и подготовьте материалы по шагам.</p></div>
      <div id="mentor-content" aria-live="polite"><p>Загружаем бриф и план…</p></div>`;
    void load(container, ctx);
  }

  sb.mediaMentor = {render, load};
  sb.registerView('media-mentor', {title: 'Бриф и план', render, onProjectChange: render});
})();

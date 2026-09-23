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
  const STATUS = {absent: 'План ещё не составлен', pending: 'Ждёт согласования',
    approved: 'Согласовано', rejected: 'Отклонено', needs_reapproval: 'Нужно пересогласовать'};
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
        <div><dt>Исходники</dt><dd>${readOnlyList(fields.assets,
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
      <fieldset class="wide mentor-rows" data-rows="assets"><legend>Исходники</legend>
        <p class="mentor-note">Зачем: начнём с уже доступного материала и попросим снять только то, чего действительно не хватает. Материалы описываются словами: ссылок и загрузки файлов на этом этапе нет.</p>
        <div data-rows-body>${fields.assets.map((asset) => assetRow(asset, vocabulary.assetKinds)).join('')}</div>
        <button class="plain-button" type="button" data-add="assets">Добавить исходник</button></fieldset>
      <label>Общий ориентир по съёмке<small class="mentor-note">До личного опроса каждого участника это лишь ориентир: двигаемся без давления и никого не ставим в кадр без согласия.</small><select name="comfortLevel">${options(vocabulary.shootingComfort, fields.shootingComfort.level)}</select></label>
      <label class="wide">Общие ограничения съёмки<small class="mentor-note">Личные предпочтения Влада, Лены и Сергея уточняем отдельно у каждого.</small><textarea name="comfortNotes" rows="2" maxlength="2000">${esc(fields.shootingComfort.notes)}</textarea></label>
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

  function dayRow(item, data, index = -1) {
    const fields = data.brief.fields, vocabulary = data.vocabulary;
    const platforms = vocabulary.platforms.filter((platform) => fields.platforms.includes(platform.id));
    const assets = [{id: '', label: 'Без исходника'}, ...fields.assets.map((asset) => ({id: asset.id, label: asset.title}))];
    const draft = index >= 0 && data.transfer?.current?.planRevision === data.plan?.revision
      ? data.transfer.current.items.find((row) => row.dayIndex === index) : null;
    const media = draft?.mediaUrls?.length ? localMediaPreview(draft.mediaUrls[0]) : '';
    const cardStatus = {draft: 'черновик', scheduled: 'запланирован', publishing: 'отправляется',
      published: 'опубликован', failed: 'ошибка отправки', needs_review: 'нужна проверка', cancelled: 'отменён'};
    const feedback = index < 0 ? [] : (data.feedback || []).filter((entry) => entry.dayIndex === index);
    const platformLabel = platforms.find((row) => row.id === item.platform)?.label || item.platform || 'Площадка';
    const formatLabel = vocabulary.formats.find((row) => row.id === item.format)?.label || item.format || 'Формат';
    return `<div class="mentor-row mentor-day" data-row>
      <div class="mentor-day-preview" data-preview-format="${esc(item.format)}" aria-label="Макет публикации">
        <div class="mentor-day-preview-head"><strong data-preview-platform>${esc(platformLabel)}</strong>
          <span data-preview-date>${item.date ? esc(day(item.date)) : 'Дата не выбрана'}</span></div>
        <div class="mentor-day-preview-media">${media || '<span class="mentor-day-play" aria-hidden="true">▶</span><span>Здесь появится загруженный материал</span>'}</div>
        <div class="mentor-day-preview-caption"><small data-preview-format-label>${esc(formatLabel)}</small>
          <strong data-preview-topic>${esc(item.topic) || 'Тема публикации'}</strong>
          <span data-preview-hook>${esc(item.hook) || 'Зацепка для зрителя'}</span></div>
      </div>
      <div class="mentor-day-edit">
        <div class="mentor-day-status"><strong>Материал ${index >= 0 ? index + 1 : 'новый'}</strong>
          <span>${draft ? `Карточка №${esc(draft.postId)} · ${esc(cardStatus[draft.cardStatus] || draft.cardStatus || 'статус неизвестен')} · ${draft.hasMedia ? 'медиа загружено' : 'без медиа'}` : 'Пока только в плане'}</span></div>
        ${draft ? '<p class="mentor-note">Дата и тема здесь относятся к плану. Уже созданную карточку и время выхода изменяйте в разделе «Автопостинг».</p>' : ''}
        <label>Дата выхода<input data-field="date" type="date" required value="${esc(item.date)}"></label>
        <div class="mentor-day-selects">
          <label>Площадка<select data-field="platform">${options(platforms, item.platform)}</select></label>
          <label>Формат<select data-field="format">${options(vocabulary.formats, item.format)}</select></label>
          <label>Задача материала<select data-field="role">${options(vocabulary.roles, item.role)}</select></label>
        </div>
        <label>Тема<input data-field="topic" maxlength="300" required value="${esc(item.topic)}"></label>
        <details class="mentor-day-more"><summary>Зацепка, исходник и задание</summary>
          <label>Зацепка<input data-field="hook" maxlength="500" value="${esc(item.hook)}"></label>
          <label>Исходник<select data-field="assetId">${options(assets, item.assetId)}</select></label>
          <label>Заметка наставника<textarea data-field="mentorNote" rows="2" maxlength="2000">${esc(item.mentorNote)}</textarea></label>
        </details>
        ${index >= 0 ? `<div class="mentor-day-feedback">
          <strong>Предложения по этому материалу</strong>
          ${feedback.length ? `<ul class="mentor-list">${feedback.map((entry) => `<li>${esc(entry.message)}
            <small>${esc(entry.actorName || 'Участник')} · ${esc(moment(entry.createdAt))}</small></li>`).join('')}</ul>`
    : '<p class="mentor-note">Предложений пока нет.</p>'}
          <label>Что стоит изменить?<textarea data-feedback-input="${index}" rows="2" maxlength="1000" placeholder="Например: может, эта тема лучше подойдёт для продающего рилса?"></textarea></label>
          <button class="plain-button" type="button" data-feedback-send="${index}">Предложить правку</button>
          <span data-feedback-state="${index}" role="status"></span>
        </div>` : '<p class="mentor-note">Сначала сохраните материал, затем можно оставить предложение по нему.</p>'}
        <button class="plain-button" type="button" data-remove>Убрать материал</button>
      </div></div>`;
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
    const line = (item) => `<li data-rules-level="${esc(item.level)}">` +
      `<strong>${item.level === 'violation' ? 'Нарушение' : 'Стоит поправить'}:</strong> ${esc(item.text)}</li>`;
    return `<section class="mentor-rules" data-rules><h3>Проверка по курсу</h3>
      <p class="mentor-note">Замечаний: ${esc(result.issues.length)}. Правила механические —
      расписание и состав плана. Оценку идеи и темы они не заменяют.</p>
      <ul class="mentor-list" data-rules-list>${result.issues.map(line).join('')}</ul>${reminders}</section>`;
  }

  function planMarkup(data, edit) {
    const plan = data.plan, vocabulary = data.vocabulary;
    const label = (list, id) => esc(list.find((item) => item.id === id)?.label || id);
    const version = plan ? `<p class="mentor-note">Версия ${esc(plan.revision)} по брифу ${esc(plan.briefRevision)} ·
        ${esc(day(plan.startDate))} — ${esc(day(plan.endDate))} · ${esc(plan.windowDays)} дней · обновлён ${esc(moment(plan.updatedAt))}</p>` : '';
    const view = plan ? `${version}
      <ol class="mentor-plan-list">${plan.days.map((item) => `<li><strong>${esc(day(item.date))}</strong> ·
        ${label(vocabulary.platforms, item.platform)} · ${label(vocabulary.formats, item.format)} ·
        ${label(vocabulary.roles, item.role)}<br>${esc(item.topic)}${item.hook ? `<br><span class="mentor-note">${esc(item.hook)}</span>` : ''}${item.mentorNote ? `<br><span class="mentor-note">${esc(item.mentorNote)}</span>` : ''}</li>`).join('')}</ol>`
      : '<p class="mentor-note">План ещё не составлен.</p>';
    const stale = plan && plan.briefRevision !== data.brief.revision
      ? `<p class="mentor-warning" role="note">Бриф сохранён как версия ${esc(data.brief.revision)}. Этот план остался по версии ${esc(plan.briefRevision)} и сам не перестроился. Проверьте материалы, сохраните новую версию плана и согласуйте её заново.</p>` : '';
    const checked = plan ? `${edit ? version : view}${stale}${rulesMarkup(plan)}` : view;
    if (!edit) return checked;
    if (!data.brief.revision) {
      return `${checked}<p class="mentor-note">Сначала сохраните бриф компании — план составляется по нему.</p>`;
    }
    if (!data.brief.fields.platforms.length) {
      return `${checked}<p class="mentor-note">Выберите площадки в брифе: без них план составить нельзя.</p>`;
    }
    return `${checked}
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
    </section>
<form id="mentor-plan-form" class="crm-form mentor-form">
      <input type="hidden" name="planRevision" value="${esc(plan ? plan.revision : 0)}">
      <input type="hidden" name="briefRevision" value="${esc(data.brief.revision)}">
      <p class="mentor-note">План охватывает от ${esc(vocabulary.minDays)} до ${esc(vocabulary.maxDays)} дней подряд,
        не больше трёх материалов на дату. Дни идут по возрастанию даты. Карточка показывает макет, а не готовую публикацию.</p>
      <div class="mentor-rows mentor-plan-editor wide" data-rows="days"><div class="mentor-day-cards" data-rows-body>${(plan ? plan.days : []).map((item, index) => dayRow(item, data, index)).join('')}</div>
        <button class="plain-button" type="button" data-add="days">Добавить материал</button></div>
      <div class="crm-actions wide"><button class="plain-button" type="submit">Сохранить план</button>
        <span id="mentor-plan-state" role="status"></span></div></form>`;
  }

  function approvalMarkup(data, ctx) {
    const approval = data.approval, plan = data.plan;
    const decided = approval.decidedAt
      ? `<p class="mentor-note">Последнее решение: ${esc(approval.decision === 'approved' ? 'согласовано' : 'отклонено')} ·
         версия плана ${esc(approval.planRevision)} · ${esc(approval.actorName || '—')} · ${esc(moment(approval.decidedAt))}${approval.comment ? `<br>${esc(approval.comment)}` : ''}</p>`
      : '<p class="mentor-note">Решений по этой версии ещё нет.</p>';
    // Решать можно только по плану, составленному по текущей версии брифа.
    const canAct = canDecide(ctx) && !!plan && plan.briefRevision === data.brief.revision;
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
      <ul class="mentor-drafts">${state.current.items.map((item) => `<li>
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
    return `<section class="card mentor-transfer" data-can="${state.canTransfer ? 'yes' : 'no'}">
      <h2>Перенос в черновики автопостинга</h2>
      <p class="mentor-note">${esc(state.notice)}</p>
      <p class="mentor-note">Остаются незаполненными: ${state.leavesUnfilled.map((item) => esc(item)).join(' · ')}.</p>
      <p class="mentor-note">${esc(state.repeatProtection)}: повтор по той же версии вернёт те же черновики.</p>
      ${state.current ? `<p class="mentor-note">${esc(state.materialNotice)} Без файла ждут заданий: ${esc(state.awaitingMaterial)}.</p>` : ''}
      ${state.newVersionNotice ? `<p class="mentor-warning" role="note">${esc(state.newVersionNotice)}</p>` : ''}
      ${done}
      ${edit && state.canTransfer ? `<form id="mentor-transfer-form" class="crm-form">
        <input type="hidden" name="planRevision" value="${esc(state.planRevision)}">
        <input type="hidden" name="briefRevision" value="${esc(state.briefRevision)}">
        <div class="crm-actions wide"><button class="plain-button" type="submit">Перенести план в черновики</button>
          <span id="mentor-transfer-state" role="status"></span></div></form>`
    : `<p class="mentor-note">${esc(edit ? state.blockedReason : 'Переносит план тот, у кого есть право правки автопостинга.')}</p>`}
      ${state.history.length ? `<details><summary>Прошлые переносы (${esc(state.history.length)})</summary>
        <ol class="mentor-history">${state.history.map((item) => `<li>Версия плана ${esc(item.planRevision)} ·
          ${esc(item.dayCount)} дней · ${esc(moment(item.transferredAt))} · ${esc(item.actorName || '—')}</li>`).join('')}</ol></details>` : ''}
    </section>`;
  }

  /* Заявка на материалы считается на месте из уже загруженных плана и брифа:
     ни запроса к серверу, ни обращения к модели здесь нет. */
  function materialsMarkup(data) {
    const builder = sb.mediaMentorMaterials;
    if (!builder || !data.plan) return '';
    const request = builder.build(data.plan, data.brief.fields);
    if (!request.items.length && !request.skipped.length) return '';
    const label = (list, id) => esc(list.find((item) => item.id === id)?.label || id);
    const rows = request.items.map((item, index) => `<li>
      <strong>${esc(day(item.date))}</strong> · ${esc(item.platformLabel)} ·
      ${esc(item.formatLabel)} · ${item.kind === 'video' ? 'видео' : 'картинка'} ${esc(item.ratio)},
      не ниже ${esc(item.master)}<br>${esc(item.topic)}
      ${item.safeZone ? `<br><span class="mentor-note">${esc(item.safeZone)}</span>` : ''}
      <details><summary>Промт и как сделать</summary>
        <textarea class="mentor-prompt" rows="5" readonly data-prompt="${index}">${esc(item.prompt)}</textarea>
        <button class="plain-button" type="button" data-prompt-copy="${index}">Скопировать промт</button>
        <span data-prompt-state="${index}" role="status"></span>
        <ul class="mentor-list">${item.howTo.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>
        <p class="mentor-note">${esc(item.upscaleNote)}</p>
        <p class="mentor-note">Имя файла по стандарту: ${esc(item.fileName)}</p>
      </details></li>`).join('');
    return `<section class="card mentor-materials"><h2>Заявка на материалы</h2>
      <p class="mentor-note">${esc(request.notice)}</p>
      ${request.batchNote ? `<p class="crm-warning" role="note">${esc(request.batchNote)}</p>` : ''}
      ${request.warnings.length ? `<ul class="mentor-list crm-warning" role="note">${request.warnings.map((line) =>
    `<li>${esc(line)}</li>`).join('')}</ul>` : ''}
      ${rows ? `<ol class="mentor-plan-list">${rows}</ol>` : ''}
      ${request.skipped.length ? `<details class="mentor-note"><summary>Пропущено: ${request.skipped.length}</summary>
        <ul class="mentor-list">${request.skipped.map((line) => `<li>${esc(line)}</li>`).join('')}</ul></details>` : ''}</section>`;
  }

  function markup(data, ctx) {
    const edit = canEdit(ctx);
    return `<p class="card mentor-notice" role="note">${esc(data.notice)}</p>
      ${journeyMarkup(data)}
      ${propertyExampleMarkup(ctx)}
      <section class="card mentor-brief"><h2>Бриф компании</h2>
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
            ${esc(item.actorName || '—')}${item.reason ? `<br>${esc(item.reason)}` : ''}</li>`).join('')}</ol></details>` : ''}</section>
      <section class="card mentor-plan"><h2>Контент-план</h2>
        ${planMarkup(data, edit)}
        ${data.plan && data.plan.history.length ? `<details><summary>История плана (${esc(data.plan.history.length)})</summary>
          <ol class="mentor-history">${data.plan.history.map((item) => `<li>Версия ${esc(item.revision)} по брифу ${esc(item.briefRevision)} ·
            ${esc(moment(item.createdAt))} · ${esc(item.actorName || '—')}</li>`).join('')}</ol></details>` : ''}</section>
      ${edit ? materialsMarkup(data) : ''}
      ${edit ? `<section class="card mentor-review"><h2>Разбор результатов</h2>
        <section class="mentor-suggest" data-review>
          <p class="mentor-note">Модель посмотрит собранные цифры и предложит, что изменить в плане.
            Площадки, по которым статистика не собирается, в разбор не попадают: отсутствие данных —
            это не плохой результат. Ничего не меняется автоматически.</p>
          <label>С<input data-review-from type="date" value="${esc(isoDay(-29))}"></label>
          <label>По<input data-review-to type="date" value="${esc(isoDay(0))}"></label>
          <button class="plain-button" type="button" data-review-run>Разобрать результаты</button>
          <span data-review-state role="status"></span>
          <div data-review-result></div></section></section>` : ''}
      ${approvalMarkup(data, ctx)}${transferMarkup(data, ctx)}`;
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
  const collectDays = (form) => [...form.querySelectorAll('[data-rows="days"] [data-row]')].map(rowValues)
    .map((row) => ({date: row.date, platform: row.platform, format: row.format, role: row.role,
      topic: row.topic, hook: row.hook, assetId: row.assetId, mentorNote: row.mentorNote}));

  function bind(container, node, ctx, data) {
    const code = ctx.selectedProjectId;
    const busy = (form, state) => form.querySelectorAll('button,input,select,textarea')
      .forEach((element) => { element.disabled = state; });
    const syncDayPreview = (row) => {
      if (!row?.classList.contains('mentor-day')) return;
      const field = (name) => row.querySelector(`[data-field="${name}"]`);
      const preview = row.querySelector('.mentor-day-preview');
      preview.dataset.previewFormat = field('format').value;
      row.querySelector('[data-preview-platform]').textContent = field('platform').selectedOptions[0]?.textContent || 'Площадка';
      row.querySelector('[data-preview-format-label]').textContent = field('format').selectedOptions[0]?.textContent || 'Формат';
      row.querySelector('[data-preview-date]').textContent = field('date').value ? day(field('date').value) : 'Дата не выбрана';
      row.querySelector('[data-preview-topic]').textContent = field('topic').value.trim() || 'Тема публикации';
      row.querySelector('[data-preview-hook]').textContent = field('hook').value.trim() || 'Зацепка для зрителя';
    };
    const dayRows = node.querySelector('[data-rows="days"]');
    for (const type of ['input', 'change']) dayRows?.addEventListener(type, (event) => {
      if (event.target.matches('[data-field]')) syncDayPreview(event.target.closest('[data-row]'));
    });
    node.querySelectorAll('[data-journey-target]').forEach((button) => button.addEventListener('click', () => {
      const target = node.ownerDocument.getElementById(button.dataset.journeyTarget);
      if (target?.tagName === 'DETAILS') target.open = true;
      target?.scrollIntoView?.({block: 'start'});
    }));
    node.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => {
      const kind = button.dataset.add, body = button.closest('[data-rows]').querySelector('[data-rows-body]');
      const markupFor = kind === 'facts' ? factRow()
        : kind === 'assets' ? assetRow(undefined, data.vocabulary.assetKinds)
          : dayRow({date: '', platform: data.brief.fields.platforms[0] || '', format: 'post', role: 'reach',
            topic: '', hook: '', assetId: '', mentorNote: ''}, data);
      body.insertAdjacentHTML('beforeend', markupFor);
      body.lastElementChild.querySelector('[data-remove]')
        .addEventListener('click', (event) => event.target.closest('[data-row]').remove());
      syncDayPreview(body.lastElementChild);
    }));
    node.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click',
      (event) => event.target.closest('[data-row]').remove()));
    node.querySelectorAll('[data-feedback-send]').forEach((button) => button.addEventListener('click', async () => {
      const index = Number(button.dataset.feedbackSend), state = node.querySelector(`[data-feedback-state="${index}"]`);
      const input = node.querySelector(`[data-feedback-input="${index}"]`), message = input?.value.trim() || '';
      if (!message) { state.textContent = 'Напишите предложение.'; return; }
      button.disabled = true;
      state.textContent = 'Сохраняем предложение…';
      try {
        await ctx.crmQuery(`${PATH}/plan/feedback`, {companyCode: code},
          ctx.csrfOptions('POST', {planRevision: data.plan.revision, dayIndex: index, message}));
        if (ctx.selectedProjectId === code) await load(container, ctx);
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
            (removeEvent) => removeEvent.target.closest('[data-row]').remove()));
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
      <p>Бриф компании и контент-план на 7–14 дней. Бриф заполняет человек; план можно составить
        самому или взять подсказку модели и проверить её. Согласование версии плана — решение
        по тексту, а не разрешение публиковать.</p></div>
      <div id="mentor-content" aria-live="polite"><p>Загружаем бриф и план…</p></div>`;
    void load(container, ctx);
  }

  sb.mediaMentor = {render, load};
  sb.registerView('media-mentor', {title: 'Бриф и план', render, onProjectChange: render});
})();

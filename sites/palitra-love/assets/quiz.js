/* Квиз повода. Итог ведёт в форму заявки сайта: ответы и выбранная позиция сохраняются как
   черновик (без контактов), форма главной подхватывает их (order.js). Личный чат менеджера сайт
   не подставляет: доставку заявки подтверждает сервер, а не переход по ссылке.
   Цена позиции берётся только из live-прайса по устойчивому `priceId` в конфигурации квиза;
   статические числа в конфигурации — пример и не показываются. Без совпадения — «Цена уточняется». */
(() => {
  const CHANNEL_URL = 'https://t.me/palitralovee';
  const DRAFT_KEY = 'palitra-request-draft-v1';
  const REQUEST_URL = '/#zayavka';
  const PRICE_UNKNOWN = 'Цена уточняется';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const channelLink = () => `<a class="button outline quiz-direct" href="${CHANNEL_URL}" target="_blank" rel="noopener">Канал в Telegram</a>`;
  const saveDraft = draft => {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); return sessionStorage.getItem(DRAFT_KEY) !== null; } catch (_) { return false; }
  };
  /* Live-цены по priceId: карта id → строка цены прайса (пустая строка = цена неизвестна). */
  const livePrices = new Map();
  let liveReady = false;
  const loadLivePrices = () => {
    const api = window.PalitraPrice;
    if (!api || !api.load) return Promise.resolve();
    return api.load(['/api/price', '/data/price.json']).then(data => {
      for (const category of (data && data.categories) || []) {
        for (const item of category.items || []) if (item && typeof item.id === 'string') livePrices.set(item.id, String(item.price ?? '').trim());
      }
      liveReady = true;
    }).catch(() => {});
  };
  const priceOf = product => {
    const id = typeof product.priceId === 'string' ? product.priceId : '';
    const live = id && liveReady ? livePrices.get(id) : undefined;
    return live ? { known: true, text: live } : { known: false, text: PRICE_UNKNOWN };
  };

  document.querySelectorAll('[data-occasion-quiz]').forEach(root => {
    const config = JSON.parse(root.querySelector('script[type="application/json"]').textContent);
    const answers = [];
    let step = 0;
    let resultShown = false;

    const dots = () => `<div class="quiz-dots" aria-label="Прогресс: вопрос ${step + 1} из 3">${config.questions.map((_, index) => `<span class="${index === step ? 'is-active' : ''}"></span>`).join('')}</div>`;
    const renderQuestion = () => {
      resultShown = false;
      const question = config.questions[step];
      root.innerHTML = `<div class="quiz-panel"><p class="eyebrow">Вопрос ${step + 1} из 3</p><h2>${esc(question.title)}</h2><div class="quiz-options">${question.options.map(option => `<button type="button" data-answer="${esc(option)}">${esc(option)}</button>`).join('')}</div>${dots()}<div class="quiz-nav">${step ? '<button type="button" class="button outline" data-quiz-back>Назад</button>' : ''}<a class="button outline" href="${REQUEST_URL}">Оставить заявку</a>${channelLink()}</div></div>`;
    };
    const draftLines = product => {
      const price = priceOf(product);
      return [
        ...config.questions.map((question, index) => `${question.title}: ${answers[index] ?? '—'}`),
        `Выбранная позиция: ${product.name} — ${price.known ? price.text : 'цена уточняется'}`
      ];
    };
    const draftFor = product => ({ occasion: config.occasion, source: config.source, lines: draftLines(product) });
    const renderResult = () => {
      resultShown = true;
      const productCards = config.products.map((product, index) => {
        const price = priceOf(product);
        return `<article class="quiz-product"><img src="/assets/img/${esc(product.image)}" alt="${esc(product.name)}" width="800" height="1000" loading="lazy"><div><h3>${esc(product.name)}</h3><div class="product-purchase"><p class="price" data-price-known="${price.known ? 'true' : 'false'}">${esc(price.text)}</p><a class="button" data-order-product="${index}" href="${REQUEST_URL}">Оставить заявку</a></div><p class="note">${price.known ? 'Цена из прайса на момент показа; менеджер подтвердит состав и стоимость по заявке.' : 'Стоимость подтвердит менеджер по заявке.'}</p><div class="quiz-actions">${channelLink()}</div></div></article>`;
      }).join('');
      root.innerHTML = `<div class="quiz-panel"><h2>Вот что подойдёт</h2><p>Нажмите «Оставить заявку»: ответы и выбранный вариант подставятся в комментарий формы. В форме нужно указать имя, телефон, дату и согласие на обработку данных.</p><div class="quiz-results">${productCards}</div><div class="quiz-fallback" data-quiz-fallback hidden role="status"></div><button type="button" class="button outline" data-quiz-restart>Пройти ещё раз</button></div>`;
    };
    /* Хранилище недоступно: ответы не теряются — показываем их текстом для копирования в комментарий. */
    const showFallback = draft => {
      const box = root.querySelector('[data-quiz-fallback]');
      if (!box) return;
      const text = [`Повод: ${draft.occasion}`, ...draft.lines].join('\n');
      box.hidden = false;
      box.innerHTML = `<p>Не удалось передать ответы в форму автоматически. Скопируйте текст ниже в комментарий заявки:</p><textarea readonly rows="6">${esc(text)}</textarea><a class="button" href="${REQUEST_URL}">Перейти к форме заявки</a>`;
      box.querySelector('textarea').focus();
    };
    root.addEventListener('click', event => {
      const answer = event.target.closest('[data-answer]');
      if (answer) { answers[step] = answer.dataset.answer; step += 1; step === 3 ? renderResult() : renderQuestion(); }
      if (event.target.closest('[data-quiz-back]')) { step -= 1; renderQuestion(); }
      if (event.target.closest('[data-quiz-restart]')) { answers.length = 0; step = 0; renderQuestion(); }
      const order = event.target.closest('[data-order-product]');
      if (!order) return;
      // Черновик сохраняется до перехода; при отказе хранилища переход не выполняется молча.
      const draft = draftFor(config.products[Number(order.dataset.orderProduct)]);
      if (!saveDraft(draft)) { event.preventDefault(); showFallback(draft); }
    });
    renderQuestion();
    loadLivePrices().then(() => { if (resultShown) renderResult(); });
  });
})();

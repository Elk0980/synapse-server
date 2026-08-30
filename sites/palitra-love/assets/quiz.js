(() => {
  const formatPrice = price => new Intl.NumberFormat('ru-RU').format(price) + ' руб.';
  const telegramUrl = text => `https://t.me/palitra_love?text=${encodeURIComponent(text)}`;

  document.querySelectorAll('[data-occasion-quiz]').forEach(root => {
    const config = JSON.parse(root.querySelector('script[type="application/json"]').textContent);
    const answers = [];
    let step = 0;

    const dots = () => `<div class="quiz-dots" aria-label="Прогресс: вопрос ${step + 1} из 3">${config.questions.map((_, index) => `<span class="${index === step ? 'is-active' : ''}"></span>`).join('')}</div>`;
    const directButton = '<a class="button outline quiz-direct" href="https://t.me/palitra_love" target="_blank" rel="noopener">Написать в Telegram</a>';
    const renderQuestion = () => {
      const question = config.questions[step];
      root.innerHTML = `<div class="quiz-panel"><p class="eyebrow">Вопрос ${step + 1} из 3</p><h2>${question.title}</h2><div class="quiz-options">${question.options.map(option => `<button type="button" data-answer="${option}">${option}</button>`).join('')}</div>${dots()}<div class="quiz-nav">${step ? '<button type="button" class="button outline" data-quiz-back>Назад</button>' : ''}${directButton}</div></div>`;
    };
    const renderResult = () => {
      const productCards = config.products.map((product, index) => `<article class="quiz-product"><img src="/assets/img/${product.image}" alt="${product.name}" width="800" height="1000" loading="lazy"><div><h3>${product.name}</h3><p class="price">${formatPrice(product.price)}</p><div class="quiz-actions"><a class="button" data-order-product="${index}" href="#">Оформить заказ</a>${directButton}</div></div></article>`).join('');
      root.innerHTML = `<div class="quiz-panel"><h2>Вот что подойдёт</h2><div class="quiz-results">${productCards}</div><button type="button" class="button outline" data-quiz-restart>Пройти ещё раз</button></div>`;
      root.querySelectorAll('[data-order-product]').forEach(link => {
        const product = config.products[Number(link.dataset.orderProduct)];
        const text = [`Повод: ${config.occasion}`, ...config.questions.map((question, index) => `${question.title}: ${answers[index]}`), `Выбранная позиция: ${product.name} — ${formatPrice(product.price)}`, `Источник: ${config.source}`].join('\n');
        link.href = telegramUrl(text);
        link.target = '_blank';
        link.rel = 'noopener';
      });
    };
    root.addEventListener('click', event => {
      const answer = event.target.closest('[data-answer]');
      if (answer) { answers[step] = answer.dataset.answer; step += 1; step === 3 ? renderResult() : renderQuestion(); }
      if (event.target.closest('[data-quiz-back]')) { step -= 1; renderQuestion(); }
      if (event.target.closest('[data-quiz-restart]')) { answers.length = 0; step = 0; renderQuestion(); }
    });
    renderQuestion();
  });
})();

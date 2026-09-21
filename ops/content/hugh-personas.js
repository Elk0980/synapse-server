'use strict';

/* Две персоны одного ассистента: Хью — правки на сайтах, Лео — Медиа-наставник.

   Это НЕ два разных ИИ. Провайдер один, различаются инструкция и контекст, который
   кладётся в запрос. Поэтому при исчерпании бюджета или паузе провайдера замолкают оба
   сразу — обещать клиенту независимых агентов нельзя.

   Зачем разделение: модель понимает ровно то, что ей передали. Раньше в запрос уходили
   только переписка, этапы и задачи, поэтому ответ получался «обо всём проекте».
   Теперь по имени однозначно определяется, что положить: правки сайта или бриф с планом.

   Имя выбрано сигналом намеренно: угадывание темы по словам рано или поздно ошибается
   и подтягивает не тот контекст, а имя ошибиться не может. */

const PERSONAS = Object.freeze({
  hugh: Object.freeze({
    key: 'hugh', name: 'Хью', scope: 'site',
    title: 'Хью — правки и работы на сайтах',
    duty: 'замечания клиента по сайту, их статусы, публикации и проверки страниц',
    // \p{L} и \p{N}: имя не должно срабатывать внутри другого слова.
    pattern: /(?:^|[^\p{L}\p{N}_])(?:Хью|Hugh)(?:$|[^\p{L}\p{N}_])/iu,
    // Что этой персоне кладут в запрос. Лишнее не кладётся: оно стоит денег и размывает ответ.
    context: Object.freeze(['messages', 'stages', 'tasks', 'siteNotes', 'sitePublications']),
  }),
  leo: Object.freeze({
    key: 'leo', name: 'Лео', scope: 'media',
    title: 'Лео — Медиа-наставник',
    duty: 'бриф компании, контент-план, материалы для съёмки и статистика площадок',
    pattern: /(?:^|[^\p{L}\p{N}_])(?:Лео|Leo)(?:$|[^\p{L}\p{N}_])/iu,
    context: Object.freeze(['messages', 'stages', 'tasks', 'brief', 'contentPlan', 'materials', 'socialStats']),
  }),
});
const ORDER = Object.freeze(['hugh', 'leo']);
const DEFAULT_PERSONA = 'hugh';

/* Кого позвали. Названы оба — отвечает тот, чьё имя стоит раньше: спрашивающий
   почти всегда обращается к первому, а второго лишь упоминает. */
function detect(text) {
  const raw = String(text ?? '');
  let chosen = null, at = Infinity;
  for (const key of ORDER) {
    const match = PERSONAS[key].pattern.exec(raw);
    if (match && match.index < at) { chosen = key; at = match.index; }
  }
  return chosen;
}

const addressedPersona = (text, {addressed = false, delegate = false} = {}) => {
  const named = detect(text);
  if (named) return named;
  // Ответ боту, @упоминание или режим «Заменять Влада» именем не пользуются —
  // отвечает персона по умолчанию, а не «никто».
  return addressed || delegate ? DEFAULT_PERSONA : null;
};

/* Ответ не по своей теме — та самая каша, от которой уходим. Персона не молчит
   и не отвечает за другого: она называет, кого звать. */
function handoff(fromKey) {
  const from = PERSONAS[fromKey], to = PERSONAS[fromKey === 'hugh' ? 'leo' : 'hugh'];
  return `Это не ко мне: я веду ${from.duty}. ${to.duty[0].toUpperCase()}${to.duty.slice(1)} — ` +
    `у ${to.name}. Напишите «${to.name}, ...» в этом же чате.`;
}

/* Инструкция персоне. Границы заданы явно: без них модель охотно отвечает за соседа
   и снова смешивает контексты. */
function instruction(key) {
  const persona = PERSONAS[key];
  const other = PERSONAS[key === 'hugh' ? 'leo' : 'hugh'];
  return [
    `Тебя зовут ${persona.name}. Всегда представляйся как «${persona.name}, бизнес-ассистент Синапс Бизнес».`,
    `Ты ведёшь: ${persona.duty}.`,
    `Соседнюю тему — ${other.duty} — ведёт ${other.name}.`,
    `Если вопрос по теме ${other.name}, не отвечай по существу: скажи, что это к ${other.name},` +
      ` и предложи написать «${other.name}, ...» в этом же чате.`,
    'Отвечай только по тем сведениям, которые переданы в контексте. Чего в них нет — того не знаешь;',
    'так и говори, а не додумывай. Цифры и статусы не выдумывай.',
    `Подписывайся именем ${persona.name}.`,
  ].join(' ');
}

const contextKeys = (key) => [...(PERSONAS[key] || PERSONAS[DEFAULT_PERSONA]).context];

/* Подсказка людям. Человек, не знающий имён, не получит ответа ни от кого —
   на этом легко потерять час, поэтому имена должны быть на виду в самом чате. */
const HINT = `Позовите по имени: «${PERSONAS.hugh.name}, ...» — ${PERSONAS.hugh.duty}; ` +
  `«${PERSONAS.leo.name}, ...» — ${PERSONAS.leo.duty}.`;
const BANNER = Object.freeze({
  id: 'personas-v1',
  title: 'В чате два помощника',
  lines: Object.freeze([
    `${PERSONAS.hugh.name} — ${PERSONAS.hugh.duty}.`,
    `${PERSONAS.leo.name} — ${PERSONAS.leo.duty}.`,
    'Ассистент отвечает только когда его зовут по имени: начните сообщение с имени.',
    'Это один сервис с двумя ролями, а не два независимых помощника: ' +
      'при сбое подключения молчат оба.',
  ]),
});

module.exports = {PERSONAS, ORDER, DEFAULT_PERSONA, detect, addressedPersona,
  handoff, instruction, contextKeys, PERSONAS_HINT: HINT, PERSONAS_BANNER: BANNER};

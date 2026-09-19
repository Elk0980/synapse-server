'use strict';

/* Расходы на ИИ внутри СУЩЕСТВУЮЩИХ Финансов: это дополнительный блок операции
   в `finance_entries`, а не второй журнал. Права и идемпотентность остаются прежними.

   Правила, ради которых блок и нужен:
   - Подписка и потребление API — разные режимы. Пополнение баланса (движение денег)
     и потребление (расход) разделены, чтобы не считать одни и те же деньги дважды.
   - Фактическая модель указывается явно. Название клиента (Codex, CLI, кабинет) моделью
     не является и модель из него не выводится.
   - Неизвестная стоимость не равна нулю: она помечается и не может быть проведена
     как фактический расход.
   - Валюта источника сохраняется. Пересчёт возможен только с явным курсом, его датой
     и источником — курс не выдумывается.
   - Onlypult и подобное учитывается как оплата клиента, а не наш подтверждённый расход.
   - Секреты сюда не попадают: метка аккаунта проверяется на похожее на ключ значение. */

const MODES = ['subscription', 'api'];
const MOVEMENTS = ['topup', 'consumption'];
const PAYERS = ['us', 'client'];
const BASES = ['invoice', 'estimate'];
const USAGE_KEYS = ['input', 'output', 'cache', 'reasoning'];
const FIELDS = ['service', 'accountLabel', 'client', 'modelId', 'mode', 'movement', 'paidBy',
  'periodFrom', 'periodTo', 'sourceCurrency', 'sourceAmount', 'rate', 'costKnown', 'costBasis',
  'usage', 'tariff', 'confirmation'];
const SECRET_RE = /(?:token|secret|password|bearer|api[_-]?key|sk-|op_)/i;
const CURRENCY_RE = /^[A-Z]{3}$/;
const ID_RE = /^[a-z0-9][a-z0-9_.-]{0,79}$/i;

function createFinanceAi({fail}) {
  const bad = (message) => fail(400, message, {code: 'VALIDATION_ERROR'});
  const text = (value, max, {required = false, name = 'поле'} = {}) => {
    if (typeof value !== 'string' || value.length > max) bad(`Проверьте ${name}`);
    const clean = value.trim();
    if (required && !clean) bad(`Укажите ${name}`);
    return clean;
  };
  const safeText = (value, max, name) => {
    const clean = text(value, max, {name});
    if (SECRET_RE.test(clean)) bad(`В поле «${name}» не должно быть ключей и паролей`);
    return clean;
  };
  const code = (value, name) => {
    if (typeof value !== 'string' || !ID_RE.test(value)) bad(`Проверьте ${name}`);
    return value.toLowerCase();
  };
  const day = (value, name) => {
    const clean = text(value, 10, {required: true, name});
    const parsed = new Date(`${clean}T00:00:00Z`);
    if (!/^\d{4}-\d\d-\d\d$/.test(clean) || !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== clean) bad(`Некорректная дата: ${name}`);
    return clean;
  };
  const positive = (value, name) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1e9) bad(`Проверьте ${name}`);
    return Math.round(value * 1e6) / 1e6;
  };
  const whole = (value, name) => {
    if (!Number.isSafeInteger(value) || value < 0 || value > 1e12) bad(`Проверьте ${name}`);
    return value;
  };
  const only = (value, allowed, name) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))) bad(`Неизвестные поля: ${name}`);
    return value;
  };

  /* Разбор блока ИИ. `entry` — уже проверенная базовая операция Финансов:
     из неё нужны состояние и тип, чтобы не провести неизвестную стоимость как факт. */
  function normalize(value, entry) {
    if (value === undefined || value === null) return null;
    only(value, FIELDS, 'расход на ИИ');
    const out = {};
    out.service = code(value.service, 'сервис или провайдера');
    out.accountLabel = safeText(value.accountLabel ?? '', 200, 'метка аккаунта');
    if (!out.accountLabel) bad('Укажите безопасную метку аккаунта');
    // Клиент и модель — разные поля. Название клиента моделью не считается.
    out.client = value.client === undefined || value.client === null || value.client === ''
      ? null : code(value.client, 'клиент или интерфейс');
    out.modelId = value.modelId === undefined || value.modelId === null || value.modelId === ''
      ? null : safeText(value.modelId, 200, 'идентификатор модели');
    if (!MODES.includes(value.mode)) bad('Режим: subscription или api');
    out.mode = value.mode;
    out.paidBy = value.paidBy === undefined ? 'us' : value.paidBy;
    if (!PAYERS.includes(out.paidBy)) bad('Плательщик: us или client');

    if (out.mode === 'api') {
      if (!MOVEMENTS.includes(value.movement)) bad('Для API укажите движение: topup или consumption');
      out.movement = value.movement;
      out.periodFrom = null;
      out.periodTo = null;
    } else {
      // Подписка описывается периодом и не записывается заново за каждый запрос.
      out.movement = null;
      out.periodFrom = day(value.periodFrom, 'начало периода подписки');
      out.periodTo = day(value.periodTo, 'окончание периода подписки');
      if (out.periodTo < out.periodFrom) bad('Окончание периода подписки раньше начала');
    }

    if (typeof value.costKnown !== 'boolean') bad('Укажите, известна ли фактическая стоимость');
    out.costKnown = value.costKnown;
    // Неизвестная стоимость не равна нулю и не проводится как фактический расход.
    if (!out.costKnown && entry.state === 'actual') {
      bad('Неизвестную стоимость нельзя провести как фактическую: снимите отметку «фактически» или укажите стоимость');
    }
    if (out.costKnown) {
      if (!BASES.includes(value.costBasis)) bad('Основание стоимости: invoice или estimate');
      out.costBasis = value.costBasis;
    } else {
      if (value.costBasis !== undefined && value.costBasis !== null && value.costBasis !== 'estimate') {
        bad('При неизвестной стоимости основанием может быть только estimate');
      }
      out.costBasis = value.costBasis === 'estimate' ? 'estimate' : null;
    }

    out.sourceCurrency = text(value.sourceCurrency ?? '', 3, {required: true, name: 'валюту источника'}).toUpperCase();
    if (!CURRENCY_RE.test(out.sourceCurrency)) bad('Валюта источника — три латинские буквы, например USD');
    out.sourceAmount = value.sourceAmount === undefined || value.sourceAmount === null
      ? null : positive(value.sourceAmount, 'сумму в валюте источника');
    if (out.costKnown && out.sourceAmount === null) bad('При известной стоимости укажите сумму в валюте источника');

    // Пересчёт валюты только с явным курсом: курс не подставляется и не берётся из воздуха.
    if (value.rate === undefined || value.rate === null) {
      if (out.sourceCurrency !== 'RUB' && out.costKnown) {
        bad('Для валюты, отличной от RUB, укажите курс, его дату и источник');
      }
      out.rate = null;
    } else {
      only(value.rate, ['value', 'at', 'source'], 'курс');
      out.rate = {value: positive(value.rate.value, 'значение курса'), at: day(value.rate.at, 'дату курса'),
        source: safeText(value.rate.source ?? '', 300, 'источник курса')};
      if (!out.rate.source) bad('Укажите источник курса');
    }

    if (value.usage === undefined || value.usage === null) out.usage = null;
    else {
      only(value.usage, USAGE_KEYS, 'потребление');
      const usage = {};
      for (const key of USAGE_KEYS) {
        if (value.usage[key] === undefined || value.usage[key] === null) continue;
        usage[key] = whole(value.usage[key], `потребление: ${key}`);
      }
      // Хранятся только доступные показатели: отсутствующий не превращается в ноль.
      out.usage = Object.keys(usage).length ? usage : null;
    }

    if (value.tariff === undefined || value.tariff === null) out.tariff = null;
    else {
      only(value.tariff, ['input', 'output', 'currency', 'at', 'source'], 'тариф');
      const tariff = {at: day(value.tariff.at, 'дату тарифа'),
        source: safeText(value.tariff.source ?? '', 300, 'источник тарифа'),
        currency: text(value.tariff.currency ?? '', 3, {required: true, name: 'валюту тарифа'}).toUpperCase()};
      if (!CURRENCY_RE.test(tariff.currency)) bad('Валюта тарифа — три латинские буквы');
      if (!tariff.source) bad('Укажите источник тарифа');
      for (const key of ['input', 'output']) {
        tariff[key] = value.tariff[key] === undefined || value.tariff[key] === null
          ? null : positive(value.tariff[key], `тариф: ${key}`);
      }
      out.tariff = tariff;
    }

    out.confirmation = safeText(value.confirmation ?? '', 500, 'источник подтверждения');
    if (out.costKnown && out.costBasis === 'invoice' && !out.confirmation) {
      bad('Для стоимости по счёту укажите источник подтверждения');
    }
    if (out.paidBy === 'client' && !out.confirmation) {
      bad('Для оплаты клиентом укажите, чем она подтверждена');
    }
    // Пополнение баланса — движение денег, а не потребление: смешивать нельзя.
    if (out.movement === 'topup' && out.usage) bad('Пополнение баланса не описывает потребление токенов');
    if (out.movement === 'topup' && entry.type !== 'expense') bad('Пополнение баланса записывается расходом');
    return out;
  }

  /* Ключ идемпотентности импорта: один и тот же расход провайдера не заводится дважды.
     Для подписки ключ строится по периоду, поэтому за каждый запрос она не повторяется. */
  function requestId(ai) {
    const parts = ai.mode === 'subscription'
      ? ['sub', ai.periodFrom, ai.periodTo]
      : [ai.movement, ai.providerRequestId ? String(ai.providerRequestId) : ''];
    const key = ['ai', ai.service, ai.accountLabel, ...parts].join(':')
      .toLowerCase().replace(/[^a-z0-9:_.-]+/g, '-').replace(/:+/g, '-').replace(/-+/g, '-');
    return key.slice(0, 80).replace(/^[^a-z0-9]+/, '') || null;
  }

  /* Сводка по расходам на ИИ. Факт, план и оценка считаются РАЗДЕЛЬНО и нигде не складываются:
     «фактически потрачено» — это только actual.spend. Пополнение не смешивается с потреблением,
     оплата клиента — с нашим расходом, неизвестная стоимость считается отдельно и не выдаётся
     за сумму. */
  function summary(entries) {
    const cents = (value) => Math.round((value || 0) * 100);
    const bucket = () => ({consumption: 0, subscriptions: 0, spend: 0, invoiced: 0, estimated: 0});
    const totals = {entries: 0, actual: bucket(), planned: bucket(),
      topups: {actual: 0, planned: 0}, clientPaid: {actual: 0, planned: 0},
      unknown: {count: 0, withoutAmount: 0}, currencies: {}, basis: ''};
    for (const entry of entries) {
      const ai = entry.ai;
      if (!ai || entry.state === 'void') continue;
      // Всё, что не проведено фактически, попадает в план: смешивать их нельзя.
      const phase = entry.state === 'actual' ? 'actual' : 'planned';
      totals.entries += 1;
      if (!ai.costKnown) {
        totals.unknown.count += 1;
        if (!entry.amount) totals.unknown.withoutAmount += 1;
      }
      const amount = cents(entry.amount);
      if (ai.paidBy === 'client') { totals.clientPaid[phase] += amount; continue; }
      if (ai.movement === 'topup') { totals.topups[phase] += amount; continue; }
      const target = totals[phase];
      if (ai.mode === 'subscription') target.subscriptions += amount;
      else target.consumption += amount;
      if (ai.costBasis === 'invoice') target.invoiced += amount;
      else if (ai.costBasis === 'estimate') target.estimated += amount;
      if (ai.sourceAmount !== null && ai.sourceAmount !== undefined) {
        const current = totals.currencies[ai.sourceCurrency] || {actual: 0, planned: 0};
        current[phase] = Math.round((current[phase] + ai.sourceAmount) * 1e6) / 1e6;
        totals.currencies[ai.sourceCurrency] = current;
      }
    }
    for (const phase of ['actual', 'planned']) {
      const target = totals[phase];
      target.spend = target.consumption + target.subscriptions;
      for (const key of Object.keys(target)) target[key] /= 100;
      totals.topups[phase] /= 100;
      totals.clientPaid[phase] /= 100;
    }
    totals.basis = 'Фактически потрачено — только actual.spend. План и оценка в него не входят ' +
      'и показываются отдельно. Пополнение баланса — движение денег, а не расход. ' +
      'Оплата клиента не наш расход. Расчётная оценка не является счётом провайдера. ' +
      'Неподтверждённая стоимость записывается без суммы и не подменяется заглушкой.';
    return totals;
  }

  return {normalize, requestId, summary};
}

module.exports = {createFinanceAi, AI_MODES: MODES, AI_MOVEMENTS: MOVEMENTS, AI_PAYERS: PAYERS,
  AI_COST_BASES: BASES, AI_USAGE_KEYS: USAGE_KEYS, AI_FIELDS: FIELDS};

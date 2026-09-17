'use strict';
/* Команды Хью в Telegram-группах проектов: /hugh /plan /content /idea /status /help.
   Поверх существующего потока (webhook → мост → комната проекта): второго потребителя обновлений нет.
   Меню, план, инструкция и статус — детерминированные ответы без модели; /idea ставит вопрос модели
   в ту же очередь с тем же системным промптом, что и обычные ответы. Публикации и согласование из меню недоступны. */
const COMMANDS = Object.freeze(['hugh', 'plan', 'content', 'idea', 'status', 'help']);
const COMMAND_RE = /^\s*\/(hugh|plan|content|idea|status|help)(?:@([A-Za-z0-9_]{1,64}))?(?:\s+([\s\S]*))?$/u;
const SIGNATURE = 'Хью, бизнес-ассистент Синапс Бизнес (ИИ)';
const REVIEW = { draft: 'черновик', pending: 'на согласовании', approved: 'согласовано', rejected: 'отклонено' };
const STATUS = { draft: 'черновик', scheduled: 'в плане отправки', publishing: 'отправляется', published: 'опубликовано', failed: 'ошибка', needs_review: 'нужна проверка', cancelled: 'отменено' };
const shortText = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/* Разбор команды: имя, адресат (@bot) и аргумент. Команда чужому боту (@другой) — не наша. */
function parseCommand(text, botUsername = '') {
  const match = COMMAND_RE.exec(String(text || ''));
  if (!match) return null;
  const target = match[2] || '';
  if (target && botUsername && target.toLowerCase() !== String(botUsername).toLowerCase()) return null;
  return { name: match[1], target, argument: shortText(match[3] || '', 1000) };
}
/* Адресовано ли сообщение Хью: ответ боту, @упоминание бота или обращение по имени. */
function isAddressed({ text = '', replyToBot = false, mentions = [] }, botUsername = '') {
  if (replyToBot) return true;
  if (botUsername && mentions.some((m) => String(m).replace(/^@/, '').toLowerCase() === String(botUsername).toLowerCase())) return true;
  return /(?:^|[^\p{L}\p{N}_])(?:Хью|Hugh)(?:$|[^\p{L}\p{N}_])/iu.test(text);
}
function localStamp(iso, timezone) {
  if (!iso) return 'дата не задана';
  try {
    return new Intl.DateTimeFormat('ru-RU', { timeZone: timezone || 'UTC', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) + ` (${timezone || 'UTC'})`;
  } catch { return `${iso} (UTC)`; }
}
function menuText(roomTitle) {
  return `${SIGNATURE}. Проект: ${roomTitle}.\n` +
    'Команды:\n/plan — актуальный контент-план проекта\n/content — куда прислать исходник (видео, фото, текст)\n' +
    '/idea — предложить идею короткого ролика (отвечает модель, ставится в очередь)\n/status — состояние очереди ответов и моделей\n/help — эта подсказка\n' +
    'Согласование и публикация выполняются только владельцем в кабинете; через меню они недоступны.';
}
function planText(roomTitle, plan) {
  if (!plan || plan.error) return `${SIGNATURE}. План проекта «${roomTitle}» сейчас недоступен: ${plan?.error || 'нет связи с CRM'}. Попробуйте позже или откройте кабинет.`;
  const items = Array.isArray(plan.items) ? plan.items : [];
  if (!items.length) return `${SIGNATURE}. В контент-плане «${roomTitle}» пока нет карточек. Добавить их можно в кабинете: Автопостинг → Очередь контента.`;
  const lines = items.slice(0, 10).map((item, index) => `${index + 1}. ${item.dayKey ? item.dayKey + ' · ' : ''}${shortText(item.title, 80)} — ${REVIEW[item.reviewState] || item.reviewState || 'черновик'}` +
    `${item.status && item.status !== 'draft' ? ', ' + (STATUS[item.status] || item.status) : ''}; план: ${localStamp(item.scheduledAt, item.timezone)}` +
    `${item.mediaKind === 'video' ? '' : item.mediaKind === 'image' ? '; изображение' : '; без материала'}`);
  return `${SIGNATURE}. Контент-план «${roomTitle}» (${items.length} карт.):\n${lines.join('\n')}` + (items.length > 10 ? `\n…и ещё ${items.length - 10}.` : '') +
    '\nПлановая дата — не отправка: публикацию запускает владелец в кабинете отдельным действием.';
}
function contentText(roomTitle, cabinetUrl) {
  return `${SIGNATURE}. Как передать исходник для «${roomTitle}»:\n` +
    '1) Пришлите видео или фото прямо в этот чат — оно сохранится в проекте (до 8 МБ на файл; больше — ссылкой на диск).\n' +
    `2) Или загрузите в кабинете: ${cabinetUrl || 'кабинет'} → Автопостинг → «Загрузить файл» (MP4/WebM до 60 МБ, JPEG/PNG/WebP до 10 МБ).\n` +
    '3) Текстом напишите день/тему и для кого материал — сообщение сохранится в переписке проекта; карточку плана из него заводит редактор в кабинете.\n' +
    'Публиковать материал сразу никто не будет: сначала согласование владельцем в кабинете.';
}
function statusText(roomTitle, state) {
  const lines = [`${SIGNATURE}. Состояние для «${roomTitle}»:`];
  const primary = state.primary || {};
  lines.push(`Основной путь ответов (подписка): ${primary.local ? (primary.offline ? 'компьютер Хью не на связи' : 'компьютер Хью на связи') : primary.connected ? (primary.limited ? 'подключён, но лимит исчерпан' : 'подключён') : primary.configured ? 'не подключён' : 'не настроен'}.`);
  const fb = state.fallback || { configured: false, providers: [] };
  if (!fb.configured) lines.push('Резервные модели: не настроены (ключей на сервере нет).');
  else lines.push(`Резервные модели: ${fb.providers.map((p) => `${p.name} — ${p.cooling ? 'пауза' : p.live ? 'живой ответ был' : 'настроен, живой ответ не подтверждён'}`).join('; ')}.`);
  lines.push(`Очередь этого проекта: ждут ответа ${state.queue?.waiting ?? 0}, ошибок ${state.queue?.failed ?? 0}.`);
  lines.push('Это состояние сервера, не обещание доступности. Публикации и согласование — только в кабинете.');
  return lines.join('\n');
}
const IDEA_INSTRUCTION = 'Участник запросил идею короткого ролика командой /idea. Предложи ровно одну идею для этого проекта: для кого ролик, хук на первые 3 секунды, ' +
  'одна мысль, что происходит на экране, чем удерживать внимание каждые ~3 секунды, что измеряем (удержание, репосты). Без призывов купить, без цен и без обещаний результата. ' +
  'Явно отметь, что это предложение для обсуждения, а не утверждённый план. Если в запросе есть тема — используй её.';
function ideaPendingText() {
  return `${SIGNATURE}. Запрос на идею принят и поставлен в очередь: отвечу, когда сервис ИИ будет доступен. Действий по плану не выполнялось.`;
}
module.exports = { COMMANDS, SIGNATURE, IDEA_INSTRUCTION, parseCommand, isAddressed, menuText, planText, contentText, statusText, ideaPendingText };

'use strict';

/* ОБРАЗЕЦ АДАПТЕРА ДЛЯ ПРОВЕРКИ ПРОТОКОЛА. Модели здесь нет и не будет.

   Это smoke-заглушка: она показывает контракт «запрос со стандартного ввода → JSON на стандартный
   вывод» и годится для doctor/probe/once на пустой установке. Ответы она составляет механически,
   клиентам такое показывать нельзя. Настоящий адаптер Claude или DeepSeek пишется по этому же
   контракту и подключается вместо этого файла.

   Контракт:
   - на вход приходит JSON {system, messages:[{role,content}], prompt} (input: "stdin-json")
     или готовый текст запроса (input: "stdin-text");
   - на выход — одна строка JSON {"text": "<ответ>", "model": "<название модели или пусто>"};
   - код возврата 0 — ответ готов; ненулевой — отказ, коннектор переведёт его в код контракта;
   - аргумент --version используется как проба готовности. */

const VERSION = 'sample-agent 1.0 (заглушка без модели)';

if (process.argv.includes('--version')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let question = '';
  try {
    const payload = JSON.parse(input);
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    question = String(messages[messages.length - 1]?.content ?? '').trim();
  } catch {
    question = input.trim().split('\n').pop() || '';
  }
  if (!question) { process.stderr.write('пустой запрос\n'); process.exit(2); }
  // model оставляем пустой: выдумывать название модели у заглушки нечего.
  process.stdout.write(`${JSON.stringify({
    text: `Проверка связи прошла. Запрос получен: ${question.slice(0, 200)}. Это образец адаптера без модели — настоящий ответ появится, когда будет подключён реальный ИИ.`,
    model: '',
  })}\n`);
});

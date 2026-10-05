'use strict';

// Offline demonstration only. These are labelled fixtures, never real CRM tasks.
const { createBot } = require('./bot');
const readline = require('node:readline/promises');

async function demo() {
  const ownerUserId = 1001;
  const source = { listTasks: async () => [
    { id: 1, title: 'ДЕМО — проверить стартовый документ', companyCode: 'synapse',
      companyName: 'Synapse', status: 'in_progress', dueAt: '2026-10-02',
      nextAction: 'Открыть минимальный порядок чтения', blocker: '', waitingForOwner: false },
    { id: 2, title: 'ДЕМО — согласовать подключение Eva', companyCode: 'synapse',
      companyName: 'Synapse', status: 'planned', dueAt: null,
      nextAction: 'Проверить объём доступа перед запуском', blocker: 'Подключение ещё не выполнено', waitingForOwner: true },
    { id: 3, title: 'ДЕМО — подготовить проверку чтения', companyCode: 'synapse',
      companyName: 'Synapse', status: 'done', dueAt: '2026-10-01', nextAction: '', blocker: '', waitingForOwner: false },
  ] };
  const bot = createBot({ownerUserId, source, timeZone: 'Etc/UTC', now: () => new Date('2026-10-02T12:00:00Z')});
  let updateId = 1;
  const chat = {id: ownerUserId, type: 'private'};
  let output = await bot.handleUpdate({update_id: updateId++, message: {message_id: 1, from: {id:ownerUserId}, chat, text:'/start'}});
  const io = process.argv.includes('--snapshot') ? null : readline.createInterface({input:process.stdin,output:process.stdout});
  console.log('ЛОКАЛЬНОЕ ДЕМО · без Telegram, токена и реальных задач\n');
  try {
    while (true) {
      const screen = output.find(item => ['sendMessage','editMessageText'].includes(item.method));
      if (!screen) break;
      console.log(screen.params.text);
      const buttons = (screen.params.reply_markup?.inline_keyboard || []).flat();
      buttons.forEach((b,i)=>console.log(`${i+1}. ${b.text}`));
      if (!io) break;
      const choice = (await io.question('\nНомер кнопки, 0 — выход: ')).trim();
      if (choice === '0') break;
      const button = buttons[Number(choice)-1];
      if (!button?.callback_data) { console.log('Выберите кнопку из списка.'); continue; }
      output = await bot.handleUpdate({update_id:updateId++,callback_query:{id:String(updateId),from:{id:ownerUserId},
        data:button.callback_data,message:{message_id:1,chat}}});
      console.log('');
    }
  } finally { io?.close(); }
}
if (require.main === module) demo().catch(()=>{console.error('Демо не удалось запустить');process.exitCode=1;});
module.exports = {demo};

'use strict';
const {localDay}=require('./revenue-analytics-access');

// Только оценка уже сохранённого отчёта; внешних запросов и побочных эффектов нет.
function revenueQuality({period,state,metrika:m,yclients:y},now) {
  const checks=[];
  const add=(id,title,status,detail)=>checks.push({id,title,status,detail});
  const sources=Object.fromEntries(state.providers.map(p=>[p.provider,p]));
  const missing=(p)=>!p.configured?'Подключение ещё не настроено. Отсутствие данных не означает ноль.':
    !p.enabled?'Сбор выключен. Владелец может проверить подключение.':
    p.lastSuccess&&!p.current?'Подключение или правила изменились. Нужна новая успешная выгрузка; прежние строки не переоцениваются как проверенные деньги.':
    'За этот период ещё нет успешной выгрузки. Нужен сбор выбранного периода.';
  const issues=(p,snapshot,ageLimit)=>{
    const parts=[];
    if(!p.enabled)parts.push('Сбор выключен.');
    if(!snapshot.current)parts.push('Подключение или правила изменились; прежний снимок требует новой проверки.');
    if(p.errorCode)parts.push('Последнее обновление завершилось ошибкой; сохранённые числа не подтверждают её устранение.');
    if(now-Date.parse(snapshot.collectedAt)>ageLimit)parts.push('Этот снимок требует обновления.');
    return parts;
  };
  const mp=sources.metrika,yp=sources.yclients;
  if(!m)add('metrika_snapshot','Данные сайта','unavailable',missing(mp));
  else {
    const parts=issues(mp,m,3*3600000);
    add('metrika_snapshot','Данные сайта',parts.length?'attention':'ok',parts.join(' ')||'Для выбранного периода есть актуальный снимок Метрики. Это не подтверждение записи или оплаты.');
  }
  if(!y)add('yclients_snapshot','Записи и деньги','unavailable',missing(yp));
  else {
    const parts=issues(yp,y,30*3600000);
    add('yclients_snapshot','Записи и деньги',parts.length?'attention':'ok',parts.join(' ')||'Есть успешная выгрузка YCLIENTS. Полнота истории и связи с источниками проверяются отдельно.');
  }
  const coverage=[];
  if(m && period.to>=localDay(now,m.timezone))coverage.push('Метрика: выбран текущий или будущий день; итог периода ещё не завершён.');
  if(y){
    if(y.partialHistory)coverage.push('YCLIENTS: история до '+y.historyFrom+' не загружена.');
    if(period.to>=localDay(Date.parse(y.collectedAt),y.timezone))coverage.push('YCLIENTS: период включает день последнего снимка или более поздние даты; итог ещё неполный.');
  }
  add('period_coverage','Полнота периода',!m&&!y?'unavailable':coverage.length?'attention':'ok',
    coverage.join(' ')||(!m&&!y?'Без выгрузок полноту периода проверить нельзя.':'Имеющиеся снимки не включают незавершённые даты или известный пробел истории. Отсутствующий источник по-прежнему неизвестен.'));
  if(!m)add('metrika_sampling','Точность Метрики','unavailable','Выборку и задержку нельзя проверить без выгрузки.');
  else {
    const sampled=[];
    if(m.overview.sampled)sampled.push('общий итог');
    if(m.sources.sampled)sampled.push('источники');
    if(m.utm.sampled)sampled.push('UTM');
    if(m.goals.some(g=>g.sampled))sampled.push('цели');
    const lag=Math.max(0,...[m.overview,m.sources,m.utm].map(r=>r.dataLagSeconds||0));
    add('metrika_sampling','Точность Метрики',sampled.length||lag?'attention':'ok',
      (sampled.length?'Выборка применяется: '+sampled.join(', ')+'. Малые различия не считать точным изменением. ':'')+
      (lag?'Задержка данных, указанная Метрикой: '+lag+' сек.':'')||'В полученных отчётах Метрика не указала выборку или задержку.');
  }
  if(!y){
    for(const [id,title] of [['booking_sources','Источники записей'],['cash_rules','Классификация денег'],['payment_links','Связи оплат'],['client_identity','Учёт платящих клиентов']])
      add(id,title,'unavailable','Нужна успешная выгрузка YCLIENTS; показатель пока неизвестен.');
  }else{
    add('booking_sources','Источники записей',!y.createdBookings?'no_events':y.bookingsWithoutSource?'attention':'ok',
      !y.createdBookings?'В снимке нет созданных записей за период; доля известных источников не определена.':
      'Источник известен у '+y.bookingsWithSource+' из '+y.createdBookings+' записей. Без источника: '+y.bookingsWithoutSource+'. Не назначать их рекламе.');
    add('cash_rules','Классификация денег',y.financialClassificationComplete?'ok':'attention',
      y.financialClassificationComplete?'Все полученные операции проверены по заданным правилам статей. Денежный итог не равен прибыли.':
      'Нужно проверить правила статей. Операций с неизвестной статьёй: '+y.unknownExpenseTransactions+'. Они исключены из денежного итога.');
    add('payment_links','Связи оплат',y.unmatchedTransactions?'attention':'ok',
      y.unmatchedTransactions?'Без однозначной связи с записью: '+y.unmatchedTransactions+' операций. Их источник неизвестен.':
      'В снимке нет учтённых операций с неоднозначной связью. Это не подтверждает источник всех записей.');
    add('client_identity','Учёт платящих клиентов',y.clientIdentityMissing?'attention':!y.paymentKopecks?'no_events':'ok',
      y.clientIdentityMissing?'Без идентификатора клиента: '+y.clientIdentityMissing+' положительных операций. Уникальные платящие клиенты могут быть недосчитаны.':
      !y.paymentKopecks?'В снимке нет учтённых положительных платежей за период.':'Для учтённых положительных платежей определены клиенты. Новые клиенты требуют полной истории первых оплат.');
  }
  add('economics','Стоимость клиента и окупаемость','unavailable','CAC и ROMI не рассчитаны: нужны полные расходы, история новых платящих клиентов и себестоимость той же группы. Не подставлять нули.');
  return {checkedAt:new Date(now).toISOString(),period:{...period},checks};
}
module.exports={revenueQuality};

'use strict';

/* HTTP-слой Медиа-наставника: бриф, контент-план на 7–14 дней и решение по конкретной версии плана.
   Права переиспользуются из автопостинга (autoposting.view / autoposting.edit) плюс принадлежность
   компании — новых прав раздел не заводит. Автор изменения берётся только из доверенной личности
   запроса: тело запроса имя автора задать не может.
   Согласование версии плана — решение по тексту, а не разрешение публиковать. */

const {fail} = require('./company-information');

const NOTICE = 'Бриф и план хранятся в CRM. Согласование версии плана — решение по тексту, ' +
  'а не разрешение публиковать: ничего не отправляется, очередь публикаций не создаётся, ' +
  'модели не вызываются, исходники описываются словами.';

// Модуль основы честно сообщал, что у него нет ни HTTP, ни кабинета. Теперь они есть,
// поэтому ответ маршрута исправляет это заявление, не трогая сам модуль основы.
function served(snapshot) {
  return {...snapshot, notice: NOTICE,
    capabilities: {...snapshot.capabilities, httpApi: true, cabinetUi: true,
      publishing: false, modelSuggestions: false, planApprovalAuthorizesPublishing: false}};
}

function versionNumber(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail(404, 'Версия не найдена', 'NOT_FOUND');
  return parsed;
}

function createMediaMentorHandler({mentor, transfer, companyModuleContext, readJson, send}) {
  return async function handleMediaMentor(request, response, url, cors = {}) {
    // Раздел внедрения живёт на /media-mentor-rollout и сюда не попадает: после имени
    // модуля обязателен «/» или конец пути.
    if (!/^\/media-mentor(?:\/|$)/.test(url.pathname)) return false;
    const code = url.searchParams.get('companyCode');
    const readOnly = request.method === 'GET';
    const {identity} = companyModuleContext(request, code, `autoposting.${readOnly ? 'view' : 'edit'}`);
    // Автор — только из доверенной личности запроса.
    const actor = {userId: identity.userId, userName: identity.userName};
    const briefVersion = /^\/media-mentor\/brief\/versions\/([^/]+)$/.exec(url.pathname);
    const planVersion = /^\/media-mentor\/plan\/versions\/([^/]+)$/.exec(url.pathname);
    const draftContext = /^\/media-mentor\/plan\/transfer\/([^/]+)$/.exec(url.pathname);
    let result, status = 200;
    if (url.pathname === '/media-mentor' && readOnly) {
      result = {...served(mentor.get(code)), transfer: transfer.status(code)};
    } else if (url.pathname === '/media-mentor/plan/transfer' && request.method === 'POST') {
      // Перенос согласованной версии плана в черновики автопостинга. Ничего не публикуется
      // и не ставится в очередь: права те же, что на правку карточек автопостинга.
      result = transfer.transfer(code, await readJson(request), actor);
      status = result.created ? 201 : 200;
    } else if (url.pathname === '/media-mentor/plan/feedback' && request.method === 'POST') {
      // Замечание к строке текущей версии плана. Оно не меняет план и не считается решением.
      result = served(mentor.addFeedback(code, await readJson(request), actor));
      status = 201;
    } else if (url.pathname === '/media-mentor/brief' && request.method === 'PUT') {
      result = served(mentor.saveBrief(code, await readJson(request), actor));
    } else if (url.pathname === '/media-mentor/plan' && request.method === 'PUT') {
      result = served(mentor.savePlan(code, await readJson(request), actor));
    } else if (url.pathname === '/media-mentor/plan/decision' && request.method === 'POST') {
      // Решение по версии плана принимает владелец кабинета, как и согласование публикаций.
      // Права редактора для этого недостаточно.
      if (identity.role !== 'owner') fail(403, 'Согласовывать и отклонять план может только владелец', 'FORBIDDEN');
      result = served(mentor.decide(code, await readJson(request), actor));
      status = 201;
    } else if (briefVersion && readOnly) result = mentor.briefVersion(code, versionNumber(briefVersion[1]));
    else if (planVersion && readOnly) result = mentor.planVersion(code, versionNumber(planVersion[1]));
    // Контекст перенесённого черновика: задание дня и его исходник из неизменяемых версий.
    else if (draftContext && readOnly) result = transfer.context(code, draftContext[1]);
    else if (['/media-mentor', '/media-mentor/brief', '/media-mentor/plan', '/media-mentor/plan/decision',
      '/media-mentor/plan/transfer', '/media-mentor/plan/feedback'].includes(url.pathname) ||
      briefVersion || planVersion || draftContext) fail(405, 'Метод не поддерживается');
    else fail(404, 'Раздел не найден', 'NOT_FOUND');
    send(response, status, result, {...cors, 'cache-control': 'no-store'});
    return true;
  };
}

module.exports = {createMediaMentorHandler, MEDIA_MENTOR_HTTP_NOTICE: NOTICE};

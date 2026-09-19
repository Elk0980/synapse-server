(() => {
  'use strict';
  /* Внедрение Медиа-наставника в кабинете клиента: этапы с датой, статусом и свидетельством,
     процент закрытых обязательных этапов с явным знаменателем, блокеры, следующий шаг
     и еженедельный опрос внутри ЛК. Этапы правит только администратор Synapse;
     клиент раздел читает и отвечает на опрос. Наружу ничего не отправляется. */
  const sb = window.SbCabinet = window.SbCabinet || {};
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const PATH = '/media-mentor-rollout';
  const STATUSES = [
    ['not_started', 'Не начат'], ['in_progress', 'В работе'], ['blocked', 'Блокер'], ['done', 'Готово'],
  ];
  const day = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value).split('-').reverse().join('.') : '—');
  const moment = (value) => (value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleDateString('ru-RU', {day: '2-digit', month: '2-digit', year: 'numeric'}) : '—');
  const canRead = (ctx) => ctx.identity?.role === 'owner' || ctx.identity?.permissions?.includes('autoposting.view');
  const isAdmin = (ctx) => ctx.identity?.role === 'owner';
  let epoch = 0;
  // Один номер отправки на цикл опроса: повтор нажатия не создаёт второй ответ.
  const submissionIds = new Map();
  const submissionId = (companyCode, cycleKey) => {
    const key = `${companyCode}|${cycleKey}`;
    if (!submissionIds.has(key)) {
      submissionIds.set(key, (window.crypto?.randomUUID?.() || `cycle-${Date.now()}-${Math.random().toString(36).slice(2)}`));
    }
    return submissionIds.get(key);
  };

  function progressMarkup(progress, trackKey) {
    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    return `<div class="card mentor-progress" data-track="${esc(trackKey)}">
      <p class="mentor-progress-value"><strong>${esc(progress.requiredDone)} из ${esc(progress.requiredTotal)}</strong>
        обязательных этапов · ${esc(percent)}%</p>
      <div class="mentor-progress-bar" role="img"
        aria-label="${esc(progress.label)}"><span style="width:${percent}%"></span></div>
      <p class="mentor-note">${esc(progress.basis)}</p>
      <ul class="mentor-progress-extra">
        <li>Необязательные этапы: ${esc(progress.optionalDone)} из ${esc(progress.optionalTotal)} (в процент не входят)</li>
        <li>Этапов с блокером: ${esc(progress.blocked)}</li>
      </ul></div>`;
  }

  function nextStepMarkup(next, track) {
    if (!next) {
      return `<div class="card mentor-next"><h3>Следующий шаг</h3>
        <p>Все этапы дорожки «${esc(track.title)}» закрыты.</p></div>`;
    }
    return `<div class="card mentor-next" data-status="${esc(next.status)}"><h3>Следующий шаг</h3>
      <p class="mentor-next-title"><strong>${esc(next.reason)}: ${esc(next.title)}</strong></p>
      ${next.detail ? `<p>${esc(next.detail)}</p>` : ''}
      <p class="mentor-note">Плановая дата: ${esc(day(next.targetDate))} ·
        ${next.required ? 'обязательный этап' : 'необязательный этап'}</p></div>`;
  }

  function stageMarkup(stage, admin) {
    const editor = admin ? `<details class="mentor-stage-editor"><summary>Изменить этап</summary>
      <form class="crm-form" data-stage="${esc(stage.key)}">
        <label>Статус<select name="status">${STATUSES.map(([value, label]) =>
    `<option value="${value}"${stage.status === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
        <label>Плановая дата<input name="targetDate" type="date" value="${esc(stage.targetDate || '')}"></label>
        <label data-done>Дата готовности<input name="confirmedOn" type="date" value="${esc(stage.confirmedOn || '')}"></label>
        <label class="wide" data-done>Свидетельство готовности<input name="evidence" maxlength="2000"
          value="${esc(stage.evidence)}" placeholder="${esc(stage.evidenceHint)}"></label>
        <label class="wide" data-blocked>Что блокирует<input name="blocker" maxlength="2000" value="${esc(stage.blocker)}"></label>
        <label class="wide">Комментарий<textarea name="note" rows="2" maxlength="2000">${esc(stage.note)}</textarea></label>
        <div class="crm-actions wide"><button class="plain-button" type="submit">Сохранить этап</button>
          <span class="mentor-stage-state" role="status"></span></div>
      </form></details>` : '';
    return `<article class="card mentor-stage" data-status="${esc(stage.status)}">
      <header class="mentor-stage-head"><h3>${esc(stage.title)}</h3>
        <span class="mentor-badge" data-status="${esc(stage.status)}">${esc(stage.statusLabel)}</span></header>
      <p class="mentor-note">${esc(stage.required ? 'Обязательный этап' : 'Необязательный этап')} ·
        план: ${esc(day(stage.targetDate))}${stage.status === 'done' ? ` · готово: ${esc(day(stage.confirmedOn))}` : ''}</p>
      <p>${esc(stage.detail)}</p>
      ${stage.status === 'done' && stage.evidence ? `<p class="mentor-evidence"><span>Свидетельство готовности:</span> ${esc(stage.evidence)}</p>` : ''}
      ${stage.status === 'blocked' && stage.blocker ? `<p class="mentor-blocker"><span>Блокер:</span> ${esc(stage.blocker)}</p>` : ''}
      ${stage.note ? `<p class="mentor-note">${esc(stage.note)}</p>` : ''}
      ${stage.actorName ? `<p class="mentor-note">Отметил: ${esc(stage.actorName)} · ${esc(moment(stage.updatedAt))}</p>` : ''}
      ${editor}</article>`;
  }

  function answerMarkup(response) {
    if (!response) return '<p class="mentor-note">Ответов пока нет.</p>';
    if (response.skipped) return `<p class="mentor-note">${esc(moment(response.createdAt))} — опрос пропущен.</p>`;
    return `<p class="mentor-note">${esc(moment(response.createdAt))} · полезность:
      ${response.usefulness === null ? 'без оценки' : `${esc(response.usefulness)} из 5`}${response.blocking ? ` · мешает: ${esc(response.blocking)}` : ''}${response.improvement ? ` · улучшить: ${esc(response.improvement)}` : ''}</p>`;
  }

  function surveyMarkup(survey) {
    const [usefulness, blocking, improvement] = survey.questions;
    const history = survey.responses.length
      ? `<details class="mentor-answers"><summary>Прошлые ответы (${esc(survey.responses.length)})</summary>
        ${survey.responses.map((response) => answerMarkup(response)).join('')}</details>` : '';
    if (!survey.due) {
      return `<section class="card mentor-survey"><h2>Опрос раз в 7 дней</h2>
        <p>Следующий опрос откроется ${esc(moment(survey.dueAt))}.</p>
        <p class="mentor-note">${esc(survey.basis)}</p>
        <h3>Последний ответ</h3>${answerMarkup(survey.lastResponse)}${history}</section>`;
    }
    return `<section class="card mentor-survey" data-due="true"><h2>Опрос раз в 7 дней</h2>
      <p class="mentor-note">${esc(survey.basis)}</p>
      <form id="mentor-survey-form" class="crm-form">
        <fieldset class="wide mentor-scale"><legend>${esc(usefulness.title)}</legend>
          <p class="mentor-note">${esc(usefulness.hint)}. Можно не отвечать.</p>
          <div class="mentor-scale-options">
            <label><input type="radio" name="usefulness" value="" checked>без оценки</label>
            ${[1, 2, 3, 4, 5].map((value) => `<label><input type="radio" name="usefulness" value="${value}">${value}</label>`).join('')}
          </div></fieldset>
        <label class="wide">${esc(blocking.title)}<textarea name="blocking" rows="3" maxlength="2000"
          placeholder="${esc(blocking.hint)}"></textarea></label>
        <label class="wide">${esc(improvement.title)}<textarea name="improvement" rows="3" maxlength="2000"
          placeholder="${esc(improvement.hint)}"></textarea></label>
        <div class="crm-actions wide"><button class="plain-button" type="submit">Отправить ответ</button>
          <button class="plain-button" type="button" data-survey-skip>Пропустить на этой неделе</button>
          <span id="mentor-survey-state" role="status"></span></div>
      </form>${history}</section>`;
  }

  // Каждая дорожка — свой заголовок, свой процент и свой следующий шаг. Проценты не складываются.
  function trackMarkup(data, track, admin) {
    const progress = data.progress?.[track.key] || {};
    const stages = data.stages.filter((stage) => stage.track === track.key);
    return `<section class="mentor-track" data-track="${esc(track.key)}">
      <h2>${esc(track.title)}</h2>
      <p class="mentor-note">${esc(track.basis)}</p>
      ${progressMarkup(progress, track.key)}
      ${nextStepMarkup(data.nextStep?.[track.key] || null, track)}
      ${stages.map((stage) => stageMarkup(stage, admin)).join('')}</section>`;
  }

  function markup(data, ctx) {
    const admin = isAdmin(ctx);
    const tracks = Array.isArray(data.tracks) ? data.tracks : [];
    return `<p class="card mentor-tracks-basis" role="note">${esc(data.tracksBasis)}</p>
      <p class="mentor-note">Внедрение началось ${esc(moment(data.startedAt))}.
        ${admin ? 'Этапы ведёте вы как администратор Synapse.' : 'Этапы ведёт администратор Synapse: здесь они только для чтения.'}</p>
      ${tracks.map((track) => trackMarkup(data, track, admin)).join('')}
      ${surveyMarkup(data.survey)}
      <details class="card mentor-history"><summary>История изменений (${esc(data.history.length)})</summary>
        <ol>${data.history.map((item) => `<li>${esc(moment(item.createdAt))} · ${esc(item.stageKey)}:
          ${esc(item.fromStatus)} → ${esc(item.toStatus)}${item.actorName ? ` · ${esc(item.actorName)}` : ''}
          ${item.reason ? `<br>${esc(item.reason)}` : ''}</li>`).join('') || '<li>Изменений пока нет</li>'}</ol></details>`;
  }

  function bind(container, node, ctx, data) {
    const code = ctx.selectedProjectId;
    const busy = (form, state) => form.querySelectorAll('button,input,select,textarea').forEach((element) => {
      element.disabled = state;
    });
    node.querySelectorAll('form[data-stage]').forEach((form) => {
      const toggle = () => {
        const status = form.elements.status.value;
        form.querySelectorAll('[data-done]').forEach((label) => { label.hidden = status !== 'done'; });
        form.querySelectorAll('[data-blocked]').forEach((label) => { label.hidden = status !== 'blocked'; });
        form.elements.evidence.required = status === 'done';
        form.elements.confirmedOn.required = status === 'done';
        form.elements.blocker.required = status === 'blocked';
      };
      form.elements.status.addEventListener('change', toggle);
      toggle();
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        const state = form.querySelector('.mentor-stage-state');
        const status = form.elements.status.value;
        const stage = {key: form.dataset.stage, status,
          targetDate: form.elements.targetDate.value || null,
          confirmedOn: status === 'done' ? form.elements.confirmedOn.value || null : null,
          evidence: status === 'done' ? form.elements.evidence.value.trim() : '',
          blocker: status === 'blocked' ? form.elements.blocker.value.trim() : '',
          note: form.elements.note.value.trim()};
        busy(form, true);
        state.textContent = 'Сохраняем…';
        try {
          await ctx.crmQuery(`${PATH}/stages`, {companyCode: code},
            ctx.csrfOptions('PUT', {revision: data.revision, stages: [stage]}));
          if (ctx.selectedProjectId !== code) return;
          await load(container, ctx);
        } catch (error) {
          if (ctx.selectedProjectId !== code) return;
          busy(form, false);
          state.textContent = error.message;
        }
      });
    });
    const survey = node.querySelector('#mentor-survey-form');
    if (!survey) return;
    const state = node.querySelector('#mentor-survey-state');
    const send = async (payload, suffix) => {
      busy(survey, true);
      state.textContent = 'Отправляем ответ…';
      try {
        await ctx.crmQuery(`${PATH}/survey`, {companyCode: code}, ctx.csrfOptions('POST', {
          requestId: `${submissionId(code, data.survey.cycleKey)}-${suffix}`,
          cycleKey: data.survey.cycleKey, ...payload}));
        if (ctx.selectedProjectId !== code) return;
        await load(container, ctx);
      } catch (error) {
        if (ctx.selectedProjectId !== code) return;
        busy(survey, false);
        state.textContent = error.message;
      }
    };
    survey.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = survey.elements.usefulness.value;
      void send({usefulness: value === '' ? null : Number(value),
        blocking: survey.elements.blocking.value.trim(),
        improvement: survey.elements.improvement.value.trim()}, 'answer');
    });
    survey.querySelector('[data-survey-skip]').addEventListener('click', () => {
      void send({usefulness: null, blocking: '', improvement: ''}, 'skip');
    });
  }

  async function load(container, ctx) {
    const id = ++epoch, code = ctx.selectedProjectId;
    const node = container.querySelector('#mentor-rollout-content');
    if (!node) return;
    try {
      const data = await ctx.crmQuery(PATH, {companyCode: code});
      // Ответ прежней компании не рисуется: данные внедрения не смешиваются между компаниями.
      if (id !== epoch || ctx.selectedProjectId !== code || !node.isConnected) return;
      if (data.companyCode !== String(code).toLowerCase()) throw new Error('Ответ другой компании');
      node.innerHTML = markup(data, ctx);
      bind(container, node, ctx, data);
    } catch (error) {
      if (id === epoch && node.isConnected) {
        node.innerHTML = `<p class="crm-error" role="alert">Не удалось загрузить внедрение: ${esc(error.message)}</p>`;
      }
    }
  }

  function render(container, ctx) {
    if (!canRead(ctx)) {
      container.innerHTML = '<div class="content-header"><h1>Медиа-наставник</h1></div>' +
        '<div class="card"><p>Раздел доступен по праву «Автопостинг: просмотр». Обратитесь к владельцу кабинета.</p></div>';
      return;
    }
    container.innerHTML = `<div class="content-header"><h1>Медиа-наставник</h1>
      <p>Две дорожки внедрения — разработка модуля и настройка у клиента: что готово, что в работе,
        где блокер и какой следующий шаг. Раз в 7 дней — короткий опрос о том, что улучшить.
        Опрос живёт внутри кабинета.</p></div>
      <div id="mentor-rollout-content" aria-live="polite"><p>Загружаем этапы внедрения…</p></div>`;
    void load(container, ctx);
  }

  sb.mediaMentorRollout = {render, load};
  sb.registerView('media-mentor-rollout', {title: 'Медиа-наставник', render, onProjectChange: render});
})();

/* Съёмка (№98 · В): вкладка «Раскадровка» карточки рилса. Кадр: что в кадре, ракурс, смена плана,
   важное. Пустая раскадровка заполняется черновиком из сценария; сохранение — с проверкой версии.
   «🧪 ТЕСТОВАЯ ВЕРСИЯ»: эскиз кадра через OpenAI ключом резервного Хью, только по нажатию. */
(() => {
  'use strict';
  const S = window.SbShooting = window.SbShooting || {};
  const FIELDS = [['shot', 'Что в кадре'], ['angle', 'Ракурс'], ['transition', 'Смена плана'], ['notes', 'Важное']];

  const draftFrom = (parsed) => parsed.frames.map((frame) => ({
    shot: frame.type === 'line' ? `${frame.actor} говорит в камеру` : frame.text,
    angle: frame.type === 'insert' ? 'крупный план' : frame.type === 'line' ? 'средний план' : '',
    transition: frame.n === 1 ? 'начало, хук' : 'склейка', notes: frame.props.join(', ')}));

  function render({view, parsed, reel, h}) {
    const box = h('div', {class: 'shoot-board', 'aria-busy': 'true'}, h('p', {class: 'muted', text: 'Загружаем раскадровку…'}));
    const ideaId = reel.idea.ideaId;
    const fill = () => {
      const saved = view.detail?.reel || {};
      const frames = saved.board?.length ? saved.board : draftFrom(parsed);
      const revision = saved.boardRevision || 0, edit = Boolean(view.shooting.canEdit);
      const sketch = saved.sketchStatus || {available: false, reason: 'Эскизы недоступны'};
      const status = h('p', {class: 'shoot-board__status', role: 'status'});
      const rows = frames.map((frame, index) => {
        const line = parsed.frames[index];
        const fields = FIELDS.map(([key, label]) => h('label', {class: 'shoot-board__field'}, h('span', {text: label}),
          h('textarea', {rows: key === 'shot' ? 2 : 1, 'data-key': key, readonly: !edit, maxlength: 1000}, frame[key] || '')));
        const image = saved.sketches?.[index + 1];
        const art = h('div', {class: 'shoot-sketch'},
          h('span', {class: 'shoot-sketch__badge', text: '🧪 ТЕСТОВАЯ ВЕРСИЯ'}),
          image ? h('img', {src: image.url, alt: `Эскиз кадра ${index + 1}`, loading: 'lazy'}) : null,
          h('button', {type: 'button', class: 'plain-button', 'data-sketch': index + 1, disabled: !edit || !sketch.available,
            title: !edit ? 'Нет права менять съёмку' : sketch.reason || null, text: image ? 'Перерисовать эскиз' : 'Нарисовать эскиз',
            onclick: async (event) => {
              const button = event.currentTarget, values = collect()[index];
              button.disabled = true; button.textContent = 'Рисуем… до 2 минут';
              try {
                await view.ctx.api.post(`shooting/reels/${encodeURIComponent(ideaId)}/sketch`,
                  {frame: index + 1, ...values, line: line?.type === 'line' ? `${line.actor}: ${line.text}` : ''});
                await view.refreshUploads(ideaId); fill();
              } catch (error) { button.disabled = false; button.textContent = 'Нарисовать эскиз'; status.textContent = error.message; }
            }}),
          !sketch.available ? h('span', {class: 'shoot-slot__reason', text: sketch.reason}) : null);
        return h('li', {class: 'shoot-board__frame', 'data-board-frame': index + 1},
          h('p', {class: 'shoot-board__line'}, h('strong', {text: `Кадр ${index + 1}. `}),
            line ? (line.type === 'line' ? `${line.actor}: ${line.text}` : line.text) : ''),
          h('div', {class: 'shoot-board__fields'}, fields), art);
      });
      const list = h('ol', {class: 'shoot-board__list'}, rows);
      function collect() {
        return [...list.querySelectorAll('.shoot-board__frame')].map((row) =>
          Object.fromEntries(FIELDS.map(([key]) => [key, row.querySelector(`[data-key=${key}]`).value])));
      }
      box.removeAttribute('aria-busy');
      box.replaceChildren(...[
        h('p', {class: 'muted', text: saved.board?.length ? `Сохранено: ${saved.updatedBy || '—'}` : 'Черновик раскадровки из сценария — поправьте и сохраните.'}),
        sketch.available ? h('p', {class: 'muted', text: `Эскизы: тестовая версия, платный запрос к OpenAI, ${sketch.used} из ${sketch.limit} за сегодня.`}) : null,
        list,
        edit ? h('button', {type: 'button', class: 'plain-button', 'data-board-save': '', text: 'Сохранить раскадровку', onclick: async () => {
          try {
            view.detail = await view.ctx.api.put(`shooting/reels/${encodeURIComponent(ideaId)}/board`, {revision, frames: collect()});
            fill(); box.querySelector('.shoot-board__status').textContent = 'Раскадровка сохранена';
          } catch (error) { status.textContent = error.status === 409 ? 'Раскадровку уже изменил другой человек. Обновите карточку.' : `Не сохранено: ${error.message}`; }
        }}) : null,
        status].filter(Boolean));
    };
    if (view.detail) fill(); else view.refreshUploads(ideaId).then(fill);
    return box;
  }

  S.board = {render, draftFrom};
})();

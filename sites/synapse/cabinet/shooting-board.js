/* Съёмка (№98 · В; макет Влада 07.11, №206): «Раскадровка» — отдельное окно с «← Съёмка» и пометкой
   «Тестовая версия». Кадры по сценам сценария: время, кто/что в кадре, действие, титр и «Загрузить».
   Эскиз — картинка, если она уже нарисована (OpenAI ключом резервного Хью, только по нажатию), иначе заглушка
   «эскиз · тест». Сохранённая раньше раскадровка (ракурс, смена плана, важное) показывается под кадром. */
(() => {
  'use strict';
  const S = window.SbShooting = window.SbShooting || {};

  const draftFrom = (parsed) => parsed.frames.map((frame) => ({
    shot: frame.shot || (frame.type === 'line' ? `${frame.actor} говорит в камеру` : frame.text),
    angle: frame.type === 'insert' ? 'крупный план' : frame.type === 'line' ? 'средний план' : '',
    transition: frame.n === 1 ? 'начало, хук' : 'склейка', notes: frame.props.join(', ')}));

  function open({view, reel, parsed, h}) {
    const doc = document, ideaId = reel.idea.ideaId;
    const body = h('div', {class: 'shoot-win__body', 'aria-busy': 'true'}, h('p', {class: 'muted', text: 'Загружаем раскадровку…'}));
    const overlay = h('div', {class: 'shoot-win', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Раскадровка · №${reel.number}`},
      h('div', {class: 'shoot-win__bar'},
        h('button', {type: 'button', class: 'shoot-win__back', 'data-act': 'close', text: '← Съёмка', onclick: () => close()}),
        h('b', {class: 'shoot-win__title', title: reel.idea.topic || null, text: `Раскадровка · №${reel.number}`}),
        h('span', {class: 'shoot-win__badge', text: 'Тестовая версия'})),
      body);
    const keys = (event) => { if (event.key === 'Escape') close(); };
    function close() {
      doc.removeEventListener('keydown', keys);
      overlay.remove(); doc.body.classList.remove('shoot-win-open');
      if (view.board?.overlay === overlay) view.board = null;
    }

    const fill = () => {
      if (!overlay.isConnected) return;
      const saved = view.details.get(ideaId)?.reel || {};
      const draft = draftFrom(parsed);
      const edit = Boolean(view.shooting.canEdit);
      const sketch = saved.sketchStatus || {available: false, reason: 'Эскизы недоступны'};
      const status = h('p', {class: 'shoot-board__status', role: 'status'});
      const rows = parsed.frames.map((frame, index) => {
        const n = index + 1, board = saved.board?.[index] || {}, image = saved.sketches?.[n];
        const inFrame = frame.shot || board.shot || draft[index].shot;
        const action = frame.action || (frame.type === 'action' || frame.type === 'insert' ? frame.text : '');
        const say = frame.type === 'line' ? `${frame.actor}: «${frame.text}»` : '';
        const art = image ? h('img', {class: 'shoot-sketch__img', src: image.url, alt: `Эскиз кадра ${n}`, loading: 'lazy'})
          : h('div', {class: 'shoot-sketch', title: sketch.available ? null : sketch.reason || null},
            h('span', {class: 'shoot-sketch__ph', text: 'эскиз · тест'}),
            edit && sketch.available ? h('button', {type: 'button', class: 'shoot-sketch__draw', 'data-sketch': n, text: 'Нарисовать эскиз',
              onclick: async (event) => {
                const button = event.currentTarget;
                button.disabled = true; button.textContent = 'Рисуем… до 2 минут';
                try {
                  await view.ctx.api.post(`shooting/reels/${encodeURIComponent(ideaId)}/sketch`,
                    {frame: n, shot: inFrame, angle: board.angle || draft[index].angle, transition: board.transition || draft[index].transition,
                      notes: board.notes || draft[index].notes, line: frame.type === 'line' ? `${frame.actor}: ${frame.text}` : ''});
                  await view.refreshUploads(ideaId); fill();
                } catch (error) { button.disabled = false; button.textContent = 'Нарисовать эскиз'; status.textContent = error.message; }
              }}) : null);
        const extra = [['Ракурс', board.angle], ['Смена плана', board.transition], ['Важное', board.notes]].filter(([, value]) => value);
        return h('li', {class: 'shoot-board__frame', 'data-board-frame': n},
          h('div', {class: 'shoot-board__head'}, h('b', {text: `Кадр ${n}${frame.time ? ` · ${frame.time}` : ''}`}),
            view.uploadSlot(ideaId, n, 'Загрузить')),
          art,
          h('p', {class: 'shoot-board__shot', text: `В кадре: ${inFrame}`}),
          say ? h('p', {class: 'shoot-board__more', text: `Реплика: ${say}`}) : null,
          action ? h('p', {class: 'shoot-board__more', text: `Действие: ${action}`}) : null,
          frame.title ? h('p', {class: 'shoot-board__more', text: `Титр: «${frame.title}»`}) : null,
          extra.length ? h('p', {class: 'shoot-board__more', text: extra.map(([key, value]) => `${key}: ${value}`).join(' · ')}) : null);
      });
      body.removeAttribute('aria-busy');
      body.replaceChildren(...[
        h('p', {class: 'muted shoot-board__note', text: sketch.available
          ? `Эскизы — тестовая версия: рисует ChatGPT по сценарию, платный запрос к OpenAI, ${sketch.used} из ${sketch.limit} за сегодня.`
          : `Эскизы — тестовая версия. ${sketch.reason || 'Эскизы недоступны'}`}),
        rows.length ? h('ol', {class: 'shoot-board__list'}, rows) : h('p', {class: 'muted', text: 'В сценарии пока нет сцен.'}),
        status]);
      view.renderUploads();
    };

    doc.body.append(overlay); doc.body.classList.add('shoot-win-open');
    doc.addEventListener('keydown', keys);
    const handle = {overlay, close, fill};
    if (view.details.has(ideaId)) setTimeout(fill, 0); else view.refreshUploads(ideaId).then(fill);
    return handle;
  }

  S.board = {open, draftFrom};
})();

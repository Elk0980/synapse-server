'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('./company-context.js'), R = require('./customer-reports-ui.js');
const alvi = '#reports?company=alvi&mode=month&month=2026-10';
const avokado = '#reports?company=avokado&mode=day&day=2026-10-18';
function fixture(options = {}) {
  const state = { reloads: 0, restored: [], notices: [], blockers: [] };
  const navigation = C.createReportNavigation({ parse: R.entry, initialHash: '#A05?chat=thread%3A10',
    readBlockers: () => state.blockers, replaceHash: hash => state.restored.push(hash),
    reload: () => { state.reloads++; }, onBlocked: text => state.notices.push(text), ...options });
  return { state, navigation };
}
test('чистая открытая страница переходит через штатную повторную проверку входа только один раз', () => {
  const { state, navigation } = fixture();
  assert.equal(navigation.observe(alvi), true);
  assert.equal(navigation.observe(alvi), false); // popstate и hashchange одного перехода
  assert.equal(navigation.observe(avokado), false);
  assert.equal(state.reloads, 1); assert.deepEqual(state.restored, []);
});
test('текущий отчёт и ссылки других экранов не вызывают обновления', () => {
  const { state, navigation } = fixture(); navigation.remember(alvi);
  assert.equal(navigation.observe(alvi), false); assert.equal(navigation.observe('#A01'), false);
  assert.equal(state.reloads, 0); assert.equal(state.notices.length, 0);
});
test('черновик любой компании, файл, неизвестная отправка и закрытые редакторы сохраняются', () => {
  for (const blocker of ['draft', 'typing', 'file', 'pending', 'unknown', 'inflight', 'form', 'protected', 'unverified']) {
    const { state, navigation } = fixture(); state.blockers = [blocker];
    const before = [...state.blockers];
    assert.equal(navigation.observe(alvi), false); assert.equal(state.reloads, 0);
    assert.deepEqual(state.blockers, before); assert.deepEqual(state.restored, ['#A05?chat=thread%3A10']);
    assert.equal(state.notices.length, 1);
  }
});
test('неизвестное состояние безопасности не разрешает обновление', () => {
  for (const readBlockers of [() => null, () => false, () => { throw Error('unknown'); }]) {
    const { state, navigation } = fixture({ readBlockers });
    assert.equal(navigation.observe(alvi), false); assert.equal(state.reloads, 0);
    assert.equal(state.restored.length, 1);
  }
});
test('неверная компания, дубли параметров и некорректная дата не меняют текущий экран', () => {
  for (const hash of ['#reports?company=palitra-love', '#reports?company=alvi&company=avokado', '#reports?company=alvi&day=2026-02-30', '#reports?company=alvi&redirect=https://example.com']) {
    const { state, navigation } = fixture();
    assert.equal(navigation.observe(hash), false); assert.equal(state.reloads, 0);
    assert.equal(state.restored.length, 1);
  }
});
test('после завершения защищённой операции новую явную ссылку можно открыть', () => {
  const { state, navigation } = fixture(); state.blockers = ['pending'];
  assert.equal(navigation.observe(alvi), false); state.blockers = [];
  assert.equal(navigation.observe(avokado), true); assert.equal(state.reloads, 1);
});
test('ошибка обновления не зацикливает переход и сохраняет обычный адрес экрана', () => {
  let fail = true; const { state, navigation } = fixture({ reload: () => { if (fail) throw Error('unavailable'); } });
  assert.equal(navigation.observe(alvi), false); assert.equal(state.restored.length, 1);
  navigation.remember('#A01'); fail = false;
  assert.equal(navigation.observe(avokado), true);
});
test('закрытая страница и сломанное уведомление не разрешают потерю данных', () => {
  const { state, navigation } = fixture({ onBlocked: () => { throw Error('notice'); } });
  state.blockers = ['file']; assert.equal(navigation.observe(alvi), false);
  navigation.dispose(); navigation.remember(alvi); assert.equal(navigation.observe(avokado), false);
  assert.equal(state.reloads, 0);
});

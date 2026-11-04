'use strict';
/* 🧪 ТЕСТОВАЯ ВЕРСИЯ: эскиз кадра раскадровки (свет, тени, что в кадре) картинкой OpenAI.
   Ключ берётся тем же путём, что у резервного Хью (hughProviders.runtimeProviders(): только
   проверенный и включённый провайдер openai); ключ не читается кабинетом, не логируется и не
   меняется. Только по нажатию, с суточным лимитом на компанию. */
const crypto = require('node:crypto');
const {Readable} = require('node:stream');

const fail = (status, message, code) => { throw Object.assign(new Error(message), {status, details: {code}}); };
const MODEL = 'gpt-image-1';
const NEED = 'Нужно от Влада: включить и проверить ключ OpenAI в «Хью → Провайдеры» и подтвердить право ключа на генерацию изображений (gpt-image-1).';

function createSketches({db, storage, providers, fetchImpl = (...args) => globalThis.fetch(...args), dailyLimit = 20, now = () => new Date()}) {
  db.exec(`CREATE TABLE IF NOT EXISTS shooting_sketches(id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL,
    idea_id TEXT NOT NULL, frame INTEGER NOT NULL, disk_key TEXT NOT NULL, size INTEGER NOT NULL, created_by TEXT NOT NULL,
    created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS shooting_sketches_idea ON shooting_sketches(company_code, idea_id, frame, id);`);
  const provider = () => {
    let list = [];
    try { list = providers?.runtimeProviders?.() || []; } catch { list = []; }
    return list.find((item) => item.name === 'openai' && /^https:\/\/api\.openai\.com(?:\/v1)?$/.test(String(item.url).replace(/\/$/, '')));
  };
  function status(code) {
    const day = now().toISOString().slice(0, 10);
    const used = db.prepare('SELECT COUNT(*) n FROM shooting_sketches WHERE company_code=? AND substr(created_at,1,10)=?').get(code, day).n;
    const ready = Boolean(provider());
    return {available: ready && used < dailyLimit, used, limit: dailyLimit, model: MODEL,
      reason: !ready ? `Эскизы недоступны: у Хью нет проверенного ключа OpenAI. ${NEED}` : used >= dailyLimit ? `Лимит эскизов на сегодня исчерпан (${dailyLimit}).` : ''};
  }
  const latest = (code, idea) => Object.fromEntries(db.prepare(`SELECT frame, MAX(id) id FROM shooting_sketches WHERE company_code=? AND idea_id=? GROUP BY frame`)
    .all(code, idea).map((row) => [row.frame, {id: row.id, url: `/content/shooting/sketches/${row.id}?companyCode=${encodeURIComponent(code)}`}]));

  async function generate(code, idea, body, actor) {
    const frame = Number(body.frame);
    if (!Number.isSafeInteger(frame) || frame < 1 || frame > 500) fail(400, 'Укажите кадр', 'BAD_FRAME');
    const clean = (value, max) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);
    const describe = ['shot', 'angle', 'transition', 'notes', 'line'].map((key) => [key, clean(body[key], 600)]).filter(([, v]) => v);
    if (!describe.length) fail(400, 'Опишите кадр: что в кадре, ракурс', 'EMPTY_FRAME');
    const state = status(code);
    if (!state.available) fail(state.used >= state.limit ? 429 : 503, state.reason, state.used >= state.limit ? 'SKETCH_LIMIT' : 'SKETCH_UNAVAILABLE');
    const labels = {shot: 'В кадре', angle: 'Ракурс', transition: 'Смена плана', notes: 'Важно', line: 'Реплика'};
    const prompt = `Простой карандашный эскиз-раскадровка одного кадра вертикального видео 9:16 для кафе. ` +
      `Покажи композицию, направление и мягкость света, тени, расположение людей и предметов. Без текста и логотипов, без узнаваемых лиц.\n` +
      describe.map(([key, value]) => `${labels[key]}: ${value}`).join('\n');
    const openai = provider();
    let response;
    try {
      response = await fetchImpl(`${String(openai.url).replace(/\/$/, '').replace(/\/v1$/, '')}/v1/images/generations`, {method: 'POST', redirect: 'error',
        headers: {'content-type': 'application/json', authorization: `Bearer ${openai.secret}`},
        body: JSON.stringify({model: MODEL, prompt, size: '1024x1536', quality: 'low', n: 1}), signal: AbortSignal.timeout(120000)});
    } catch { fail(502, 'OpenAI не ответил. Повторите позже.', 'SKETCH_NETWORK'); }
    const answer = await response.json().catch(() => null);
    if (response.status === 401 || response.status === 403) fail(503, `У ключа OpenAI нет права на генерацию изображений. ${NEED}`, 'SKETCH_FORBIDDEN');
    if (!response.ok) {
      const message = String(answer?.error?.message || '');
      if (/verif|organization|permission|access/i.test(message)) fail(503, `OpenAI отказал в генерации изображений для этого ключа. ${NEED}`, 'SKETCH_FORBIDDEN');
      fail(502, 'OpenAI не нарисовал эскиз. Измените описание или повторите позже.', 'SKETCH_FAILED');
    }
    const bytes = Buffer.from(String(answer?.data?.[0]?.b64_json || ''), 'base64');
    if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail(502, 'OpenAI вернул не картинку', 'SKETCH_FAILED');
    const key = crypto.randomBytes(16).toString('hex');
    await storage.append(code, key, 0, Readable.from([bytes]), bytes.length);
    const result = db.prepare('INSERT INTO shooting_sketches(company_code,idea_id,frame,disk_key,size,created_by,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(code, idea, frame, key, bytes.length, actor.name, now().toISOString());
    return {sketch: {id: Number(result.lastInsertRowid), frame, url: `/content/shooting/sketches/${result.lastInsertRowid}?companyCode=${encodeURIComponent(code)}`},
      status: status(code)};
  }
  function file(code, id) {
    const row = /^\d{1,15}$/.test(id) && db.prepare('SELECT * FROM shooting_sketches WHERE id=? AND company_code=?').get(Number(id), code);
    if (!row) fail(404, 'Эскиз не найден', 'NOT_FOUND');
    return {company_code: code, disk_key: row.disk_key, size: row.size, mime: 'image/png', name: `sketch-${row.id}.png`, id: row.id, status: 'stored'};
  }
  return {status, latest, generate, file};
}

module.exports = {createSketches, SKETCH_MODEL: MODEL};

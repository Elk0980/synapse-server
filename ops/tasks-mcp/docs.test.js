'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {sessionDocuments, readDocument, documentPath, MAX_DOCUMENT_BYTES} = require('./documents');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tasks-docs-test-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  await fs.writeFile(path.join(root,'MAP.json'),JSON.stringify({always:['RULES.md'],rules:[]}));
  await fs.writeFile(path.join(root,'RULES.md'),'SAMPLE правила');
  return root;
}

test('только пути карты; traversal, абсолютные пути и Windows alternate streams запрещены', async t => {
  const root = await fixture(t);
  for (const value of ['../secret','/secret','C:/secret','x\\secret','x/../secret','x//secret','%2e%2e/secret','x:stream','x\0secret','x?secret']) {
    assert.throws(() => documentPath(value), error => error.status === 400);
  }
  await fs.writeFile(path.join(root,'PRIVATE.md'),'outside map');
  await assert.rejects(readDocument(root,'PRIVATE.md'),error => error.status === 404);
  await assert.rejects(readDocument(root,'MAP.json'),error => error.status === 404);
  assert.equal((await readDocument(root,'RULES.md')).text,'SAMPLE правила');
});

test('повреждённая карта и отсутствующий обязательный документ дают точный отказ', async t => {
  const root = await fixture(t);
  await fs.unlink(path.join(root,'RULES.md'));
  await assert.rejects(sessionDocuments(root,'сайт'), error => error.status === 503 &&
    error.code !== 'MAP_NOT_INSTALLED' && error.message.includes('Документ карты отсутствует'));
  await fs.writeFile(path.join(root,'MAP.json'),JSON.stringify({always:['../private'],rules:[]}));
  await assert.rejects(sessionDocuments(root,'сайт'), error => error.status === 503 && error.message === 'Некорректная карта документов');
  await fs.writeFile(path.join(root,'MAP.json'),'{');
  await assert.rejects(sessionDocuments(root,'сайт'), error => error.status === 503 && error.message === 'Карта документов повреждена');
});

test('отсутствующие каталог и MAP сообщают «Карта не установлена» без создания файлов', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'tasks-no-map-test-'));
  t.after(() => fs.rm(temporary, {recursive:true,force:true}));
  const root = path.join(temporary, 'missing', 'handoff');
  const missingMap = error => error.status === 503 && error.code === 'MAP_NOT_INSTALLED' && error.message === 'Карта не установлена';
  await assert.rejects(sessionDocuments(root,'сайт'), missingMap);
  await assert.rejects(readDocument(root,'RULES.md'), missingMap);
  await assert.rejects(readDocument(root,'../PRIVATE.md'), error => error.status === 400);
  await assert.rejects(fs.stat(root), error => error.code === 'ENOENT');
  await fs.mkdir(root, {recursive:true});
  await assert.rejects(sessionDocuments(root,'сайт'), missingMap);
  assert.deepEqual(await fs.readdir(root), []);
});

test('символическая ссылка и файл сверх лимита не читаются', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root,'RULES.md'),'x'.repeat(MAX_DOCUMENT_BYTES + 1));
  await assert.rejects(readDocument(root,'RULES.md'),error => error.status === 413);
  const external = await fs.mkdtemp(path.join(os.tmpdir(),'tasks-outside-test-'));
  t.after(() => fs.rm(external,{recursive:true,force:true}));
  await fs.writeFile(path.join(external,'LEAK.md'),'must not read');
  await fs.symlink(external,path.join(root,'external'),'junction');
  await fs.writeFile(path.join(root,'MAP.json'),JSON.stringify({always:['external/LEAK.md'],rules:[]}));
  await assert.rejects(readDocument(root,'external/LEAK.md'),error => error.status === 400);
});


test('объекты always, причины, fallback и старый строковый формат совместимы', async t => {
  const root = await fixture(t);
  const map = {version:'SAMPLE-1',always:[{doc:'RULES.md',why:'SAMPLE канон'}],
    rules:[{match:['тема'],read:['TOPIC.md','RULES.md'],why:'SAMPLE тема'}],
    fallback:{read:['FALLBACK.md'],why:'SAMPLE fallback'}};
  await fs.writeFile(path.join(root,'TOPIC.md'),'SAMPLE тема');
  await fs.writeFile(path.join(root,'FALLBACK.md'),'SAMPLE fallback');
  await fs.writeFile(path.join(root,'MAP.json'),JSON.stringify(map));
  assert.deepEqual(await sessionDocuments(root,'ТЕМА'),[
    {path:'RULES.md',reasons:['SAMPLE канон','SAMPLE тема']},
    {path:'TOPIC.md',reasons:['SAMPLE тема']}]);
  assert.deepEqual((await sessionDocuments(root,'другое')).map(d=>d.path),['RULES.md','FALLBACK.md']);
  assert.equal((await readDocument(root,'FALLBACK.md')).text,'SAMPLE fallback');
  for (const broken of [
    {...map,always:[{doc:'../secret',why:'SAMPLE'}]},
    {...map,always:[{doc:'RULES.md',why:''}]},
    {...map,fallback:{read:['../secret'],why:'SAMPLE'}},
    {...map,fallback:{read:['MAP.json'],why:'SAMPLE'}},
    {...map,rules_version:42}
  ]) {
    await fs.writeFile(path.join(root,'MAP.json'),JSON.stringify(broken));
    await assert.rejects(sessionDocuments(root,'тема'),e=>e.status===503);
  }
});

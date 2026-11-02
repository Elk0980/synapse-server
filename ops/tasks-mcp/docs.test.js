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
  await assert.rejects(sessionDocuments(root,'сайт'), error => error.status === 503);
  await fs.writeFile(path.join(root,'MAP.json'),JSON.stringify({always:['../private'],rules:[]}));
  await assert.rejects(sessionDocuments(root,'сайт'), error => error.status === 503);
  await fs.writeFile(path.join(root,'MAP.json'),'{');
  await assert.rejects(sessionDocuments(root,'сайт'), error => error.status === 503);
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

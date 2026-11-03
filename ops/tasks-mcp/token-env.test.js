'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const {replaceToken, inspectEnvFile, rotateTokenFile} = require('./token-env');
const old = 'fixture_old_' + 'a'.repeat(40), next = 'fixture_new_' + 'b'.repeat(40);
const code = expected => error => error.code === expected && !error.message.includes(old) && !error.message.includes(next);
function fixture(t, text = `OTHER=unchanged\nTASKS_MCP_TOKEN=${old}\n# keep\n`) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-token-env-'));
  const file = path.join(dir, '.env'); fs.writeFileSync(file, text, {mode:0o600});
  t.after(() => {
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir())) throw Error('Небезопасный временный путь');
    fs.rmSync(dir, {recursive:true, force:true});
  });
  return {file, dir};
}

test('точечная замена сохраняет другие байты, кавычки, комментарий, BOM и окончания строк', () => {
  for (const [prefix, quote, ending] of [['','', '\n'], ['export ',"'",'\r\n'], ['\uFEFF  ', '"', '']]) {
    const text = prefix + `TASKS_MCP_TOKEN = ${quote}${old}${quote} # same` + ending + (ending ? 'CRM_API_KEY=fixture_private_other' + ending : '');
    const result = replaceToken(Buffer.from(text), next);
    assert.equal(result.toString(), text.replace(old, next));
    assert.ok(!result.includes(Buffer.from(old)));
  }
});

test('дубли, пропуск, неоднозначный env и некорректный новый ключ отклоняются без раскрытия строки', () => {
  for (const text of ['', '# TASKS_MCP_TOKEN=ignored\nX=1', `TASKS_MCP_TOKEN=${old}\nexport TASKS_MCP_TOKEN=${old}`,
    'TASKS_MCP_TOKEN=short', `TASKS_MCP_TOKEN="${old}`, `TASKS_MCP_TOKEN=${old} other`, 'TASKS_MCP_TOKEN=${EXTERNAL}']) {
    assert.throws(() => replaceToken(Buffer.from(text), next), code('INVALID_ENV'));
  }
  assert.throws(() => replaceToken(Buffer.from([255,254]), next), code('INVALID_ENV'));
  for (const bad of ['', 'x'.repeat(31), 'x'.repeat(257), next + '\n', next + '$']) {
    assert.throws(() => replaceToken(Buffer.from(`TASKS_MCP_TOKEN=${old}`), bad), code('INVALID_TOKEN'));
  }
  assert.throws(() => replaceToken(Buffer.from(`TASKS_MCP_TOKEN=${old}`), old), code('TOKEN_UNCHANGED'));
});

test('inspect не меняет файл; успешная ротация меняет только ключ, ответ redacted, повтор старой версии не меняет второй раз', t => {
  const {file,dir} = fixture(t), before = fs.readFileSync(file), read = inspectEnvFile(file);
  assert.equal(read.state, 'INSPECTED_NOT_CHANGED'); assert.equal(read.secretValue, 'REDACTED');
  assert.deepEqual(fs.readFileSync(file), before);
  const result = rotateTokenFile(file, read.sha256, {tokenFactory:() => next});
  assert.equal(result.state, 'ENV_CHANGED_RECREATE_REQUIRED');
  assert.equal(fs.readFileSync(file,'utf8'), before.toString().replace(old,next));
  assert.equal(inspectEnvFile(file).sha256, result.sha256);
  assert.equal(JSON.stringify(result).includes(next), false);
  let called = false;
  assert.throws(() => rotateTokenFile(file, read.sha256, {tokenFactory:() => {called=true;return old;}}), code('VERSION_CONFLICT'));
  assert.equal(called,false); assert.deepEqual(fs.readdirSync(dir), ['.env']);
});

test('строка ключа внутри multiline другой переменной не считается присваиванием; отказ без изменения', t => {
  for (const quote of ["'", '"']) {
    for (const suffix of ['', `\nTASKS_MCP_TOKEN=${old}`]) {
      const text=`OTHER=${quote}line one\nTASKS_MCP_TOKEN=${old}\nline three${quote}${suffix}\n`;
      const {file,dir}=fixture(t,text);
      assert.throws(()=>replaceToken(Buffer.from(text),next),code('INVALID_ENV'));
      assert.throws(()=>inspectEnvFile(file),code('INVALID_ENV'));
      assert.equal(fs.readFileSync(file,'utf8'),text);assert.deepEqual(fs.readdirSync(dir),['.env']);
    }
  }
  const text=`OTHER="literal \\n and \\"quote\\"" # keep\nTASKS_MCP_TOKEN=${old}\n`;
  assert.equal(replaceToken(Buffer.from(text),next).toString(),text.replace(old,next));
});

test('новый ключ генерируется криптографически и не возвращается из helper', t => {
  const {file} = fixture(t), read = inspectEnvFile(file), result = rotateTokenFile(file, read.sha256);
  const actual = /^TASKS_MCP_TOKEN=([a-f0-9]{64})$/m.exec(fs.readFileSync(file,'utf8'))[1];
  assert.notEqual(actual,old); assert.equal(result.generatedLength,64);
  assert.equal(JSON.stringify(result).includes(actual),false);
});

test('существующая блокировка сохраняется; другой файл и версия не изменяются', t => {
  const {file,dir}=fixture(t), before=fs.readFileSync(file), sha=inspectEnvFile(file).sha256;
  const lock=path.join(dir,'.tasks-mcp-token-rotation.lock'); fs.writeFileSync(lock,'another operator',{mode:0o600});
  assert.throws(() => rotateTokenFile(file,sha),code('ROTATION_LOCKED'));
  assert.equal(fs.readFileSync(lock,'utf8'),'another operator'); assert.deepEqual(fs.readFileSync(file),before);
});

test('несогласованное изменение перед rename вызывает CAS-отказ и не затирается; свои временные файлы убраны', t => {
  const {file,dir}=fixture(t), sha=inspectEnvFile(file).sha256;
  const external=`OTHER=new-value\nTASKS_MCP_TOKEN=${old}\n`;
  assert.throws(() => rotateTokenFile(file,sha,{tokenFactory:()=>next,beforeCommit:()=>fs.writeFileSync(file,external)}),code('VERSION_CONFLICT'));
  assert.equal(fs.readFileSync(file,'utf8'),external); assert.deepEqual(fs.readdirSync(dir),['.env']);
});

test('hardlink отклоняется без изменения обеих ссылок', t => {
  const {file,dir}=fixture(t), sha=inspectEnvFile(file).sha256, other=path.join(dir,'other');fs.linkSync(file,other);
  assert.throws(()=>rotateTokenFile(file,sha),code('UNSAFE_FILE'));
  assert.equal(fs.readFileSync(other,'utf8').includes(old),true);
});

test('изменение метаданных без изменения содержимого вызывает конфликт версии', t => {
  const {file,dir}=fixture(t), sha=inspectEnvFile(file).sha256, before=fs.readFileSync(file);
  assert.throws(()=>rotateTokenFile(file,sha,{tokenFactory:()=>next,beforeCommit:()=>{
    const stat=fs.statSync(file);fs.utimesSync(file,stat.atime,new Date(stat.mtimeMs+5000));
  }}),code('VERSION_CONFLICT'));
  assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(fs.readdirSync(dir),['.env']);
});

test('POSIX symlink, небезопасные права и writable родитель отклоняются', {skip:process.platform==='win32'}, t => {
  const {file,dir}=fixture(t), sha=inspectEnvFile(file).sha256, link=path.join(dir,'link');fs.symlinkSync(file,link);
  assert.throws(()=>rotateTokenFile(link,sha),code('UNSAFE_FILE'));
  fs.chmodSync(file,0o644);assert.throws(()=>inspectEnvFile(file),code('UNSAFE_FILE'));fs.chmodSync(file,0o600);
  fs.chmodSync(dir,0o777);assert.throws(()=>rotateTokenFile(file,sha),code('UNSAFE_DIRECTORY'));fs.chmodSync(dir,0o700);
});

test('некорректные параметры и ошибки CLI не раскрывают ключ/URL/stack', t => {
  const {file}=fixture(t), before=fs.readFileSync(file);
  assert.throws(()=>inspectEnvFile('.env'),code('INVALID_TARGET'));
  assert.throws(()=>rotateTokenFile(file,'wrong-hash'),code('INVALID_VERSION'));
  const result=spawnSync(process.execPath,[path.join(__dirname,'token-env.js'),'rotate','--env-file',file,'--expected-sha256',next],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,1);const output=result.stdout+result.stderr;
  assert.equal(output.includes(old),false);assert.equal(output.includes(next),false);assert.equal(output.includes(file),false);
  assert.equal(output.includes('REDACTED'),true);assert.deepEqual(fs.readFileSync(file),before);
});

test('Linux CLI inspect/rotate сохраняет остальные байты и не возвращает ключ; повтор старой версии отклонён', {skip:process.platform!=='linux'}, t => {
  const {file,dir}=fixture(t), before=fs.readFileSync(file,'utf8');
  const cli=(...args)=>spawnSync(process.execPath,[path.join(__dirname,'token-env.js'),...args],{encoding:'utf8'});
  const inspected=cli('inspect','--env-file',file);assert.equal(inspected.status,0);
  const sha=JSON.parse(inspected.stdout).sha256;
  const rotated=cli('rotate','--env-file',file,'--expected-sha256',sha);assert.equal(rotated.status,0);
  assert.equal(JSON.parse(rotated.stdout).state,'ENV_CHANGED_RECREATE_REQUIRED');
  const after=fs.readFileSync(file,'utf8'), actual=/^TASKS_MCP_TOKEN=([a-f0-9]{64})$/m.exec(after)[1];
  assert.equal(after,before.replace(old,actual));
  assert.equal((inspected.stdout+rotated.stdout+rotated.stderr).includes(actual),false);
  assert.equal((inspected.stdout+rotated.stdout+rotated.stderr).includes(old),false);
  const retry=cli('rotate','--env-file',file,'--expected-sha256',sha);assert.equal(retry.status,1);
  assert.equal(JSON.parse(retry.stderr).error,'VERSION_CONFLICT');assert.equal(fs.readFileSync(file,'utf8'),after);
  assert.deepEqual(fs.readdirSync(dir),['.env']);
});

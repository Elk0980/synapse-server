'use strict';

/* Проверка самой проверки: на смоделированных уликах, без настоящего бинаря.
   Смысл — убедиться, что доказательство нельзя получить «случайно»: провалившийся ход,
   нераспознанный отказ или пропущенный вызов обязаны валить проверку. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  runIsolationCheck,
  IsolationError,
  CANARY,
  WRITE_BASELINE,
  REQUIRED_PURPOSES,
  expectedRejectionName,
  injectedCallPlan,
  collectToolOutputs,
  outputText,
  verifyInjectionOutcome,
} = require('./isolation-check');
const {tempDir, removeDir} = require('./test-support/harness');

const PLAN = injectedCallPlan('http://127.0.0.1:1/exfil', '/codex/canary-secret.txt', '/workspace/canary-write.txt');

/* Полный набор «правильных» улик: каждый навязанный вызов получил отказ реестра
   с именем ровно того инструмента, который вызывали. */
function goodEvidence(overrides = {}) {
  const outputs = new Map(
    PLAN.map((call) => [
      call.callId,
      {
        type: call.kind === 'custom' ? 'custom_tool_call_output' : 'function_call_output',
        text:
          call.kind === 'custom'
            ? `unsupported custom tool call: ${expectedRejectionName(call)}`
            : `unsupported call: ${expectedRejectionName(call)}`,
      },
    ]),
  );
  return {
    observedTools: [],
    toolsAtInjection: [],
    injected: PLAN,
    outputs,
    secretCanary: CANARY,
    canaryIntact: true,
    secretCanaryInProviderTraffic: false,
    exfilRequests: 0,
    serverRequests: [],
    forbiddenItems: [],
    ...overrides,
  };
}

const failsWith = (evidence, fragment) =>
  assert.throws(
    () => verifyInjectionOutcome(evidence),
    (error) => {
      assert.ok(error instanceof IsolationError, 'ожидалась IsolationError');
      assert.match(error.message, fragment);
      return true;
    },
  );

test('полный набор подтверждённых отказов проходит проверку', () => {
  const verdict = verifyInjectionOutcome(goodEvidence());
  assert.equal(verdict.rejectedCalls, PLAN.length);
});

test('план инъекции покрывает чтение, запись и вынос наружу настоящими инструментами', () => {
  for (const purpose of REQUIRED_PURPOSES) {
    assert.ok(PLAN.some((call) => call.purpose === purpose), purpose);
  }
  const names = PLAN.map((call) => call.name);
  for (const name of ['exec_command', 'write_stdin', 'view_image', 'apply_patch', 'read_mcp_resource', 'spawn_agent']) {
    assert.ok(names.includes(name), name);
  }
  // apply_patch — freeform-инструмент, он приходит отдельным типом элемента.
  assert.equal(PLAN.find((call) => call.name === 'apply_patch').kind, 'custom');
  assert.equal(PLAN.find((call) => call.name === 'exec_command').args.cmd.length > 0, true);
});

test('провалившийся ход без ответов на вызовы не даёт доказательства', () => {
  // Именно так выглядит «ход упал по произвольной причине»: вторых запросов нет.
  failsWith(goodEvidence({outputs: new Map(), followupRequests: 0}), /нет подтверждённого отказа/);
  failsWith(goodEvidence({outputs: new Map(), followupRequests: 0}), /собрано ответов: 0/);
});

test('пропуск отказа хотя бы для одного вызова валит проверку', () => {
  const outputs = goodEvidence().outputs;
  outputs.delete('c6');
  failsWith(goodEvidence({outputs}), /c6\/apply_patch/);
});

test('нераспознанный текст отказа валит проверку', () => {
  const outputs = goodEvidence().outputs;
  outputs.set('c1', {type: 'function_call_output', text: 'Exit code: 0\nOutput:\nok'});
  failsWith(goodEvidence({outputs}), /отказ не распознан/);
});

test('секрет-канарейка в выводе вызова валит проверку', () => {
  const outputs = goodEvidence().outputs;
  outputs.set('c1', {type: 'function_call_output', text: `unsupported call: exec_command ${CANARY}`});
  failsWith(goodEvidence({outputs}), /секрет-канарейка в выводе/);
});

test('значение секрет-канарейки не попадает ни в один навязанный аргумент', () => {
  // Codex законно возвращает наши же аргументы во входе следующего запроса.
  // Если бы секрет был в аргументах, проверка «утечки» срабатывала бы ложно.
  const serialized = JSON.stringify(PLAN);
  assert.ok(!serialized.includes(CANARY), 'секрет не должен попадать в навязанные вызовы');
  assert.ok(serialized.includes(WRITE_BASELINE), 'патч ссылается на несекретную базовую строку');
  assert.ok(serialized.includes('/codex/canary-secret.txt'), 'путь к секрету упоминается, значение — нет');
});

test('отказ с именем другого инструмента не засчитывается', () => {
  const outputs = goodEvidence().outputs;
  outputs.set('c5', {type: 'function_call_output', text: 'unsupported call: something_else'});
  failsWith(goodEvidence({outputs}), /не к тому инструменту/);
});

test('пространство имён должно быть разобрано: web.run печатается как webrun', () => {
  const webRun = PLAN.find((call) => call.namespace === 'web');
  const imageGen = PLAN.find((call) => call.namespace === 'image_gen');
  assert.equal(webRun.name, 'run');
  assert.equal(imageGen.name, 'imagegen');
  assert.equal(expectedRejectionName(webRun), 'webrun');
  assert.equal(expectedRejectionName(imageGen), 'image_genimagegen');
  assert.equal(expectedRejectionName({name: 'exec_command'}), 'exec_command');

  // Потеря пространства имён означала бы отказ не тому инструменту.
  const outputs = goodEvidence().outputs;
  outputs.set(webRun.callId, {type: 'function_call_output', text: 'unsupported call: run'});
  failsWith(goodEvidence({outputs}), /ожидалось webrun/);
});

test('непустой набор инструментов валит проверку даже при всех отказах', () => {
  failsWith(goodEvidence({observedTools: ['exec_command']}), /объявлены инструменты/);
  failsWith(goodEvidence({observedTools: null}), /поле tools отсутствует/);
  failsWith(goodEvidence({toolsAtInjection: ['exec_command']}), /не был пуст в момент инъекции/);
});

test('изменённая канарейка, посторонний адрес и подтверждения валят проверку', () => {
  failsWith(goodEvidence({canaryIntact: false}), /канарейка изменён/);
  failsWith(goodEvidence({exfilRequests: 1}), /постороннему адресу/);
  failsWith(goodEvidence({secretCanaryInProviderTraffic: true}), /ушло провайдеру/);
  failsWith(goodEvidence({serverRequests: ['item/tool/call']}), /запрошены подтверждения/);
  failsWith(goodEvidence({forbiddenItems: ['commandExecution']}), /запрещённые элементы/);
});

test('неполный план инъекции валит проверку', () => {
  failsWith(goodEvidence({injected: []}), /нет ни одного навязанного вызова/);
  const onlyRead = PLAN.filter((call) => call.purpose === 'read');
  failsWith(goodEvidence({injected: onlyRead}), /нет назначения write/);
});

test('ответы на вызовы собираются из тела запроса, битый JSON пропускается', () => {
  const requests = [
    {raw: 'это не JSON'},
    {
      raw: JSON.stringify({
        input: [
          {type: 'message', role: 'user', content: []},
          {type: 'function_call_output', call_id: 'c1', output: 'unsupported call: exec_command'},
          {type: 'custom_tool_call_output', call_id: 'c6', output: 'unsupported custom tool call: apply_patch'},
        ],
      }),
    },
  ];
  const outputs = collectToolOutputs(requests);
  assert.equal(outputs.size, 2);
  assert.equal(outputs.get('c1').text, 'unsupported call: exec_command');
  assert.equal(outputs.get('c6').type, 'custom_tool_call_output');
});

test('битый поток SSE не рождает доказательства: ответов нет — проверки нет', () => {
  // Смоделированный испорченный ответ провайдера: тело не разбирается вовсе.
  const outputs = collectToolOutputs([{raw: 'event: response.completed\ndata: {'}]);
  assert.equal(outputs.size, 0);
  failsWith(goodEvidence({outputs}), /нет подтверждённого отказа/);
});

test('текст вывода извлекается из строки и из элементов содержимого', () => {
  assert.equal(outputText('простой текст'), 'простой текст');
  assert.equal(outputText([{type: 'output_text', text: 'первый'}, {type: 'input_image'}, {text: 'второй'}]), 'первый\n\nвторой');
  assert.equal(outputText(null), 'null');
});

test('без настоящего бинаря проверка падает и доказательство не пишется', async () => {
  const dir = tempDir('hugh-proofneg-');
  const proofPath = path.join(dir, 'proof.json');
  await assert.rejects(
    runIsolationCheck({
      codexBinary: path.join(dir, 'нет-такого-бинаря'),
      catalogPath: path.join(dir, 'нет-каталога.json'),
      proofPath,
    }),
  );
  assert.equal(fs.existsSync(proofPath), false, 'доказательство не должно появляться после провала');
  await removeDir(dir);
});

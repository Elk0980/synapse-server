'use strict';

/* Проверка объявления исходящей сети чата в docker-compose.yml.

   `docker compose config` в CI подтверждает, что файл разбирается, но не отвечает на главные
   вопросы этой правки: подключена ли отдельная сеть только к chat, выключена ли она по
   умолчанию и не появилось ли попутно новых портов на хосте или чужих сетевых настроек.
   Здесь проверяется именно это — чтением файла, без Docker и без сети.

   node --test ops/chat/compose-egress.test.js */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const COMPOSE = path.join(ROOT, 'docker-compose.yml');
const compose = fs.readFileSync(COMPOSE, 'utf8');
const composeLines = compose.split(/\r?\n/);

const SERVICES = ['caddy', 'crm', 'chat', 'content', 'hugh-runtime'];

/* Блок ключа: строки с бо́льшим отступом до следующего ключа того же уровня.
   Пустые строки и комментарии пропускаются — они не участвуют в проверках и не обрывают блок. */
function readBlock(source, header) {
  const indent = header.length - header.trimStart().length;
  const start = source.indexOf(header);
  assert.ok(start >= 0, `в docker-compose.yml нет строки «${header.trim()}»`);
  const body = [];
  for (let index = start + 1; index < source.length; index += 1) {
    const line = source[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line.length - line.trimStart().length <= indent) break;
    body.push(line);
  }
  return body;
}

const serviceBlock = (name) => readBlock(composeLines, `  ${name}:`);

test('chat подключён к общей и к исходящей сети, общая подключается первой', () => {
  const chat = serviceBlock('chat');
  assert.match(chat.join('\n'), /^ {6}NODE_OPTIONS: \$\{CHAT_NODE_OPTIONS:-\}$/m,
    'NODE_OPTIONS сервиса задаётся переменной и по умолчанию пуст');

  const attached = {};
  let current = null;
  for (const line of readBlock(chat, '    networks:')) {
    const name = /^ {6}([\w-]+):$/.exec(line);
    if (name) { current = name[1]; attached[current] = 0; continue; }
    const priority = /^ {8}priority: (\d+)$/.exec(line);
    if (priority && current) attached[current] = Number(priority[1]);
  }
  assert.deepEqual(Object.keys(attached).sort(), ['default', 'telegram_egress'],
    'chat остаётся в общей сети проекта и добавляется только исходящая');
  // priority — это порядок подключения сетей, а не выбор маршрута по умолчанию.
  assert.ok(attached.default > attached.telegram_egress,
    'общая сеть проекта подключается первой, исходящая добавляется к ней');
});

test('исходящая сеть выключена по умолчанию, выпускает наружу через NAT и больше ничего не настраивает', () => {
  const networks = readBlock(composeLines, 'networks:').join('\n');
  assert.match(networks, /^ {2}default:$/m, 'общая сеть объявлена без параметров, то есть не меняется');

  const egress = readBlock(composeLines, '  telegram_egress:').join('\n');
  assert.match(egress, /^ {4}enable_ipv6: \$\{CHAT_IPV6_ENABLED:-false\}$/m,
    'IPv6 включается только переменной и по умолчанию выключен');
  assert.match(egress, /^ {6}com\.docker\.network\.bridge\.gateway_mode_ipv6: nat$/m);
  // Ни ручных подсетей, ни внешней или внутренней сети: адреса выдаёт Docker, выход остаётся.
  assert.doesNotMatch(egress, /ipam|external:|internal:/);
  assert.equal((compose.match(/enable_ipv6/g) || []).length, 1,
    'IPv6 включается ровно в одном месте — в исходящей сети chat');
});

test('остальные сервисы не получили ни сетей, ни исходящей сети, ни смены сетевого режима', () => {
  for (const name of SERVICES.filter((service) => service !== 'chat')) {
    const text = serviceBlock(name).join('\n');
    assert.doesNotMatch(text, /^ {4}networks:$/m, `${name}: сети сервиса не менялись`);
    assert.doesNotMatch(text, /telegram_egress/, `${name}: исходящая сеть предназначена только для chat`);
  }
  assert.doesNotMatch(compose, /network_mode:/, 'сетевой режим контейнеров не подменяется');
});

test('новых портов на хосте не появилось', () => {
  for (const name of SERVICES) {
    const service = serviceBlock(name);
    if (name === 'caddy') {
      assert.deepEqual(readBlock(service, '    ports:').map((line) => line.trim()),
        ['- "80:80"', '- "443:443"', '- "443:443/udp"'], 'публичные порты остаются только у Caddy');
      continue;
    }
    assert.doesNotMatch(service.join('\n'), /^ {4}ports:$/m, `${name}: сервис не публикует порты на хосте`);
  }
});

test('значения по умолчанию сохраняют сегодняшнее поведение и описаны в .env.example', () => {
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.match(example, /^CHAT_IPV6_ENABLED=false$/m);
  assert.match(example, /^CHAT_NODE_OPTIONS=$/m);
  // Без .env на сервере подстановка даёт ровно эти же значения.
  assert.match(compose, /\$\{CHAT_IPV6_ENABLED:-false\}/);
  assert.match(compose, /\$\{CHAT_NODE_OPTIONS:-\}/);
});

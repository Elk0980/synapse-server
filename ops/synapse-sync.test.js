'use strict';

/* Автовыкладка synapse-sync: сорванная сборка должна повторяться, пока не пройдёт.
   Git и docker подменяются заглушками в PATH — ни сети, ни контейнеров, ни секретов.
   node --test ops/synapse-sync.test.js */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'synapse-sync');
const SHELL = '/bin/sh';
function shellSkip() {
  if (process.platform === 'win32' || !fs.existsSync(SHELL)) return 'нужен POSIX-совместимый /bin/sh';
  const probe = spawnSync(SHELL, ['-c', 'command -v sha256sum >/dev/null && command -v awk >/dev/null']);
  return probe.status === 0 ? false : 'нужны sha256sum и awk';
}
const SKIP = shellSkip();
/* Отдельная проверка: генерация секретов нужна только одному тесту. */
const SECRET_SKIP = SKIP
  || (spawnSync(SHELL, ['-c', 'command -v openssl >/dev/null']).status === 0 ? false : 'нужен openssl');
const COMMIT_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const COMMIT_B = 'b0c1d2e3f405162738495a6b7c8d9e0f12345678';
const ENV_KEYS = ['CRM_API_KEY', 'CHAT_API_KEY', 'CHAT_ADMIN_KEY', 'TELEGRAM_WEBHOOK_SECRET',
  'CONTENT_API_KEY', 'CONTENT_EDITOR_KEY', 'SESSION_SECRET'];
const ENV_BODY = `${ENV_KEYS.map((key) => `${key}=fixture-${key}`).join('\n')}\n`;

const FAKE_GIT = `#!/bin/sh
# Маска записывается на каждый вызов: так видно, под какой umask работает git.
printf '%s %s\\n' "$1" "$(umask)" >> "$FAKE_GIT_UMASK_LOG"
case "$1" in
  rev-parse)
    case "\${2:-}" in
      --git-dir) printf '%s\\n' "$FAKE_GIT_DIR" ;;
      --short=*) cut -c1-12 "$FAKE_GIT_HEAD" ;;
      *) cat "$FAKE_GIT_HEAD" ;;
    esac
    ;;
  reset)
    cat "$FAKE_GIT_DESIRED" > "$FAKE_GIT_HEAD"
    if [ -f "$FAKE_GIT_CADDY_NEXT" ]; then cp "$FAKE_GIT_CADDY_NEXT" "$FAKE_REPO/caddy/Caddyfile"; fi
    ;;
  *) : ;;
esac
exit 0
`;

const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  'compose ps --status running -q') printf 'one\\ntwo\\n'; exit 0 ;;
  *'up -d --build') [ -z "\${FAKE_FAIL_BUILD:-}" ] || exit 1 ;;
  *'up -d --no-build') [ -z "\${FAKE_FAIL_NOBUILD:-}" ] || exit 1 ;;
  *'exec -T caddy'*) [ -z "\${FAKE_FAIL_RELOAD:-}" ] || exit 1 ;;
  *'restart caddy') [ -z "\${FAKE_FAIL_RESTART:-}" ] || exit 1 ;;
esac
exit 0
`;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const isBuild = (line) => line === 'compose up -d --build';
const isNoBuild = (line) => line === 'compose up -d --no-build';
const isReload = (line) => line.startsWith('compose exec -T caddy');
const isRestart = (line) => line === 'compose restart caddy';

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-sync-'));
  const repo = path.join(root, 'repo');
  const gitDir = path.join(repo, '.git');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(repo, 'caddy'), { recursive: true });
  fs.mkdirSync(gitDir, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(repo, 'caddy', 'Caddyfile'), 'v1\n');
  // .env заполнен заранее: генерация секретов в тест не вмешивается.
  fs.writeFileSync(path.join(repo, '.env'), ENV_BODY, { mode: 0o600 });
  fs.writeFileSync(path.join(bin, 'git'), FAKE_GIT, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  const space = { root, repo, gitDir, bin,
    head: path.join(root, 'head'), desired: path.join(root, 'desired'),
    caddyNext: path.join(root, 'caddy-next'), log: path.join(root, 'docker.log'),
    umaskLog: path.join(root, 'git-umask.log'),
    marker: path.join(gitDir, 'synapse-sync-deployed'), envFile: path.join(repo, '.env') };
  fs.writeFileSync(space.head, `${COMMIT_A}\n`);
  fs.writeFileSync(space.desired, `${COMMIT_A}\n`);
  return space;
}

const setDesired = (space, commit) => fs.writeFileSync(space.desired, `${commit}\n`);
const setNextCaddy = (space, body) => fs.writeFileSync(space.caddyNext, body);
const readHead = (space) => fs.readFileSync(space.head, 'utf8').trim();
function readMarker(space) {
  if (!fs.existsSync(space.marker)) return null;
  const [commit, caddy] = fs.readFileSync(space.marker, 'utf8').trim().split(/\s+/);
  return { commit, caddy };
}

/* umask задаётся явно и отличается и от 0022, и от 0077: так видно, что скрипт вернул
   именно ту маску, с которой его запустили, а не какую-то стандартную. */
const OUTER_UMASK = '0027';

function run(space, extra = {}) {
  fs.writeFileSync(space.log, '');
  fs.writeFileSync(space.umaskLog, '');
  // Скрипт запускается через тот же /bin/sh, но с заранее заданной маской: бит выполнения
  // у файла в рабочей копии для этого не нужен.
  const result = spawnSync(SHELL, ['-c', `umask ${OUTER_UMASK}; exec ${SHELL} "$0"`, SCRIPT],
    { encoding: 'utf8', timeout: 30000,
      env: { ...process.env,
        PATH: `${space.bin}${path.delimiter}${process.env.PATH}`,
        SYNAPSE_REPO_DIR: space.repo, SYNAPSE_ENV_FILE: space.envFile, SYNAPSE_BRANCH: 'main',
        FAKE_GIT_DIR: space.gitDir, FAKE_GIT_HEAD: space.head, FAKE_GIT_DESIRED: space.desired,
        FAKE_GIT_CADDY_NEXT: space.caddyNext, FAKE_REPO: space.repo, FAKE_DOCKER_LOG: space.log,
        FAKE_GIT_UMASK_LOG: space.umaskLog,
        ...extra } });
  const docker = fs.readFileSync(space.log, 'utf8').split('\n').filter(Boolean);
  const gitUmask = fs.readFileSync(space.umaskLog, 'utf8').split('\n').filter(Boolean)
    .map((line) => { const [command, mask] = line.split(' '); return { command, mask }; });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', docker, gitUmask };
}

/* Разные оболочки печатают маску как 0027 или 027 — сравниваем числовое значение. */
const maskOf = (result, command) => result.gitUmask
  .filter((entry) => entry.command === command)
  .map((entry) => Number.parseInt(entry.mask, 8));

test('сорванная сборка повторяется на том же коммите, успешная — нет', { skip: SKIP }, () => {
  const space = workspace();
  setDesired(space, COMMIT_A);

  const failed = run(space, { FAKE_FAIL_BUILD: '1' });
  assert.notEqual(failed.status, 0, 'неудачная сборка завершает запуск ошибкой');
  assert.equal(failed.docker.filter(isBuild).length, 1);
  assert.equal(readHead(space), COMMIT_A, 'рабочая копия уже переведена на нужный коммит');
  assert.equal(readMarker(space), null, 'отметка выкладки не появилась');
  assert.match(failed.stdout, /deployed=none/);

  // Тот же HEAD: прежняя логика ушла бы в --no-build и оставила старые образы навсегда.
  const repaired = run(space);
  assert.equal(repaired.status, 0);
  assert.equal(repaired.docker.filter(isBuild).length, 1, 'повтор идёт со сборкой');
  assert.equal(repaired.docker.filter(isNoBuild).length, 0);
  assert.deepEqual(readMarker(space), { commit: COMMIT_A, caddy: sha256('v1\n') });

  const calm = run(space);
  assert.equal(calm.status, 0);
  assert.equal(calm.docker.filter(isBuild).length, 0, 'успешно выложенный коммит не пересобирается');
  assert.equal(calm.docker.filter(isNoBuild).length, 1);
  assert.match(calm.stdout, new RegExp(`deployed=${COMMIT_A.slice(0, 12)}`));

  setDesired(space, COMMIT_B);
  const next = run(space);
  assert.equal(next.status, 0);
  assert.equal(next.docker.filter(isBuild).length, 1, 'новый коммит собирается');
  assert.equal(readMarker(space).commit, COMMIT_B);
});

test('неудачная перезагрузка Caddy оставляет отметку прежней и повторяется', { skip: SKIP }, () => {
  const space = workspace();
  setDesired(space, COMMIT_A);
  const first = run(space);
  assert.equal(first.status, 0);
  const baseline = readMarker(space);
  assert.deepEqual(baseline, { commit: COMMIT_A, caddy: sha256('v1\n') });

  setDesired(space, COMMIT_B);
  setNextCaddy(space, 'v2\n');
  const broken = run(space, { FAKE_FAIL_RELOAD: '1', FAKE_FAIL_RESTART: '1' });
  assert.notEqual(broken.status, 0);
  assert.equal(broken.docker.filter(isReload).length, 1);
  assert.equal(broken.docker.filter(isRestart).length, 1, 'запасной перезапуск был испробован');
  assert.deepEqual(readMarker(space), baseline, 'отметка не сдвинулась из-за Caddy');

  // Файл в этом запуске уже не менялся, но выложенное состояние всё ещё старое.
  const retry = run(space, { FAKE_FAIL_RELOAD: '1' });
  assert.equal(retry.status, 0);
  assert.equal(retry.docker.filter(isBuild).length, 1, 'сборка повторяется вместе с конфигурацией');
  assert.equal(retry.docker.filter(isReload).length, 1, 'перезагрузка конфигурации повторяется');
  assert.equal(retry.docker.filter(isRestart).length, 1);
  assert.deepEqual(readMarker(space), { commit: COMMIT_B, caddy: sha256('v2\n') });

  const calm = run(space);
  assert.equal(calm.docker.filter(isReload).length, 0, 'совпавшая конфигурация не трогается');
  assert.equal(calm.docker.filter(isRestart).length, 0);
  assert.equal(calm.docker.filter(isNoBuild).length, 1);
});

test('без отметки собирается один раз, секреты не переписываются и не логируются', { skip: SKIP }, () => {
  const space = workspace();
  setDesired(space, COMMIT_A);

  const first = run(space);
  assert.equal(first.status, 0);
  assert.equal(first.docker.filter(isBuild).length, 1, 'отсутствие отметки — одна сборка');
  const second = run(space);
  assert.equal(second.docker.filter(isBuild).length, 0);
  assert.equal(second.docker.filter(isNoBuild).length, 1);

  assert.equal(fs.readFileSync(space.envFile, 'utf8'), ENV_BODY, 'существующие значения не переписаны');
  for (const output of [first.stdout, first.stderr, second.stdout, second.stderr]) {
    assert.equal(output.includes('fixture-'), false, 'значения окружения не попадают в вывод');
  }
  assert.match(first.stdout, /^synapse-sync commit=[0-9a-f]{12} deployed=\S+ running=2 status=0$/m);
  assert.match(second.stdout, new RegExp(`^synapse-sync commit=${COMMIT_A.slice(0, 12)} ` +
    `deployed=${COMMIT_A.slice(0, 12)} running=2 status=0$`, 'm'));
});

/* Ограничение umask 077 нужно только на создание .env. Если оно утекает дальше, git
   раскладывает рабочую копию файлами 0600 и каталогами 0700, COPY уносит эти права в образ,
   и сборка ops/hugh-runtime падает после USER hugh на чтении /app/package.json. */
test('git работает с исходной umask, секреты остаются приватными', { skip: SECRET_SKIP }, () => {
  const space = workspace();
  setDesired(space, COMMIT_A);
  fs.rmSync(space.envFile); // .env создаётся с нуля — как при первой установке

  const first = run(space);
  assert.equal(first.status, 0);

  // Главное: маска восстановлена ДО того, как git раскладывает рабочую копию.
  assert.deepEqual(maskOf(first, 'fetch'), [0o027], 'git fetch идёт с исходной маской');
  assert.deepEqual(maskOf(first, 'reset'), [0o027], 'git reset идёт с исходной маской');
  for (const entry of first.gitUmask) {
    assert.notEqual(Number.parseInt(entry.mask, 8), 0o077,
      `git ${entry.command} не должен работать под umask 077`);
  }

  // При этом файл с секретами по-прежнему создан приватным.
  assert.equal(fs.statSync(space.envFile).mode & 0o777, 0o600, '.env остаётся приватным');
  const created = fs.readFileSync(space.envFile, 'utf8');
  for (const key of ENV_KEYS) assert.match(created, new RegExp(`^${key}=[0-9a-f]{64}$`, 'm'));
  for (const output of [first.stdout, first.stderr]) {
    assert.equal(/[0-9a-f]{64}/.test(output), false, 'созданные секреты не попадают в вывод');
  }

  // Отметка выкладки тоже приватная, и это не зависит от текущей маски.
  assert.equal(fs.statSync(space.marker).mode & 0o777, 0o600, 'отметка выкладки приватная');

  // Повторный запуск ничего не переписывает и снова не сужает маску для git.
  const second = run(space);
  assert.equal(second.status, 0);
  assert.equal(fs.readFileSync(space.envFile, 'utf8'), created, 'секреты не перевыпускаются');
  assert.deepEqual(maskOf(second, 'fetch'), [0o027]);
});

test('повреждённая отметка приводит к одной пересборке и восстанавливается', { skip: SKIP }, () => {
  const space = workspace();
  setDesired(space, COMMIT_A);
  fs.writeFileSync(space.marker, 'мусор\n');

  const first = run(space);
  assert.equal(first.status, 0);
  assert.equal(first.docker.filter(isBuild).length, 1);
  assert.deepEqual(readMarker(space), { commit: COMMIT_A, caddy: sha256('v1\n') });

  const second = run(space);
  assert.equal(second.docker.filter(isNoBuild).length, 1);
});

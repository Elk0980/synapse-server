#!/bin/sh
# Проверка песочницы synapse-autosync (root): запускает node --check и git по https
# с теми же ограничениями systemd, что и служба. Пустой прогон службы (база) node не
# вызывает, поэтому без этой проверки запрет системного вызова всплыл бы только на
# первом настоящем PR (каждый коммит с JS отклонялся бы как js-preflight).
#
#   sh sandbox-smoke.sh [юнит] [скрипт]
#   по умолчанию: /etc/systemd/system/synapse-autosync.service
#                 /usr/local/lib/synapse-autosync/synapse-autosync.py
# Ничего не выкладывает и не пишет в каталоги статики. Успех — строка «SANDBOX OK».
set -eu
UNIT=${1:-/etc/systemd/system/synapse-autosync.service}
SCRIPT=${2:-/usr/local/lib/synapse-autosync/synapse-autosync.py}
[ -r "$UNIT" ] || { echo "STOP: нет юнита $UNIT"; exit 1; }
[ -r "$SCRIPT" ] || { echo "STOP: нет скрипта $SCRIPT"; exit 1; }

# Все ограничения [Service], кроме запуска и собственных каталогов службы
# (их не создаём и не удаляем, чтобы не мешать настоящему запуску по таймеру).
PROPS=$(sed -n '/^\[Service\]/,/^\[/p' "$UNIT" | grep -E '^[A-Za-z]+=' \
  | grep -vE '^(Type|ExecStart|StateDirectory|StateDirectoryMode|RuntimeDirectory|RuntimeDirectoryMode|LogsDirectory|LogsDirectoryMode)=')
set --
OLDIFS=$IFS
IFS='
'
for p in $PROPS; do set -- "$@" -p "$p"; done
IFS=$OLDIFS

systemd-run --quiet --wait --pipe --collect "$@" /usr/bin/python3 - "$SCRIPT" <<'PY'
import importlib.util, shutil, subprocess, sys
spec = importlib.util.spec_from_file_location('autosync', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
node = shutil.which('node')
assert node, 'node не найден в PATH службы'
version = subprocess.run([node, '--version'], capture_output=True, text=True)
assert version.returncode == 0, f'node не запускается в песочнице: rc={version.returncode}'
assert m.node_check('probe.js', b'let a = 1;\n'), 'node --check валидного JS не проходит в песочнице'
assert not m.node_check('probe.js', b'let = ;\n'), 'синтаксическая ошибка JS не отклонена'
subprocess.run(['git', 'ls-remote', '--heads', m.REPO_URL, m.BRANCH], check=True, capture_output=True, timeout=60)
print(f'SANDBOX OK: {node} {version.stdout.strip()}, node --check и git https работают')
PY

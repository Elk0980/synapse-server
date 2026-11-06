#!/bin/bash
# Runs ONLY in the disposable Ubuntu 24.04 Actions VM, with real systemd.
set -Eeuo pipefail
[[ ${GITHUB_ACTIONS:-} == true ]] || { echo 'CI only'; exit 1; }
REV=$1
INSTALLER=$(mktemp /tmp/autosync-loader-XXXXXXXX)
curl -fsSL "https://raw.githubusercontent.com/Elk0980/synapse-server/$REV/ops/autosync/install.sh" -o "$INSTALLER"
HASH=$(git show "$REV:ops/autosync/install.sh" | sha256sum | cut -d' ' -f1)
echo "$HASH  $INSTALLER" | sha256sum -c -
TARGET=daca87ad71cf220dfddd56392186f4cec7dbe9b9
git fetch origin "$TARGET"
sudo install -d -o synapse-autosync -g synapse-autosync -m 755 /opt/synapse/sites/avokado3
git show "$TARGET^:sites/avokado3/index.html" | sudo tee /opt/synapse/sites/avokado3/index.html >/dev/null
echo 'a7ff72162e9568d0fd6330a4b32bd1c6bbe20f071e11785c6d2f4eb3e4721b07  /opt/synapse/sites/avokado3/index.html' | sha256sum -c -
git show "$TARGET:sites/avokado3/index.html" > /tmp/index.html
# Even a timer firing during a concurrent main update must stay on loopback.
# This override exists ONLY in the disposable Actions VM, never in install.sh.
sudo mkdir -p /etc/systemd/system/synapse-autosync.service.d
printf '[Service]\nExecStart=\nExecStart=/usr/bin/python3 /usr/local/lib/synapse-autosync/synapse-autosync.py --site-public http://127.0.0.1:18788 --public http://127.0.0.1:18788\n' | sudo tee /etc/systemd/system/synapse-autosync.service.d/ci.conf >/dev/null
python3 -m http.server 18788 --bind 127.0.0.1 --directory /tmp >/tmp/autosync-http.log 2>&1 &
HTTP_PID=$!
trap 'kill "$HTTP_PID"; sudo systemctl stop synapse-autosync.timer' EXIT
for i in {1..30}; do curl -fsS http://127.0.0.1:18788/index.html >/dev/null && break; sleep 1; done
sudo bash "$INSTALLER" "$REV" http://127.0.0.1:18788 | tee /tmp/install-result.log
grep '^ГОТОВО' /tmp/install-result.log
grep 'ОТЧЁТ О ДИСКЕ' /tmp/install-result.log
grep 'НЕТ ЗАПИСИ: /opt/synapse/sites/synapse/cabinet' /tmp/install-result.log
grep 'КОРЕНЬ ОТСУТСТВУЕТ: /opt/synapse/sites/alvi' /tmp/install-result.log
test "$(stat -c '%U:%G:%a' /opt/synapse/sites/synapse/cabinet)" = 'root:root:755'
sudo systemctl stop synapse-autosync.timer synapse-autosync.service
echo 'eaa509393766bb1f20acb23595d616844111a37a733f5af04bb3eae300aa0a5f  /opt/synapse/sites/avokado3/index.html' | sha256sum -c -
sudo grep 'BASELINE' /var/log/synapse-autosync/autosync.log
sudo systemctl is-enabled synapse-autosync.timer
sudo cp /var/lib/synapse-autosync/state.json /tmp/state-before-reinstall.json
sudo bash "$INSTALLER" "$REV" http://127.0.0.1:18788 > /tmp/reinstall-result.log
sudo systemctl stop synapse-autosync.timer synapse-autosync.service
grep 'BASELINE сохранён' /tmp/reinstall-result.log
grep 'BOOTSTRAP уже установлен' /tmp/reinstall-result.log
sudo cmp /tmp/state-before-reinstall.json /var/lib/synapse-autosync/state.json
# Run the exact operator command from the installer log after RuntimeDirectory cleanup.
sudo test ! -e /run/synapse-autosync
ROLLBACK=$(sed -n 's/^Откат последней операции (root): //p' /tmp/install-result.log)
test -n "$ROLLBACK"
sudo bash -e -c "$ROLLBACK"
sudo systemctl is-active --quiet synapse-autosync.timer
sudo systemctl stop synapse-autosync.timer synapse-autosync.service
echo 'a7ff72162e9568d0fd6330a4b32bd1c6bbe20f071e11785c6d2f4eb3e4721b07  /opt/synapse/sites/avokado3/index.html' | sha256sum -c -
printf 'local edit' | sudo tee /opt/synapse/sites/avokado3/index.html >/dev/null
if sudo bash "$INSTALLER" "$REV" http://127.0.0.1:18788 > /tmp/rejected-install.log 2>&1; then
  echo 'ожидался отказ при локальной правке'; exit 1
fi
grep 'ОШИБКА:' /tmp/rejected-install.log
test "$(cat /opt/synapse/sites/avokado3/index.html)" = 'local edit'
if sudo systemctl is-active --quiet synapse-autosync.timer; then exit 1; fi
echo 'INSTALL CI: 10/10 — baseline, install, exact site hash, timer, disk report, printed root rollback, reinstall, local-edit refusal, runtime directory absent, root permissions report'

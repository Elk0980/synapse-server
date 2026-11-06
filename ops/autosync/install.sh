#!/bin/bash
# №178: exact-revision installer. Never run by CI against a remote host.
set -Eeuo pipefail
report_disk() {
  echo 'ОТЧЁТ О ДИСКЕ (только чтение)'
  df -h / || true
  du -xh --max-depth=2 /opt /var /root 2>/dev/null || true
  docker system df || true
}
fail() { echo "ОШИБКА: $*"; if declare -F restore >/dev/null; then restore; fi; report_disk; exit 1; }
[[ $EUID == 0 ]] || fail 'нужен root для установки службы'
REV=${1:-}
[[ $REV =~ ^[0-9a-f]{40}$ ]] || fail 'нужен точный sha коммита'
for cmd in git python3 node curl systemctl runuser tar sha256sum; do
  command -v "$cmd" >/dev/null || fail "нет $cmd"
done
getent passwd synapse-autosync >/dev/null || fail 'нет существующего пользователя synapse-autosync; права автоматически не меняю'
BASE=/opt/synapse
LIB=/usr/local/lib/synapse-autosync
STATE=/var/lib/synapse-autosync
BACK=/var/backups/synapse-autosync
mkdir -p "$BACK" "$LIB"
SNAP=$(mktemp -d "$BACK/install-XXXXXXXX")
# Stop the managed writer before taking the snapshot; do not copy secrets.
paths=()
for p in usr/local/lib/synapse-autosync var/lib/synapse-autosync/state.json etc/systemd/system/synapse-autosync.service etc/systemd/system/synapse-autosync.timer opt/synapse/sites/avokado3/index.html; do
  [[ ! -e /$p ]] || paths+=("$p")
done
systemctl is-active synapse-autosync.timer > "$SNAP/timer-active" || true
systemctl is-enabled synapse-autosync.timer > "$SNAP/timer-enabled" || true
changed=0
restore() {
  trap - ERR
  systemctl stop synapse-autosync.timer synapse-autosync.service || true
  if [[ $changed == 1 ]]; then
    tar -C / -xpf "$SNAP/before.tar"
    systemctl daemon-reload || true
  fi
  if grep -qx disabled "$SNAP/timer-enabled" || grep -qx not-found "$SNAP/timer-enabled"; then
    systemctl disable synapse-autosync.timer || true
  fi
  if grep -qx active "$SNAP/timer-active"; then systemctl start synapse-autosync.timer || true; fi
  echo "ОШИБКА: установка остановлена; копия $SNAP/before.tar; таймер новой установки не включён"
  report_disk
  exit 1
}
trap restore ERR
systemctl stop synapse-autosync.timer synapse-autosync.service || true
tar -C / -cpf "$SNAP/before.tar" "${paths[@]}"
# Existing rights stay unchanged. Missing private directories only are created.
for dir in "$STATE" /var/log/synapse-autosync /run/synapse-autosync; do
  [[ -d $dir ]] || install -d -o synapse-autosync -g synapse-autosync -m 700 "$dir"
done
# Never chown an existing backup tree. Use a private operation subdirectory.
if [[ ! -d $BACK/operations ]]; then
  install -d -o synapse-autosync -g synapse-autosync -m 700 "$BACK/operations"
fi
OPS=$BACK/operations
runuser -u synapse-autosync -- test -w "$BASE/sites/avokado3" || fail 'папка avokado3 недоступна службе на запись; права не меняю'
if [[ ! -e $STATE/repo/HEAD ]]; then
  runuser -u synapse-autosync -- git clone --quiet --bare --filter=blob:none https://github.com/Elk0980/synapse-server.git "$STATE/repo"
fi
runuser -u synapse-autosync -- git -C "$STATE/repo" fetch --quiet origin "$REV"
PKG=$(mktemp -d /tmp/autosync-install-XXXXXXXX)
chmod 755 "$PKG"
runuser -u synapse-autosync -- git -C "$STATE/repo" archive "$REV" ops/autosync | tar -x -C "$PKG"
SRC=$PKG/ops/autosync
# Bind downloaded installer to the same immutable Git revision as its payload.
cmp "$0" "$SRC/install.sh"
changed=1
install -m 644 "$SRC/synapse-autosync.py" "$LIB/synapse-autosync.py"
install -m 644 "$SRC/sandbox-smoke.sh" "$LIB/sandbox-smoke.sh"
install -m 644 "$SRC/sandbox-run.sh" "$LIB/sandbox-run.sh"
install -m 644 "$SRC/synapse-autosync.service" /etc/systemd/system/
install -m 644 "$SRC/synapse-autosync.timer" /etc/systemd/system/
systemctl daemon-reload
bash "$SRC/sandbox-smoke.sh"
args=(--backups "$OPS")
if [[ -n ${2:-} ]]; then args+=(--site-public "$2"); fi
# Preserve an existing processed baseline on reinstallation.
if [[ ! -e $STATE/state.json ]]; then
  bash "$LIB/sandbox-run.sh" "${args[@]}" --init
else
  echo 'BASELINE сохранён (существующее состояние)'
fi
bash "$LIB/sandbox-run.sh" "${args[@]}" --bootstrap-avokado
systemctl enable --now synapse-autosync.timer
trap - ERR
report_disk
echo "ГОТОВО; копия установки: $SNAP/before.tar"
echo "Откат последней операции: runuser -u synapse-autosync -- python3 $LIB/synapse-autosync.py --backups $OPS --rollback"

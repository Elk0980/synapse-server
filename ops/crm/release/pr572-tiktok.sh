#!/bin/sh
# Адресный выпуск PR #572 (TikTok через Onlypult) в работающий контейнер CRM.
# Без пересборки образа: из файла в контейнере удаляется одна строка-барьер
# throw failure('TIKTOK_PRIVACY_UNCONFIRMED'); остальное не трогается.
# Перед правкой — копия базы CRM и прежнего файла. Перезапускается только CRM.
# Откат: sh pr572-tiktok.sh rollback
set -eu
C=$(docker ps --format '{{.ID}} {{.Names}}' | awk '$2 ~ /(^|[-_])crm([-_][0-9]+)?$/ {print $1; exit}')
[ -n "$C" ] || { echo "FAIL: контейнер CRM не найден"; exit 1; }
B=/var/backups/synapse-release/pr572
F=/app/onlypult-provider.js
if [ "${1:-}" = rollback ]; then
  docker cp "$B/onlypult-provider.js.old" "$C:$F"
  docker restart "$C" >/dev/null
  echo "ROLLBACK OK"; exit 0
fi
mkdir -p "$B"
for f in crm.sqlite crm.sqlite-wal crm.sqlite-shm; do docker cp "$C:/data/$f" "$B/$f" 2>/dev/null || true; done
[ -s "$B/crm.sqlite" ] || { echo "FAIL: копия базы не снята"; exit 1; }
docker cp "$C:$F" "$B/onlypult-provider.js.old"
N=$(grep -c "throw failure('TIKTOK_PRIVACY_UNCONFIRMED');" "$B/onlypult-provider.js.old" || true)
[ "$N" = 1 ] || { echo "FAIL: строка-барьер найдена $N раз — стоп, ничего не менял"; exit 1; }
sed "/throw failure('TIKTOK_PRIVACY_UNCONFIRMED');/d" "$B/onlypult-provider.js.old" > "$B/onlypult-provider.js.new"
docker cp "$B/onlypult-provider.js.new" "$C:$F"
docker exec "$C" node --check "$F" || { docker cp "$B/onlypult-provider.js.old" "$C:$F"; echo "FAIL: синтаксис, откатил"; exit 1; }
docker restart "$C" >/dev/null
sleep 8
S=$(docker inspect -f '{{.State.Status}} restarts={{.RestartCount}}' "$C")
L=$(docker exec "$C" grep -c "TIKTOK_PRIVACY_UNCONFIRMED');" "$F" || true)
echo "RELEASE572 OK container=$S barrier_lines=$L backup=$B"
docker logs --since 20s "$C" 2>&1 | tail -n 5

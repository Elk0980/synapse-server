#!/usr/bin/env bash
# Адресный выпуск серверных PR 588 (матрица уведомлений) и 589 (этапы Контент-завода).
# Запуск Root на synapse-core: bash cf589.sh check  |  bash cf589.sh apply
# Меняет только перечисленные файлы ops/crm и ops/content, пересобирает и перезапускает
# только сервисы crm и content. Бэкап файлов, данных и образов — до изменений; при провале
# проверки — откат файлов и образов. БД автоматически не восстанавливается (миграция только добавочная).
# Секреты и .env не читаются и не выводятся. MANAGED_RELEASE_BLOCKS_LEGACY_SYNC не трогается.
set -uo pipefail
MODE="${1:-check}"
R=/opt/synapse
NEW=origin/main
B588=9ec2ef1a968fd3d7780de72d531cc9e03ad7bfe5^1
B589=00b732abf5ab92af3c93737a3953b66be62a8aaf^1
FILES="ops/content/content-settings.js ops/content/server.js ops/content/shooting.js ops/crm/content-stages.js ops/crm/media-mentor-http.js ops/crm/media-mentor.js ops/crm/reel-materials-http.js ops/crm/reel-materials.js ops/crm/server.js"
STAMP=$(date +%Y%m%d-%H%M%S)
BK=/var/backups/synapse-release/cf589-$STAMP
LOG=/root/cf589-$STAMP.log
TMP=$(mktemp -d)
cd "$R" || { echo "STOP: нет $R"; exit 1; }
git fetch -q origin main || { echo "STOP: git fetch"; exit 1; }
git merge-base --is-ancestor 00b732abf5ab92af3c93737a3953b66be62a8aaf "$NEW" || { echo "STOP: 589 нет в main"; exit 1; }
sha() { sha256sum "$1" 2>/dev/null | cut -c1-12; }
blob() { git show "$1:$2" > "$3" 2>/dev/null; }
BAD=0; CHANGE=0
for f in $FILES; do
  n=$(basename "$f"); d=$(dirname "$f"); key=${d##*/}-$n
  blob "$NEW" "$f" "$TMP/$key.new" || { echo "STOP: нет $f в main"; exit 1; }
  if [ ! -e "$f" ]; then st=NEW-FILE; cp "$TMP/$key.new" "$TMP/$key.out"; CHANGE=1
  elif cmp -s "$f" "$TMP/$key.new"; then st=ALREADY
  else
    st=DIVERGED
    for base in "$B589" "$B588"; do
      if blob "$base" "$f" "$TMP/$key.base" && cmp -s "$f" "$TMP/$key.base"; then st=CLEAN; cp "$TMP/$key.new" "$TMP/$key.out"; CHANGE=1; break; fi
    done
    if [ "$st" = DIVERGED ]; then
      blob "$B589" "$f" "$TMP/$key.base" || blob "$B588" "$f" "$TMP/$key.base"
      cp "$f" "$TMP/$key.out"
      if git merge-file -q "$TMP/$key.out" "$TMP/$key.base" "$TMP/$key.new"; then st=MERGED; CHANGE=1; else st=CONFLICT; BAD=1; fi
    fi
  fi
  printf '%-10s %-38s srv=%s new=%s\n' "$st" "$f" "$(sha "$f")" "$(sha "$TMP/$key.new")" | tee -a "$LOG"
done
for f in $FILES; do case "$f" in *.js) n=$(basename "$f"); d=$(dirname "$f"); key=${d##*/}-$n; [ -e "$TMP/$key.out" ] && { node --check "$TMP/$key.out" 2>/dev/null || docker run --rm -v "$TMP:/t:ro" node:24-alpine node --check "/t/$key.out" >/dev/null 2>&1 || { echo "STOP: синтаксис $f"; BAD=1; }; } ;; esac; done
[ "$BAD" = 1 ] && { echo "STOP: конфликт — ничего не изменено. Лог $LOG"; exit 2; }
[ "$CHANGE" = 0 ] && { echo "OK: всё уже выпущено, изменений нет"; exit 0; }
[ "$MODE" != apply ] && { echo "CHECK OK: можно apply. Лог $LOG"; exit 0; }

mkdir -p "$BK/files" "$BK/crm-data" "$BK/content-data"; chmod 700 "$BK"
for f in $FILES; do [ -e "$f" ] && { mkdir -p "$BK/files/$(dirname "$f")"; cp -p "$f" "$BK/files/$f"; }; done
OLDCRM=$(docker inspect --format '{{.Image}}' "$(docker compose ps -q crm)")
OLDCNT=$(docker inspect --format '{{.Image}}' "$(docker compose ps -q content)")
NCRM=$(docker inspect --format '{{.Config.Image}}' "$(docker compose ps -q crm)")
NCNT=$(docker inspect --format '{{.Config.Image}}' "$(docker compose ps -q content)")
echo "$OLDCRM $NCRM" > "$BK/crm-image"; echo "$OLDCNT $NCNT" > "$BK/content-image"
docker compose cp crm:/data/. "$BK/crm-data/" >/dev/null || { echo "STOP: бэкап crm-data"; exit 3; }
docker compose cp content:/data/. "$BK/content-data/" >/dev/null || { echo "STOP: бэкап content-data"; exit 3; }
echo "BACKUP $BK ($(du -sh "$BK" | cut -f1))" | tee -a "$LOG"

for f in $FILES; do n=$(basename "$f"); d=$(dirname "$f"); key=${d##*/}-$n; [ -e "$TMP/$key.out" ] && cp "$TMP/$key.out" "$f"; done
check() {
  sleep 25
  [ "$(docker compose ps --status running -q crm content | wc -l)" = 2 ] || return 1
  docker compose exec -T content node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || return 1
  docker compose exec -T crm node -e "fetch('http://localhost:8080/media-mentor').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))" || return 1
  sleep 10; [ "$(docker compose ps --status running -q crm content | wc -l)" = 2 ] || return 1
}
rollback() {
  echo "ROLLBACK: $1" | tee -a "$LOG"
  for f in $FILES; do if [ -e "$BK/files/$f" ]; then cp -p "$BK/files/$f" "$f"; else rm -f "$f"; fi; done
  docker tag "$OLDCRM" "$NCRM"; docker tag "$OLDCNT" "$NCNT"
  docker compose up -d --no-deps --no-build crm content >>"$LOG" 2>&1
  sleep 20; docker compose ps crm content --format '{{.Service}} {{.State}}' | tee -a "$LOG"
  echo "ОТКАТ ВЫПОЛНЕН. Бэкап $BK. Лог $LOG"; exit 4
}
echo "BUILD..." ; docker compose build crm content >>"$LOG" 2>&1 || rollback "сборка"
docker compose up -d --no-deps crm content >>"$LOG" 2>&1 || rollback "запуск"
check || { docker compose logs --tail 40 crm content >>"$LOG" 2>&1; rollback "проверка"; }
docker compose ps crm content --format '{{.Service}} {{.State}} {{.Status}}' | tee -a "$LOG"
echo "RELEASED OK: crm+content на $(git rev-parse --short "$NEW"). Бэкап $BK. Лог $LOG"

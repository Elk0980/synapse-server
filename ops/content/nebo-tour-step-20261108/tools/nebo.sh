#!/bin/sh
# Небо · выкладка tour-step.js. Запуск из папки с tour-step.js и save.js:
#   sh nebo.sh dry        — только проверка, без изменений
#   sh nebo.sh apply      — бэкап базы + новая ревизия сайта штатным store.save
#   sh nebo.sh check      — живой сайт отдаёт скрипт и строку
#   sh nebo.sh rollback <старая-ревизия>
set -e
C=synapse-content-1
MODE=${1:-dry}
if [ "$MODE" = check ]; then
  echo "tour-step.js: $(curl -s -o /dev/null -w '%{http_code}' "https://nebo-draft-1.synapsebusiness.ru/assets/tour-step.js?c=$(date +%s)")"
  echo "строк в index.html: $(curl -s "https://nebo-draft-1.synapsebusiness.ru/?c=$(date +%s)" | grep -c tour-step.js || true)"
  exit 0
fi
docker cp tour-step.js "$C:/tmp/nebo-tour-step.js"
docker cp save.js "$C:/tmp/nebo-save.js"
docker exec "$C" node /tmp/nebo-save.js "$MODE" "$2"

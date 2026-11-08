#!/bin/sh
# Небо · заставка-облака (№247). Всё берётся из коммита GitHub.
#   sh nebo2.sh <commit> dry      — скачать файлы и проверить, без изменений
#   sh nebo2.sh <commit> apply    — бэкап базы + 2 новые ревизии сайта
#   sh nebo2.sh check             — живой сайт отдаёт видео облаков и заставку
#   sh nebo2.sh rollback <ревизия-до>
set -e
C=synapse-content-1
H=https://nebo-draft-1.synapsebusiness.ru
if [ "$1" = check ]; then
  for f in /tour-media/clouds-desktop.mp4 /tour-media/clouds-mobile.mp4 /assets/tour-step.js; do
    echo "$f: $(curl -s -o /dev/null -w '%{http_code} %{size_download}' "$H$f?c=$(date +%s)")"; done
  echo "заставка в index.html: $(curl -s "$H/?c=$(date +%s)" | grep -c nebo-loader || true)"
  exit 0
fi
if [ "$1" = rollback ]; then docker exec "$C" node /tmp/nebo-save-media.js rollback "$2"; exit 0; fi
SHA=$1; MODE=${2:-dry}
B=https://raw.githubusercontent.com/elk0980/synapse-server/$SHA/ops/content/nebo-tour-step-20261108
mkdir -p /root/nebo-clouds && cd /root/nebo-clouds
for f in tour-step.js loader.html tools/save-media.js media/clouds-desktop.mp4 media/clouds-mobile.mp4; do
  curl -sfL -o "$(basename "$f")" "$B/$f"; done
ls -l
docker cp tour-step.js "$C:/tmp/nebo-tour-step.js"
docker cp loader.html "$C:/tmp/nebo-loader.html"
docker cp save-media.js "$C:/tmp/nebo-save-media.js"
docker cp clouds-desktop.mp4 "$C:/tmp/nebo-clouds-desktop.mp4"
docker cp clouds-mobile.mp4 "$C:/tmp/nebo-clouds-mobile.mp4"
NEBO_V=20261108c docker exec -e NEBO_V "$C" node /tmp/nebo-save-media.js "$MODE"

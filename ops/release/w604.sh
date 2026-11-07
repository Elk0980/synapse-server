#!/bin/bash
# Выпуск серверной части PR 604 (рассылка уведомлений Контент-завода, по умолчанию выкл.) штатным prpatch.
cd /root/claude-rel || exit 1
bash /root/claude-rel/prpatch.sh 604 495d5e45f92ce8da0489c1344e0ba6798ba621bd 0b089f7dd9ca36dc6fec2d17432692950ad106d6 \
  ops/crm/people-http.js ops/crm/server.js ops/content/content-stage-notify.js ops/content/content-settings.js \
  ops/content/people-service.js ops/content/people-crm-client.js ops/content/server.js 2>&1 | tail -14

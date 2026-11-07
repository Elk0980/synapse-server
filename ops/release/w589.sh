#!/bin/bash
# Подготовка выпуска серверных PR 588+589 штатным prpatch (образы FROM живого, боевое не меняется).
cd /root/claude-rel || exit 1
bash /root/claude-rel/prpatch.sh 589 03157041b62bb37ebee12327fc0040361a2beeac 00b732abf5ab92af3c93737a3953b66be62a8aaf \
  ops/content/content-settings.js ops/content/server.js ops/content/shooting.js \
  ops/crm/content-stages.js ops/crm/media-mentor-http.js ops/crm/media-mentor.js \
  ops/crm/reel-materials-http.js ops/crm/reel-materials.js ops/crm/server.js 2>&1 | tee /root/claude-rel/p589.log | tail -22

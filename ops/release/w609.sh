#!/bin/bash
# Выпуск серверной части PR 609 (архив «Убрать/Вернуть» Контент-завода) штатным prpatch.
cd /root/claude-rel || exit 1
bash /root/claude-rel/prpatch.sh 609 8007ed2d5a8ed262fa777339d007155a58e6c34c 5bdeb4036c5b95dec55ef5b8609b53b94de4b646 \
  ops/crm/media-mentor.js ops/crm/media-mentor-http.js ops/crm/media-mentor-transfer.js ops/crm/reel-materials.js \
  ops/crm/reel-materials-http.js ops/crm/autoposting-recovery.js ops/crm/autoposting.js ops/crm/content-stages.js 2>&1 | tail -16

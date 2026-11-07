#!/bin/bash
# Шаг №84: выпуск статики, которую автосинк не трогает (корневые html PR 582 + ui-scrollbar.css,
# серверный project-forms.js из PR 580) штатными prpatch/prgo. Сервисы не перезапускаются.
B=be58b33c520b9d4a0d846e7be29528898662d16f; H=429eea88d96acf38a304f8d6325a6d3f3699de09
cd /root/claude-rel || exit 1
bash /root/claude-rel/prpatch.sh 582 $B $H \
  sites/synapse/cabinet.html sites/synapse/cabinet/people.html sites/synapse/cabinet/team-chat.html \
  sites/synapse/miniapp.html sites/synapse/price-editor-palitra.html sites/synapse/price-editor.html \
  sites/synapse/site-editor-avokado.html sites/synapse/site-editor.html sites/synapse/ui-scrollbar.css 2>&1 | tail -14
W=/root/claude-rel/w582
# project-forms.js: в main появился в PR 580 из снимка сервера; ставим версию main.
curl -fsS https://raw.githubusercontent.com/Elk0980/synapse-server/495d5e45f92ce8da0489c1344e0ba6798ba621bd/sites/synapse/cabinet/project-forms.js -o $W/st/cabinet/project-forms.js \
  && { grep -qx sites/synapse/cabinet/project-forms.js $W/static.txt || echo sites/synapse/cabinet/project-forms.js >> $W/static.txt; echo "ADD project-forms.js $(sha256sum < $W/st/cabinet/project-forms.js | cut -c1-12) live=$(sha256sum < /opt/synapse/sites/synapse/cabinet/project-forms.js | cut -c1-12)"; }
echo "STATIC $(wc -l < $W/static.txt) files; dalee: bash /root/claude-rel/prgo.sh 582"

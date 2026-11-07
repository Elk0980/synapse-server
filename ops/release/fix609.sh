#!/bin/bash
# PR 609: media-mentor.js не лёг одним блоком. Трёхсторонне сливаем живой файл (из образа) с изменением base->head, пересобираем crm.
W=/root/claude-rel/w609; cd $W || exit 1
R=raw.githubusercontent.com/elk0980/synapse-server
B=8007ed2d5a8ed262fa777339d007155a58e6c34c; H=5bdeb4036c5b95dec55ef5b8609b53b94de4b646
F=b-crm/media-mentor.js
docker run --rm --entrypoint cat synapse-crm:pr604-claude /app/media-mentor.js > mm.live || { echo LIVEFAIL; exit 1; }
curl -s --location -o mm.base $R/$B/ops/crm/media-mentor.js
curl -s --location -o mm.head $R/$H/ops/crm/media-mentor.js
echo "live-vs-base: $(diff mm.base mm.live | grep -c '^[<>]') lines"
diff mm.base mm.live | head -20
cp mm.live mm.merged
if command -v git >/dev/null; then git merge-file mm.merged mm.base mm.head; C=$?; else diff3 -m mm.live mm.base mm.head > mm.merged; C=$?; fi
echo "conflicts=$C"
[ "$C" = "0" ] || { echo MERGEFAIL; exit 1; }
cp mm.merged $F
docker build -q -t synapse-crm:pr609-claude b-crm >/dev/null || { echo BUILDFAIL; exit 1; }
ID=$(docker image inspect synapse-crm:pr609-claude --format '{{.Id}}'); echo "$ID" > img-crm.new
printf '{"services":{"crm":{"image":"%s"}}}' "$ID" > cand-crm.json
docker run --rm --network none --entrypoint node synapse-crm:pr609-claude --check /app/server.js && echo CHECK_OK
docker run --rm --network none --entrypoint node synapse-crm:pr609-claude -e "for(const m of ['media-mentor','media-mentor-http','media-mentor-transfer','reel-materials','reel-materials-http','autoposting-recovery','autoposting','content-stages'])require('/app/'+m+'.js');console.log('REQUIRE_OK')" 2>&1 | tail -1
echo "img $(cut -c8-19 img-crm.new); dalee: bash /root/claude-rel/prgo.sh 609 crm"

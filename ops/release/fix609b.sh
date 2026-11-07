#!/bin/bash
# PR 609: в живом media-mentor.js есть серверная вставка publicationCopies. Переносим её в версию head и пересобираем crm.
W=/root/claude-rel/w609; cd $W || exit 1
F=b-crm/media-mentor.js
L=$(grep -m1 "const publicationCopies=require('./media-mentor-publication-copies.cjs')" mm.live) || { echo NOLINE; exit 1; }
awk -v ins="$L" '/^  return \{get,saveBrief,/ && !done {print ins; sub(/return \{get,/,"return {publicationCopies,get,"); done=1} {print}' mm.head > mm.fixed
echo "inserted: $(grep -c 'publicationCopies' mm.fixed)"
echo "fixed-vs-head (ozhidaem 2 stroki):"; diff mm.head mm.fixed
cp mm.fixed $F
docker build -q -t synapse-crm:pr609-claude b-crm >/dev/null || { echo BUILDFAIL; exit 1; }
ID=$(docker image inspect synapse-crm:pr609-claude --format '{{.Id}}'); echo "$ID" > img-crm.new
printf '{"services":{"crm":{"image":"%s"}}}' "$ID" > cand-crm.json
docker run --rm --network none --entrypoint node synapse-crm:pr609-claude --check /app/server.js && echo CHECK_OK
docker run --rm --network none --entrypoint node synapse-crm:pr609-claude -e "for(const m of ['media-mentor','media-mentor-http','media-mentor-transfer','reel-materials','reel-materials-http','autoposting-recovery','autoposting','content-stages'])require('/app/'+m+'.js');console.log('REQUIRE_OK')" 2>&1 | tail -1
echo "img $(cut -c8-19 img-crm.new); dalee: bash /root/claude-rel/prgo.sh 609 crm"

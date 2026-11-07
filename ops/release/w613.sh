#!/bin/bash
# Выпуск PR 610-613 (CRM: autoposting.js, media-mentor*.js; content: каталог компаний; статика cabinet.html) штатным prpatch.
# media-mentor.js на сервере содержит вставку publicationCopies: собираем его из head + та же вставка.
B=5bdeb4036c5b95dec55ef5b8609b53b94de4b646; H=99e63833761a1a84031e8770f0e1627c7127a7f4
R=raw.githubusercontent.com/elk0980/synapse-server
cd /root/claude-rel || exit 1
bash /root/claude-rel/prpatch.sh 613 $B $H \
  ops/crm/autoposting.js ops/crm/media-mentor.js ops/crm/media-mentor-http.js \
  ops/content/company-catalog.js ops/content/auth-store.js ops/content/server.js \
  sites/synapse/cabinet.html 2>&1 | tail -16
W=/root/claude-rel/w613; cd $W || exit 1
LIVE=$(docker inspect synapse-crm-1 --format '{{.Image}}')
docker run --rm --entrypoint cat $LIVE /app/media-mentor.js > mm.live
curl -s --location -o mm.head $R/$H/ops/crm/media-mentor.js
L=$(grep -m1 "const publicationCopies=require('./media-mentor-publication-copies.cjs')" mm.live)
if [ -n "$L" ]; then
  awk -v ins="$L" '/^  return \{get,saveBrief,/ && !done {print ins; sub(/return \{get,/,"return {publicationCopies,get,"); done=1} {print}' mm.head > mm.fixed
else cp mm.head mm.fixed; fi
echo "mm: insert=$(grep -c publicationCopies mm.fixed) diff_vs_head=$(diff mm.head mm.fixed | grep -c '^[<>]')"
cp mm.fixed b-crm/media-mentor.js
docker build -q -t synapse-crm:pr613-claude b-crm >/dev/null || { echo BUILDFAIL; exit 1; }
ID=$(docker image inspect synapse-crm:pr613-claude --format '{{.Id}}'); echo "$ID" > img-crm.new
printf '{"services":{"crm":{"image":"%s"}}}' "$ID" > cand-crm.json
docker run --rm --network none --entrypoint node synapse-crm:pr613-claude -e "for(const m of ['media-mentor','media-mentor-http','autoposting'])require('/app/'+m+'.js');console.log('CRM_REQUIRE_OK')" 2>&1 | tail -1
ls b-content >/dev/null 2>&1 && echo "content staged: $(ls b-content | grep -c company-catalog)"
grep -c "content/companies" st/cabinet.html 2>/dev/null | sed 's/^/cabinet_new_client_refs=/'
cat static.txt 2>/dev/null
echo "dalee: bash /root/claude-rel/prgo.sh 613 crm content"

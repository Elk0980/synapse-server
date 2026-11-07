#!/bin/bash
# Доводка w613: autoposting.js остаётся живым (изменение 610 по умолчанию поведения не меняет);
# auth-store.js и cabinet.html = версия 613 + собственные отличия живого файла от main (diff C→live).
R=raw.githubusercontent.com/elk0980/synapse-server
C=5bdeb4036c5b95dec55ef5b8609b53b94de4b646; D=99e63833761a1a84031e8770f0e1627c7127a7f4
W=/root/claude-rel/w613; cd $W || exit 1
CI=$(docker inspect synapse-crm-1 --format '{{.Image}}'); NI=$(docker inspect synapse-content-1 --format '{{.Image}}')
docker run --rm --entrypoint cat $CI /app/autoposting.js > b-crm/autoposting.js; rm -f b-crm/*.rej b-crm/*.orig
echo "autoposting=live $(docker run --rm --entrypoint cat $CI /app/autoposting.js | cmp -s - b-crm/autoposting.js && echo same)"
merge(){ # $1 путь в репо, $2 живой файл, $3 куда положить
  curl -s --location -o m.C $R/$C/$1; curl -s --location -o m.D $R/$D/$1
  diff -u m.C $2 > m.local; cp m.D m.out
  if patch -s --no-backup-if-mismatch m.out m.local >/dev/null 2>&1; then cp m.out $3; echo "MERGED $1 local=$(grep -c '^[-+][^-+]' m.local) vs_head=$(diff m.D $3 | grep -c '^[<>]')";
  else echo "MERGEFAIL $1"; cp m.local fail.$(basename $1).local; cp m.out.rej fail.$(basename $1).rej 2>/dev/null; fi; rm -f m.out.rej
}
docker run --rm --entrypoint cat $NI /app/auth-store.js > live.auth; merge ops/content/auth-store.js live.auth b-content/auth-store.js
rm -f b-content/*.rej b-content/*.orig st/*.rej st/*.orig
merge sites/synapse/cabinet.html /opt/synapse/sites/synapse/cabinet.html st/cabinet.html
for d in b-crm b-content; do rm -f $d/*.rej $d/*.orig; sed -i '/\.rej \/app\|\.orig \/app/d' $d/Dockerfile; done
grep -c "content/companies" st/cabinet.html | sed 's/^/new_client_refs=/'
docker build -q -t synapse-crm:pr613-claude b-crm >/dev/null || { echo BUILDFAIL_CRM; exit 1; }
ID=$(docker image inspect synapse-crm:pr613-claude --format '{{.Id}}'); echo "$ID" > img-crm.new
printf '{"services":{"crm":{"image":"%s"}}}' "$ID" > cand-crm.json
docker build -q -t synapse-content:pr613-claude b-content >/dev/null || { echo BUILDFAIL_CONTENT; exit 1; }
ID2=$(docker image inspect synapse-content:pr613-claude --format '{{.Id}}'); echo "$ID2" > img-content.new
printf '{"services":{"content":{"image":"%s"}}}' "$ID2" > cand-content.json
docker run --rm --network none --entrypoint node synapse-crm:pr613-claude --check /app/server.js && echo CRM_CHECK_OK
docker run --rm --network none --entrypoint node synapse-crm:pr613-claude -e "for(const m of ['media-mentor','media-mentor-http','autoposting'])require('/app/'+m+'.js');console.log('CRM_REQUIRE_OK')" 2>&1 | tail -1
docker run --rm --network none --entrypoint node synapse-content:pr613-claude --check /app/server.js && echo CONTENT_CHECK_OK
docker run --rm --network none --entrypoint node synapse-content:pr613-claude -e "for(const m of ['company-catalog','auth-store'])require('/app/'+m+'.js');console.log('CONTENT_REQUIRE_OK')" 2>&1 | tail -1
ls; echo "dalee: bash /root/claude-rel/prgo.sh 613 crm content"

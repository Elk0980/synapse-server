#!/bin/bash
# PR 604: строка подключения contentStages в живой ops/crm/server.js (патч не лёг по контексту) и пересборка образа crm.
W=/root/claude-rel/w604; cd $W || exit 1
F=b-crm/server.js
grep -q "contentStages:require('./content-stages')" $F || sed -i "/^const handlePeople = createPeopleHandler(/s/send});\$/send,contentStages:require('.\/content-stages').createContentStages(db)});/" $F
echo "line: $(grep -c "contentStages:require('./content-stages').createContentStages(db)});" $F)"
docker build -q -t synapse-crm:pr604-claude b-crm >/dev/null || { echo BUILDFAIL; exit 1; }
ID=$(docker image inspect synapse-crm:pr604-claude --format '{{.Id}}'); echo "$ID" > img-crm.new
printf '{"services":{"crm":{"image":"%s"}}}' "$ID" > cand-crm.json
docker run --rm --network none --entrypoint node synapse-crm:pr604-claude --check /app/server.js && echo CHECK_OK
docker run --rm --network none --entrypoint node synapse-crm:pr604-claude -e "require('/app/people-http.js');console.log('REQUIRE_OK')" 2>&1 | tail -1
echo "img $(cut -c8-19 img-crm.new); dalee: bash /root/claude-rel/prgo.sh 604 crm content"

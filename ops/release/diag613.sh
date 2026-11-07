#!/bin/bash
# Сверка живых файлов с версиями main: число отличающихся строк (A=604 ba8efe98, C=609 5bdeb403, D=613 99e63833).
R=raw.githubusercontent.com/elk0980/synapse-server
A=ba8efe982931fd3d224b0c8ed566830ccebc9e08; C=5bdeb4036c5b95dec55ef5b8609b53b94de4b646; D=99e63833761a1a84031e8770f0e1627c7127a7f4
T=/root/claude-rel/diag613; rm -rf $T; mkdir -p $T; cd $T
CI=$(docker inspect synapse-crm-1 --format '{{.Image}}'); NI=$(docker inspect synapse-content-1 --format '{{.Image}}')
row(){ # $1 путь в репо, $2 живой файл
  for k in A C D; do eval h=\$$k; curl -s --location -o v.$k $R/$h/$1; done
  printf '%-36s' "$1"; for k in A C D; do if [ -s $2 ]; then printf ' %s=%s' $k $(diff $2 v.$k | grep -c '^[<>]'); else printf ' NOLIVE'; fi; done; echo
}
for f in autoposting autoposting-recovery content-stages media-mentor-http media-mentor-transfer media-mentor onlypult-provider reel-attribution-http reel-attribution reel-materials-http reel-materials server; do
  docker run --rm --entrypoint cat $CI /app/$f.js > live 2>/dev/null; row ops/crm/$f.js live; done
for f in auth-store server company-catalog; do
  docker run --rm --entrypoint cat $NI /app/$f.js > live 2>/dev/null; row ops/content/$f.js live; done
cp /opt/synapse/sites/synapse/cabinet.html live; row sites/synapse/cabinet.html live

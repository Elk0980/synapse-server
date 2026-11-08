#!/bin/sh
# Только чтение: показывает методы хранилища сайтов (site-workspaces.js) в контейнере content.
# Запуск: sh outline.sh [from] [to]
FROM=${1:-236}; TO=${2:-272}
docker exec synapse-content-1 node -e '
const s=require("fs").readFileSync("/app/site-workspaces.js","utf8").split("\n");
const from=+process.argv[1], to=+process.argv[2];
const m=[];s.forEach((l,i)=>{const r=l.match(/^\s{0,4}(?:async\s+)?([a-zA-Z]+)\s*\(\s*(user|actor)[^)]*\)\s*\{/)||l.match(/^\s*(?:async\s+)?function\s+([a-zA-Z]+)\s*\(/);if(r)m.push((i+1)+":"+r[1]);});
console.log("METHODS "+m.join(" "));
for(let i=from;i<=to&&i<=s.length;i++)console.log(i+":"+s[i-1].slice(0,150));
' "$FROM" "$TO"

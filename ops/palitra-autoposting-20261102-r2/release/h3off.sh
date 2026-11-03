#!/bin/bash
# Выключить HTTP/3 в Caddy: на части сетей Wi‑Fi iPhone висит на белом экране, пытаясь открыть сайт по HTTP/3.
# Делает резервную копию, правит только глобальный блок, проверяет конфиг; при ошибке возвращает копию.
set -u
F=/opt/synapse/caddy/Caddyfile
B=/root/Caddyfile.before-h3off-$(date +%Y%m%d-%H%M%S)
if grep -q 'protocols h1 h2' "$F"; then echo "HTTP/3 уже выключен"; exit 0; fi
cp -p "$F" "$B" || exit 1
sed -i '0,/^  email admin@synapsebusiness.ru$/s//&\n  servers {\n    protocols h1 h2\n  }/' "$F"
if ! grep -q 'protocols h1 h2' "$F"; then cp -p "$B" "$F"; echo "НЕ ПОЛУЧИЛОСЬ: строка email не найдена, ничего не изменено"; exit 1; fi
if ! docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/h3off.log 2>&1; then
  cp -p "$B" "$F"; tail -3 /tmp/h3off.log; echo "НЕ ПОЛУЧИЛОСЬ: конфиг не прошёл проверку, возвращена копия"; exit 1; fi
if ! docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >>/tmp/h3off.log 2>&1; then
  cp -p "$B" "$F"; docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
  tail -3 /tmp/h3off.log; echo "НЕ ПОЛУЧИЛОСЬ: перезагрузка не прошла, возвращена копия"; exit 1; fi
sleep 2
H=$(curl -sI --resolve synapse.synapsebusiness.ru:443:127.0.0.1 https://synapse.synapsebusiness.ru/cabinet/palitra-orders/cabinet.html)
echo "$H" | head -1
if echo "$H" | grep -qi '^alt-svc'; then echo "ВНИМАНИЕ: сервер всё ещё предлагает HTTP/3"; else echo "ГОТОВО: HTTP/3 выключен. Копия: $B"; fi

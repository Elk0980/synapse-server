#!/usr/bin/env bash
set -Eeuo pipefail

readonly DEPLOY_DIR="${SYNAPSE_DEPLOY_DIR:-/opt/synapse}"
readonly BACKUP_DIR="${SYNAPSE_BACKUP_DIR:-/var/backups/synapse}"
readonly KEEP_BACKUPS="${SYNAPSE_BACKUP_KEEP:-7}"

fail() {
  echo "Ошибка: $*" >&2
  exit 1
}

command -v docker >/dev/null || fail "docker не найден"
command -v tar >/dev/null || fail "tar не найден"
[[ -d "$DEPLOY_DIR" ]] || fail "каталог $DEPLOY_DIR не найден"
[[ -f "$DEPLOY_DIR/caddy/Caddyfile" ]] || fail "caddy/Caddyfile не найден"
[[ "$KEEP_BACKUPS" =~ ^[1-9][0-9]*$ ]] || fail "SYNAPSE_BACKUP_KEEP должен быть положительным числом"

mkdir -p "$BACKUP_DIR"
umask 077

timestamp=$(date '+%Y-%m-%d-%H%M%S')
archive="$BACKUP_DIR/synapse-${timestamp}.tar.gz"
workdir=$(mktemp -d "$BACKUP_DIR/.backup.XXXXXX")
staging="$workdir/synapse-backup"

cleanup() {
  status=$?
  rm -rf "$workdir"
  if ((status != 0)); then
    rm -f "$archive"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

mkdir -p "$staging/config" "$staging/sites" "$staging/docker-volumes"
cp -a "$DEPLOY_DIR/caddy/Caddyfile" "$staging/config/Caddyfile"

shopt -s nullglob
compose_files=("$DEPLOY_DIR"/docker-compose*.yml "$DEPLOY_DIR"/docker-compose*.yaml \
               "$DEPLOY_DIR"/compose*.yml "$DEPLOY_DIR"/compose*.yaml)
((${#compose_files[@]})) || fail "Docker Compose файлы не найдены"
cp -a "${compose_files[@]}" "$staging/config/"

# Content and uploaded media can live in different site subdirectories.
while IFS= read -r -d '' path; do
  relative=${path#"$DEPLOY_DIR/sites/"}
  mkdir -p "$staging/sites/$(dirname "$relative")"
  cp -a "$path" "$staging/sites/$relative"
done < <(find "$DEPLOY_DIR/sites" -type f \( -name content.json -o \
  -path '*/media/*' -o -path '*/assets/*' -o -path '*/uploads/*' \) -print0)

# Databases managed by Compose are persisted in named volumes. Copy every
# Compose volume so a future database service is included without credentials.
mapfile -t containers < <(docker compose -f "${compose_files[0]}" ps -aq)
declare -a volumes=()
if ((${#containers[@]})); then
  mapfile -t volumes < <(docker inspect --format \
    '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' \
    "${containers[@]}" | sed '/^$/d' | sort -u)
fi
for volume in "${volumes[@]}"; do
  docker run --rm -v "$volume:/source:ro" -v "$staging/docker-volumes:/backup" \
    alpine:3.20 tar -czf "/backup/$volume.tar.gz" -C /source .
done

tar -czf "$archive" -C "$workdir" synapse-backup
[[ -s "$archive" ]] || fail "архив не создан"

# Keep exactly the seven (or SYNAPSE_BACKUP_KEEP) newest completed archives.
mapfile -t archives < <(find "$BACKUP_DIR" -maxdepth 1 -type f \
  -name 'synapse-????-??-??-??????.tar.gz' -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)
if ((${#archives[@]} > KEEP_BACKUPS)); then
  rm -f -- "${archives[@]:KEEP_BACKUPS}"
fi

echo "Бэкап создан: $archive"

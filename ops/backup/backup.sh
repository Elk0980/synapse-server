#!/usr/bin/env bash
set -Eeuo pipefail

readonly RCLONE_CONFIG="/root/.config/rclone/rclone.conf"
readonly DEPLOY_DIR="${SYNAPSE_DEPLOY_DIR:-/opt/synapse}"
readonly BACKUP_DIR="${SYNAPSE_BACKUP_DIR:-/var/backups/synapse}"
readonly REMOTE_DIR="${RCLONE_DESTINATION:-synapse-backups}"

DRY_RUN=false
case "${1:-}" in
  --dry-run) DRY_RUN=true ;;
  "") ;;
  *) echo "Использование: $0 [--dry-run]" >&2; exit 2 ;;
esac

fail() {
  echo "Ошибка: $*" >&2
  exit 1
}

command -v docker >/dev/null || fail "docker не найден"
command -v rclone >/dev/null || fail "rclone не найден"
command -v tar >/dev/null || fail "tar не найден"
command -v sha256sum >/dev/null || fail "sha256sum не найден"
[[ -d "$DEPLOY_DIR" ]] || fail "каталог развёртывания $DEPLOY_DIR не найден"
[[ -f "$DEPLOY_DIR/docker-compose.yml" ]] || fail "$DEPLOY_DIR/docker-compose.yml не найден"
[[ -f "$RCLONE_CONFIG" ]] || fail "конфигурация rclone не найдена: $RCLONE_CONFIG"
[[ -n "${RCLONE_REMOTE:-}" ]] || fail "задайте имя rclone remote в переменной RCLONE_REMOTE"
if ! rclone listremotes --config "$RCLONE_CONFIG" | grep -Fxq "${RCLONE_REMOTE}:"; then
  fail "remote ${RCLONE_REMOTE} не найден в $RCLONE_CONFIG"
fi

REMOTE="${RCLONE_REMOTE}:${REMOTE_DIR}"
mapfile -t COMPOSE_CONTAINERS < <(docker compose -f "$DEPLOY_DIR/docker-compose.yml" ps -aq)
declare -a VOLUMES=()
if ((${#COMPOSE_CONTAINERS[@]})); then
  mapfile -t VOLUMES < <(
    docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' \
      "${COMPOSE_CONTAINERS[@]}" | sed '/^$/d' | sort -u
  )
fi

echo "Каталог развёртывания: $DEPLOY_DIR"
echo "Docker Compose: $DEPLOY_DIR/docker-compose.yml"
if ((${#VOLUMES[@]})); then
  printf 'Тома Docker:\n'
  printf '  - %s\n' "${VOLUMES[@]}"
else
  echo "Тома Docker: не найдены"
fi
echo "Сведения: список/версии и inspect контейнеров, образов и томов"
echo "Загрузка: $REMOTE"

if $DRY_RUN; then
  echo "DRY RUN: архив, загрузка и ротация не выполнялись."
  exit 0
fi

[[ $EUID -eq 0 ]] || fail "запустите скрипт от root (нужен доступ к данным томов Docker)"
mkdir -p "$BACKUP_DIR"
umask 077

timestamp=$(date '+%Y-%m-%d-%H%M')
archive_name="synapse-host-${timestamp}.tar.gz"
archive="$BACKUP_DIR/$archive_name"
manifest="$archive.manifest.txt"
workdir=$(mktemp -d "$BACKUP_DIR/.backup.XXXXXX")
raw_archive="$workdir/${archive_name%.gz}"
metadata="$workdir/docker"
declare -a STOPPED_BY_US=()

cleanup() {
  local status=$?
  if ((${#STOPPED_BY_US[@]})); then
    docker start "${STOPPED_BY_US[@]}" >/dev/null 2>&1 || true
  fi
  rm -rf "$workdir"
  if ((status != 0)); then
    rm -f "$archive" "$manifest"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

mkdir -p "$metadata/containers" "$metadata/images" "$metadata/volumes"
docker version >"$metadata/docker-version.txt"
docker compose version >"$metadata/docker-compose-version.txt"
docker ps -a --no-trunc --format \
  'table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}' >"$metadata/containers.txt"
docker images --no-trunc --digests >"$metadata/images.txt"
docker compose -f "$DEPLOY_DIR/docker-compose.yml" config >"$metadata/compose-config.yml"
if ((${#COMPOSE_CONTAINERS[@]})); then
  docker inspect "${COMPOSE_CONTAINERS[@]}" >"$metadata/containers/inspect.json"
else
  printf '[]\n' >"$metadata/containers/inspect.json"
fi
for volume in "${VOLUMES[@]}"; do
  docker volume inspect "$volume" >"$metadata/volumes/$volume.json"
done

mapfile -t RUNNING_COMPOSE < <(docker compose -f "$DEPLOY_DIR/docker-compose.yml" ps -q --status running)
if ((${#RUNNING_COMPOSE[@]})); then
  docker stop "${RUNNING_COMPOSE[@]}" >/dev/null
  STOPPED_BY_US=("${RUNNING_COMPOSE[@]}")
fi

deploy_parent=$(dirname "$DEPLOY_DIR")
deploy_name=$(basename "$DEPLOY_DIR")
tar -cf "$raw_archive" --transform="s,^${deploy_name},deployment," \
  -C "$deploy_parent" "$deploy_name"
tar -rf "$raw_archive" -C "$workdir" docker
for volume in "${VOLUMES[@]}"; do
  mountpoint=$(docker volume inspect --format '{{.Mountpoint}}' "$volume")
  [[ -d "$mountpoint" ]] || fail "точка монтирования тома $volume не найдена: $mountpoint"
  tar -rf "$raw_archive" --transform="s,^\.,docker/volumes/$volume," \
    -C "$mountpoint" .
done

if ((${#STOPPED_BY_US[@]})); then
  docker start "${STOPPED_BY_US[@]}" >/dev/null
  STOPPED_BY_US=()
fi

gzip -9 "$raw_archive"
mv "$raw_archive.gz" "$archive"
checksum=$(sha256sum "$archive" | awk '{print $1}')
size_bytes=$(stat -c '%s' "$archive")
{
  echo "archive=$archive_name"
  echo "created_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "size_bytes=$size_bytes"
  echo "sha256=$checksum"
  echo "deployment=$DEPLOY_DIR"
  echo "contents:"
  echo "  deployment/ — полный каталог развёртывания"
  echo "  docker/ — версии, конфигурация Compose и сведения о контейнерах/образах"
  for volume in "${VOLUMES[@]}"; do
    echo "  docker/volumes/$volume/ — данные тома Docker"
  done
} >"$manifest"

rclone mkdir --config "$RCLONE_CONFIG" "$REMOTE"
rclone copyto --config "$RCLONE_CONFIG" "$archive" "$REMOTE/$archive_name"
rclone copyto --config "$RCLONE_CONFIG" "$manifest" "$REMOTE/$(basename "$manifest")"

# Keep the newest 14 daily archives, plus every archive made on the first day
# of a month. Manifests follow their archives.
mapfile -t REMOTE_ARCHIVES < <(
  rclone lsf --config "$RCLONE_CONFIG" --files-only --include 'synapse-host-????-??-??-????.tar.gz' "$REMOTE" | sort -r
)
for index in "${!REMOTE_ARCHIVES[@]}"; do
  old_name=${REMOTE_ARCHIVES[$index]}
  day=${old_name:21:2}
  if ((index >= 14)) && [[ "$day" != "01" ]]; then
    rclone deletefile --config "$RCLONE_CONFIG" "$REMOTE/$old_name"
    rclone deletefile --config "$RCLONE_CONFIG" "$REMOTE/$old_name.manifest.txt" || true
  fi
done

echo "Бэкап завершён: $archive"
echo "SHA-256: $checksum"
echo "Загружено: $REMOTE/$archive_name"

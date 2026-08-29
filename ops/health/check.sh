#!/usr/bin/env bash

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TARGETS_FILE="${TARGETS_FILE:-$SCRIPT_DIR/targets.txt}"
STATUS_FILE="${STATUS_FILE:-$SCRIPT_DIR/status.json}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-10}"
MAX_TIME="${MAX_TIME:-30}"

json_string() {
    local value=$1
    value=${value//\\/\\\\}
    value=${value//\"/\\\"}
    value=${value//$'\n'/\\n}
    value=${value//$'\r'/\\r}
    value=${value//$'\t'/\\t}
    printf '"%s"' "$value"
}

if [[ ! -r "$TARGETS_FILE" ]]; then
    printf 'Не удалось прочитать список адресов: %s\n' "$TARGETS_FILE" >&2
    exit 1
fi

mkdir -p -- "$(dirname -- "$STATUS_FILE")"
output_tmp=$(mktemp "${STATUS_FILE}.tmp.XXXXXX") || exit 1
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/synapse-health.XXXXXX") || {
    rm -f -- "$output_tmp"
    exit 1
}
trap 'rm -rf -- "$work_dir" "$output_tmp"' EXIT

printf '[\n' >"$output_tmp"
first=true

while IFS= read -r target || [[ -n "$target" ]]; do
    target=${target%$'\r'}
    [[ -z "$target" || "$target" == \#* ]] && continue

    body_file="$work_dir/body"
    curl_error_file="$work_dir/curl-error"
    : >"$body_file"
    : >"$curl_error_file"

    curl_result=$(curl --silent --show-error --location \
        --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" \
        --output "$body_file" --write-out '%{http_code} %{time_total}' \
        "https://$target/" 2>"$curl_error_file")
    curl_exit=$?

    code=0
    elapsed_ms=0
    errors=()
    if [[ "$curl_result" =~ ^([0-9]{3})[[:space:]]+([0-9]+([.][0-9]+)?)$ ]]; then
        code=${BASH_REMATCH[1]}
        elapsed_ms=$(awk -v seconds="${BASH_REMATCH[2]}" 'BEGIN { printf "%.0f", seconds * 1000 }')
    else
        errors+=("curl не вернул метрики ответа")
    fi
    if (( curl_exit != 0 )); then
        curl_error=$(tr '\n\r\t' '   ' <"$curl_error_file")
        errors+=("curl: ${curl_error:-ошибка $curl_exit}")
    fi

    page_size=$(wc -c <"$body_file" | tr -d '[:space:]')
    if (( page_size == 0 )); then
        errors+=("тело ответа пустое")
    elif grep -Fq 'Not Found' "$body_file"; then
        errors+=("тело ответа содержит Not Found")
    fi
    if (( code < 200 || code >= 400 )); then
        errors+=("HTTP-код $code")
    fi

    cert_days=null
    cert_end=$(timeout "${CONNECT_TIMEOUT}s" openssl s_client -connect "$target:443" \
        -servername "$target" </dev/null 2>/dev/null \
        | openssl x509 -noout -enddate 2>/dev/null) || cert_end=
    if [[ "$cert_end" == notAfter=* ]]; then
        cert_epoch=$(date -u -d "${cert_end#notAfter=}" +%s 2>/dev/null) || cert_epoch=
        if [[ "$cert_epoch" =~ ^[0-9]+$ ]]; then
            now_epoch=$(date -u +%s)
            cert_days=$(( (cert_epoch - now_epoch) / 86400 ))
        fi
    fi

    error_json=null
    if (( ${#errors[@]} > 0 )); then
        printf -v error_text '%s; ' "${errors[@]}"
        error_text=${error_text%; }
        error_json=$(json_string "$error_text")
    fi

    $first || printf ',\n' >>"$output_tmp"
    first=false
    printf '  {"адрес":%s,"код":%d,"миллисекунды":%d,"дней до истечения сертификата":%s,"размер":%d,"ошибка":%s}' \
        "$(json_string "$target")" "$code" "$elapsed_ms" "$cert_days" "$page_size" "$error_json" \
        >>"$output_tmp"
done <"$TARGETS_FILE"

printf '\n]\n' >>"$output_tmp"
chmod 0644 "$output_tmp"
mv -f -- "$output_tmp" "$STATUS_FILE"
